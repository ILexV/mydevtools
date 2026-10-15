/**
 * Whether a desktop window holds input the user would lose by closing it.
 * Tool pages do not persist field text or files. Readonly output and buttons
 * do not count. The DOM walk lives in the shell; this predicate is the rule.
 */

export interface InputSnapshot {
  fileCount: number;
  /** Editable text fields and textareas, not readonly output. */
  texts: readonly string[];
  /** CodeMirror documents (`.cm-content`). */
  editors: readonly string[];
}

export function hasUserInput(snapshot: InputSnapshot): boolean {
  if (snapshot.fileCount > 0) return true;
  if (snapshot.texts.some((value) => value.trim().length > 0)) return true;
  if (snapshot.editors.some((value) => value.trim().length > 0)) return true;
  return false;
}
