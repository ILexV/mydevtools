/// <reference lib="webworker" />
/**
 * Archive explorer worker. Lists ZIP, TAR and gzip/Zstandard/Brotli-compressed TAR or single
 * files, filters and selects entries, extracts the selection to one file, a new ZIP or a
 * chosen folder, and creates ZIP/TAR archives. Decompression is bounded per read, sizes and
 * CRCs are checked, and unsafe names, links and overlapping entries are never written.
 */
import init, { Crc32, Decoder, Encoder } from "@/generated/wasm/compression/compression.js";
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import {
  ARCHIVE_BOMB_MIN_BYTES,
  ARCHIVE_BOMB_RATIO,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_OUTPUT_BYTES,
  ArchiveError,
  TarReader,
  ZIP64_THRESHOLD,
  checkBombRatio,
  detectArchive,
  innerStreamName,
  isTarHeader,
  readZipDirectory,
  sanitizeEntryPath,
  tarEnd,
  tarHeader,
  tarPadding,
  uniquePath,
  zipCentralHeader,
  zipDataDescriptor,
  zipDataStart,
  zipEnd,
  zipLocalHeader,
  zipMethodCodec,
  type ArchiveEntry,
  type ReadRange,
  type StreamCodec,
  type ZipWriteEntry,
} from "@/tools/archive-format";
import type {
  ArchiveContainer,
  ArchiveCreateFormat,
  ArchiveRequest,
  ArchiveRow,
  ArchiveSuccess,
  ArchiveSummary,
  ArchiveWorkerMessage,
  ExtractSummary,
  ExtractTarget,
  SelectAction,
  SelectionSummary,
} from "@/tools/archive-explorer-protocol";

interface Session {
  id: number;
  file: File;
  container: ArchiveContainer;
  codec: StreamCodec | null;
  single: boolean;
  entries: ArchiveEntry[];
  view: Uint32Array | null;
  selected: Uint8Array;
}

const CHUNK = 1024 * 1024;
const MAX_ROWS = 500;
const PEEK_BYTES = 64 * 1024;
const LIMIT_CODES = new Set(["too-many-entries", "bomb", "too-large"]);

let session: Session | null = null;
let nextSessionId = 1;
let wasm: Promise<unknown> | null = null;

function ready(): Promise<unknown> {
  if (!wasm) {
    wasm = init().catch((error: unknown) => {
      wasm = null;
      throw error;
    });
  }
  return wasm;
}

function post(message: ArchiveWorkerMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(id: number, processed: number, total: number, started: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

/** Rate-limited progress for loops that run per chunk. */
function progressTicker(id: number, total: number) {
  const started = performance.now();
  let last = 0;
  return (processed: number, force = false) => {
    const now = performance.now();
    if (!force && now - last < 100) return;
    last = now;
    progress(id, processed, total, started);
  };
}

function reader(file: Blob): ReadRange {
  return async (offset, length) => new Uint8Array(await file.slice(offset, offset + Math.max(0, length)).arrayBuffer());
}

/** WASM codec errors arrive as "code: message". */
function codecError(error: unknown): unknown {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const match = /^(corrupt|truncated|checksum|invalid):\s*(.*)$/u.exec(text);
  if (!match) return error;
  const code = match[1] === "invalid" ? "corrupt" : match[1] as "corrupt" | "truncated" | "checksum";
  return new ArchiveError(code, match[2]);
}

/**
 * Decodes `length` compressed bytes from `offset` and hands bounded output windows to `sink`.
 * `onInput` sees the compressed bytes consumed so far (for progress and bomb ratios).
 */
async function decodeRange(
  read: ReadRange,
  offset: number,
  length: number,
  codec: string,
  sink: (bytes: Uint8Array) => Promise<void> | void,
  onInput?: (consumed: number) => void,
): Promise<void> {
  await ready();
  const decoder = new Decoder(codec);
  try {
    const drain = async () => {
      for (;;) {
        const out = decoder.read(CHUNK);
        if (out.length === 0) return;
        await sink(out);
      }
    };
    for (let pos = 0; pos < length && !decoder.is_finished();) {
      const take = Math.min(CHUNK, length - pos);
      const chunk = await read(offset + pos, take);
      if (chunk.length < take) throw new ArchiveError("truncated", "The file ends early");
      decoder.write(chunk);
      pos += take;
      await drain();
      onInput?.(pos);
    }
    if (!decoder.is_finished()) {
      decoder.end();
      await drain();
    }
  } catch (error) {
    throw codecError(error);
  } finally {
    decoder.free();
  }
}

async function copyRange(read: ReadRange, offset: number, length: number, sink: (bytes: Uint8Array) => Promise<void> | void): Promise<void> {
  for (let pos = 0; pos < length;) {
    const take = Math.min(CHUNK, length - pos);
    const chunk = await read(offset + pos, take);
    if (chunk.length < take) throw new ArchiveError("truncated", "The file ends early");
    await sink(chunk);
    pos += take;
  }
}

/** First decompressed bytes of a stream, enough to recognize a TAR header. */
async function peekStream(file: File, codec: StreamCodec): Promise<{ head: Uint8Array; name: string | null }> {
  await ready();
  const decoder = new Decoder(codec);
  const parts: Uint8Array[] = [];
  let have = 0;
  try {
    for (let pos = 0; pos < file.size && have < 512 && !decoder.is_finished();) {
      const chunk = new Uint8Array(await file.slice(pos, pos + PEEK_BYTES).arrayBuffer());
      decoder.write(chunk);
      pos += chunk.length;
      if (pos >= file.size) decoder.end();
      for (let out = decoder.read(4096); out.length > 0 && have < 512; out = decoder.read(4096)) {
        parts.push(out);
        have += out.length;
      }
    }
    const head = new Uint8Array(have);
    let at = 0;
    for (const part of parts) { head.set(part, at); at += part.length; }
    return { head, name: decoder.gzip_name() ?? null };
  } catch (error) {
    throw codecError(error);
  } finally {
    decoder.free();
  }
}

function isUnsupported(current: Session, item: ArchiveEntry): boolean {
  return current.container === "zip" && item.kind === "file" && zipMethodCodec(item.method) === null;
}

function summarize(current: Session, zip64: boolean, comment: string, streamSize: number): ArchiveSummary {
  const summary: ArchiveSummary = {
    sessionId: current.id, container: current.container, codec: current.codec, single: current.single,
    entries: current.entries.length, files: 0, dirs: 0, links: 0, totalSize: 0, streamSize, unsafe: 0, renamed: 0,
    encrypted: 0, unsupported: 0, overlap: 0, suspicious: 0, zip64, comment,
  };
  for (const item of current.entries) {
    if (item.kind === "file") {
      summary.files++;
      if (item.size > 0) summary.totalSize += item.size;
    } else if (item.kind === "dir") summary.dirs++;
    else summary.links++;
    if (item.issue === "renamed") summary.renamed++;
    else if (item.issue) summary.unsafe++;
    if (item.encrypted) summary.encrypted++;
    if (isUnsupported(current, item)) summary.unsupported++;
    if (item.overlap) summary.overlap++;
    if (current.container === "zip" && item.size > ARCHIVE_BOMB_MIN_BYTES && item.size > Math.max(1, item.packed) * ARCHIVE_BOMB_RATIO) summary.suspicious++;
  }
  return summary;
}

async function open(id: number, file: File): Promise<ArchiveSummary> {
  session = null;
  const read = reader(file);
  const head = await read(0, 4096);
  const detected = detectArchive(head, file.name);
  if (detected.kind === "unsupported") throw new ArchiveError("unsupported-format", "Unknown archive format", detected.format);
  const make = (container: ArchiveContainer, codec: StreamCodec | null, single: boolean, entries: ArchiveEntry[]): Session => ({
    id: nextSessionId++, file, container, codec, single, entries, view: null, selected: new Uint8Array(entries.length),
  });
  if (detected.kind === "zip") {
    const directory = await readZipDirectory(file.size, read);
    session = make("zip", null, false, directory.entries);
    return summarize(session, directory.zip64, directory.comment, 0);
  }
  if (detected.kind === "tar") {
    const entries = await listTar(id, file.size, (push, onInput) => streamPlain(read, file.size, push, onInput));
    session = make("tar", null, false, entries);
    return summarize(session, false, "", file.size);
  }
  const { codec } = detected;
  const peek = await peekStream(file, codec);
  const isTar = peek.head.length >= 512 && isTarHeader(peek.head.subarray(0, 512));
  if (!isTar) {
    const name = peek.name && sanitizeEntryPath(peek.name).path ? peek.name.split(/[\\/]/u).pop()! : innerStreamName(file.name, codec);
    const item: ArchiveEntry = {
      name, safePath: sanitizeEntryPath(name).path || "file", issue: null, kind: "file", size: -1, packed: file.size,
      mtime: file.lastModified, method: -1, encrypted: false, crc: 0, offset: 0, limit: file.size, overlap: false, link: "",
    };
    session = make("stream", codec, true, [item]);
    return summarize(session, false, "", -1);
  }
  let streamSize = 0;
  const entries = await listTar(id, file.size, async (push, onInput) => {
    await decodeRange(read, 0, file.size, codec, async (bytes) => {
      streamSize += bytes.length;
      checkBombRatio(streamSize, file.size);
      await push(bytes);
    }, onInput);
  });
  session = make("tar", codec, false, entries);
  return summarize(session, false, "", streamSize);
}

type Pump = (push: (bytes: Uint8Array) => Promise<void>, onInput: (consumed: number) => void) => Promise<void>;

async function streamPlain(read: ReadRange, size: number, push: (bytes: Uint8Array) => Promise<void>, onInput: (consumed: number) => void): Promise<void> {
  for (let pos = 0; pos < size; pos += CHUNK) {
    await push(await read(pos, Math.min(CHUNK, size - pos)));
    onInput(Math.min(size, pos + CHUNK));
  }
}

/** One pass over a TAR stream that keeps the headers and skips the data. */
async function listTar(id: number, total: number, pump: Pump): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const tar = new TarReader({ entry(item) { entries.push(item); return false; } });
  const tick = progressTicker(id, total);
  await pump(async (bytes) => { if (!tar.ended) await tar.push(bytes); }, (consumed) => tick(consumed));
  tar.finish();
  tick(total, true);
  return entries;
}

function requireSession(sessionId: number): Session {
  if (!session || session.id !== sessionId) throw new ArchiveError("session-missing", "The archive session is gone");
  return session;
}

function viewIndex(current: Session, row: number): number {
  return current.view ? current.view[row] : row;
}

function viewLength(current: Session): number {
  return current.view ? current.view.length : current.entries.length;
}

function filter(current: Session, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    current.view = null;
    return current.entries.length;
  }
  const matches: number[] = [];
  current.entries.forEach((item, index) => {
    if (item.name.toLocaleLowerCase().includes(needle)) matches.push(index);
  });
  current.view = Uint32Array.from(matches);
  return matches.length;
}

function rows(current: Session, start: number, count: number): ArchiveRow[] {
  const out: ArchiveRow[] = [];
  const end = Math.min(viewLength(current), start + Math.max(0, Math.min(MAX_ROWS, count)));
  for (let row = Math.max(0, start); row < end; row++) {
    const index = viewIndex(current, row);
    const item = current.entries[index];
    out.push({
      index, name: item.name, kind: item.kind, size: item.size, packed: current.container === "zip" || current.single ? item.packed : -1,
      mtime: item.mtime, method: item.method, issue: item.issue, encrypted: item.encrypted, unsupported: isUnsupported(current, item),
      overlap: item.overlap, link: item.link, selected: current.selected[index] === 1,
    });
  }
  return out;
}

function selectionSummary(current: Session): SelectionSummary {
  let selected = 0;
  let selectedFiles = 0;
  let selectedBytes = 0;
  let firstFile = "";
  current.selected.forEach((flag, index) => {
    if (!flag) return;
    selected++;
    const item = current.entries[index];
    if (item.kind === "file") {
      selectedFiles++;
      if (item.size > 0) selectedBytes += item.size;
      if (!firstFile) firstFile = item.safePath.split("/").pop() ?? "";
    }
  });
  return { selected, selectedFiles, selectedBytes, firstFile };
}

/** Toggling a directory row applies to everything under it. */
function select(current: Session, action: SelectAction, row?: number): SelectionSummary {
  if (action === "none") current.selected.fill(0);
  else if (action === "all") current.selected.fill(1);
  else if (action === "filtered") {
    if (current.view) for (const index of current.view) current.selected[index] = 1;
    else current.selected.fill(1);
  } else if (row !== undefined && row >= 0 && row < viewLength(current)) {
    const index = viewIndex(current, row);
    const item = current.entries[index];
    const value = current.selected[index] ? 0 : 1;
    current.selected[index] = value;
    if (item.kind === "dir") {
      const prefix = item.name.endsWith("/") ? item.name : `${item.name}/`;
      current.entries.forEach((other, i) => { if (other.name.startsWith(prefix)) current.selected[i] = value; });
    }
  }
  return selectionSummary(current);
}

// ---------------------------------------------------------------- extraction

interface EntrySink {
  /** Begins an entry; null skips it (the reason is counted by the caller). */
  open(item: ArchiveEntry, path: string): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | null>;
  finish(): Promise<void>;
}

/** Buffers output and hands the writer bounded chunks (copies, so views into reused buffers are safe). */
function chunkedOutput(write: (bytes: Uint8Array) => Promise<void>) {
  const buffer = new Uint8Array(CHUNK);
  let used = 0;
  let total = 0;
  const flush = async () => {
    if (used === 0) return;
    await write(buffer.slice(0, used));
    used = 0;
  };
  return {
    async bytes(data: Uint8Array) {
      total += data.length;
      for (let pos = 0; pos < data.length;) {
        if (used === buffer.length) await flush();
        const take = Math.min(buffer.length - used, data.length - pos);
        buffer.set(data.subarray(pos, pos + take), used);
        used += take;
        pos += take;
      }
    },
    flush,
    get total() { return total; },
  };
}

function singleFileSink(port: MessagePort): EntrySink {
  const writer = createWorkerByteWriter(port);
  const out = chunkedOutput((bytes) => writer.write(bytes));
  let used = false;
  return {
    async open() {
      if (used) return null;
      used = true;
      return { write: (bytes) => out.bytes(bytes), close: async () => {}, abort: async () => {} };
    },
    async finish() {
      await out.flush();
      writer.close();
    },
  };
}

/** A new ZIP of stored entries; the CRC and sizes follow each entry in a data descriptor. */
function zipSink(port: MessagePort): EntrySink {
  const writer = createWorkerByteWriter(port);
  const out = chunkedOutput((bytes) => writer.write(bytes));
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  return {
    async open(item, path) {
      const entry: ZipWriteEntry = {
        name: encoder.encode(path), mtime: item.mtime, method: 0, zip64: item.size < 0 || item.size >= ZIP64_THRESHOLD,
        offset: out.total, crc: 0, packed: 0, size: 0,
      };
      await out.bytes(zipLocalHeader(entry));
      const crc = new Crc32();
      return {
        async write(bytes) {
          crc.update(bytes);
          entry.size += bytes.length;
          await out.bytes(bytes);
        },
        async close() {
          entry.crc = crc.value() >>> 0;
          entry.packed = entry.size;
          crc.free();
          await out.bytes(zipDataDescriptor(entry));
          central.push(zipCentralHeader(entry));
        },
        async abort() {
          // The whole ZIP is abandoned with the original error; nothing to undo here.
          crc.free();
        },
      };
    },
    async finish() {
      const dirOffset = out.total;
      for (const header of central) await out.bytes(header);
      await out.bytes(zipEnd(central.length, dirOffset, out.total - dirOffset));
      await out.flush();
      writer.close();
    },
  };
}

/** Writes into a user-chosen folder; existing files are kept and the new one gets a ` (2)` name. */
function folderSink(root: FileSystemDirectoryHandle, summary: ExtractSummary): EntrySink & { mkdir(path: string): Promise<void> } {
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>([["", Promise.resolve(root)]]);
  const used = new Set<string>();
  const directory = (path: string): Promise<FileSystemDirectoryHandle> => {
    const cached = dirs.get(path);
    if (cached) return cached;
    const slash = path.lastIndexOf("/");
    const made = directory(path.slice(0, Math.max(0, slash))).then((parent) => parent.getDirectoryHandle(path.slice(slash + 1), { create: true }));
    dirs.set(path, made);
    made.catch(() => dirs.delete(path));
    return made;
  };
  const exists = async (parent: FileSystemDirectoryHandle, name: string) => {
    try {
      await parent.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  };
  return {
    async mkdir(path) {
      await directory(path);
    },
    async open(_item, path) {
      let target = uniquePath(path, used);
      const slash = target.lastIndexOf("/");
      let parent: FileSystemDirectoryHandle;
      try {
        parent = await directory(target.slice(0, Math.max(0, slash)));
        while (await exists(parent, target.slice(slash + 1))) target = uniquePath(target, used);
      } catch {
        summary.failed++;
        return null;
      }
      if (target !== path) summary.renamed++;
      let writable: FileSystemWritableFileStream;
      try {
        writable = await (await parent.getFileHandle(target.slice(slash + 1), { create: true })).createWritable();
      } catch {
        summary.failed++;
        return null;
      }
      return {
        write: (bytes) => writable.write(bytes as Uint8Array<ArrayBuffer>),
        close: () => writable.close(),
        async abort() {
          try { await writable.abort(); } catch { /* Already closed. */ }
        },
      };
    },
    async finish() {},
  };
}

/** Why an entry is not extracted, or null when it can be. */
function skipReason(current: Session, item: ArchiveEntry): keyof ExtractSummary | null {
  if (item.kind === "symlink" || item.kind === "hardlink" || item.kind === "other") return "skippedLinks";
  if (!item.safePath) return "skippedUnsafe";
  if (item.encrypted) return "skippedEncrypted";
  if (isUnsupported(current, item) || item.overlap) return "skippedUnsupported";
  return null;
}

async function extract(id: number, current: Session, target: ExtractTarget, stream?: MessagePort, root?: FileSystemDirectoryHandle): Promise<ExtractSummary> {
  const summary: ExtractSummary = { written: 0, bytes: 0, skippedUnsafe: 0, skippedLinks: 0, skippedEncrypted: 0, skippedUnsupported: 0, renamed: 0, failed: 0 };
  const chosen: number[] = [];
  current.selected.forEach((flag, index) => { if (flag) chosen.push(index); });
  if (chosen.length === 0) throw new ArchiveError("need-selection", "Nothing to extract");
  // Stored ZIP entries and plain TAR members still need the WASM CRC-32.
  await ready();
  const files: number[] = [];
  const dirs: number[] = [];
  for (const index of chosen) {
    const item = current.entries[index];
    if (item.kind === "dir") {
      if (item.safePath) dirs.push(index);
      continue;
    }
    const reason = skipReason(current, item);
    if (reason) (summary[reason] as number)++;
    else files.push(index);
  }
  if (target === "file" && files.length !== 1) throw new ArchiveError("need-one", "Choose exactly one file");
  if (files.length === 0 && (target !== "folder" || dirs.length === 0)) throw new ArchiveError("need-selection", "Nothing to extract");
  const folder = target === "folder" ? folderSink(root!, summary) : null;
  const sink: EntrySink = folder ?? (target === "zip" ? zipSink(stream!) : singleFileSink(stream!));
  if (folder) for (const index of dirs) await folder.mkdir(current.entries[index].safePath);
  const read = reader(current.file);
  const want = new Set(files);
  const total = files.reduce((sum, index) => sum + Math.max(0, current.entries[index].size), 0) || current.file.size;
  const tick = progressTicker(id, current.single || current.codec ? current.file.size : total);
  const usedPaths = new Set<string>();
  let produced = 0;
  const account = (bytes: number, input: number) => {
    produced += bytes;
    summary.bytes += bytes;
    if (produced > ARCHIVE_MAX_OUTPUT_BYTES) throw new ArchiveError("too-large", "The output is larger than the extraction limit");
    if (current.single || current.codec) checkBombRatio(produced, input);
  };

  const writeEntry = async (item: ArchiveEntry, body: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>) => {
    const path = folder ? item.safePath : uniquePath(item.safePath, usedPaths);
    if ((!folder && path !== item.safePath) || item.issue === "renamed") summary.renamed++;
    const handle = await sink.open(item, path);
    if (!handle) return;
    try {
      await body((bytes) => handle.write(bytes));
      await handle.close();
      summary.written++;
    } catch (error) {
      await handle.abort();
      throw error;
    }
  };

  if (current.container === "zip" || (current.container === "tar" && !current.codec)) {
    // Random access in archive order keeps reads sequential.
    files.sort((a, b) => current.entries[a].offset - current.entries[b].offset);
    for (const index of files) {
      const item = current.entries[index];
      await writeEntry(item, async (write) => {
        if (current.container === "tar") {
          await copyRange(read, item.offset, item.size, async (bytes) => {
            account(bytes.length, 0);
            await write(bytes);
            tick(produced);
          });
          return;
        }
        const start = await zipDataStart(item, read);
        const codec = zipMethodCodec(item.method);
        const crc = new Crc32();
        let size = 0;
        const out = async (bytes: Uint8Array) => {
          size += bytes.length;
          if (size > item.size) throw new ArchiveError("size-mismatch", "An entry is larger than its declared size");
          checkBombRatio(size, item.packed);
          crc.update(bytes);
          account(bytes.length, 0);
          await write(bytes);
          tick(produced);
        };
        try {
          if (codec === "") await copyRange(read, start, item.packed, out);
          else await decodeRange(read, start, item.packed, codec!, out);
          if (size !== item.size) throw new ArchiveError("size-mismatch", "An entry is smaller than its declared size");
          if ((crc.value() >>> 0) !== (item.crc >>> 0)) throw new ArchiveError("checksum", "An entry's CRC-32 does not match");
        } finally {
          crc.free();
        }
      });
    }
  } else if (current.single) {
    const item = current.entries[0];
    let decodedInput = 0;
    await writeEntry(item, (write) => decodeRange(read, 0, current.file.size, current.codec!, async (bytes) => {
      account(bytes.length, decodedInput);
      await write(bytes);
    }, (consumed) => { decodedInput = consumed; tick(consumed); }));
  } else {
    // Compressed TAR: one sequential pass, writing the selected members as they pass by.
    let decodedInput = 0;
    let open: { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | null = null;
    const tar = new TarReader({
      async entry(_item, index) {
        if (!want.has(index)) return false;
        const item = current.entries[index];
        const path = folder ? item.safePath : uniquePath(item.safePath, usedPaths);
        if ((!folder && path !== item.safePath) || item.issue === "renamed") summary.renamed++;
        open = await sink.open(item, path);
        return open !== null;
      },
      async data(bytes) {
        await open?.write(bytes);
      },
      async end() {
        const finished = open;
        open = null;
        if (finished) {
          await finished.close();
          summary.written++;
        }
      },
    });
    try {
      await decodeRange(read, 0, current.file.size, current.codec!, async (bytes) => {
        account(bytes.length, decodedInput);
        if (!tar.ended) await tar.push(bytes);
      }, (consumed) => { decodedInput = consumed; tick(consumed); });
      tar.finish();
    } catch (error) {
      const pending = open as { abort(): Promise<void> } | null;
      await pending?.abort();
      throw error;
    }
    // The pass decodes the whole stream; report the bytes of the members written.
    summary.bytes = files.reduce((sum, index) => sum + Math.max(0, current.entries[index].size), 0);
  }
  await sink.finish();
  tick(current.single || current.codec ? current.file.size : total, true);
  return summary;
}

// ---------------------------------------------------------------- creation

async function create(id: number, files: File[], paths: string[], format: ArchiveCreateFormat, level: number, port: MessagePort): Promise<{ entries: number; inputBytes: number; outputBytes: number }> {
  if (files.length === 0) throw new ArchiveError("need-selection", "Nothing to add");
  if (files.length > ARCHIVE_MAX_ENTRIES) throw new ArchiveError("too-many-entries", "Too many files");
  await ready();
  const writer = createWorkerByteWriter(port);
  const out = chunkedOutput((bytes) => writer.write(bytes));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const tick = progressTicker(id, total);
  const used = new Set<string>();
  const names = files.map((file, i) => uniquePath(sanitizeEntryPath(paths[i] ?? file.name).path || sanitizeEntryPath(file.name).path || "file", used));
  let processed = 0;
  const readFile = async (file: File, onChunk: (bytes: Uint8Array) => Promise<void>) => {
    const read = reader(file);
    for (let pos = 0; pos < file.size; pos += CHUNK) {
      const chunk = await read(pos, Math.min(CHUNK, file.size - pos));
      await onChunk(chunk);
      processed += chunk.length;
      tick(processed);
    }
  };

  if (format === "zip") {
    const encoder = new TextEncoder();
    const central: Uint8Array[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entry: ZipWriteEntry = {
        name: encoder.encode(names[i]), mtime: file.lastModified, method: level > 0 ? 8 : 0, zip64: file.size >= ZIP64_THRESHOLD,
        offset: out.total, crc: 0, packed: 0, size: file.size,
      };
      await out.bytes(zipLocalHeader(entry));
      const start = out.total;
      if (entry.method === 8) {
        const deflate = new Encoder("deflate", level, file.size, null);
        try {
          await readFile(file, (chunk) => out.bytes(deflate.push(chunk)));
          await out.bytes(deflate.finish());
          entry.crc = deflate.crc32() >>> 0;
        } finally {
          deflate.free();
        }
      } else {
        const crc = new Crc32();
        try {
          await readFile(file, async (chunk) => { crc.update(chunk); await out.bytes(chunk); });
          entry.crc = crc.value() >>> 0;
        } finally {
          crc.free();
        }
      }
      entry.packed = out.total - start;
      await out.bytes(zipDataDescriptor(entry));
      central.push(zipCentralHeader(entry));
    }
    const dirOffset = out.total;
    for (const header of central) await out.bytes(header);
    await out.bytes(zipEnd(central.length, dirOffset, out.total - dirOffset));
  } else {
    const codec = format === "tar.gz" ? "gzip" : format === "tar.zst" ? "zstd" : null;
    const compressor = codec ? new Encoder(codec, level, -1, null) : null;
    let tarBytes = 0;
    const emit = async (bytes: Uint8Array) => {
      tarBytes += bytes.length;
      await out.bytes(compressor ? compressor.push(bytes) : bytes);
    };
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        await emit(tarHeader(names[i], file.size, file.lastModified));
        await readFile(file, emit);
        await emit(tarPadding(file.size));
      }
      await emit(tarEnd(tarBytes));
      if (compressor) await out.bytes(compressor.finish());
    } finally {
      compressor?.free();
    }
  }
  await out.flush();
  writer.close();
  tick(total, true);
  return { entries: files.length, inputBytes: total, outputBytes: out.total };
}

async function handle(id: number, request: ArchiveRequest): Promise<void> {
  try {
    let result: ArchiveSuccess;
    switch (request.type) {
      case "open":
        result = { kind: "open", ...(await open(id, request.file)) };
        break;
      case "filter": {
        const current = requireSession(request.sessionId);
        result = { kind: "filter", sessionId: current.id, count: filter(current, request.query) };
        break;
      }
      case "rows": {
        const current = requireSession(request.sessionId);
        result = { kind: "rows", sessionId: current.id, rows: rows(current, request.start, request.count) };
        break;
      }
      case "select": {
        const current = requireSession(request.sessionId);
        result = { kind: "select", sessionId: current.id, ...select(current, request.action, request.row) };
        break;
      }
      case "extract": {
        const current = requireSession(request.sessionId);
        result = { kind: "extract", sessionId: current.id, ...(await extract(id, current, request.target, request.stream, request.directory)) };
        break;
      }
      case "create":
        result = { kind: "create", ...(await create(id, request.files, request.paths, request.format, request.level, request.stream)) };
        break;
    }
    post({ id, ok: true, ...result });
  } catch (raw) {
    const error = codecError(raw);
    const archiveError = error instanceof ArchiveError ? error : null;
    if (archiveError && request.type === "open") session = null;
    const code = archiveError?.code ?? null;
    const fallback = archiveError ? (LIMIT_CODES.has(archiveError.code) ? "input-too-large" : "unknown") : "worker-failed";
    const classified = classifyWorkerError(error, fallback);
    const detail = archiveError?.detail ? `:${archiveError.detail}` : "";
    post({ id, ok: false, code: classified.code, message: code ? `${code}${detail}` : classified.message });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<ArchiveRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as ArchiveRequest));
});

export {};
