/** Client-side image preparation, kept in step with the Python SDK. */

import { Image2PPTError } from "./errors.js";

export const UPLOAD_TARGET_BYTES = 1024 * 1024;
export const UPLOAD_MAX_DIM = 2000;
export const UPLOAD_QUALITY_LADDER = [90, 85, 80] as const;

const PASSTHROUGH_MIMES = new Set(["image/png", "image/jpeg"]);

export interface CompressedImage {
  buffer: Buffer;
  mime: string;
}

type SharpFactory = typeof import("sharp");

let sharpModule: Promise<SharpFactory> | undefined;

/**
 * Load `sharp` on first use rather than at import time.
 *
 * `sharp` ships a native binary per platform and throws while the module is being
 * evaluated when the right one was never installed — a well-known npm failure mode
 * on uncommon platforms and in trimmed-down container images. A static import would
 * take the whole SDK down with it, and most of this client never touches an image:
 * `account`, `status`, `waitFor` and `download` have no reason to stop working
 * because image preparation cannot run. Deferring the import confines the failure to
 * the calls that actually need it, and turns an opaque native error into one that
 * names the problem.
 */
async function loadSharp(): Promise<SharpFactory> {
  return (sharpModule ??= import("sharp").then(
    (mod) => mod.default,
    (err: unknown) => {
      throw new Image2PPTError(
        `preparing images for upload needs the "sharp" native binary, which is not ` +
          `installed for this platform (${process.platform}/${process.arch}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    },
  ));
}

/**
 * Match the Python SDK's image-upload preparation rules.
 *
 * PNG/JPEG images already within both byte and dimension budgets stay byte-for-byte
 * untouched. Every other supported image is flattened on white and JPEG-encoded at
 * successively lower quality settings. A dimension-compliant source is retained if
 * that re-encode would make it larger; an oversized source always uses the resized
 * JPEG so its longest edge is at most 2000px.
 *
 * Decoding uses sharp's default strictness, which refuses a truncated or otherwise
 * damaged file instead of quietly filling the missing part with grey. That matches
 * the Python SDK, and it is the behaviour worth having: half an image uploaded is
 * half a slide the caller has already paid credits for.
 */
export async function compressImageForUpload(
  raw: Buffer,
  mime: string,
): Promise<CompressedImage> {
  const sharp = await loadSharp();
  // sharp's default is the first page/frame, matching Pillow's default for animated
  // GIF/WebP. `metadata()` decodes enough to establish dimensions without re-encoding.
  const source = sharp(raw, { animated: false });
  const metadata = await source.metadata();
  const { width, height } = metadata;
  if (width === undefined || height === undefined) {
    throw new Error("image dimensions are unavailable");
  }

  const longestEdge = Math.max(width, height);
  if (
    raw.byteLength <= UPLOAD_TARGET_BYTES &&
    longestEdge <= UPLOAD_MAX_DIM &&
    PASSTHROUGH_MIMES.has(mime)
  ) {
    // Decode once even though the bytes are kept as they are. `metadata()` reads the
    // header only, so without this a truncated file would pass straight through — the
    // Python SDK, which always decodes, refuses it. Half an image uploaded is half a
    // slide the caller has already paid a credit for.
    await sharp(raw, { animated: false }).stats();
    return { buffer: raw, mime };
  }

  let compressed: Buffer | undefined;
  for (const quality of UPLOAD_QUALITY_LADDER) {
    compressed = await sharp(raw, { animated: false })
      .resize({
        width: UPLOAD_MAX_DIM,
        height: UPLOAD_MAX_DIM,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality })
      .toBuffer();
    if (compressed.byteLength <= UPLOAD_TARGET_BYTES) break;
  }

  // `compressed` is assigned by the non-empty quality ladder above.
  if (longestEdge > UPLOAD_MAX_DIM || compressed!.byteLength < raw.byteLength) {
    return { buffer: compressed!, mime: "image/jpeg" };
  }
  return { buffer: raw, mime };
}
