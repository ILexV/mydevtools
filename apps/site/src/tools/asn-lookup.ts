/**
 * ASN lookup text and the address check. The query and the result are not
 * stored. There is no timeout setting: the agent reads a local prefix table.
 */
import type { AsnLookupResult } from "@/scripts/local-agent";

/** One plain-text result: query, address, prefix, ASN, name, status, covers. */
export function formatAsnText(result: AsnLookupResult): string {
  return [
    result.query,
    result.address,
    result.prefix ?? "",
    result.asn ?? "",
    result.name,
    result.status,
    result.covers,
  ].join(" ");
}

/**
 * One IPv4 or IPv6 address, or one CIDR. A name, a URL, a dash range, a zone
 * and a list are rejected before the page asks the agent.
 */
export function asnQueryLooksValid(query: string): boolean {
  const chars = [...query];
  if (chars.length < 1 || chars.length > 128) return false;
  if (!/^[\x21-\x7e]+$/.test(query)) return false;
  if (query.includes("://") || query.includes(",") || query.includes("-") || query.includes("%")) return false;
  if (query.split("/").length > 2) return false;
  const slash = query.indexOf("/");
  const addr = slash === -1 ? query : query.slice(0, slash);
  const prefix = slash === -1 ? null : query.slice(slash + 1);
  if (!addr) return false;
  if (prefix !== null && !prefixLooksValid(prefix, addr.includes(":"))) return false;
  if (addr.includes(":")) return ipv6LooksValid(addr);
  return ipv4LooksValid(addr);
}

function prefixLooksValid(prefix: string, v6: boolean): boolean {
  if (!/^\d{1,3}$/.test(prefix) || (prefix.length > 1 && prefix.startsWith("0"))) return false;
  const value = Number(prefix);
  return value <= (v6 ? 128 : 32);
}

function ipv4LooksValid(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return false;
    return Number(part) <= 255;
  });
}

function ipv6LooksValid(input: string): boolean {
  let text = input;
  let v4 = false;
  const dot = text.lastIndexOf(".");
  if (dot !== -1) {
    const colon = text.lastIndexOf(":");
    if (colon === -1 || colon > dot) return false;
    if (!ipv4LooksValid(text.slice(colon + 1))) return false;
    text = text.slice(0, colon);
    v4 = true;
  }
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;
  const side = (value: string): string[] | null => {
    if (value === "") return [];
    const parts = value.split(":");
    if (parts.some((part) => part === "")) return null;
    return parts;
  };
  const left = side(halves[0] ?? "");
  const right = compressed ? side(halves[1] ?? "") : [];
  if (!left || !right) return false;
  const count = left.length + right.length + (v4 ? 2 : 0);
  if (compressed ? count >= 8 : count !== 8) return false;
  return [...left, ...right].every((part) => /^[0-9a-fA-F]{1,4}$/.test(part));
}
