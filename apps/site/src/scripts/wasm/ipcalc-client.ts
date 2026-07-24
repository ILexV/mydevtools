/**
 * IP calculator WASM client (main thread). One-shot IPv4 subnet
 * calculation. Caches the module init promise; normalizes thrown values
 * into typed `WasmError`.
 */
import init, { calc_ipv4 } from "@/generated/wasm/ipcalc/ipcalc.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

/** WASM-defined result JSON (network, broadcast, mask, hosts — see legacy ip-subnet-calculator). */
export async function calcIpv4(input: string): Promise<unknown> {
  await ensureReady();
  try {
    return calc_ipv4(input);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}
