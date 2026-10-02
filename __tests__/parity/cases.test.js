/*
 * Runs the data-driven fixtures in parity/cases/*.cjs against V4. Each
 * operation's `expect` is asserted here; with PARITY_RECORD=1 the results
 * are written to parity/golden/cases-<file>.json for the V5 comparison.
 *
 * pgSettings are applied the way PostGraphile V4 does it for a request:
 * `set_config(key, value, true)` inside the request's transaction.
 */
/* eslint-disable global-require, import/no-dynamic-require */
const fs = require('fs');
const path = require('path');
const { graphql, printSchema } = require('graphql');
const { createPostGraphileSchema } = require('postgraphile-core');
const { withPgClient } = require('../helpers');
const { dumpSchema, resetSettings } = require('../../parity/dbstate.cjs');

const casesDir = path.resolve(__dirname, '../../parity/cases');
const goldenDir = path.resolve(__dirname, '../../parity/golden');
const plugin = require('../../index.js');

const files = fs
  .readdirSync(casesDir)
  .filter((f) => f.endsWith('.cjs'))
  .sort();

files.forEach((file) => {
  const cases = require(path.join(casesDir, file));
  const recorded = [];

  describe(file, () => {
    cases.forEach((parityCase) => {
      test(parityCase.name, () =>
        withPgClient(async (pgClient) => {
          const query = (text, values) => pgClient.query(text, values);
          await pgClient.query(parityCase.setup);
          const options = parityCase.options || {};
          const baseSchema = await createPostGraphileSchema(pgClient, ['p'], {
            ...options,
          });
          const schema = await createPostGraphileSchema(pgClient, ['p'], {
            ...options,
            appendPlugins: [plugin],
          });
          const record = {
            name: parityCase.name,
            setup: parityCase.setup,
            options,
            schemas: {
              base: printSchema(baseSchema),
              plugin: printSchema(schema),
            },
            initialDbState: await dumpSchema(query),
            operations: [],
          };

          let before = record.initialDbState;
          // eslint-disable-next-line no-restricted-syntax
          for (const op of parityCase.operations) {
            const pgSettings = op.pgSettings || {};
            // A V4 request runs in its own transaction; mirror that with a
            // savepoint so we can tell if V4 left the transaction aborted
            // (its COMMIT would then roll the whole request back).
            // eslint-disable-next-line no-await-in-loop
            await pgClient.query('savepoint parity_op');
            // eslint-disable-next-line no-restricted-syntax
            for (const [key, value] of Object.entries(pgSettings)) {
              // eslint-disable-next-line no-await-in-loop
              await pgClient.query('select set_config($1, $2, true)', [
                key,
                value,
              ]);
            }
            // eslint-disable-next-line no-await-in-loop
            const result = await graphql(
              schema,
              op.source,
              null,
              { pgClient },
              op.variableValues || undefined,
            );
            let transactionAborted = false;
            try {
              // eslint-disable-next-line no-await-in-loop
              await resetSettings(query, pgSettings);
              // eslint-disable-next-line no-await-in-loop
              await pgClient.query('release savepoint parity_op');
            } catch (e) {
              if (e.code !== '25P02') throw e;
              transactionAborted = true;
              // eslint-disable-next-line no-await-in-loop
              await pgClient.query('rollback to savepoint parity_op');
              // eslint-disable-next-line no-await-in-loop
              await resetSettings(query, pgSettings);
            }
            // eslint-disable-next-line no-await-in-loop
            const dbState = await dumpSchema(query);
            const expected = op.expect || {};
            if (expected.errors !== undefined) {
              expect(!!result.errors).toBe(expected.errors);
            }
            if (expected.dbUnchanged) {
              expect(dbState).toEqual(before);
            }
            record.operations.push({
              source: op.source,
              variableValues: op.variableValues || null,
              ...(op.pgSettings ? { pgSettings: op.pgSettings } : null),
              ...(op.expect ? { expect: op.expect } : null),
              ...(transactionAborted ? { v4TransactionAborted: true } : null),
              result: JSON.parse(JSON.stringify(result)),
              dbState,
            });
            before = dbState;
          }
          recorded.push(record);
        }),
      );
    });

    afterAll(() => {
      if (!process.env.PARITY_RECORD) return;
      const name = `cases-${file.replace(/\.cjs$/, '')}`;
      fs.writeFileSync(
        path.join(goldenDir, `${name}.json`),
        `${JSON.stringify({ file: name, cases: recorded }, null, 2)}\n`,
      );
    });
  });
});
