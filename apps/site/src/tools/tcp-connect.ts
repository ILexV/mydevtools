/**
 * TCP connect settings and the text report. The timeout is a setting.
 * The host, the port and the result are not stored.
 */
import type { TcpConnectResult } from "@/scripts/local-agent";

export const TCP_CONNECT_STORAGE_KEY = "mdt.tcp-connect.v1";
export const TCP_TIMEOUT_MIN = 200;
export const TCP_TIMEOUT_MAX = 10_000;
export const TCP_TIMEOUT_DEFAULT = 3_000;

export interface TcpConnectSettings {
  v: 1;
  timeoutMs: number;
}

export function defaultTcpConnectSettings(): TcpConnectSettings {
  return { v: 1, timeoutMs: TCP_TIMEOUT_DEFAULT };
}

/** Keeps a timeout inside 200..=10000 ms. A saved host or port is dropped. */
export function parseTcpConnectSettings(value: unknown): TcpConnectSettings {
  if (!value || typeof value !== "object") return defaultTcpConnectSettings();
  const timeoutMs = (value as { timeoutMs?: unknown }).timeoutMs;
  if (!isTcpTimeout(timeoutMs)) return defaultTcpConnectSettings();
  return { v: 1, timeoutMs };
}

export function isTcpTimeout(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= TCP_TIMEOUT_MIN
    && value <= TCP_TIMEOUT_MAX;
}

/** One plain-text result: host, port, status, address, milliseconds. */
export function formatTcpText(result: TcpConnectResult): string {
  return `${result.host} ${result.port} ${result.status} ${result.address} ${result.elapsedMs}`;
}
