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

/** A file was rejected: unsupported format or over the 35MB per-file limit (400). */
export class InvalidFileError extends Image2PPTError {}

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
