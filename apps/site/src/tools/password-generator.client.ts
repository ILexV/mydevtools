/**
 * Password Generator client controller. One-shot WASM generation
 * (`password-client`), settings persisted to localStorage, auto-generate
 * on load when the result is empty, history of the last 10 passwords
 * (newest first) with per-item copy. Legacy parity.
 */
import { generatePassword } from "@/scripts/wasm/password-client";

interface Strings {
  copy: string;
  copied: string;
  errorNoCharset: string;
}

interface PwSettings {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  specialChars: string;
}

const SETTINGS_KEY = "mydevtools.tools.password-generator.settings.v1";
const HISTORY_LIMIT = 10;
const COPY_FEEDBACK_MS = 1200;

const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" /></svg>';
const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>';

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-pw-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-pw-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const lengthInput = root.querySelector<HTMLInputElement>("[data-pw-length]");
  const lengthVal = root.querySelector<HTMLElement>("[data-pw-length-val]");
  const chkUpper = root.querySelector<HTMLInputElement>("[data-pw-uppercase]");
  const chkLower = root.querySelector<HTMLInputElement>("[data-pw-lowercase]");
  const chkNumbers = root.querySelector<HTMLInputElement>("[data-pw-numbers]");
  const chkSpecial = root.querySelector<HTMLInputElement>("[data-pw-special]");
  const specialCharsInput = root.querySelector<HTMLInputElement>("[data-pw-special-chars]");
  const generateBtn = root.querySelector<HTMLButtonElement>("[data-pw-generate]");
  const resultInput = root.querySelector<HTMLInputElement>("[data-pw-result]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-pw-copy]");
  const historyList = root.querySelector<HTMLElement>("[data-pw-history-list]");
  const historyEmpty = root.querySelector<HTMLElement>("[data-pw-history-empty]");
  const clearHistoryBtn = root.querySelector<HTMLButtonElement>("[data-pw-clear-history]");

  if (
    !lengthInput ||
    !lengthVal ||
    !chkUpper ||
    !chkLower ||
    !chkNumbers ||
    !chkSpecial ||
    !specialCharsInput ||
    !generateBtn ||
    !resultInput ||
    !copyBtn ||
    !historyList ||
    !historyEmpty ||
    !clearHistoryBtn
  ) {
    return;
  }

  const lengthEl: HTMLInputElement = lengthInput;
  const lengthValEl: HTMLElement = lengthVal;
  const upperEl: HTMLInputElement = chkUpper;
  const lowerEl: HTMLInputElement = chkLower;
  const numbersEl: HTMLInputElement = chkNumbers;
  const specialEl: HTMLInputElement = chkSpecial;
  const specialCharsEl: HTMLInputElement = specialCharsInput;
  const resultEl: HTMLInputElement = resultInput;
  const historyListEl: HTMLElement = historyList;
  const historyEmptyEl: HTMLElement = historyEmpty;

  function readSettings(): PwSettings {
    return {
      length: parseInt(lengthEl.value, 10),
      uppercase: upperEl.checked,
      lowercase: lowerEl.checked,
      numbers: numbersEl.checked,
      special: specialEl.checked,
      specialChars: specialCharsEl.value,
    };
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
    } catch {
      /* storage unavailable */
    }
  }

  function loadSettings() {
    let parsed: Partial<PwSettings>;
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (!stored) return;
      parsed = JSON.parse(stored) as Partial<PwSettings>;
    } catch {
      return;
    }
    if (typeof parsed.length === "number" && Number.isFinite(parsed.length)) {
      const clamped = Math.min(128, Math.max(4, Math.round(parsed.length)));
      lengthEl.value = String(clamped);
      lengthValEl.textContent = String(clamped);
    }
    if (typeof parsed.uppercase === "boolean") upperEl.checked = parsed.uppercase;
    if (typeof parsed.lowercase === "boolean") lowerEl.checked = parsed.lowercase;
    if (typeof parsed.numbers === "boolean") numbersEl.checked = parsed.numbers;
    if (typeof parsed.special === "boolean") specialEl.checked = parsed.special;
    if (typeof parsed.specialChars === "string") specialCharsEl.value = parsed.specialChars;
  }

  function addToHistory(password: string) {
    historyEmptyEl.hidden = true;

    const item = document.createElement("li");
    const pass = document.createElement("span");
    pass.className = "pw-history-pass";
    pass.textContent = password;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-history-copy";
    btn.title = strings.copy;
    btn.setAttribute("aria-label", strings.copy);
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(password);
        const original = btn.innerHTML;
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => {
          btn.innerHTML = original;
        }, COPY_FEEDBACK_MS);
      } catch {
        /* clipboard unavailable */
      }
    });

    item.append(pass, btn);
    historyListEl.prepend(item);
    while (historyListEl.children.length > HISTORY_LIMIT) {
      historyListEl.lastElementChild?.remove();
    }
  }

  async function generate() {
    const settings = readSettings();
    saveSettings();

    if (!settings.uppercase && !settings.lowercase && !settings.numbers && !settings.special) {
      resultEl.value = strings.errorNoCharset;
      return;
    }

    try {
      const password = await generatePassword({
        length: settings.length,
        uppercase: settings.uppercase,
        lowercase: settings.lowercase,
        numbers: settings.numbers,
        special: settings.special,
        specialChars: settings.specialChars,
      });
      resultEl.value = password;
      addToHistory(password);
    } catch (e) {
      resultEl.value = e instanceof Error ? e.message : String(e);
    }
  }

  lengthEl.addEventListener("input", () => {
    lengthValEl.textContent = lengthEl.value;
    saveSettings();
  });
  specialCharsEl.addEventListener("input", saveSettings);
  for (const chk of [upperEl, lowerEl, numbersEl, specialEl]) {
    chk.addEventListener("change", saveSettings);
  }

  generateBtn.addEventListener("click", () => {
    void generate();
  });

  copyBtn.addEventListener("click", async () => {
    const value = resultEl.value;
    if (!value || value === strings.errorNoCharset) return;
    try {
      await navigator.clipboard.writeText(value);
      const original = copyBtn.textContent;
      copyBtn.textContent = strings.copied;
      setTimeout(() => {
        copyBtn.textContent = original;
      }, COPY_FEEDBACK_MS);
    } catch {
      /* clipboard unavailable */
    }
  });

  clearHistoryBtn.addEventListener("click", () => {
    historyListEl.replaceChildren();
    historyEmptyEl.hidden = false;
  });

  loadSettings();

  // Generate an initial password on load when the result is empty (legacy).
  if (!resultEl.value) {
    void generate();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
