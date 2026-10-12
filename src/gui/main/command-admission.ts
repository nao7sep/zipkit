/** One admission boundary for effects during app shutdown. Reads and joining
 * already-submitted work remain available; a cancelled quit reopens admission. */
export class CommandAdmission {
  #accepting = true;
  #edits = true;
  accepting(): boolean { return this.#accepting; }
  acceptingEdits(): boolean { return this.#edits; }
  /** Stop new effects before waiting for preload's already-issued edit batch.
   * Preload freezes further submissions; close() then ends this drain phase. */
  beginClosing(): void { this.#accepting = false; }
  close(): void { this.#accepting = false; this.#edits = false; }
  reopen(): void { this.#accepting = true; this.#edits = true; }
}
export const appAdmission = new CommandAdmission();
