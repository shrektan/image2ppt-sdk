"""Client-side image compression, matched to the server's upload pipeline.

The server runs the same compression on every upload (``compressImageForUpload``).
By pre-compressing to the same spec, the server's pass becomes a passthrough — one
less redundant compute, fewer bytes on the wire. These constants must stay in sync
with the server; changing one means changing both.
"""

from __future__ import annotations

import io

from PIL import Image

_UPLOAD_TARGET_BYTES = 1024 * 1024
_UPLOAD_MAX_DIM = 2000
_UPLOAD_QUALITY_LADDER = (90, 85, 80)
# Only PNG / JPEG pass through as-is; WebP / GIF are transcoded to JPEG even when
# small (matching the server, which transcodes anything that isn't PNG/JPEG first).
_PASSTHROUGH_MIMES = frozenset({"image/png", "image/jpeg"})
IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})


def compress_image_for_upload(raw: bytes, mime: str) -> "tuple[bytes, str]":
    """Compress an image to the server's spec; return ``(bytes, mime)``.

    Rules mirror the server's ``compressImageForUpload``:
      - PNG/JPEG with longest edge <= 2000px and <= 1MB -> returned as-is (passthrough).
      - Otherwise: fit inside 2000x2000 (shrink only), flatten transparency onto
        white, JPEG at quality 90 -> 85 -> 80 until <= 1MB or the ladder bottoms out.
      - Fallback: if compression somehow yields a larger file (already-low-quality
        sources do this) -> return the original, never "blurrier AND bigger".

    Only images go through here; PDFs are uploaded as-is and rendered server-side.
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
        # thumbnail = fit inside, no enlargement (server's fit:inside + withoutEnlargement).
        if max(width, height) > _UPLOAD_MAX_DIM:
            scaled.thumbnail((_UPLOAD_MAX_DIM, _UPLOAD_MAX_DIM), Image.LANCZOS)

        # Flatten onto white, dropping alpha (server's .flatten({background:'#ffffff'})).
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
