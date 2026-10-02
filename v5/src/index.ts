import "./interfaces.ts";

import { PgNestedMutationsPlugin } from "./plugin.ts";

export type * from "./interfaces.ts";
export { PgNestedMutationsPlugin } from "./plugin.ts";
export {
  NestedMutationEngine,
  PgNestedInsertStep,
  PgNestedUpdateStep,
} from "./runtime.ts";
export { version } from "./version.ts";

/**
 * Add to your preset's `extends`. Options (same names and defaults as V4's
 * `graphileBuildOptions`) go in `preset.schema`:
 *
 * ```js
 * const preset = {
 *   extends: [PostGraphileAmberPreset, makeV4Preset(), NestedMutationsPreset],
 *   schema: { nestedMutationsSimpleFieldNames: true },
 * };
 * ```
 */
export const NestedMutationsPreset: GraphileConfig.Preset = {
  plugins: [PgNestedMutationsPlugin],
};

export default NestedMutationsPreset;
