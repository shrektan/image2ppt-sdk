/**
 * End-to-end wire tests: the client talking to a real HTTP server over a real socket.
 *
 * The rest of the suite injects a fake `fetch` that never reads the request body, so
 * it cannot see what actually goes out. This file can. The client builds its own
 * multipart body and streams it, which puts two things beyond the reach of a fake:
 * whether the stream survives being consumed by the runtime, and whether the
 * `Content-Length` the client computes is the number of bytes that arrive.
 */

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
});
