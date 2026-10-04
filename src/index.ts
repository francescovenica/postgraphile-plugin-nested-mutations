import "./interfaces.ts";

import { PgNestedMutationsBehaviorPlugin } from "./PgNestedMutationsBehaviorPlugin.ts";
import { PgNestedMutationsFieldsPlugin } from "./PgNestedMutationsFieldsPlugin.ts";
import { PgNestedMutationsGatherPlugin } from "./PgNestedMutationsGatherPlugin.ts";
import { PgNestedMutationsInflectionPlugin } from "./PgNestedMutationsInflectionPlugin.ts";
import { PgNestedMutationsPlansPlugin } from "./PgNestedMutationsPlansPlugin.ts";
import { PgNestedMutationsTypesPlugin } from "./PgNestedMutationsTypesPlugin.ts";

export type * from "./interfaces.ts";
export {
  nestedBehavior,
  PgNestedMutationsBehaviorPlugin,
} from "./PgNestedMutationsBehaviorPlugin.ts";
export { PgNestedMutationsFieldsPlugin } from "./PgNestedMutationsFieldsPlugin.ts";
export { PgNestedMutationsGatherPlugin } from "./PgNestedMutationsGatherPlugin.ts";
export { PgNestedMutationsInflectionPlugin } from "./PgNestedMutationsInflectionPlugin.ts";
export { PgNestedMutationsPlansPlugin } from "./PgNestedMutationsPlansPlugin.ts";
export { PgNestedMutationsTypesPlugin } from "./PgNestedMutationsTypesPlugin.ts";
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
 *   extends: [PostGraphileAmberPreset, makeV4Preset(), PgNestedMutationsPreset],
 *   schema: { nestedMutationsSimpleFieldNames: true },
 * };
 * ```
 */
export const PgNestedMutationsPreset: GraphileConfig.Preset = {
  plugins: [
    PgNestedMutationsInflectionPlugin,
    PgNestedMutationsGatherPlugin,
    PgNestedMutationsBehaviorPlugin,
    PgNestedMutationsTypesPlugin,
    PgNestedMutationsFieldsPlugin,
    PgNestedMutationsPlansPlugin,
  ],
};

export default PgNestedMutationsPreset;
