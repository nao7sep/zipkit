/**
 * For an app's tests that need the SDK to meet a failing disk: the bounded
 * file access every verb uses, and Node's file system as it plugs in. A test
 * builds a `Volume` over a port whose calls it controls (a sync that fails, an
 * open that never answers) and hands it to the SDK by overriding
 * `ZipKit.volume`. Not for production code: there the SDK builds its own.
 */

export { nodeFileSystem, Volume } from "./internal/volume.js";
export type { FileSystemPort } from "./internal/volume.js";
