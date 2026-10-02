/* Result/database-state normalisation shared by the V5 comparison tests. */

/**
 * Error messages produced by graphql-js itself differ between graphql@15
 * (V4) and graphql@16 (V5). These are not produced by the plugin.
 */
function normalizeMessage(message: string) {
  return message
    .replace(/^Expected type "?([^".]+)"?\.?/g, "Expected type $1")
    .replace(/\.$/, "");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fixtures with `uuid_generate_v4()` defaults produce different values on
 * every run: replace UUIDs (also inside node IDs) with a placeholder, and
 * sort arrays that contained one so row order by UUID doesn't matter.
 */
export function normalizeRandom(value: any): { value: any; random: boolean } {
  if (typeof value === "string") {
    if (UUID.test(value)) return { value: "<uuid>", random: true };
    if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 8) {
      try {
        const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
        if (Array.isArray(decoded) && decoded.some((d) => UUID.test(String(d)))) {
          return {
            value: `<nodeId:${JSON.stringify(normalizeRandom(decoded).value)}>`,
            random: true,
          };
        }
      } catch {
        // not a node ID
      }
    }
    return { value, random: false };
  }
  if (Array.isArray(value)) {
    const items = value.map(normalizeRandom);
    const random = items.some((i) => i.random);
    const out = items.map((i) => i.value);
    if (random) out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { value: out, random };
  }
  if (value && typeof value === "object") {
    let random = false;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normalizeRandom(v);
      random ||= n.random;
      out[k] = n.value;
    }
    return { value: out, random };
  }
  return { value, random: false };
}

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
