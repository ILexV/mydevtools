/**
 * AEAD file tool helpers (pure, unit-tested in test/crypto-tools.test.ts):
 * output file names (`<name>.aead` on encrypt; strip `.aead` or append
 * `.dec` on decrypt — legacy parity), the progress line
 * `X / Y • speed/s • ETA m:ss`, and duration formatting.
 */
import { formatBytes, progressPercent } from "../lib/format.ts";

export const AEAD_EXTENSION = ".aead";

/** Encrypted output name: always appends `.aead`. */
export function encryptedName(name: string): string {
  return `${name}${AEAD_EXTENSION}`;
}

/** Decrypted output name: strips a trailing `.aead` (case-insensitive), else appends `.dec`. */
export function decryptedName(name: string): string {
  const stripped = name.toLowerCase().endsWith(AEAD_EXTENSION) ? name.slice(0, -AEAD_EXTENSION.length) : "";
  return stripped ? stripped : `${name}.dec`;
}

/** Legacy formatDuration parity: `m:ss` or `h:mm:ss`; `--:--` for unknown. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface AeadProgressView {
  percent: number;
  text: string;
}

/** Progress bar percent + `processed / total • speed/s • ETA` label (2-digit byte units). */
export function aeadProgressView(processed: number, total: number, elapsedMs: number): AeadProgressView {
  const seconds = elapsedMs / 1000;
  const speed = seconds > 0 ? processed / seconds : 0;
  const remaining = speed > 0 ? Math.max(0, total - processed) / speed : Number.NaN;
  return {
    percent: progressPercent(processed, total),
    text: `${formatBytes(processed, 2)} / ${formatBytes(total, 2)} • ${formatBytes(speed, 2)}/s • ETA ${formatDuration(remaining)}`,
  };
}
