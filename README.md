# Garbage Classifier (real-life photos + object detection)

Take a photo of an item (or upload one) and the app says which of **10 garbage types** it is:
battery, biological, cardboard, clothes, glass, metal, paper, plastic, shoes, trash.
If it is not sure, it says **Unknown**. Objects in the photo are found first (classic image processing,
no pretrained detector), so you can pick one object and classify only that crop. Everything runs locally.

## Repository layout

| Folder | What's inside |
|---|---|
| `web/` | Flask web app + the trained model (`web/model/garbage_cnn.keras`, EfficientNetV2-B0, 224×224) |
| `training/` | `Garbage_CNN_RealLife_SK.ipynb` – Google Colab notebook that trained the model |
| `opencv-basics/` | Lab code: camera capture (`main.py`) and gray / mean blur / iterative threshold mask (`detect.py`) |

## Results (from the training notebook)

| Test set | Images | Accuracy | Macro F1 |
|---|---|---|---|
| Kaggle test (held out, near-duplicates grouped) | 2,450 | 93.8% | 0.929 |
| Web photos (real-life style, CC0 / CC BY) | 378 | 86.8% | 0.861 |

With the default "Unknown" threshold of 0.70 the app answers ~81% of web photos and ~95% of those answers are correct.

## Run the app

Needs Python 3.10–3.13 on Windows 64-bit, Linux, or an Apple Silicon Mac (no TensorFlow build for Intel Macs).
The first start downloads ~500 MB of packages.

- **Windows:** double-click `web/Start-Windows.bat`
- **macOS:** double-click `web/Launch.command` (if blocked: right-click → Open)
- **Linux / manual:**
  ```bash
  cd web
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  PYTHONPATH=src .venv/bin/python -m garbage_web
  ```

Then open <http://127.0.0.1:5062>.

1. **Choose image**, or **Use camera** → **Capture**.
2. Objects are detected automatically: 1 object is cropped and classified straight away; with 2+ objects click a
   numbered box; with none, crop by hand or classify the whole photo.
3. Move the **Unknown threshold** slider to change how sure the model must be.

Tip: plain surface, good light, objects not touching.

Technical details (detector, preprocessing, swapping the model, tests): see [`web/README.md`](web/README.md).

## Retrain the model

Open `training/Garbage_CNN_RealLife_SK.ipynb` in Google Colab, choose a **T4 GPU**, and **Run all**
(about 60–90 min). It downloads the Kaggle dataset
[`sumn2u/garbage-classification-v2` (v12)](https://www.kaggle.com/datasets/sumn2u/garbage-classification-v2),
adds CC0 / CC BY web photos, cleans labels with scikit-learn, trains, calibrates and downloads a results ZIP.
Copy `garbage_cnn.keras`, `config.json` and `confidence_threshold_table.csv` from it into `web/model/`.

## Tests

```bash
cd web
PYTHONPATH=src .venv/bin/python -m pytest -q
node --test tests_js/*.test.js
```
