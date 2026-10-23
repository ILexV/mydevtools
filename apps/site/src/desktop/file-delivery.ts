/**
 * Hands files to a tool page as if the person had picked them: the shell finds
 * the page's main file input (drop zone first), fills it through the frame's own
 * DataTransfer and fires `input`/`change`. Used by "open with" on the desk,
 * drops anywhere inside a window and OS file launches. Files never leave the browser.
 */

import { fileExtension } from "./file-routes.ts";

/** `accept` attribute check: `.ext`, `type/*` and exact MIME tokens; an empty accept takes anything. */
export function acceptsFile(accept: string, file: { name: string; type: string }): boolean {
  const tokens = accept.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;
  const extension = fileExtension(file.name);
  const type = file.type.toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return token === extension;
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return token === type || token === "application/octet-stream";
  });
}

/** Best file input of a tool page for these files, or null when none fits. */
export function pickFileInput(doc: Document, files: readonly File[]): HTMLInputElement | null {
  const root = doc.querySelector("main.tool") ?? doc.body;
  const all = [...root.querySelectorAll<HTMLInputElement>("input[type=file]")].filter((input) => !input.disabled);
  // Inputs of the visible mode first; a hidden panel's input is the last resort.
  const inputs = [...all.filter((input) => !input.closest("[hidden]")), ...all.filter((input) => input.closest("[hidden]"))];
  const fits = (input: HTMLInputElement) => files.every((file) => acceptsFile(input.accept, file));
  const zone = inputs.filter((input) => input.closest(".ds-dropzone"));
  return zone.find(fits) ?? inputs.find(fits) ?? null;
}

/** Puts the files into the tool's input. A single-file input gets the first file only. */
export function deliverFiles(doc: Document, files: readonly File[]): boolean {
  const view = doc.defaultView;
  const input = pickFileInput(doc, files);
  if (!view || !input || files.length === 0) return false;
  const transfer = new view.DataTransfer();
  for (const file of input.multiple ? files : files.slice(0, 1)) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  return true;
}
