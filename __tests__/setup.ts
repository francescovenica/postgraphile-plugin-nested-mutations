import { GraphQLSchema } from "postgraphile/graphql";
import { expect } from "vitest";

import { printSorted } from "./support/harness.ts";

// Snapshot schemas as sorted SDL.
expect.addSnapshotSerializer({
  test: (value) => value instanceof GraphQLSchema,
  serialize: (value) => printSorted(value),
});
