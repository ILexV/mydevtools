/**
 * Lazy entry point for the CodeMirror 6 editor kit (`codemirror-kit.ts`,
 * npm `@codemirror/*`, bundled by Vite). Tool controllers call
 * `loadEditorKit()`; the kit and its language grammar are fetched as separate
 * chunks only on pages that mount an editor (json/xml/yaml beautifiers,
 * json-to-typescript), so other pages ship no editor code. Theme CSS:
 * `styles/codemirror.css`.
 *
 * Also exports editor-agnostic helpers: file drop onto an editor host and
 * text download.
 */

export type { EditorLanguage, IndentStyle, MdtEditor } from "@/scripts/codemirror-kit";
type EditorKit = typeof import("@/scripts/codemirror-kit");

let kitPromise: Promise<EditorKit> | null = null;

/** Loads (once) the CodeMirror 6 kit; a failed load can be retried. */
export function loadEditorKit(): Promise<EditorKit> {
  kitPromise ??= import("@/scripts/codemirror-kit").catch((err: unknown) => {
    kitPromise = null;
    throw err;
  });
  return kitPromise;
}

/**
 * Drop a file onto an editor host: `.is-dragover` while dragging files, the
 * first accepted file goes to `onFile`. Capture-phase listeners stop
 * CodeMirror's own drop handler from also inserting the file text; plain
 * text drags (no files) still reach the editor.
 */
export function bindEditorFileDrop(host: HTMLElement, accept: (file: File) => boolean, onFile: (file: File) => void): void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  host.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    host.classList.add("is-dragover");
  }, true);
  host.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, true);
  host.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) host.classList.remove("is-dragover");
  }, true);
  host.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    host.classList.remove("is-dragover");
    const file = Array.from(e.dataTransfer?.files ?? []).find(accept);
    if (file) onFile(file);
  }, true);
}

/** Save `text` as a download (object URL revoked after the click is handled). */
export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
