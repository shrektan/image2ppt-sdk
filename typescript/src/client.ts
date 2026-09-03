/** The image2ppt API client. */

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// Imported from `node:timers` rather than taken off the global, and that is
// load-bearing: the test suite spies on `globalThis.setTimeout` to assert on the
// delays this client *waits* for (retry backoff, poll intervals). The idle
// watchdog below is not one of those waits — it is an internal deadline that
// never sleeps the caller — so it must stay out of that reckoning.
import { clearTimeout as clearTimer, setTimeout as setTimer } from "node:timers";

import {
  APIConnectionError,
  APITimeoutError,
  Image2PPTError,
  Image2PPTTimeoutError,
  InvalidFileError,
  JobCancelledError,
  JobFailedError,
  MalformedResponseError,
  RateLimitedError,
  exceptionFor,
} from "./errors.js";
import { compressImageForUpload } from "./compress.js";
import type { CompressedImage } from "./compress.js";
import { checkFileSize, checkSubmission, planBatches } from "./limits.js";
import type { UploadItem } from "./limits.js";
import type {
  Account,
  CancellationResult,
  ClientOptions,
  ConvertOptions,
  SubmitOptions,
  WaitOptions,
} from "./types.js";
import { Job } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://image2ppt.com";

/**
 * Sent on every request so the service knows which client version made it.
 *
 * The whole header has to be exactly this string: appending another product token
 * means the request is no longer recognised as coming from an official SDK. It is
 * not part of authentication and never changes the outcome of a request. Built from
 * `VERSION`, which a test keeps in step with `package.json`.
 */
const USER_AGENT = `image2ppt-node/${VERSION}`;

/** Wait between rate-limited retries when the server sends no `Retry-After`. */
const RATE_LIMIT_FALLBACK_WAIT_MS = 5_000;

/**
 * Floor for a server-sent `Retry-After`, in seconds. `Retry-After: 0` is a legal
 * value meaning "retry now", and a proxy can even send a negative one; taken
 * literally either turns every retry loop in this client into a tight loop that
 * re-sends the same multipart body as fast as the link allows — for up to
 * `rateLimitMaxWaitMs`, with tens of megabytes of files on each pass. A floor makes
 * a retry a retry instead of a flood, and costs nothing when the server means it.
 */
const MIN_RETRY_AFTER_SECONDS = 1;

/** How many images are read and re-encoded at the same time. See `#prepareFiles`. */
const PREPARE_CONCURRENCY = 4;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

/** Formats that count as exactly one page each. Anything else (PDF) is unknown. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** A file resolved to the exact bytes and metadata that will go on the wire. */
interface PreparedFile {
  path: string;
  name: string;
  mime: string;
  /** Images are already compressed in memory. PDFs are streamed from `path`. */
  buffer?: Buffer;
  size: number;
  isImage: boolean;
}

interface PreparedUploadItem extends UploadItem {
  file: PreparedFile;
}

type RequestBody = NonNullable<RequestInit["body"]>;

function multipartFilename(name: string): string {
  // A filename is multipart header data, not an arbitrary byte channel. Percent-encode
  // the three characters that could break out of the quoted string, which is exactly
  // what Node's built-in FormData did before this client assembled the body itself.
  // Backslash-escaping instead would be ambiguous: a filename may legally contain a
  // backslash, and a parser that un-escapes would then swallow the closing quote.
  return name.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

/** `actual` below zero means the file could no longer be read at all. */
function fileChanged(path: string, measured: number, actual: number): Image2PPTError {
  return new Image2PPTError(
    `"${path}" changed while it was being uploaded: ${measured} bytes when it was ` +
      `measured, ${actual < 0 ? "unreadable" : `${actual} bytes`} now`,
    { code: "FILE_CHANGED" },
  );
}

/**
 * Aborts a request that has gone `timeoutMs` with **no data moving** either way.
 *
 * `timeoutMs` used to bound the whole request, which meant a 40MB upload or a
 * large PPTX download was killed at 60 seconds however healthy it was — a
 * progressing transfer punished for being big. It is an idle timeout instead:
 * `kick()` is called as each chunk of the request body is produced and as each
 * chunk of the response arrives, and only a real stall reaches the deadline. That
 * is what the Python client's read timeout has always meant, so the two now agree.
 *
 * A request that never gets a response at all is still covered: the clock starts
 * when the watchdog is built and nothing kicks it.
 *
 * The abort reason is an `APITimeoutError` rather than a bare signal, and that is
 * deliberate. `fetch` rejects with whatever the signal was aborted with, and the
 * multipart body's own errors only reach the caller if they are `Image2PPTError`s
 * — anything else degrades into an opaque `TypeError: fetch failed` on the way
 * out, whichever end of the request it came from.
 */
class IdleWatchdog {
  readonly #controller = new AbortController();
  readonly #timeoutMs: number;
  readonly #describe: () => string;
  #timer: ReturnType<typeof setTimer> | undefined;
  #stopped = false;

  constructor(timeoutMs: number, describe: () => string) {
    this.#timeoutMs = timeoutMs;
    this.#describe = describe;
    this.kick();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Data moved: start the clock over. */
  kick(): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimer(this.#timer);
    this.#timer = setTimer(() => {
      this.#stopped = true;
      this.#controller.abort(
        new APITimeoutError(this.#describe(), { code: "REQUEST_TIMEOUT" }),
      );
    }, this.#timeoutMs);
    // The watchdog must never be the reason a process stays alive: a caller who
    // has stopped awaiting this request should not be held open by its timer.
    this.#timer.unref?.();
  }

  /** The exchange is over — release the timer. Safe to call more than once. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimer(this.#timer);
    this.#timer = undefined;
  }
}

function buildMultipart(
  files: PreparedFile[],
  options: SubmitOptions,
  onChunk: () => void,
): {
  body: RequestBody;
  contentType: string;
  contentLength: number;
} {
  const boundary = `----image2ppt-${randomUUID()}`;
  const chunk = (value: string): Buffer => Buffer.from(value, "utf8");
  const fileHeader = (file: PreparedFile): string =>
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files"; filename="${multipartFilename(file.name)}"\r\n` +
    `Content-Type: ${file.mime}\r\n\r\n`;
  const field = (name: string, value: string): string =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const trailer = `--${boundary}--\r\n`;

  const fields: string[] = [];
  if (options.locale) fields.push(field("locale", options.locale));
  if (options.aspectRatio) fields.push(field("aspectRatio", options.aspectRatio));

  // The body streams, but its length is known before the first byte goes out: image
  // payloads are already in memory, a PDF's size was measured while preparing it, and
  // every delimiter is a fixed string. Sending `Content-Length` rather than letting
  // the request go out chunked is what lets an oversized submission be refused up
  // front instead of after tens of megabytes have already crossed the wire.
  const contentLength =
    files.reduce(
      (total, file) => total + Buffer.byteLength(fileHeader(file), "utf8") + file.size + 2,
      0,
    ) +
    fields.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) +
    Buffer.byteLength(trailer, "utf8");

  async function* chunks(): AsyncGenerator<Buffer> {
    // Every yield goes through here so the idle watchdog sees the upload moving.
    // A body that stops being produced — or that the connection stops accepting —
    // stops kicking, which is exactly when the request should be given up on.
    function* moving(part: Buffer): Generator<Buffer> {
      onChunk();
      yield part;
    }
    for (const file of files) {
      yield* moving(chunk(fileHeader(file)));
      if (file.buffer !== undefined) {
        yield* moving(file.buffer);
      } else if (file.size > 0) {
        // PDFs are intentionally never buffered: retries create a fresh stream from
        // disk while images retain their already-compressed payload. The read is
        // capped at the size measured while preparing the file and then checked
        // against it, because that size is what `Content-Length` and the pre-flight
        // limits were both computed from. A document rewritten underneath us has to
        // fail here rather than send a body that contradicts its own header.
        let sent = 0;
        for await (const part of createReadStream(file.path, { end: file.size - 1 })) {
          sent += (part as Buffer).byteLength;
          yield* moving(Buffer.from(part));
        }
        // A file that shrank comes up short right here. One that grew would have been
        // cut off at the cap instead — the byte count still matches, so the size on
        // disk has to be checked once more to catch it. Either way the caller must
        // hear about it: a truncated document is a deck they paid credits for and
        // cannot use.
        if (sent !== file.size) throw fileChanged(file.path, file.size, sent);
        // Deleted mid-upload counts as changed too — a raw ENOENT here would escape
        // the unwrap in `#request` and reach the caller as a bare "fetch failed".
        const sizeAfter = await stat(file.path).then(
          (stats) => stats.size,
          () => -1,
        );
        if (sizeAfter !== file.size) throw fileChanged(file.path, file.size, sizeAfter);
      }
      yield* moving(chunk("\r\n"));
    }
    for (const value of fields) yield* moving(chunk(value));
    yield* moving(chunk(trailer));
  }
  const source = Readable.from(chunks());
  // The body can refuse to finish — a file rewritten underneath the upload. That
  // error reaches the caller through `fetch`, which rejects with it as the `cause`.
  // The stream reports it a second time on its own, though, and an error event with
  // no listener is an unhandled rejection: on a default Node setup that takes the
  // caller's whole process down over a failure the SDK is already reporting properly.
  source.on("error", () => {});
  return {
    body: Readable.toWeb(source) as unknown as RequestBody,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real reason behind an opaque transport error.
 *
 * undici reports every connection failure — refused, reset, DNS, TLS — as the same
 * `TypeError: fetch failed`, and puts what actually happened in `cause`. On its own
 * the top-level message tells a caller nothing, so the chain is walked and the
 * innermost description is what gets reported.
 */
function describeCause(err: unknown): string {
  const seen = new Set<unknown>();
  let current = err;
  let described = String(err);
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    described = current.message || described;
    if (current.cause === undefined) break;
    current = current.cause;
  }
  return described;
}

/** A download that stopped arriving. Never a verdict on the file already written. */
function downloadCutOff(err: unknown, jobId: string): Error {
  // The watchdog's own abort is already the error worth reporting.
  if (err instanceof Image2PPTError) return err;
  return new APIConnectionError(
    `download of job ${jobId} was cut off: ${describeCause(err)}`,
    { cause: err },
  );
}

/**
 * The response body as Node chunks, reporting progress and owning its failures.
 *
 * The download is consumed outside the `fetch` call, so nothing there could wrap a
 * body that died mid-stream — it used to reach the caller as whatever the stream
 * threw. Reading it here gives that failure a home, and gives the idle watchdog the
 * per-chunk signal that lets a slow-but-moving download run as long as it needs to.
 * Errors from the *disk* side are left alone: they are not transport failures and
 * must not be dressed up as one.
 */
async function* readingBody(
  body: ReadableStream<Uint8Array>,
  jobId: string,
  onChunk: () => void,
): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of Readable.fromWeb(body)) {
      onChunk();
      yield chunk as Buffer;
    }
  } catch (err) {
    throw downloadCutOff(err, jobId);
  }
}

/**
 * MIME type for a supported extension; refuse anything else locally.
 *
 * `MIME_BY_EXT` is what the API accepts. Falling back to a generic type meant a
 * `.txt` or `.docx` was treated as PDF-like, given a batch of its own and uploaded,
 * only to come back `INVALID_FILE` — and in `submitAll` the batches ahead of it were
 * already jobs with credits reserved. The supported set is known locally, so this is
 * a failure that can cost nothing.
 *
 * The trade-off is deliberate: a format the service starts accepting is refused here
 * until this list is updated and released.
 */
function guessMime(name: string): string {
  const mime = MIME_BY_EXT[extname(name).toLowerCase()];
  if (mime === undefined) {
    throw new InvalidFileError(
      `"${name}" is not a supported file type; this client accepts ` +
        `${Object.keys(MIME_BY_EXT).sort().join(", ")}. Nothing was uploaded`,
      { code: "INVALID_FILE" },
    );
  }
  return mime;
}

function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/**
 * Create `destDir` if needed and prove a file can actually be written in it.
 *
 * Creating the directory is not enough on its own: when it already exists, a
 * recursive `mkdir` succeeds no matter what the permissions are, so a read-only
 * destination sails through and only fails later — after the jobs exist and the
 * credits are spent.
 *
 * The proof is an actual file rather than a permission-bit check. Permission bits
 * get it wrong in exactly the environments that need the answer: they ignore
 * read-only mounts and ACLs, and running as root they report writable for
 * directories nothing can be written to. Creating a real file is the same
 * operation `download` will do a few seconds later, so it is the same answer.
 *
 * The probe has a random name and is opened with the `wx` flag, which fails if
 * anything is already there. A predictable name opened for writing would follow —
 * and truncate — whatever already sits at that path, including a symlink someone
 * left in a shared output directory. Only the entry this call actually created is
 * removed afterwards.
 */
async function ensureWritableDir(destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const probe = join(destDir, `.image2ppt-write-test-${randomUUID()}`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch (err) {
    throw new Error(
      `cannot write to destDir "${destDir}" (${(err as NodeJS.ErrnoException).code ?? err}); ` +
        "nothing was submitted",
      { cause: err },
    );
  }
  // Only reached when this call created it.
  await rm(probe, { force: true }).catch(() => undefined);
}

/**
 * Milliseconds left for waiting out rate limits — spent only by actual waiting.
 *
 * A wall-clock deadline fixed at the start of the call would be eaten by the uploads
 * themselves: a large pile on a slow uplink can burn the whole allowance before the
 * first 429 even arrives, and then `rateLimitMaxWaitMs` quietly means "do not wait at
 * all" — with the cutoff depending on link speed rather than on anything the caller
 * chose. The option promises time spent waiting, so only waiting takes from it.
 */
class WaitBudget {
  #remainingMs: number;

  constructor(remainingMs: number) {
    this.#remainingMs = remainingMs;
  }

  /** Wait `ms` if the budget covers it; resolve false if it does not. */
  async spend(ms: number): Promise<boolean> {
    if (ms > this.#remainingMs) return false;
    await sleep(ms);
    this.#remainingMs -= ms;
    return true;
  }
}

/**
 * Record the jobs created so far on an error escaping a batch call.
 *
 * Every `Image2PPTError` declares `submittedJobs`; this also reaches the rarer
 * non-SDK escape (an exhausted network error), so the caller never has to know
 * which kind they caught to find out what they already paid for.
 */
function attachSubmittedJobs(err: unknown, jobs: Job[]): void {
  if (typeof err === "object" && err !== null) {
    (err as { submittedJobs?: Job[] }).submittedJobs = [...jobs];
  }
}

/**
 * Client for the image2ppt API. Server-side only — keep your key off the browser.
 *
 * ```ts
 * const client = new Image2PPTClient({ apiKey: "i2p_live_..." });
 * const job = await client.convert(["slide.png", "report.pdf"], "out.pptx");
 * ```
 */
export class Image2PPTClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly rateLimitMaxWaitMs: number;
  readonly warnOnDeprecated: boolean;
  /**
   * `Accept-Language` sent on every request, or undefined to send none.
   *
   * Sets the language of the service's error **messages** only — not the language
   * of the deck, which is `SubmitOptions.locale`.
   */
  readonly acceptLanguage?: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  #deprecationWarned = false;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) {
      throw new Error("apiKey is required");
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.rateLimitMaxWaitMs = Math.max(0, options.rateLimitMaxWaitMs ?? 1_800_000);
    this.warnOnDeprecated = options.warnOnDeprecated !== false;
    this.acceptLanguage = options.acceptLanguage;
    this.#apiKey = options.apiKey;
    const impl = options.fetch ?? globalThis.fetch;
    if (!impl) {
      throw new Error("no global fetch found; pass options.fetch (Node 18+ has one)");
    }
    this.#fetch = impl;
  }

  /**
   * Submit a batch of files and create a conversion job.
   *
   * Checked locally before anything is uploaded: the files must add up to at most
   * 45MB and at most 50 pages. Over either limit this throws without opening a
   * connection — going over the size cap on the wire does not come back as a clean
   * error, it comes back as a dead connection.
   *
   * **A failed submission is never retried automatically.** A network error does
   * not tell you whether the request body made it: the job may not exist, or it
   * may exist with credits already reserved and only the response lost. Retrying
   * the second case charges twice, and without an idempotency key there is no way
   * to tell them apart — so the error is thrown as-is. Check `account()` or your
   * job list before resending.
   *
   * @param paths Local file paths (one or more). png/jpeg/webp/gif/pdf, each ≤ 35MB,
   *   and ≤ 45MB of file content per request. An image is 1 page, a PDF is its page
   *   count; the total must be ≤ 50 pages. For more files than one request can hold,
   *   use `submitAll` / `convertAll`.
   * @returns A `Job` with status `pending`, plus `slideCount` and `creditsReserved`.
   * @throws InvalidFileError Including the local `PAYLOAD_TOO_LARGE` pre-flight failure.
   */
  async submit(paths: string[], options: SubmitOptions = {}): Promise<Job> {
    if (!paths.length) {
      throw new Error("at least one file is required");
    }
    return this.#submitPrepared(await this.#prepareFiles(paths), options);
  }

  /**
   * Split files into submittable batches and create **one job per batch**.
   *
   * For a pile of files too big or too numerous for a single request. Batching
   * rules live in `planBatches`: at most 40MB of file content and at most 50
   * images per batch, and every PDF in a batch of its own (the SDK does not parse
   * PDFs, so only the server knows their page count). Input order is preserved.
   *
   * **Each returned job produces its own PPTX.** There is no server-side merge —
   * N batches means N decks. If you need exactly one deck, keep the submission
   * inside one request's limits and use `convert`.
   *
   * **Rate limits are waited out, not thrown.** A pile big enough to need
   * batching is a pile big enough to hit the account's per-minute page quota (and
   * its cap on concurrently active jobs). Both arrive as a 429 with a
   * `Retry-After`, and both are handled the same way: sleep that long, then try
   * the same batch again. Waiting is the normal path here. Total waiting is capped
   * by the client's `rateLimitMaxWaitMs`.
   *
   * **Network errors are not retried** — see `submit`. Only a 429 is, because only
   * a 429 proves the server did not take the submission.
   *
   * **If it does give up, the jobs already created are handed back on the error**,
   * in `err.submittedJobs`. Those jobs are running on the server with credits
   * already reserved — they are not lost and not refunded. Wait on them or fetch
   * them later; do not resubmit those files.
   *
   * @returns One pending `Job` per batch, in batch order.
   * @throws InvalidFileError A single file is over the 35MB per-file limit, so no
   *   batching can carry it.
   * @throws RateLimitedError Still rate limited after `rateLimitMaxWaitMs`.
   */
  async submitAll(paths: string[], options: SubmitOptions = {}): Promise<Job[]> {
    if (!paths.length) {
      throw new Error("at least one file is required");
    }
    const files = await this.#prepareFiles(paths);
    const batches = planBatches(
      files.map((file): PreparedUploadItem => ({
        path: file.path,
        size: file.size,
        isPdf: !file.isImage,
        file,
      })),
    );
    const budget = new WaitBudget(this.rateLimitMaxWaitMs);
    const jobs: Job[] = [];
    for (const batch of batches) {
      try {
        jobs.push(
          await this.#submitBatch(
            batch.map((item) => (item as PreparedUploadItem).file),
            options,
            budget,
          ),
        );
      } catch (err) {
        // Whatever went wrong, the earlier batches are already jobs on the server
        // with credits reserved. Losing the ids would mean the caller paid for
        // work they can never collect.
        attachSubmittedJobs(err, jobs);
        throw err;
      }
    }
    return jobs;
  }

  /** Fetch the current job state as a `Job` snapshot. Throws JobNotFoundError. */
  async getJob(jobId: string): Promise<Job> {
    return Job.fromJson(
      await this.#request("GET", `/api/v1/jobs/${encodeURIComponent(jobId)}`, {
        consume: (res) => this.#parseJson(res),
      }),
    );
  }

  /**
   * Request graceful cancellation of a conversion job.
   *
   * Pages already running finish and remain in the deliverable; pages that have
   * not started are skipped and refunded. **A page being dispatched at the very
   * moment the request arrives may still run to completion and be billed.**
   * Repeating the call is safe. When `finalizing` is true, keep polling with
   * `getJob` until the job is terminal.
   *
   * @throws JobAlreadyFinishedError The job already finished, **or is past the
   *   point where cancelling could change the outcome** (409 `JOB_ALREADY_FINISHED`).
   */
  async cancel(jobId: string): Promise<CancellationResult> {
    const body: unknown = await this.#request(
      "POST",
      `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
      { consume: (res) => this.#parseJson(res) },
    );
    // Read the three documented fields rather than casting the body through, so a
    // malformed envelope surfaces as an Image2PPTError instead of silently handing
    // back `finalizing: undefined` — which reads as "settled" and stops polling a
    // job that is still draining. Mirrors the Python CancellationResult model,
    // shape check included, so the same bad body fails the same way in both clients.
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new MalformedResponseError(
        "malformed cancellation response, expected a JSON object",
      );
    }
    const d = body as Record<string, unknown>;
    for (const key of ["jobId", "cancellationRequested", "finalizing"]) {
      if (!(key in d)) {
        throw new MalformedResponseError(`malformed cancellation response, missing ${key}`);
      }
    }
    return {
      jobId: d.jobId as string,
      cancellationRequested: Boolean(d.cancellationRequested),
      finalizing: Boolean(d.finalizing),
    };
  }

  /**
   * Poll until the job reaches a terminal state; return the completed `Job`.
   *
   * Backs off from `pollIntervalMs` to 15s. On a 429 it waits the `Retry-After`
   * seconds. A failed job throws JobFailedError; exceeding `timeoutMs` throws
   * Image2PPTTimeoutError (the job itself may still be running).
   */
  async wait(jobId: string, options: WaitOptions = {}): Promise<Job> {
    const pollInterval = options.pollIntervalMs ?? 5_000;
    const timeout = options.timeoutMs ?? 1_800_000;
    // Monotonic clock so a system-time jump can't skew the deadline (mirrors the
    // Python client's time.monotonic()).
    const deadline = performance.now() + timeout;
    let interval = pollInterval;

    for (;;) {
      let job: Job;
      try {
        job = await this.getJob(jobId);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          const waitMs = err.retryAfter != null ? err.retryAfter * 1000 : interval;
          await this.#sleepUntil(deadline, waitMs, jobId);
          continue;
        }
        // A single poll failed. The job itself is fine — the question is only
        // whether asking again could go better, and the error answers that itself
        // through `isTransient`: a 5xx, a dropped connection, a request that
        // stalled. Back off and ask again until the deadline.
        //
        // Anything else ends the wait, and that now includes an error this client
        // did not expect at all. It used to be the opposite: "not one of ours" was
        // read as "transient", so a bug in this SDK was swallowed and retried for
        // the full half hour before surfacing as a timeout. The mirror-image bug
        // was worse in practice — a single slow status poll is reported as this
        // SDK's own error, so "one of ours" made it fatal and one stalled poll
        // killed the whole wait.
        if (!(err instanceof Image2PPTError) || !err.isTransient) throw err;
        await this.#sleepUntil(deadline, interval, jobId);
        interval = Math.min(interval * 1.5, 15_000);
        continue;
      }

      if (job.isCompleted) return job;
      if (job.isFailed) {
        const err = job.error ?? undefined;
        const ErrorClass = err?.code === "JOB_CANCELLED" ? JobCancelledError : JobFailedError;
        throw new ErrorClass(err?.message ?? "conversion failed", {
          code: err?.code,
          job,
        });
      }

      await this.#sleepUntil(deadline, interval, jobId);
      interval = Math.min(interval * 1.5, 15_000);
    }
  }

  /**
   * Download a completed job's PPTX to `destPath`; return that path. Throws
   * NotReadyError (409), JobNotFoundError (404), or OutputExpiredError (410).
   *
   * **`destPath` either holds a complete deck or is not written at all.** The bytes
   * go to a temporary file beside it and are renamed into place once the last one
   * arrives, so a connection dropped mid-download cannot leave a truncated `.pptx`
   * that opens in a file listing and nowhere else. That matters most for
   * `convertAll`, whose contract is "the decks already downloaded stay on disk" — a
   * half-written `part-02.pptx` would be indexed as one of them.
   */
  async download(jobId: string, destPath: string): Promise<string> {
    // Same directory as the destination, so the rename is atomic rather than a
    // cross-filesystem copy.
    const partial = join(dirname(destPath), `.${basename(destPath)}.${randomUUID()}.part`);
    return this.#request("GET", `/api/v1/jobs/${encodeURIComponent(jobId)}/download`, {
      consume: async (res, watchdog) => {
        if (!res.ok) {
          await this.#raiseForError(res);
        }
        try {
          if (res.body) {
            // Stream to disk in chunks so a large PPTX never sits fully in memory
            // (mirrors the Python client's iter_content streaming). A deck of any
            // size downloads fine as long as bytes keep arriving — see `timeoutMs`.
            await pipeline(
              Readable.from(readingBody(res.body, jobId, () => watchdog.kick())),
              createWriteStream(partial),
            );
          } else {
            // No body stream (shouldn't happen for a 200 download): buffer as a
            // fallback, wrapped the same way so a failure here is an SDK error too.
            await writeFile(
              partial,
              Buffer.from(
                await res.arrayBuffer().catch((err: unknown) => {
                  throw downloadCutOff(err, jobId);
                }),
              ),
            );
          }
          await rename(partial, destPath);
        } catch (err) {
          await rm(partial, { force: true }).catch(() => undefined);
          throw err;
        }
        return destPath;
      },
    });
  }

  /**
   * One-shot: submit → wait for completion → download to `destPath`.
   *
   * One job, one PPTX — the files must fit in a single submission (45MB of file
   * content, 50 pages). For more than that, `convertAll` splits the pile and writes
   * one PPTX per batch.
   */
  async convert(
    paths: string[],
    destPath: string,
    options: ConvertOptions = {},
  ): Promise<Job> {
    const job = await this.submit(paths, options);
    const completed = await this.wait(job.jobId, options);
    await this.download(completed.jobId, destPath);
    return completed;
  }

  /**
   * Batch version of `convert`: submit everything, wait, download each deck.
   *
   * Files are split with `submitAll`, every batch is submitted first (so the
   * server works on them in parallel), then each job is waited on and downloaded
   * in order.
   *
   * **This writes one PPTX per batch, not one merged deck.** Output files are
   * named `part-01.pptx`, `part-02.pptx`, ... inside `destDir` — stable for the
   * same input, and never overwriting each other. Existing files with those names
   * are overwritten. `convert` is unchanged: one job, one PPTX.
   *
   * `timeoutMs` is the wait cap **per job**, not for the whole pile. If a job
   * fails or runs past it, earlier batches that already downloaded stay on disk
   * and later ones are not waited on. Every job created so far is on the thrown
   * error as `err.submittedJobs` — those are still running with credits reserved,
   * so wait on them rather than resubmitting.
   *
   * Rate limits during submission are waited out — see `submitAll`.
   *
   * @param destDir Directory for the PPTX files. Created **and proven writable
   *   before anything is submitted**, so an unusable destination costs nothing.
   * @returns The written file paths, in batch order.
   */
  async convertAll(
    paths: string[],
    destDir: string,
    options: ConvertOptions = {},
  ): Promise<string[]> {
    // Before anything is submitted: if the destination is unusable, fail now
    // rather than after N jobs exist with credits reserved and nowhere to put
    // their output. This is the one step that can fail for free.
    await ensureWritableDir(destDir);

    const jobs = await this.submitAll(paths, options);

    const written: string[] = [];
    try {
      for (const [index, job] of jobs.entries()) {
        const completed = await this.wait(job.jobId, options);
        const destPath = join(destDir, `part-${String(index + 1).padStart(2, "0")}.pptx`);
        await this.download(completed.jobId, destPath);
        written.push(destPath);
      }
    } catch (err) {
      // Same contract as submitAll: the jobs are already paid for, so the caller
      // gets their ids back instead of having to guess.
      attachSubmittedJobs(err, jobs);
      throw err;
    }
    return written;
  }

  /** Return account info: `{ email, credits }` (available credits). */
  async account(): Promise<Account> {
    return (await this.#request("GET", "/api/v1/account", {
      consume: (res) => this.#parseJson(res),
    })) as unknown as Account;
  }

  // ----- internals --------------------------------------------------- //
  /**
   * Submit one batch, waiting out rate limits until `deadline`.
   *
   * Retrying a 429 is not the same gamble as retrying a broken upload: a 429 is
   * the server saying it did *not* take the submission. Nothing was created and
   * nothing was charged, so trying the same batch again is free.
   *
   * Both flavors of 429 (per-minute page quota, concurrent-job cap) carry a
   * `Retry-After` and are handled identically. When the header is missing we fall
   * back to a fixed wait.
   */
  async #submitBatch(
    files: PreparedFile[],
    options: SubmitOptions,
    budget: WaitBudget,
  ): Promise<Job> {
    // Two things stop this: the shared waiting `budget`, and MAX_BATCH_ATTEMPTS. The
    // budget bounds time spent waiting; the attempt count bounds the uploads, which
    // the budget cannot see — a server answering `Retry-After: 1` forever costs almost
    // no budget per round while re-sending the whole batch every time.
    let attemptsLeft = MAX_BATCH_ATTEMPTS;
    for (;;) {
      try {
        return await this.#submitPrepared(files, options);
      } catch (err) {
        if (!(err instanceof RateLimitedError)) throw err;
        attemptsLeft -= 1;
        const delay =
          err.retryAfter != null ? err.retryAfter * 1000 : RATE_LIMIT_FALLBACK_WAIT_MS;
        // On the last attempt, do not wait first: nothing follows the wait, so it
        // would only delay the error the caller is already getting.
        if (attemptsLeft <= 0 || !(await budget.spend(delay))) throw err;
      }
    }
  }

  /**
   * Prepare paths once, so pre-flight, batching, and multipart share identical bytes.
   *
   * Bounded on purpose. `submitAll` takes an arbitrarily long list, and preparing one
   * image holds the whole source file in memory while it is decoded and re-encoded.
   * Preparing them all at once meant a few hundred photos put a few hundred whole
   * files in memory simultaneously — enough to take the process down before a single
   * byte was uploaded. A small pool keeps the decoder busy and the peak flat.
   */
  async #prepareFiles(paths: string[]): Promise<PreparedFile[]> {
    const prepared = new Array<PreparedFile>(paths.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < paths.length; index = next++) {
        prepared[index] = await this.#prepareFile(paths[index]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PREPARE_CONCURRENCY, paths.length) }, worker),
    );
    return prepared;
  }

  /** Resolve one path to its exact multipart metadata and wire size. */
  async #prepareFile(path: string): Promise<PreparedFile> {
    const name = basename(path);
    const mime = guessMime(name);
    if (!isImageMime(mime)) {
      // PDF files are only stat-ed here; their bytes are streamed while building the
      // multipart body so a large document never occupies client memory.
      return {
        path,
        name,
        mime,
        size: (await stat(path)).size,
        isImage: false,
      };
    }

    // Read outside the try: a missing or unreadable path is a filesystem problem, not
    // an invalid image, and the PDF branch above lets its own ENOENT/EACCES through.
    const raw = await readFile(path);
    let compressed: CompressedImage;
    try {
      compressed = await compressImageForUpload(raw, mime);
    } catch (err) {
      // An SDK error here is preparation refusing to run at all (no native decoder
      // for this platform), not a verdict on this file. Passing it through keeps it
      // from being reported as a bad image.
      if (err instanceof Image2PPTError) throw err;
      // Corrupt, truncated, or undecodable image. Surfaced as an SDK error, matching
      // the Python client, so callers catching Image2PPTError never see a raw decoder
      // type leak out of this SDK.
      throw new InvalidFileError(
        `could not read image "${name}": ${err instanceof Error ? err.message : String(err)}`,
        { code: "INVALID_FILE" },
      );
    }
    const buffer = compressed.buffer;
    const outputName =
      compressed.mime === "image/jpeg" && !/\.jpe?g$/i.test(name)
        ? `${name.slice(0, Math.max(0, name.length - extname(name).length))}.jpg`
        : name;
    return {
      path,
      name: outputName,
      mime: compressed.mime,
      buffer,
      size: buffer.byteLength,
      isImage: true,
    };
  }

  /** Validate and submit a prepared payload exactly once. */
  async #submitPrepared(files: PreparedFile[], options: SubmitOptions): Promise<Job> {
    // Pre-flight happens after image preparation because these are the exact bytes
    // that will be transmitted, not the potentially much larger source files.
    for (const file of files) checkFileSize(file.path, file.size);
    checkSubmission(
      files.reduce((total, file) => total + file.size, 0),
      files.filter((file) => file.isImage).length,
      files.filter((file) => !file.isImage).length,
    );
    return Job.fromJson(
      await this.#request("POST", "/api/v1/jobs", {
        // Rebuilt per attempt: a retry needs a body that has not been consumed.
        body: (watchdog) => buildMultipart(files, options, () => watchdog.kick()),
        consume: (res) => this.#parseJson(res),
      }),
    );
  }

  /**
   * Make one HTTP request and consume its response, under an idle watchdog.
   *
   * The response body is read inside `consume` rather than after this returns,
   * because the watchdog has to cover it: a body that starts arriving and then
   * stops is exactly the failure `timeoutMs` is there to catch, and it happens
   * after the headers are in. `consume` is handed the watchdog so a path that
   * streams — only `download` — can report each chunk as progress; the short JSON
   * bodies do not need to, since a JSON reply that takes longer than the whole
   * idle budget to arrive genuinely is stuck.
   *
   * Every failure leaves here as an `Image2PPTError`. The READMEs promise that,
   * and four different platform errors used to escape it: a transport failure as
   * undici's opaque `TypeError: fetch failed`, an unparseable 2xx body as a raw
   * `SyntaxError`, a job body missing its own id as no error at all, and a
   * download cut off mid-stream as whatever the stream happened to throw.
   */
  async #request<T>(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      /**
       * Builds the request body. A callback rather than a value because the body
       * streams and needs the watchdog, which does not exist until the request does.
       */
      body?: (watchdog: IdleWatchdog) => {
        body: RequestBody;
        contentType: string;
        contentLength: number;
      };
      consume: (res: Response, watchdog: IdleWatchdog) => Promise<T>;
    },
  ): Promise<T> {
    const watchdog = new IdleWatchdog(
      this.timeoutMs,
      () =>
        `request to ${path} went ${this.timeoutMs}ms with no data moving ` +
        "(timeoutMs is an idle timeout, not a limit on how long a transfer may take)",
    );
    try {
      const payload = options.body?.(watchdog);
      let res: Response;
      try {
        res = await this.#fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "User-Agent": USER_AGENT,
            ...(this.acceptLanguage ? { "Accept-Language": this.acceptLanguage } : {}),
            ...(payload
              ? {
                  "Content-Type": payload.contentType,
                  "Content-Length": String(payload.contentLength),
                }
              : {}),
            ...options.headers,
          },
          body: payload?.body,
          signal: watchdog.signal,
          // Node's fetch requires this for a streaming request body. It is ignored by
          // browsers, but this SDK is intentionally server-side only.
          duplex: "half",
        });
      } catch (err) {
        throw this.#asRequestError(err, path);
      }
      this.#warnIfDeprecated(res);
      return await options.consume(res, watchdog);
    } finally {
      watchdog.stop();
    }
  }

  /**
   * Turn whatever `fetch` rejected with into this SDK's own error.
   *
   * Order matters here and is not interchangeable. An error the request *body*
   * raised — this client's own code objecting that a file changed underneath the
   * upload, or the watchdog giving up on a stalled one — has to be recognised
   * before the generic transport wrapping, or the caller is told "the connection
   * failed" about a problem that was never on the connection.
   */
  #asRequestError(err: unknown, path: string): Error {
    // The watchdog aborts with its own APITimeoutError, and `fetch` rejects with
    // whatever the signal carried, so this arrives already in the right shape.
    if (err instanceof Image2PPTError) return err;
    // A throw from the request body reaches the caller as undici's bare
    // `TypeError: fetch failed`, with the real reason demoted to `cause`. The body
    // is this client's own code, so when it is the one that objected — a file that
    // changed underneath the upload — its message is the one worth surfacing.
    if (err instanceof Error && err.cause instanceof Image2PPTError) return err.cause;
    // An abort that is not the watchdog's: a caller-supplied `fetch` implementation
    // with its own deadline, or a runtime that aborts with a bare DOMException.
    if (
      err instanceof DOMException &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      return new APITimeoutError(`request to ${path} was aborted: ${err.message}`, {
        code: "REQUEST_TIMEOUT",
        cause: err,
      });
    }
    // Everything else is the connection itself: refused, reset, DNS, TLS. undici
    // reports all of them as the same unhelpful `TypeError: fetch failed` and hides
    // the actual reason in `cause`, so lift that reason into the message and keep
    // the original reachable.
    return new APIConnectionError(`request to ${path} failed: ${describeCause(err)}`, {
      cause: err,
    });
  }

  /**
   * Log at most one warning if this SDK version has been marked deprecated.
   *
   * A response from a version below the support floor carries a `Deprecation`
   * header — successful ones included, which is why this is checked before the
   * status code rather than after. Presence is the whole signal, the value is not
   * parsed. `Sunset` and `Link` join the message when present. `wait()` polls every
   * few seconds, so this is latched per client.
   *
   * Everything below is inside the guard on purpose: this notice is advisory, and
   * nothing it does — reading the headers included — may turn a served response into
   * a thrown error.
   */
  #warnIfDeprecated(res: Response): void {
    if (!this.warnOnDeprecated || this.#deprecationWarned) return;
    try {
      if (!res.headers.has("Deprecation")) return;
      this.#deprecationWarned = true;
      const parts = [
        `This image2ppt Node SDK (${VERSION}) has been marked deprecated.`,
      ];
      const url = linkUrl(res.headers.get("Link"));
      if (url) parts.push(`See ${url} for what changed.`);
      const sunset = res.headers.get("Sunset");
      if (sunset) parts.push(`Support is planned to end ${sunset}.`);
      parts.push(
        "Pass warnOnDeprecated: false to Image2PPTClient() to silence this warning.",
      );
      console.warn(parts.join(" "));
    } catch {
      // Advisory only: neither a throwing console.warn nor an unexpected response
      // object may fail the request.
    }
  }

  /**
   * The JSON body of a successful response.
   *
   * A 2xx that is not JSON is a real thing to meet — a captive portal, a CDN error
   * page, a proxy that replaced the response — and it used to escape as a raw
   * `SyntaxError` from `res.json()`, which is not an `Image2PPTError` and so was
   * not catchable the way the README says every failure is.
   */
  async #parseJson(res: Response): Promise<Record<string, unknown>> {
    if (!res.ok) {
      await this.#raiseForError(res);
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      // The watchdog's abort comes through here too when the body stalls partway.
      if (err instanceof Image2PPTError) throw err;
      if (err instanceof SyntaxError) {
        throw new MalformedResponseError(
          `${res.status} response was not JSON: ${err.message}`,
          { statusCode: res.status, cause: err },
        );
      }
      // The body started and then stopped arriving: a transport failure, not a
      // parsing one, and worth retrying where a mangled body would not be.
      throw new APIConnectionError(
        `${res.status} response body did not finish arriving: ${describeCause(err)}`,
        { statusCode: res.status, cause: err },
      );
    }
  }

  async #raiseForError(res: Response): Promise<never> {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body && typeof body === "object" && body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // non-JSON error body (e.g. a gateway HTML page): fall back to status text
    }
    throw exceptionFor({
      statusCode: res.status,
      code,
      message: message ?? `request failed (HTTP ${res.status})`,
      retryAfter: parseRetryAfter(res.headers.get("Retry-After")),
    });
  }

  /**
   * Sleep `ms`, but never past `deadline` and never past `MAX_SLEEP_MS`.
   *
   * The `MAX_SLEEP_MS` clamp is not redundant with the deadline: `deadline` comes from
   * the caller's `timeoutMs`, so both bounds here can be caller-supplied and neither
   * constrains the other. See `MAX_SLEEP_MS` for what an out-of-range wait does.
   */
  async #sleepUntil(deadline: number, ms: number, jobId: string): Promise<void> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Image2PPTTimeoutError(`timed out waiting for job ${jobId}`, jobId);
    }
    await sleep(Math.min(ms, remaining, MAX_SLEEP_MS));
  }
}

/** Pull the URL out of a `Link: <url>; rel=...` header, or null. */
function linkUrl(value: string | null): string | null {
  if (!value) return null;
  const start = value.indexOf("<");
  const end = value.indexOf(">", start + 1);
  if (start === -1 || end === -1) return null;
  const url = value.slice(start + 1, end).trim();
  return url || null;
}

/**
 * `Retry-After` as plain decimal seconds — the only spelling this client accepts.
 *
 * Written with `[0-9]` and an explicit leading/trailing space-or-tab rather than `\d`
 * and `trim()`. Python's `\d` matches every Unicode decimal digit and JavaScript's
 * matches only ASCII, so `Retry-After: ５` would be five seconds to one client and
 * unparseable to the other — the exact two-client disagreement this pattern exists to
 * remove. Space and tab are the only whitespace HTTP allows around a field value;
 * `trim()` would also eat Unicode spaces that never belong there.
 */
const RETRY_AFTER_SECONDS = /^[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*$/;

/**
 * Longest delay this client will ever wait in one go, in milliseconds (~24.8 days).
 *
 * The line is this platform's timer range: a delay past 2**31-1 milliseconds is not
 * representable, and `setTimeout` silently clamps it to *1 millisecond* — so an
 * out-of-range wait turns into "retry immediately, at full speed". Python fails
 * differently on the same input (`time.sleep` raises `OverflowError`), which is the
 * other half of the problem: the two clients would stop agreeing. Drawing the line at
 * the same number in both keeps them in step. Nothing legitimate lives out here.
 *
 * It bounds **every** wait, not just a server-sent `Retry-After`: the polling backoff
 * is seeded from the caller's own `pollIntervalMs`, and on repeated 429s without a
 * `Retry-After` that seed is reused unchanged — so an absurd `pollIntervalMs` with a
 * large enough `timeoutMs` would reach the timer the same way.
 */
const MAX_SLEEP_MS = 2 ** 31 - 1;

/**
 * How many times one batch may be re-sent after a 429 before giving up.
 *
 * The waiting budget alone does not bound the work: a server answering
 * `Retry-After: 1` indefinitely costs only a second per round, so a 30-minute budget
 * would buy ~1800 rounds — and every round re-uploads the whole batch, tens of
 * megabytes at a time. A server still refusing after this many tries is not going to
 * be talked round by more of them.
 */
const MAX_BATCH_ATTEMPTS = 10;

/**
 * Parse the `Retry-After` header as seconds (contract: integer seconds).
 *
 * Anything unusable comes back as `undefined` so the caller falls back to its own
 * wait: a missing header, an HTTP-date, a negative value, a value past `MAX_SLEEP_MS`
 * once converted, or any spelling that is not plain decimal seconds.
 *
 * The syntax is matched explicitly rather than handed to `Number`. Both languages'
 * parsers are lenient in their own way — `Number` takes `"0x10"` as 16, Python's
 * `float` takes `"1e3"` and `"nan"` — so "whatever the parser accepts" would mean the
 * two clients disagreeing about the same header. One pattern, one answer.
 *
 * A usable value is floored at `MIN_RETRY_AFTER_SECONDS` — see that constant for why
 * zero cannot be taken literally.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = RETRY_AFTER_SECONDS.exec(value);
  if (match === null) return undefined;
  const seconds = Number(match[1]);
  if (seconds * 1000 > MAX_SLEEP_MS) return undefined;
  return Math.max(seconds, MIN_RETRY_AFTER_SECONDS);
}
