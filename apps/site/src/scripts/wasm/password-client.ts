/**
 * Password WASM client (main thread). One-shot password generation —
 * fast enough to not need a worker. Caches the module init promise.
 */
import init, { generate_password, PasswordOptions } from "@/generated/wasm/password/password.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

export interface PasswordGenOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  specialChars: string;
}

export async function generatePassword(options: PasswordGenOptions): Promise<string> {
  await ensureReady();
  try {
    const opts = new PasswordOptions(
      options.length,
      options.uppercase,
      options.lowercase,
      options.numbers,
      options.special,
      options.specialChars,
    );
    try {
      return generate_password(opts);
    } finally {
      opts.free();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}
