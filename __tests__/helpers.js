/*
 * Helpers for the integration tests. Each test runs inside a transaction
 * that is rolled back, against a schema built with PostGraphile V5, the V4
 * compatibility preset (configured from the test's V4-style `options`) and
 * this plugin.
 */
import {
  buildSchema,
  execute,
  presetFromV4Options,
  withRolledBackClient,
} from './support/harness.ts';

const builtSchemas = new WeakMap();

export const withSchema =
  ({ setup, test, options = {} }) =>
  () =>
    withRolledBackClient(async (client) => {
      if (setup) {
        if (typeof setup === 'function') {
          await setup(client);
        } else {
          await client.query(setup);
        }
      }
      const built = await buildSchema(
        client,
        presetFromV4Options(options, { plugin: true }),
      );
      builtSchemas.set(built.schema, built);
      return test({ schema: built.schema, pgClient: client });
    });

/**
 * Same call signature as graphql-js's positional `graphql()`. The context is
 * ignored: the schema already runs its queries through the test's client.
 */
export const graphql = (schema, source, _rootValue, _context, variableValues) =>
  execute(builtSchemas.get(schema), source, variableValues);
