/*
 * V5 transaction semantics on a real pool with pgSettings (role + JWT
 * claims), compared with the outcomes recorded from the V4 plugin in
 * parity/golden/transactions-v4.json.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll as after, beforeAll as before, test } from "vitest";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { makeSchema } from "postgraphile";
import { makePgService } from "postgraphile/adaptors/pg";
import { grafast } from "postgraphile/grafast";
import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { makeV4Preset } from "postgraphile/presets/v4";

import { PgNestedMutationsPreset } from "../src/index.ts";
import { TEST_DATABASE_URL } from "./support/harness.ts";
import { normalizeResult } from "./support/normalize.ts";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  fixtureSql,
  pgSettings,
  operations,
  captureStatements,
  transactionOf,
} = require("../parity/transactionFixture.cjs");

const SCHEMA = "nested_tx_v5";
const v4OutcomesPath = join(root, "parity/golden/transactions-v4.json");
const v4Outcomes = existsSync(v4OutcomesPath)
  ? JSON.parse(readFileSync(v4OutcomesPath, "utf8"))
  : null;

let pool: pg.Pool;
let admin: pg.Pool;
let log: Array<{ pid: number; text: string }>;

before(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  log = captureStatements(pool);
  admin = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});

after(async () => {
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.end();
  await pool.end();
});

async function counts() {
  const { rows } = await admin.query(
    `select (select count(*) from ${SCHEMA}.parent)::int as parent,
            (select count(*) from ${SCHEMA}.child)::int as child,
            (select count(*) from ${SCHEMA}.grandchild)::int as grandchild`,
  );
  return rows[0];
}

async function run(source: string) {
  await admin.query(fixtureSql(SCHEMA));
  const pgService = makePgService({
    pool,
    schemas: [SCHEMA],
    pubsub: false,
    pgSettings: (() => pgSettings) as any,
  });
  const { schema, resolvedPreset } = await makeSchema({
    extends: [PostGraphileAmberPreset, makeV4Preset({}), PgNestedMutationsPreset],
    pgServices: [pgService],
  });
  const beforeCounts = await counts();
  log.length = 0;
  const result = await grafast({
    schema,
    source,
    contextValue: {},
    resolvedPreset,
    requestContext: {},
  });
  const statements = log.slice();
  return {
    result: JSON.parse(JSON.stringify(result)),
    before: beforeCounts,
    after: await counts(),
    statements,
  };
}

function sameAsV4(name: string, outcome: any) {
  assert.ok(v4Outcomes, "parity/golden/transactions-v4.json is missing");
  const v4 = v4Outcomes[name];
  assert.deepEqual(normalizeResult(outcome.result), normalizeResult(v4.result));
  assert.deepEqual(outcome.before, v4.before);
  assert.deepEqual(outcome.after, v4.after);
}

test("a nested mutation runs on one backend inside one transaction", async () => {
  const outcome = await run(operations.success);
  assert.equal(outcome.result.errors, undefined);
  const tx = transactionOf(outcome.statements);
  assert.equal(tx.allWritesOnOneBackend, true);
  assert.equal(tx.writesInside, true);
  assert.match(tx.statements[0].text, /^begin/i);
  // pgSettings (role, JWT claims) are applied inside that same transaction
  assert.match(tx.statements[1].text, /set_config/);
  assert.match(tx.statements.at(-1)!.text, /^commit/i);
  // the payload's root row is re-selected inside the transaction too
  const lastWrite = tx.statements.findLastIndex((s: any) =>
    /^\s*(insert|update|delete)\b/i.test(s.text),
  );
  assert.ok(
    tx.statements
      .slice(lastWrite + 1)
      .some((s: any) => /^select\b/i.test(s.text) && s.text.includes(`"${SCHEMA}"."parent"`)),
    "payload re-select inside the transaction",
  );
  sameAsV4("success", outcome);
});

test("a failure on the last statement of a 3-level tree changes nothing", async () => {
  const outcome = await run(operations.deepFailure);
  assert.equal(outcome.result.errors.length, 1);
  assert.deepEqual(outcome.after, outcome.before);
  const tx = transactionOf(outcome.statements);
  assert.equal(tx.allWritesOnOneBackend, true);
  assert.equal(tx.writesInside, true);
  assert.match(tx.statements.at(-1)!.text, /^rollback/i);
  sameAsV4("deepFailure", outcome);
});

test("an RLS denial three levels down rolls back the parent", async () => {
  const outcome = await run(operations.deepRlsDenial);
  assert.match(outcome.result.errors[0].message, /row-level security/);
  assert.deepEqual(outcome.after, outcome.before);
  const tx = transactionOf(outcome.statements);
  assert.equal(tx.allWritesOnOneBackend, true);
  assert.match(tx.statements[1].text, /set_config/);
  assert.match(tx.statements.at(-1)!.text, /^rollback/i);
  sameAsV4("deepRlsDenial", outcome);
});

test("multiple root fields: the first persists when the second fails", async () => {
  const outcome = await run(operations.multipleRootFields);
  assert.equal(outcome.result.errors.length, 1);
  assert.deepEqual(outcome.result.errors[0].path, ["second"]);
  sameAsV4("multipleRootFields", outcome);
});
