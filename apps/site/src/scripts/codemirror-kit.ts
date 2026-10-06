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
 * content element.
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
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";
import { tagHighlighter, tags as t } from "@lezer/highlight";

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
}

/** Small editor surface the tool controllers use. */
export interface MdtEditor {
  readonly view: EditorView;
  getValue(): string;
  setValue(text: string): void;
  setIndent(style: IndentStyle): void;
  focus(): void;
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
  if (opts.hintId) attrs["aria-describedby"] = opts.hintId;
  if (readOnly) attrs["aria-readonly"] = "true";

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

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions }) });
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
  };
}
