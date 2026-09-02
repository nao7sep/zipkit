/** Map native BrowserWindow activation onto the renderer's chrome state. */
export function installWindowActivityState(
  subscribe: (callback: (active: boolean) => void) => () => void,
  root: Pick<Element, "toggleAttribute">,
): () => void {
  return subscribe((active) => {
    root.toggleAttribute("data-window-inactive", !active);
  });
}
