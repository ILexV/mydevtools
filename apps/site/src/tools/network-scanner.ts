/**
 * Network scanner settings and the report. The timeout, the probe ports and
 * the name setting are stored; the network and the hosts found are not.
 */
import type { NetworkScanHost } from "../scripts/local-agent.ts";

export const NETWORK_SCANNER_STORAGE_KEY = "mdt.network-scanner.v1";
export const NETWORK_TIMEOUT_MIN = 200;
export const NETWORK_TIMEOUT_MAX = 5_000;
export const NETWORK_TIMEOUT_DEFAULT = 1_000;
/** The agent tries at most this many TCP ports on each address. */
export const MAX_PROBE_PORTS = 16;
export const DEFAULT_PROBE_PORTS = "22, 80, 443, 445, 3389";
/** The agent scans a /22 at most. */
export const MIN_NETWORK_PREFIX = 22;

export interface NetworkScannerSettings {
  v: 1;
  timeoutMs: number;
  ports: string;
  resolveNames: boolean;
}

export function defaultNetworkScannerSettings(): NetworkScannerSettings {
  return { v: 1, timeoutMs: NETWORK_TIMEOUT_DEFAULT, ports: DEFAULT_PROBE_PORTS, resolveNames: true };
}

export const isNetworkTimeout = (value: unknown): value is number => typeof value === "number"
  && Number.isInteger(value) && value >= NETWORK_TIMEOUT_MIN && value <= NETWORK_TIMEOUT_MAX;

export function parseNetworkScannerSettings(value: unknown): NetworkScannerSettings {
  const settings = defaultNetworkScannerSettings();
  if (!value || typeof value !== "object") return settings;
  const saved = value as Partial<Record<keyof NetworkScannerSettings, unknown>>;
  if (isNetworkTimeout(saved.timeoutMs)) settings.timeoutMs = saved.timeoutMs;
  if (typeof saved.ports === "string" && parseProbePorts(saved.ports)) settings.ports = saved.ports;
  if (typeof saved.resolveNames === "boolean") settings.resolveNames = saved.resolveNames;
  return settings;
}

/** Up to 16 single ports, separated by commas or spaces; empty means ICMP and ARP only. */
export function parseProbePorts(text: string): number[] | null {
  const tokens = text.split(/[\s,;]+/u).filter(Boolean);
  const ports: number[] = [];
  for (const token of tokens) {
    if (!/^\d{1,5}$/u.test(token)) return null;
    const port = Number(token);
    if (port < 1 || port > 65_535) return null;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports.length <= MAX_PROBE_PORTS ? ports.sort((a, b) => a - b) : null;
}

/** An IPv4 CIDR from /22 to /32, normalized to its network address; null otherwise. */
export function parseNetwork(text: string): { network: string; prefix: number; size: number } | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(text.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return null;
  if (prefix < MIN_NETWORK_PREFIX) return null;
  const value = octets.reduce((sum, octet) => sum * 256 + octet, 0);
  const size = 2 ** (32 - prefix);
  const base = value - (value % size);
  const network = [24, 16, 8, 0].map((shift) => Math.floor(base / 2 ** shift) % 256).join(".");
  return { network: `${network}/${prefix}`, prefix, size };
}

/** Numeric IPv4 order, for the table and the report. */
export function compareAddresses(left: string, right: string): number {
  const value = (address: string) => address.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
  return value(left) - value(right);
}

/** Tab-separated report, one host per line in address order; pastes into a spreadsheet. */
export function formatNetworkReport(network: string, hosts: readonly NetworkScanHost[]): string {
  const rows = [...hosts].sort((a, b) => compareAddresses(a.address, b.address)).map((host) => [
    host.address,
    host.name ?? "",
    host.mac ?? "",
    host.rttMs === undefined ? "" : `${host.rttMs} ms`,
    host.openPorts.join(","),
    host.via.join(","),
    host.thisComputer ? "this computer" : "",
  ].join("\t"));
  return [network, ["address", "name", "mac", "rtt", "open ports", "seen by", "note"].join("\t"), ...rows].join("\n");
}
