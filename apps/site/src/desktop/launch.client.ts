/**
 * `/launch/`: entry point for the installed app. The OS opens files here
 * (manifest `file_handlers`) and the app's "Desktop" shortcut points here.
 * Picks the visitor's language like the root page, parks launched file handles
 * and continues to that language's desk, which offers tools for the files.
 */
import { localizedPath } from "@/lib/url";
import { DEFAULT_LOCALE, LOCALES, type LocaleCode } from "@/registry/locales";
import { parkLaunchHandles } from "./launch-store.ts";

interface LaunchParams {
  files: readonly FileSystemHandle[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** Without launched files the desk opens after this short wait. */
const CONSUMER_WAIT_MS = 800;

function pickLanguage(): LocaleCode {
  const supported = LOCALES.map((locale) => locale.code) as string[];
  try {
    const saved = localStorage.getItem("locale");
    if (saved && supported.includes(saved)) return saved as LocaleCode;
  } catch {
    /* storage blocked: fall back to the browser languages */
  }
  for (const language of navigator.languages ?? [navigator.language]) {
    const code = String(language || "").toLowerCase().split("-")[0] ?? "";
    if (supported.includes(code)) return code as LocaleCode;
  }
  return DEFAULT_LOCALE;
}

const desk = localizedPath(pickLanguage(), "desktop");
let done = false;
const go = (key?: string) => {
  if (done) return;
  done = true;
  location.replace(key ? `${desk}?launch=${key}` : desk);
};

const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
if (queue) {
  queue.setConsumer((params) => {
    const handles = params.files.filter((handle): handle is FileSystemFileHandle => handle.kind === "file");
    if (handles.length === 0) {
      go();
      return;
    }
    parkLaunchHandles(handles).then(go, () => go());
  });
}
window.setTimeout(() => go(), CONSUMER_WAIT_MS);
