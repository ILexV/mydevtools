/**
 * DOM builders shared by the PDF tool controllers (pdf-compressor,
 * pdf-merger, pdf-to-text): selected-file rows on the global `ds-file-item*`
 * classes (controller-created DOM — Astro scoped CSS would not reach it),
 * icon buttons/links, status badges and the row spinner. Browser-only.
 */

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** Prism icon paths (same family as components/Icon.astro). */
export const PDF_ICONS = {
  download: `${SVG_OPEN}<path d="M10 4v9M6.5 9.5 10 13l3.5-3.5"/><path d="M4 13.5V15a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-1.5"/></svg>`,
  close: `${SVG_OPEN}<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/></svg>`,
  up: `${SVG_OPEN}<path d="M10 15.5V4.5M5.5 9 10 4.5 14.5 9"/></svg>`,
  down: `${SVG_OPEN}<path d="M10 4.5v11M5.5 11l4.5 4.5 4.5-4.5"/></svg>`,
  check: `${SVG_OPEN}<path d="m4 10.5 4 4 8-9"/></svg>`,
} as const;

export interface FileRowParts {
  li: HTMLLIElement;
  meta: HTMLElement;
  actions: HTMLElement;
}

/**
 * `li.ds-file-item` with name (full name in `title`), a meta line and an
 * actions cell. `index` is shown 1-based as the first meta token.
 */
export function buildFileRow(name: string, index: number): FileRowParts {
  const li = document.createElement("li");
  li.className = "ds-file-item";
  const main = document.createElement("div");
  main.className = "pdf-file-main";
  const nameEl = document.createElement("div");
  nameEl.className = "ds-file-item-name";
  nameEl.title = name;
  nameEl.textContent = name;
  const meta = document.createElement("div");
  meta.className = "ds-file-item-meta";
  const idx = document.createElement("span");
  idx.textContent = `#${index + 1}`;
  meta.append(idx);
  main.append(nameEl, meta);
  const actions = document.createElement("div");
  actions.className = "ds-file-item-actions";
  li.append(main, actions);
  return { li, meta, actions };
}

/** Append ` · <text>` to a meta line; `hiddenLabel` is screen-reader only. */
export function appendMeta(meta: HTMLElement, text: string, hiddenLabel?: string): void {
  const sep = document.createElement("span");
  sep.setAttribute("aria-hidden", "true");
  sep.textContent = " · ";
  meta.append(sep);
  if (hiddenLabel) {
    const label = document.createElement("span");
    label.className = "visually-hidden";
    label.textContent = `${hiddenLabel}: `;
    meta.append(label);
  }
  const value = document.createElement("span");
  value.className = "pdf-meta-value";
  value.textContent = text;
  meta.append(value);
}

export function iconButton(icon: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ds-icon-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = icon;
  return btn;
}

export function downloadLink(url: string, fileName: string, label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "ds-icon-btn pdf-download";
  a.href = url;
  a.download = fileName;
  a.title = label;
  a.setAttribute("aria-label", label);
  a.innerHTML = PDF_ICONS.download;
  return a;
}

export type BadgeTone = "" | "cat" | "success" | "warning" | "danger";

export function badge(text: string, tone: BadgeTone = "", title?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = tone ? `ds-badge ds-badge-${tone}` : "ds-badge";
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

/** Row "working" indicator with an accessible name. */
export function spinner(label: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "ds-spinner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", label);
  return el;
}
