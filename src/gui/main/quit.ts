/**
 * Completes asynchronous quit work before terminating Electron.
 *
 * `app.quit()` is not a reliable continuation after macOS has already closed
 * the last window. `app.exit()` is safe here because all owned flushes have
 * settled first, and it deliberately avoids re-entering `before-quit`.
 */
export async function flushThenExit(
  work: readonly unknown[],
  onSuccess: () => void,
  onError: (error: unknown) => void,
  exit: (code: number) => void,
): Promise<void> {
  try {
    await Promise.all(work);
    onSuccess();
  } catch (error) {
    onError(error);
  } finally {
    exit(0);
  }
}
