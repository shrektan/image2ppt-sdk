/**
 * Unit tests for upload-size limits and batch planning.
 *
 * Pure functions only: no client, no files, no network. Sizes are plain numbers,
 * so these run instantly and stay readable.
 */

import { describe, expect, it } from "vitest";

import {
  BATCH_TARGET_BYTES,
  InvalidFileError,
  MAX_PAGES_PER_JOB,
  MAX_UPLOAD_BYTES,
  TooManySlidesError,
  type UploadItem,
  checkSubmission,
  planBatches,
} from "../src/index.js";

const img = (path: string, size = 1): UploadItem => ({ path, size, isPdf: false });
const pdf = (path: string, size = 1): UploadItem => ({ path, size, isPdf: true });

/** Batches as lists of file names, so assertions read like the input. */
const names = (batches: UploadItem[][]): string[][] =>
  batches.map((batch) => batch.map((item) => item.path));

// --------------------------------------------------------------------------- //
// checkSubmission — the pre-flight gate
// --------------------------------------------------------------------------- //
describe("checkSubmission", () => {
  it("accepts a submission sitting exactly on both limits", () => {
    expect(() => checkSubmission(MAX_UPLOAD_BYTES, MAX_PAGES_PER_JOB)).not.toThrow();
  });

  it("rejects one byte over the size cap", () => {
    expect(() => checkSubmission(MAX_UPLOAD_BYTES + 1, 1)).toThrow(InvalidFileError);
    try {
      checkSubmission(MAX_UPLOAD_BYTES + 1, 1);
    } catch (err) {
      expect((err as InvalidFileError).code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("rejects one page over the page cap", () => {
    expect(() => checkSubmission(1, MAX_PAGES_PER_JOB + 1)).toThrow(TooManySlidesError);
  });
});

// --------------------------------------------------------------------------- //
// planBatches — size splitting
// --------------------------------------------------------------------------- //
describe("planBatches size splitting", () => {
  it("plans nothing for empty input", () => {
    expect(planBatches([])).toEqual([]);
  });

  it("refuses a single file over the hard cap — no split can help", () => {
    expect(() => planBatches([img("huge.png", MAX_UPLOAD_BYTES + 1)])).toThrow(
      InvalidFileError,
    );
    try {
      planBatches([img("huge.png", MAX_UPLOAD_BYTES + 1)]);
    } catch (err) {
      expect((err as InvalidFileError).code).toBe("PAYLOAD_TOO_LARGE");
      expect((err as Error).message).toContain("huge.png");
    }
  });

  it("keeps a batch filled exactly to the target as one batch", () => {
    const half = Math.floor(BATCH_TARGET_BYTES / 2);
    const batches = planBatches([img("a", half), img("b", BATCH_TARGET_BYTES - half)]);
    expect(names(batches)).toEqual([["a", "b"]]);
  });

  it("starts a second batch one byte past the target", () => {
    const half = Math.floor(BATCH_TARGET_BYTES / 2);
    const batches = planBatches([img("a", half), img("b", BATCH_TARGET_BYTES - half + 1)]);
    expect(names(batches)).toEqual([["a"], ["b"]]);
  });

  it("still places a file between the target and the hard cap — alone", () => {
    const big = Math.floor((BATCH_TARGET_BYTES + MAX_UPLOAD_BYTES) / 2);
    const batches = planBatches([img("small", 10), img("big", big), img("tail", 10)]);
    expect(names(batches)).toEqual([["small"], ["big"], ["tail"]]);
  });
});

// --------------------------------------------------------------------------- //
// planBatches — page splitting
// --------------------------------------------------------------------------- //
describe("planBatches page splitting", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_v, i) => img(`p${i}`));

  it("keeps exactly the page limit in one batch", () => {
    const batches = planBatches(many(MAX_PAGES_PER_JOB));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(MAX_PAGES_PER_JOB);
  });

  it("splits off one image past the page limit", () => {
    const batches = planBatches(many(MAX_PAGES_PER_JOB + 1));
    expect(batches.map((b) => b.length)).toEqual([MAX_PAGES_PER_JOB, 1]);
    expect(names(batches)[1]).toEqual([`p${MAX_PAGES_PER_JOB}`]);
  });
});

// --------------------------------------------------------------------------- //
// planBatches — PDFs and ordering
// --------------------------------------------------------------------------- //
describe("planBatches PDFs and ordering", () => {
  it("gives each PDF its own batch", () => {
    expect(names(planBatches([pdf("one.pdf"), pdf("two.pdf")]))).toEqual([
      ["one.pdf"],
      ["two.pdf"],
    ]);
  });

  it("splits the images around a PDF — its page count is unknown here", () => {
    expect(names(planBatches([img("a"), pdf("doc.pdf"), img("b")]))).toEqual([
      ["a"],
      ["doc.pdf"],
      ["b"],
    ]);
  });

  it("preserves order and plans the same input the same way twice", () => {
    const items = [img("a", 10), img("b", 20), pdf("c.pdf", 30), img("d", 40)];
    const first = names(planBatches(items));
    expect(first).toEqual([["a", "b"], ["c.pdf"], ["d"]]);
    expect(names(planBatches(items))).toEqual(first);
  });
});
