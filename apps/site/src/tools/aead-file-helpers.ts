/**
 * AEAD file tool helpers (pure, unit-tested in test/crypto-tools.test.ts):
 * output file names (`<name>.aead` on encrypt; strip `.aead` or append
 * `.dec` on decrypt — legacy parity), the progress line
 * `X / Y • speed/s • ETA m:ss`, duration formatting, and the container
 * algorithm id / header hex used by the AEAD worker, and the Argon2id cost
 * presets / custom-value parsing / weak-setting rule of the KDF selector.
 */
import { formatBytes, progressPercent } from "../lib/format.ts";
import type { AeadAlgorithm, AeadKdfParams } from "../scripts/wasm/aead-file-protocol.ts";

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

/** Container algorithm id written into the MDT header: 1 AES-256-GCM, 2 ChaCha20-Poly1305, 3 XChaCha20-Poly1305. */
export function aeadAlgorithmId(algorithm: AeadAlgorithm): number {
  if (algorithm === "chacha20-poly1305") return 2;
  if (algorithm === "xchacha20-poly1305") return 3;
  return 1;
}

/** Lowercase hex of the container header (shown in the output panel). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Site default (MDT3 header version 1, no stored parameters): 64 MiB, 3 passes, 1 lane. */
export const AEAD_KDF_DEFAULT: AeadKdfParams = { memKib: 64 * 1024, iterations: 3, parallelism: 1 };

/** Key-derivation presets; "custom" opens memory/passes/lanes fields. */
export const AEAD_KDF_PRESETS: Readonly<Record<string, AeadKdfParams>> = {
  light: { memKib: 19 * 1024, iterations: 2, parallelism: 1 },
  standard: AEAD_KDF_DEFAULT,
  strong: { memKib: 256 * 1024, iterations: 4, parallelism: 1 },
  maximum: { memKib: 1024 * 1024, iterations: 4, parallelism: 1 },
};

/** Custom field bounds (match the WASM header limits, memory capped lower for browsers). */
export const AEAD_KDF_LIMITS = { memMib: [8, 2048], iterations: [1, 64], parallelism: [1, 16] } as const;

function intInRange(text: string, [min, max]: readonly [number, number]): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** Custom fields (memory in MiB, passes, lanes) → params, or the name of the first invalid field. */
export function parseKdfCustom(memMib: string, iterations: string, parallelism: string): AeadKdfParams | "memory" | "iterations" | "parallelism" {
  const mem = intInRange(memMib, AEAD_KDF_LIMITS.memMib);
  if (mem === null) return "memory";
  const it = intInRange(iterations, AEAD_KDF_LIMITS.iterations);
  if (it === null) return "iterations";
  const par = intInRange(parallelism, AEAD_KDF_LIMITS.parallelism);
  if (par === null) return "parallelism";
  return { memKib: mem * 1024, iterations: it, parallelism: par };
}

/**
 * Below the OWASP Argon2id floor (19 MiB × 2 passes, or the equivalent
 * memory × passes product such as 46 MiB × 1) — guessing gets cheap.
 */
export function isWeakKdf(p: AeadKdfParams): boolean {
  const mib = p.memKib / 1024;
  return p.iterations === 1 ? mib < 46 : mib * p.iterations < 38;
}

export function isDefaultKdf(p: AeadKdfParams): boolean {
  return p.memKib === AEAD_KDF_DEFAULT.memKib && p.iterations === AEAD_KDF_DEFAULT.iterations && p.parallelism === AEAD_KDF_DEFAULT.parallelism;
}

/** Compact technical label shown in the result: `Argon2id m=64 MiB, t=3, p=1`. */
export function kdfLabel(p: AeadKdfParams): string {
  return `Argon2id m=${Math.round(p.memKib / 1024)} MiB, t=${p.iterations}, p=${p.parallelism}`;
}
