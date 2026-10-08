/**
 * Home hero "text lab": live Base64 / URL / Hex / SHA-256 of the visitor's
 * text, computed locally (see lib/hero-lab.ts). Input is never persisted or
 * sent anywhere. Plays one short typing demo if the visitor hasn't touched
 * the panel, fires `mdt:lab-input` for the prism canvas and flashes a row
 * when its packet arrives (`mdt:prism-hit`).
 */
import { computeLab, LAB_KINDS, type LabKind } from "@/lib/hero-lab";
import { formatString } from "@/lib/format";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { whenIdle } from "@/scripts/idle";

interface LabStrings {
  copied: string;
  bytes: string;
  samples: string[];
}

export function initHeroLab(band: HTMLElement): void {
  const root = band.querySelector<HTMLElement>("[data-hero-lab]");
  const input = root?.querySelector<HTMLTextAreaElement>("[data-lab-input]");
  const island = root?.querySelector<HTMLScriptElement>("[data-lab-strings]");
  if (!root || !input || !island || root.dataset.bound) return;
  root.dataset.bound = "1";

  const strings = JSON.parse(island.textContent || "{}") as LabStrings;
  const outs = new Map<LabKind, HTMLElement>();
  for (const kind of LAB_KINDS) {
    const el = root.querySelector<HTMLElement>(`[data-lab-out="${kind}"]`);
    if (el) outs.set(kind, el);
  }
  const bytesEl = root.querySelector<HTMLElement>("[data-lab-bytes]");
  const nextBtn = root.querySelector<HTMLButtonElement>("[data-lab-next]");
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-lab-row]"));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let seq = 0;
  let sampleIdx = 0;
  let demoTimer = 0;
  let touched = false;

  async function render(): Promise<void> {
    const id = ++seq;
    const r = await computeLab(input!.value);
    if (id !== seq) return; // a newer keystroke already rendered
    for (const kind of LAB_KINDS) {
      const el = outs.get(kind);
      if (!el) continue;
      const v = r[kind] ?? "—";
      el.textContent = v;
      el.title = v;
    }
    if (bytesEl) bytesEl.textContent = formatString(strings.bytes, r.bytes);
    band.dispatchEvent(new CustomEvent("mdt:lab-input"));
  }

  function stopDemo(): void {
    touched = true;
    window.clearTimeout(demoTimer);
  }

  function setText(text: string): void {
    input!.value = text;
    void render();
  }

  input.readOnly = false;
  input.addEventListener("input", () => {
    stopDemo();
    void render();
  });
  root.addEventListener("pointerdown", stopDemo);
  root.addEventListener("focusin", stopDemo);

  for (const el of root.querySelectorAll<HTMLElement>("[data-lab-enhance]")) el.hidden = false;

  nextBtn?.addEventListener("click", () => {
    if (!strings.samples.length) return;
    sampleIdx = (sampleIdx + 1) % strings.samples.length;
    setText(strings.samples[sampleIdx]);
  });

  root.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-lab-copy]");
    if (!btn) return;
    const kind = btn.dataset.labCopy as LabKind;
    const text = outs.get(kind)?.textContent ?? "";
    if (text && text !== "—") void copyWithFeedback(btn, text, strings.copied);
  });

  band.addEventListener("mdt:prism-hit", (e) => {
    const row = rows[(e as CustomEvent<{ row: number }>).detail.row];
    if (!row) return;
    row.classList.remove("is-hit");
    void row.offsetWidth; // restart the flash animation
    row.classList.add("is-hit");
  });

  // One-shot demo: type the multilingual sample so the outputs visibly react.
  const demo = strings.samples[1];
  // Starts once the page is idle: the typing burst must not land in the load window.
  if (demo && !reduced.matches) whenIdle(() => {
    if (touched) return;
    demoTimer = window.setTimeout(() => {
      if (touched) return;
      const chars = Array.from(demo);
      let i = 0;
      sampleIdx = 1;
      const tick = () => {
        if (touched) return;
        input.value = chars.slice(0, ++i).join("");
        void render();
        if (i < chars.length) demoTimer = window.setTimeout(tick, 70);
      };
      input.value = "";
      tick();
    }, 600);
  });
}
