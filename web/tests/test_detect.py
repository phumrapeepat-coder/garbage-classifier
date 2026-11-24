"""Object detection: the hand-written pipeline (NumPy only) and the /api/detect endpoint."""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image, ImageDraw

from garbage_web.utils import detect as D

from .conftest import ClientMaker, FakeModel, encode


def surface(w: int = 640, h: int = 480, base: tuple[int, int, int] = (200, 195, 185), seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    img = np.zeros((h, w, 3)) + np.array(base, float)
    img += (30 * (x / w - 0.5))[..., None]  # uneven light
    img += rng.normal(0, 5, img.shape)  # camera noise
    return Image.fromarray(img.clip(0, 255).astype(np.uint8))


def three_objects() -> Image.Image:
    im = surface()
    d = ImageDraw.Draw(im)
    d.ellipse((60, 150, 180, 330), fill=(190, 30, 40))
    d.rectangle((270, 90, 340, 380), fill=(60, 120, 200))
    d.rectangle((430, 200, 580, 400), fill=(30, 30, 30))
    return im


def boxes(im: Image.Image) -> list[tuple[int, int, int, int]]:
    found = D.detect_objects(np.asarray(im.convert("RGB")))
    return [(b.x, b.y, b.x + b.width, b.y + b.height) for b in found.boxes]


def covers(box: tuple[int, int, int, int], truth: tuple[int, int, int, int], slack: int = 20) -> bool:
    return (
        box[0] <= truth[0] + 2 and box[1] <= truth[1] + 2 and box[2] >= truth[2] - 2 and box[3] >= truth[3] - 2
        and box[0] >= truth[0] - slack and box[1] >= truth[1] - slack
        and box[2] <= truth[2] + slack and box[3] <= truth[3] + slack
    )


def test_finds_three_objects_left_to_right() -> None:
    found = boxes(three_objects())
    assert len(found) == 3
    truths = [(60, 150, 180, 330), (270, 90, 340, 380), (430, 200, 580, 400)]
    for box, truth in zip(found, truths, strict=True):
        assert covers(box, truth), (box, truth)


def test_blank_surface_has_no_objects() -> None:
    assert boxes(surface()) == []


def test_same_colour_object_found_by_its_outline() -> None:
    im = surface(base=(235, 235, 230))
    ImageDraw.Draw(im).rectangle((200, 120, 420, 380), fill=(240, 240, 236), outline=(160, 160, 160), width=3)
    found = boxes(im)
    assert len(found) == 1 and covers(found[0], (200, 120, 420, 380))


def test_object_touching_the_border() -> None:
    im = surface()
    ImageDraw.Draw(im).rectangle((0, 100, 150, 300), fill=(40, 90, 50))
    found = boxes(im)
    assert len(found) == 1 and covers(found[0], (0, 100, 151, 301))


def test_busy_background_is_not_an_object() -> None:
    rng = np.random.default_rng(5)
    clutter = Image.fromarray(rng.integers(0, 256, size=(60, 80, 3), dtype=np.uint8)).resize((640, 480))
    assert boxes(clutter) == []


def test_specks_are_ignored() -> None:
    im = surface()
    d = ImageDraw.Draw(im)
    for x in range(50, 600, 60):
        d.rectangle((x, 50, x + 2, 52), fill=(0, 0, 0))
    assert boxes(im) == []


def test_large_photo_boxes_are_in_original_pixels() -> None:
    im = three_objects().resize((2560, 1920), Image.Resampling.NEAREST)
    found = boxes(im)
    assert len(found) == 3
    assert covers(found[1], (1080, 360, 1360, 1520), slack=60)


def test_at_most_nine_objects() -> None:
    im = surface(w=900, h=600)
    d = ImageDraw.Draw(im)
    for i in range(12):
        x, y = 30 + (i % 6) * 145, 60 + (i // 6) * 270
        d.rectangle((x, y, x + 90, y + 160), fill=(20, 60, 160))
    assert len(boxes(im)) == D.MAX_OBJECTS


def test_tiny_image_returns_nothing() -> None:
    assert D.detect_objects(np.zeros((12, 12, 3), dtype=np.uint8)).boxes == ()


def test_rejects_non_rgb() -> None:
    with pytest.raises(ValueError):
        D.detect_objects(np.zeros((40, 40), dtype=np.uint8))


# ---- the building blocks behave like their lab definitions ----------------------------------------------


def test_resize_small_keeps_shape_ratio() -> None:
    img = np.zeros((960, 1280, 3), dtype=np.uint8)
    assert D.resize_small(img).shape == (180, 240, 3)
    tiny = np.zeros((100, 50, 3), dtype=np.uint8)
    assert D.resize_small(tiny).shape == (100, 50, 3)  # already small: unchanged


def test_avg_filter_matches_window_average() -> None:
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, size=(9, 11)).astype(np.uint8)
    result = D.avg_filter(img)
    assert np.isclose(result[4, 5], img[3:6, 4:7].mean())
    assert result[0, 0] == img[0, 0]  # outermost pixels keep their value (LAB06 loop)


def test_rgb2ycbcr_grey_has_neutral_colour() -> None:
    ycc = D.rgb2ycbcr(np.full((2, 2, 3), 100, dtype=np.uint8))
    assert np.allclose(ycc[0, 0], [100, 127.5, 127.5], atol=1)


def test_background_colour_ignores_object_on_edge() -> None:
    ycc = np.zeros((40, 40, 3)) + [150, 120, 130]
    ycc[0:20, 0:6] = [20, 128, 128]  # object touching the left edge
    assert np.allclose(D.background_colour(ycc), [150, 120, 130])


def test_prewitt_finds_a_step() -> None:
    gray = np.zeros((10, 10))
    gray[:, 5:] = 100
    edges = D.prewitt_edges(gray)
    assert edges[5, 4] == 300 and edges[5, 1] == 0
    assert edges[0, 4] == 0  # the photo's own frame is not an edge


def test_iterative_threshold_splits_two_groups() -> None:
    values = np.concatenate([np.full(100, 20.0), np.full(100, 200.0)])
    assert 20 < D.iterative_threshold(values) < 200


def test_morphology() -> None:
    m = np.zeros((20, 20), dtype=np.uint8)
    m[5:15, 5:15] = 255
    m[10, 10] = 0  # pinhole
    m[2, 2] = 255  # speck
    k = np.ones([3, 3], dtype=np.uint8)
    assert D.closing(m, k)[10, 10] == 255
    assert D.opening(m, k)[2, 2] == 0
    assert (D.erosion(m, k) == 255).sum() < (m == 255).sum() < (D.dilation(m, k) == 255).sum()
    assert (D.closing(m, k, 3) == 255).sum() >= (D.closing(m, k) == 255).sum()


def test_erosion_keeps_objects_on_the_edge() -> None:
    m = np.zeros((10, 10), dtype=np.uint8)
    m[0:6, 0:6] = 255
    assert D.erosion(m, np.ones([3, 3], dtype=np.uint8))[0, 0] == 255


def test_find_objects_uses_8_connectivity() -> None:
    m = np.zeros((8, 8), dtype=np.uint8)
    m[1, 1] = m[2, 2] = 255  # diagonal neighbours: one object
    m[5:7, 5:7] = 255
    objects = D.find_objects(m)
    assert sorted(o[4] for o in objects) == [2, 4]
    assert [1, 1, 2, 2, 2] in objects


# ---- API --------------------------------------------------------------------------------------------------


def post_detect(client, data: bytes):  # type: ignore[no-untyped-def]
    return client.post("/api/detect", data={"image": (io.BytesIO(data), "p.png")}, content_type="multipart/form-data")


def test_api_detect(make_client: ClientMaker, fake_model: FakeModel) -> None:
    res = post_detect(make_client(), encode(three_objects(), "PNG"))
    assert res.status_code == 200
    body = res.get_json()
    assert body["width"] == 640 and body["height"] == 480
    assert len(body["objects"]) == 3
    assert set(body["objects"][0]) == {"x", "y", "width", "height", "area_fraction"}
    assert fake_model.batches == []  # detection never runs the classifier


def test_api_detect_uses_exif_rotation(make_client: ClientMaker) -> None:
    im = three_objects()
    exif = Image.Exif()
    exif[0x0112] = 6  # "rotate 90 CW to display"
    data = encode(im, "JPEG", exif=exif, quality=95)
    body = post_detect(make_client(), data).get_json()
    assert (body["width"], body["height"]) == (480, 640)  # the size the browser shows


def test_api_detect_bad_input(make_client: ClientMaker) -> None:
    client = make_client()
    assert post_detect(client, b"not an image").status_code == 400
    assert client.post("/api/detect", data={}, content_type="multipart/form-data").status_code == 400
