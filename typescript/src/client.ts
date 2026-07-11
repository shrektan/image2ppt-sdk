/** The image2ppt API client. */

import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  Image2PPTTimeoutError,
  JobFailedError,
  RateLimitedError,
  exceptionFor,
} from "./errors.js";
import type {
  Account,
  ClientOptions,
  ConvertOptions,
  SubmitOptions,
  WaitOptions,
} from "./types.js";
import { Job } from "./types.js";

export const DEFAULT_BASE_URL = "https://image2ppt.com";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function guessMime(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
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
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) {
      throw new Error("apiKey is required");
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
   * @param paths Local file paths (one or more). png/jpeg/webp/gif/pdf, each ≤ 35MB.
   *   An image is 1 page, a PDF is its page count; the total must be ≤ 50 pages.
   * @returns A `Job` with status `pending`, plus `slideCount` and `creditsReserved`.
   */
  async submit(paths: string[], options: SubmitOptions = {}): Promise<Job> {
    if (!paths.length) {
      throw new Error("at least one file is required");
    }
    const form = new FormData();
    for (const path of paths) {
      const buffer = await readFile(path);
      const name = basename(path);
      form.append("files", new Blob([buffer], { type: guessMime(name) }), name);
    }
    if (options.locale) form.append("locale", options.locale);
    if (options.aspectRatio) form.append("aspectRatio", options.aspectRatio);

    const res = await this.#request("POST", "/api/v1/jobs", { body: form });
    return Job.fromJson(await this.#parseJson(res));
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
    const deadline = Date.now() + timeout;
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
        throw err;
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
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return destPath;
  }

  /** One-shot: submit → wait for completion → download to `destPath`. */
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

  /** Return account info: `{ email, credits }` (available credits). */
  async account(): Promise<Account> {
    const res = await this.#request("GET", "/api/v1/account");
    return (await this.#parseJson(res)) as unknown as Account;
  }

  // ----- internals --------------------------------------------------- //
  #request(method: string, path: string, init: { body?: FormData } = {}): Promise<Response> {
    return this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}` },
      body: init.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
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
    const remaining = deadline - Date.now();
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
