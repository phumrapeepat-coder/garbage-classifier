"""Image validation and preprocessing with exact parity to the training notebook.

Recipe (see model/config.json "preprocess"):
EXIF transpose -> RGB (alpha blended onto WHITE, like training's to_rgb) -> bilinear resize
(stretch, no letterbox) -> float32 in 0..255.
We do NOT divide by 255: the model has a Rescaling layer built in, so doing it here would
apply it twice and silently wreck the predictions.
"""
from __future__ import annotations

import io
import logging
import warnings

import numpy as np
import numpy.typing as npt
import pillow_heif  # type: ignore[import-untyped]
from PIL import Image, ImageOps, UnidentifiedImageError

from garbage_web.models import InputError, ModelConfig
from garbage_web.settings import MAX_PIXELS

log = logging.getLogger(__name__)

FloatBatch = npt.NDArray[np.float32]

# MPO = multi-picture JPEG written by many phone cameras; Pillow reports it as format "MPO".
ALLOWED_FORMATS = frozenset({"JPEG", "MPO", "PNG", "WEBP", "HEIF"})
_OPENERS = ["JPEG", "PNG", "WEBP", "HEIF"]  # the only decoders Image.open may try

# Pillow warns above this many pixels and raises DecompressionBombError above 2x this.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
Image.init()  # register every built-in plugin so formats=[...] can resolve the names
pillow_heif.register_heif_opener()  # adds "HEIF" (iPhone photos) to Pillow

# Well-known signatures we deliberately do not decode: reported as 415 (not as "corrupt").
_UNSUPPORTED_MAGIC = (b"GIF8", b"BM", b"II*\x00", b"MM\x00*")

_FORMAT_MESSAGE = "Only JPEG, PNG, WebP and HEIC images are supported."


def _too_large() -> InputError:
    return InputError(413, "image_too_large", "That image has too many pixels. Please use a smaller photo.")


def _invalid() -> InputError:
    return InputError(400, "invalid_image", "That file could not be read as an image. Try a JPEG, PNG or WebP photo.")


def decode_image(data: bytes) -> Image.Image:
    """Validate and fully decode bytes into a PIL image (format sniffed from the bytes only)."""
    if not data:
        raise InputError(400, "empty_image", "The uploaded file is empty.")
    try:
        # Turn Pillow's "image is large" warning into a hard rejection.
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data), formats=_OPENERS)
        if img.format not in ALLOWED_FORMATS:
            raise InputError(415, "unsupported_format", _FORMAT_MESSAGE)
        width, height = img.size
        # Check the header-declared size BEFORE decoding so a tiny file cannot expand into gigabytes.
        if width * height > MAX_PIXELS:
            raise _too_large()
        img.load()  # force the full decode now so truncated/corrupt data fails here, not later
        return img
    except InputError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise _too_large() from exc
    except UnidentifiedImageError as exc:
        # formats=[...] hides other decoders, so tell "real image, wrong type" from "garbage" by signature.
        if data.startswith(_UNSUPPORTED_MAGIC):
            raise InputError(415, "unsupported_format", _FORMAT_MESSAGE) from exc
        log.info("rejected undecodable upload: %s", exc.__class__.__name__)
        raise _invalid() from exc
    except (OSError, SyntaxError, ValueError) as exc:
        log.info("rejected undecodable upload: %s", exc.__class__.__name__)
        raise _invalid() from exc


def _has_alpha(img: Image.Image) -> bool:
    return (
        img.mode in ("P", "PA", "La", "RGBa")
        or "A" in img.getbands()
        or "transparency" in img.info
    )


def to_rgb_like_training(img: Image.Image) -> Image.Image:
    """EXIF rotation, then RGB. Transparent pixels are blended onto white, exactly as training did."""
    fixed = ImageOps.exif_transpose(img)
    if _has_alpha(fixed):
        rgba = fixed.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(white, rgba).convert("RGB")
    return fixed.convert("RGB")


def to_model_input(img: Image.Image, cfg: ModelConfig) -> FloatBatch:
    """Image -> float32 array of shape (1, H, W, 3), values 0..255."""
    rgb = to_rgb_like_training(img)
    resized = rgb.resize(cfg.resize_wh, Image.Resampling.BILINEAR)  # stretch, no letterbox
    arr: FloatBatch = np.asarray(resized, dtype=np.float32)[None, ...]
    return arr


def tta_batch(x: FloatBatch) -> FloatBatch:
    """Stack the image with its horizontal mirror -> (2, H, W, 3).

    Flip AFTER the resize, on the width axis, like training's x[:, :, ::-1, :].
    """
    flipped = np.ascontiguousarray(x[:, :, ::-1, :])
    batch: FloatBatch = np.concatenate([x, flipped], axis=0)
    return batch


def preprocess_bytes(data: bytes, cfg: ModelConfig) -> FloatBatch:
    img = decode_image(data)
    try:
        return to_model_input(img, cfg)
    except (OSError, ValueError, SyntaxError, TypeError) as exc:
        # e.g. broken EXIF blocks make exif_transpose raise; show the friendly 400 instead of a 500.
        log.info("rejected upload during preprocessing: %s", exc.__class__.__name__)
        raise _invalid() from exc
