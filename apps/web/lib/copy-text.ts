/**
 * Copy text to the clipboard from a page that may be running inside an iframe.
 *
 * **Why the async Clipboard API is not enough here.** The admin surface is embedded in VIGA's
 * site (`frame-ancestors` in `next.config.mjs` is what permits it), and inside an iframe
 * `navigator.clipboard.writeText` is gated by the `clipboard-write` permissions policy. Unless
 * the EMBEDDING page sets `allow="clipboard-write"` on the iframe element, the promise rejects
 * with `NotAllowedError` — on HTTPS, from a genuine user click, every time. VIGA owns that
 * embed code, so the frame cannot fix it from the inside. It is also unavailable outright in
 * any non-secure context, where `navigator.clipboard` is `undefined`.
 *
 * So the modern call is TRIED, and a `document.execCommand("copy")` fallback runs when it is
 * unavailable or refused. `execCommand` is deprecated and synchronous, which is exactly why it
 * still works: it predates the permissions policy and is not subject to it.
 *
 * Returns whether the text actually reached the clipboard, so the caller can tell the operator
 * the truth rather than assuming either outcome.
 */
export async function copyText(text: string): Promise<boolean> {
  // Optional-chained rather than assumed: in a non-secure context `navigator.clipboard` is
  // undefined, and reading `.writeText` off it would throw before the fallback could run.
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused by permissions policy (the iframe case) — fall through and try the old way.
  }
  return copyWithExecCommand(text);
}

/**
 * The pre-permissions-policy copy path: put the text in a selected textarea and ask the
 * document to copy the selection.
 *
 * The textarea is positioned off-screen rather than hidden with `display: none` or
 * `visibility: hidden` — an unrendered element cannot hold a selection, so hiding it that way
 * makes the copy silently do nothing.
 */
function copyWithExecCommand(text: string): boolean {
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "fixed";
  holder.style.top = "-1000px";
  holder.style.opacity = "0";
  document.body.appendChild(holder);

  try {
    holder.select();
    // iOS Safari ignores `select()` on a readonly field and needs the explicit range.
    holder.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // Removed on every path: a leaked textarea per click would accumulate in a long admin
    // session and can steal focus.
    holder.remove();
  }
}
