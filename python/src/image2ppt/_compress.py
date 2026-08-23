"""Client-side image compression, sized to what the upload API accepts.

Compressing before the upload means fewer bytes on the wire and a faster submission.
The Node SDK prepares images to this same spec, so both clients send the same payload
for the same file: changing a constant here means changing it there too.
"""

from __future__ import annotations

import io

from PIL import Image

_UPLOAD_TARGET_BYTES = 1024 * 1024
_UPLOAD_MAX_DIM = 2000
_UPLOAD_QUALITY_LADDER = (90, 85, 80)
# Only PNG / JPEG pass through as-is; WebP / GIF are transcoded to JPEG even when
# small, since those are the two formats this spec passes through unchanged.
_PASSTHROUGH_MIMES = frozenset({"image/png", "image/jpeg"})
IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})


def compress_image_for_upload(raw: bytes, mime: str) -> "tuple[bytes, str]":
    """Compress an image to the upload spec; return ``(bytes, mime)``.

    Rules, shared with the Node SDK:
      - PNG/JPEG with longest edge <= 2000px and <= 1MB -> returned as-is (passthrough).
      - Otherwise: fit inside 2000x2000 (shrink only), flatten transparency onto
        white, JPEG at quality 90 -> 85 -> 80 until <= 1MB or the ladder bottoms out.
      - Fallback: if compression somehow yields a larger file (already-low-quality
        sources do this) -> return the original, never "blurrier AND bigger".

    Only images go through here; PDFs are uploaded exactly as they are on disk.
    """
    with Image.open(io.BytesIO(raw)) as img:
        img.load()  # animated GIF / WebP: first frame only (Pillow default)
        width, height = img.size
        within_budget = (
            len(raw) <= _UPLOAD_TARGET_BYTES and max(width, height) <= _UPLOAD_MAX_DIM
        )
        if within_budget and mime in _PASSTHROUGH_MIMES:
            return raw, mime

        scaled = img.copy()
        # thumbnail = fit inside the box, never enlarge.
        if max(width, height) > _UPLOAD_MAX_DIM:
            scaled.thumbnail((_UPLOAD_MAX_DIM, _UPLOAD_MAX_DIM), Image.LANCZOS)

        # Flatten onto white, dropping alpha: the upload format has no alpha channel.
        has_alpha = scaled.mode in ("RGBA", "LA") or (
            scaled.mode == "P" and "transparency" in scaled.info
        )
        if has_alpha:
            rgba = scaled.convert("RGBA")
            flattened = Image.new("RGB", rgba.size, (255, 255, 255))
            flattened.paste(rgba, mask=rgba.split()[-1])
            scaled = flattened
        else:
            scaled = scaled.convert("RGB")

        compressed = None
        for quality in _UPLOAD_QUALITY_LADDER:
            buffer = io.BytesIO()
            scaled.save(buffer, format="JPEG", quality=quality)
            compressed = buffer.getvalue()
            if len(compressed) <= _UPLOAD_TARGET_BYTES:
                break

    oversized = max(width, height) > _UPLOAD_MAX_DIM
    if compressed is not None and (oversized or len(compressed) < len(raw)):
        # Keep the re-encode when it's smaller, OR when the source is over the
        # dimension budget — an oversized image MUST be shrunk to honor the
        # "<= 2000px" guarantee, even if this particular re-encode is a few bytes
        # larger. The "never blurrier AND bigger" fallback only applies to
        # already-in-bounds images (a byte-size-only miss).
        return compressed, "image/jpeg"
    return raw, mime
