/** Client-side image preparation, kept in step with the Python SDK. */

import sharp from "sharp";

export const UPLOAD_TARGET_BYTES = 1024 * 1024;
export const UPLOAD_MAX_DIM = 2000;
export const UPLOAD_QUALITY_LADDER = [90, 85, 80] as const;

const PASSTHROUGH_MIMES = new Set(["image/png", "image/jpeg"]);

export interface CompressedImage {
  buffer: Buffer;
  mime: string;
}

/**
 * Match the server and Python SDK's image-upload preparation rules.
 *
 * PNG/JPEG images already within both byte and dimension budgets stay byte-for-byte
 * untouched. Every other supported image is flattened on white and JPEG-encoded at
 * successively lower quality settings. A dimension-compliant source is retained if
 * that re-encode would make it larger; an oversized source always uses the resized
 * JPEG so its longest edge is at most 2000px.
 */
export async function compressImageForUpload(
  raw: Buffer,
  mime: string,
): Promise<CompressedImage> {
  // sharp's default is the first page/frame, matching Pillow's default for animated
  // GIF/WebP. `metadata()` decodes enough to establish dimensions without re-encoding.
  const source = sharp(raw, { animated: false, failOn: "error" });
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
    return { buffer: raw, mime };
  }

  let compressed: Buffer | undefined;
  for (const quality of UPLOAD_QUALITY_LADDER) {
    compressed = await sharp(raw, { animated: false, failOn: "error" })
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
