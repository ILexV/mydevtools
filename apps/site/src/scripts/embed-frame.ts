/**
 * Inside a desktop window (`?embed=1`): tell the shell the tool markup is
 * parsed, before images, fonts or WASM finish. The shell starts close
 * protection and its hotkeys here instead of at `load`, so text typed while
 * the page is still loading counts as input. Links to other pages (the agent
 * download page, docs) open in a new tab: navigating the frame would replace
 * the tool and leave the window showing «the tool did not load».
 */
if (document.documentElement.classList.contains("is-embed") && window.parent !== window) {
  window.parent.postMessage({ type: "mdt:frame-interactive" }, window.location.origin);
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin === window.location.origin && url.pathname === window.location.pathname) return;
    link.target = "_blank";
    link.rel = "noopener";
  }, true);
}
