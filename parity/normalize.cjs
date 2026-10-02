/*
 * Fixtures with `uuid_generate_v4()` defaults produce different values on
 * every run. Replace UUIDs (also inside node IDs) with a placeholder, and
 * sort arrays that contained one so row order by UUID doesn't matter. Used
 * when recording golden files (so they are stable) and when comparing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeRandom(value) {
  if (typeof value === 'string') {
    if (UUID.test(value)) return { value: '<uuid>', random: true };
    if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 8) {
      try {
        const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
        if (Array.isArray(decoded) && decoded.some((d) => UUID.test(String(d)))) {
          return {
            value: `<nodeId:${JSON.stringify(normalizeRandom(decoded).value)}>`,
            random: true,
          };
        }
      } catch (e) {
        // not a node ID
      }
    }
    return { value, random: false };
  }
  if (Array.isArray(value)) {
    const items = value.map(normalizeRandom);
    const random = items.some((i) => i.random);
    const out = items.map((i) => i.value);
    if (random) {
      out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return { value: out, random };
  }
  if (value && typeof value === 'object') {
    let random = false;
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      const n = normalizeRandom(v);
      random = random || n.random;
      out[k] = n.value;
    });
    return { value: out, random };
  }
  return { value, random: false };
}

const stable = (value) => normalizeRandom(value).value;

module.exports = { normalizeRandom, stable };
