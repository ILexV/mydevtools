/**
 * "Open with" routing for files dropped on the desk or launched from the OS
 * (PWA file handler): which tools can take a file, best match first.
 * The same table feeds the manifest's `file_handlers`, so the OS offers
 * MyDevTools only for types some tool really opens.
 */

export interface FileRoute {
  /** Lower-case extensions with the dot. */
  extensions: readonly string[];
  /** MIME types for the manifest; the first one also matches `File.type`. */
  mimeTypes: readonly string[];
  /** Tools that open this kind of file, best first. */
  slugs: readonly string[];
}

export const FILE_ROUTES: readonly FileRoute[] = [
  { extensions: [".pdf"], mimeTypes: ["application/pdf"], slugs: ["pdf-organizer", "pdf-to-text", "pdf-compressor", "pdf-merger"] },
  {
    extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".ico", ".tga", ".avif"],
    mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"],
    slugs: ["image-batch", "image-compressor", "image-converter", "image-resizer", "qr-scanner"],
  },
  { extensions: [".json"], mimeTypes: ["application/json"], slugs: ["json-explorer", "json-beautifier", "data-format-converter", "local-data-playground"] },
  { extensions: [".jsonl", ".ndjson"], mimeTypes: ["application/x-ndjson"], slugs: ["json-explorer", "log-analyzer", "local-data-playground", "data-format-converter"] },
  { extensions: [".csv", ".tsv"], mimeTypes: ["text/csv", "text/tab-separated-values"], slugs: ["csv-explorer", "data-format-converter", "local-data-playground"] },
  { extensions: [".parquet"], mimeTypes: ["application/vnd.apache.parquet"], slugs: ["parquet-explorer", "local-data-playground", "data-format-converter"] },
  {
    extensions: [".sqlite", ".sqlite3", ".db", ".db3", ".s3db", ".sl3"],
    mimeTypes: ["application/vnd.sqlite3", "application/x-sqlite3"],
    slugs: ["sqlite-explorer"],
  },
  { extensions: [".xml"], mimeTypes: ["application/xml", "text/xml"], slugs: ["xml-beautifier"] },
  { extensions: [".log", ".clef"], mimeTypes: ["text/x-log"], slugs: ["log-analyzer", "large-file-diff"] },
  { extensions: [".txt"], mimeTypes: ["text/plain"], slugs: ["log-analyzer", "text-diff-viewer", "large-file-diff"] },
  {
    extensions: [".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z"],
    mimeTypes: ["application/zip", "application/x-tar", "application/gzip", "application/x-bzip2", "application/x-xz", "application/zstd", "application/x-7z-compressed"],
    slugs: ["archive-explorer", "compression-benchmark"],
  },
  { extensions: [".pub", ".pem", ".key"], mimeTypes: ["application/x-pem-file"], slugs: ["openssh-keys"] },
  { extensions: [".aead"], mimeTypes: ["application/x-mdt-aead"], slugs: ["aead-file"] },
];

/** Tools that take any file: checksums, signatures, raw bytes, encryption. */
export const ANY_FILE_SLUGS: readonly string[] = ["hash-calculator", "file-signature", "hex-viewer", "aead-file", "base64-encoder"];

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * Ranked tools for a set of files: tools that fit every file come first in table
 * order, then the generic any-file tools. Unknown slugs are dropped.
 */
export function toolsForFiles(files: readonly { name: string; type: string }[], available: ReadonlySet<string>): string[] {
  if (files.length === 0) return [];
  const perFile = files.map((file) => {
    const extension = fileExtension(file.name);
    const type = file.type.toLowerCase();
    const slugs: string[] = [];
    for (const route of FILE_ROUTES) {
      if (route.extensions.includes(extension) || (type && route.mimeTypes.includes(type))) slugs.push(...route.slugs);
    }
    if (slugs.length === 0 && type.startsWith("image/")) slugs.push(...FILE_ROUTES[1]!.slugs);
    return slugs;
  });
  const shared = perFile[0]!.filter((slug) => perFile.every((slugs) => slugs.includes(slug)));
  const result: string[] = [];
  for (const slug of [...shared, ...ANY_FILE_SLUGS]) {
    if (available.has(slug) && !result.includes(slug)) result.push(slug);
  }
  return result;
}

/** `file_handlers[0].accept` for the web app manifest: each route's main MIME type → its extensions. */
export function manifestAccept(): Record<string, string[]> {
  const accept: Record<string, string[]> = {};
  for (const route of FILE_ROUTES) accept[route.mimeTypes[0]!] = [...route.extensions];
  return accept;
}
