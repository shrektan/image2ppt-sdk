/** The image2ppt API client. */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  Image2PPTError,
  Image2PPTTimeoutError,
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

export const DEFAULT_BASE_URL = "https://image2ppt.com";

/** Wait between rate-limited retries when the server sends no `Retry-After`. */
const RATE_LIMIT_FALLBACK_WAIT_MS = 5_000;

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

function guessMime(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
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
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) {
      throw new Error("apiKey is required");
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.rateLimitMaxWaitMs = Math.max(0, options.rateLimitMaxWaitMs ?? 1_800_000);
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
        return { name, mime: guessMime(name), buffer: await readFile(path) };
      }),
    );
    // Pre-flight, before a single byte goes out: an oversized request is not
    // answered with an error, it is cut off — so it must never be sent.
    for (const file of files) checkFileSize(file.name, file.buffer.byteLength);
    checkSubmission(
      files.reduce((total, file) => total + file.buffer.byteLength, 0),
      files.filter((file) => isImageMime(file.mime)).length,
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
   * @throws InvalidFileError A single file is over the per-request limit on its
   *   own, so no batching can carry it.
   * @throws RateLimitedError Still rate limited after `rateLimitMaxWaitMs`.
   */
  async submitAll(paths: string[], options: SubmitOptions = {}): Promise<Job[]> {
    if (!paths.length) {
      throw new Error("at least one file is required");
    }
    const batches = planBatches(await this.#uploadItems(paths));
    const deadline = performance.now() + this.rateLimitMaxWaitMs;
    const jobs: Job[] = [];
    for (const batch of batches) {
      try {
        jobs.push(
          await this.#submitBatch(batch.map((item) => item.path), options, deadline),
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
   */
  async download(jobId: string, destPath: string): Promise<string> {
    const res = await this.#request(
      "GET",
      `/api/v1/jobs/${encodeURIComponent(jobId)}/download`,
    );
    if (!res.ok) {
      await this.#raiseForError(res);
    }
    if (res.body) {
      // Stream to disk in chunks so a large PPTX never sits fully in memory
      // (mirrors the Python client's iter_content streaming).
      await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    } else {
      // No body stream (shouldn't happen for a 200 download): buffer as a fallback.
      await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    }
    return destPath;
  }

  /**
   * One-shot: submit → wait for completion → download to `destPath`.
   *
   * One job, one PPTX — the files must fit in a single submission (45MB, 50
   * pages). For more than that, `convertAll` splits the pile and writes one PPTX
   * per batch.
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
   * @param destDir Directory for the PPTX files; created **before anything is
   *   submitted**, so an unusable destination costs nothing.
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
    await mkdir(destDir, { recursive: true });

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
    deadline: number,
  ): Promise<Job> {
    for (;;) {
      try {
        return await this.submit(paths, options);
      } catch (err) {
        if (!(err instanceof RateLimitedError)) throw err;
        const delay =
          err.retryAfter != null ? err.retryAfter * 1000 : RATE_LIMIT_FALLBACK_WAIT_MS;
        const remaining = deadline - performance.now();
        if (remaining <= 0 || delay > remaining) throw err;
        await sleep(delay);
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
    try {
      return await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#apiKey}` },
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

  async #sleepUntil(deadline: number, ms: number, jobId: string): Promise<void> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Image2PPTTimeoutError(`timed out waiting for job ${jobId}`, jobId);
    }
    await sleep(Math.min(ms, remaining));
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}
