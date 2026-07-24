/**
 * Regex WASM client (main thread). One-shot regex test — Rust regex engine
 * with legacy-compatible result shape. Caches the module init promise.
 */
import init, { test_regex } from "@/generated/wasm/regex_tool/regex_tool.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

/** WASM-defined result JSON (matches array, groups, positions — see legacy regex-tester). */
export async function regexTest(pattern: string, text: string): Promise<unknown> {
  await ensureReady();
  try {
    return test_regex(pattern, text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}
