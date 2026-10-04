import {
  buildSchema,
  presetFromV4Options,
  withRolledBackClient,
} from '../../support/harness.ts';

export const test = (schemas, options, setup) => () =>
  withRolledBackClient(async (client) => {
    if (setup) {
      if (typeof setup === 'function') {
        await setup(client);
      } else {
        await client.query(setup);
      }
    }
    const { schema } = await buildSchema(
      client,
      presetFromV4Options(options, { plugin: true }),
      schemas,
    );
    expect(schema).toMatchSnapshot();
  });
