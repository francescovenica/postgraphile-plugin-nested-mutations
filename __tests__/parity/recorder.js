/*
 * Jest `setupFilesAfterEnv` file. When PARITY_RECORD=1 it records, for every
 * V4 test that uses `withSchema`, the setup SQL, schema options, the V4
 * schema (base and with the plugin) and, for every `graphql()` call, the
 * operation, its result and the resulting database state. The V5 suite
 * replays these "golden" recordings and compares (see v5/test/parity.test.ts).
 */
/* eslint-disable global-require, no-underscore-dangle */
const fs = require('fs');
const path = require('path');

if (process.env.PARITY_RECORD) {
  jest.mock('graphql', () => {
    const actual = jest.requireActual('graphql');
    return {
      ...actual,
      graphql: (...args) => global.mockParityGraphql(actual.graphql, args),
    };
  });
  const { dumpSchema } = require('../../parity/dbstate.cjs');
  const helpers = require('../helpers');
  const { createPostGraphileSchema } = require('postgraphile-core');
  const { printSchema } = require('graphql');

  const cases = [];
  let current = null;

  const nestedMutationsPlugin = require('../../index.js');
  const knownPlugins = new Map([
    [require('@graphile-contrib/pg-simplify-inflector'), 'pg-simplify-inflector'],
  ]);
  const otherPlugins = (options) =>
    ((options && options.appendPlugins) || []).filter(
      (p) => p !== nestedMutationsPlugin,
    );
  const serializableOptions = (options) => {
    const { appendPlugins, ...rest } = options || {};
    const extraPlugins = otherPlugins(options).map((p) => {
      const name = knownPlugins.get(p);
      if (!name) throw new Error('Unknown plugin in parity recording');
      return name;
    });
    return JSON.parse(
      JSON.stringify({
        ...rest,
        ...(extraPlugins.length ? { extraPlugins } : null),
      }),
    );
  };

  global.mockParityGraphql = async (realGraphql, args) => {
    const result = await realGraphql(...args);
    if (current) {
      const [, source, , contextValue, variableValues] = args;
      const dbState = await dumpSchema((t, v) => contextValue.pgClient.query(t, v));
      current.operations.push({
        source,
        variableValues: variableValues || null,
        result: JSON.parse(JSON.stringify(result)),
        dbState,
      });
    }
    return result;
  };

  const realWithSchema = helpers.withSchema;
  helpers.withSchema = ({ setup, test, options = {} }) =>
    realWithSchema({
      setup,
      options,
      test: async ({ schema, pgClient }) => {
        const { currentTestName } = expect.getState();
        const baseSchema = await createPostGraphileSchema(pgClient, ['p'], {
          showErrorStack: true,
          ...options,
          appendPlugins: otherPlugins(options),
        });
        current = {
          name: currentTestName,
          setup: typeof setup === 'string' ? setup : null,
          options: serializableOptions(options),
          schemas: {
            base: printSchema(baseSchema),
            plugin: printSchema(schema),
          },
          initialDbState: null,
          operations: [],
        };
        current.initialDbState = await dumpSchema((t, v) => pgClient.query(t, v));
        cases.push(current);
        try {
          return await test({ schema, pgClient });
        } finally {
          current = null;
        }
      },
    });

  afterAll(() => {
    if (!cases.length) return;
    const { testPath } = expect.getState();
    const name = path.basename(testPath).replace(/\.test\.js$/, '');
    const dir = path.resolve(__dirname, '../../parity/golden');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      `${JSON.stringify({ file: name, cases }, null, 2)}\n`,
    );
  });
}
