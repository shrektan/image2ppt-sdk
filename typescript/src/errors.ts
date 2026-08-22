/**
 * Exception hierarchy for the image2ppt client.
 *
 * Every error carries the HTTP `statusCode`, the server error `code` (from the
 * `{ error: { code, message } }` envelope), and a human-readable `message`.
 * Branch on `code`, not `message` — messages may be reworded.
 */

import type { Job } from "./types.js";

export interface ErrorInit {
  statusCode?: number;
  code?: string;
}

/** Base class for all client errors. */
export class Image2PPTError extends Error {
  readonly statusCode?: number;
  readonly code?: string;
  /**
   * Jobs already created when this error was thrown out of `submitAll` /
   * `convertAll`. They are **running on the server with credits already
   * reserved** — not lost, not refunded by the failure. Wait on them
   * (`wait`/`download`) or come back to them later. Empty for any error not
   * thrown out of a batch call.
   */
  submittedJobs: Job[] = [];

  constructor(message: string, init: ErrorInit = {}) {
    super(message);
    // new.target gives the concrete subclass, so subclasses get the right name
    // without each redefining it.
    this.name = new.target.name;
    this.statusCode = init.statusCode;
    this.code = init.code;
  }
}

/** API key is missing, invalid, or the account is gone (401 / 403). */
export class AuthenticationError extends Image2PPTError {}

/**
 * A file was rejected (400), or the request carried too much file content.
 *
 * Raised for an unsupported format, a single file over the 35MB per-file limit, or
 * a request whose files add up to more than the 45MB per-request limit
 * (413 `PAYLOAD_TOO_LARGE`). The client raises the `PAYLOAD_TOO_LARGE` case
 * locally, before uploading anything.
 */
export class InvalidFileError extends Image2PPTError {}

/**
 * The upload was cut off before the body finished arriving (400 `UPLOAD_ABORTED`).
 *
 * The server is telling you it did **not** take the submission — no job was created
 * and no credits were reserved — so **resending the same files is safe**. That makes
 * this different from a transport-level fetch failure, which cannot rule out that the
 * job was created and only the response was lost; the client never retries that one
 * for you.
 *
 * If it keeps happening the submission is probably too large for the link. Send fewer
 * files per request, or use `submitAll` / `convertAll` to split.
 */
export class UploadAbortedError extends Image2PPTError {}

/**
 * The body was not valid `multipart/form-data` (400 `MALFORMED_UPLOAD`). A
 * client-side framing problem: **retrying the identical payload will not help**.
 * Using this SDK unmodified you should never see it; if you do, please report it.
 */
export class MalformedUploadError extends Image2PPTError {}

/**
 * The request carried no files at all (400 `NO_FILES`). Using this SDK you should
 * never see it — `submit` refuses an empty `paths` before opening a connection.
 */
export class NoFilesError extends Image2PPTError {}

/**
 * `aspectRatio` was not one of the accepted values (400 `INVALID_ASPECT_RATIO`).
 * Accepted: `auto` (default), `16:9`, `4:3`. Nothing was created and nothing was
 * charged — fix the value and submit again.
 */
export class InvalidAspectRatioError extends Image2PPTError {}

/**
 * One submission holds more pages than the per-minute quota allows (400
 * `PAGE_RATE_EXCEEDED`).
 *
 * Distinct from `RateLimitedError`: a 429 means "not right now, try again in N
 * seconds" and the same submission will eventually go through. `PAGE_RATE_EXCEEDED`
 * means this submission can *never* fit the window whole, so waiting does not help —
 * split it, e.g. with `submitAll` / `convertAll`.
 */
export class PageRateExceededError extends Image2PPTError {}

/** The submission exceeds the 50-page-per-job limit (400 TOO_MANY_SLIDES). */
export class TooManySlidesError extends Image2PPTError {}

/** Not enough available credits to cover the submission (402). */
export class InsufficientCreditsError extends Image2PPTError {}

/** The job id doesn't exist, or isn't owned by this key's account (404). */
export class JobNotFoundError extends Image2PPTError {}

/** The job hasn't finished yet, so the deliverable can't be downloaded (409). */
export class NotReadyError extends Image2PPTError {}

/** The job finished, but its PPTX passed the retention window and was reaped (410). */
export class OutputExpiredError extends Image2PPTError {}

/**
 * Rate limited (429 RATE_LIMITED). `retryAfter` is the server-suggested wait in
 * seconds (from the `Retry-After` header); retry after that long.
 *
 * Both kinds of 429 land here — the per-minute page quota and the cap on
 * concurrently active jobs — and both are handled the same way: wait, then try the
 * same submission again. `submitAll` / `convertAll` do that for you; if one of
 * them gives up, `submittedJobs` holds the jobs already created.
 */
export class RateLimitedError extends Image2PPTError {
  readonly retryAfter?: number;

  constructor(message: string, init: ErrorInit & { retryAfter?: number } = {}) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/**
 * The job ended in failure (raised by `wait` when it polls status=failed). `job`
 * is the failure snapshot; `code` / `message` come from its `error` field.
 */
export class JobFailedError extends Image2PPTError {
  readonly job?: Job;

  constructor(message: string, init: { code?: string; job?: Job } = {}) {
    super(message, { code: init.code });
    this.job = init.job;
  }
}

/**
 * `wait` exceeded its `timeout` before the job reached a terminal state. This does
 * not mean the job failed — it may still be running. Re-`wait` on the `jobId` later.
 */
export class Image2PPTTimeoutError extends Image2PPTError {
  readonly jobId?: string;

  constructor(message: string, jobId?: string) {
    super(message);
    this.jobId = jobId;
  }
}

// Server error code -> exception class. Unlisted codes fall back to the status-code
// map, then to the base class.
const CODE_TO_CLASS: Record<string, new (m: string, i?: ErrorInit) => Image2PPTError> = {
  INVALID_API_KEY: AuthenticationError,
  API_KEY_REQUIRED: AuthenticationError,
  ACCOUNT_DELETED: AuthenticationError,
  INVALID_FILE: InvalidFileError,
  INVALID_PDF: InvalidFileError,
  PAYLOAD_TOO_LARGE: InvalidFileError,
  UPLOAD_ABORTED: UploadAbortedError,
  MALFORMED_UPLOAD: MalformedUploadError,
  NO_FILES: NoFilesError,
  INVALID_ASPECT_RATIO: InvalidAspectRatioError,
  PAGE_RATE_EXCEEDED: PageRateExceededError,
  TOO_MANY_SLIDES: TooManySlidesError,
  INSUFFICIENT_CREDITS: InsufficientCreditsError,
  RATE_LIMITED: RateLimitedError,
  JOB_NOT_FOUND: JobNotFoundError,
  NOT_READY: NotReadyError,
  OUTPUT_EXPIRED: OutputExpiredError,
};
const STATUS_TO_CLASS: Record<number, new (m: string, i?: ErrorInit) => Image2PPTError> = {
  401: AuthenticationError,
  403: AuthenticationError, // API_KEY_REQUIRED / ACCOUNT_DELETED (fallback if code absent)
  402: InsufficientCreditsError,
  404: JobNotFoundError,
  409: NotReadyError,
  410: OutputExpiredError,
  413: InvalidFileError,
  429: RateLimitedError,
};

/** Build the mapped exception for an error envelope. */
export function exceptionFor(args: {
  statusCode: number;
  code?: string;
  message: string;
  retryAfter?: number;
}): Image2PPTError {
  const { statusCode, code, message, retryAfter } = args;
  if (statusCode === 429) {
    return new RateLimitedError(message, {
      statusCode: 429,
      code: code ?? "RATE_LIMITED",
      retryAfter,
    });
  }
  const cls =
    (code && CODE_TO_CLASS[code]) || STATUS_TO_CLASS[statusCode] || Image2PPTError;
  return new cls(message, { statusCode, code });
}
