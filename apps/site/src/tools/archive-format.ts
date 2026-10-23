/**
 * Archive formats for the archive explorer: ZIP central directory (ZIP64, SFX offsets,
 * Info-ZIP Unicode paths) and TAR headers (ustar, GNU long names, pax), safe extraction
 * paths against path traversal (Zip Slip) and reserved names, compression-bomb guards, and
 * the ZIP/TAR writers used to create archives. Pure code: the worker supplies byte reads.
 */

export const ARCHIVE_MAX_ENTRIES = 1_000_000;
export const ARCHIVE_MAX_DIRECTORY_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_MAX_PATH_DEPTH = 64;
export const ARCHIVE_MAX_SEGMENT_BYTES = 255;
/** Output/input ratio that counts as a compression bomb once the output passes BOMB_MIN_BYTES. */
export const ARCHIVE_BOMB_RATIO = 1000;
export const ARCHIVE_BOMB_MIN_BYTES = 64 * 1024 * 1024;
/** Total bytes one extraction or one listing pass may produce. */
export const ARCHIVE_MAX_OUTPUT_BYTES = 64 * 1024 ** 3;
/** Longest GNU long name or pax header accepted. */
export const TAR_MAX_META_BYTES = 1024 * 1024;

export type ArchiveErrorCode =
  | "unsupported-format"
  | "corrupt"
  | "truncated"
  | "too-many-entries"
  | "encrypted"
  | "unsupported-method"
  | "overlap"
  | "bomb"
  | "size-mismatch"
  | "checksum"
  | "too-large"
  | "need-one"
  | "need-selection"
  | "session-missing";

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly detail: string;
  constructor(code: ArchiveErrorCode, message: string, detail = "") {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
    this.detail = detail;
  }
}

export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;
export type StreamCodec = "gzip" | "zstd" | "brotli";
export type EntryKind = "file" | "dir" | "symlink" | "hardlink" | "other";
/** Why an entry name is not extracted as is: unsafe names are skipped, renamed ones are adjusted. */
export type PathIssue = "absolute" | "traversal" | "control" | "too-long" | "empty" | "renamed";

export interface ArchiveEntry {
  /** Name as stored in the archive, decoded. */
  name: string;
  /** Relative path used for extraction; "" when the name is unsafe. */
  safePath: string;
  issue: PathIssue | null;
  kind: EntryKind;
  /** Uncompressed size, -1 when unknown. */
  size: number;
  /** Stored (compressed) size, -1 when unknown. */
  packed: number;
  /** Modification time in ms since the epoch, NaN when unknown. */
  mtime: number;
  /** ZIP method number; -1 for TAR. */
  method: number;
  encrypted: boolean;
  crc: number;
  /** ZIP: local header offset; TAR: data offset in the (decompressed) stream. */
  offset: number;
  /** ZIP: where the next entry starts; data past it overlaps another entry. */
  limit: number;
  /** ZIP: the declared data range overlaps another entry (a known zip-bomb trick). */
  overlap: boolean;
  link: string;
}

export type ArchiveDetection =
  | { kind: "zip" }
  | { kind: "tar" }
  | { kind: "stream"; codec: StreamCodec }
  | { kind: "unsupported"; format: string };

const td = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x1_0000_0000;

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((value, i) => bytes[at + i] === value);
}

const ZIP_EXTENSIONS = /\.(zip|jar|war|ear|apk|aar|xpi|crx|ipa|epub|odt|ods|odp|docx|xlsx|pptx|vsix|nupkg|whl|exe)$/iu;

/** Identifies the container from the first bytes (at least 512) and the file name. */
export function detectArchive(head: Uint8Array, name: string): ArchiveDetection {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || startsWith(head, [0x50, 0x4b, 0x07, 0x08])) {
    return { kind: "zip" };
  }
  if (startsWith(head, [0x1f, 0x8b])) return { kind: "stream", codec: "gzip" };
  if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return { kind: "stream", codec: "zstd" };
  if (head.length >= 512 && isTarHeader(head.subarray(0, 512))) return { kind: "tar" };
  if (startsWith(head, [0x42, 0x5a, 0x68])) return { kind: "unsupported", format: "bzip2" };
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { kind: "unsupported", format: "xz" };
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "unsupported", format: "7z" };
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { kind: "unsupported", format: "RAR" };
  if (startsWith(head, [0x04, 0x22, 0x4d, 0x18])) return { kind: "unsupported", format: "LZ4" };
  // Brotli has no magic number; trust the extension. SFX executables are ZIPs with a stub.
  if (/\.(br|tbr)$/iu.test(name)) return { kind: "stream", codec: "brotli" };
  if (ZIP_EXTENSIONS.test(name)) return { kind: "zip" };
  return { kind: "unsupported", format: "" };
}

/** Name of the file inside a single compressed stream: `x.tar.gz` → `x.tar`, `x.tgz` → `x.tar`. */
export function innerStreamName(name: string, codec: StreamCodec): string {
  const short = { gzip: /\.t(gz|az)$/iu, zstd: /\.tzst$/iu, brotli: /\.tbr$/iu }[codec];
  if (short.test(name)) return name.replace(short, ".tar");
  const long = { gzip: /\.(gz|gzip|z)$/iu, zstd: /\.(zst|zstd)$/iu, brotli: /\.br$/iu }[codec];
  const stripped = name.replace(long, "");
  return stripped && stripped !== name ? stripped : `${name}.out`;
}

// ---------------------------------------------------------------- safe paths

const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/iu;
const RESERVED_CHARS = /[<>:"|?*]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/**
 * Relative extraction path for an archive name (Zip Slip / path traversal protection).
 * Absolute paths, drive letters, `..` segments and control characters make the name unsafe;
 * characters and device names Windows refuses are replaced, which marks the entry renamed.
 */
export function sanitizeEntryPath(raw: string): { path: string; issue: PathIssue | null } {
  if (CONTROL_CHARS.test(raw)) return { path: "", issue: "control" };
  const unified = raw.replace(/\\/gu, "/");
  if (unified.startsWith("/") || /^[a-z]:/iu.test(unified)) return { path: "", issue: "absolute" };
  const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return { path: "", issue: "traversal" };
  if (segments.length === 0) return { path: "", issue: "empty" };
  if (segments.length > ARCHIVE_MAX_PATH_DEPTH) return { path: "", issue: "too-long" };
  const encoder = new TextEncoder();
  let renamed = false;
  const safe: string[] = [];
  for (const segment of segments) {
    let next = segment.replace(RESERVED_CHARS, "_").replace(/[. ]+$/u, "");
    if (next === "") next = "_";
    if (RESERVED_SEGMENT.test(next)) next = `_${next}`;
    if (encoder.encode(next).length > ARCHIVE_MAX_SEGMENT_BYTES) return { path: "", issue: "too-long" };
    if (next !== segment) renamed = true;
    safe.push(next);
  }
  return { path: safe.join("/"), issue: renamed ? "renamed" : null };
}

/** Makes `path` unique among `used` (case-insensitive) with a ` (2)` suffix before the extension. */
export function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/** Throws when the bytes produced so far look like a compression bomb. */
export function checkBombRatio(output: number, input: number): void {
  if (output > ARCHIVE_MAX_OUTPUT_BYTES) throw new ArchiveError("too-large", "The output is larger than the extraction limit");
  if (output > ARCHIVE_BOMB_MIN_BYTES && output > Math.max(1, input) * ARCHIVE_BOMB_RATIO) {
    throw new ArchiveError("bomb", "The data expands more than the compression-bomb limit");
  }
}

function entry(name: string, kind: EntryKind, fields: Partial<ArchiveEntry>): ArchiveEntry {
  const { path, issue } = sanitizeEntryPath(name);
  return {
    // "./" and "/" directory entries name the extraction root itself: nothing to create, nothing unsafe.
    name, safePath: path, issue: kind === "dir" && (issue === "empty" || (issue === "absolute" && /^\/+$/u.test(name))) ? null : issue, kind, size: -1, packed: -1, mtime: Number.NaN, method: -1, encrypted: false,
    crc: 0, offset: 0, limit: 0, overlap: false, link: "", ...fields,
  };
}

// ---------------------------------------------------------------- ZIP reading

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return out;
}

/** UTF-8 when flagged or valid; otherwise CP437 as APPNOTE says. */
function decodeZipName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return td(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeCp437(bytes);
  }
}

function dosTime(time: number, date: number): number {
  if (date === 0) return Number.NaN;
  const value = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
  return value.getTime();
}

function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipDirectory {
  entries: ArchiveEntry[];
  comment: string;
  zip64: boolean;
}

/** Reads the ZIP central directory: EOCD, ZIP64 records, a stub before the archive (SFX). */
export async function readZipDirectory(size: number, read: ReadRange): Promise<ZipDirectory> {
  const tailLength = Math.min(size, 22 + 0xffff + 20);
  const tail = await read(size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06 && i + 22 + u16(tail, i + 20) <= tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ArchiveError("corrupt", "No end of central directory record");
  const eocdOffset = size - tailLength + at;
  if (u16(tail, at + 4) !== 0 || u16(tail, at + 6) !== 0) throw new ArchiveError("unsupported-format", "Split archives are not supported", "split ZIP");
  let count = u16(tail, at + 10);
  let dirSize = u32(tail, at + 12);
  let dirOffset = u32(tail, at + 16);
  const comment = decodeZipName(tail.subarray(at + 22, at + 22 + u16(tail, at + 20)), false);
  let zip64 = false;
  let recordEnd = eocdOffset;
  if ((count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) && at >= 20 && u32(tail, at - 20) === 0x07064b50) {
    const recordOffset = u64(tail, at - 12);
    const record = await read(recordOffset, 56);
    if (record.length < 56 || u32(record, 0) !== 0x06064b50) throw new ArchiveError("corrupt", "Bad ZIP64 end record");
    count = u64(record, 32);
    dirSize = u64(record, 40);
    dirOffset = u64(record, 48);
    zip64 = true;
    recordEnd = recordOffset;
  }
  if (count > ARCHIVE_MAX_ENTRIES) throw new ArchiveError("too-many-entries", "Too many entries");
  if (dirSize > ARCHIVE_MAX_DIRECTORY_BYTES) throw new ArchiveError("too-many-entries", "The central directory is too large");
  // A self-extracting stub shifts every offset by its own length.
  const base = recordEnd - dirSize - dirOffset;
  if (base < 0) throw new ArchiveError("corrupt", "The central directory lies outside the file");
  const dirStart = dirOffset + base;
  const dir = await read(dirStart, dirSize);
  if (dir.length < dirSize) throw new ArchiveError("truncated", "The central directory is cut off");

  const entries: ArchiveEntry[] = [];
  let pos = 0;
  while (pos + 46 <= dir.length && u32(dir, pos) === 0x02014b50) {
    if (entries.length >= ARCHIVE_MAX_ENTRIES) throw new ArchiveError("too-many-entries", "Too many entries");
    const madeBy = u16(dir, pos + 4);
    const flags = u16(dir, pos + 8);
    const method = u16(dir, pos + 10);
    const nameLength = u16(dir, pos + 28);
    const extraLength = u16(dir, pos + 30);
    const commentLength = u16(dir, pos + 32);
    const external = u32(dir, pos + 38);
    let usize = u32(dir, pos + 24);
    let csize = u32(dir, pos + 20);
    let offset = u32(dir, pos + 42);
    const end = pos + 46 + nameLength + extraLength + commentLength;
    if (end > dir.length) throw new ArchiveError("corrupt", "A central directory entry is cut off");
    const rawName = dir.subarray(pos + 46, pos + 46 + nameLength);
    let name = decodeZipName(rawName, (flags & 0x800) !== 0);
    let mtime = dosTime(u16(dir, pos + 12), u16(dir, pos + 14));
    const extra = dir.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = u16(extra, e);
      const length = u16(extra, e + 2);
      const data = extra.subarray(e + 4, e + 4 + length);
      if (id === 0x0001) {
        let f = 0;
        if (usize === 0xffffffff && f + 8 <= data.length) { usize = u64(data, f); f += 8; }
        if (csize === 0xffffffff && f + 8 <= data.length) { csize = u64(data, f); f += 8; }
        if (offset === 0xffffffff && f + 8 <= data.length) { offset = u64(data, f); f += 8; }
      } else if (id === 0x5455 && data.length >= 5 && (data[0] & 1)) {
        mtime = u32(data, 1) * 1000;
      } else if (id === 0x7075 && data.length >= 5 && data[0] === 1) {
        // Info-ZIP Unicode Path: valid only while it matches the stored name's CRC.
        if (u32(data, 1) === crc32(rawName)) name = td(data.subarray(5));
      }
      e += 4 + length;
    }
    const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    const kind: EntryKind = name.endsWith("/") || fileType === 0o040000 || (((madeBy >> 8) === 0 || (madeBy >> 8) === 11) && (external & 0x10))
      ? "dir"
      : fileType === 0o120000 ? "symlink" : "file";
    entries.push(entry(name, kind, {
      size: usize,
      packed: csize,
      mtime,
      method,
      encrypted: (flags & 1) !== 0 || method === 99,
      crc: u32(dir, pos + 16),
      offset: offset + base,
    }));
    pos = end;
  }
  if (entries.length !== count && count !== 0xffff) {
    throw new ArchiveError("corrupt", `The central directory lists ${entries.length} of ${count} entries`);
  }
  markZipOverlaps(entries, dirStart);
  return { entries, comment, zip64 };
}

/** Sets each entry's limit to the next local header and flags shared or overlapping ranges. */
function markZipOverlaps(entries: ArchiveEntry[], dirStart: number): void {
  const order = entries.map((_, i) => i).sort((a, b) => entries[a].offset - entries[b].offset);
  for (let k = 0; k < order.length; k++) {
    const current = entries[order[k]];
    let next = k + 1;
    while (next < order.length && entries[order[next]].offset === current.offset) {
      entries[order[next]].overlap = true;
      current.overlap = true;
      next++;
    }
    current.limit = next < order.length ? entries[order[next]].offset : dirStart;
    if (current.offset + 30 + current.packed > current.limit || current.offset >= dirStart) current.overlap = true;
  }
}

/** Start of an entry's data after its local header; refuses data that runs into another entry. */
export async function zipDataStart(item: ArchiveEntry, read: ReadRange): Promise<number> {
  const header = await read(item.offset, 30);
  if (header.length < 30 || u32(header, 0) !== 0x04034b50) throw new ArchiveError("corrupt", "Bad local file header");
  const start = item.offset + 30 + u16(header, 26) + u16(header, 28);
  if (item.overlap || start + item.packed > item.limit) throw new ArchiveError("overlap", "The entry overlaps another entry");
  return start;
}

/** ZIP methods this tool can extract, mapped to a decoder codec ("" = stored). */
export function zipMethodCodec(method: number): "" | "deflate" | "zstd" | null {
  if (method === 0) return "";
  if (method === 8) return "deflate";
  if (method === 93) return "zstd";
  return null;
}

export const ZIP_METHOD_NAMES: Readonly<Record<number, string>> = {
  0: "Stored", 1: "Shrink", 6: "Implode", 8: "Deflate", 9: "Deflate64", 12: "BZIP2", 14: "LZMA",
  93: "Zstandard", 95: "XZ", 98: "PPMd", 99: "AES",
};

// ---------------------------------------------------------------- TAR reading

function tarString(block: Uint8Array, start: number, length: number): Uint8Array {
  const field = block.subarray(start, start + length);
  const zero = field.indexOf(0);
  return zero < 0 ? field : field.subarray(0, zero);
}

/** Octal field, or GNU base-256 when the high bit of the first byte is set. */
function tarNumber(block: Uint8Array, start: number, length: number): number {
  if (block[start] & 0x80) {
    let value = block[start] & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + block[start + i];
    return value;
  }
  const text = td(tarString(block, start, length)).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) return Number.NaN;
  return Number.parseInt(text, 8);
}

/** True when the 512-byte block is a TAR header with a valid checksum. */
export function isTarHeader(block: Uint8Array): boolean {
  if (block.length < 512) return false;
  let sum = 0;
  let signedSum = 0;
  let nonZero = false;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    if (block[i] !== 0) nonZero = true;
    sum += byte;
    signedSum += byte > 127 ? byte - 256 : byte;
  }
  if (!nonZero) return false;
  const stored = tarNumber(block, 148, 8);
  return stored === sum || stored === signedSum;
}

function parsePax(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const length = Number.parseInt(td(data.subarray(pos, space)), 10);
    if (!Number.isFinite(length) || length <= 0 || pos + length > data.length) break;
    const record = td(data.subarray(space + 1, pos + length - 1));
    const eq = record.indexOf("=");
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    pos += length;
  }
  return records;
}

export interface TarHandlers {
  /** A header; return true to receive its data. */
  entry(item: ArchiveEntry, index: number): boolean | Promise<boolean>;
  /** Data of a wanted entry; `bytes` is a view into the pushed chunk, valid during the call. */
  data?(bytes: Uint8Array, index: number): Promise<void> | void;
  /** All data of a wanted entry was delivered. */
  end?(index: number): Promise<void> | void;
}

/**
 * Streaming TAR reader. `push` takes the archive bytes in any chunking, `finish` checks
 * the end. Meta entries (GNU L/K, pax x/g) are folded into the next real entry.
 */
export class TarReader {
  private readonly handlers: TarHandlers;
  private readonly header = new Uint8Array(512);
  private headerFill = 0;
  private position = 0;
  private remaining = 0;
  private padding = 0;
  private meta: Uint8Array | null = null;
  private metaFill = 0;
  private metaType = "";
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax = new Map<string, string>();
  private wanted = false;
  private zeroBlocks = 0;
  private index = -1;
  ended = false;
  count = 0;

  constructor(handlers: TarHandlers) {
    this.handlers = handlers;
  }

  /** Bytes consumed so far (the stream offset of the next byte). */
  get offset(): number {
    return this.position;
  }

  async push(chunk: Uint8Array): Promise<void> {
    let pos = 0;
    while (pos < chunk.length && !this.ended) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - pos);
        const part = chunk.subarray(pos, pos + take);
        if (this.meta) {
          this.meta.set(part, this.metaFill);
          this.metaFill += take;
        } else if (this.wanted && this.handlers.data) {
          await this.handlers.data(part, this.index);
        }
        pos += take;
        this.position += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          if (this.meta) this.finishMeta();
          else if (this.wanted) await this.endEntry();
        }
        continue;
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, chunk.length - pos);
        pos += take;
        this.position += take;
        this.padding -= take;
        continue;
      }
      const take = Math.min(512 - this.headerFill, chunk.length - pos);
      this.header.set(chunk.subarray(pos, pos + take), this.headerFill);
      this.headerFill += take;
      pos += take;
      this.position += take;
      if (this.headerFill === 512) {
        this.headerFill = 0;
        await this.readHeader();
      }
    }
  }

  /** Throws when the stream stopped inside an entry. A missing end marker is tolerated. */
  finish(): void {
    if (this.ended) return;
    if (this.remaining > 0 || this.headerFill > 0 || this.meta) throw new ArchiveError("truncated", "The TAR archive ends inside an entry");
  }

  private async endEntry(): Promise<void> {
    this.wanted = false;
    await this.handlers.end?.(this.index);
  }

  private async readHeader(): Promise<void> {
    const block = this.header;
    if (block.every((byte) => byte === 0)) {
      this.zeroBlocks++;
      if (this.zeroBlocks >= 2) this.ended = true;
      return;
    }
    this.zeroBlocks = 0;
    if (!isTarHeader(block)) throw new ArchiveError("corrupt", `Bad TAR header at byte ${this.position - 512}`);
    const size = tarNumber(block, 124, 12);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError("corrupt", "Bad TAR entry size");
    const type = String.fromCharCode(block[156] || 0x30);
    const padded = Math.ceil(size / 512) * 512;
    if (type === "L" || type === "K" || type === "x" || type === "g") {
      if (size > TAR_MAX_META_BYTES) throw new ArchiveError("corrupt", "A TAR meta header is too large");
      this.metaType = type;
      this.meta = new Uint8Array(size);
      this.metaFill = 0;
      this.remaining = size;
      this.padding = padded - size;
      if (size === 0) this.finishMeta();
      return;
    }
    const ustar = block[257] === 0x75 && block[262] === 0 && td(block.subarray(257, 262)) === "ustar";
    const prefix = ustar ? td(tarString(block, 345, 155)) : "";
    const baseName = td(tarString(block, 0, 100));
    const name = this.pax.get("path") ?? this.longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    const link = this.pax.get("linkpath") ?? this.longLink ?? td(tarString(block, 157, 100));
    const paxSize = this.pax.has("size") ? Number(this.pax.get("size")) : size;
    const paxTime = this.pax.has("mtime") ? Number(this.pax.get("mtime")) : tarNumber(block, 136, 12);
    const dataSize = Number.isFinite(paxSize) && paxSize >= 0 ? paxSize : size;
    const kind: EntryKind = type === "0" || type === "7" ? "file"
      : type === "5" ? "dir" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "other";
    this.longName = null;
    this.longLink = null;
    this.pax = new Map();
    if (this.count >= ARCHIVE_MAX_ENTRIES) throw new ArchiveError("too-many-entries", "Too many entries");
    this.index = this.count++;
    const item = entry(kind === "dir" && !name.endsWith("/") ? `${name}/` : name, kind, {
      size: kind === "file" ? dataSize : 0,
      packed: dataSize,
      mtime: Number.isFinite(paxTime) ? paxTime * 1000 : Number.NaN,
      offset: this.position,
      link,
    });
    // Links and specials carry no data even when a size is set (hardlinks in some writers).
    const carries = kind === "file" || kind === "other" ? dataSize : 0;
    this.remaining = carries;
    this.padding = Math.ceil(carries / 512) * 512 - carries;
    this.wanted = (await this.handlers.entry(item, this.index)) && kind === "file";
    if (this.wanted && carries === 0) await this.endEntry();
  }

  private finishMeta(): void {
    const data = this.meta!.subarray(0, this.metaFill);
    if (this.metaType === "L") this.longName = td(tarString(data, 0, data.length));
    else if (this.metaType === "K") this.longLink = td(tarString(data, 0, data.length));
    else if (this.metaType === "x") this.pax = parsePax(data);
    this.meta = null;
  }
}

// ---------------------------------------------------------------- CRC-32 (small inputs)

let crcTable: Uint32Array | null = null;

/** Table CRC-32 for names and tests; file data goes through the WASM hasher. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- ZIP writing

class ByteWriter {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos = 0;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(value: number): this { this.view.setUint16(this.pos, value, true); this.pos += 2; return this; }
  u32(value: number): this { this.view.setUint32(this.pos, value >>> 0, true); this.pos += 4; return this; }
  u64(value: number): this { this.u32(value % 0x1_0000_0000); return this.u32(Math.floor(value / 0x1_0000_0000)); }
  raw(data: Uint8Array): this { this.bytes.set(data, this.pos); this.pos += data.length; return this; }
}

/** Entries at or above this size get ZIP64 records; deflate may grow stored data slightly. */
export const ZIP64_THRESHOLD = 0xffff0000;
const UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

export interface ZipWriteEntry {
  name: Uint8Array;
  mtime: number;
  method: 0 | 8;
  zip64: boolean;
  offset: number;
  crc: number;
  packed: number;
  size: number;
}

/** Local header with a data descriptor to follow (flag 3), UTF-8 names (flag 11). */
export function zipLocalHeader(item: Pick<ZipWriteEntry, "name" | "mtime" | "method" | "zip64">): Uint8Array {
  const { time, date } = dosStamp(item.mtime);
  const out = new ByteWriter(30 + item.name.length + (item.zip64 ? 20 : 0));
  out.u32(0x04034b50).u16(item.zip64 ? 45 : 20).u16(0x0808).u16(item.method).u16(time).u16(date).u32(0);
  out.u32(item.zip64 ? 0xffffffff : 0).u32(item.zip64 ? 0xffffffff : 0).u16(item.name.length).u16(item.zip64 ? 20 : 0).raw(item.name);
  if (item.zip64) out.u16(0x0001).u16(16).u64(0).u64(0);
  return out.bytes;
}

export function zipDataDescriptor(item: Pick<ZipWriteEntry, "crc" | "packed" | "size" | "zip64">): Uint8Array {
  const out = new ByteWriter(item.zip64 ? 24 : 16);
  out.u32(0x08074b50).u32(item.crc);
  if (item.zip64) out.u64(item.packed).u64(item.size);
  else out.u32(item.packed).u32(item.size);
  return out.bytes;
}

export function zipCentralHeader(item: ZipWriteEntry): Uint8Array {
  const { time, date } = dosStamp(item.mtime);
  const big = [item.size >= 0xffffffff || item.zip64, item.packed >= 0xffffffff || item.zip64, item.offset >= 0xffffffff];
  const extra = big.filter(Boolean).length * 8;
  const out = new ByteWriter(46 + item.name.length + (extra ? 4 + extra : 0));
  out.u32(0x02014b50).u16(0x031e).u16(extra ? 45 : 20).u16(0x0808).u16(item.method).u16(time).u16(date).u32(item.crc);
  out.u32(big[1] ? 0xffffffff : item.packed).u32(big[0] ? 0xffffffff : item.size);
  out.u16(item.name.length).u16(extra ? 4 + extra : 0).u16(0).u16(0).u16(0).u32(UNIX_FILE_ATTRIBUTES);
  out.u32(big[2] ? 0xffffffff : item.offset).raw(item.name);
  if (extra) {
    out.u16(0x0001).u16(extra);
    if (big[0]) out.u64(item.size);
    if (big[1]) out.u64(item.packed);
    if (big[2]) out.u64(item.offset);
  }
  return out.bytes;
}

/** End records; adds the ZIP64 end record and locator when counts or offsets overflow. */
export function zipEnd(count: number, dirOffset: number, dirSize: number): Uint8Array {
  const zip64 = count >= 0xffff || dirOffset >= 0xffffffff || dirSize >= 0xffffffff;
  const out = new ByteWriter((zip64 ? 56 + 20 : 0) + 22);
  if (zip64) {
    const recordOffset = dirOffset + dirSize;
    out.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(dirSize).u64(dirOffset);
    out.u32(0x07064b50).u32(0).u64(recordOffset).u32(1);
  }
  out.u32(0x06054b50).u16(0).u16(0).u16(Math.min(count, 0xffff)).u16(Math.min(count, 0xffff));
  out.u32(Math.min(dirSize, 0xffffffff)).u32(Math.min(dirOffset, 0xffffffff)).u16(0);
  return out.bytes;
}

/**
 * In-memory stored (uncompressed) ZIP of already compressed files — PDF parts,
 * JPEG/PNG/WebP outputs — for a "download all" button. `crc` may be passed
 * when the caller already has it.
 */
export function storedZip(files: readonly { name: string; bytes: Uint8Array; crc?: number }[], mtime = Date.now()): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const entry: ZipWriteEntry = {
      name: new TextEncoder().encode(file.name),
      mtime,
      method: 0,
      zip64: file.bytes.length >= ZIP64_THRESHOLD,
      offset,
      crc: file.crc ?? crc32(file.bytes),
      packed: file.bytes.length,
      size: file.bytes.length,
    };
    const local = zipLocalHeader(entry);
    const descriptor = zipDataDescriptor(entry);
    parts.push(local, file.bytes, descriptor);
    offset += local.length + file.bytes.length + descriptor.length;
    central.push(zipCentralHeader(entry));
  }
  const dirSize = central.reduce((sum, c) => sum + c.length, 0);
  return new Blob([...parts, ...central, zipEnd(files.length, offset, dirSize)] as BlobPart[], { type: "application/zip" });
}

// ---------------------------------------------------------------- TAR writing

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0");
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = new TextEncoder().encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
}

function tarBlock(name: Uint8Array, prefix: Uint8Array, size: number, mtimeMs: number, type: string): Uint8Array {
  const block = new Uint8Array(512);
  const ascii = (text: string, at: number) => block.set(new TextEncoder().encode(text), at);
  block.set(name.subarray(0, 100), 0);
  ascii(octal(type === "5" ? 0o755 : 0o644, 8), 100);
  ascii(octal(0, 8), 108);
  ascii(octal(0, 8), 116);
  if (size < 0o77777777777) {
    ascii(octal(size, 12), 124);
  } else {
    // GNU base-256 for sizes of 8 GiB and more; pax "size" carries it too.
    let value = size;
    for (let i = 135; i > 124; i--) { block[i] = value % 256; value = Math.floor(value / 256); }
    block[124] = 0x80;
  }
  ascii(octal(Math.max(0, Math.floor(mtimeMs / 1000)), 12), 136);
  block[156] = type.charCodeAt(0);
  ascii("ustar\u000000", 257);
  block.set(prefix.subarray(0, 155), 345);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  ascii(`${octal(sum, 7)}\u0000 `, 148);
  return block;
}

/** Header blocks for one TAR member: a pax header first when the name or size needs one. */
export function tarHeader(path: string, size: number, mtimeMs: number, type: "0" | "5" = "0"): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(path);
  let name = bytes;
  let prefix = new Uint8Array(0);
  let needsPax = size >= 0o77777777777 || /[^\x20-\x7e]/u.test(path);
  if (bytes.length > 100) {
    const split = path.lastIndexOf("/", path.length - 2);
    const head = split > 0 ? encoder.encode(path.slice(0, split)) : null;
    const tail = split > 0 ? encoder.encode(path.slice(split + 1)) : null;
    if (head && tail && head.length <= 155 && tail.length <= 100) {
      prefix = head;
      name = tail;
    } else {
      needsPax = true;
      name = encoder.encode(path.slice(-99).replace(/^[^/]*\//u, "")).subarray(0, 100);
    }
  }
  const header = tarBlock(name, prefix, size, mtimeMs, type);
  if (!needsPax) return header;
  let records = paxRecord("path", path);
  if (size >= 0o77777777777) records += paxRecord("size", String(size));
  const data = encoder.encode(records);
  const padded = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(512 + padded + 512);
  out.set(tarBlock(encoder.encode("PaxHeader"), new Uint8Array(0), data.length, mtimeMs, "x"), 0);
  out.set(data, 512);
  out.set(header, 512 + padded);
  return out;
}

/** Zero padding after `size` data bytes. */
export function tarPadding(size: number): Uint8Array {
  return new Uint8Array((512 - (size % 512)) % 512);
}

/** Two zero blocks, then padding to a 10 KiB record as GNU tar writes it. */
export function tarEnd(written: number): Uint8Array {
  const total = written + 1024;
  return new Uint8Array(1024 + ((10240 - (total % 10240)) % 10240));
}
