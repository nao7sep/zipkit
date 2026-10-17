/**
 * The engine's path look-up for tests that write real files: what the SDK host
 * answers, on the real volume.
 */

import { ZipKit, type PathState } from "../../src/sdk/index.js";

export function realPathState(target: string): Promise<PathState> {
  return new ZipKit().pathState(target);
}
