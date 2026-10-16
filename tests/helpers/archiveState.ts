/**
 * The engine's path look-up for tests that write real files: what the SDK host
 * answers, on the real volume.
 */

import { nodeFileSystem, Volume } from "../../src/sdk/internal/volume.js";
import { pathState, type PathState } from "../../src/gui/main/path-state.js";

export function realPathState(target: string): Promise<PathState> {
  return pathState(target, new Volume(nodeFileSystem, 30_000));
}
