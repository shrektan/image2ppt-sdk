/**
 * Upload size limits and batch planning.
 *
 * The API caps the **file content of a single request** at 45MB. Going over that
 * is not a friendly failure: the check can only run after the whole body has been
 * received, and the network layer in front of the API gives up on an oversized
 * request before it ever gets there — so a client that sends too much sees the
 * connection die (a write timeout on a slow uplink, a broken pipe on a fast one)
 * with no error code and no explanation.
 *
 * The fix is to never send too much. These limits, the pre-flight checks, and
 * `planBatches` let a client know a submission is too big *before* opening a
 * connection, and split a large pile of files into submittable batches.
 *
 * There are three separate caps, and they fail in different ways: one file
 * (`MAX_FILE_BYTES`), the file content of one request (`MAX_UPLOAD_BYTES`), and
 * pages per job (`MAX_PAGES_PER_JOB`).
 */

import { InvalidFileError, TooManySlidesError } from "./errors.js";

/**
 * Server cap on **one** file. A file over this is rejected with `INVALID_FILE`
 * however it is submitted, so no amount of batching helps. Keep in sync with the
 * documented API contract.
 */
export const MAX_FILE_BYTES = 35 * 1024 * 1024;

/**
 * Server cap on the file content of one request. Over this, the request is
 * rejected (413 `PAYLOAD_TOO_LARGE`) — or cut off outright before the server can
 * answer at all. Keep in sync with the documented API contract.
 */
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

/**
 * Target ceiling for one auto-planned batch. Deliberately *below*
 * `MAX_UPLOAD_BYTES`: what travels on the wire is a multipart body, so the
 * request is always somewhat larger than the file bytes it carries (boundaries,
 * per-part headers, filenames). The gap absorbs that, so a planned batch does not
 * land just over the cap.
 */
export const BATCH_TARGET_BYTES = 40 * 1024 * 1024;

/**
 * Server cap on pages per job. An image is 1 page; a PDF counts as its own page
 * count. Keep in sync with the documented API contract.
 */
export const MAX_PAGES_PER_JOB = 50;

/**
 * One file to upload, with the size it will occupy in the request.
 *
 * This client uploads files as they are on disk (unlike the Python client, it
 * does not compress images first), so `size` is the size on disk.
 *
 * `isPdf` marks a file whose page count is unknown to the client — the SDK does
 * not parse PDFs. Such a file is never mixed into a batch with others.
 */
export interface UploadItem {
  path: string;
  size: number;
  isPdf: boolean;
}

/** Format a byte count as MB, for human-readable error messages. */
export function formatBytes(size: number): string {
  // Stays honest below a megabyte. Rounding everything to MB makes a submission one
  // byte over the cap read as "45.0MB, over the 45.0MB limit (0.0MB too much)" — a
  // message that contradicts itself and looks like the check is broken.
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Throw if one file is over the per-file cap, whatever else it travels with.
 *
 * Separate from `checkSubmission` because it is a property of the file, not of
 * the request: a 40MB PDF fits under the 45MB request cap and would sail through
 * batch planning, then be rejected by the server every single time. Fail on it
 * locally instead of building a batch that can never succeed.
 *
 * @param path The file, named in the error so the caller knows which one.
 * @param size Its size as it will be uploaded.
 * @throws InvalidFileError Over `MAX_FILE_BYTES` (`code: "INVALID_FILE"`, the same
 *   code the server would answer with).
 */
export function checkFileSize(path: string, size: number): void {
  if (size > MAX_FILE_BYTES) {
    throw new InvalidFileError(
      `"${path}" is ${formatBytes(size)}, over the ${formatBytes(MAX_FILE_BYTES)} ` +
        "per-file limit; the server rejects it however it is submitted, so " +
        "splitting into batches will not help",
      { code: "INVALID_FILE" },
    );
  }
}

/**
 * Throw if a submission cannot succeed, before any bytes go on the wire.
 *
 * **The page check is a lower bound, not the server's verdict.** An image is
 * exactly 1 page, but a PDF is however many pages it holds and the SDK does not
 * parse PDFs (zero dependencies), so each one can only be counted as *at least* 1.
 * That is enough to catch the combinations that are certain to fail — 50 images
 * plus any PDF is at least 51 pages, so it never had a chance — but a submission
 * that passes here can still come back `TOO_MANY_SLIDES` from the server, because
 * a 30-page PDF counted as 1 here and as 30 there. Passing this check means "not
 * obviously doomed", not "will be accepted".
 *
 * @param totalBytes Sum of the file sizes that will be sent in this request.
 * @param imagePages Number of image files. Each is exactly 1 page.
 * @param pdfFiles Number of PDFs (or other files whose page count is unknown to
 *   the client). Each counts as at least 1 page.
 * @throws TooManySlidesError The minimum page count already exceeds what one job
 *   can hold.
 * @throws InvalidFileError File content over the per-request cap
 *   (`code = "PAYLOAD_TOO_LARGE"`).
 */
export function checkSubmission(
  totalBytes: number,
  imagePages: number,
  pdfFiles = 0,
): void {
  const minPages = imagePages + pdfFiles;
  if (minPages > MAX_PAGES_PER_JOB) {
    const counted = pdfFiles
      ? `${imagePages} images plus ${pdfFiles} ${pdfFiles === 1 ? "PDF" : "PDFs"} ` +
        `(at least 1 page each) is at least ${minPages} pages`
      : `${imagePages} images is ${minPages} pages`;
    throw new TooManySlidesError(
      `${counted} in one submission, over the ${MAX_PAGES_PER_JOB}-page-per-job ` +
        "limit; use submitAll() or convertAll() to split them into jobs automatically",
      { code: "TOO_MANY_SLIDES" },
    );
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    throw new InvalidFileError(
      `these files add up to ${formatBytes(totalBytes)}, over the ` +
        `${formatBytes(MAX_UPLOAD_BYTES)} limit for one request ` +
        `(${formatBytes(totalBytes - MAX_UPLOAD_BYTES)} too much). ` +
        "Send fewer files per call, or use submitAll() / convertAll() to split them " +
        "into batches automatically",
      { code: "PAYLOAD_TOO_LARGE" },
    );
  }
}

/**
 * Split files into batches that each fit in one submission.
 *
 * Pure function: no file system, no network. Same input, same output.
 *
 * Rules:
 * - a batch holds at most `BATCH_TARGET_BYTES` of file content;
 * - a batch holds at most `MAX_PAGES_PER_JOB` images. That count is exact, not a
 *   lower bound like `checkSubmission`'s: a PDF always flushes the current batch
 *   and takes one of its own, so a batch being filled here only ever holds images,
 *   and an image is always exactly 1 page;
 * - **every PDF gets a batch to itself.** The SDK does not parse PDFs (zero
 *   dependencies), so the client cannot know how many pages one holds. Mixed into
 *   a batch, an unknown page count could push the job over the page limit with no
 *   way to predict it. Alone, the job is exactly that one PDF and the server's own
 *   count decides;
 * - input order is preserved, so the same files always plan the same way.
 *
 * @throws InvalidFileError A single file is over `MAX_FILE_BYTES`. No batching can
 *   help — the server rejects that file however it is submitted.
 */
export function planBatches(items: Iterable<UploadItem>): UploadItem[][] {
  const batches: UploadItem[][] = [];
  let current: UploadItem[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  };

  for (const item of items) {
    // Stricter than the request cap and checked first: a file over the per-file
    // limit is unsubmittable, not merely unbatchable.
    checkFileSize(item.path, item.size);
    if (item.isPdf) {
      flush();
      batches.push([item]);
      continue;
    }
    // A file bigger than the batch target still gets uploaded — alone. The
    // `current.length` guard means we only start a new batch to make room, never
    // refuse to place an item.
    if (
      current.length &&
      (currentBytes + item.size > BATCH_TARGET_BYTES ||
        current.length + 1 > MAX_PAGES_PER_JOB)
    ) {
      flush();
    }
    current.push(item);
    currentBytes += item.size;
  }

  flush();
  return batches;
}
