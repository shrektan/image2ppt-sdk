/**
 * Unit tests for the image2ppt Node client.
 *
 * Uses an injected fake `fetch` returning real `Response` objects (Node 18+ has
 * them globally), so there's no network and no mocking library. Polling tests use
 * pollIntervalMs=0 / Retry-After: 0 to run instantly.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  Image2PPTClient,
  Image2PPTError,
  Image2PPTTimeoutError,
  InsufficientCreditsError,
  InvalidFileError,
  Job,
  JobNotFoundError,
  MAX_FILE_BYTES,
  MAX_PAGES_PER_JOB,
  MAX_UPLOAD_BYTES,
  NotReadyError,
  RateLimitedError,
  type Job as JobType,
  TooManySlidesError,
} from "../src/index.js";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake fetch that also records every call, so tests can assert on what was sent. */
type RecordingFetch = typeof fetch & {
  calls: Array<{ url: string; init: RequestInit }>;
};

/** A fake fetch driven by a per-call script; the handler may throw to simulate
 * a network failure. `n` is the 1-based call number. */
function fetchScript(handler: (n: number) => Response | Promise<Response>): RecordingFetch {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(calls.length);
  }) as unknown as RecordingFetch;
  impl.calls = calls;
  return impl;
}

/** A fake fetch that returns the given responses in sequence. */
function fetchSequence(...responses: Response[]): RecordingFetch {
  return fetchScript((n) => responses[Math.min(n - 1, responses.length - 1)]);
}

/** Filenames carried by each POST, in order: [[batch1...], [batch2...]]. */
function postedFilenames(fetchImpl: RecordingFetch): string[][] {
  return fetchImpl.calls
    .filter((call) => call.init.method === "POST")
    .map((call) =>
      (call.init.body as FormData).getAll("files").map((part) => (part as File).name),
    );
}

function client(fetchImpl: typeof fetch): Image2PPTClient {
  return new Image2PPTClient({ apiKey: "i2p_live_test", fetch: fetchImpl });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "i2p-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tempFile(name = "a.png"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.from("fake-image-bytes"));
  return path;
}

// --------------------------------------------------------------------------- //
// construction
// --------------------------------------------------------------------------- //
describe("construction", () => {
  it("requires an apiKey", () => {
    expect(() => new Image2PPTClient({ apiKey: "" })).toThrow();
  });

  it("strips a trailing slash from baseUrl", () => {
    const c = new Image2PPTClient({ apiKey: "k", baseUrl: "https://x.test/", fetch });
    expect(c.baseUrl).toBe("https://x.test");
  });
});

// --------------------------------------------------------------------------- //
// submit
// --------------------------------------------------------------------------- //
describe("submit", () => {
  it("returns a pending Job", async () => {
    const file = await tempFile();
    const c = client(
      fetchSequence(json(201, { jobId: "job_1", status: "pending", slideCount: 1, creditsReserved: 1 })),
    );
    const job = await c.submit([file], { locale: "en", aspectRatio: "16:9" });
    expect(job.jobId).toBe("job_1");
    expect(job.status).toBe("pending");
    expect(job.creditsReserved).toBe(1);
  });

  it("throws for no files", async () => {
    await expect(client(fetchSequence(json(200, {}))).submit([])).rejects.toThrow();
  });

  it("maps 401 to AuthenticationError", async () => {
    const file = await tempFile();
    const c = client(fetchSequence(json(401, { error: { code: "INVALID_API_KEY", message: "bad key" } })));
    await expect(c.submit([file])).rejects.toMatchObject({
      name: "AuthenticationError",
      code: "INVALID_API_KEY",
      statusCode: 401,
    });
    await expect(c.submit([file])).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps 402 to InsufficientCreditsError", async () => {
    const file = await tempFile();
    const c = client(fetchSequence(json(402, { error: { code: "INSUFFICIENT_CREDITS", message: "no credits" } })));
    await expect(c.submit([file])).rejects.toBeInstanceOf(InsufficientCreditsError);
  });
});

// --------------------------------------------------------------------------- //
// getJob / wait
// --------------------------------------------------------------------------- //
describe("wait", () => {
  it("polls until completed", async () => {
    const c = client(
      fetchSequence(
        json(200, { jobId: "j", status: "processing", progress: 10 }),
        json(200, { jobId: "j", status: "processing", progress: 60 }),
        json(200, { jobId: "j", status: "completed", slideCount: 2, creditsUsed: 2 }),
      ),
    );
    const job = await c.wait("j", { pollIntervalMs: 0 });
    expect(job.isCompleted).toBe(true);
    expect(job.creditsUsed).toBe(2);
  });

  it("throws JobFailedError on failure with the snapshot", async () => {
    const c = client(
      fetchSequence(
        json(200, {
          jobId: "j",
          status: "failed",
          slideCount: 3,
          creditsRefunded: 3,
          error: { code: "CONVERSION_FAILED", message: "boom" },
        }),
      ),
    );
    await expect(c.wait("j", { pollIntervalMs: 0 })).rejects.toMatchObject({
      name: "JobFailedError",
      code: "CONVERSION_FAILED",
    });
  });

  it("backs off on 429 then continues", async () => {
    const c = client(
      fetchSequence(
        json(429, { error: { code: "RATE_LIMITED", message: "slow" } }, { "Retry-After": "0" }),
        json(200, { jobId: "j", status: "completed" }),
      ),
    );
    const job = await c.wait("j", { pollIntervalMs: 0 });
    expect(job.isCompleted).toBe(true);
  });

  it("throws Image2PPTTimeoutError past the deadline", async () => {
    const c = client(fetchSequence(json(200, { jobId: "j", status: "processing" })));
    await expect(c.wait("j", { pollIntervalMs: 0, timeoutMs: 0 })).rejects.toBeInstanceOf(
      Image2PPTTimeoutError,
    );
  });

  it("retries a transient 5xx then completes", async () => {
    const c = client(
      fetchSequence(
        json(500, { error: { code: "STORAGE_FAILED", message: "oops" } }),
        json(200, { jobId: "j", status: "completed" }),
      ),
    );
    const job = await c.wait("j", { pollIntervalMs: 0 });
    expect(job.isCompleted).toBe(true);
  });

  it("aborts on a 4xx (job gone) during polling", async () => {
    const c = client(fetchSequence(json(404, { error: { code: "JOB_NOT_FOUND", message: "gone" } })));
    await expect(c.wait("j", { pollIntervalMs: 0 })).rejects.toBeInstanceOf(JobNotFoundError);
  });
});

// --------------------------------------------------------------------------- //
// convert (end-to-end: submit -> wait -> download)
// --------------------------------------------------------------------------- //
describe("convert", () => {
  it("submits, waits, and streams the download to disk", async () => {
    const out = join(dir, "out.pptx");
    const file = await tempFile();
    const c = client(
      fetchSequence(
        json(201, { jobId: "job_9", status: "pending", slideCount: 1, creditsReserved: 1 }),
        json(200, { jobId: "job_9", status: "completed", slideCount: 1, creditsUsed: 1 }),
        new Response(Buffer.from("PPTXDATA"), { status: 200 }),
      ),
    );
    const job = await c.convert([file], out, { pollIntervalMs: 0 });
    expect(job.isCompleted).toBe(true);
    expect(job.jobId).toBe("job_9");
    expect((await readFile(out)).toString()).toBe("PPTXDATA");
  });
});

// --------------------------------------------------------------------------- //
// download / account
// --------------------------------------------------------------------------- //
describe("download & account", () => {
  it("writes the PPTX bytes to disk", async () => {
    const out = join(dir, "out.pptx");
    const c = client(fetchSequence(new Response(Buffer.from("PPTXBYTES"), { status: 200 })));
    const path = await c.download("j", out);
    expect(path).toBe(out);
    expect((await readFile(out)).toString()).toBe("PPTXBYTES");
  });

  it("maps 409 to NotReadyError", async () => {
    const out = join(dir, "out.pptx");
    const c = client(fetchSequence(json(409, { error: { code: "NOT_READY", message: "wait" } })));
    await expect(c.download("j", out)).rejects.toBeInstanceOf(NotReadyError);
  });

  it("returns account info", async () => {
    const c = client(fetchSequence(json(200, { email: "you@example.com", credits: 42 })));
    const info = await c.account();
    expect(info.email).toBe("you@example.com");
    expect(info.credits).toBe(42);
  });
});

// --------------------------------------------------------------------------- //
// error mapping
// --------------------------------------------------------------------------- //
describe("error mapping", () => {
  it("carries retryAfter on 429", async () => {
    const c = client(fetchSequence(json(429, { error: { code: "RATE_LIMITED", message: "slow" } }, { "Retry-After": "12" })));
    await expect(c.account()).rejects.toMatchObject({ name: "RateLimitedError", retryAfter: 12 });
    const c2 = client(fetchSequence(json(429, { error: { code: "RATE_LIMITED", message: "slow" } }, { "Retry-After": "12" })));
    await expect(c2.account()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("falls back for a non-JSON error body", async () => {
    const c = client(fetchSequence(new Response("<html>gateway error</html>", { status: 500 })));
    await expect(c.account()).rejects.toMatchObject({ name: "Image2PPTError", statusCode: 500 });
  });
});

// --------------------------------------------------------------------------- //
// Job model
// --------------------------------------------------------------------------- //
describe("Job", () => {
  it("maps camelCase fields and terminal flags", () => {
    const job = Job.fromJson({ jobId: "j", status: "completed", creditsUsed: 5, creditsRefunded: 1 });
    expect(job.jobId).toBe("j");
    expect(job.isCompleted).toBe(true);
    expect(job.isTerminal).toBe(true);
    expect(job.creditsUsed).toBe(5);
  });
});

// --------------------------------------------------------------------------- //
// upload size guard — the regression this whole feature exists for
//
// A submission over the per-request size cap does not come back as an error: the
// network layer in front of the API drops the connection mid-upload, and the
// caller sees a bare write timeout. So the only acceptable behavior is to refuse
// locally, having sent nothing. Every test here asserts on the recorded calls.
// --------------------------------------------------------------------------- //

/** A file of exactly `size` bytes, allocated sparsely (instant, no real I/O). */
async function sparseFile(name: string, size: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "");
  await truncate(path, size);
  return path;
}

async function manyImages(count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    paths.push(await tempFile(`p${String(i).padStart(3, "0")}.png`));
  }
  return paths;
}

describe("upload size guard", () => {
  it("refuses an oversized batch without sending anything", async () => {
    // Two individually-legal files that add up past the request cap.
    const half = Math.floor(MAX_UPLOAD_BYTES / 2);
    const files = [
      await sparseFile("a.png", half),
      await sparseFile("b.png", half + 1),
    ];
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    await expect(client(f).submit(files)).rejects.toBeInstanceOf(InvalidFileError);
    await expect(client(f).submit(files)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(f.calls).toHaveLength(0); // nothing went on the wire
  });

  it("refuses too many pages without sending anything", async () => {
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    await expect(client(f).submit(files)).rejects.toBeInstanceOf(TooManySlidesError);
    expect(f.calls).toHaveLength(0);
  });

  it("still sends exactly one request for a submission within the limits", async () => {
    const file = await tempFile();
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    expect(postedFilenames(f)).toEqual([["a.png"]]);
  });
});

// --------------------------------------------------------------------------- //
// submitAll / convertAll — automatic batching
// --------------------------------------------------------------------------- //
describe("submitAll", () => {
  it("splits past the page limit into two jobs", async () => {
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const ids = ["job_a", "job_b"];
    const f = fetchScript((n) => json(201, { jobId: ids[n - 1], status: "pending" }));

    const jobs = await client(f).submitAll(files);

    expect(jobs.map((job) => job.jobId)).toEqual(ids);
    const sent = postedFilenames(f);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(MAX_PAGES_PER_JOB);
    expect(sent[1]).toEqual([`p${String(MAX_PAGES_PER_JOB).padStart(3, "0")}.png`]);
  });

  it("gives a PDF its own job", async () => {
    const img = await tempFile("a.png");
    const doc = await tempFile("doc.pdf");
    const f = fetchScript(() => json(201, { jobId: "j", status: "pending" }));

    await client(f).submitAll([img, doc]);

    expect(postedFilenames(f)).toEqual([["a.png"], ["doc.pdf"]]);
  });

  it("behaves like submit for a single batch", async () => {
    const files = await manyImages(3);
    const f = fetchScript(() => json(201, { jobId: "j", status: "pending" }));

    const jobs = await client(f).submitAll(files);

    expect(jobs).toHaveLength(1);
    expect(postedFilenames(f)).toHaveLength(1);
  });
});

describe("convertAll", () => {
  it("writes one numbered PPTX per batch", async () => {
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const outDir = join(dir, "decks");
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      json(201, { jobId: "job_b", status: "pending" }),
      json(200, { jobId: "job_a", status: "completed" }),
      new Response(Buffer.from("DECK-A"), { status: 200 }),
      json(200, { jobId: "job_b", status: "completed" }),
      new Response(Buffer.from("DECK-B"), { status: 200 }),
    );

    const written = await client(f).convertAll(files, outDir, { pollIntervalMs: 0 });

    expect(written).toEqual([join(outDir, "part-01.pptx"), join(outDir, "part-02.pptx")]);
    expect((await readFile(written[0])).toString()).toBe("DECK-A");
    expect((await readFile(written[1])).toString()).toBe("DECK-B");
  });
});

// --------------------------------------------------------------------------- //
// a failed submission is NOT retried
//
// This looks like a missing feature; it is a deliberate one. A network error
// proves only that the exchange broke — the server may have received the whole
// body, created the job and reserved credits, and then lost the connection while
// answering. Retrying that case charges the user twice. Nothing here can tell the
// two apart without an idempotency key the API does not offer, so the error goes
// to the caller untouched. These tests exist so nobody quietly adds the retry back.
// --------------------------------------------------------------------------- //
describe("no automatic submit retry", () => {
  it("does not retry a broken connection", async () => {
    const file = await tempFile();
    const f = fetchScript(() => {
      throw new TypeError("fetch failed");
    });

    await expect(client(f).submit([file])).rejects.toBeInstanceOf(TypeError);
    expect(f.calls).toHaveLength(1); // tried exactly once
  });

  it("does not retry a request it timed out", async () => {
    const file = await tempFile();
    const f = fetchScript(() => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    });

    await expect(client(f).submit([file])).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("does not retry an HTTP error answer", async () => {
    const file = await tempFile();
    const f = fetchSequence(
      json(402, { error: { code: "INSUFFICIENT_CREDITS", message: "no" } }),
    );

    await expect(client(f).submit([file])).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(f.calls).toHaveLength(1);
  });

  it("does not retry inside submitAll either, and still hands back the jobs", async () => {
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    let n = 0;
    const f = fetchScript(() => {
      n += 1;
      if (n === 1) return json(201, { jobId: "job_a", status: "pending" });
      throw new TypeError("fetch failed");
    });

    const err = await client(f).submitAll(files).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(f.calls).toHaveLength(2); // batch 1, then batch 2 once
    expect(submittedIds(err)).toEqual(["job_a"]);
  });
});

// --------------------------------------------------------------------------- //
// submitAll rate limiting
//
// A pile big enough to need batching is a pile big enough to hit the per-minute
// page quota, so a 429 mid-pile is the normal case, not an exception. If it were
// thrown, batching would only trade one failure for another. Retry-After is 0 in
// these tests so nothing actually sleeps.
// --------------------------------------------------------------------------- //
function rateLimited(retryAfter?: string): Response {
  return json(
    429,
    { error: { code: "RATE_LIMITED", message: "slow down" } },
    retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  );
}

/** Job ids off an error's `submittedJobs`, whatever error type it is. */
function submittedIds(err: unknown): string[] {
  return ((err as { submittedJobs?: JobType[] }).submittedJobs ?? []).map((j) => j.jobId);
}

describe("submitAll rate limiting", () => {
  it("waits out a rate limit and retries the same batch", async () => {
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      rateLimited("0"), // second batch bounces off the per-minute quota
      json(201, { jobId: "job_b", status: "pending" }),
    );

    const jobs = await client(f).submitAll(files);

    expect(jobs.map((job) => job.jobId)).toEqual(["job_a", "job_b"]);
    const sent = postedFilenames(f);
    expect(sent).toHaveLength(3); // batch 1, the rejected batch 2, then batch 2 again
    expect(sent[1]).toEqual(sent[2]); // the retry carried exactly the same files
  });

  it("hands back created jobs when it gives up", async () => {
    // Giving up must not strand the jobs already created — they are running and
    // their credits are already reserved.
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const f = fetchSequence(json(201, { jobId: "job_a", status: "pending" }), rateLimited("0"));
    // No waiting budget at all: the first 429 ends it.
    const c = new Image2PPTClient({
      apiKey: "i2p_live_test",
      fetch: f,
      rateLimitMaxWaitMs: 0,
    });

    const err = await c.submitAll(files).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitedError);
    expect(submittedIds(err)).toEqual(["job_a"]);
    expect(postedFilenames(f)).toHaveLength(2); // no pointless extra attempt
  });

  it("uses a default wait when the server sends no Retry-After", async () => {
    // The delay is captured off setTimeout rather than actually slept through, so
    // the test pins the documented 5s fallback without taking 5s.
    const files = await manyImages(2);
    const f = fetchSequence(rateLimited(), json(201, { jobId: "job_a", status: "pending" }));
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn, 0);
      }) as unknown as typeof setTimeout);

    try {
      const jobs = await client(f).submitAll(files);
      expect(jobs.map((job) => job.jobId)).toEqual(["job_a"]);
    } finally {
      spy.mockRestore();
    }

    expect(delays).toEqual([5_000]); // the documented fallback, not zero
  });

  it("keeps submittedJobs on a non-rate-limit failure too", async () => {
    // Any failure mid-pile strands paid-for jobs, not just a rate limit.
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      json(402, { error: { code: "INSUFFICIENT_CREDITS", message: "no" } }),
    );

    const err = await client(f).submitAll(files).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(submittedIds(err)).toEqual(["job_a"]);
  });

  it("convertAll hands back jobs when a later one fails", async () => {
    // The first deck is on disk, the second job failed — but jobs 1..N are all
    // still identified on the error.
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const outDir = join(dir, "decks");
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      json(201, { jobId: "job_b", status: "pending" }),
      json(200, { jobId: "job_a", status: "completed" }),
      new Response(Buffer.from("DECK-A"), { status: 200 }),
      json(200, {
        jobId: "job_b",
        status: "failed",
        error: { code: "CONVERSION_FAILED", message: "boom" },
      }),
    );

    const err = await client(f)
      .convertAll(files, outDir, { pollIntervalMs: 0 })
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe("JobFailedError");
    expect(submittedIds(err)).toEqual(["job_a", "job_b"]);
    expect((await readFile(join(outDir, "part-01.pptx"))).toString()).toBe("DECK-A");
  });
});


// --------------------------------------------------------------------------- //
// per-file limit and destination checks — both must fail before spending money
// --------------------------------------------------------------------------- //
describe("per-file limit", () => {
  it("refuses a single file over the per-file limit", async () => {
    // It fits the 45MB request cap, but the server rejects it every time.
    const big = await sparseFile("big.pdf", MAX_FILE_BYTES + 1);
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    const err = await client(f).submit([big]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidFileError);
    expect((err as InvalidFileError).code).toBe("INVALID_FILE");
    expect((err as Error).message).toContain("big.pdf");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses it in submitAll too, instead of planning a doomed batch", async () => {
    const big = await sparseFile("big.pdf", MAX_FILE_BYTES + 1);
    const img = await tempFile("a.png");
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    await expect(client(f).submitAll([img, big])).rejects.toBeInstanceOf(InvalidFileError);
    expect(f.calls).toHaveLength(0); // the good file isn't submitted either
  });
});

describe("convertAll destination", () => {
  it("checks the destination before submitting anything", async () => {
    // An unusable destDir must not cost credits: no job may exist afterwards.
    const files = await manyImages(2);
    const notADir = join(dir, "decks");
    await writeFile(notADir, "I am a regular file");
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    await expect(client(f).convertAll(files, notADir)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------- //
// PDF pages, and a destination that only *looks* usable
// --------------------------------------------------------------------------- //
describe("PDF pages in submit", () => {
  it("counts a PDF as a page, so 50 images plus one is refused", async () => {
    // 50 images is exactly the limit; any PDF alongside makes it at least 51, so
    // the server would reject it every time. Refuse locally, send nothing.
    const files = await manyImages(MAX_PAGES_PER_JOB);
    files.push(await tempFile("doc.pdf"));
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    const err = await client(f).submit(files).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TooManySlidesError);
    expect((err as Error).message).toContain("at least 51");
    expect(f.calls).toHaveLength(0);
  });

  it("still accepts 49 images plus one PDF", async () => {
    // The guard must not over-reach: 49 + 1 is exactly 50 at the lower bound.
    const files = await manyImages(MAX_PAGES_PER_JOB - 1);
    files.push(await tempFile("doc.pdf"));
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit(files);

    expect(postedFilenames(f)).toHaveLength(1);
  });
});

describe("convertAll destination writability", () => {
  it("refuses a destDir that exists but cannot be written", async () => {
    // The bug this catches: a recursive mkdir SUCCEEDS on a read-only directory,
    // so creating the directory early proved nothing — the submissions still went
    // out and only writing the first deck failed, after the credits were spent.
    const files = await manyImages(2);
    const readOnly = join(dir, "decks");
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    try {
      const err = await client(f).convertAll(files, readOnly).catch((e: unknown) => e);
      expect((err as Error).message).toContain("cannot write");
      expect(f.calls).toHaveLength(0); // nothing submitted, nothing charged
    } finally {
      await chmod(readOnly, 0o755); // let the temp-dir cleanup remove it
    }
  });

  it("leaves no probe file behind", async () => {
    const files = await manyImages(1);
    const outDir = join(dir, "decks");
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      json(200, { jobId: "job_a", status: "completed" }),
      new Response(Buffer.from("DECK-A"), { status: 200 }),
    );

    await client(f).convertAll(files, outDir, { pollIntervalMs: 0 });

    expect((await readdir(outDir)).sort()).toEqual(["part-01.pptx"]);
  });
});
