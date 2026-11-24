"""Object detection for ONE photo of objects lying on a plain surface.

Built only from the EGCI486 lab code (LAB01-LAB07). The one extra step is the flood fill at the end,
which splits the mask into separate objects (no lab covers that).
OpenCV is used only for cv2.resize (as in LAB02). No pretrained model.

Step                                                 Lab code it reuses
 1. Resize the photo smaller with cv2.resize          LAB02 Workshop 1 (image sampling)
 2. 3x3 average filter on R, G and B                 LAB03 part 3 Ex 2 (average), LAB04 med_filtering_rgb
 3. RGB -> YCbCr                                     LAB04 part 2 rgb2ycbcr
 4. Background colour = median of the photo border   LAB01 slicing + np.median (LAB03 median filter)
 5. Difference from the background colour            LAB07 template matching (sum of squared differences)
 6. Prewitt edges                                    LAB03 part 3 Ex 3 (h_r, h_c, gradient = g_c + g_r)
 7. Iterative threshold -> 0/255 masks               LAB05 Ex 1 (fixed T) and Ex 1.2 (iterative T)
 8. Closing, then opening                           LAB06 erosion / dilation / opening / closing
 9. Connected objects -> bounding boxes              flood fill (extra); boxes like the LAB07 rectangles

Assumption: the surface is plain, so the border of the photo is mostly surface.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# ---- settings -------------------------------------------------------------------------------------------
WORK_SIDE = 240  # longest side after resizing (the loops below are slow on big images)
BORDER_PERCENT = 0.04  # thickness of the border band used to learn the surface colour
LUMA_WEIGHT = 0.5  # brightness (Y) counts half as much as colour (Cb, Cr): soft shadows matter less
MIN_COLOR_T = 24  # fixed minimum T for the colour difference (LAB05 Ex 1 style): a blank table stays blank
EDGE_T = 40  # fixed T for the Prewitt edges (LAB05 Ex 1 style), chosen by testing
CLOSE_TIMES = 3  # closing = 3 x dilation then 3 x erosion with the LAB06 3x3 kernel (= one 7x7)
OPEN_TIMES = 2  # opening = 2 x erosion then 2 x dilation (= one 5x5)
MIN_AREA_PERCENT = 0.004  # an object must fill at least 0.4% of the photo...
MIN_SIDE = 8  # ...and its box must be at least 8 x 8 pixels
FULL_FRAME_PERCENT = 0.97  # a box this close to the whole photo is the surface itself
MAX_BOX_PERCENT = 0.8  # a box covering 80%+ of the photo means the background is not plain
MAX_OBJECTS = 9  # the web page picks objects with keys 1-9

# the 8 pixels around a pixel: up, down, left, right and the 4 diagonals
EIGHT_NEIGHBOURS = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


# ---- results (what the web server sends to the page) ---------------------------------------------------


@dataclass(frozen=True)
class Box:
  """Bounding box in ORIGINAL image pixels; x, y is the top-left corner."""

  x: int
  y: int
  width: int
  height: int
  area_fraction: float  # object pixels / photo pixels

  def to_json(self) -> dict[str, float | int]:
    return {
      "x": self.x,
      "y": self.y,
      "width": self.width,
      "height": self.height,
      "area_fraction": round(self.area_fraction, 5),
    }


@dataclass(frozen=True)
class Detection:
  width: int  # size of the photo the boxes refer to
  height: int
  boxes: tuple[Box, ...]  # numbered left to right


# ---- 1. resize (LAB02) ---------------------------------------------------------------------------------


def resize_small(img):
  h, w = img.shape[0], img.shape[1]
  if max(h, w) <= WORK_SIDE:
    return img  # already small enough

  scale = WORK_SIDE / max(h, w)  # e.g. 240 / 1280 = 0.1875
  new_w = int(w * scale)  # e.g. 1280 * 0.1875 = 240
  new_h = int(h * scale)  # e.g.  960 * 0.1875 = 180

  small = cv2.resize(img, (new_w, new_h))  # cv2.resize takes (width, height), like LAB02
  return small


# ---- 2. average filter (LAB03, LAB04) -------------------------------------------------------------------


def avg_filter(img):
  # Same loop as the LAB06 erosion: copy the image, then replace each inner pixel by the
  # average of its 3x3 window. The outermost pixels keep their value (no zero padding),
  # because zero padding would make the border dark, and the border is where step 4 looks.
  img = img.astype(float)
  result = np.copy(img)  # Prevent overwriting the original image
  h, w = img.shape

  for r in range(0, h - 2):
    for c in range(0, w - 2):
      result[r + 1, c + 1] = np.average(img[r:r + 3, c:c + 3])

  return result


def avg_filter_rgb(img):
  R = img[:, :, 0]
  G = img[:, :, 1]
  B = img[:, :, 2]

  r_avg = avg_filter(R)
  g_avg = avg_filter(G)
  b_avg = avg_filter(B)

  result = np.stack((r_avg, g_avg, b_avg), axis=-1).clip(0, 255).astype(np.uint8)
  return result


# ---- 3. colour space (LAB04) ----------------------------------------------------------------------------


def rgb2ycbcr(img):
  img = img.astype(float)
  R = img[:, :, 0]
  G = img[:, :, 1]
  B = img[:, :, 2]
  r, g, b = R / 255, G / 255, B / 255

  y = (0.299 * r) + (0.587 * g) + (0.114 * b)
  cb = (0.564 * (b - y)) + 0.5
  cr = (0.713 * (r - y)) + 0.5
  Y, Cb, Cr = y * 255, cb * 255, cr * 255

  img_ycbcr = np.stack((Y, Cb, Cr), axis=-1).clip(0, 255).astype(np.uint8)
  return img_ycbcr


# ---- 4. background colour from the border (LAB01 slicing + np.median) -----------------------------------


def border_pixels(img, band_percent=BORDER_PERCENT):
  """All pixels in a band around the edge of a colour image, as an (N, 3) array."""
  h, w = img.shape[0], img.shape[1]
  t = max(2, round(min(h, w) * band_percent))  # band thickness in pixels

  top = img[0:t, :]  # slice the first t rows
  bottom = img[h - t:h, :]  # slice the last t rows
  left = img[t:h - t, 0:t]  # rows t..h-t only, so the corners are not counted twice
  right = img[t:h - t, w - t:w]

  return np.concatenate([top.reshape(-1, 3), bottom.reshape(-1, 3), left.reshape(-1, 3), right.reshape(-1, 3)])


def background_colour(ycbcr):
  border = border_pixels(ycbcr)
  Y = np.median(border[:, 0])  # median: objects touching the edge barely move it
  Cb = np.median(border[:, 1])
  Cr = np.median(border[:, 2])
  return np.array([Y, Cb, Cr])


# ---- 5. difference from the background (LAB07 sum of squared differences) -------------------------------


def colour_difference(ycbcr, bg):
  img = ycbcr.astype(float)
  Y = img[:, :, 0]
  Cb = img[:, :, 1]
  Cr = img[:, :, 2]

  # Like LAB07 template matching: sum of the squared differences, here per pixel over Y, Cb, Cr.
  # The square root brings it back to the 0-255 scale so it can be thresholded like an image.
  diff = (LUMA_WEIGHT * (Y - bg[0])) ** 2 + (Cb - bg[1]) ** 2 + (Cr - bg[2]) ** 2
  return np.sqrt(diff)


# ---- 6. Prewitt edges (LAB03) ---------------------------------------------------------------------------


def prewitt_edges(img):
  # Prewitt Mask
  h_r = np.array(
    [[1, 1, 1],
     [0, 0, 0],
     [-1, -1, -1]], dtype=int
  )
  h_c = np.array(
    [[1, 0, -1],
     [1, 0, -1],
     [1, 0, -1]], dtype=int
  )

  img = img.astype(int)
  h, w = img.shape
  g_r = np.zeros_like(img, dtype=int)
  g_c = np.zeros_like(img, dtype=int)

  # Same loop as LAB06 (no zero padding): with zero padding the photo's own frame
  # would look like a very strong edge.
  for r in range(0, h - 2):
    for c in range(0, w - 2):
      g_r[r + 1, c + 1] = np.abs(np.sum(img[r:r + 3, c:c + 3] * h_r))
      g_c[r + 1, c + 1] = np.abs(np.sum(img[r:r + 3, c:c + 3] * h_c))

  gradient = g_c + g_r
  return gradient


# ---- 7. thresholding (LAB05) ----------------------------------------------------------------------------


def iterative_threshold(img, predefine=1):
  old_T = np.average(img)
  new_T = old_T

  while True:
    if img[img > new_T].size == 0 or img[img <= new_T].size == 0:
      break  # everything is on one side: nothing to split
    a1 = np.average(img[img > new_T])
    a2 = np.average(img[img <= new_T])
    new_T = (a1 + a2) / 2
    if abs(old_T - new_T) < predefine:
      break
    old_T = new_T

  return new_T


def make_mask(img, T):
  mask = np.zeros(img.shape, dtype=np.uint8)
  mask[img > T] = 255
  return mask


# ---- 8. morphology (LAB06) ------------------------------------------------------------------------------


def erosion(img, kernel):
  kernel = kernel * 255
  result = np.copy(img)
  for r in range(0, img.shape[0] - 2):
    for c in range(0, img.shape[1] - 2):
      if not np.array_equal(img[r:r + kernel.shape[0], c:c + kernel.shape[1]], kernel):
        result[r + 1, c + 1] = 0

  kernel = kernel / 255
  return result


def dilation(img, kernel):
  kernel = kernel * 255
  result = np.copy(img)
  for r in range(0, img.shape[0] - 2):
    for c in range(0, img.shape[1] - 2):
      if img[r + 1, c + 1] == 255:
        result[r:r + kernel.shape[0], c:c + kernel.shape[1]] = 255

  kernel = kernel / 255
  return result


def opening(img, kernel, times=1):
  result = img
  for _ in range(times):
    result = erosion(result, kernel)
  for _ in range(times):
    result = dilation(result, kernel)
  return result


def closing(img, kernel, times=1):
  result = img
  for _ in range(times):
    result = dilation(result, kernel)
  for _ in range(times):
    result = erosion(result, kernel)
  return result


# ---- 9. connected objects (flood fill: the one non-lab step) --------------------------------------------


def flood_fill(mask, visited, r0, c0):
  """Visit every object pixel (255) connected to (r0, c0). Returns its area and bounding box."""
  h, w = mask.shape
  stack = [(r0, c0)]
  visited[r0, c0] = True
  area = 0
  r_min, r_max, c_min, c_max = r0, r0, c0, c0

  while stack:
    r, c = stack.pop()
    area += 1
    r_min, r_max = min(r_min, r), max(r_max, r)
    c_min, c_max = min(c_min, c), max(c_max, c)
    for dr, dc in EIGHT_NEIGHBOURS:
      nr, nc = r + dr, c + dc
      if 0 <= nr < h and 0 <= nc < w and not visited[nr, nc] and mask[nr, nc] == 255:
        visited[nr, nc] = True
        stack.append((nr, nc))

  return area, c_min, r_min, c_max, r_max


def find_objects(mask):
  """One [x0, y0, x1, y1, area] per connected white region (8-connectivity)."""
  h, w = mask.shape
  visited = np.zeros((h, w), dtype=bool)
  objects = []

  for r in range(h):
    for c in range(w):
      if mask[r, c] == 255 and not visited[r, c]:
        area, x0, y0, x1, y1 = flood_fill(mask, visited, r, c)
        objects.append([x0, y0, x1, y1, area])

  return objects


# ---- 10. keep the real objects --------------------------------------------------------------------------


def filter_objects(objects, h, w):
  boxes = []
  for x0, y0, x1, y1, area in objects:
    box_w, box_h = x1 - x0 + 1, y1 - y0 + 1
    if area < MIN_AREA_PERCENT * h * w or box_w < MIN_SIDE or box_h < MIN_SIDE:
      continue  # speck
    if box_w >= FULL_FRAME_PERCENT * w and box_h >= FULL_FRAME_PERCENT * h:
      continue  # the surface itself
    if box_w * box_h >= MAX_BOX_PERCENT * w * h:
      continue  # busy background merged into one blob
    boxes.append([x0, y0, x1, y1, area])

  boxes.sort(key=lambda b: b[4], reverse=True)  # biggest first
  return boxes[:MAX_OBJECTS]


# ---- the whole pipeline ---------------------------------------------------------------------------------


def object_mask(small):
  """Steps 2-8: small RGB image -> mask (255 = object)."""
  smooth = avg_filter_rgb(small)
  ycbcr = rgb2ycbcr(smooth)

  bg = background_colour(ycbcr)
  diff = colour_difference(ycbcr, bg)
  T = max(iterative_threshold(diff), MIN_COLOR_T)
  colour_mask = make_mask(diff, T)

  edges = prewitt_edges(ycbcr[:, :, 0])  # edges on Y (= grayscale)
  edge_mask = make_mask(edges, EDGE_T)

  mask = np.zeros(colour_mask.shape, dtype=np.uint8)
  mask[(colour_mask == 255) | (edge_mask == 255)] = 255  # colour OR edge

  kernel = np.ones([3, 3], dtype=np.uint8)
  mask = closing(mask, kernel, CLOSE_TIMES)
  mask = opening(mask, kernel, OPEN_TIMES)
  return mask


def detect_objects(rgb) -> Detection:
  """Full-size RGB uint8 photo (H, W, 3) -> boxes in full-size pixels, numbered left to right."""
  if rgb.ndim != 3 or rgb.shape[2] != 3:
    raise ValueError("expected an RGB image of shape (H, W, 3)")
  h, w = rgb.shape[0], rgb.shape[1]
  small = resize_small(rgb)
  sh, sw = small.shape[0], small.shape[1]
  if min(sh, sw) < 3 * MIN_SIDE:
    return Detection(w, h, ())  # too small to say anything useful

  mask = object_mask(small)
  boxes = filter_objects(find_objects(mask), sh, sw)
  boxes.sort(key=lambda b: (b[0] + b[2]) / 2)  # number them left to right

  # The boxes are in small-image pixels: scale them back up to the original photo.
  scale_x = w / sw  # e.g. 1280 / 240 = 5.33
  scale_y = h / sh  # e.g.  960 / 180 = 5.33

  result = []
  for x0, y0, x1, y1, area in boxes:
    ox0 = int(x0 * scale_x)
    oy0 = int(y0 * scale_y)
    ox1 = min(w, int((x1 + 1) * scale_x))
    oy1 = min(h, int((y1 + 1) * scale_y))
    result.append(Box(ox0, oy0, ox1 - ox0, oy1 - oy0, area / (sh * sw)))
  return Detection(w, h, tuple(result))
