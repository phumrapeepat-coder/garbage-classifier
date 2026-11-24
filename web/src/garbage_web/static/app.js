"use strict";

// DOM glue only: every decision with logic in it lives in the pure modules (camera_helpers.js, crop_math.js,
// decision.js, file_rules.js) so it can be unit-tested in Node.
//
// States:  idle -> preview (camera live) -> captured -> cropping -> captured -> classifying -> result
//           captured -> detecting -> choosing -> (object picked: crop) -> classifying -> result
//   * New photo     : -> captured, then detection starts by itself (POST /api/detect, boxes only, no model)
//                     0 objects: stay captured; 1+ objects: choosing (numbered boxes, you click one)
//   * Pick object   : choosing -> crop = object box + margin (cut from the ORIGINAL) -> classifying -> result
//   * Choose image  : idle -> captured
//   * Use camera    : idle -> preview, Capture: preview -> captured (the camera is stopped right after)
//   * Crop          : captured/result -> cropping -> captured (crops are always cut from the ORIGINAL image)
//   * Classify      : captured/result -> classifying -> result (or back to captured with an inline error)
//   * Retake        : camera photo -> preview again; uploaded photo -> idle
// Nothing is stored in the browser (no web storage, no cookies) and nothing is sent anywhere except
// POST /api/detect (find objects) and POST /api/predict (classify), both to this local server.
const CH = window.CameraHelpers;
const CM = window.CropMath;
const DC = window.Decision;
const FR = window.FileRules;
const DM = window.DetectMath;

const CROP_JPEG_QUALITY = 0.95;
const DRAW_THRESHOLD_PX = 4; // a plain click on the photo must not replace the selection

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file-input"),
  chooseLabel: $("choose-label"),
  cameraBtn: $("camera-btn"),
  cameraSource: $("camera-source"),
  refreshBtn: $("refresh-cameras-btn"),
  cameraHint: $("camera-hint"),
  cameraInfo: $("camera-info"),
  stage: $("stage"),
  emptyMsg: $("empty-msg"),
  video: $("video"),
  preview: $("preview"),
  canvas: $("canvas"),
  cropOverlay: $("crop-overlay"),
  cropFrame: $("crop-frame"),
  cropBox: $("crop-box"),
  cropHelp: $("crop-help"),
  cropError: $("crop-error"),
  imageNote: $("image-note"),
  captureBtn: $("capture-btn"),
  retakeBtn: $("retake-btn"),
  cropBtn: $("crop-btn"),
  useOriginalBtn: $("use-original-btn"),
  applyBtn: $("apply-crop-btn"),
  cancelBtn: $("cancel-crop-btn"),
  classifyBtn: $("classify-btn"),
  detectBtn: $("detect-btn"),
  wholeBtn: $("whole-btn"),
  detOverlay: $("det-overlay"),
  detFrame: $("det-frame"),
  objectPicker: $("object-picker"),
  objectList: $("object-list"),
  status: $("status"),
  resultCard: $("result-card"),
  resultKnown: $("result-known"),
  resultLabel: $("result-label"),
  resultConf: $("result-conf"),
  resultUnknown: $("result-unknown"),
  bars: $("bars"),
  tips: $("retake-tips"),
  tipsList: $("tips-list"),
  slider: $("threshold-slider"),
  thresholdValue: $("threshold-value"),
  thresholdHint: $("threshold-hint"),
  verticalRow: $("vertical-row"),
  verticalToggle: $("vertical-toggle"),
};

let state = "idle";
let stream = null; // active MediaStream, if any
let source = null; // "camera" | "upload" | null: where the current photo came from
let originalBlob = null; // the untouched upload/capture; crops are always cut from this
let originalUrl = null;
let croppedBlob = null; // applied crop (JPEG) or null while the original is used
let croppedUrl = null;
let cropInfo = null; // {width, height, fromWidth, fromHeight} for the note under the photo
let canPreview = true; // false when the browser cannot decode the file (e.g. HEIC outside Safari)
let cameraStarting = false;
let processing = false; // true while a crop is being cut
let imageToken = 0; // bumped on every new/cleared photo so a slow decode cannot overwrite a newer one
let requestToken = 0; // bumped by start/stop so a late camera permission answer is dropped
let cropToken = 0; // bumped by every crop open/apply/cancel so late async crop work is dropped
let lastProbs = null; // calibrated probabilities of the last classification (the slider re-decides on these)

// Object detection (memory only).
let objects = []; // detected objects in natural pixels of the ORIGINAL, numbered left to right
let detected = false; // detection has run for the current photo
let selectedObject = null; // index of the object the current crop was cut around, or null
let detectToken = 0; // bumped on every new photo / detection so a late answer is dropped

// Camera source (memory only: raw deviceIds are never stored or sent anywhere).
let selectedDeviceId = ""; // "" = Default camera
const knownLabels = new Map();
let deviceToken = 0;
let enumerating = false;
let cameraControlsLocked = false;
let verticalFrame = false; // live preview + capture use a 3:4 centre slice (auto-on for iPhone)

// Crop editor.
let natW = 0; // natural size of the ORIGINAL as the browser decoded it (EXIF already applied)
let natH = 0;
let cropRect = null; // selection in natural pixels
let drag = null; // active pointer gesture

// Filled from /api/config; these defaults keep the page usable if that call fails.
let appConfig = {
  default_threshold: DC.DEFAULT_THRESHOLD,
  slider: { min: 0.4, max: 0.95, step: 0.05 },
  threshold_table: [],
};

// ---- rendering ------------------------------------------------------------------------------

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function defaultMessage() {
  if (cameraStarting) return "Starting the camera...";
  switch (state) {
    case "preview": return "Camera is on. Press Capture when ready.";
    case "captured": return "Photo ready. Crop it if you like, then press Classify.";
    case "cropping": return "Select the area to keep, then press Apply.";
    case "classifying": return "Classifying...";
    case "detecting": return "Looking for objects...";
    case "choosing": return DM.foundMessage(objects.length);
    default: return "";
  }
}

/** One function decides what is visible/enabled for the current state, so the UI cannot drift out of sync. */
function render(message, kind) {
  const live = state === "preview";
  const cropping = state === "cropping";
  const classifying = state === "classifying";
  const choosing = state === "choosing";
  const detecting = state === "detecting";
  const hasImage = Boolean(originalBlob) && !live;
  const showImg = hasImage && canPreview;
  const idleOrBlocked = !live && !showImg;
  const busy = classifying || processing || detecting;

  els.video.hidden = !live;
  els.preview.hidden = !showImg;
  els.emptyMsg.hidden = !idleOrBlocked;
  els.emptyMsg.textContent =
    hasImage && !canPreview
      ? "Preview is not available for this file in this browser (HEIC photos preview in Safari). You can still press Classify."
      : "No photo yet. Choose an image or use the camera.";
  els.cropOverlay.hidden = !cropping;
  els.cropOverlay.classList.toggle("busy", processing);
  els.cropHelp.hidden = !cropping;
  els.detOverlay.hidden = !choosing || !showImg;
  els.detOverlay.classList.toggle("busy", processing);
  els.objectPicker.hidden = !choosing;
  for (const b of els.objectList.querySelectorAll("button")) b.disabled = busy;
  for (const b of els.detFrame.querySelectorAll("button")) b.disabled = busy;

  els.captureBtn.hidden = !live;
  els.verticalRow.hidden = !live;
  els.verticalToggle.checked = verticalFrame;
  els.stage.classList.toggle("portrait", live && verticalFrame);
  els.retakeBtn.hidden = !hasImage || cropping;
  // Detect: retry when detection has not worked yet; after it found 2+ objects it becomes "Choose another object".
  els.detectBtn.hidden = !showImg || cropping || choosing || (detected && objects.length === 0);
  els.detectBtn.textContent = !detected ? "Detect objects" : objects.length > 1 ? "Choose another object" : "Show detected object";
  els.wholeBtn.hidden = !choosing;
  els.retakeBtn.textContent = source === "camera" ? "Retake" : "Remove photo";
  els.cropBtn.hidden = !showImg || cropping || choosing;
  els.useOriginalBtn.hidden = !hasImage || !croppedBlob || cropping || choosing;
  els.applyBtn.hidden = !cropping;
  els.cancelBtn.hidden = !cropping;
  els.classifyBtn.hidden = !hasImage || cropping || choosing;
  const buttons = [els.retakeBtn, els.cropBtn, els.useOriginalBtn, els.applyBtn, els.cancelBtn, els.classifyBtn,
    els.detectBtn, els.wholeBtn];
  for (const b of buttons) {
    b.disabled = busy;
  }

  els.cameraBtn.disabled = busy || cameraStarting || cropping || live;
  els.file.disabled = busy || cropping || cameraStarting;
  els.chooseLabel.setAttribute("aria-disabled", String(els.file.disabled));
  els.chooseLabel.classList.toggle("is-disabled", els.file.disabled);
  cameraControlsLocked = busy || cameraStarting || cropping || live;
  els.cameraSource.disabled = cameraControlsLocked;
  els.refreshBtn.disabled = cameraControlsLocked || enumerating;

  els.resultCard.hidden = state !== "result";

  // Note under the photo: tells the user which pixels Classify will really send.
  let note = "";
  if (hasImage && croppedBlob && cropInfo && cropInfo.object) {
    note = "Using object " + cropInfo.object + " of " + cropInfo.of + ": a crop of " + cropInfo.width + " x " +
      cropInfo.height + " px around it, cut from the original " + cropInfo.fromWidth + " x " + cropInfo.fromHeight +
      " px photo.";
  } else if (hasImage && croppedBlob && cropInfo) {
    note = "Using a crop of " + cropInfo.width + " x " + cropInfo.height + " px, cut from the original " +
      cropInfo.fromWidth + " x " + cropInfo.fromHeight + " px photo.";
  } else if (hasImage && !canPreview) {
    note = "Crop is not available without a preview. The original file will be sent as it is.";
  }
  els.imageNote.hidden = note === "";
  els.imageNote.textContent = note;

  setStatus(message !== undefined ? message : defaultMessage(), kind || (busy ? "busy" : ""));
}

function showError(text) {
  render(text, "error"); // inline in the card; the state is not changed
}

// ---- photo handling -------------------------------------------------------------------------

function stopCamera() {
  requestToken += 1;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  els.video.srcObject = null;
  els.cameraInfo.textContent = "";
}

function clearCrop() {
  cropToken += 1;
  if (croppedUrl) URL.revokeObjectURL(croppedUrl);
  croppedUrl = null;
  croppedBlob = null;
  cropInfo = null;
  cropRect = null;
  drag = null;
  processing = false;
  selectedObject = null;
  els.cropError.textContent = "";
}

function clearImage() {
  imageToken += 1;
  clearCrop();
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = null;
  originalBlob = null;
  source = null;
  canPreview = true;
  lastProbs = null;
  detectToken += 1;
  objects = [];
  detected = false;
  els.detFrame.replaceChildren();
  els.objectList.replaceChildren();
  els.preview.removeAttribute("src");
}

/** Show the ORIGINAL while cropping, otherwise what Classify will send. */
function showImage() {
  const showOriginal = state === "cropping" || state === "choosing" || state === "detecting";
  const url = showOriginal ? originalUrl : croppedUrl || originalUrl;
  if (url) {
    if (els.preview.getAttribute("src") !== url) els.preview.src = url;
  } else {
    els.preview.removeAttribute("src");
  }
  els.preview.alt = croppedBlob && state !== "cropping" ? "Cropped photo preview" : "Selected photo preview";
}

async function canDecode(url) {
  els.preview.src = url;
  try {
    await els.preview.decode();
    return true;
  } catch (_) {
    return false;
  }
}

/** Make a blob the current photo. The server is the authority on the format; the preview is a convenience. */
async function loadImage(blob, kind) {
  clearImage();
  originalBlob = blob;
  originalUrl = URL.createObjectURL(blob);
  source = kind;
  const token = ++imageToken;
  state = "captured";
  render("Loading the photo...", "busy");
  const ok = await canDecode(originalUrl);
  if (token !== imageToken) return; // another photo replaced this one while it decoded
  canPreview = ok;
  render();
  if (ok) runDetection(); // find the objects right away (needs the preview to show the boxes)
}

function handleFile(file) {
  if (!file) return;
  const check = FR.checkFile(file);
  els.file.value = ""; // so picking the same file again still fires "change"
  if (!check.ok) {
    showError(check.reason);
    return;
  }
  stopCamera();
  cameraStarting = false;
  loadImage(file, "upload");
}

function retake() {
  const wasCamera = source === "camera";
  clearImage();
  state = "idle";
  render();
  if (wasCamera) startCamera();
}

// ---- camera ---------------------------------------------------------------------------------

function currentSourceLabel() {
  // Prefer the name picked in the dropdown; some browsers give the track an opaque id instead of a name.
  const picked = knownLabels.get(selectedDeviceId);
  if (picked) return picked;
  const track = stream && stream.getVideoTracks()[0];
  if (track && track.label) return track.label;
  return "";
}

function updateCameraInfo() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  const settings = track ? track.getSettings() : {};
  const width = els.video.videoWidth || settings.width || 0;
  const height = els.video.videoHeight || settings.height || 0;
  let text = CH.formatResolution({ width, height, sourceLabel: currentSourceLabel() });
  const keep = CH.frameRect(width, height, verticalFrame);
  if (keep && (keep.width !== width || keep.height !== height)) {
    text += " Vertical frame: Capture keeps " + keep.width + " x " + keep.height + " px.";
  }
  els.cameraInfo.textContent = text;
}

/** Names go in through textContent only, so a hostile device label cannot inject markup. */
function renderCameraOptions(result) {
  els.cameraSource.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default camera";
  els.cameraSource.append(def);
  for (const o of result.options) {
    const opt = document.createElement("option");
    opt.value = o.deviceId;
    opt.textContent = o.label;
    els.cameraSource.append(opt);
    if (!o.unavailable) knownLabels.set(o.deviceId, o.label);
  }
  els.cameraSource.value = result.selectedId; // an unavailable choice stays selected, not silently swapped
  els.cameraHint.textContent = result.hint || "";
}

/** Lists cameras WITHOUT opening one (no permission prompt; names stay hidden until the camera was allowed once). */
async function refreshCameras() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    els.cameraHint.textContent = "This browser cannot list cameras. The Default camera still works when it is allowed.";
    return;
  }
  const token = ++deviceToken;
  enumerating = true;
  els.refreshBtn.disabled = true;
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (_) {
    if (token !== deviceToken) return;
    enumerating = false;
    els.refreshBtn.disabled = cameraControlsLocked;
    els.cameraHint.textContent = "Could not list the cameras. Press Refresh cameras to try again.";
    return;
  }
  if (token !== deviceToken) return; // a newer refresh owns the UI now
  enumerating = false;
  els.refreshBtn.disabled = cameraControlsLocked;
  renderCameraOptions(
    CH.reconcileDevices({ devices, selectedId: selectedDeviceId, selectedLabel: knownLabels.get(selectedDeviceId) || "" }),
  );
}

function onCameraSourceChange() {
  if (cameraControlsLocked) {
    els.cameraSource.value = selectedDeviceId; // locked: ignore racing changes
    return;
  }
  selectedDeviceId = els.cameraSource.value;
}

/** A live track ended by itself (cable pulled, iPhone locked away): stop cleanly, do not reconnect. */
function onTrackEnded(endedStream) {
  if (stream !== endedStream) return;
  stopCamera();
  state = "idle";
  render("The camera was disconnected or stopped. Reconnect it, press Refresh cameras, then press Use camera.", "error");
  refreshCameras();
}

async function startCamera() {
  const unsupported = CH.supportMessage({ isSecureContext: window.isSecureContext, mediaDevices: navigator.mediaDevices });
  if (unsupported) {
    showError(unsupported);
    return;
  }
  if (cameraStarting) return;
  stopCamera();
  const token = requestToken; // stopCamera() just bumped it; a later stop/reset bumps it again
  const deviceId = selectedDeviceId; // snapshot: later dropdown changes cannot affect this attempt
  cameraStarting = true;
  render();
  let newStream = null;
  let relaxed = false;
  while (!newStream) {
    try {
      newStream = await navigator.mediaDevices.getUserMedia(
        relaxed ? CH.buildFallbackConstraints(deviceId) : CH.buildConstraints(deviceId),
      );
    } catch (err) {
      if (token !== requestToken) return;
      if (CH.shouldRelaxResolution(err, deviceId, relaxed)) {
        relaxed = true; // same exact deviceId: only the 1920x1080 wish is dropped, never the device
        continue;
      }
      cameraStarting = false;
      render(CH.cameraErrorMessage(err, deviceId), "error");
      if (deviceId) refreshCameras();
      return;
    }
  }
  if (token !== requestToken) {
    // A file pick / reset happened while the permission prompt was open: do not leave a live camera behind.
    newStream.getTracks().forEach((t) => t.stop());
    return;
  }
  cameraStarting = false;
  stream = newStream;
  const track = newStream.getVideoTracks()[0];
  // Mirror only a front camera's live preview; the captured pixels are never mirrored.
  els.video.classList.toggle("mirrored", Boolean(track) && track.getSettings().facingMode === "user");
  els.video.srcObject = newStream;
  if (track) track.addEventListener("ended", () => onTrackEnded(newStream));
  clearImage();
  // iPhone -> vertical (the switch can override it). Check the live track name AND the name picked in the
  // dropdown: some browsers give the track an opaque id instead of the device name.
  verticalFrame = CH.isIPhoneLabel(currentSourceLabel()) || CH.isIPhoneLabel(knownLabels.get(selectedDeviceId));
  state = "preview";
  render();
  updateCameraInfo(); // refined again on loadedmetadata, when videoWidth/videoHeight are real
  refreshCameras(); // permission is granted now, so the device names become visible
}

function captureFrame() {
  return new Promise((resolve, reject) => {
    const r = CH.frameRect(els.video.videoWidth, els.video.videoHeight, verticalFrame);
    if (!r) {
      reject(new Error("The camera has not produced a frame yet."));
      return;
    }
    // Native pixels, no scaling: the whole frame, or the vertical centre slice that the preview shows.
    // No transform either, so the CSS mirror of the live preview never touches the captured pixels.
    els.canvas.width = r.width;
    els.canvas.height = r.height;
    els.canvas.getContext("2d").drawImage(els.video, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    els.canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not capture the frame."))),
      "image/jpeg",
      CH.CAPTURE_JPEG_QUALITY,
    );
  });
}

async function onCapture() {
  const token = requestToken;
  const label = currentSourceLabel() || "Default camera";
  try {
    const blob = await captureFrame();
    if (token !== requestToken) return;
    const w = els.canvas.width;
    const h = els.canvas.height;
    stopCamera(); // the camera only runs until the still frame is taken
    await loadImage(blob, "camera");
    els.cameraInfo.textContent = "Captured photo: " + w + " x " + h + " px from " + label + ".";
  } catch (err) {
    stopCamera(); // never leave a live track behind after a failed capture
    state = "idle";
    render(err.message, "error");
  } finally {
    els.canvas.width = 0; // release the pixel buffer
    els.canvas.height = 0;
  }
}

// ---- crop -----------------------------------------------------------------------------------

/** Rect of the drawn image inside the <img> element (object-fit: contain), plus the element's screen box. */
function measure() {
  const box = els.preview.getBoundingClientRect();
  const content = CM.containRect(box.width, box.height, natW, natH);
  return content ? { box, content } : null;
}

function layoutOverlay() {
  if (state !== "cropping") return;
  const m = measure();
  if (!m || !cropRect) return;
  const stage = els.stage.getBoundingClientRect();
  const { box, content } = m;
  // The frame sits exactly on the drawn image (not on the letterbox bars).
  const frame = els.cropFrame.style;
  frame.left = box.left - stage.left + content.x + "px";
  frame.top = box.top - stage.top + content.y + "px";
  frame.width = content.width + "px";
  frame.height = content.height + "px";
  const d = CM.naturalToDisplay(cropRect, { x: 0, y: 0, scale: content.scale });
  const s = els.cropBox.style;
  s.left = d.x + "px";
  s.top = d.y + "px";
  s.width = d.width + "px";
  s.height = d.height + "px";
  els.cropBox.setAttribute(
    "aria-valuetext",
    "Left " + Math.round(cropRect.x) + ", top " + Math.round(cropRect.y) +
      ", width " + Math.round(cropRect.width) + ", height " + Math.round(cropRect.height) + " pixels",
  );
}

function setCropRect(rect) {
  cropRect = rect;
  els.cropError.textContent = "";
  layoutOverlay();
}

async function openCrop() {
  if (!originalBlob || !canPreview || !["captured", "result"].includes(state) || processing) return;
  const token = ++cropToken;
  els.preview.src = originalUrl; // measure the ORIGINAL, not a previous crop
  try {
    await els.preview.decode();
  } catch (_) {
    if (token !== cropToken) return;
    showImage();
    showError("Could not read this image for cropping. You can still classify it as it is.");
    return;
  }
  if (token !== cropToken) return;
  natW = els.preview.naturalWidth;
  natH = els.preview.naturalHeight;
  if (!natW || !natH) {
    showImage();
    showError("Could not read this image for cropping. You can still classify it as it is.");
    return;
  }
  // Start from the picked object's crop, so a small adjustment is all that is needed.
  const fromObject = selectedObject !== null && objects[selectedObject]
    ? DM.paddedRect(objects[selectedObject], natW, natH) : null;
  cropRect = (fromObject && CM.clampRect(fromObject, natW, natH)) || CM.fullRect(natW, natH);
  state = "cropping";
  showImage();
  render();
  layoutOverlay();
  els.cropBox.focus();
}

/** Leave the editor; return to the result if there still is one for this exact image. */
function closeCrop() {
  cropToken += 1;
  drag = null;
  processing = false;
  els.cropError.textContent = "";
  state = lastProbs ? "result" : "captured";
  showImage();
}

function cancelCrop() {
  if (state !== "cropping" || processing) return;
  closeCrop();
  render(croppedBlob ? "Crop canceled. Still using the cropped copy." : "Crop canceled. Still using the original.");
  els.cropBtn.focus();
}

function useOriginal() {
  if (processing || !originalBlob) return;
  clearCrop();
  lastProbs = null; // an earlier result belonged to the cropped copy
  state = "captured";
  showImage();
  render("Using the original photo. Press Classify.");
  els.cropBtn.focus();
}

/** Copy the selected pixels of the ORIGINAL (as the browser shows it, EXIF applied) into a JPEG blob. */
function cutBlob(rect) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Could not prepare the crop."));
      return;
    }
    // JPEG has no alpha: paint white first so transparent areas become white (the server blends onto white too).
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.drawImage(els.preview, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    canvas.toBlob(
      (blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error("Could not create the cropped image."));
      },
      "image/jpeg",
      CROP_JPEG_QUALITY,
    );
  });
}

async function applyCrop() {
  if (state !== "cropping" || processing) return;
  const rect = CM.toIntRect(cropRect, natW, natH);
  const check = CM.validateRect(rect, natW, natH);
  if (!check.ok) {
    els.cropError.textContent = check.reason;
    return;
  }
  if (CM.isFullImage(rect, natW, natH)) {
    useOriginal(); // selecting everything equals the original: keep its bytes, no re-encode
    return;
  }
  const token = ++cropToken;
  processing = true;
  render("Applying the crop...", "busy");
  let blob;
  try {
    blob = await cutBlob(rect);
  } catch (err) {
    if (token !== cropToken) return;
    processing = false;
    render();
    els.cropError.textContent = err.message;
    return;
  }
  if (token !== cropToken) return;
  processing = false;
  if (blob.size > FR.MAX_BYTES) {
    render();
    els.cropError.textContent = "The cropped image is over 8 MB. Choose a smaller area.";
    return;
  }
  if (croppedUrl) URL.revokeObjectURL(croppedUrl);
  croppedBlob = blob;
  croppedUrl = URL.createObjectURL(blob);
  cropInfo = { width: rect.width, height: rect.height, fromWidth: natW, fromHeight: natH };
  selectedObject = null; // a hand-made crop, not exactly a detected object any more
  lastProbs = null;
  state = "captured";
  showImage();
  render("Crop applied. Press Classify.");
  els.cropBtn.focus();
}

function pointerNatural(event) {
  const m = measure();
  if (!m) return null;
  return CM.displayToNatural({ x: event.clientX - m.box.left, y: event.clientY - m.box.top }, m.content, natW, natH);
}

function oppositeCorner(handle, r) {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  return { x: handle.includes("w") ? right : r.x, y: handle.includes("n") ? bottom : r.y };
}

function onPointerDown(event) {
  if (state !== "cropping" || processing) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const at = pointerNatural(event);
  const m = measure();
  if (!at || !m) return;
  const handle = event.target instanceof HTMLElement ? event.target.dataset.handle : undefined;
  const start = { clientX: event.clientX, clientY: event.clientY };
  if (handle) {
    drag = { mode: "resize", anchor: oppositeCorner(handle, cropRect) };
  } else if (event.target === els.cropBox && !CM.isFullImage(cropRect, natW, natH)) {
    // A full-photo box cannot move anywhere, so dragging inside it draws a new box instead.
    drag = { mode: "move", start, orig: { ...cropRect }, scale: m.content.scale };
  } else {
    drag = { mode: "draw", anchor: at, start, moved: false };
  }
  els.cropOverlay.setPointerCapture(event.pointerId);
  event.preventDefault(); // no text selection / image drag / touch scroll during the gesture
}

function onPointerMove(event) {
  if (!drag || state !== "cropping") return;
  if (drag.mode === "move") {
    const dx = (event.clientX - drag.start.clientX) / drag.scale;
    const dy = (event.clientY - drag.start.clientY) / drag.scale;
    setCropRect(CM.moveRect(drag.orig, dx, dy, natW, natH));
    return;
  }
  const at = pointerNatural(event);
  if (!at) return;
  if (drag.mode === "draw" && !drag.moved) {
    const travelled = Math.hypot(event.clientX - drag.start.clientX, event.clientY - drag.start.clientY);
    if (travelled < DRAW_THRESHOLD_PX) return; // still just a click
    drag.moved = true;
  }
  setCropRect(CM.rectFromDrag(drag.anchor, at, natW, natH));
}

function endDrag() {
  if (!drag) return;
  drag = null;
  if (state === "cropping" && cropRect) setCropRect(CM.toIntRect(cropRect, natW, natH)); // snap to whole pixels
}

/** Arrow keys move the selection, Shift+arrows resize it, Enter applies. (Escape is handled on the document.) */
function onBoxKeyDown(event) {
  if (state !== "cropping" || processing) return;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const dir = arrows[event.key];
  if (dir) {
    event.preventDefault();
    const step = Math.max(1, Math.round(Math.max(natW, natH) / 100));
    const next = event.shiftKey
      ? CM.clampRect({ ...cropRect, width: cropRect.width + dir[0] * step, height: cropRect.height + dir[1] * step }, natW, natH)
      : CM.moveRect(cropRect, dir[0] * step, dir[1] * step, natW, natH);
    setCropRect(CM.toIntRect(next, natW, natH));
  } else if (event.key === "Enter") {
    event.preventDefault();
    applyCrop();
  }
}

// ---- object detection + pick ----------------------------------------------------------------

/** Put the ORIGINAL in the preview and read its natural size (boxes and crops are in those pixels). */
async function showOriginalDecoded() {
  els.preview.src = originalUrl;
  try {
    await els.preview.decode();
  } catch (_) {
    return false;
  }
  natW = els.preview.naturalWidth;
  natH = els.preview.naturalHeight;
  return natW > 0 && natH > 0;
}

function layoutDetOverlay() {
  if (state !== "choosing") return;
  const m = measure();
  if (!m) return;
  const stage = els.stage.getBoundingClientRect();
  const { box, content } = m;
  const frame = els.detFrame.style; // sits exactly on the drawn image, like the crop frame
  frame.left = box.left - stage.left + content.x + "px";
  frame.top = box.top - stage.top + content.y + "px";
  frame.width = content.width + "px";
  frame.height = content.height + "px";
}

/** Numbered boxes on the photo plus the same choices as buttons under it (text via textContent only). */
function buildPicker() {
  els.detFrame.replaceChildren();
  els.objectList.replaceChildren();
  objects.forEach((obj, i) => {
    const n = String(i + 1);
    const color = DM.colorFor(i);

    const boxBtn = document.createElement("button");
    boxBtn.type = "button";
    boxBtn.className = "det-box";
    boxBtn.setAttribute("aria-label", "Object " + n);
    boxBtn.style.setProperty("--c", color);
    const pct = DM.toPercent(obj, natW, natH);
    boxBtn.style.left = pct.left + "%";
    boxBtn.style.top = pct.top + "%";
    boxBtn.style.width = pct.width + "%";
    boxBtn.style.height = pct.height + "%";
    const tag = document.createElement("span");
    tag.className = "det-tag";
    tag.textContent = n;
    boxBtn.append(tag);
    boxBtn.addEventListener("click", () => selectObject(i));
    els.detFrame.append(boxBtn);

    const listBtn = document.createElement("button");
    listBtn.type = "button";
    listBtn.className = "btn";
    listBtn.style.setProperty("--c", color);
    const dot = document.createElement("span");
    dot.className = "dot";
    listBtn.append(dot, document.createTextNode("Object " + n));
    listBtn.addEventListener("click", () => selectObject(i));
    els.objectList.append(listBtn);
  });
}

async function enterChoosing() {
  if (!objects.length || !originalBlob || !canPreview || processing) return;
  const token = ++cropToken;
  if (!(await showOriginalDecoded())) {
    if (token !== cropToken) return;
    showImage();
    showError("Could not read this image to show the objects.");
    return;
  }
  if (token !== cropToken) return;
  state = "choosing";
  buildPicker();
  showImage();
  render();
  layoutDetOverlay();
  const first = els.detFrame.querySelector("button");
  if (first) first.focus();
}

/** Leave the picker without choosing: back to the result if there is one for the current photo/crop. */
function leaveChoosing() {
  if (state !== "choosing" || processing) return;
  cropToken += 1;
  state = lastProbs ? "result" : "captured";
  showImage();
  render(croppedBlob ? "Still using the current crop." : "Still using the whole photo.");
}

async function runDetection() {
  if (!originalBlob || !canPreview || processing || !["captured", "result"].includes(state)) return;
  const token = ++detectToken;
  const previous = state;
  state = "detecting";
  render();
  let body = null;
  try {
    const form = new FormData();
    form.append("image", originalBlob, originalBlob.name || "photo.jpg");
    const res = await fetch("/api/detect", { method: "POST", body: form });
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (token !== detectToken) return; // a newer photo or detection owns the page now
    if (!res.ok || !body || !Array.isArray(body.objects)) {
      state = previous;
      render((body && body.message) || "Object detection failed. You can still crop by hand and classify.", "error");
      return;
    }
  } catch (_) {
    if (token !== detectToken) return;
    state = previous;
    render("Could not reach the server. Is it still running?", "error");
    return;
  }
  const ok = await showOriginalDecoded();
  if (token !== detectToken) return;
  state = previous;
  if (!ok) {
    showImage();
    render("Could not read this image to show the objects.", "error");
    return;
  }
  objects = DM.scaleBoxes(body.objects, body.width, body.height, natW, natH);
  detected = true;
  if (objects.length === 0) {
    showImage();
    render(DM.foundMessage(0));
  } else {
    enterChoosing();
  }
}

/** Crop the ORIGINAL around object i (plus a margin) and send that crop to the model. */
async function selectObject(i) {
  if (processing || i < 0 || i >= objects.length || !originalBlob) return;
  if (!["captured", "result", "choosing"].includes(state)) return;
  const token = ++cropToken;
  processing = true;
  render("Cropping object " + (i + 1) + "...", "busy");
  if (!(await showOriginalDecoded())) {
    if (token !== cropToken) return;
    processing = false;
    showImage();
    render("Could not read this image for cropping. You can still classify it as it is.", "error");
    return;
  }
  const rect = DM.paddedRect(objects[i], natW, natH);
  const check = CM.validateRect(rect, natW, natH);
  if (!check.ok) {
    processing = false;
    render("That object is too small to classify. " + check.reason, "error");
    return;
  }
  let blob;
  try {
    blob = await cutBlob(rect);
  } catch (err) {
    if (token !== cropToken) return;
    processing = false;
    render(err.message, "error");
    return;
  }
  if (token !== cropToken) return;
  processing = false;
  if (croppedUrl) URL.revokeObjectURL(croppedUrl);
  croppedBlob = blob;
  croppedUrl = URL.createObjectURL(blob);
  cropInfo = { width: rect.width, height: rect.height, fromWidth: natW, fromHeight: natH, object: i + 1, of: objects.length };
  selectedObject = i;
  lastProbs = null;
  state = "captured";
  showImage();
  render();
  classify();
}

/** "Classify whole photo" from the picker: no crop. */
function classifyWhole() {
  if (state !== "choosing" || processing) return;
  useOriginal();
  classify();
}

function onDetectButton() {
  if (detected && objects.length > 0) enterChoosing();
  else runDetection();
}

// ---- classify + result ----------------------------------------------------------------------

function appendBar(list, item) {
  const pct = item.confidence * 100;
  const li = document.createElement("li");
  const head = document.createElement("div");
  head.className = "bar-head";
  const name = document.createElement("span");
  name.textContent = item.label;
  const value = document.createElement("span");
  value.textContent = DC.formatPercent(item.confidence);
  head.append(name, value);
  const track = document.createElement("div");
  track.className = "track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", item.label);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", pct.toFixed(1));
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.style.width = pct.toFixed(1) + "%";
  track.append(fill);
  li.append(head, track);
  list.append(li);
}

/** Re-decide from the cached probabilities with the slider value: no network involved. */
function renderThreshold() {
  const t = DC.normaliseThreshold(els.slider.value, appConfig.default_threshold);
  els.thresholdValue.textContent = t.toFixed(2);
  const hint = DC.hintFor(t, appConfig.threshold_table);
  els.thresholdHint.hidden = hint === null;
  els.thresholdHint.textContent = hint || "";
  if (!lastProbs) return;

  const d = DC.decide(lastProbs, t);
  const known = d.status === "known";
  els.resultKnown.hidden = !known;
  els.resultUnknown.hidden = known;
  els.tips.hidden = known;
  if (known) {
    els.resultLabel.textContent = d.label;
    els.resultConf.textContent = DC.formatPercent(d.confidence) + " confident";
  }
  els.bars.replaceChildren();
  for (const item of d.shown) appendBar(els.bars, item);
  els.tipsList.replaceChildren();
  if (!known) {
    for (const tip of DC.RETAKE_TIPS) {
      const li = document.createElement("li");
      li.textContent = tip;
      els.tipsList.append(li);
    }
  }
}

async function classify() {
  const blob = croppedBlob || originalBlob;
  if (!blob || state === "classifying" || !["captured", "result"].includes(state)) return;
  const previous = state;
  state = "classifying";
  render();
  try {
    const form = new FormData();
    form.append("image", blob, blob.name || (croppedBlob ? "crop.jpg" : "capture.jpg"));
    const res = await fetch("/api/predict", { method: "POST", body: form });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok || !body || !Array.isArray(body.probabilities)) {
      state = previous === "result" && lastProbs ? "result" : "captured";
      render((body && body.message) || "The server could not classify that image.", "error");
      return;
    }
    lastProbs = body.probabilities;
    state = "result";
    renderThreshold();
    render("Done.");
    els.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (_) {
    state = previous === "result" && lastProbs ? "result" : "captured";
    render("Could not reach the server. Is it still running?", "error");
  }
}

// ---- startup --------------------------------------------------------------------------------

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("config unavailable");
    const cfg = await res.json();
    appConfig = {
      default_threshold: DC.normaliseThreshold(cfg.default_threshold, DC.DEFAULT_THRESHOLD),
      slider: cfg.slider || appConfig.slider,
      threshold_table: Array.isArray(cfg.threshold_table) ? cfg.threshold_table : [],
    };
  } catch (_) {
    // keep the built-in defaults; the hint simply stays hidden
  }
  els.slider.min = String(appConfig.slider.min);
  els.slider.max = String(appConfig.slider.max);
  els.slider.step = String(appConfig.slider.step);
  els.slider.value = String(appConfig.default_threshold);
  renderThreshold();
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) render("The model is not available right now. Check the server window for details.", "error");
  } catch (_) {
    render("Could not reach the server. Is it still running?", "error");
  }
}

els.file.addEventListener("change", () => handleFile(els.file.files[0]));
els.cameraBtn.addEventListener("click", startCamera);
els.cameraSource.addEventListener("change", onCameraSourceChange);
els.refreshBtn.addEventListener("click", () => {
  if (!cameraControlsLocked) refreshCameras();
});
els.video.addEventListener("loadedmetadata", updateCameraInfo);
els.video.addEventListener("resize", updateCameraInfo);
if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
  navigator.mediaDevices.addEventListener("devicechange", () => refreshCameras());
}
els.captureBtn.addEventListener("click", onCapture);
els.verticalToggle.addEventListener("change", () => {
  verticalFrame = els.verticalToggle.checked;
  render();
  updateCameraInfo();
});
els.retakeBtn.addEventListener("click", retake);
els.cropBtn.addEventListener("click", openCrop);
els.useOriginalBtn.addEventListener("click", useOriginal);
els.applyBtn.addEventListener("click", applyCrop);
els.cancelBtn.addEventListener("click", cancelCrop);
els.classifyBtn.addEventListener("click", classify);
els.detectBtn.addEventListener("click", onDetectButton);
els.wholeBtn.addEventListener("click", classifyWhole);
els.slider.addEventListener("input", renderThreshold);
els.cropOverlay.addEventListener("pointerdown", onPointerDown);
els.cropOverlay.addEventListener("pointermove", onPointerMove);
els.cropOverlay.addEventListener("pointerup", endDrag);
els.cropOverlay.addEventListener("pointercancel", endDrag);
els.cropOverlay.addEventListener("lostpointercapture", endDrag);
els.cropBox.addEventListener("keydown", onBoxKeyDown);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state === "cropping" && !processing) cancelCrop();
  if (state === "choosing" && !processing) {
    if (event.key === "Escape") leaveChoosing();
    const i = DM.keyToIndex(event.key, objects.length);
    if (i >= 0) {
      event.preventDefault();
      selectObject(i);
    }
  }
});
function layoutAll() {
  layoutOverlay();
  layoutDetOverlay();
}
window.addEventListener("resize", layoutAll);
if (typeof ResizeObserver === "function") new ResizeObserver(layoutAll).observe(els.stage);
window.addEventListener("pagehide", stopCamera);
// Back/forward cache restores the old DOM without running scripts again: start from a clean state.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopCamera();
    clearImage();
    state = "idle";
    render();
  }
});

render();
loadConfig();
checkHealth();
refreshCameras(); // lists cameras only; it never opens one, so no permission prompt appears on load
