/**
 * Archive explorer worker messages. The archive File is structured-cloned (bytes stay in the
 * blob store); entries, the filter view and the selection live in the worker session.
 */
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { EntryKind, PathIssue, StreamCodec } from "@/tools/archive-format";

export type ArchiveContainer = "zip" | "tar" | "stream";
export type ArchiveCreateFormat = "zip" | "tar" | "tar.gz" | "tar.zst";
export type ExtractTarget = "file" | "zip" | "folder";

export interface ArchiveSummary {
  sessionId: number;
  container: ArchiveContainer;
  /** Compression around a TAR or a single file. */
  codec: StreamCodec | null;
  /** A compressed single file, not a TAR. */
  single: boolean;
  entries: number;
  files: number;
  dirs: number;
  links: number;
  /** Sum of known uncompressed file sizes. */
  totalSize: number;
  /** Decompressed TAR stream length for compressed TARs. */
  streamSize: number;
  unsafe: number;
  renamed: number;
  encrypted: number;
  unsupported: number;
  overlap: number;
  /** Files whose declared ratio passes the compression-bomb limit. */
  suspicious: number;
  zip64: boolean;
  comment: string;
}

export interface ArchiveRow {
  index: number;
  name: string;
  kind: EntryKind;
  size: number;
  packed: number;
  mtime: number;
  method: number;
  issue: PathIssue | null;
  encrypted: boolean;
  unsupported: boolean;
  overlap: boolean;
  link: string;
  selected: boolean;
}

export interface SelectionSummary {
  selected: number;
  selectedFiles: number;
  selectedBytes: number;
  /** File name (last segment) of the first selected file, for the save dialog. */
  firstFile: string;
}

export interface ExtractSummary {
  written: number;
  bytes: number;
  skippedUnsafe: number;
  skippedLinks: number;
  skippedEncrypted: number;
  skippedUnsupported: number;
  renamed: number;
  failed: number;
}

export type SelectAction = "toggle" | "all" | "none" | "filtered";

export type ArchiveRequest =
  | { type: "open"; file: File }
  | { type: "filter"; sessionId: number; query: string }
  | { type: "rows"; sessionId: number; start: number; count: number }
  | { type: "select"; sessionId: number; action: SelectAction; row?: number }
  | { type: "extract"; sessionId: number; target: ExtractTarget; stream?: MessagePort; directory?: FileSystemDirectoryHandle }
  | { type: "create"; files: File[]; paths: string[]; format: ArchiveCreateFormat; level: number; stream: MessagePort };

export type ArchiveSuccess =
  | ({ kind: "open" } & ArchiveSummary)
  | { kind: "filter"; sessionId: number; count: number }
  | { kind: "rows"; sessionId: number; rows: ArchiveRow[] }
  | ({ kind: "select"; sessionId: number } & SelectionSummary)
  | ({ kind: "extract"; sessionId: number } & ExtractSummary)
  | { kind: "create"; entries: number; inputBytes: number; outputBytes: number };

export type ArchiveWorkerMessage =
  | ({ id: number; ok: true } & ArchiveSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };
