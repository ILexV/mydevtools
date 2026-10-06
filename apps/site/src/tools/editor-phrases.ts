/**
 * Localized CodeMirror 6 UI phrases (fold markers, search/replace panel,
 * go-to-line, screen-reader announcements) for the structured-data editor
 * tools. Build-time only: the .astro shells put the result into their JSON
 * island and pass it to `createEditor({ phrases })` → `EditorState.phrases`.
 * Strings live once in `tools/json-beautifier` (keys `Editor_*`) and are
 * shared by json/xml/yaml beautifiers and json-to-typescript.
 */
import { t } from "@/i18n/messages";
import type { LocaleCode } from "@/registry/locales";

/** CodeMirror source phrase → locale key. */
const PHRASE_KEYS: Record<string, string> = {
  "Fold line": "Editor_FoldLine",
  "Unfold line": "Editor_UnfoldLine",
  "Folded lines": "Editor_FoldedLines",
  "Unfolded lines": "Editor_UnfoldedLines",
  to: "Editor_To",
  "folded code": "Editor_FoldedCode",
  unfold: "Editor_Unfold",
  Find: "Editor_Find",
  Replace: "Editor_ReplacePlaceholder",
  next: "Editor_Next",
  previous: "Editor_Previous",
  all: "Editor_All",
  "match case": "Editor_MatchCase",
  regexp: "Editor_Regexp",
  "by word": "Editor_ByWord",
  replace: "Editor_Replace",
  "replace all": "Editor_ReplaceAll",
  close: "Editor_Close",
  "current match": "Editor_CurrentMatch",
  "on line": "Editor_OnLine",
  "replaced match on line $": "Editor_ReplacedMatchOnLine",
  "replaced $ matches": "Editor_ReplacedMatches",
  "Go to line": "Editor_GoToLine",
  go: "Editor_Go",
  "Control character": "Editor_ControlCharacter",
  "Selection deleted": "Editor_SelectionDeleted",
};

/** Phrase map for `EditorState.phrases` (empty for English — CodeMirror's own strings). */
export function editorPhrases(lang: LocaleCode): Record<string, string> {
  if (lang === "en") return {};
  const out: Record<string, string> = {};
  for (const [phrase, key] of Object.entries(PHRASE_KEYS)) out[phrase] = t(lang, "tools/json-beautifier", key);
  return out;
}
