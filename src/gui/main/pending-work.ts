import { managedIOPending } from "./managed-io.js";

/** Called after quit's required saves and bounded cleanup, with new command
 * admission closed. Logical cancellation does not prove native settlement. The
 * SDK's volume work runs in its own utility process, so only main's own managed
 * saves can hold main's exit. */
export function nativeWorkPending(): boolean {
  return managedIOPending();
}
