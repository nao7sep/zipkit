/** One admission boundary for effects during app shutdown: quit stops new
 * effects first and job edits only as its queue save begins, so edits the
 * window already sent are taken. A cancelled quit reopens admission. */
export class CommandAdmission {
  #accepting = true;
  #edits = true;
  accepting(): boolean { return this.#accepting; }
  acceptingEdits(): boolean { return this.#edits; }
  /** Stop new effects; edits are still taken until close(). */
  beginClosing(): void { this.#accepting = false; }
  close(): void { this.#accepting = false; this.#edits = false; }
  reopen(): void { this.#accepting = true; this.#edits = true; }
}
export const appAdmission = new CommandAdmission();
