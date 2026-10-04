import { createRequire } from "node:module";

import pg from "pg";
import { makeSchema } from "postgraphile";
import * as adaptor from "postgraphile/adaptors/pg";
import { grafast } from "postgraphile/grafast";
import {
  type GraphQLSchema,
  lexicographicSortSchema,
  printSchema,
} from "postgraphile/graphql";
import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { makeV4Preset } from "postgraphile/presets/v4";

import { PgSimplifyInflectionPreset } from "@graphile/simplify-inflection";

import { PgNestedMutationsPreset } from "../../src/index.ts";

/** V4 plugins used by recorded fixtures -> their V5 equivalents */
const extraPresets: Record<string, GraphileConfig.Preset> = {
  "pg-simplify-inflector": PgSimplifyInflectionPreset,
};

const require = createRequire(import.meta.url);
const { dumpSchema, resetSettings } = require("../../parity/dbstate.cjs") as {
  dumpSchema: (
    query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>,
    schema?: string,
  ) => Promise<Record<string, unknown[]>>;
  resetSettings: (
    query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>,
    pgSettings?: Record<string, string>,
  ) => Promise<void>;
};

export { dumpSchema, resetSettings };

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set");
}

/** Runs `fn` with a client inside a transaction that is always rolled back. */
export async function withRolledBackClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local timezone to '+04:00'");
    return await fn(client);
  } finally {
    try {
      await client.query("rollback");
    } finally {
      await client.end();
    }
  }
}

/** V4 `createPostGraphileSchema` options -> V5 preset */
export function presetFromV4Options(
  v4Options: Record<string, any>,
  { plugin }: { plugin: boolean },
): GraphileConfig.Preset {
  const {
    appendPlugins: _a,
    showErrorStack: _s,
    extraPlugins = [],
    ...rest
  } = v4Options ?? {};
  return {
    extends: [
      PostGraphileAmberPreset,
      makeV4Preset(rest),
      ...(extraPlugins as string[]).map((name) => {
        const preset = extraPresets[name];
        if (!preset) throw new Error(`No V5 equivalent for ${name}`);
        return preset;
      }),
      ...(plugin ? [PgNestedMutationsPreset] : []),
    ],
  };
}

export interface BuiltSchema {
  schema: GraphQLSchema;
  resolvedPreset: GraphileConfig.ResolvedPreset;
}

/**
 * Builds a V5 schema introspecting through `client` (already inside a
 * transaction, so uncommitted fixtures are visible). `pgSettings` for each
 * request are read from `requestContext.testPgSettings`.
 */
export async function buildSchema(
  client: pg.Client | pg.PoolClient,
  preset: GraphileConfig.Preset,
  schemas: string[] = ["p"],
): Promise<BuiltSchema> {
  const { schema, resolvedPreset } = await makeSchema({
    ...preset,
    pgServices: [
      {
        name: "main",
        schemas,
        withPgClientKey: "withPgClient",
        pgSettingsKey: "pgSettings",
        pgSettings: (ctx: any) => ctx?.testPgSettings ?? {},
        adaptor: adaptor as any,
        adaptorSettings: {
          poolClient: client,
          poolClientIsInTransaction: true,
        },
      } as any,
    ],
  });
  return { schema, resolvedPreset };
}

export async function execute(
  { schema, resolvedPreset }: BuiltSchema,
  source: string,
  variableValues?: Record<string, unknown> | null,
  pgSettings?: Record<string, string>,
) {
  const result = await grafast({
    schema,
    source,
    variableValues: variableValues ?? undefined,
    contextValue: {},
    resolvedPreset,
    requestContext: { testPgSettings: pgSettings ?? {} } as any,
  });
  return JSON.parse(JSON.stringify(result));
}

export function printSorted(schema: GraphQLSchema) {
  return printSchema(lexicographicSortSchema(schema));
}

export const pgQuery =
  (client: pg.Client | pg.PoolClient) =>
  (text: string, values?: unknown[]) =>
    client.query(text, values as any[]);
