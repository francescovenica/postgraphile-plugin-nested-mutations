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
import { afterAll as after, describe, test } from "vitest";
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
import { normalizeDb, normalizeResult } from "./support/normalize.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenDir = join(root, "parity/golden");
const require = createRequire(import.meta.url);
const knownDifferences = require("../parity/known-differences.cjs") as Array<{
  file: string;
  case: string;
  reason: string;
  operation?: number;
  schemaChanges?: string[];
  errorMessages?: string[];
  adjust?: {
    fromOperation: number;
    result?: (result: any, operation: number) => any;
    dbState?: (state: any) => any;
  };
}>;
const knownPluginDifferences: string[] = [];
const adjustedCase = (known: typeof knownDifferences) =>
  known.some((k) => k.adjust);

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
  // e.g. transactions-v4.json, used by transaction.test.ts
  if (!Array.isArray(golden.cases)) continue;
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

          if (adjustedCase(known)) {
            knownPluginDifferences.push(
              `${golden.file} › ${goldenCase.name}: ${known.find((k) => k.adjust)!.reason}`,
            );
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
          const adjusted = known.find((k) => k.adjust)?.adjust;
          const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
          for (const [i, op] of goldenCase.operations.entries()) {
            const expectedResult =
              adjusted?.result && i >= adjusted.fromOperation
                ? adjusted.result(clone(op.result), i)
                : op.result;
            const expectedDbState =
              adjusted?.dbState && i >= adjusted.fromOperation
                ? adjusted.dbState(clone(op.dbState))
                : op.dbState;
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
                normalizeResult(expectedResult),
                `operation ${i} result differs`,
              );
            }
            const after = await dumpSchema(query);
            assert.deepEqual(
              normalizeDb(after),
              normalizeDb(expectedDbState),
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
    "Generated by `__tests__/parity.test.ts` from the recordings in `parity/golden`.",
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
