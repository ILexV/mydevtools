/**
 * Closing protects changed input, not defaults, generated output or saved settings.
 * Snapshots stay in memory and use element identity (fields may be added/reordered).
 */
import type { Text } from "@codemirror/state";

export interface InputSnapshot {
  fileCount: number;
  values: ReadonlyMap<object, string | Text>;
}

export function hasUserInput(current: InputSnapshot, initial: InputSnapshot): boolean {
  if (current.fileCount > 0) return true;
  for (const [field, value] of current.values) {
    const before = initial.values.get(field);
    if (typeof value === "string") {
      if (value !== before && value.trim().length > 0) return true;
    } else if (value !== before && !(before && typeof before !== "string" && value.eq(before))) {
      // CodeMirror documents are immutable; inspect chunks without copying the document.
      for (const chunk of value.iter()) {
        if (chunk.trim().length > 0) return true;
      }
    }
  }
  return false;
}

/** Install once per loaded tool document; unloading the iframe releases all state. */
export function trackUserInput(doc: Document): () => boolean {
  let initial = snapshotInput(doc);
  let interacted = false;
  const beforeAction = (event: Event) => {
    if (interacted || !event.isTrusted) return;
    // Capture late initialization / restored preferences before the first user action.
    initial = snapshotInput(doc);
    interacted = true;
  };
  const afterAction = (event: Event) => {
    // File pickers/autofill can dispatch input without a preceding key/pointer event.
    if (event.isTrusted) interacted = true;
  };
  const beforeTransferredInput = () => {
    if (interacted) return;
    // Transfer is an explicit user action, but its DOM write is synthetic.
    // Capture the untouched target first so close protection sees the payload.
    initial = snapshotInput(doc);
    interacted = true;
  };
  for (const type of ["pointerdown", "keydown", "beforeinput", "paste", "drop"]) {
    doc.addEventListener(type, beforeAction, true);
  }
  for (const type of ["input", "change"]) doc.addEventListener(type, afterAction, true);
  doc.addEventListener("mdt:transferred-input", beforeTransferredInput, true);
  return () => interacted && hasUserInput(snapshotInput(doc), initial);
}

function snapshotInput(doc: Document): InputSnapshot {
  const values = new Map<object, string | Text>();
  // Dropzones retain files in controller memory even when their native input is reset.
  let fileCount = doc.querySelectorAll(".ds-dropzone.has-file").length;
  for (const input of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
    if (input.readOnly || input.disabled || input.closest(".cm-panels")) continue;
    if (input.tagName === "INPUT") {
      const field = input as HTMLInputElement;
      if (field.type === "file") {
        fileCount += field.files?.length ?? 0;
        continue;
      }
      if (["hidden", "checkbox", "radio", "button", "submit", "reset", "range", "color", "search"].includes(field.type)) continue;
    }
    values.set(input, input.value);
  }
  // Read the full model, not the virtualized viewport; readonly output never responds.
  for (const editor of doc.querySelectorAll('.cm-content[contenteditable="true"]')) {
    editor.dispatchEvent(new CustomEvent("mdt:input-snapshot", { detail: values }));
  }
  return { fileCount, values };
}
