/**
 * The browser entry (`zipkitsdk/types`): what a consumer uses where Node does
 * not load, such as an app's window. Every public type, and the plain data a
 * window needs before it calls the SDK, so no window restates an SDK rule: the
 * built-in policy, the manifest's settings when one is written, the built-in
 * exclusion patterns and the rule registry.
 * Nothing here imports Node or a dependency; a typecheck against browser
 * libraries (`tsconfig.browser.json`) holds that.
 */

export type * from "./types.ts";
export type { FindingRule, RuleId, RuleSpec, VerifyRuleId } from "./registry.ts";
export { DEFAULT_POLICY, MANIFEST_DEFAULTS } from "./defaults.ts";
export { DEFAULT_EXCLUSIONS } from "./filter/defaults.ts";
export { RULE_REGISTRY } from "./registry.ts";
