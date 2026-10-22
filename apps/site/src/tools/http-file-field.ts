import { formatBytes } from "@/lib/format";
import type { HttpFileRef } from "@/tools/http-workspace";

export interface FileFieldStrings {
  BodyChooseFile: string;
  BodyRemoveFile: string;
  BodyFileMissing: string;
}

/**
 * Picked files of the HTTP client body, kept in page memory only: the workspace
 * saves their descriptions, so after a reload a file must be chosen again.
 */
export class FileStore {
  private readonly files = new Map<string, File>();

  add(file: File): HttpFileRef {
    const id = crypto.randomUUID();
    this.files.set(id, file);
    return { id, name: file.name, size: file.size, type: file.type };
  }

  get(ref: HttpFileRef): File | undefined {
    return this.files.get(ref.id);
  }
}

export interface FileField {
  element: HTMLElement;
  get(): HttpFileRef | null;
  set(ref: HttpFileRef | null | undefined): void;
}

/** «Choose file» button with the name and size, a remove button and a «choose again» mark. */
export function createFileField(strings: FileFieldStrings, store: FileStore, label: string, onChange: () => void): FileField {
  const element = document.createElement("div");
  element.className = "http-file-field";
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.tabIndex = -1;
  const choose = document.createElement("button");
  choose.type = "button";
  choose.className = "ds-btn ds-btn-small";
  choose.textContent = strings.BodyChooseFile;
  choose.setAttribute("aria-label", `${label}: ${strings.BodyChooseFile}`);
  const name = document.createElement("span");
  name.className = "http-file-name mono";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ds-btn ds-btn-small ds-btn-ghost";
  remove.textContent = "×";
  remove.title = strings.BodyRemoveFile;
  remove.setAttribute("aria-label", strings.BodyRemoveFile);
  element.append(input, choose, name, remove);
  let current: HttpFileRef | null = null;

  function render(): void {
    const missing = current !== null && !store.get(current);
    name.textContent = current ? `${current.name} · ${formatBytes(current.size)}${missing ? ` · ${strings.BodyFileMissing}` : ""}` : "";
    name.title = current?.name ?? "";
    name.hidden = !current;
    name.classList.toggle("is-missing", missing);
    remove.hidden = !current;
  }

  choose.addEventListener("click", () => input.click());
  // The picker's own input event would reach the row before the file is stored.
  input.addEventListener("input", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    current = store.add(file);
    render();
    onChange();
  });
  remove.addEventListener("click", () => {
    current = null;
    render();
    choose.focus();
    onChange();
  });

  render();
  return {
    element,
    get: () => current && { ...current },
    set(ref) {
      current = ref ? { ...ref } : null;
      render();
    },
  };
}
