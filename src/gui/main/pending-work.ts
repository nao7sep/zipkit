import { volumeWorkPending } from "../../sdk/internal/volume.js";
import { managedIOPending } from "./managed-io.js";

/** Called after quit's required saves and bounded cleanup, with new command
 * admission closed. Logical SDK cancellation does not prove native settlement. */
export function nativeWorkPending(): boolean {
  return volumeWorkPending() || managedIOPending();
}
