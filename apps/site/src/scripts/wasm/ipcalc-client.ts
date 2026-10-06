/**
 * IP calculator WASM client (main thread). One-shot IPv4 / IPv6 subnet
 * calculation and subnet splitting. Caches the module init promise; normalizes thrown values
 * into typed `WasmError`.
 */
import init, { calc_ipv4, calc_ipv6, split_ipv4, split_ipv6 } from "@/generated/wasm/ipcalc/ipcalc.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
/** Load + instantiate the module once; a failed load is retried on the next call. */
export function ensureIpcalcReady(): Promise<void> {
  if (!ready) {
    ready = init().then(
      () => undefined,
      (e: unknown) => {
        ready = null;
        throw e;
      },
    );
  }
  return ready;
}

/** WASM-defined result JSON (network, broadcast, mask, hosts — see legacy ip-subnet-calculator). */
export async function calcIpv4(input: string): Promise<unknown> {
  await ensureIpcalcReady();
  try {
    return calc_ipv4(input);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}

/** True when the input looks like IPv6 (contains a colon) — routes to `calcIpv6`. */
export function isIpv6Input(input: string): boolean {
  return input.includes(":");
}

/** WASM IPv6 result JSON (network, first/last, address count as decimal string — see wasm/ipcalc/src/ipv6.rs). */
export async function calcIpv6(input: string): Promise<unknown> {
  await ensureIpcalcReady();
  try {
    return calc_ipv6(input);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}

/**
 * Split the network in `input` (IPv4 or IPv6, routed like `calcIpv4`/`calcIpv6`)
 * into `/newPrefix` subnets. WASM `SplitResult` (wasm/ipcalc/src/split.rs):
 * counts as decimal strings, at most 256 subnets listed + `truncated`.
 */
export async function splitSubnets(input: string, newPrefix: number): Promise<unknown> {
  await ensureIpcalcReady();
  try {
    return isIpv6Input(input) ? split_ipv6(input, newPrefix) : split_ipv4(input, newPrefix);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}
