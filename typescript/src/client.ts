/** The image2ppt API client. */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  Image2PPTError,
  Image2PPTTimeoutError,
  InvalidFileError,
  JobFailedError,
  RateLimitedError,
  exceptionFor,
} from "./errors.js";
import { checkFileSize, checkSubmission, planBatches } from "./limits.js";
import type { UploadItem } from "./limits.js";
import type {
  Account,
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
 * The service matches this string in full (`^...$`); appending another product
 * token would make the whole header unrecognisable. It is not part of
 * authentication and never changes the outcome of a request. Built from
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    const files = await Promise.all(
      paths.map(async (path) => {
        const name = basename(path);
        return { path, name, mime: guessMime(name), buffer: await readFile(path) };
      }),
    );
    // Pre-flight, before a single byte goes out: an oversized request is not
    // answered with an error, it is cut off — so it must never be sent. The error
    // names the full path, matching `planBatches` and the Python client — a bare
    // basename is ambiguous the moment two directories hold the same filename.
    for (const file of files) checkFileSize(file.path, file.buffer.byteLength);
    checkSubmission(
      files.reduce((total, file) => total + file.buffer.byteLength, 0),
      files.filter((file) => isImageMime(file.mime)).length,
      // A PDF's real page count is only known server-side; counting it as at least
      // 1 is what stops "50 images + a PDF" from being sent as a submission that is
      // certain to come back over the page limit.
      files.filter((file) => !isImageMime(file.mime)).length,
    );

    const buildForm = (): FormData => {
      const form = new FormData();
      for (const file of files) {
        form.append("files", new Blob([file.buffer], { type: file.mime }), file.name);
      }
      if (options.locale) form.append("locale", options.locale);
      if (options.aspectRatio) form.append("aspectRatio", options.aspectRatio);
      return form;
    };

    // Sent exactly once, never auto-retried: see the note above.
    const res = await this.#request("POST", "/api/v1/jobs", { body: buildForm() });
    return Job.fromJson(await this.#parseJson(res));
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
    const batches = planBatches(await this.#uploadItems(paths));
    const budget = new WaitBudget(this.rateLimitMaxWaitMs);
    const jobs: Job[] = [];
    for (const batch of batches) {
      try {
        jobs.push(
          await this.#submitBatch(batch.map((item) => item.path), options, budget),
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
    const res = await this.#request("GET", `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    return Job.fromJson(await this.#parseJson(res));
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
        // A single poll hit a transient server (5xx) or network error. The job may
        // still be running, so back off and retry until the deadline instead of
        // aborting. Client errors (4xx: job gone, bad key) are not transient.
        const transient =
          !(err instanceof Image2PPTError) ||
          (err.statusCode != null && err.statusCode >= 500);
        if (!transient) throw err;
        await this.#sleepUntil(deadline, interval, jobId);
        interval = Math.min(interval * 1.5, 15_000);
        continue;
      }

      if (job.isCompleted) return job;
      if (job.isFailed) {
        const err = job.error ?? undefined;
        throw new JobFailedError(err?.message ?? "conversion failed", {
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
    const res = await this.#request(
      "GET",
      `/api/v1/jobs/${encodeURIComponent(jobId)}/download`,
    );
    if (!res.ok) {
      await this.#raiseForError(res);
    }
    // Same directory as the destination, so the rename is atomic rather than a
    // cross-filesystem copy.
    const partial = join(dirname(destPath), `.${basename(destPath)}.${randomUUID()}.part`);
    try {
      if (res.body) {
        // Stream to disk in chunks so a large PPTX never sits fully in memory
        // (mirrors the Python client's iter_content streaming).
        await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
      } else {
        // No body stream (shouldn't happen for a 200 download): buffer as a fallback.
        await writeFile(partial, Buffer.from(await res.arrayBuffer()));
      }
      await rename(partial, destPath);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw err;
    }
    return destPath;
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
    const res = await this.#request("GET", "/api/v1/account");
    return (await this.#parseJson(res)) as unknown as Account;
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
    paths: string[],
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
        return await this.submit(paths, options);
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

  /** Measure files for batch planning, using the size they will occupy on the wire. */
  async #uploadItems(paths: string[]): Promise<UploadItem[]> {
    return Promise.all(
      paths.map(async (path) => ({
        path,
        size: (await stat(path)).size,
        isPdf: !isImageMime(guessMime(basename(path))),
      })),
    );
  }

  async #request(method: string, path: string, init: { body?: FormData } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#apiKey}`, "User-Agent": USER_AGENT },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout aborts the whole request (including a slow large
      // upload/download body) with a native DOMException, which is NOT an
      // Image2PPTError. Re-wrap it so callers catching Image2PPTError — as the
      // README/examples do — don't crash on a raw DOMException. Raise timeoutMs
      // for large transfers; it bounds the entire request, not just idle time.
      if (
        err instanceof DOMException &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        throw new Image2PPTError(
          `request to ${path} exceeded timeoutMs=${this.timeoutMs}`,
          { code: "REQUEST_TIMEOUT" },
        );
      }
      throw err;
    }
    this.#warnIfDeprecated(res);
    return res;
  }

  /**
   * Log at most one warning if this SDK version has been marked deprecated.
   *
   * The service puts a `Deprecation` header on successful responses of a version
   * below the support floor. Presence is the whole signal — the value is not
   * parsed. `Sunset` and `Link` are included in the message when present. `wait()`
   * polls every few seconds, so this is latched per client.
   */
  #warnIfDeprecated(res: Response): void {
    if (!this.warnOnDeprecated || this.#deprecationWarned) return;
    if (!res.headers.has("Deprecation")) return;
    this.#deprecationWarned = true;
    try {
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
      // Advisory only: a throwing console.warn must not fail the request.
    }
  }

  async #parseJson(res: Response): Promise<Record<string, unknown>> {
    if (!res.ok) {
      await this.#raiseForError(res);
    }
    return (await res.json()) as Record<string, unknown>;
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
