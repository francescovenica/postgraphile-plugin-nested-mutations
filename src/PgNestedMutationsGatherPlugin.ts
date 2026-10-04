import { gatherConfig } from "postgraphile/graphile-build";

import { version } from "./version.ts";

/**
 * V5 relations and uniques don't keep the constraint they came from; V4 used
 * the constraint name in type names and its introspection order for field
 * order, so record both on the relation/unique extensions.
 */
export const PgNestedMutationsGatherPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsGatherPlugin",
  description:
    "Records the originating constraint on relations and uniques for nested mutations",
  version,
  after: ["smart-tags", "PgRelationsPlugin", "PgTablesPlugin"],

  gather: gatherConfig({
    namespace: "pgNestedMutations",
    helpers: {},
    hooks: {
      pgRelations_relation(_info, event) {
        const { pgConstraint, relation } = event;
        const extensions = ((relation as any).extensions ??= {});
        extensions.nestedMutations = {
          constraintName: pgConstraint.conname,
          constraintId: pgConstraint._id,
          sortKey: [
            Number(pgConstraint.conrelid),
            [...(pgConstraint.conkey ?? [])],
            Number(pgConstraint.confrelid ?? 0),
            [...(pgConstraint.confkey ?? [])],
            pgConstraint.conname,
          ],
          isSelfReference: pgConstraint.conrelid === pgConstraint.confrelid,
        };
      },
      pgTables_unique(_info, event) {
        const { pgConstraint, unique } = event;
        const extensions = ((unique as any).extensions ??= {});
        extensions.nestedMutations = {
          constraintName: pgConstraint.conname,
          sortKey: [
            Number(pgConstraint.conrelid),
            [...(pgConstraint.conkey ?? [])],
            0,
            [],
            pgConstraint.conname,
          ],
        };
      },
    },
  }),
};
