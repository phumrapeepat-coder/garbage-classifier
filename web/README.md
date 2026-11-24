# Garbage classifier web app v2 — SK model (cleaned Kaggle + more web photos)

A local page to test the garbage model on your own photos: choose an image or use the camera, optionally crop,
classify, and see the answer or **Unknown** when the model is not sure.

## Run

Double-click `Launch.command` (or run it in Terminal). It starts the server and opens
<http://127.0.0.1:5062> once the model is loaded. Only your own computer can reach it (127.0.0.1, port 5062).

Manually:

```
cd web
PYTHONPATH=src .venv/bin/python -m garbage_web
```

Uploads are processed in memory and never saved. Limits: 8 MB per file, 50 megapixels per image.
Formats: JPEG, PNG, WebP, HEIC (HEIC is decoded on the server; the browser preview works in Safari only).

## Object detection (pick an object before classifying)

Every new photo is sent once to `POST /api/detect`, which returns bounding boxes only (it never runs the model).
The detector in `src/garbage_web/utils/detect.py` is built only from the EGCI486 lab code (LAB01-LAB07),
OpenCV only for cv2.resize, no pretrained model: resize to longest side 240 -> 3x3 average filter ->
YCbCr -> background colour = median of the photo border -> difference from it (sum of squared differences) +
Prewitt edges -> iterative threshold / fixed threshold -> closing and opening with the LAB06 3x3
erosion and dilation -> flood fill to split the mask into objects (the one non-lab step) -> boxes (specks and
"the whole photo" dropped, at most 9, numbered left to right). About 1 s per photo.
It assumes a plain surface: the border should mostly show that surface.

The page draws numbered boxes; the chosen box plus a 12% margin (`PAD_FRAC` in `static/detect_math.js`) is cut
from the original photo in the browser and that crop is what `/api/predict` classifies. The classification model,
its preprocessing and `/api/predict` are unchanged. Tuning constants are at the top of `utils/detect.py`.

## Test

```
PYTHONPATH=src .venv/bin/python -m pytest -q     # Python (also runs the Node suites)
node --test tests_js/*.test.js                   # JavaScript logic only
```

Not covered by automatic tests: a real webcam or iPhone Continuity Camera, touch cropping on a phone, how it looks.

**Camera frame:** the live frame takes the camera's own shape. For an iPhone camera it switches to a vertical 3:4 frame
automatically ("Vertical frame" switch, also usable for any camera); Capture keeps exactly that frame
(e.g. 1920×1080 → 810×1080). To use 9:16 instead, change `PORTRAIT_RATIO` in `static/camera_helpers.js` and the
`aspect-ratio` in `static/style.css`.

## Swap the model

Replace these files in `model/` (or set `GARBAGE_MODEL_DIR` to another folder), then restart:

- `garbage_cnn.keras`: Keras model, input 224x224 RGB floats 0..255, softmax output
- `config.json`: `classes` (in output order), `image_size`, `input_range` `[0, 255]`, `temperature`
- `confidence_threshold_table.csv` (optional): columns `threshold,answered,accuracy_when_answered`

The server refuses to start on a bad `config.json` and reports the model as unavailable if it does not match.

## What the threshold means

Each photo gets a confidence for every class (flip-averaged, then temperature-calibrated). If the best one is
below the **threshold** the page says **Unknown** instead of guessing. The default is 0.70 and the slider
(0.40 to 0.95) re-decides instantly without uploading again.

The hint under the slider comes from `confidence_threshold_table.csv`, measured on a small set of web photos:
"At 0.70: answers about 81% of photos, about 95% correct." Between table rows the numbers are interpolated, above
0.90 there is no data, and they were measured without the mirror-image averaging the app uses, so read them as
rough guides, not promises.

## How it works (short)

Image -> EXIF rotation -> RGB (transparency blended onto white, like training) -> bilinear resize to 224x224
(stretch) -> float 0..255 (no /255, the model rescales itself) -> model on the image and its mirror -> average ->
temperature scaling -> rank -> Unknown rule.
