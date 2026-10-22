/**
 * Port scanner settings, port lists and the text report. The port list, the
 * timeout and the parallelism are settings; the host and the results are not
 * stored.
 */
import type { PortScanCounts, PortScanStatus } from "../scripts/local-agent.ts";

export const PORT_SCANNER_STORAGE_KEY = "mdt.port-scanner.v1";
export const PORT_TIMEOUT_MIN = 200;
export const PORT_TIMEOUT_MAX = 5_000;
export const PORT_TIMEOUT_DEFAULT = 1_000;
export const PORT_PARALLEL_MIN = 1;
export const PORT_PARALLEL_MAX = 64;
export const PORT_PARALLEL_DEFAULT = 64;
/** The agent accepts at most this many ranges in one scan. */
export const MAX_PORT_RANGES = 1024;

export type PortPreset = "common" | "well-known" | "all" | "custom";

export interface PortScannerSettings {
  v: 1;
  preset: PortPreset;
  /** The custom list as typed, e.g. `22, 80, 8000-8100`. */
  custom: string;
  timeoutMs: number;
  parallel: number;
}

/** Well-known services, shown next to a port number in results and reports. */
export const SERVICES: Readonly<Record<number, string>> = {
  20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 67: "dhcp", 69: "tftp",
  80: "http", 88: "kerberos", 110: "pop3", 111: "rpcbind", 123: "ntp", 135: "msrpc", 137: "netbios-ns",
  139: "netbios-ssn", 143: "imap", 161: "snmp", 179: "bgp", 389: "ldap", 443: "https", 445: "smb",
  465: "smtps", 514: "syslog", 515: "printer", 548: "afp", 554: "rtsp", 587: "submission", 631: "ipp",
  636: "ldaps", 853: "dns-over-tls", 873: "rsync", 990: "ftps", 993: "imaps", 995: "pop3s",
  1080: "socks", 1194: "openvpn", 1433: "mssql", 1521: "oracle", 1723: "pptp", 1883: "mqtt",
  2049: "nfs", 2375: "docker", 2376: "docker-tls", 3000: "http-dev", 3306: "mysql", 3389: "rdp",
  5000: "http-alt", 5060: "sip", 5222: "xmpp", 5353: "mdns", 5432: "postgresql", 5672: "amqp",
  5900: "vnc", 5985: "winrm", 5986: "winrm-https", 6379: "redis", 6443: "kubernetes", 8000: "http-alt",
  8080: "http-proxy", 8081: "http-alt", 8443: "https-alt", 8883: "mqtt-tls", 9000: "http-alt",
  9090: "http-alt", 9092: "kafka", 9100: "jetdirect", 9200: "elasticsearch", 11211: "memcached",
  27017: "mongodb",
};

/** The «Common» preset: every port with a service name above. */
export const COMMON_PORTS: readonly number[] = Object.keys(SERVICES).map(Number).sort((a, b) => a - b);

export function defaultPortScannerSettings(): PortScannerSettings {
  return { v: 1, preset: "common", custom: "", timeoutMs: PORT_TIMEOUT_DEFAULT, parallel: PORT_PARALLEL_DEFAULT };
}

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export const isPortTimeout = (value: unknown): value is number => inRange(value, PORT_TIMEOUT_MIN, PORT_TIMEOUT_MAX);
export const isPortParallel = (value: unknown): value is number => inRange(value, PORT_PARALLEL_MIN, PORT_PARALLEL_MAX);

/** Keeps known values; anything else falls back to its default. A saved host is dropped. */
export function parsePortScannerSettings(value: unknown): PortScannerSettings {
  const settings = defaultPortScannerSettings();
  if (!value || typeof value !== "object") return settings;
  const saved = value as Partial<Record<keyof PortScannerSettings, unknown>>;
  if (saved.preset === "common" || saved.preset === "well-known" || saved.preset === "all" || saved.preset === "custom") {
    settings.preset = saved.preset;
  }
  if (typeof saved.custom === "string" && saved.custom.length <= 4096) settings.custom = saved.custom;
  if (isPortTimeout(saved.timeoutMs)) settings.timeoutMs = saved.timeoutMs;
  if (isPortParallel(saved.parallel)) settings.parallel = saved.parallel;
  return settings;
}

/**
 * `22, 80 443; 8000-8100` → merged inclusive ranges and the port count.
 * Null when a token is not a port or a range from 1 to 65535.
 */
export function parsePortList(text: string): { ranges: [number, number][]; count: number } | null {
  const tokens = text.split(/[\s,;]+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  const ranges: [number, number][] = [];
  for (const token of tokens) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/u.exec(token);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end > 65_535 || start > end) return null;
    ranges.push([start, end]);
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: [number, number][]): { ranges: [number, number][]; count: number } {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { ranges: merged, count: merged.reduce((sum, [start, end]) => sum + end - start + 1, 0) };
}

/** The ranges a preset scans; `custom` reads the typed list. */
export function presetPorts(preset: PortPreset, custom: string): { ranges: [number, number][]; count: number } | null {
  if (preset === "common") return mergeRanges(COMMON_PORTS.map((port) => [port, port]));
  if (preset === "well-known") return { ranges: [[1, 1024]], count: 1024 };
  if (preset === "all") return { ranges: [[1, 65_535]], count: 65_535 };
  const parsed = parsePortList(custom);
  return parsed && parsed.ranges.length <= MAX_PORT_RANGES ? parsed : null;
}

export interface PortResult {
  port: number;
  status: PortScanStatus;
  elapsedMs: number;
}

/** Plain-text report: target, summary, then one row per listed port in port order. */
export function formatPortReport(
  host: string,
  address: string,
  results: readonly PortResult[],
  counts: PortScanCounts,
): string {
  const header = [`${host} (${address})`, `scanned ${counts.done}: open ${counts.open}, closed ${counts.closed}, filtered ${counts.filtered}, other ${counts.other}`, ""];
  const rows = [...results].sort((a, b) => a.port - b.port).map((result) =>
    [String(result.port).padEnd(6), result.status.padEnd(12), (SERVICES[result.port] ?? "").padEnd(14), `${result.elapsedMs} ms`].join(" ").trimEnd());
  return [...header, "PORT   STATUS       SERVICE        TIME", ...rows].join("\n");
}
