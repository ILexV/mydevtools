/**
 * QR Code Scanner client controller. Image picked via the file button, drag
 * & drop or a click on the drop zone (`bindDropzone`); bytes are decoded by the
 * qrcode WASM module in a Web Worker (`qrDecode`), so a large photo doesn't
 * freeze the page. Localized errors: not an image, unsupported format (crate
 * decodes png/jpeg/webp), no QR found, read failure. URL results expose an
 * open-link action (http/https only). A newer file or Clear aborts the
 * in-flight decode (terminates the worker) and a sequence token guarantees a
 * stale result never overwrites the current one.
 *
 * Camera: "Scan with camera" (`qr-camera.ts`) shows a live preview with a
 * framing overlay and a camera switcher (>1 device); frames are decoded in the
 * same worker. The camera stops on the first result (button becomes "Scan
 * again"), on Stop, on page hide and when a file is chosen. The button is
 * hidden when getUserMedia is missing in a secure context; on an insecure
 * page it stays and explains why the camera is unavailable.
 */
import { qrDecode } from "@/scripts/wasm/qrcode-decode-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, copyWithFeedback, setDropzoneHasFile } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { classifyDecodeError, isHttpUrl, isImageType, type CameraErrorKind } from "@/tools/qr-code";
import { cameraSupported, createCameraScanner } from "@/tools/qr-camera";

interface Strings {
  copy: string;
  copied: string;
  errorNotImage: string;
  errorNoQr: string;
  errorReading: string;
  errorUnsupportedImage: string;
  errorCopy: string;
  scanCamera: string;
  scanAgain: string;
  errorCameraDenied: string;
  errorCameraNotFound: string;
  errorCameraInUse: string;
  errorCameraInsecure: string;
  errorCameraGeneric: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-qrs-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-qrs-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  root.dataset.initialized = "true";
  const strings: Strings = raw;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const zone = q<HTMLElement>("[data-qrs-dropzone]");
  const input = q<HTMLInputElement>("[data-qrs-file]");
  const clearBtn = q<HTMLButtonElement>("[data-qrs-clear]");
  const selectedEl = q<HTMLElement>("[data-qrs-selected]");
  const preview = q<HTMLImageElement>("[data-qrs-preview]");
  const nameEl = q<HTMLElement>("[data-qrs-filename]");
  const sizeEl = q<HTMLElement>("[data-qrs-filesize]");
  const busyEl = q<HTMLElement>("[data-qrs-busy]");
  const resultEl = q<HTMLElement>("[data-qrs-result]");
  const outputArea = q<HTMLTextAreaElement>("[data-qrs-output]");
  const copyBtn = q<HTMLButtonElement>("[data-qrs-copy]");
  const linkWrap = q<HTMLElement>("[data-qrs-linkwrap]");
  const openLink = q<HTMLAnchorElement>("[data-qrs-openlink]");
  const errorBox = q<HTMLElement>("[data-qrs-error]");
  const cameraActions = q<HTMLElement>("[data-qrs-camera-actions]");
  const cameraStart = q<HTMLButtonElement>("[data-qrs-camera-start]");
  const cameraStartLabel = q<HTMLElement>("[data-qrs-camera-start-label]");
  const cameraSection = q<HTMLElement>("[data-qrs-camera]");
  const video = q<HTMLVideoElement>("[data-qrs-video]");
  const cameraStop = q<HTMLButtonElement>("[data-qrs-camera-stop]");
  const cameraSelectWrap = q<HTMLElement>("[data-qrs-camera-select-wrap]");
  const cameraSelect = q<HTMLSelectElement>("[data-qrs-camera-select]");

  if (!zone || !input || !selectedEl || !preview || !resultEl || !outputArea || !errorBox) return;

  let previewUrl: string | null = null;
  let seq = 0;
  let decodeJob: AbortController | null = null;

  function showError(msg: string) {
    errorBox!.textContent = msg;
    errorBox!.hidden = false;
  }
  function clearError() {
    errorBox!.hidden = true;
    errorBox!.textContent = "";
  }
  function setBusy(on: boolean) {
    if (busyEl) busyEl.hidden = !on;
    zone!.setAttribute("aria-busy", String(on));
  }

  function hideResult() {
    resultEl!.hidden = true;
    outputArea!.value = "";
    if (linkWrap) linkWrap.hidden = true;
    openLink?.removeAttribute("href");
  }

  function showResult(text: string) {
    outputArea!.value = text;
    resultEl!.hidden = false;
    if (isHttpUrl(text) && openLink && linkWrap) {
      openLink.href = text;
      linkWrap.hidden = false;
    }
  }

  function showSelection(file: File) {
    selectedEl!.hidden = false;
    setDropzoneHasFile(zone!, true);
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatBytes(file.size, 2);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview!.src = previewUrl;
  }

  function clearSelection() {
    seq++; // drop any in-flight decode result
    decodeJob?.abort();
    decodeJob = null;
    setBusy(false);
    input!.value = "";
    selectedEl!.hidden = true;
    setDropzoneHasFile(zone!, false);
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    preview!.removeAttribute("src");
  }

  async function handleFile(file: File) {
    closeCamera(); // switching to file upload always releases the camera
    clearError();
    hideResult();
    if (!isImageType(file.type)) {
      clearSelection();
      showError(strings.errorNotImage);
      return;
    }

    showSelection(file);
    const mine = ++seq;
    decodeJob?.abort(); // superseded: stop the old decode instead of waiting for it
    const ctrl = new AbortController();
    decodeJob = ctrl;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await qrDecode(bytes, ctrl.signal);
      if (mine !== seq) return;
      showResult(text);
    } catch (e) {
      if (mine !== seq) return;
      if (e instanceof WasmError) {
        showError(classifyDecodeError(e.message) === "unsupportedImage" ? strings.errorUnsupportedImage : strings.errorNoQr);
      } else {
        showError(strings.errorReading);
      }
    } finally {
      if (decodeJob === ctrl) decodeJob = null;
      if (mine === seq) setBusy(false);
    }
  }

  // ---- Live camera scanning ----
  const cameraMessages: Record<CameraErrorKind, string> = {
    denied: strings.errorCameraDenied,
    notFound: strings.errorCameraNotFound,
    inUse: strings.errorCameraInUse,
    insecure: strings.errorCameraInsecure,
    generic: strings.errorCameraGeneric,
  };

  function hideCameraUi() {
    if (cameraSection) cameraSection.hidden = true;
    if (cameraSelectWrap) cameraSelectWrap.hidden = true;
    cameraStart?.removeAttribute("aria-expanded");
  }

  const camera = video
    ? createCameraScanner({
        video,
        onResult(text) {
          hideCameraUi();
          if (cameraStartLabel) cameraStartLabel.textContent = strings.scanAgain;
          showResult(text);
          outputArea!.focus();
        },
        onError(kind) {
          hideCameraUi();
          showError(cameraMessages[kind]);
          cameraStart?.focus();
        },
        onDevices(devices, activeId) {
          if (!cameraSelect || !cameraSelectWrap) return;
          cameraSelect.replaceChildren(
            ...devices.map((d, i) => {
              const opt = document.createElement("option");
              opt.value = d.deviceId;
              opt.textContent = d.label || `${i + 1}`;
              opt.selected = d.deviceId === activeId;
              return opt;
            }),
          );
          cameraSelectWrap.hidden = devices.length < 2;
        },
        onInterrupted: hideCameraUi,
      })
    : null;

  function closeCamera() {
    if (camera?.running) camera.stop();
    hideCameraUi();
  }

  // Hide the button only where getUserMedia is genuinely unsupported; on an
  // insecure page keep it so the user learns why the camera can't start.
  if (camera && cameraActions && (cameraSupported() || !window.isSecureContext)) cameraActions.hidden = false;

  cameraStart?.addEventListener("click", () => {
    if (!camera) return;
    clearSelection();
    hideResult();
    clearError();
    if (cameraSection) cameraSection.hidden = false;
    cameraStart.setAttribute("aria-expanded", "true");
    void camera.start();
  });
  cameraStop?.addEventListener("click", () => {
    closeCamera();
    cameraStart?.focus();
  });
  cameraSelect?.addEventListener("change", () => {
    if (camera?.running) void camera.start(cameraSelect.value);
  });

  bindDropzone(zone, input, (files) => {
    if (files[0]) void handleFile(files[0]);
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
    hideResult();
    clearError();
  });

  copyBtn?.addEventListener("click", async () => {
    if (!outputArea.value) return;
    const ok = await copyWithFeedback(copyBtn, outputArea.value, strings.copied);
    if (!ok) showError(strings.errorCopy);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
