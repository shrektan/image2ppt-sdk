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
  MAX_FILE_BYTES,
  MAX_PAGES_PER_JOB,
  MAX_UPLOAD_BYTES,
  TooManySlidesError,
  type UploadItem,
  checkFileSize,
  formatBytes,
  checkSubmission,
  planBatches,
} from "../src/index.js";

const img = (path: string, size = 1): UploadItem => ({ path, size, isPdf: false });
const pdf = (path: string, size = 1): UploadItem => ({ path, size, isPdf: true });

/** Batches as lists of file names, so assertions read like the input. */
const names = (batches: UploadItem[][]): string[][] =>
  batches.map((batch) => batch.map((item) => item.path));

// --------------------------------------------------------------------------- //
// checkFileSize — a property of the file, not of the request
//
// The per-file cap is STRICTER than the request cap (35MB vs 45MB), so a file can
// sit comfortably inside a request and still be rejected by the server every time.
// --------------------------------------------------------------------------- //
describe("checkFileSize", () => {
  it("accepts a file sitting exactly on the per-file cap", () => {
    expect(() => checkFileSize("ok.pdf", MAX_FILE_BYTES)).not.toThrow();
  });

  it("refuses a file one byte over, naming it", () => {
    expect(() => checkFileSize("big.pdf", MAX_FILE_BYTES + 1)).toThrow(InvalidFileError);
    try {
      checkFileSize("big.pdf", MAX_FILE_BYTES + 1);
    } catch (err) {
      expect((err as InvalidFileError).code).toBe("INVALID_FILE");
      expect((err as Error).message).toContain("big.pdf");
    }
  });

  it("is stricter than the request cap", () => {
    // Guards the reason this check exists: without it, a file between the two
    // caps looks submittable to the batch planner and never is.
    expect(MAX_FILE_BYTES).toBeLessThan(MAX_UPLOAD_BYTES);
    const between = Math.floor((MAX_FILE_BYTES + MAX_UPLOAD_BYTES) / 2);
    expect(() => checkSubmission(between, 1)).not.toThrow(); // request cap is happy
    expect(() => checkFileSize("between.pdf", between)).toThrow(InvalidFileError);
  });
});

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

  it("refuses a single oversized file — no split can help", () => {
    // The planner applies the per-file cap, so it stops at 35MB not 45MB.
    expect(() => planBatches([img("huge.png", MAX_FILE_BYTES + 1)])).toThrow(
      InvalidFileError,
    );
    try {
      planBatches([img("huge.png", MAX_FILE_BYTES + 1)]);
    } catch (err) {
      expect((err as InvalidFileError).code).toBe("INVALID_FILE");
      expect((err as Error).message).toContain("huge.png");
    }
  });

  it("refuses a file between the two caps", () => {
    // The regression this guards: it fits the request cap, so the planner used to
    // build a batch for it that the server would reject every single time.
    const between = Math.floor((MAX_FILE_BYTES + MAX_UPLOAD_BYTES) / 2);
    expect(() => planBatches([img("doomed.pdf", between)])).toThrow(InvalidFileError);
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

  it("gives two max-size files a batch each", () => {
    // The largest legal file is 35MB, so two of them blow the 40MB batch target
    // and must be split — neither is refused.
    const batches = planBatches([img("a", MAX_FILE_BYTES), img("b", MAX_FILE_BYTES)]);
    expect(names(batches)).toEqual([["a"], ["b"]]);
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

// --------------------------------------------------------------------------- //
// formatBytes — mirrors the Python test of the same name
// --------------------------------------------------------------------------- //
describe("formatBytes", () => {
  it("does not round a small overage down to zero", () => {
    // Otherwise the error reads "45.0MB, over the 45.0MB limit (0.0MB too much)" —
    // self-contradictory, and it looks like the check itself is broken. That is
    // exactly how it printed against the real server.
    expect(formatBytes(1)).toBe("1B");
    expect(formatBytes(32 * 1024)).toBe("32.0KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");

    expect(() => checkSubmission(MAX_UPLOAD_BYTES + 1, 1)).toThrow(InvalidFileError);
    try {
      checkSubmission(MAX_UPLOAD_BYTES + 1, 1);
    } catch (err) {
      expect((err as Error).message).not.toContain("0.0MB too much");
    }
  });
});
