/**
 * Unit tests for the image2ppt Node client.
 *
 * Uses an injected fake `fetch` returning real `Response` objects (Node 18+ has
 * them globally), so there's no network and no mocking library. Polling tests use
 * pollIntervalMs=0 / Retry-After: 0 to run instantly.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  Image2PPTClient,
  Image2PPTTimeoutError,
  InsufficientCreditsError,
  Job,
  NotReadyError,
  RateLimitedError,
} from "../src/index.js";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake fetch that returns the given responses in sequence. */
function fetchSequence(...responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => {
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res;
  }) as unknown as typeof fetch;
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
