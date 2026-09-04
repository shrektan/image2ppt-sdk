/**
 * End-to-end wire tests: the client talking to a real HTTP server over a real socket.
 *
 * The rest of the suite injects a fake `fetch` that never reads the request body, so
 * it cannot see what actually goes out. This file can. The client builds its own
 * multipart body and streams it, which puts two things beyond the reach of a fake:
 * whether the stream survives being consumed by the runtime, and whether the
 * `Content-Length` the client computes is the number of bytes that arrive.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { Image2PPTClient } from "../src/index.js";

interface Received {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let server: Server;
let baseUrl: string;
let received: Received[];
let dir: string;

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(parts) });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobId: "job-1", status: "pending" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "image2ppt-wire-"));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function client(): Image2PPTClient {
  return new Image2PPTClient({ apiKey: "i2p_live_test", baseUrl });
}

async function png(name: string, width: number, height: number): Promise<string> {
  const path = join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: "#204060" } })
    .png()
    .toFile(path);
  return path;
}

/**
 * An image whose bytes cannot be squeezed small. Random pixels compress to nothing,
 * so what goes on the wire is a payload of several megabytes rather than the few
 * hundred kilobytes a photograph turns into. The size is the point: the part has to
 * be big enough that writing it to a slow receiver takes longer than a whole idle
 * budget.
 */
async function noisyPng(name: string, edge: number): Promise<string> {
  const path = join(dir, name);
  await sharp(randomBytes(edge * edge * 3), {
    raw: { width: edge, height: edge, channels: 3 },
  })
    .png()
    .toFile(path);
  return path;
}

describe("submitting over a real socket", () => {
  it("declares a Content-Length equal to the bytes that arrive, and does not go out chunked", async () => {
    const files = [await png("a.png", 40, 40), await png("b.png", 3000, 40)];
    const pdf = join(dir, "doc.pdf");
    await writeFile(pdf, Buffer.alloc(64 * 1024, 7));

    const job = await client().submit([...files, pdf], { locale: "zh-CN" });

    expect(job.jobId).toBe("job-1");
    const [call] = received;
    expect(call).toBeDefined();
    expect(call!.headers["transfer-encoding"]).toBeUndefined();
    expect(Number(call!.headers["content-length"])).toBe(call!.body.byteLength);
  });

  it("delivers every part intact — filenames, types, and bytes", async () => {
    const small = await png("small.png", 20, 20);
    const pdf = join(dir, "doc.pdf");
    const pdfBytes = Buffer.alloc(8192, 3);
    await writeFile(pdf, pdfBytes);

    await client().submit([small, pdf], { aspectRatio: "16:9" });

    const text = received[0]!.body.toString("latin1");
    expect(text).toContain('filename="small.png"');
    expect(text).toContain("Content-Type: image/png");
    expect(text).toContain('filename="doc.pdf"');
    expect(text).toContain("Content-Type: application/pdf");
    expect(text).toContain('name="aspectRatio"\r\n\r\n16:9\r\n');
    // The PDF was streamed from disk rather than buffered; it must still arrive whole.
    expect(received[0]!.body.includes(pdfBytes)).toBe(true);
  });

  it("fails loudly when a PDF shrinks between being measured and being sent", async () => {
    // The PDF is streamed rather than buffered, so its bytes are read after the size
    // that Content-Length was computed from. Sending a body shorter than its own
    // header would hang or truncate; the client has to refuse instead.
    const pdf = join(dir, "doc.pdf");
    await writeFile(pdf, Buffer.alloc(200_000, 9));
    const submission = client().submit([pdf]);
    // `truncate` shrinks in place. Rewriting the file would blank it first, and a
    // read landing in that window would prove nothing about a shrunken file.
    await truncate(pdf, 10);

    // `fetch` buries a body-side throw in `cause`; the client digs it back out, so
    // the caller sees the SDK's own error rather than a bare "fetch failed".
    await expect(submission).rejects.toMatchObject({
      name: "Image2PPTError",
      code: "FILE_CHANGED",
      message: expect.stringContaining("changed while it was being uploaded"),
    });
  });

  it("fails loudly when a PDF grows between being measured and being sent", async () => {
    // Growing is the sneakier direction: the read stops at the measured size, so the
    // byte count still adds up and only the document arrives cut in half.
    const pdf = join(dir, "doc.pdf");
    await writeFile(pdf, Buffer.alloc(200_000, 9));
    const submission = client().submit([pdf]);
    // Append rather than rewrite, so the file only ever grows.
    await appendFile(pdf, Buffer.alloc(200_000, 9));

    await expect(submission).rejects.toMatchObject({
      name: "Image2PPTError",
      code: "FILE_CHANGED",
    });
  });

  it("reports a PDF deleted mid-upload as a changed file, not as a bare fetch failure", async () => {
    const pdf = join(dir, "doc.pdf");
    await writeFile(pdf, Buffer.alloc(200_000, 9));
    const submission = client().submit([pdf]);
    await rm(pdf, { force: true });

    await expect(submission).rejects.toMatchObject({
      name: "Image2PPTError",
      code: "FILE_CHANGED",
    });
  });

  it("percent-encodes a quote in a filename instead of breaking the header", async () => {
    const path = await png('we"ird.png', 20, 20);

    await client().submit([path]);

    const text = received[0]!.body.toString("latin1");
    expect(text).toContain('filename="we%22ird.png"');
  });

  it("re-sends the whole body on a rate-limit retry", async () => {
    let firstCall = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(parts) });
        if (firstCall) {
          firstCall = false;
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
          res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } }));
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jobId: "job-2", status: "pending" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const jobs = await new Image2PPTClient({
      apiKey: "i2p_live_test",
      baseUrl,
      rateLimitMaxWaitMs: 30_000,
    }).submitAll([await png("retry.png", 30, 30)]);

    expect(jobs.map((job) => job.jobId)).toEqual(["job-2"]);
    expect(received).toHaveLength(2);
    // A consumed stream would make the second attempt arrive short or empty.
    expect(received[1]!.body.equals(received[0]!.body.subarray(0, 0))).toBe(false);
    expect(received[1]!.body.byteLength).toBe(received[0]!.body.byteLength);
    expect(Number(received[1]!.headers["content-length"])).toBe(received[1]!.body.byteLength);
  }, 20_000);

  it("keeps a slow but progressing upload alive past the idle timeout", async () => {
    // What `timeoutMs` means: nothing moved for this long. A receiver that takes the
    // body in small sips holds one request open for several times that budget while
    // never once going quiet, and that request has to succeed.
    //
    // This is out of reach of the injected `fetch` the rest of the suite uses,
    // because that one never writes a byte anywhere. Only a real socket pushes back:
    // handing the runtime a whole image in a single piece let it swallow the lot
    // immediately, so the upload was reported as progressing once and then said
    // nothing for the whole time the bytes were actually crawling out — and the
    // clock ran out in the middle of a perfectly healthy upload, which is the exact
    // thing an idle timeout exists to prevent. In pieces, the runtime only takes the
    // next one once the previous one has gone, so what gets reported is the transfer
    // as it really moves.
    const sipMs = 20;
    const idleBudgetMs = 1_000;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let bytesIn = 0;
    server = createServer((req, res) => {
      req.on("data", (part: Buffer) => {
        bytesIn += part.byteLength;
        // Stop reading, then start again. The socket stops draining, the client
        // stops being able to write, and the transfer slows right down without ever
        // actually stopping.
        req.pause();
        setTimeout(() => req.resume(), sipMs);
      });
      req.on("end", () => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jobId: "job-slow", status: "pending" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Enough megabytes that the sips add up to several times the idle budget.
    const paths = await Promise.all(
      [1, 2, 3, 4].map((n) => noisyPng(`noise-${n}.png`, 2000)),
    );

    const started = Date.now();
    const job = await new Image2PPTClient({
      apiKey: "i2p_live_test",
      baseUrl,
      timeoutMs: idleBudgetMs,
    }).submit(paths);
    const elapsed = Date.now() - started;

    expect(job.jobId).toBe("job-slow");
    // Proof the request really did outlast its own idle budget, several times over,
    // rather than the server having quietly swallowed everything at full speed.
    expect(elapsed).toBeGreaterThan(idleBudgetMs * 2);
    expect(bytesIn).toBeGreaterThan(8_000_000);
  }, 120_000);

  it("gives the body its own idle budget once the response headers arrive", async () => {
    // The response headers arriving *is* data moving: the service just answered. If
    // that does not restart the clock, the whole time spent waiting for the answer
    // is charged against the body as well, and a deck the service took a while to
    // start sending is cut off while it is arriving perfectly normally. Worse on a
    // submission — the caller sees a failure for a job the service accepted, and
    // resubmitting by hand pays for it twice.
    const idleBudgetMs = 1_000;
    const headerDelayMs = 800;
    const firstChunkDelayMs = 400;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      req.resume();
      // Answer late, but well inside the budget on its own.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        // Put the headers on the wire now. `writeHead` alone only stages them —
        // they would otherwise travel with the first body write, and the client
        // would rightly see one long silence instead of an answer followed by a
        // pause.
        res.flushHeaders();
        // Then start sending. Each gap is inside the budget; only the two added
        // together exceed it, which is exactly what a missing restart would do.
        let sent = 0;
        const push = (): void => {
          if (sent === 3) {
            res.end();
            return;
          }
          sent += 1;
          res.write(randomBytes(1024));
          setTimeout(push, firstChunkDelayMs);
        };
        setTimeout(push, firstChunkDelayMs);
      }, headerDelayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dest = join(dir, "late-answer.pptx");
    const started = Date.now();
    await new Image2PPTClient({
      apiKey: "i2p_live_test",
      baseUrl,
      timeoutMs: idleBudgetMs,
    }).download("job-late", dest);

    // Proof the download really did outlive a single idle budget while never once
    // going quiet for longer than one.
    expect(Date.now() - started).toBeGreaterThan(idleBudgetMs);
  }, 60_000);
});
