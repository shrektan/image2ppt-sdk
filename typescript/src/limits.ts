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
 * The fix is to never send too much. These limits, the pre-flight check, and
 * `planBatches` let a client know a submission is too big *before* opening a
 * connection, and split a large pile of files into submittable batches.
 */

import { InvalidFileError, TooManySlidesError } from "./errors.js";

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
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Throw if a submission cannot succeed, before any bytes go on the wire.
 *
 * @param totalBytes Sum of the file sizes that will be sent in this request.
 * @param imagePages Number of image files (each is exactly 1 page). PDFs are
 *   excluded — their page count is only known server-side.
 * @throws TooManySlidesError More images than one job can hold.
 * @throws InvalidFileError File content over the per-request cap
 *   (`code = "PAYLOAD_TOO_LARGE"`).
 */
export function checkSubmission(totalBytes: number, imagePages: number): void {
  if (imagePages > MAX_PAGES_PER_JOB) {
    throw new TooManySlidesError(
      `${imagePages} images in one submission, over the ${MAX_PAGES_PER_JOB}-page-per-job ` +
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
 * - a batch holds at most `MAX_PAGES_PER_JOB` images;
 * - **every PDF gets a batch to itself.** The SDK does not parse PDFs (zero
 *   dependencies), so the client cannot know how many pages one holds. Mixed into
 *   a batch, an unknown page count could push the job over the page limit with no
 *   way to predict it. Alone, the job is exactly that one PDF and the server's own
 *   count decides;
 * - input order is preserved, so the same files always plan the same way.
 *
 * @throws InvalidFileError A single file is over `MAX_UPLOAD_BYTES`. No batching
 *   can help — it does not fit in any request on its own.
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
    if (item.size > MAX_UPLOAD_BYTES) {
      throw new InvalidFileError(
        `"${item.path}" is ${formatBytes(item.size)} on its own, over the ` +
          `${formatBytes(MAX_UPLOAD_BYTES)} limit for one request; it cannot be ` +
          "uploaded in any batch",
        { code: "PAYLOAD_TOO_LARGE" },
      );
    }
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
