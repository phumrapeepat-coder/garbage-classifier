@echo off
rem Double-click launcher for Windows.
rem First run: creates .venv and installs requirements (needs internet, about 500 MB, a few minutes).
rem Every run: starts the local server and opens http://127.0.0.1:5062 once the model is loaded.
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto check

set "PY="
rem TensorFlow 2.21 supports Python 3.10-3.13 only. Try the Python launcher first, then plain python.
for %%V in (3.12 3.13 3.11 3.10) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo ERROR: Python 3.10, 3.11, 3.12 or 3.13 is needed. TensorFlow does not support other versions.
  echo Install Python 3.12 from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^) and run this again.
  pause
  exit /b 1
)

echo First run: setting up with %PY%. This downloads about 500 MB once.
%PY% -m venv .venv || (echo ERROR: could not create .venv & pause & exit /b 1)
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo ERROR: installing the requirements failed ^(see the messages above^).
  rmdir /s /q .venv
  pause
  exit /b 1
)
echo Setup done.

:check
rem Already set up: install anything new in requirements.txt (e.g. OpenCV for object detection).
".venv\Scripts\python.exe" -c "import cv2" >nul 2>&1 && goto start
echo Installing new requirements (OpenCV, about 40 MB)...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo ERROR: installing the requirements failed ^(see the messages above^).
  pause
  exit /b 1
)

:start
rem Open the browser once the server answers (model warm-up takes a few seconds).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){try{if((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5062/api/health).StatusCode -eq 200){Start-Process 'http://127.0.0.1:5062';break}}catch{};Start-Sleep 1}"

echo Starting... the page opens by itself. Keep this window open; close it to stop the app.
set "PYTHONPATH=src"
".venv\Scripts\python.exe" -m garbage_web
pause
