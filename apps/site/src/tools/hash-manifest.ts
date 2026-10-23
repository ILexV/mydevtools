/**
 * Checksum manifest support for the Hash Calculator (DOM-free; unit-tested in
 * test/hash-manifest.test.ts): parse SHA256SUMS / *.sha256 / md5sum output
 * (GNU `digest  name`, `digest *name`, escaped `\` lines) and BSD tagged lines
 * (`SHA256 (name) = digest`), then verify computed file digests against it —
 * release artifacts and distribution images checked by file name.
 * The algorithm comes from the BSD tag or the manifest file name
 * (`SHA512SUMS`, `app.sha256`); otherwise any selected algorithm whose digest
 * has the same length may match, and the matching one is reported.
 */

export interface ManifestEntry {
  /** 1-based line number in the manifest. */
  line: number;
  /** File name as written (may include a directory). */
  path: string;
  /** Lower-case hex digest. */
  hex: string;
  /** Hash Calculator algorithm id when the manifest names it, else null. */
  algo: string | null;
}

export interface Manifest {
  entries: ManifestEntry[];
  /** Line numbers that are neither checksum lines, comments nor blank. */
  invalidLines: number[];
}

/** BSD tag (upper-cased, without `-`) → algorithm id. */
const BSD_TAGS: Record<string, string> = {
  MD5: "md5",
  SHA1: "sha1",
  SHA224: "sha224",
  SHA256: "sha256",
  SHA384: "sha384",
  SHA512: "sha512",
  "SHA512/224": "sha512-224",
  "SHA512/256": "sha512-256",
  SHA3224: "sha3-224",
  SHA3256: "sha3-256",
  SHA3384: "sha3-384",
  SHA3512: "sha3-512",
  BLAKE2B: "blake2b",
  BLAKE2B512: "blake2b",
  BLAKE2S: "blake2s",
  BLAKE2S256: "blake2s",
  BLAKE3: "blake3",
  RMD160: "ripemd160",
  RIPEMD160: "ripemd160",
};

/** Hex length of the algorithms a manifest name or BSD tag can imply. */
const HEX_LENGTH: Record<string, number> = {
  md5: 32,
  sha1: 40,
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
  "sha512-224": 56,
  "sha512-256": 64,
  "sha3-224": 56,
  "sha3-256": 64,
  "sha3-384": 96,
  "sha3-512": 128,
  blake2b: 128,
  blake2s: 64,
  blake3: 64,
  ripemd160: 40,
};

/** Most common algorithm per digest length, auto-selected for untagged manifests. */
const COMMON_BY_LENGTH: Record<number, string> = { 32: "md5", 40: "sha1", 56: "sha224", 64: "sha256", 96: "sha384", 128: "sha512" };

/** Algorithm implied by a manifest file name: `SHA256SUMS`, `app.sha512`, `CHECKSUMS.md5`, `file.b3`. */
export function algoFromManifestName(name: string): string | null {
  const lower = name.toLowerCase();
  const sha = /sha-?(1|224|256|384|512)(?![0-9])/.exec(lower);
  if (sha) return `sha${sha[1]}`;
  if (/md5/.test(lower)) return "md5";
  if (/blake3|\.b3$|b3sums/.test(lower)) return "blake3";
  return null;
}

function unescapeGnuName(name: string): string {
  return name.replace(/\\(\\|n|r)/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : "\\"));
}

/**
 * Parse a checksum list. GNU lines may start with `\` (escaped name); the
 * separator is two spaces or ` *` (binary mode). Comments (`#`) and blank
 * lines are skipped; anything else is reported in `invalidLines`.
 */
export function parseManifest(text: string, manifestName = ""): Manifest {
  const hinted = algoFromManifestName(manifestName);
  const entries: ManifestEntry[] = [];
  const invalidLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^﻿/, "").trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const bsd = /^([A-Za-z0-9/-]+) ?\((.+)\) ?= ?([0-9a-fA-F]+)$/.exec(line);
    if (bsd) {
      const algo = BSD_TAGS[bsd[1].toUpperCase().replace(/-/g, "")] ?? null;
      entries.push({ line: i + 1, path: bsd[2], hex: bsd[3].toLowerCase(), algo });
      return;
    }
    const gnu = /^(\\?)([0-9a-fA-F]{8,}) [ *](.+)$/.exec(line);
    if (gnu) {
      const hex = gnu[2].toLowerCase();
      const path = gnu[1] ? unescapeGnuName(gnu[3]) : gnu[3];
      entries.push({ line: i + 1, path, hex, algo: hinted && HEX_LENGTH[hinted] === hex.length ? hinted : null });
      return;
    }
    invalidLines.push(i + 1);
  });
  return { entries, invalidLines };
}

/** File name without directories or a leading `./`. */
export function baseName(path: string): string {
  return path.replace(/^\.\//, "").split(/[\\/]/).pop() ?? path;
}

/**
 * Algorithms to select so every entry can be checked: the named algorithm,
 * or for untagged entries the most common one of that digest length — only
 * when no selected algorithm already yields that length (by `HEX_LENGTH`).
 */
export function algorithmsToSelect(manifest: Manifest, selected: readonly string[]): string[] {
  const add = new Set<string>();
  const selectedLengths = new Set(selected.map((id) => HEX_LENGTH[id]).filter((n) => n !== undefined));
  for (const e of manifest.entries) {
    if (e.algo) {
      if (!selected.includes(e.algo)) add.add(e.algo);
    } else if (!selectedLengths.has(e.hex.length) && COMMON_BY_LENGTH[e.hex.length]) {
      add.add(COMMON_BY_LENGTH[e.hex.length]);
    }
  }
  return [...add];
}

export type ManifestStatus = "ok" | "failed" | "missing" | "pending" | "error" | "no-algorithm";

export interface ManifestGroup {
  source: "text" | "file";
  name: string | null;
  status: "ready" | "hashing" | "done" | "error" | "canceled";
  hashes: readonly { id: string; hex: string }[];
}

export interface ManifestRow {
  entry: ManifestEntry;
  status: ManifestStatus;
  /** Index of the selected file this entry refers to, or null when missing. */
  groupIndex: number | null;
  /** Algorithm that matched (ok) or was compared (failed). */
  algo: string | null;
}

export interface ManifestReport {
  rows: ManifestRow[];
  /** Indexes of selected files that no manifest entry names. */
  unlisted: number[];
  counts: Record<ManifestStatus, number>;
}

/** Compare computed digests with the manifest; files are matched by base name (exact, then case-insensitive). */
export function verifyManifest(manifest: Manifest, groups: readonly ManifestGroup[]): ManifestReport {
  const files = groups.map((g, i) => ({ g, i })).filter(({ g }) => g.source === "file" && g.name !== null);
  const used = new Set<number>();
  const counts: Record<ManifestStatus, number> = { ok: 0, failed: 0, missing: 0, pending: 0, error: 0, "no-algorithm": 0 };
  const rows = manifest.entries.map((entry): ManifestRow => {
    const name = baseName(entry.path);
    const hit = files.find(({ g }) => g.name === name) ?? files.find(({ g }) => g.name?.toLowerCase() === name.toLowerCase());
    let row: ManifestRow;
    if (!hit) row = { entry, status: "missing", groupIndex: null, algo: entry.algo };
    else {
      used.add(hit.i);
      const g = hit.g;
      if (g.status === "error" || g.status === "canceled") row = { entry, status: "error", groupIndex: hit.i, algo: entry.algo };
      else if (g.status !== "done") row = { entry, status: "pending", groupIndex: hit.i, algo: entry.algo };
      else {
        const candidates = entry.algo
          ? g.hashes.filter((h) => h.id === entry.algo)
          : g.hashes.filter((h) => h.hex.trim().length === entry.hex.length);
        const match = candidates.find((h) => h.hex.trim().toLowerCase() === entry.hex);
        row = candidates.length === 0
          ? { entry, status: "no-algorithm", groupIndex: hit.i, algo: entry.algo }
          : { entry, status: match ? "ok" : "failed", groupIndex: hit.i, algo: (match ?? candidates[0]).id };
      }
    }
    counts[row.status]++;
    return row;
  });
  const unlisted = files.filter(({ i }) => !used.has(i)).map(({ i }) => i);
  return { rows, unlisted, counts };
}
