/**
 * Live camera QR scanning for the QR scanner tool. Opens the rear camera
 * (`getUserMedia`, facingMode "environment", or a chosen deviceId), shows it
 * in a <video>, and decodes frames in the qrcode Web Worker: each frame is
 * downscaled to ≤1024 px via `createImageBitmap` (transferred; raw RGBA as a
 * fallback) and a new frame is grabbed only when the previous decode has
 * finished — frames are dropped, never queued. Stops (all tracks released) on
 * the first successful decode, on `stop()`, and on page hide. Camera failures
 * are reported as kinds (denied / notFound / inUse / insecure / generic).
 */
import { qrDecodeBitmap, qrDecodeImageData } from "@/scripts/wasm/qrcode-decode-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { cameraFrameSize, classifyCameraError, type CameraErrorKind } from "@/tools/qr-code";

/** Pause between frame grabs (ms); decode time adds to it, frames are never queued. */
const FRAME_INTERVAL_MS = 120;

export interface CameraScannerOptions {
  video: HTMLVideoElement;
  onResult(text: string): void;
  onError(kind: CameraErrorKind): void;
  onProcessingError(): void;
  /** Called with the available video inputs once permission is granted. */
  onDevices?(devices: MediaDeviceInfo[], activeId: string | undefined): void;
  /** The page was hidden and the camera released (UI should reset). */
  onInterrupted?(): void;
}

export interface CameraScanner {
  start(deviceId?: string): Promise<void>;
  stop(): void;
  readonly running: boolean;
}

/** True when getUserMedia exists (a secure context in a supporting browser). */
export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function createCameraScanner(opts: CameraScannerOptions): CameraScanner {
  const { video } = opts;
  let stream: MediaStream | null = null;
  let session = 0; // bumps on every start/stop: stale async work checks it
  let active = false; // between start() and stop(), incl. the permission prompt
  let timer: number | null = null;
  let fallbackCanvas: HTMLCanvasElement | null = null;
  let decodeController: AbortController | null = null;
  const useBitmap = typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";

  function stop(): void {
    session++;
    active = false;
    decodeController?.abort();
    decodeController = null;
    if (timer) clearTimeout(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.pause();
    video.srcObject = null;
  }

  async function grab(width: number, height: number, signal: AbortSignal): Promise<string> {
    if (useBitmap) {
      const bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
      return qrDecodeBitmap(bitmap, signal);
    }
    if (!fallbackCanvas) fallbackCanvas = document.createElement("canvas");
    fallbackCanvas.width = width;
    fallbackCanvas.height = height;
    const ctx = fallbackCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2D context");
    ctx.drawImage(video, 0, 0, width, height);
    return qrDecodeImageData(ctx.getImageData(0, 0, width, height), signal);
  }

  function schedule(mine: number): void {
    timer = window.setTimeout(() => void tick(mine), FRAME_INTERVAL_MS);
  }

  async function tick(mine: number): Promise<void> {
    if (mine !== session) return;
    const size = video.readyState >= 2 ? cameraFrameSize(video.videoWidth, video.videoHeight) : null;
    if (!size) return schedule(mine);
    const signal = decodeController?.signal;
    if (!signal) return;
    try {
      const text = await grab(size.width, size.height, signal);
      if (mine !== session) return;
      stop();
      opts.onResult(text);
      return;
    } catch (error) {
      if (mine !== session) return;
      if (error instanceof WasmError && error.code === "unknown") {
        // A valid frame with no decodable QR code is expected while scanning.
      } else {
        stop();
        opts.onProcessingError();
        return;
      }
    }
    if (mine === session) schedule(mine);
  }

  async function start(deviceId?: string): Promise<void> {
    stop();
    active = true;
    const mine = session;
    if (!window.isSecureContext || !cameraSupported()) {
      active = false;
      opts.onError("insecure");
      return;
    }
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } },
      });
    } catch (e) {
      if (mine === session) {
        active = false;
        opts.onError(classifyCameraError(e instanceof Error ? e.name : undefined));
      }
      return;
    }
    if (mine !== session) {
      // Stopped while the permission prompt was open: release immediately.
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    video.srcObject = s;
    try {
      await video.play();
    } catch {
      // Autoplay of a muted inline video should not fail; frames are still read.
    }
    if (mine !== session) return;
    if (opts.onDevices) {
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        const activeId = s.getVideoTracks()[0]?.getSettings().deviceId;
        if (mine === session) opts.onDevices(devices, activeId);
      } catch {
        // Device list is optional (switcher stays hidden).
      }
    }
    if (mine !== session) return;
    decodeController = new AbortController();
    schedule(mine);
  }

  // Never keep the camera on in the background.
  function interrupt(): void {
    if (!active) return;
    stop();
    opts.onInterrupted?.();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") interrupt();
  });
  window.addEventListener("pagehide", interrupt);

  return {
    start,
    stop,
    get running() {
      return active;
    },
  };
}
