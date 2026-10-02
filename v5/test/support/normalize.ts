/* Result/database-state normalisation shared by the V5 comparison tests. */
import { createRequire } from "node:module";

/**
 * Error messages produced by graphql-js itself differ between graphql@15
 * (V4) and graphql@16 (V5). These are not produced by the plugin.
 */
function normalizeMessage(message: string) {
  return message
    .replace(/^Expected type "?([^".]+)"?\.?/g, "Expected type $1")
    .replace(/\.$/, "");
}

const require = createRequire(import.meta.url);
export const { normalizeRandom } = require("../../../parity/normalize.cjs") as {
  normalizeRandom: (value: any) => { value: any; random: boolean };
};

export function normalizeResult(result: any) {
  return normalizeRandom({
    data: result.data ?? null,
    errors: result.errors
      ? result.errors.map((e: any) => ({
          message: normalizeMessage(e.message),
          path: e.path ?? null,
        }))
      : null,
  }).value;
}

export const normalizeDb = (state: any) => normalizeRandom(state).value;
