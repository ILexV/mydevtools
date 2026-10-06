/**
 * Unit Converter client. Drives category/from/to selects + value input → live
 * result, swap, copy, formula note, quick-conversion chips, and a common
 * conversions sidebar. Math via `units.ts`; numbers are shown in the page
 * locale (`formatNumberLocale`), unit names come localized from the island.
 *
 * The category `<select>` options are rendered server-side; this controller
 * only wires behavior and populates the per-category from/to unit selects.
 */
import {
  commonConversions,
  convertValue,
  formatNumberLocale,
  isBelowAbsoluteZero,
  unitData,
  type Category,
} from "@/tools/units";
import { copyWithFeedback } from "@/scripts/tool-ui";

interface Strings {
  lang: string;
  copied: string;
  copyFailed: string;
  belowAbsoluteZero: string;
  unitNames: Record<string, string>;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-unit-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-unit-tool]");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "1";
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const categorySelectEl = root.querySelector<HTMLSelectElement>("[data-unit-category]");
  const fromUnitSelectEl = root.querySelector<HTMLSelectElement>("[data-unit-from]");
  const toUnitSelectEl = root.querySelector<HTMLSelectElement>("[data-unit-to]");
  const fromValueInputEl = root.querySelector<HTMLInputElement>("[data-unit-from-value]");
  const toValueInputEl = root.querySelector<HTMLInputElement>("[data-unit-to-value]");
  if (!categorySelectEl || !fromUnitSelectEl || !toUnitSelectEl || !fromValueInputEl || !toValueInputEl) {
    return;
  }
  const categorySelect = categorySelectEl;
  const fromUnitSelect = fromUnitSelectEl;
  const toUnitSelect = toUnitSelectEl;
  const fromValueInput = fromValueInputEl;
  const toValueInput = toValueInputEl;

  const swapBtn = root.querySelector<HTMLButtonElement>("[data-unit-swap]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-unit-copy]");
  const formulaEl = root.querySelector<HTMLElement>("[data-unit-formula]");
  const quickEl = root.querySelector<HTMLElement>("[data-unit-quick]");
  const commonEl = root.querySelector<HTMLElement>("[data-unit-common]");
  const warningEl = root.querySelector<HTMLElement>("[data-unit-warning]");
  const errorEl = root.querySelector<HTMLElement>("[data-unit-error]");

  const fmt = (n: number): string => formatNumberLocale(n, strings.lang);
  const name = (id: string): string => strings.unitNames[id] ?? id;

  let currentCategory: Category = (categorySelect.value as Category) || "length";

  // Build the from/to unit <option>s for a category and pick the default pair
  // (first two units, mirroring the legacy defaults).
  function populateUnitSelects(category: Category) {
    const keys = Object.keys(unitData[category].units);
    const options = (): HTMLOptionElement[] => keys.map((k) => new Option(name(k), k));
    fromUnitSelect.replaceChildren(...options());
    toUnitSelect.replaceChildren(...options());
    fromUnitSelect.value = keys[0];
    toUnitSelect.value = keys[1] ?? keys[0];
  }

  function updateFormula(value: number, from: string, to: string, result: number) {
    if (!formulaEl) return;
    let formula: string;
    if (currentCategory === "temperature") {
      formula = `${fmt(value)} ${name(from)} ${from === to ? "=" : "→"} ${fmt(result)} ${name(to)}`;
    } else {
      const units = unitData[currentCategory].units;
      const fromFactor = units[from]?.factor;
      const toFactor = units[to]?.factor;
      const ratio = fromFactor != null && toFactor != null ? fromFactor / toFactor : 1;
      formula = `${fmt(value)} ${name(from)} × ${fmt(ratio)} = ${fmt(result)} ${name(to)}`;
    }
    formulaEl.textContent = formula;
  }

  function updateQuickConversions(value: number) {
    if (!quickEl) return;
    const fromUnit = fromUnitSelect.value;
    const keys = Object.keys(unitData[currentCategory].units);
    quickEl.replaceChildren(
      ...keys
        .filter((u) => u !== fromUnit)
        .map((u) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ds-chip-btn";
          btn.dataset.unitQuickPick = u;
          btn.setAttribute("aria-pressed", String(u === toUnitSelect.value));
          btn.textContent = `${fmt(convertValue(value, fromUnit, u, currentCategory))} ${name(u)}`;
          return btn;
        }),
    );
  }

  function updateCommonConversions() {
    if (!commonEl) return;
    commonEl.replaceChildren(
      ...commonConversions[currentCategory].map((conv) => {
        const result = convertValue(conv.from, conv.fromUnit, conv.toUnit, currentCategory);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ds-btn";
        btn.dataset.unitCommonPick = `${conv.from}|${conv.fromUnit}|${conv.toUnit}`;
        btn.textContent = `${fmt(conv.from)} ${conv.fromUnit} = ${fmt(result)} ${conv.toUnit}`;
        btn.title = `${name(conv.fromUnit)} → ${name(conv.toUnit)}`;
        return btn;
      }),
    );
  }

  function updateConversion() {
    const value = fromValueInput.valueAsNumber;
    const fromUnit = fromUnitSelect.value;
    const toUnit = toUnitSelect.value;

    if (!Number.isFinite(value)) {
      toValueInput.value = "";
      if (formulaEl) formulaEl.textContent = "";
      quickEl?.replaceChildren();
      if (warningEl) warningEl.hidden = true;
      return;
    }

    const result = convertValue(value, fromUnit, toUnit, currentCategory);
    toValueInput.value = fmt(result);
    if (warningEl) {
      const below = currentCategory === "temperature" && isBelowAbsoluteZero(value, fromUnit);
      warningEl.textContent = below ? strings.belowAbsoluteZero : "";
      warningEl.hidden = !below;
    }
    updateFormula(value, fromUnit, toUnit, result);
    updateQuickConversions(value);
  }

  function applyCategory(category: Category) {
    currentCategory = category;
    populateUnitSelects(currentCategory);
    fromValueInput.value = "1";
    updateConversion();
    updateCommonConversions();
  }

  categorySelect.addEventListener("change", () => applyCategory(categorySelect.value as Category));
  fromUnitSelect.addEventListener("change", updateConversion);
  toUnitSelect.addEventListener("change", updateConversion);
  fromValueInput.addEventListener("input", updateConversion);

  swapBtn?.addEventListener("click", () => {
    const tmp = fromUnitSelect.value;
    fromUnitSelect.value = toUnitSelect.value;
    toUnitSelect.value = tmp;
    updateConversion();
  });

  copyBtn?.addEventListener("click", async () => {
    const value = toValueInput.value;
    if (!value) return;
    const ok = await copyWithFeedback(copyBtn, value, strings.copied);
    if (errorEl) {
      errorEl.textContent = ok ? "" : strings.copyFailed;
      errorEl.hidden = ok;
    }
  });

  quickEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-unit-quick-pick]");
    if (!btn) return;
    toUnitSelect.value = btn.dataset.unitQuickPick || toUnitSelect.value;
    updateConversion();
    quickEl.querySelector<HTMLButtonElement>(`[data-unit-quick-pick="${toUnitSelect.value}"]`)?.focus();
  });

  commonEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-unit-common-pick]");
    if (!btn) return;
    const [val, fromUnit, toUnit] = (btn.dataset.unitCommonPick || "").split("|");
    fromValueInput.value = val;
    fromUnitSelect.value = fromUnit;
    toUnitSelect.value = toUnit;
    updateConversion();
  });

  categorySelect.value = currentCategory;
  populateUnitSelects(currentCategory);
  fromValueInput.value = "1";
  updateConversion();
  updateCommonConversions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
