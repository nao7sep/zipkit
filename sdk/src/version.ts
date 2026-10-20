/**
 * The SDK's version, recorded in every manifest it writes and in its startup
 * event. Read from the SDK's own package.json, the one place it is written;
 * plain Node loads the JSON import, and an app's bundler inlines it.
 */

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
