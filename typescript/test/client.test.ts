/**
 * Unit tests for the image2ppt Node client.
 *
 * Uses an injected fake `fetch` returning real `Response` objects (Node 18+ has
 * them globally), so there's no network and no mocking library. Polling tests use
 * pollIntervalMs=0 to run instantly. Rate-limit tests capture the delay off
 * `setTimeout` instead of sleeping through it: `Retry-After` is floored (see
 * "Retry-After sanitising"), so setting it to 0 no longer skips the wait.
 */

import { randomFillSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  AuthenticationError,
  Image2PPTClient,
  Image2PPTTimeoutError,
  InsufficientCreditsError,
  InvalidAspectRatioError,
  InvalidFileError,
  Job,
  JobAlreadyFinishedError,
  JobCancelledError,
  JobFailedError,
  JobNotFoundError,
  MalformedUploadError,
  MAX_FILE_BYTES,
  MAX_PAGES_PER_JOB,
  MAX_UPLOAD_BYTES,
  NoFilesError,
  NotReadyError,
  PageRateExceededError,
  RateLimitedError,
  type Job as JobType,
  TooManySlidesError,
  UploadAbortedError,
  VERSION,
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
async function postedFilenames(fetchImpl: RecordingFetch): Promise<string[][]> {
  return Promise.all(
    fetchImpl.calls
      .filter((call) => call.init.method === "POST")
      .map(async (call) => {
        const text = Buffer.from(await new Response(call.init.body).arrayBuffer()).toString("latin1");
        return [...text.matchAll(/Content-Disposition: form-data; name="files"; filename="([^"]+)"/g)].map(
          (match) => match[1]!,
        );
      }),
  );
}

interface PostedFile {
  name: string;
  mime: string;
  body: Buffer;
}

/** Decode the SDK's streaming multipart payload without involving a web server. */
async function postedFiles(fetchImpl: RecordingFetch): Promise<PostedFile[][]> {
  return Promise.all(
    fetchImpl.calls
      .filter((call) => call.init.method === "POST")
      .map(async (call) => {
        const headers = call.init.headers as Record<string, string>;
        const boundary = headers["Content-Type"]!.match(/boundary=(.+)$/)![1]!;
        const payload = Buffer.from(await new Response(call.init.body).arrayBuffer());
        const marker = Buffer.from(`--${boundary}`);
        const nextMarker = Buffer.from(`\r\n--${boundary}`);
        const parts: PostedFile[] = [];
        let position = payload.indexOf(marker);
        while (position !== -1) {
          position += marker.byteLength;
          if (payload.subarray(position, position + 2).equals(Buffer.from("--"))) break;
          position += 2; // CRLF after the boundary
          const headerEnd = payload.indexOf(Buffer.from("\r\n\r\n"), position);
          const header = payload.subarray(position, headerEnd).toString("latin1");
          const bodyStart = headerEnd + 4;
          const bodyEnd = payload.indexOf(nextMarker, bodyStart);
          const filename = header.match(/filename="([^"]+)"/)?.[1];
          const mime = header.match(/Content-Type: ([^\r\n]+)/)?.[1];
          if (filename && mime) {
            parts.push({ name: filename, mime, body: payload.subarray(bodyStart, bodyEnd) });
          }
          position = bodyEnd + 2;
        }
        return parts;
      }),
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
  if (/\.png$/i.test(name)) {
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "#112233" } })
      .png()
      .toFile(path);
  } else {
    await writeFile(path, Buffer.from("fake-file-bytes"));
  }
  return path;
}

async function noisyPng(name: string, width: number, height: number): Promise<string> {
  const path = join(dir, name);
  const raw = randomFillSync(Buffer.alloc(width * height * 3));
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toFile(path);
  return path;
}

async function flatPng(name: string, width: number, height: number): Promise<string> {
  const path = join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: "#010203" } })
    .png({ compressionLevel: 0 })
    .toFile(path);
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

  it("maps UPLOAD_ABORTED to its own type", async () => {
    // The one upload failure a caller may safely resend: the server states it
    // took nothing. It must be distinguishable from MALFORMED_UPLOAD.
    const file = await tempFile();
    const c = client(
      fetchSequence(json(400, { error: { code: "UPLOAD_ABORTED", message: "body incomplete" } })),
    );
    await expect(c.submit([file])).rejects.toMatchObject({
      name: "UploadAbortedError",
      code: "UPLOAD_ABORTED",
      statusCode: 400,
    });
  });

  it("maps MALFORMED_UPLOAD to its own type", async () => {
    // Opposite advice — resending identical bytes is pointless — so it must not
    // share a type with UPLOAD_ABORTED.
    const file = await tempFile();
    const c = client(
      fetchSequence(json(400, { error: { code: "MALFORMED_UPLOAD", message: "bad multipart" } })),
    );
    const err = await c.submit([file]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MalformedUploadError);
    expect(err).not.toBeInstanceOf(UploadAbortedError);
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
describe("cancel", () => {
  it("requests graceful cancellation and returns the winding-down state", async () => {
    const f = fetchSequence(
      json(202, { jobId: "j/1", cancellationRequested: true, finalizing: true }),
    );
    const result = await client(f).cancel("j/1");

    expect(result).toEqual({
      jobId: "j/1",
      cancellationRequested: true,
      finalizing: true,
    });
    expect(f.calls[0]?.url).toBe("https://image2ppt.com/api/v1/jobs/j%2F1/cancel");
    expect(f.calls[0]?.init.method).toBe("POST");
  });

  it("maps a naturally finished job to JobAlreadyFinishedError", async () => {
    const c = client(
      fetchSequence(
        json(409, {
          error: { code: "JOB_ALREADY_FINISHED", message: "already finished" },
        }),
      ),
    );
    await expect(c.cancel("j")).rejects.toBeInstanceOf(JobAlreadyFinishedError);
  });
});

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

  it("throws JobCancelledError when cancellation settles without a deliverable", async () => {
    const c = client(
      fetchSequence(
        json(200, {
          jobId: "j",
          status: "failed",
          cancellationRequested: true,
          error: { code: "JOB_CANCELLED", message: "cancelled" },
        }),
      ),
    );
    const error = await c.wait("j", { pollIntervalMs: 0 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(JobCancelledError);
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error).toMatchObject({ code: "JOB_CANCELLED" });
  });

  it("backs off on 429 then continues", async () => {
    const c = client(
      fetchSequence(
        json(429, { error: { code: "RATE_LIMITED", message: "slow" } }, { "Retry-After": "0" }),
        json(200, { jobId: "j", status: "completed" }),
      ),
    );
    // The header says 0 but the client floors it, so let the timer fire instantly
    // rather than spending a real second of suite time.
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void) =>
        realSetTimeout(cb, 0)) as unknown as typeof setTimeout);
    try {
      const job = await c.wait("j", { pollIntervalMs: 0 });
      expect(job.isCompleted).toBe(true);
    } finally {
      spy.mockRestore();
    }
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
// client-side image preparation — behavior matched to the Python SDK
// --------------------------------------------------------------------------- //
describe("client-side image preparation", () => {
  it("passes through a PNG within the byte and dimension budgets byte-for-byte", async () => {
    const file = await tempFile("small.png");
    const original = await readFile(file);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    expect(part).toMatchObject({ name: "small.png", mime: "image/png" });
    expect(part!.body.equals(original)).toBe(true);
  });

  it("turns a 3MiB in-bounds PNG into a smaller JPEG upload", async () => {
    const file = await noisyPng("photo.png", 1024, 1024);
    const originalSize = (await stat(file)).size;
    expect(originalSize).toBeGreaterThan(3 * 1024 * 1024);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    expect(part).toMatchObject({ name: "photo.jpg", mime: "image/jpeg" });
    expect(part!.body.byteLength).toBeLessThan(originalSize);
    expect((await sharp(part!.body).metadata()).format).toBe("jpeg");
  });

  it("shrinks an image whose longest edge exceeds 2000px", async () => {
    const file = await noisyPng("wide.png", 2100, 1000);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    const metadata = await sharp(part!.body).metadata();
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(2000);
  });

  it("flattens alpha PNGs onto white and removes alpha in JPEG output", async () => {
    const file = join(dir, "alpha.png");
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 0, 0, 0], i);
    await sharp(rgba, { raw: { width: 1024, height: 1024, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toFile(file);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    const decoded = await sharp(part!.body).raw().toBuffer({ resolveWithObject: true });
    expect(part).toMatchObject({ name: "alpha.jpg", mime: "image/jpeg" });
    expect(decoded.info.channels).toBe(3);
    expect([...decoded.data.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it("uses the first JPEG quality step that fits in 1MiB", async () => {
    const file = await noisyPng("quality.png", 1150, 1150);
    const source = await readFile(file);
    const q90 = await sharp(source).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    const q85 = await sharp(source).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
    expect(q90.byteLength).toBeGreaterThan(1024 * 1024);
    expect(q85.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    expect(part!.body.equals(q85)).toBe(true);
  });

  it("keeps an in-bounds image when its JPEG re-encode would be larger", async () => {
    const file = join(dir, "tiny.webp");
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "#112233" } })
      .webp({ quality: 1 })
      .toFile(file);
    const original = await readFile(file);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    expect(part).toMatchObject({ name: "tiny.webp", mime: "image/webp" });
    expect(part!.body.equals(original)).toBe(true);
  });

  it("uses a resized JPEG for an oversized source even when that JPEG is larger", async () => {
    const file = join(dir, "long.webp");
    await sharp({ create: { width: 2001, height: 1, channels: 3, background: "#000000" } })
      .webp({ quality: 1 })
      .toFile(file);
    const originalSize = (await stat(file)).size;
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    const [part] = (await postedFiles(f))[0]!;
    expect(part).toMatchObject({ name: "long.jpg", mime: "image/jpeg" });
    expect(part!.body.byteLength).toBeGreaterThan(originalSize);
    expect((await sharp(part!.body).metadata()).width).toBe(2000);
  });

  it("runs pre-flight and batch planning from compressed image sizes", async () => {
    const files = [await flatPng("one.png", 3200, 3200), await flatPng("two.png", 3200, 3200)];
    expect((await stat(files[0]!)).size + (await stat(files[1]!)).size).toBeGreaterThan(
      MAX_UPLOAD_BYTES,
    );
    const direct = fetchSequence(json(201, { jobId: "direct", status: "pending" }));
    await client(direct).submit(files);
    expect(await postedFilenames(direct)).toEqual([["one.jpg", "two.jpg"]]);

    const batched = fetchSequence(json(201, { jobId: "batched", status: "pending" }));

    const jobs = await client(batched).submitAll(files);

    expect(jobs).toHaveLength(1);
    expect(await postedFilenames(batched)).toEqual([["one.jpg", "two.jpg"]]);
  });

  it("streams PDF bytes unchanged instead of preparing an in-memory image payload", async () => {
    const file = await sparseFile("large.pdf", 2 * 1024 * 1024);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    expect(f.calls[0]!.init.body).toBeInstanceOf(ReadableStream);
    const [part] = (await postedFiles(f))[0]!;
    expect(part).toMatchObject({ name: "large.pdf", mime: "application/pdf" });
    expect(part!.body.byteLength).toBe(2 * 1024 * 1024);
  });

  it("maps undecodable image data to InvalidFileError", async () => {
    const file = join(dir, "broken.png");
    await writeFile(file, "not an image");

    await expect(client(fetchSequence(json(201, {}))).submit([file])).rejects.toMatchObject({
      name: "InvalidFileError",
      code: "INVALID_FILE",
    });
  });

  it("refuses a truncated image rather than uploading a half-decoded one", async () => {
    // Pillow refuses these on the Python side. Uploading the grey remainder would cost
    // the caller a credit for a slide that is half missing.
    const file = join(dir, "cut.jpg");
    await sharp({ create: { width: 800, height: 800, channels: 3, background: "#3366aa" } })
      .jpeg()
      .toFile(file);
    await truncate(file, Math.floor((await stat(file)).size / 2));

    await expect(client(fetchSequence(json(201, {}))).submit([file])).rejects.toMatchObject({
      name: "InvalidFileError",
      code: "INVALID_FILE",
    });
  });

  it("lets a filesystem error stay a filesystem error", async () => {
    await expect(
      client(fetchSequence(json(201, {}))).submit([join(dir, "not-there.png")]),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a .jpeg name as it is instead of rewriting the extension", async () => {
    const file = join(dir, "photo.jpeg");
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "#112233" } })
      .jpeg()
      .toFile(file);
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit([file]);

    expect(await postedFilenames(f)).toEqual([["photo.jpeg"]]);
  });

  it("preserves upload order with more files than the preparation pool", async () => {
    // Preparation runs a few images at a time; the results still have to line up with
    // the paths the caller passed, in order.
    const names = Array.from({ length: 9 }, (_, index) => `order-${index}.png`);
    const files = await Promise.all(names.map((name) => tempFile(name)));
    const f = fetchSequence(json(201, { jobId: "j", status: "pending" }));

    await client(f).submit(files);

    expect(await postedFilenames(f)).toEqual([names]);
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

  it("maps the cancellation marker and defaults it for old responses", () => {
    expect(
      Job.fromJson({ jobId: "new", status: "processing", cancellationRequested: true })
        .cancellationRequested,
    ).toBe(true);
    expect(Job.fromJson({ jobId: "old", status: "processing" }).cancellationRequested).toBe(false);
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
      await sparseFile("a.pdf", half),
      await sparseFile("b.pdf", half + 1),
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

    expect(await postedFilenames(f)).toEqual([["a.png"]]);
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
    const sent = await postedFilenames(f);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(MAX_PAGES_PER_JOB);
    expect(sent[1]).toEqual([`p${String(MAX_PAGES_PER_JOB).padStart(3, "0")}.png`]);
  });

  it("gives a PDF its own job", async () => {
    const img = await tempFile("a.png");
    const doc = await tempFile("doc.pdf");
    const f = fetchScript(() => json(201, { jobId: "j", status: "pending" }));

    await client(f).submitAll([img, doc]);

    expect(await postedFilenames(f)).toEqual([["a.png"], ["doc.pdf"]]);
  });

  it("behaves like submit for a single batch", async () => {
    const files = await manyImages(3);
    const f = fetchScript(() => json(201, { jobId: "j", status: "pending" }));

    const jobs = await client(f).submitAll(files);

    expect(jobs).toHaveLength(1);
    expect(await postedFilenames(f)).toHaveLength(1);
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

    // Fire the floored wait immediately instead of sleeping through it.
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void) =>
        realSetTimeout(cb, 0)) as unknown as typeof setTimeout);
    let jobs;
    try {
      jobs = await client(f).submitAll(files);
    } finally {
      spy.mockRestore();
    }

    expect(jobs.map((job) => job.jobId)).toEqual(["job_a", "job_b"]);
    const sent = await postedFilenames(f);
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
    expect(await postedFilenames(f)).toHaveLength(2); // no pointless extra attempt
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

    expect(await postedFilenames(f)).toHaveLength(1);
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

// --------------------------------------------------------------------------- //
// Retry-After sanitising
//
// The retry loops sleep for as long as the server asks. Taken literally, two
// legal-looking header values turn that into a tight loop that re-sends the same
// multipart body — tens of megabytes of files — as fast as the link allows, for as
// long as the waiting budget lasts. These pin the floor that stops it, and mirror
// the Python client's tests one for one.
// --------------------------------------------------------------------------- //
describe("Retry-After sanitising", () => {
  /** Run `fn`, capturing every delay handed to setTimeout instead of sleeping. */
  async function captureDelays(fn: () => Promise<void>): Promise<number[]> {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return delays;
  }

  it.each([
    ["0", 1_000], // legal ("retry now"), but literally zero is a flood
    ["0.25", 1_000], // sub-second is the same problem, just slower
    ["12", 12_000], // a real wait is passed through untouched
  ])("floors Retry-After %s to %ims", async (header, expected) => {
    const files = await manyImages(2);
    const f = fetchSequence(
      rateLimited(header as string),
      json(201, { jobId: "job_a", status: "pending" }),
    );

    const delays = await captureDelays(async () => {
      const jobs = await client(f).submitAll(files);
      expect(jobs.map((job) => job.jobId)).toEqual(["job_a"]);
    });

    expect(delays).toEqual([expected]);
  });

  it.each([["-1"], ["nan"], ["Wed, 21 Oct 2026 07:28:00 GMT"]])(
    "treats an unusable Retry-After %s as missing",
    async (header) => {
      const files = await manyImages(2);
      const f = fetchSequence(
        rateLimited(header),
        json(201, { jobId: "job_a", status: "pending" }),
      );

      const delays = await captureDelays(async () => {
        const jobs = await client(f).submitAll(files);
        expect(jobs.map((job) => job.jobId)).toEqual(["job_a"]);
      });

      expect(delays).toEqual([5_000]); // the documented fallback, not a busy loop
    },
  );
});

// --------------------------------------------------------------------------- //
// Destination write probe
// --------------------------------------------------------------------------- //
describe("destination write probe", () => {
  let probeDir: string;
  beforeEach(async () => {
    probeDir = await mkdtemp(join(tmpdir(), "image2ppt-probe-"));
  });
  afterEach(async () => {
    await rm(probeDir, { recursive: true, force: true });
  });

  it("never opens a path it did not create", async () => {
    // A predictable probe name opened for writing truncates whatever is already
    // there — including a symlink someone left in a shared output directory.
    const outDir = join(probeDir, "decks");
    await mkdir(outDir);
    const victim = join(probeDir, "important.txt");
    await writeFile(victim, "do not truncate me");
    await symlink(victim, join(outDir, `.image2ppt-write-test-${process.pid}`));

    const files = await manyImages(1);
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      json(200, { jobId: "job_a", status: "completed" }),
      new Response(Buffer.from("DECK-A"), { status: 200 }),
    );
    await client(f).convertAll(files, outDir, { pollIntervalMs: 0 });

    expect(await readFile(victim, "utf8")).toBe("do not truncate me");
  });
});

// --------------------------------------------------------------------------- //
// Unsupported file types
//
// The accepted extensions are known locally, so uploading a .txt just to be told
// INVALID_FILE is a round trip that never had to happen — and in submitAll the
// batches ahead of it are already jobs with credits reserved by the time the server
// answers.
// --------------------------------------------------------------------------- //
describe("unsupported file types", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "image2ppt-ext-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses an unsupported extension without sending anything", async () => {
    const doc = join(dir, "notes.txt");
    await writeFile(doc, "hello");
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    await expect(client(f).submit([doc])).rejects.toBeInstanceOf(InvalidFileError);
    await expect(client(f).submit([doc])).rejects.toMatchObject({ code: "INVALID_FILE" });
    expect(f.calls).toHaveLength(0);
  });

  it("submitAll refuses before paying for the batches ahead", async () => {
    // The unsupported file is last; the batches before it must not be submitted.
    const files = await manyImages(MAX_PAGES_PER_JOB + 1);
    const doc = join(dir, "notes.docx");
    await writeFile(doc, "hello");
    const f = fetchScript(() => {
      throw new Error("no HTTP request should have been made");
    });

    await expect(client(f).submitAll([...files, doc])).rejects.toBeInstanceOf(
      InvalidFileError,
    );
    expect(f.calls).toHaveLength(0); // nothing created, nothing charged
  });
});

// --------------------------------------------------------------------------- //
// Download is all-or-nothing
// --------------------------------------------------------------------------- //
describe("download atomicity", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "image2ppt-dl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A 200 whose body dies partway through, like a dropped connection. */
  function explodingBody(): Response {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("PK\u0003\u0004 first half"));
        controller.error(new Error("connection reset mid-download"));
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("leaves no truncated file behind", async () => {
    const dest = join(dir, "deck.pptx");
    const f = fetchSequence(explodingBody());

    await expect(client(f).download("job_a", dest)).rejects.toThrow();

    // A half deck would show up in a listing and open nowhere else.
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not destroy the deck already there", async () => {
    // Writing straight to the destination would truncate it on the first chunk.
    // `convertAll` reuses fixed names (part-01.pptx, ...), so a re-run whose
    // download dies partway would replace a good deck with a broken one.
    const dest = join(dir, "deck.pptx");
    await writeFile(dest, "PREVIOUS-GOOD-DECK");
    const f = fetchSequence(explodingBody());

    await expect(client(f).download("job_a", dest)).rejects.toThrow();

    expect(await readFile(dest, "utf8")).toBe("PREVIOUS-GOOD-DECK");
    expect(await readdir(dir)).toEqual(["deck.pptx"]);
  });

  it("writes the whole deck on success", async () => {
    const dest = join(dir, "deck.pptx");
    const f = fetchSequence(new Response(Buffer.from("DECK-BYTES"), { status: 200 }));

    expect(await client(f).download("job_a", dest)).toBe(dest);
    expect(await readFile(dest, "utf8")).toBe("DECK-BYTES");
    expect(await readdir(dir)).toEqual(["deck.pptx"]);
  });
});

// --------------------------------------------------------------------------- //
// Client identification
//
// The shape `docs/api.md` documents, pinned here so the header cannot drift out of
// it. The whole string has to match: appending another product token means the
// caller is no longer recognised as an official SDK.
// --------------------------------------------------------------------------- //
const SDK_USER_AGENT_RE = /^image2ppt-(python|node)\/\S+$/;

const DEPRECATION_HEADERS = {
  Deprecation: "@1793491200",
  Sunset: "Sun, 01 Nov 2026 00:00:00 GMT",
  Link: '<https://github.com/shrektan/image2ppt-sdk/blob/main/CHANGELOG.md>; rel="deprecation"',
};

describe("client identification", () => {
  it("sends a User-Agent naming the SDK and its version", async () => {
    const f = fetchSequence(json(200, { email: "e", credits: 1 }));
    await client(f).account();

    const headers = f.calls[0]?.init.headers as Record<string, string>;
    const ua = headers["User-Agent"];
    expect(ua).toBe(`image2ppt-node/${VERSION}`);
    expect(ua).toMatch(SDK_USER_AGENT_RE);
  });

  it("sends that User-Agent through an injected fetch too", async () => {
    const f = fetchSequence(json(200, { email: "e", credits: 1 }));
    await new Image2PPTClient({ apiKey: "i2p_live_test", fetch: f }).account();

    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`image2ppt-node/${VERSION}`);
  });
});

describe("deprecation warning", () => {
  it("warns once when Deprecation is present", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A new Response each call — reusing one would consume its body the first time.
      const f = fetchScript(() => json(200, { email: "e", credits: 1 }, DEPRECATION_HEADERS));
      const c = client(f);
      await c.account();
      await c.account();
      expect(spy).toHaveBeenCalledTimes(1);
      const msg = String(spy.mock.calls[0]?.[0]);
      expect(msg).toContain(VERSION);
      expect(msg).toMatch(/deprecated/i);
      expect(msg).toContain("CHANGELOG.md");
      expect(msg).toContain("Sun, 01 Nov 2026 00:00:00 GMT");
      expect(msg).toContain("warnOnDeprecated: false");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when the switch is off", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fetchScript(() => json(200, { email: "e", credits: 1 }, DEPRECATION_HEADERS));
      const c = new Image2PPTClient({
        apiKey: "i2p_live_test",
        fetch: f,
        warnOnDeprecated: false,
      });
      await c.account();
      await c.account();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not fail the request if console.warn throws", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new DOMException("boom", "AbortError");
    });
    try {
      const f = fetchScript(() => json(200, { email: "e", credits: 1 }, DEPRECATION_HEADERS));
      const info = await client(f).account();
      expect(info.email).toBe("e");
    } finally {
      spy.mockRestore();
    }
  });

  it("warns on a Deprecation header alone", async () => {
    // Sunset and Link are optional; losing them must not lose the warning.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fetchSequence(
        json(200, { email: "e", credits: 1 }, { Deprecation: "@1793491200" }),
      );
      await client(f).account();
      expect(spy).toHaveBeenCalledTimes(1);
      const msg = String(spy.mock.calls[0]?.[0]);
      expect(msg).toMatch(/deprecated/i);
      expect(msg).toContain("warnOnDeprecated: false");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn without a Deprecation header", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fetchSequence(
        json(200, { email: "e", credits: 1 }, { Sunset: "Sun, 01 Nov 2026 00:00:00 GMT" }),
      );
      await client(f).account();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// --------------------------------------------------------------------------- //
// Error-code mapping for the codes the contract lists
// --------------------------------------------------------------------------- //
describe("documented 400 codes", () => {
  it.each([
    ["NO_FILES", NoFilesError],
    ["INVALID_ASPECT_RATIO", InvalidAspectRatioError],
    ["PAGE_RATE_EXCEEDED", PageRateExceededError],
  ])("maps %s to its own type", async (code, expected) => {
    // These used to land on the base class, so `instanceof InvalidFileError` missed
    // them and callers had to compare strings.
    const files = await manyImages(1);
    const f = fetchSequence(json(400, { error: { code, message: "no" } }));

    const err = await client(f).submit(files).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(expected);
    expect(err).toMatchObject({ code });
  });
});

// --------------------------------------------------------------------------- //
// The rate-limit waiting budget
//
// `rateLimitMaxWaitMs` promises time spent *waiting*. A wall-clock deadline set at
// the start of the call would be spent by the uploads themselves, so on a slow link
// a large pile could exhaust it before the first 429 ever arrived — turning the
// option into "do not wait at all", with the cutoff decided by link speed. Mirrors
// the Python tests of the same name.
// --------------------------------------------------------------------------- //
describe("rate-limit waiting budget", () => {
  /** Run `fn`, capturing every delay handed to setTimeout instead of sleeping. */
  async function captureDelays(fn: () => Promise<void>): Promise<number[]> {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return delays;
  }

  it("is not consumed by upload time", async () => {
    const files = await manyImages(MAX_PAGES_PER_JOB + 1); // two batches
    const f = fetchSequence(
      json(201, { jobId: "job_a", status: "pending" }),
      rateLimited("0"), // second batch bounces
      json(201, { jobId: "job_b", status: "pending" }),
    );
    // The clock races far past the whole budget while the first batch uploads. Only
    // waiting may take from the budget, so this must not change the outcome.
    let ticks = 0;
    const nowSpy = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (ticks += 10_000_000));
    const c = new Image2PPTClient({
      apiKey: "i2p_live_test",
      fetch: f,
      rateLimitMaxWaitMs: 10_000,
    });

    let delays: number[];
    try {
      delays = await captureDelays(async () => {
        const jobs = await c.submitAll(files);
        expect(jobs.map((job) => job.jobId)).toEqual(["job_a", "job_b"]);
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(delays).toEqual([1_000]); // it waited, rather than giving up on a spent clock
  });

  it("is spent by waiting and then gives up", async () => {
    // Two waits of 4s fit in a 10s budget; the third does not.
    const files = await manyImages(2);
    let calls = 0;
    const f = fetchScript(() => {
      calls += 1;
      // A budget that never depletes would retry forever. Fail loudly instead of
      // hanging the suite.
      if (calls > 3) throw new Error("retried past the waiting budget");
      return rateLimited("4");
    });
    const c = new Image2PPTClient({
      apiKey: "i2p_live_test",
      fetch: f,
      rateLimitMaxWaitMs: 10_000,
    });

    const delays = await captureDelays(async () => {
      await expect(c.submitAll(files)).rejects.toBeInstanceOf(RateLimitedError);
    });

    expect(delays).toEqual([4_000, 4_000]); // 8s spent, the third 4s would not fit
  });
});

// --------------------------------------------------------------------------- //
// Retry-After spellings a lenient number parser would accept
//
// `Number("0x10")` is 16 and Python's `float("1e3")` is 1000. Accepting "whatever
// the parser allows" makes the two SDKs disagree about the same header, so both
// match plain decimal seconds explicitly. Mirrors the Python parametrised test.
// --------------------------------------------------------------------------- //
describe("Retry-After spellings", () => {
  async function delaysFor(header: string): Promise<number[]> {
    const files = await manyImages(2);
    const f = fetchSequence(rateLimited(header), json(201, { jobId: "j", status: "pending" }));
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
    try {
      await client(f).submitAll(files);
    } finally {
      spy.mockRestore();
    }
    return delays;
  }

  it.each([["0x10"], ["1e3"], ["+5"], [".5"], ["5s"], ["nan"], ["inf"], ["-1"]])(
    "treats %s as missing and uses the documented fallback",
    async (header) => {
      expect(await delaysFor(header)).toEqual([5_000]);
    },
  );

  it("accepts a value with the transport's surrounding whitespace", async () => {
    expect(await delaysFor("  12  ")).toEqual([12_000]);
  });
});

// --------------------------------------------------------------------------- //
// Retry-After: digits and whitespace must mean the same thing in both clients
//
// The parser matches `[0-9]` and an explicit space-or-tab rather than `\d` and
// `trim()`, because Python's `\d` matches every Unicode decimal digit while
// JavaScript's matches only ASCII — left to the defaults, `Retry-After: ５` would be
// five seconds to the Python client and unparseable here.
//
// That case cannot be written as a test on this side: `Headers` is specified over
// ByteStrings and refuses a non-ASCII value outright, so no `Response` can carry one.
// The test below pins that refusal — it is the reason the disagreement can only ever
// originate on the Python side, and it is what makes the ASCII-only pattern here belt
// and braces rather than dead weight. The Python suite carries the mirrored cases.
// --------------------------------------------------------------------------- //
describe("Retry-After digits and whitespace", () => {
  it.each([["５"], ["١٢"]])(
    "cannot even be delivered as a header value in Node (%s)",
    (value) => {
      expect(() => new Headers({ "Retry-After": value })).toThrow();
    },
  );

  it("still parses a plain value delivered through real headers", async () => {
    const files = await manyImages(2);
    const f = fetchSequence(rateLimited("12"), json(201, { jobId: "j", status: "pending" }));
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
    try {
      await client(f).submitAll(files);
    } finally {
      spy.mockRestore();
    }
    expect(delays).toEqual([12_000]);
  });
});

// --------------------------------------------------------------------------- //
// A batch is not retried forever on a cheap Retry-After
// --------------------------------------------------------------------------- //
describe("batch retry cap", () => {
  it("stops re-uploading long before the waiting budget runs out", async () => {
    // The waiting budget cannot see the uploads, and every retry re-sends them. A
    // server answering `Retry-After: 1` costs a second of budget per round, so a
    // 30-minute budget alone would buy ~1800 rounds — 1800 re-uploads of the same
    // files. The attempt cap is what bounds the work rather than the waiting.
    const files = await manyImages(2);
    const f = fetchScript(() => rateLimited("1"));
    const c = new Image2PPTClient({
      apiKey: "i2p_live_test",
      fetch: f,
      rateLimitMaxWaitMs: 1_800_000,
    });

    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void) =>
        realSetTimeout(cb, 0)) as unknown as typeof setTimeout);
    try {
      await expect(c.submitAll(files)).rejects.toBeInstanceOf(RateLimitedError);
    } finally {
      spy.mockRestore();
    }

    expect(f.calls).toHaveLength(10); // MAX_BATCH_ATTEMPTS, not ~1800
  });
});

// --------------------------------------------------------------------------- //
// Running out of attempts strands paid-for jobs too
// --------------------------------------------------------------------------- //
describe("attempt cap and submittedJobs", () => {
  it("hands back the jobs already created when attempts run out", async () => {
    // There are two ways to give up mid-pile — out of waiting budget, and out of
    // attempts. Both strand paid-for jobs, so both must hand back their ids. The
    // budget path has its own test; this one covers the attempt cap.
    const files = await manyImages(MAX_PAGES_PER_JOB + 1); // two batches
    const f = fetchScript((n) =>
      n === 1 ? json(201, { jobId: "job_a", status: "pending" }) : rateLimited("1"),
    );
    const c = new Image2PPTClient({
      apiKey: "i2p_live_test",
      fetch: f,
      rateLimitMaxWaitMs: 1_800_000,
    });

    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void) =>
        realSetTimeout(cb, 0)) as unknown as typeof setTimeout);
    let err: unknown;
    try {
      err = await c.submitAll(files).catch((e: unknown) => e);
    } finally {
      spy.mockRestore();
    }

    expect(err).toBeInstanceOf(RateLimitedError);
    expect(submittedIds(err)).toEqual(["job_a"]);
    expect(f.calls).toHaveLength(1 + 10); // first batch, then MAX_BATCH_ATTEMPTS
  });
});

// --------------------------------------------------------------------------- //
// Retry-After beyond what a timer can represent
//
// A delay past 2**31-1 ms is not representable here: `setTimeout` silently clamps it
// to *1 millisecond*, so an absurd header would turn "wait" into "retry immediately,
// at full speed" for every permitted attempt. Python fails differently on the same
// input (`time.sleep` raises OverflowError), so the two clients would also stop
// agreeing. Both draw the line at the same number. Mirrors the Python cases.
// --------------------------------------------------------------------------- //
describe("Retry-After beyond the timer range", () => {
  async function delaysFor(header: string, budgetMs: number): Promise<number[]> {
    const files = await manyImages(2);
    const f = fetchSequence(rateLimited(header), json(201, { jobId: "j", status: "pending" }));
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
    try {
      await new Image2PPTClient({
        apiKey: "i2p_live_test",
        fetch: f,
        rateLimitMaxWaitMs: budgetMs,
      }).submitAll(files);
    } finally {
      spy.mockRestore();
    }
    return delays;
  }

  // A budget generous enough that it cannot be what rejects these.
  const HUGE_BUDGET = Number.MAX_SAFE_INTEGER;

  it.each([["99999999999999999999"], ["2147484"]])(
    "treats %s as a header the server never sent",
    async (header) => {
      expect(await delaysFor(header, HUGE_BUDGET)).toEqual([5_000]);
    },
  );

  it("still honours a value just inside the line", async () => {
    expect(await delaysFor("2147483", HUGE_BUDGET)).toEqual([2_147_483_000]);
  });
});

// --------------------------------------------------------------------------- //
// Every wait is bounded, not just a server-sent Retry-After
//
// The polling backoff is seeded from the caller's own pollIntervalMs, and a 429
// without a Retry-After reuses that seed unchanged. With a large enough timeoutMs the
// deadline does not bound it either — both bounds are caller-supplied, so neither
// constrains the other. Past the timer range that stops being a wait at all:
// setTimeout clamps to 1ms and the client hammers the server. Mirrors the Python tests.
// --------------------------------------------------------------------------- //
describe("every wait is bounded", () => {
  async function delaysWhilePolling(
    pollIntervalMs: number,
    timeoutMs: number,
  ): Promise<number[]> {
    const f = fetchSequence(
      json(429, { error: { code: "RATE_LIMITED", message: "slow" } }),
      json(200, { jobId: "j", status: "completed" }),
    );
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
    try {
      const job = await client(f).wait("j", { pollIntervalMs, timeoutMs });
      expect(job.isCompleted).toBe(true);
    } finally {
      spy.mockRestore();
    }
    return delays;
  }

  it("clamps a huge poll interval to the timer range", async () => {
    // 2**31-1: past this, setTimeout would clamp to 1ms and poll in a tight loop.
    expect(await delaysWhilePolling(1e18, 1e18)).toEqual([2 ** 31 - 1]);
  });

  it("still lets the deadline win when it is the smaller bound", async () => {
    const delays = await delaysWhilePolling(1e18, 30_000);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[0]).toBeLessThanOrEqual(30_000); // the deadline, not the clamp
  });
});
