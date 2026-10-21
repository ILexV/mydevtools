import type { HttpAuth, HttpAuthType } from "@/tools/http-workspace";

export interface AuthEditorStrings {
  AuthType: string;
  AuthInherit: string;
  AuthNone: string;
  AuthBasic: string;
  AuthBearer: string;
  AuthApiKey: string;
  AuthOAuth2: string;
  AuthAwsV4: string;
  AuthUsername: string;
  AuthPassword: string;
  AuthToken: string;
  KeyLabel: string;
  ValueLabel: string;
  AuthAddTo: string;
  AuthInHeader: string;
  AuthInQuery: string;
  AuthTokenUrl: string;
  AuthClientId: string;
  AuthClientSecret: string;
  AuthScope: string;
  AuthClientAuth: string;
  AuthClientAuthHeader: string;
  AuthClientAuthBody: string;
  AuthGetToken: string;
  AuthAccessKey: string;
  AuthSecretKey: string;
  AuthSessionToken: string;
  AuthRegion: string;
  AuthService: string;
  AuthHint: string;
}

export interface AuthEditor {
  element: HTMLElement;
  get(): HttpAuth;
  set(auth: HttpAuth | undefined): void;
  /** Text under the type select while `inherit` is chosen: what it resolves to. */
  setNote(text: string): void;
  /** OAuth token state; null hides it. */
  setTokenStatus(text: string | null, error?: boolean): void;
  setDisabled(disabled: boolean): void;
}

type FieldSpec = { name: string; label: keyof AuthEditorStrings; secret?: boolean; options?: [string, keyof AuthEditorStrings][]; placeholder?: string };

const FIELDS: Record<Exclude<HttpAuthType, "inherit" | "none">, FieldSpec[]> = {
  basic: [{ name: "username", label: "AuthUsername" }, { name: "password", label: "AuthPassword", secret: true }],
  bearer: [{ name: "token", label: "AuthToken", secret: true }],
  apikey: [
    { name: "key", label: "KeyLabel", placeholder: "X-API-Key" },
    { name: "value", label: "ValueLabel", secret: true },
    { name: "in", label: "AuthAddTo", options: [["header", "AuthInHeader"], ["query", "AuthInQuery"]] },
  ],
  oauth2: [
    { name: "tokenUrl", label: "AuthTokenUrl", placeholder: "https://auth.example.com/oauth/token" },
    { name: "clientId", label: "AuthClientId" },
    { name: "clientSecret", label: "AuthClientSecret", secret: true },
    { name: "scope", label: "AuthScope" },
    { name: "clientAuth", label: "AuthClientAuth", options: [["header", "AuthClientAuthHeader"], ["body", "AuthClientAuthBody"]] },
  ],
  awsv4: [
    { name: "accessKey", label: "AuthAccessKey" },
    { name: "secretKey", label: "AuthSecretKey", secret: true },
    { name: "sessionToken", label: "AuthSessionToken", secret: true },
    { name: "region", label: "AuthRegion", placeholder: "us-east-1" },
    { name: "service", label: "AuthService", placeholder: "execute-api" },
  ],
};

const TYPE_LABELS: [HttpAuthType, keyof AuthEditorStrings][] = [
  ["inherit", "AuthInherit"], ["none", "AuthNone"], ["basic", "AuthBasic"], ["bearer", "AuthBearer"],
  ["apikey", "AuthApiKey"], ["oauth2", "AuthOAuth2"], ["awsv4", "AuthAwsV4"],
];

function blankAuth(type: HttpAuthType): HttpAuth {
  switch (type) {
    case "basic": return { type, username: "", password: "" };
    case "bearer": return { type, token: "" };
    case "apikey": return { type, key: "", value: "", in: "header" };
    case "oauth2": return { type, tokenUrl: "", clientId: "", clientSecret: "", scope: "", clientAuth: "header" };
    case "awsv4": return { type, accessKey: "", secretKey: "", sessionToken: "", region: "", service: "" };
    default: return { type };
  }
}

/**
 * Auth tab editor (request and folder settings): type select plus the fields of
 * Basic, Bearer, API key, OAuth 2.0 client credentials and AWS SigV4. Values of
 * other types are kept while switching, so a misclick does not lose them.
 */
export function createAuthEditor(
  strings: AuthEditorStrings,
  idPrefix: string,
  onChange: () => void,
  onGetToken?: () => void,
): AuthEditor {
  const element = document.createElement("div");
  element.className = "http-auth-editor";
  const drafts = new Map<HttpAuthType, HttpAuth>();
  let current: HttpAuth = { type: "inherit" };
  let disabled = false;

  const typeField = document.createElement("label");
  typeField.className = "http-auth-field http-auth-type";
  const typeLabel = document.createElement("span");
  typeLabel.textContent = strings.AuthType;
  const typeSelect = document.createElement("select");
  typeSelect.className = "ds-field-select";
  for (const [type, label] of TYPE_LABELS) typeSelect.append(new Option(strings[label], type));
  typeField.append(typeLabel, typeSelect);
  const note = document.createElement("p");
  note.className = "ds-hint http-auth-note";
  note.hidden = true;
  const fields = document.createElement("div");
  fields.className = "http-auth-fields";
  const tokenRow = document.createElement("div");
  tokenRow.className = "http-auth-token";
  const tokenButton = document.createElement("button");
  tokenButton.type = "button";
  tokenButton.className = "ds-btn ds-btn-small";
  tokenButton.textContent = strings.AuthGetToken;
  const tokenStatus = document.createElement("p");
  tokenStatus.className = "ds-hint http-auth-token-status";
  tokenStatus.setAttribute("role", "status");
  tokenStatus.hidden = true;
  tokenRow.append(tokenButton, tokenStatus);
  tokenButton.addEventListener("click", () => onGetToken?.());
  const hint = document.createElement("p");
  hint.className = "ds-hint http-auth-hint";
  hint.textContent = strings.AuthHint;
  element.append(typeField, note, fields, tokenRow, hint);

  function render(): void {
    typeSelect.value = current.type;
    const specs = current.type === "inherit" || current.type === "none" ? [] : FIELDS[current.type];
    const record = current as unknown as Record<string, string>;
    fields.replaceChildren(...specs.map((spec) => {
      const id = `${idPrefix}-${spec.name}`;
      const wrapper = document.createElement("div");
      wrapper.className = "http-auth-field";
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = strings[spec.label];
      let control: HTMLInputElement | HTMLSelectElement;
      if (spec.options) {
        control = document.createElement("select");
        control.className = "ds-field-select";
        for (const [value, text] of spec.options) control.append(new Option(strings[text], value));
      } else {
        control = document.createElement("input");
        control.type = spec.secret ? "password" : "text";
        control.className = "ds-field mono";
        control.autocomplete = spec.secret ? "new-password" : "off";
        control.spellcheck = false;
        if (spec.placeholder) control.placeholder = spec.placeholder;
      }
      control.id = id;
      control.value = record[spec.name] ?? "";
      control.disabled = disabled;
      control.addEventListener(spec.options ? "change" : "input", () => {
        record[spec.name] = control.value;
        onChange();
      });
      wrapper.append(label, control);
      return wrapper;
    }));
    tokenRow.hidden = current.type !== "oauth2" || !onGetToken;
    note.hidden = !note.textContent || current.type !== "inherit";
    hint.hidden = current.type === "inherit" || current.type === "none";
  }

  typeSelect.addEventListener("change", () => {
    drafts.set(current.type, current);
    const type = typeSelect.value as HttpAuthType;
    current = drafts.get(type) ?? blankAuth(type);
    render();
    onChange();
  });

  render();
  return {
    element,
    get: () => structuredClone(current),
    set(auth) {
      drafts.clear();
      current = structuredClone(auth ?? { type: "inherit" });
      render();
    },
    setNote(text) {
      note.textContent = text;
      note.hidden = !text || current.type !== "inherit";
    },
    setTokenStatus(text, error = false) {
      tokenStatus.textContent = text ?? "";
      tokenStatus.hidden = !text;
      tokenStatus.classList.toggle("is-error", error);
    },
    setDisabled(value) {
      disabled = value;
      typeSelect.disabled = value;
      tokenButton.disabled = value;
      for (const control of fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) control.disabled = value;
    },
  };
}
