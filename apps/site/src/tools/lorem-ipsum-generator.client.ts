/**
 * Lorem Ipsum Generator client controller. Drives the `LoremIpsumGenerator.astro`
 * shell: reads the controls, calls `generateLorem`, writes output + stats, and
 * wires copy/download. SSR-safe — no-ops when the shell is absent. All UI text
 * comes from the `data-lorem-strings` island.
 */
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { generateLorem, clampCount, type LoremFormat, type LoremType } from "@/tools/lorem-ipsum";
import { copyWithFeedback, revealOutput } from "@/scripts/tool-ui";
import { formatPlural } from "@/lib/format";

interface Strings {
  generateTypeLabel: string;
  paragraphs: string;
  sentences: string;
  words: string;
  countLabel: string;
  startWithClassic: string;
  wrapParagraphs: string;
  generateButton: string;
  outputLabel: string;
  copyButton: string;
  downloadButton: string;
  copied: string;
  copyFailed: string;
  lang: string;
  wordsStat: string;
  characters: string;
  /** Optional plural variants (`wordsStat_one`, `characters_few`, …). */
  [key: string]: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-lorem-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-lorem-tool]");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "1";
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const typeEl = root.querySelector<HTMLSelectElement>("[data-li-type]");
  const countEl = root.querySelector<HTMLInputElement>("[data-li-count]");
  const formatEl = root.querySelector<HTMLSelectElement>("[data-li-format]");
  const classicEl = root.querySelector<HTMLInputElement>("[data-li-classic]");
  const wrapEl = root.querySelector<HTMLInputElement>("[data-li-wrap]");
  const outputEl = root.querySelector<HTMLTextAreaElement>("[data-li-output]");
  const wordsEl = root.querySelector<HTMLElement>("[data-li-words]");
  const charsEl = root.querySelector<HTMLElement>("[data-li-chars]");
  const wordsLabelEl = root.querySelector<HTMLElement>("[data-li-words-label]");
  const charsLabelEl = root.querySelector<HTMLElement>("[data-li-chars-label]");
  const generateBtn = root.querySelector<HTMLButtonElement>("[data-li-generate]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-li-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-li-download]");
  const errorEl = root.querySelector<HTMLElement>("[data-li-error]");
  if (!typeEl || !countEl || !formatEl || !outputEl) return;
  const type = typeEl;
  const count = countEl;
  const format = formatEl;
  const output = outputEl;

  const nf = new Intl.NumberFormat(strings.lang);

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function generate(explicit = false): void {
    // <p> wrapping only applies to HTML paragraphs — grey the toggle out otherwise.
    if (wrapEl) wrapEl.disabled = !(format.value === "html" && type.value === "paragraphs");
    const operation = explicit ? startToolOperation("lorem-ipsum-generator") : null;
    try {
      const result = generateLorem({
        type: type.value as LoremType,
        count: count.value.trim() === "" ? NaN : Number(count.value),
        format: format.value as LoremFormat,
        startClassic: !!classicEl?.checked,
        wrapParagraphs: !!wrapEl?.checked,
      });
      output.value = result.text;
      if (wordsEl) wordsEl.textContent = nf.format(result.words);
      if (charsEl) charsEl.textContent = nf.format(result.chars);
      // "1 слово / 3 слова / 5 слов": label follows the locale's plural category.
      if (wordsLabelEl) wordsLabelEl.textContent = formatPlural(strings, "wordsStat", result.words, strings.lang);
      if (charsLabelEl) charsLabelEl.textContent = formatPlural(strings, "characters", result.chars, strings.lang);
      operation?.complete();
    } catch (error) {
      operation?.fail();
      throw error;
    }
  }

  generateBtn?.addEventListener("click", () => {
    generate(true);
    // Explicit Generate only; live option changes never scroll or emit analytics.
    revealOutput(output.closest<HTMLElement>(".ds-card, .ds-output"));
  });
  type.addEventListener("change", () => generate());
  format.addEventListener("change", () => generate());
  classicEl?.addEventListener("change", () => generate());
  wrapEl?.addEventListener("change", () => generate());
  count.addEventListener("input", () => generate());
  // Reflect the effective (clamped) count once editing is done: 0 → 1, 5000 → 1000.
  count.addEventListener("change", () => {
    if (count.value.trim() !== "") count.value = String(clampCount(Number(count.value)));
  });

  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, output.value, strings.copied);
    showError(ok ? "" : strings.copyFailed);
  });

  downloadBtn?.addEventListener("click", () => {
    const blob = new Blob([output.value], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lorem-ipsum.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  generate();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
