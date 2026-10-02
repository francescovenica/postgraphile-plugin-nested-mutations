/*
 * V4 transaction semantics, through PostGraphile V4's own request handling
 * (`withPostGraphileContext`) on a real pool with pgSettings, as a server
 * would run it. Outcomes are recorded (PARITY_RECORD=1) to
 * parity/golden/transactions-v4.json and compared by v5/test/transaction.test.ts.
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { graphql } = require('graphql');
const {
  createPostGraphileSchema,
  withPostGraphileContext,
} = require('postgraphile');
const {
  fixtureSql,
  pgSettings,
  operations,
  captureStatements,
  transactionOf,
} = require('../../parity/transactionFixture.cjs');

const SCHEMA = 'nested_tx_v4';
const outcomes = {};
let pool;
let admin;
let log;

const counts = async () => {
  const { rows } = await admin.query(
    `select (select count(*) from ${SCHEMA}.parent)::int as parent,
            (select count(*) from ${SCHEMA}.child)::int as child,
            (select count(*) from ${SCHEMA}.grandchild)::int as grandchild`,
  );
  return rows[0];
};

const run = async (source) => {
  await admin.query(fixtureSql(SCHEMA));
  const schema = await createPostGraphileSchema(admin, [SCHEMA], {
    appendPlugins: [require('../../index.js')], // eslint-disable-line global-require
  });
  const before = await counts();
  log.length = 0;
  const result = await withPostGraphileContext(
    { pgPool: pool, pgSettings, query: source },
    (context) => graphql(schema, source, null, context),
  );
  const statements = log.slice();
  return {
    result: JSON.parse(JSON.stringify(result)),
    before,
    after: await counts(),
    statements,
  };
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  log = captureStatements(pool);
  // separate (uncaptured) pool for fixtures and introspection
  admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

afterAll(async () => {
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.end();
  await pool.end();
  if (process.env.PARITY_RECORD) {
    fs.writeFileSync(
      path.resolve(__dirname, '../../parity/golden/transactions-v4.json'),
      `${JSON.stringify(outcomes, null, 2)}\n`,
    );
  }
});

test('a nested mutation runs on one backend inside one transaction', async () => {
  const outcome = await run(operations.success);
  expect(outcome.result.errors).toBeUndefined();
  expect(outcome.after).toEqual({
    parent: outcome.before.parent + 1,
    child: outcome.before.child + 1,
    grandchild: outcome.before.grandchild + 1,
  });
  const tx = transactionOf(outcome.statements);
  expect(tx.allWritesOnOneBackend).toBe(true);
  expect(tx.writesInside).toBe(true);
  expect(tx.statements[0].text).toMatch(/^begin/i);
  expect(tx.statements[1].text).toMatch(/set_config/);
  expect(tx.statements[tx.statements.length - 1].text).toMatch(/^commit/i);
  outcomes.success = { result: outcome.result, before: outcome.before, after: outcome.after };
});

test('a failure on the last statement of a 3-level tree changes nothing', async () => {
  const outcome = await run(operations.deepFailure);
  expect(outcome.result.errors).toHaveLength(1);
  expect(outcome.after).toEqual(outcome.before);
  const tx = transactionOf(outcome.statements);
  expect(tx.allWritesOnOneBackend).toBe(true);
  expect(tx.writesInside).toBe(true);
  outcomes.deepFailure = { result: outcome.result, before: outcome.before, after: outcome.after };
});

test('an RLS denial three levels down rolls back the parent', async () => {
  const outcome = await run(operations.deepRlsDenial);
  expect(outcome.result.errors[0].message).toMatch(/row-level security/);
  expect(outcome.after).toEqual(outcome.before);
  outcomes.deepRlsDenial = { result: outcome.result, before: outcome.before, after: outcome.after };
});

test('multiple root fields: the first persists when the second fails', async () => {
  const outcome = await run(operations.multipleRootFields);
  expect(outcome.result.errors).toHaveLength(1);
  expect(outcome.result.errors[0].path).toEqual(['second']);
  expect(outcome.after).toEqual({
    parent: outcome.before.parent + 1,
    child: outcome.before.child + 1,
    grandchild: outcome.before.grandchild + 1,
  });
  outcomes.multipleRootFields = {
    result: outcome.result,
    before: outcome.before,
    after: outcome.after,
  };
});
