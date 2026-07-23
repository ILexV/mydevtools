/**
 * Lorem Ipsum Generator client controller. Drives the `LoremIpsumGenerator.astro`
 * shell: reads the controls, calls `generateLorem`, writes output + stats, and
 * wires copy/download. SSR-safe — no-ops when the shell is absent. All UI text
 * comes from the `data-lorem-strings` island.
 */
import { generateLorem, type LoremFormat, type LoremType } from "@/tools/lorem-ipsum";

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
  if (!root) return;
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
  const generateBtn = root.querySelector<HTMLButtonElement>("[data-li-generate]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-li-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-li-download]");
  if (!typeEl || !countEl || !formatEl || !outputEl) return;
  const type = typeEl;
  const count = countEl;
  const format = formatEl;
  const output = outputEl;

  function generate(): void {
    const result = generateLorem({
      type: type.value as LoremType,
      count: parseInt(count.value, 10) || 5,
      format: format.value as LoremFormat,
      startClassic: !!classicEl?.checked,
      wrapParagraphs: !!wrapEl?.checked,
    });
    output.value = result.text;
    if (wordsEl) wordsEl.textContent = String(result.words);
    if (charsEl) charsEl.textContent = String(result.chars);
  }

  generateBtn?.addEventListener("click", generate);
  type.addEventListener("change", generate);
  format.addEventListener("change", generate);
  classicEl?.addEventListener("change", generate);
  wrapEl?.addEventListener("change", generate);
  count.addEventListener("input", generate);

  copyBtn?.addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(output.value);
      const btn = e.currentTarget as HTMLButtonElement;
      const orig = btn.textContent;
      btn.textContent = strings.copied;
      setTimeout(() => {
        btn.textContent = orig;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
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
    URL.revokeObjectURL(url);
  });

  generate();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
