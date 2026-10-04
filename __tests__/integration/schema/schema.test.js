import * as core from './core.js';

test(
  'prints a schema with the nested mutations plugin',
  core.test(['p'], {}),
);

test(
  'prints a schema with the nested mutations plugin in simple names mode',
  core.test(['p'], {
    graphileBuildOptions: {
      nestedMutationsSimpleFieldNames: true,
    },
  }),
);
