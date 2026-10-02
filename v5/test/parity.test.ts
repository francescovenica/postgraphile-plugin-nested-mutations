/*
 * Replays every V4 recording in parity/golden/*.json against V5 (+ V4 preset
 * + this plugin) and checks:
 *
 * - the plugin's schema delta (types/fields added or changed on top of the
 *   base schema) is identical, including field order;
 * - each operation returns the same result and leaves the same database
 *   state (every table in schema `p`).
 *
 * It also diffs the full V4+plugin and V5+plugin schemas with
 * graphql-inspector and writes parity/report.md, classifying each remaining
 * difference as plugin-related (a failure) or a core V4 -> V5 difference.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { diff } from "@graphql-inspector/core";
import { buildSchema as buildSchemaFromSDL, printSchema } from "postgraphile/graphql";

import {
  buildSchema,
  dumpSchema,
  execute,
  pgQuery,
  presetFromV4Options,
  printSorted,
  resetSettings,
  withRolledBackClient,
} from "./support/harness.ts";
import {
  coreTypeRenames,
  pluginDelta,
  pluginFieldOrder,
  renameCoreTypes,
  touchesPlugin,
} from "./support/schemaDiff.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const goldenDir = join(root, "parity/golden");
const require = createRequire(import.meta.url);
const knownDifferences = require("../../parity/known-differences.cjs") as Array<{
  file: string;
  case: string;
  reason: string;
  operation?: number;
  schemaChanges?: string[];
  errorMessages?: string[];
}>;
const knownPluginDifferences: string[] = [];

interface GoldenOperation {
  source: string;
  variableValues: Record<string, unknown> | null;
  pgSettings?: Record<string, string>;
  expect?: { errors?: boolean; dbUnchanged?: boolean };
  /** V4 left the transaction aborted; its COMMIT rolled the request back */
  v4TransactionAborted?: boolean;
  result: any;
  dbState: Record<string, unknown[]>;
}
interface GoldenCase {
  name: string;
  setup: string | null;
  options: Record<string, any>;
  /** Unsorted SDL prints of the V4 schema without / with the plugin */
  schemas: { base: string; plugin: string };
  initialDbState: Record<string, unknown[]>;
  operations: GoldenOperation[];
}

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
function normalizeRandom(value: any): { value: any; random: boolean } {
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

const normalizeDb = (state: any) => normalizeRandom(state).value;

function renameSDL(sdl: string, renames: Map<string, string>) {
  let out = sdl;
  for (const [from, to] of renames) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return out;
}

const coreDifferences: string[] = [];
const pluginDifferences: string[] = [];

const files = readdirSync(goldenDir).filter((f) => f.endsWith(".json")).sort();

for (const file of files) {
  const golden = JSON.parse(readFileSync(join(goldenDir, file), "utf8")) as {
    file: string;
    cases: GoldenCase[];
  };
  describe(golden.file, () => {
    for (const goldenCase of golden.cases) {
      test(goldenCase.name, async () => {
        await withRolledBackClient(async (client) => {
          if (goldenCase.setup) await client.query(goldenCase.setup);

          const base = await buildSchema(
            client,
            presetFromV4Options(goldenCase.options, { plugin: false }),
          );
          const withPlugin = await buildSchema(
            client,
            presetFromV4Options(goldenCase.options, { plugin: true }),
          );

          // --- Schema parity -------------------------------------------------
          const renames = coreTypeRenames(
            goldenCase.schemas.base,
            printSorted(base.schema),
          );
          for (const [from, to] of renames) {
            coreDifferences.push(`Core type renamed: ${from} → ${to}`);
          }
          const v4Delta = renameCoreTypes(
            pluginDelta(goldenCase.schemas.base, goldenCase.schemas.plugin),
            renames,
          );
          const v5Delta = pluginDelta(
            printSorted(base.schema),
            printSorted(withPlugin.schema),
          );
          const known = knownDifferences.filter(
            (k) => k.file === golden.file && k.case === goldenCase.name,
          );
          const knownSchema = known.find((k) => k.schemaChanges);

          // Core renames (reported above) are applied to the V4 side so that
          // descriptions mentioning a renamed core type aren't flagged.
          const changes = await diff(
            buildSchemaFromSDL(renameSDL(goldenCase.schemas.plugin, renames)),
            withPlugin.schema,
          );
          const pluginChanges: string[] = [];
          for (const change of changes) {
            if (
              touchesPlugin(v4Delta, change.path) ||
              touchesPlugin(v5Delta, change.path)
            ) {
              pluginChanges.push(change.message);
            } else {
              coreDifferences.push(change.message);
            }
          }

          if (knownSchema) {
            // Documented deliberate difference: it must be exactly this.
            assert.deepEqual(
              [...pluginChanges].sort(),
              [...knownSchema.schemaChanges!].sort(),
              "schema differs from V4 other than the documented way",
            );
            knownPluginDifferences.push(
              `${golden.file} › ${goldenCase.name}: ${knownSchema.reason}`,
            );
          } else {
            for (const message of pluginChanges) {
              pluginDifferences.push(`${golden.file} › ${goldenCase.name}: ${message}`);
            }
            assert.deepEqual(v5Delta, v4Delta, "plugin schema delta differs");
            assert.deepEqual(
              pluginFieldOrder(v5Delta, printSchema(withPlugin.schema)),
              pluginFieldOrder(
                v4Delta,
                renameSDL(goldenCase.schemas.plugin, renames),
              ),
              "field order of plugin types/fields differs",
            );
          }

          // --- Behaviour parity ----------------------------------------------
          const query = pgQuery(client);
          assert.deepEqual(
            normalizeDb(await dumpSchema(query)),
            normalizeDb(goldenCase.initialDbState),
            "initial database state differs",
          );
          let before = await dumpSchema(query);
          for (const [i, op] of goldenCase.operations.entries()) {
            const result = await execute(
              withPlugin,
              op.source,
              op.variableValues,
              op.pgSettings,
            );
            await resetSettings(query, op.pgSettings);
            const knownResult = known.find(
              (k) => k.operation === i && k.errorMessages,
            );
            if (knownResult) {
              const actual = normalizeResult(result);
              assert.deepEqual(
                actual.errors?.map((e: any) => e.message),
                knownResult.errorMessages,
                `operation ${i}: documented V5 error differs`,
              );
              assert.deepEqual(
                actual.data,
                normalizeResult(op.result).data,
                `operation ${i} data differs`,
              );
              knownPluginDifferences.push(
                `${golden.file} › ${goldenCase.name} (operation ${i}): ${knownResult.reason}`,
              );
            } else {
              assert.deepEqual(
                normalizeResult(result),
                normalizeResult(op.result),
                `operation ${i} result differs`,
              );
            }
            const after = await dumpSchema(query);
            assert.deepEqual(
              normalizeDb(after),
              normalizeDb(op.dbState),
              `operation ${i} database state differs`,
            );
            if (op.expect?.errors !== undefined) {
              assert.equal(!!result.errors, op.expect.errors, `operation ${i} errors`);
            }
            if (op.expect?.dbUnchanged) {
              assert.deepEqual(after, before, `operation ${i} changed the database`);
            }
            before = after;
          }
        });
      });
    }
  });
}

after(() => {
  const counts = new Map<string, number>();
  for (const m of coreDifferences) counts.set(m, (counts.get(m) ?? 0) + 1);
  const lines = [
    "# V4 → V5 schema parity report",
    "",
    "Generated by `v5/test/parity.test.ts` from the recordings in `parity/golden`.",
    "Each fixture's full V4+plugin schema is diffed against V5+plugin",
    "(V4 preset) with graphql-inspector.",
    "",
    "## Differences in types/fields the plugin adds or changes",
    "",
    pluginDifferences.length
      ? pluginDifferences.map((l) => `- ${l}`).join("\n")
      : "None.",
    "",
    "## Documented, deliberate plugin differences",
    "",
    "Listed in `parity/known-differences.cjs`; the suite checks each one is",
    "exactly as documented.",
    "",
    knownPluginDifferences.length
      ? knownPluginDifferences.map((l) => `- ${l}`).join("\n")
      : "None.",
    "",
    "## Core V4 → V5 differences (not the plugin)",
    "",
    "Counted across all fixtures.",
    "",
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([m, n]) => `- (${n}×) ${m}`),
    "",
  ];
  writeFileSync(join(root, "parity/report.md"), lines.join("\n"));
  assert.equal(
    pluginDifferences.length,
    0,
    `plugin-related schema differences:\n${pluginDifferences.join("\n")}`,
  );
});
