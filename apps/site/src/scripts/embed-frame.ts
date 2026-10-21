/**
 * Inside a desktop window (`?embed=1`): tell the shell the tool markup is
 * parsed, before images, fonts or WASM finish. The shell starts close
 * protection and its hotkeys here instead of at `load`, so text typed while
 * the page is still loading counts as input.
 */
if (document.documentElement.classList.contains("is-embed") && window.parent !== window) {
  window.parent.postMessage({ type: "mdt:frame-interactive" }, window.location.origin);
}
