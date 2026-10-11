/** One admission boundary for effects during app shutdown. Reads and joining
 * already-submitted work remain available; a cancelled quit reopens admission. */
export class CommandAdmission {
  #accepting = true;
  accepting(): boolean { return this.#accepting; }
  close(): void { this.#accepting = false; }
  reopen(): void { this.#accepting = true; }
}
export const appAdmission = new CommandAdmission();
