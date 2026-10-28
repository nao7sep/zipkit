import { managedIOPending } from "./managed-io.js";

/** Called after quit's required saves and bounded cleanup, with new command
 * admission closed. Logical cancellation does not prove native settlement:
 * a managed save still in a native call can hold main's exit. */
export function nativeWorkPending(): boolean {
  return managedIOPending();
}
