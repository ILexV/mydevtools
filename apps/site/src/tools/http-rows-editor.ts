import { createFileField, type FileField, type FileFieldStrings, type FileStore } from "@/tools/http-file-field";
import type { HttpFormDataRow, HttpSavedRow } from "@/tools/http-workspace";

export interface RowsEditorStrings {
  KeyLabel: string;
  ValueLabel: string;
  EnabledLabel: string;
  RemoveRow: string;
  AddRow: string;
}

export interface RowsEditor<T extends HttpSavedRow = HttpSavedRow> {
  element: HTMLElement;
  read(): T[];
  replace(rows: readonly T[]): void;
}

export interface FormDataStrings extends FileFieldStrings {
  BodyFieldKind: string;
  BodyKindText: string;
  BodyKindFile: string;
}

/**
 * Key/value/enabled table for HTTP client variables (environment, global and
 * folder scopes) and x-www-form-urlencoded fields. A trailing blank row is
 * always kept for typing; blank rows are not returned.
 */
export function createRowsEditor(strings: RowsEditorStrings, label: string, onChange: () => void): RowsEditor {
  return createTable(strings, label, onChange, null) as RowsEditor;
}

/** The same table for multipart/form-data: each row is a text value or a picked file. */
export function createFormDataEditor(
  strings: RowsEditorStrings & FormDataStrings, label: string, store: FileStore, onChange: () => void,
): RowsEditor<HttpFormDataRow> {
  return createTable(strings, label, onChange, { strings, store });
}

function createTable(
  strings: RowsEditorStrings,
  label: string,
  onChange: () => void,
  files: { strings: FormDataStrings; store: FileStore } | null,
): RowsEditor<HttpFormDataRow> {
  const element = document.createElement("div");
  element.className = "http-rows-editor";
  const scroll = document.createElement("div");
  scroll.className = "http-table-scroll";
  const table = document.createElement("table");
  table.className = "http-kv-table";
  table.setAttribute("aria-label", label);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headCell = (text: string, className = "", hidden = false): HTMLTableCellElement => {
    const cell = document.createElement("th");
    if (className) cell.className = className;
    if (hidden) {
      const span = document.createElement("span");
      span.className = "visually-hidden";
      span.textContent = text;
      cell.append(span);
    } else {
      cell.scope = "col";
      cell.textContent = text;
    }
    return cell;
  };
  headRow.append(
    headCell(strings.EnabledLabel, "http-check-cell", true),
    headCell(strings.KeyLabel),
    ...(files ? [headCell(files.strings.BodyFieldKind, "http-kind-cell")] : []),
    headCell(strings.ValueLabel),
    headCell(strings.RemoveRow, "http-remove-cell", true),
  );
  head.append(headRow);
  const body = document.createElement("tbody");
  table.append(head, body);
  scroll.append(table);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ds-btn ds-btn-small ds-btn-ghost http-add-row";
  add.textContent = `+ ${strings.AddRow}`;
  element.append(scroll, add);

  interface Row {
    element: HTMLTableRowElement; enabled: HTMLInputElement; key: HTMLInputElement; value: HTMLInputElement;
    kind: HTMLSelectElement | null; file: FileField | null;
  }
  const rows: Row[] = [];
  const input = (aria: string): HTMLInputElement => {
    const field = document.createElement("input");
    field.type = "text";
    field.className = "ds-field mono";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.placeholder = aria;
    field.setAttribute("aria-label", aria);
    return field;
  };
  const cell = (child: HTMLElement, className = ""): HTMLTableCellElement => {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.append(child);
    return td;
  };
  const blank = (row: Row | undefined): boolean => row !== undefined && !row.key.value && !row.value.value
    && row.enabled.checked && !row.file?.get() && row.kind?.value !== "file";

  function append(entry?: HttpFormDataRow): Row {
    const tr = document.createElement("tr");
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "ds-check";
    enabled.checked = entry?.enabled ?? true;
    enabled.setAttribute("aria-label", strings.EnabledLabel);
    const key = input(strings.KeyLabel);
    key.value = entry?.name ?? "";
    const value = input(strings.ValueLabel);
    value.value = entry?.value ?? "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ds-btn ds-btn-small ds-btn-ghost";
    remove.setAttribute("aria-label", strings.RemoveRow);
    remove.title = strings.RemoveRow;
    remove.textContent = "×";
    let kind: HTMLSelectElement | null = null;
    let file: FileField | null = null;
    const valueCell = cell(value);
    if (files) {
      kind = document.createElement("select");
      kind.className = "ds-field-select";
      kind.setAttribute("aria-label", files.strings.BodyFieldKind);
      kind.append(new Option(files.strings.BodyKindText, "text"), new Option(files.strings.BodyKindFile, "file"));
      kind.value = entry?.kind ?? "text";
      file = createFileField(files.strings, files.store, strings.ValueLabel, () => tr.dispatchEvent(new Event("input")));
      file.set(entry?.file);
      valueCell.append(file.element);
      const selectKind = kind;
      const showKind = (): void => {
        value.hidden = selectKind.value === "file";
        file!.element.hidden = selectKind.value !== "file";
      };
      showKind();
      kind.addEventListener("change", showKind);
    }
    tr.append(cell(enabled, "http-check-cell"), cell(key), ...(kind ? [cell(kind, "http-kind-cell")] : []), valueCell,
      cell(remove, "http-remove-cell"));
    const row: Row = { element: tr, enabled, key, value, kind, file };
    rows.push(row);
    body.append(tr);
    tr.addEventListener("input", () => {
      if (rows.at(-1) === row && !blank(row)) append();
      onChange();
    });
    remove.addEventListener("click", () => {
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      tr.remove();
      if (!blank(rows.at(-1))) append();
      rows[Math.min(index, rows.length - 1)]!.key.focus();
      onChange();
    });
    return row;
  }

  add.addEventListener("click", () => {
    const last = rows.at(-1);
    (blank(last) ? last! : append()).key.focus();
  });

  function replace(entries: readonly HttpFormDataRow[]): void {
    rows.length = 0;
    body.replaceChildren();
    for (const entry of entries) append(entry);
    append();
  }

  replace([]);
  return {
    element,
    read: () => rows.filter((row) => row.key.value || row.value.value || row.file?.get())
      .map((row) => {
        const entry = { name: row.key.value, value: row.value.value, enabled: row.enabled.checked };
        return row.kind ? { ...entry, kind: row.kind.value as HttpFormDataRow["kind"], file: row.file!.get() } : entry as HttpFormDataRow;
      }),
    replace,
  };
}
