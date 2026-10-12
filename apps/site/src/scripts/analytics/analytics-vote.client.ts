import { VOTE_CHOICES, type VoteChoice } from "./events.ts";
import { sendVote } from "./transport.ts";

interface VoteStrings {
  submitting: string;
  accepted: string;
  failed: string;
  disabled: string;
}

let acceptedOnPage = false;
const initialized = new WeakSet<HTMLElement>();

function parseStrings(root: HTMLElement): VoteStrings | null {
  const source = root.querySelector<HTMLScriptElement>("[data-vote-strings]");
  if (!source?.textContent) return null;
  try {
    const value = JSON.parse(source.textContent) as Partial<VoteStrings>;
    if ([value.submitting, value.accepted, value.failed, value.disabled].every((entry) => typeof entry === "string")) {
      return value as VoteStrings;
    }
  } catch {
    // A malformed localization island leaves the static form inert.
  }
  return null;
}

function isVoteChoice(value: FormDataEntryValue | null): value is VoteChoice {
  return typeof value === "string" && VOTE_CHOICES.some((choice) => choice.id === value);
}

export function initAnalyticsVote(root: HTMLElement): void {
  if (initialized.has(root)) return;
  const form = root.querySelector<HTMLFormElement>("[data-vote-form]");
  const submit = root.querySelector<HTMLButtonElement>("[data-vote-submit]");
  const status = root.querySelector<HTMLElement>("[data-vote-status]");
  const strings = parseStrings(root);
  if (!form || !submit || !status || !strings) return;
  initialized.add(root);

  const choices = [...form.querySelectorAll<HTMLInputElement>('input[name="analytics-vote-choice"]')];
  const setDisabled = (disabled: boolean): void => {
    for (const choice of choices) choice.disabled = disabled;
    submit.disabled = disabled || !choices.some((choice) => choice.checked);
  };
  const setStatus = (message: string, state?: "accepted" | "failed" | "disabled"): void => {
    status.textContent = message;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };

  if (acceptedOnPage) {
    setDisabled(true);
    setStatus(strings.accepted, "accepted");
    return;
  }

  form.addEventListener("change", () => {
    submit.disabled = acceptedOnPage || !choices.some((choice) => choice.checked);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (acceptedOnPage) return;
    const choice = new FormData(form).get("analytics-vote-choice");
    if (!isVoteChoice(choice)) return;

    setDisabled(true);
    setStatus(strings.submitting);
    const result = await sendVote(choice);
    if (result === "accepted") {
      acceptedOnPage = true;
      setDisabled(true);
      setStatus(strings.accepted, "accepted");
      return;
    }
    if (result === "disabled") {
      setDisabled(true);
      setStatus(strings.disabled, "disabled");
      return;
    }
    setDisabled(false);
    setStatus(strings.failed, "failed");
  });
}
