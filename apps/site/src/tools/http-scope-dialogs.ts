import { createAuthEditor, type AuthEditorStrings } from "@/tools/http-auth-editor";
import { createRowsEditor, type RowsEditorStrings } from "@/tools/http-rows-editor";
import type { HttpWorkspace } from "@/tools/http-workspace";

export interface ScopeDialogStrings extends RowsEditorStrings, AuthEditorStrings {
  GlobalVariables: string;
  NewEnvironment: string;
  NewEnvironmentName: string;
  EnvironmentName: string;
  DuplicateEnvironment: string;
  DeleteEnvironment: string;
  DeleteEnvironmentConfirm: string;
  CopySuffix: string;
  Variables: string;
  FolderSettingsTitle: string;
  AuthInheritParent: string;
}

interface ScopeDialogOptions {
  strings: ScopeDialogStrings;
  workspace(): HttpWorkspace;
  newId(): string;
  /** The workspace was edited in place: save it and refresh dependent UI. */
  changed(): void;
}

function onClose(dialog: HTMLDialogElement, close: HTMLButtonElement): (trigger: HTMLElement) => void {
  let returnFocus: HTMLElement | null = null;
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const target = returnFocus;
    returnFocus = null;
    queueMicrotask(() => { if (target?.isConnected) target.focus(); });
  });
  return (trigger) => { returnFocus = trigger; };
}

/**
 * «Environments» window of the HTTP client: global variables and named
 * environments (create, rename, duplicate, delete) with their `{{var}}` rows.
 * Edits go straight into the workspace and are saved like request edits.
 */
export function bindEnvironmentsDialog(dialog: HTMLDialogElement, options: ScopeDialogOptions): {
  open(trigger: HTMLElement, environmentId?: string | null): void;
} {
  const s = options.strings;
  const set = dialog.querySelector<HTMLSelectElement>("[data-http-env-set]")!;
  const create = dialog.querySelector<HTMLButtonElement>("[data-http-env-new]")!;
  const nameRow = dialog.querySelector<HTMLElement>("[data-http-env-name-row]")!;
  const name = dialog.querySelector<HTMLInputElement>("[data-http-env-name]")!;
  const duplicate = dialog.querySelector<HTMLButtonElement>("[data-http-env-duplicate]")!;
  const remove = dialog.querySelector<HTMLButtonElement>("[data-http-env-delete]")!;
  const rowsHost = dialog.querySelector<HTMLElement>("[data-http-env-rows]")!;
  const remember = onClose(dialog, dialog.querySelector<HTMLButtonElement>("[data-http-env-close]")!);
  let selected = "";

  const environment = () => options.workspace().environments?.find((entry) => entry.id === selected);
  const rows = createRowsEditor(s, s.Variables, () => {
    const workspace = options.workspace();
    const target = environment();
    if (target) target.variables = rows.read();
    else workspace.globals = rows.read();
    options.changed();
  });
  rowsHost.replaceChildren(rows.element);

  function render(focusName = false): void {
    const workspace = options.workspace();
    const environments = workspace.environments ?? [];
    if (selected && !environments.some((entry) => entry.id === selected)) selected = "";
    set.replaceChildren(new Option(s.GlobalVariables, ""),
      ...environments.map((entry) => new Option(entry.name || s.NewEnvironmentName, entry.id)));
    set.value = selected;
    const target = environment();
    nameRow.hidden = !target;
    name.value = target?.name ?? "";
    rows.replace(target ? target.variables : workspace.globals ?? []);
    if (focusName) {
      name.focus();
      name.select();
    }
  }

  function addEnvironment(nameText: string, variables: HttpWorkspace["globals"] = []): void {
    const workspace = options.workspace();
    const entry = { id: options.newId(), name: nameText, variables: structuredClone(variables ?? []) };
    workspace.environments = [...(workspace.environments ?? []), entry];
    selected = entry.id;
    options.changed();
    render(true);
  }

  set.addEventListener("change", () => {
    selected = set.value;
    render();
  });
  create.addEventListener("click", () => addEnvironment(s.NewEnvironmentName));
  duplicate.addEventListener("click", () => {
    const target = environment();
    if (target) addEnvironment(`${target.name} ${s.CopySuffix}`, target.variables);
  });
  name.addEventListener("input", () => {
    const target = environment();
    if (!target) return;
    target.name = name.value;
    set.selectedOptions[0]!.textContent = name.value || s.NewEnvironmentName;
    options.changed();
  });
  remove.addEventListener("click", () => {
    const target = environment();
    if (!target || !window.confirm(s.DeleteEnvironmentConfirm.replace("{name}", target.name))) return;
    const workspace = options.workspace();
    workspace.environments = (workspace.environments ?? []).filter((entry) => entry.id !== target.id);
    if (workspace.activeEnvironmentId === target.id) workspace.activeEnvironmentId = null;
    selected = "";
    options.changed();
    render();
    set.focus();
  });

  return {
    open(trigger, environmentId = null) {
      if (dialog.open) return;
      remember(trigger);
      selected = environmentId ?? "";
      render();
      dialog.showModal();
      set.focus();
    },
  };
}

/**
 * Folder settings of the HTTP client tree: the folder's Auth (inherited by its
 * requests and subfolders) and its collection variables.
 */
export function bindFolderDialog(dialog: HTMLDialogElement, options: ScopeDialogOptions): {
  open(trigger: HTMLElement, folderId: string): void;
} {
  const s = options.strings;
  const title = dialog.querySelector<HTMLElement>("[data-http-folder-title]")!;
  const authHost = dialog.querySelector<HTMLElement>("[data-http-folder-auth]")!;
  const rowsHost = dialog.querySelector<HTMLElement>("[data-http-folder-rows]")!;
  const remember = onClose(dialog, dialog.querySelector<HTMLButtonElement>("[data-http-folder-close]")!);
  let folderId = "";
  const folder = () => options.workspace().folders.find((entry) => entry.id === folderId);
  const auth = createAuthEditor(s, "http-folder-auth", () => {
    const target = folder();
    if (!target) return;
    target.auth = auth.get();
    options.changed();
  });
  const rows = createRowsEditor(s, s.Variables, () => {
    const target = folder();
    if (!target) return;
    target.variables = rows.read();
    options.changed();
  });
  authHost.replaceChildren(auth.element);
  rowsHost.replaceChildren(rows.element);

  return {
    open(trigger, id) {
      folderId = id;
      const target = folder();
      if (!target || dialog.open) return;
      remember(trigger);
      title.textContent = s.FolderSettingsTitle.replace("{name}", target.name);
      auth.set(target.auth);
      auth.setNote(s.AuthInheritParent);
      rows.replace(target.variables ?? []);
      dialog.showModal();
      dialog.querySelector<HTMLSelectElement>("select")?.focus();
    },
  };
}
