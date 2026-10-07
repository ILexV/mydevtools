/**
 * CodeMirror 6 editor kit for the structured-data tools (json/xml/yaml
 * beautifiers, json-to-typescript). Never imported statically: pages reach it
 * only through `loadEditorKit()` in `codemirror-loader.ts`, so Vite emits it
 * (and each language package) as lazy chunks and other pages load 0 editor JS.
 *
 * Features: line numbers, fold gutter + keys, bracket matching/closing,
 * history, search panel (Ctrl/Cmd-F — the editor virtualizes rendering, so
 * browser find can't see off-screen text), syntax highlight via
 * `mdtHighlighter` (`tok-*` classes themed in `styles/codemirror.css`),
 * Ctrl/Cmd-Enter submit, Tab indents with the built-in Esc→Tab focus escape
 * (read-only editors never capture Tab), aria-label/-describedby on the
 * content element, and parse-error diagnostics (`setDiagnostic`: underlined
 * token or EOF insertion marker, tinted line, gutter marker, message panel
 * with "Go to error", aria-invalid; cleared by the next edit).
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  GutterMarker,
  gutterLineClass,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  WidgetType,
  type DecorationSet,
  type KeyBinding,
} from "@codemirror/view";
import { tagHighlighter, tags as t } from "@lezer/highlight";
import { announce } from "@/scripts/tool-ui";

export type EditorLanguage = "json" | "xml" | "yaml" | "typescript" | "text";
export type IndentStyle = number | "tab";

export interface EditorOptions {
  language: EditorLanguage;
  /** Accessible name of the editable content element. */
  label: string;
  /** Id of a visible hint element (keyboard help) for aria-describedby. */
  hintId?: string;
  readOnly?: boolean;
  /** Initial indentation (default 2 spaces). */
  indent?: IndentStyle;
  /** Ctrl/Cmd-Enter handler. */
  onSubmit?: () => void;
  /** Called after every document change (user edits and `setValue`). */
  onChange?: () => void;
  /** Localized CodeMirror UI phrases (`editor-phrases.ts`); empty = English. */
  phrases?: Record<string, string>;
  /** Message panel for `setDiagnostic` (an element with an id, no live role). */
  diagnostics?: DiagnosticPanelOptions;
}

export interface DiagnosticPanelOptions {
  box: HTMLElement;
  /** "Go to error" button label. */
  goToLabel: string;
  /**
   * Live-validating tools (re-check shortly after typing): an edit only marks
   * the panel stale instead of hiding it, so it doesn't flicker per keystroke.
   */
  keepPanelOnEdit?: boolean;
}

/**
 * Parse error as the editor shows it: final localized text plus document
 * offsets (`from === null` = location unknown; `from === to` = insertion
 * point such as a missing bracket at EOF).
 */
export interface EditorDiagnostic {
  message: string;
  /** Raw parser detail, shown muted after the message. */
  detail?: string;
  from: number | null;
  to: number | null;
}

/** Small editor surface the tool controllers use. */
export interface MdtEditor {
  readonly view: EditorView;
  getValue(): string;
  setValue(text: string): void;
  setIndent(style: IndentStyle): void;
  focus(): void;
  /**
   * Show (or clear with null) a parse diagnostic. `announce` reads it out once
   * through the shared polite live region — pass it only on explicit submit.
   */
  setDiagnostic(diagnostic: EditorDiagnostic | null, options?: { announce?: boolean }): void;
  /** Focus the editor, select the diagnostic range and scroll it into view. */
  revealDiagnostic(): void;
}

// Per-language chunks: a page only downloads the grammar it uses.
const LANGUAGES: Record<Exclude<EditorLanguage, "text">, () => Promise<LanguageSupport>> = {
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
};
const languageCache = new Map<EditorLanguage, Promise<LanguageSupport>>();

function loadLanguage(lang: EditorLanguage): Promise<Extension> {
  if (lang === "text") return Promise.resolve([]);
  let p = languageCache.get(lang);
  if (!p) {
    p = LANGUAGES[lang]().catch((err: unknown) => {
      languageCache.delete(lang);
      throw err;
    });
    languageCache.set(lang, p);
  }
  return p;
}

function indentExtensions(style: IndentStyle): Extension {
  const size = style === "tab" ? 4 : style;
  return [indentUnit.of(style === "tab" ? "\t" : " ".repeat(size)), EditorState.tabSize.of(size)];
}

/**
 * Syntax tag → CSS class (colors in `styles/codemirror.css`). Unlisted
 * modified tags fall back to their base tag (e.g. lineComment → comment,
 * definition(propertyName) → propertyName for YAML keys).
 */
const mdtHighlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], class: "tok-keyword" },
  { tag: [t.tagName, t.angleBracket], class: "tok-tag" },
  { tag: [t.string, t.attributeValue, t.character], class: "tok-string" },
  { tag: [t.regexp, t.escape, t.special(t.string)], class: "tok-string2" },
  { tag: t.number, class: "tok-number" },
  { tag: [t.bool, t.null, t.atom], class: "tok-atom" },
  { tag: [t.propertyName, t.attributeName], class: "tok-property" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type" },
  { tag: t.definition(t.variableName), class: "tok-def" },
  { tag: t.variableName, class: "tok-variable" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta, t.labelName], class: "tok-meta" },
  { tag: t.comment, class: "tok-comment" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], class: "tok-punct" },
  { tag: t.invalid, class: "tok-invalid" },
]);

/**
 * Structural theme (fonts, gutters, cursor, selection, fold placeholder,
 * matching bracket) on `--mdt-*` tokens. Kept as an EditorView theme so it
 * out-ranks CodeMirror's base theme (mounted via adoptedStyleSheets).
 */
const mdtTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--mdt-text)",
    backgroundColor: "transparent",
    fontSize: "0.875rem",
  },
  "&.cm-focused": { outline: "none" },
  // Ligatures off: `<!--`, `=>`, `!=` must show the literal characters.
  ".cm-scroller": { fontFamily: "var(--mdt-font-mono)", lineHeight: "1.5", fontVariantLigatures: "none" },
  ".cm-content": { caretColor: "var(--mdt-text)", padding: "4px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--mdt-text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--cm-selection-focused)",
  },
  ".cm-selectionBackground": { backgroundColor: "var(--cm-selection)" },
  ".cm-gutters": {
    backgroundColor: "var(--mdt-surface-muted)",
    color: "var(--mdt-text-muted)",
    borderRight: "1px solid var(--mdt-border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 8px", minWidth: "2.5em" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--mdt-text-muted)", padding: "0 4px", cursor: "pointer" },
  ".cm-foldPlaceholder": {
    backgroundColor: "transparent",
    border: "1px solid var(--mdt-border)",
    color: "var(--mdt-accent)",
    fontFamily: "var(--mdt-font-mono)",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--mdt-accent) 12%, transparent)",
    outline: "1px solid var(--mdt-accent)",
    color: "inherit",
  },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--mdt-danger)", backgroundColor: "transparent" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--mdt-accent) 14%, transparent)" },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--mdt-warning) 30%, transparent)",
    outline: "1px solid var(--mdt-border)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--mdt-accent) 35%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--mdt-surface-muted)", color: "var(--mdt-text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--mdt-border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--mdt-border)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "0.8125rem" },
  ".cm-textfield": {
    backgroundColor: "var(--mdt-surface-raised)",
    color: "var(--mdt-text)",
    border: "1px solid var(--mdt-border)",
    borderRadius: "var(--mdt-radius-xs)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--mdt-surface-raised)",
    color: "var(--mdt-text)",
    border: "1px solid var(--mdt-border)",
    borderRadius: "var(--mdt-radius-xs)",
  },
  ".cm-specialChar": { color: "var(--mdt-danger)" },
});

interface DiagnosticState {
  from: number | null;
  to: number;
  deco: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}

const setDiagnosticEffect = StateEffect.define<{ from: number | null; to: number } | null>();

/** Zero-width EOF / missing-token marker (a short danger caret, styled in codemirror.css). */
class InsertionMarker extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-mdt-diag-insert";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

/** Gutter cells (line number, fold) of the error line get `cm-mdt-diag-gutter`. */
class DiagnosticGutterMarker extends GutterMarker {
  elementClass = "cm-mdt-diag-gutter";
}
const diagnosticGutterMarker = new DiagnosticGutterMarker();

/**
 * Parse-error highlight state: wavy-underlined token (or insertion marker),
 * tinted line and gutter marker. Any document change clears it — a stale
 * position would point at the wrong text.
 */
const diagnosticField = StateField.define<DiagnosticState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDiagnosticEffect)) continue;
      if (!e.value) return null;
      const { doc } = tr.state;
      const { from } = e.value;
      if (from === null) return { from: null, to: 0, deco: Decoration.none, gutter: RangeSet.empty };
      const to = Math.max(from, e.value.to);
      const line = doc.lineAt(from);
      const ranges: Range<Decoration>[] = [Decoration.line({ class: "cm-mdt-diag-line" }).range(line.from)];
      ranges.push(
        to > from
          ? Decoration.mark({ class: "cm-mdt-diag-mark" }).range(from, to)
          : Decoration.widget({ widget: new InsertionMarker(), side: 1 }).range(from),
      );
      return { from, to, deco: Decoration.set(ranges, true), gutter: RangeSet.of([diagnosticGutterMarker.range(line.from)]) };
    }
    return tr.docChanged ? null : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v?.deco ?? Decoration.none),
    gutterLineClass.from(f, (v) => v?.gutter ?? RangeSet.empty),
  ],
});

/** Keep scrolled-to ranges (Go to error, cursor) clear of the sticky site header. */
const stickyHeaderMargin = EditorView.scrollMargins.of(() => {
  const header = document.querySelector<HTMLElement>("header.site-header");
  const bottom = header?.getBoundingClientRect().bottom ?? 0;
  return bottom > 0 ? { top: bottom + 8 } : null;
});

/** Creates an editor inside `host` (language chunk loaded on demand). */
export async function createEditor(host: HTMLElement, opts: EditorOptions): Promise<MdtEditor> {
  const language = await loadLanguage(opts.language);
  const indent = new Compartment();
  const readOnly = Boolean(opts.readOnly);

  const keys: KeyBinding[] = [];
  if (opts.onSubmit) {
    const submit = opts.onSubmit;
    keys.push({ key: "Mod-Enter", run: () => (submit(), true), preventDefault: true });
  }
  keys.push(...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap);
  // Tab indents only in editable editors; Esc then Tab leaves (built-in tab focus mode).
  if (!readOnly) keys.push(indentWithTab);

  const attrs: Record<string, string> = { "aria-label": opts.label };
  if (readOnly) attrs["aria-readonly"] = "true";
  // aria-describedby = keyboard hint (+ the error message while a diagnostic is shown).
  const panel = opts.diagnostics;
  const errorId = panel?.box.id;
  const dynamicAttrs = EditorView.contentAttributes.compute([diagnosticField], (state) => {
    const active = state.field(diagnosticField) !== null;
    const ids = [opts.hintId, active ? errorId : undefined].filter(Boolean).join(" ");
    const out: Record<string, string> = {};
    if (ids) out["aria-describedby"] = ids;
    if (active) out["aria-invalid"] = "true";
    return out;
  });

  const onChange = opts.onChange;
  const extensions: Extension[] = [
    lineNumbers(),
    foldGutter(),
    highlightSpecialChars(),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(mdtHighlighter),
    EditorView.lineWrapping,
    indent.of(indentExtensions(opts.indent ?? 2)),
    keymap.of(keys),
    EditorView.contentAttributes.of(attrs),
    dynamicAttrs,
    diagnosticField,
    stickyHeaderMargin,
    mdtTheme,
    language,
  ];
  if (opts.phrases && Object.keys(opts.phrases).length) extensions.push(EditorState.phrases.of(opts.phrases));
  if (readOnly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    // Non-editable content is still focusable so keyboard users can select/copy.
    extensions.push(EditorView.contentAttributes.of({ tabindex: "0" }));
  } else {
    extensions.push(history(), closeBrackets(), indentOnInput());
  }
  if (onChange) {
    extensions.push(EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange();
    }));
  }
  // An edit cleared the highlight (diagnosticField) — sync the message panel.
  extensions.push(EditorView.updateListener.of((u) => {
    if (u.docChanged && u.startState.field(diagnosticField) && !u.state.field(diagnosticField)) onDiagnosticEdited();
  }));

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions }) });

  function revealDiagnostic(): void {
    const d = view.state.field(diagnosticField);
    if (!d || d.from === null) return;
    const range = EditorSelection.range(d.from, d.to);
    // "nearest": the editor scroller (and the page, only if needed) move the minimum.
    view.dispatch({ selection: EditorSelection.create([range]), effects: EditorView.scrollIntoView(range, { y: "nearest", yMargin: 24 }) });
    view.focus(); // CodeMirror focuses with preventScroll
  }

  /** Message panel: text (+ muted raw detail) and a 44px "Go to error" button when the location is known. */
  function renderPanel(d: EditorDiagnostic | null): void {
    host.classList.toggle("is-error", d !== null);
    if (!panel) return;
    const { box } = panel;
    box.classList.remove("is-stale");
    if (!d) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const text = document.createElement("span");
    text.className = "mdt-diag-text";
    const message = document.createElement("span");
    message.className = "mdt-diag-message";
    message.textContent = d.message;
    text.append(message);
    if (d.detail) {
      const detail = document.createElement("span");
      detail.className = "mdt-diag-detail";
      detail.dir = "auto";
      detail.textContent = d.detail;
      text.append(detail);
    }
    box.replaceChildren(text);
    if (d.from !== null) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ds-btn mdt-diag-goto";
      btn.textContent = panel.goToLabel;
      btn.addEventListener("click", revealDiagnostic);
      box.append(btn);
    }
    box.hidden = false;
  }

  function onDiagnosticEdited(): void {
    if (panel?.keepPanelOnEdit && !panel.box.hidden) {
      host.classList.remove("is-error");
      panel.box.classList.add("is-stale");
      panel.box.querySelector<HTMLButtonElement>(".mdt-diag-goto")?.setAttribute("disabled", "");
      return;
    }
    renderPanel(null);
  }
  // Theme switches change fonts/colors only via CSS vars; re-measure anyway.
  new MutationObserver(() => view.requestMeasure()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
    },
    setIndent(style: IndentStyle) {
      view.dispatch({ effects: indent.reconfigure(indentExtensions(style)) });
    },
    focus: () => view.focus(),
    setDiagnostic(d, options) {
      const len = view.state.doc.length;
      const from = d && d.from !== null ? Math.min(Math.max(0, d.from), len) : null;
      const to = from === null ? 0 : Math.min(Math.max(from, d?.to ?? from), len);
      view.dispatch({ effects: setDiagnosticEffect.of(d ? { from, to } : null) });
      renderPanel(d);
      if (d && options?.announce) announce(d.detail ? `${d.message}. ${d.detail}` : d.message);
    },
    revealDiagnostic,
  };
}
