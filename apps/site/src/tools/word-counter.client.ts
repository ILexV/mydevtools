/**
 * Word Counter client. Recomputes stats on every input (rules in
 * `word-stats.ts`). Pure JS, no network. Paste/copy go through the Clipboard
 * API; failures surface a localized error instead of failing silently.
 * Empty textarea shows a hint + "Load example" (localized sample text, on click only).
 */
import { computeStats, readingMinutes } from "@/tools/word-stats";
import { bindEmptyState, bindLoadExample, copyWithFeedback, setFieldValue } from "@/scripts/tool-ui";

interface Strings {
  copied: string;
  copyFailed: string;
  copyFailedShort?: string;
  pasteFailed: string;
  minutes: string;
  example?: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-wc-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-wc-tool]");
  if (!root) return;
  const raw = readStrings();
  const textareaEl = root.querySelector<HTMLTextAreaElement>("[data-wc-textarea]");
  if (!raw || !textareaEl) return;
  const strings: Strings = raw;
  const textarea = textareaEl;
  const errorEl = root.querySelector<HTMLElement>("[data-wc-error]");

  const els = {
    words: root.querySelector<HTMLElement>("[data-wc-words]"),
    charsSpaces: root.querySelector<HTMLElement>("[data-wc-chars-spaces]"),
    charsNoSpaces: root.querySelector<HTMLElement>("[data-wc-chars-nospaces]"),
    lines: root.querySelector<HTMLElement>("[data-wc-lines]"),
    paragraphs: root.querySelector<HTMLElement>("[data-wc-paragraphs]"),
    sentences: root.querySelector<HTMLElement>("[data-wc-sentences]"),
    reading: root.querySelector<HTMLElement>("[data-wc-reading]"),
    speaking: root.querySelector<HTMLElement>("[data-wc-speaking]"),
  };
  const inputHost = root.querySelector<HTMLElement>("[data-wc-input-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-wc-example]");
  const syncInput = inputHost ? bindEmptyState(inputHost, textarea) : () => {};
  if (exampleBtn && strings.example) {
    const sample = strings.example;
    bindLoadExample(exampleBtn, () => setFieldValue(textarea, sample));
  }
  const nf = new Intl.NumberFormat(document.documentElement.lang || undefined);

  function showError(message: string | null) {
    if (!errorEl) return;
    errorEl.textContent = message ?? "";
    errorEl.hidden = message === null;
  }

  function render() {
    const s = computeStats(textarea.value);
    if (els.words) els.words.textContent = nf.format(s.words);
    if (els.charsSpaces) els.charsSpaces.textContent = nf.format(s.charsSpaces);
    if (els.charsNoSpaces) els.charsNoSpaces.textContent = nf.format(s.charsNoSpaces);
    if (els.lines) els.lines.textContent = nf.format(s.lines);
    if (els.paragraphs) els.paragraphs.textContent = nf.format(s.paragraphs);
    if (els.sentences) els.sentences.textContent = nf.format(s.sentences);
    if (els.reading) els.reading.textContent = `${nf.format(readingMinutes(s.words, 200))} ${strings.minutes}`;
    if (els.speaking) els.speaking.textContent = `${nf.format(readingMinutes(s.words, 130))} ${strings.minutes}`;
  }

  textarea.addEventListener("input", () => {
    showError(null);
    render();
  });

  root.querySelector<HTMLButtonElement>("[data-wc-clear]")?.addEventListener("click", () => {
    textarea.value = "";
    syncInput();
    showError(null);
    render();
    textarea.focus();
  });

  const copyBtn = root.querySelector<HTMLButtonElement>("[data-wc-copy]");
  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, textarea.value, strings.copied, undefined, {
      failedLabel: strings.copyFailedShort,
    });
    showError(ok ? null : strings.copyFailed);
  });

  root.querySelector<HTMLButtonElement>("[data-wc-paste]")?.addEventListener("click", async () => {
    try {
      textarea.value = await navigator.clipboard.readText();
      syncInput();
      showError(null);
      render();
    } catch {
      showError(strings.pasteFailed);
    }
  });

  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
