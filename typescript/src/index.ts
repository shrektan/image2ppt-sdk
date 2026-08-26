/**
 * Official Node.js / TypeScript client for the image2ppt API.
 * Convert images and PDFs into editable PowerPoint (.pptx) decks.
 *
 * ```ts
 * import { Image2PPTClient } from "image2ppt";
 *
 * const client = new Image2PPTClient({ apiKey: "i2p_live_..." });
 * const job = await client.convert(["slide.png", "report.pdf"], "out.pptx");
 * console.log("credits used:", job.creditsUsed);
 * ```
 *
 * Server-side only — keep your API key off the browser.
 * See https://github.com/shrektan/image2ppt-sdk for docs and examples.
 */

export { DEFAULT_BASE_URL, Image2PPTClient } from "./client.js";
export { VERSION } from "./version.js";
export {
  AuthenticationError,
  Image2PPTError,
  Image2PPTTimeoutError,
  InsufficientCreditsError,
  InvalidAspectRatioError,
  InvalidFileError,
  JobAlreadyFinishedError,
  JobCancelledError,
  JobFailedError,
  JobNotFoundError,
  MalformedUploadError,
  NoFilesError,
  NotReadyError,
  OutputExpiredError,
  PageRateExceededError,
  RateLimitedError,
  TooManySlidesError,
  UploadAbortedError,
} from "./errors.js";
export {
  BATCH_TARGET_BYTES,
  MAX_FILE_BYTES,
  MAX_PAGES_PER_JOB,
  MAX_UPLOAD_BYTES,
  checkFileSize,
  checkSubmission,
  planBatches,
} from "./limits.js";
export type { UploadItem } from "./limits.js";
export { Job } from "./types.js";
export type {
  Account,
  AspectRatio,
  CancellationResult,
  ClientOptions,
  ConvertOptions,
  JobError,
  JobStatus,
  Locale,
  SubmitOptions,
  WaitOptions,
} from "./types.js";
