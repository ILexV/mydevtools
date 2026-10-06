/**
 * Password Generator client controller. One-shot WASM generation
 * (`password-client`), settings persisted to localStorage, auto-generate
 * on load when the result is empty, history of the last 10 passwords
 * (newest first) with per-item copy. Legacy parity. Shows the entropy /
 * strength meter of each generated password; an explicit Generate click
 * scrolls the result into view on phones (revealOutput).
 */
import { generatePassword } from "@/scripts/wasm/password-client";
import { copyWithFeedback, prepareCopyButton, revealOutput, syncEmptyState, withPreparing } from "@/scripts/tool-ui";
import { formatPlural } from "@/lib/format";
import {
  alphabetSize,
  entropyBits,
  hasCharset,
  sanitizeSettings,
  strengthFill,
  strengthLevel,
  type PwSettings,
} from "@/tools/password-settings";

interface Strings {
  copy: string;
  copied: string;
  copyFailed: string;
  errorNoCharset: string;
  preparing: string;
  strengthLabel: string;
  /** "{0} bits" (+ optional `entropyBits_<plural>` variants). */
  entropyBits: string;
  /** weak, fair, strong, very strong */
  strengthLevels: string[];
  [key: string]: unknown;
}

const SETTINGS_KEY = "mydevtools.tools.password-generator.settings.v1";
const HISTORY_LIMIT = 10;

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
  const resultInput = root.querySelector<HTMLOutputElement>("[data-pw-result]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-pw-copy]");
  const historyList = root.querySelector<HTMLElement>("[data-pw-history-list]");
  const historyEmpty = root.querySelector<HTMLElement>("[data-pw-history]");
  const clearHistoryBtn = root.querySelector<HTMLButtonElement>("[data-pw-clear-history]");
  const errorBox = root.querySelector<HTMLElement>("[data-pw-error]");
  const strengthBox = root.querySelector<HTMLElement>("[data-pw-strength]");
  const meterEl = root.querySelector<HTMLElement>("[data-pw-meter]");
  const levelEl = root.querySelector<HTMLElement>("[data-pw-strength-level]");
  const entropyEl = root.querySelector<HTMLElement>("[data-pw-entropy]");
  const resultPanel = root.querySelector<HTMLElement>("[data-pw-result-panel]");
  const actionRow = generateBtn?.closest<HTMLElement>(".ds-action-row");
  const lang = document.documentElement.lang || "en";

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
  const resultEl: HTMLOutputElement = resultInput;
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
    let parsed: unknown;
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (!stored) return;
      parsed = JSON.parse(stored);
    } catch {
      return;
    }
    const restored = sanitizeSettings(parsed);
    if (restored.length !== undefined) {
      lengthEl.value = String(restored.length);
      lengthValEl.textContent = String(restored.length);
    }
    if (restored.uppercase !== undefined) upperEl.checked = restored.uppercase;
    if (restored.lowercase !== undefined) lowerEl.checked = restored.lowercase;
    if (restored.numbers !== undefined) numbersEl.checked = restored.numbers;
    if (restored.special !== undefined) specialEl.checked = restored.special;
    if (restored.specialChars !== undefined) specialCharsEl.value = restored.specialChars;
  }

  /** Entropy meter for the password just generated (bits from the settings it used). */
  function renderStrength(settings: PwSettings | null) {
    if (!strengthBox || !meterEl || !levelEl || !entropyEl) return;
    if (!settings) {
      strengthBox.hidden = true;
      return;
    }
    const bits = entropyBits(settings.length, alphabetSize(settings));
    const level = strengthLevel(bits);
    const levelText = strings.strengthLevels[level - 1] ?? "";
    const bitsText = formatPlural(strings, "entropyBits", Math.round(bits), lang);
    meterEl.dataset.level = String(level);
    meterEl.style.setProperty("--ds-meter", String(strengthFill(bits)));
    meterEl.setAttribute("aria-valuenow", String(Math.min(128, Math.round(bits))));
    meterEl.setAttribute("aria-valuetext", `${levelText}, ${bitsText}`);
    levelEl.textContent = levelText;
    entropyEl.textContent = bitsText;
    strengthBox.hidden = false;
  }

  function showError(msg: string) {
    resultEl.value = "";
    renderStrength(null);
    resultEl.setAttribute("aria-invalid", "true");
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }
  function clearError() {
    resultEl.removeAttribute("aria-invalid");
    if (errorBox) errorBox.hidden = true;
  }

  /** History panel: empty state + hidden "Clear history" until a password exists. */
  function syncHistory() {
    const empty = historyListEl.children.length === 0;
    syncEmptyState(historyEmptyEl, empty);
    clearHistoryBtn!.hidden = empty;
  }

  function addToHistory(password: string) {
    // Shared `.ds-result-*` classes: scoped Astro styles never reach this runtime DOM.
    const item = document.createElement("div");
    item.className = "ds-result-row ds-result-row-bare";
    const pass = document.createElement("span");
    pass.className = "ds-result-value";
    pass.textContent = password;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ds-icon-btn";
    btn.setAttribute("aria-label", strings.copy);
    btn.title = strings.copy;
    prepareCopyButton(btn, strings.copied);
    btn.addEventListener("click", () =>
      void copyWithFeedback(btn, password, strings.copied, undefined, { failedLabel: strings.copyFailed }));

    item.append(pass, btn);
    historyListEl.prepend(item);
    while (historyListEl.children.length > HISTORY_LIMIT) {
      historyListEl.lastElementChild?.remove();
    }
    syncHistory();
  }

  /** `reveal` = explicit Generate click (not the auto-run on page load). */
  async function generate(reveal = false) {
    const settings = readSettings();
    saveSettings();

    if (!hasCharset(settings)) {
      showError(strings.errorNoCharset);
      return;
    }

    try {
      const password = await withPreparing(
        "password",
        generatePassword({
          length: settings.length,
          uppercase: settings.uppercase,
          lowercase: settings.lowercase,
          numbers: settings.numbers,
          special: settings.special,
          specialChars: settings.specialChars,
        }),
        { host: actionRow, label: strings.preparing },
      );
      clearError();
      resultEl.value = password;
      renderStrength(settings);
      addToHistory(password);
      if (reveal) revealOutput(resultPanel);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
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
    void generate(true);
  });

  copyBtn.addEventListener("click", () => {
    const value = resultEl.value;
    if (!value) return;
    void copyWithFeedback(copyBtn, value, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });

  clearHistoryBtn.addEventListener("click", () => {
    historyListEl.replaceChildren();
    syncHistory();
    generateBtn.focus();
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
