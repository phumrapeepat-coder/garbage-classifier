"""Preprocessing must match the training recipe exactly (the model silently degrades otherwise)."""
from __future__ import annotations

import io

import numpy as np
import numpy.typing as npt
import pytest
from PIL import Image, ImageOps

from garbage_web.models import InputError, ModelConfig
from garbage_web.utils import preprocess
from garbage_web.utils.preprocess import decode_image, preprocess_bytes, to_model_input, tta_batch

from .conftest import encode


def reference_recipe(data: bytes, size: tuple[int, int] = (224, 224)) -> npt.NDArray[np.float32]:
    """Independent re-statement of the notebook recipe for OPAQUE images:
    exif_transpose -> convert("RGB") -> BILINEAR stretch -> float32 0..255 (no /255)."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    rgb = img.convert("RGB").resize(size, Image.Resampling.BILINEAR)
    return np.asarray(rgb, dtype=np.float32)[None, ...]


@pytest.mark.parametrize(
    ("fmt", "kwargs"),
    [("JPEG", {"quality": 95}), ("PNG", {}), ("WEBP", {"lossless": True})],
)
def test_matches_reference_recipe(
    config: ModelConfig, gradient_rgb: Image.Image, fmt: str, kwargs: dict[str, object]
) -> None:
    data = encode(gradient_rgb, fmt, **kwargs)
    got = preprocess_bytes(data, config)
    assert got.shape == (1, 224, 224, 3)
    assert got.dtype == np.float32
    np.testing.assert_array_equal(got, reference_recipe(data))


def test_values_are_0_to_255_not_scaled(config: ModelConfig) -> None:
    white = Image.new("RGB", (50, 50), (255, 255, 255))
    arr = preprocess_bytes(encode(white, "PNG"), config)
    assert arr.max() == 255.0  # a /255 slip would give 1.0


def test_stretch_not_letterbox(config: ModelConfig) -> None:
    # A wide solid image must fill the whole 224x224 square (no padding bars).
    img = Image.new("RGB", (300, 60), (10, 200, 30))
    arr = preprocess_bytes(encode(img, "PNG"), config)
    assert np.all(arr[0, :, :, 1] == 200.0)


def test_exif_orientation_6_is_rotated(config: ModelConfig, gradient_rgb: Image.Image) -> None:
    exif = Image.Exif()
    exif[0x0112] = 6  # "rotate 90 clockwise to view"
    data = encode(gradient_rgb, "JPEG", quality=100, exif=exif)
    decoded = Image.open(io.BytesIO(data))
    expected = decoded.convert("RGB").transpose(Image.Transpose.ROTATE_270)
    assert expected.size == (80, 120)
    want = np.asarray(expected.resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32)[None]
    np.testing.assert_array_equal(preprocess_bytes(data, config), want)
    # and it really differs from the un-rotated recipe
    plain = np.asarray(decoded.convert("RGB").resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32)[None]
    assert not np.array_equal(preprocess_bytes(data, config), plain)


def test_rgba_is_blended_onto_white(config: ModelConfig) -> None:
    img = Image.new("RGBA", (10, 10), (200, 0, 0, 128))
    arr = preprocess_bytes(encode(img, "PNG"), config)
    a = 128 / 255
    expected = np.array([200 * a + 255 * (1 - a), 255 * (1 - a), 255 * (1 - a)])
    np.testing.assert_allclose(arr[0, 100, 100], expected, atol=1.5)
    # A plain convert("RGB") would give (200, 0, 0): prove we are not doing that.
    assert arr[0, 100, 100, 1] > 100


def test_fully_transparent_pixels_become_white(config: ModelConfig) -> None:
    img = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    arr = preprocess_bytes(encode(img, "PNG"), config)
    assert np.all(arr == 255.0)


def test_palette_png_with_transparency_becomes_white(config: ModelConfig) -> None:
    img = Image.new("P", (10, 10), 0)
    img.putpalette([255, 0, 0, 0, 0, 255] + [0] * 756)
    img.info["transparency"] = 0  # palette index 0 (red) is transparent
    arr = preprocess_bytes(encode(img, "PNG", transparency=0), config)
    assert np.all(arr == 255.0)


def test_opaque_palette_png_keeps_colours(config: ModelConfig) -> None:
    img = Image.new("P", (10, 10), 1)
    img.putpalette([255, 0, 0, 0, 0, 255] + [0] * 756)
    arr = preprocess_bytes(encode(img, "PNG"), config)
    np.testing.assert_array_equal(arr[0, 5, 5], [0.0, 0.0, 255.0])


def test_grayscale_gets_three_equal_channels(config: ModelConfig) -> None:
    img = Image.new("L", (20, 20), 77)
    arr = preprocess_bytes(encode(img, "PNG"), config)
    assert arr.shape == (1, 224, 224, 3)
    assert np.all(arr == 77.0)


def test_tta_second_row_is_exact_mirror(config: ModelConfig, gradient_rgb: Image.Image) -> None:
    x = to_model_input(gradient_rgb, config)
    batch = tta_batch(x)
    assert batch.shape == (2, 224, 224, 3)
    assert batch.dtype == np.float32
    np.testing.assert_array_equal(batch[0], x[0])
    np.testing.assert_array_equal(batch[1], x[0][:, ::-1, :])  # mirrored left-right
    np.testing.assert_array_equal(batch[1][:, 0, :], x[0][:, -1, :])
    assert batch[1].flags["C_CONTIGUOUS"]


def test_heic_is_accepted(config: ModelConfig, gradient_rgb: Image.Image) -> None:
    pillow_heif = pytest.importorskip("pillow_heif")
    buf = io.BytesIO()
    try:
        pillow_heif.from_pillow(gradient_rgb).save(buf, format="HEIF", quality=90)
    except Exception as exc:  # noqa: BLE001 - this build of libheif cannot encode: nothing to test with
        pytest.skip(f"cannot encode a HEIC fixture here: {exc}")
    arr = preprocess_bytes(buf.getvalue(), config)
    assert arr.shape == (1, 224, 224, 3)


# ---- rejected inputs -------------------------------------------------------------------------


def expect_error(data: bytes, status: int, code: str) -> None:
    with pytest.raises(InputError) as info:
        decode_image(data)
    assert (info.value.status, info.value.code) == (status, code)


def test_empty_is_400() -> None:
    expect_error(b"", 400, "empty_image")


def test_garbage_is_400() -> None:
    expect_error(b"this is not an image at all" * 20, 400, "invalid_image")


def test_truncated_jpeg_is_400(gradient_rgb: Image.Image) -> None:
    data = encode(gradient_rgb, "JPEG")
    expect_error(data[: len(data) // 2], 400, "invalid_image")


@pytest.mark.parametrize("fmt", ["GIF", "BMP", "TIFF"])
def test_other_formats_are_415(gradient_rgb: Image.Image, fmt: str) -> None:
    expect_error(encode(gradient_rgb, fmt), 415, "unsupported_format")


def test_pixel_cap_is_413(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(preprocess, "MAX_PIXELS", 1000)
    expect_error(encode(Image.new("RGB", (100, 100)), "PNG"), 413, "image_too_large")


def test_huge_header_is_413_before_decoding() -> None:
    # 100 megapixels, but a 1-bit image compresses to a few KB and costs only ~12 MB to build.
    expect_error(encode(Image.new("1", (10000, 10000)), "PNG"), 413, "image_too_large")


def test_48_megapixel_photo_is_under_the_cap() -> None:
    assert 8064 * 6048 <= preprocess.MAX_PIXELS  # an iPhone 48 MP shot must pass the pixel check
