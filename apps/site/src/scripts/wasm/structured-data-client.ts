/**
 * Structured-data WASM client (main thread). YAML format/validate one-shot
 * operations. Caches the module init promise; normalizes thrown values into
 * typed `WasmError`.
 */
import init, * as sd from "@/generated/wasm/structured_data/structured_data.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}

/** Format YAML (pretty-print). Throws WasmError on invalid YAML. */
export async function yamlFormat(input: string): Promise<string> {
  await ensureReady();
  return wrap(() => sd.yaml_format(input));
}

/** Validate YAML. Resolves when valid; throws WasmError with details otherwise. */
export async function yamlValidate(input: string): Promise<void> {
  await ensureReady();
  return wrap(() => sd.yaml_validate(input));
}
