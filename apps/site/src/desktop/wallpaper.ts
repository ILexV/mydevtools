/**
 * Desktop wallpapers. Built-in presets are CSS (no network). A custom picture
 * is decoded in the browser, scaled down, and stored as a blob in IndexedDB
 * so it does not compete with the localStorage quota. SVG and remote URLs
 * are rejected. Metadata is dropped because the pixels are re-encoded.
 */

export const WALLPAPER_PRESETS = [
  { id: "coast", labelKey: "PresetCoast" },
  { id: "dusk", labelKey: "PresetDusk" },
  { id: "dune", labelKey: "PresetDune" },
  { id: "graphite", labelKey: "PresetGraphite" },
  { id: "aurora", labelKey: "PresetAurora" },
  { id: "alpine", labelKey: "PresetAlpine" },
  { id: "silk", labelKey: "PresetSilk" },
  { id: "ember", labelKey: "PresetEmber" },
] as const;

export type WallpaperPresetId = (typeof WALLPAPER_PRESETS)[number]["id"];

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const DB_NAME = "mdt.desktop";
const STORE = "files";
const KEY = "wallpaper";

/** Long side 2560, short side 1920. Smaller images stay at their own size. */
export function fittedSize(width: number, height: number, maxLong = 2560, maxShort = 1920): { width: number; height: number } {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  let scale = 1;
  if (long > maxLong) scale = Math.min(scale, maxLong / long);
  if (short > maxShort) scale = Math.min(scale, maxShort / short);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function wallpaperTooSmall(width: number, height: number): boolean {
  return width < 1600 || height < 1600;
}

export interface PreparedWallpaper {
  blob: Blob;
  tooSmall: boolean;
}

export async function prepareWallpaper(file: File): Promise<PreparedWallpaper> {
  if (!ALLOWED.has(file.type) || file.size <= 0 || file.size > MAX_BYTES) {
    throw new Error("invalid-wallpaper");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const size = fittedSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("invalid-wallpaper");
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
    if (!blob) throw new Error("invalid-wallpaper");
    return { blob, tooSmall: wallpaperTooSmall(bitmap.width, bitmap.height) };
  } finally {
    bitmap.close();
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveWallpaperBlob(blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadWallpaperBlob(): Promise<Blob | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result instanceof Blob ? result : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function clearWallpaperBlob(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
