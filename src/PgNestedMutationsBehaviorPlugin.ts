import { version } from "./version.ts";

/**
 * The behavior strings this plugin uses, defined once. Each is also declared
 * in `GraphileBuild.BehaviorStrings` (interfaces.ts), so typos fail to compile.
 */
export const nestedBehavior = {
  connect: "nestedMutation:connect",
  insert: "nestedMutation:insert",
  update: "nestedMutation:update",
  delete: "nestedMutation:delete",
  deleteOthers: "nestedMutation:deleteOthers",
} as const;

export const PgNestedMutationsBehaviorPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsBehaviorPlugin",
  description:
    "Registers the per-relation `nestedMutation:*` behaviors, enabled by default",
  version,

  schema: {
    behaviorRegistry: {
      add: {
        [nestedBehavior.connect]: {
          description:
            "nested mutations: can connect existing rows through this relation (connectBy*)",
          entities: ["pgCodecRelation"],
        },
        [nestedBehavior.insert]: {
          description:
            "nested mutations: can create rows through this relation (create)",
          entities: ["pgCodecRelation"],
        },
        [nestedBehavior.update]: {
          description:
            "nested mutations: can update related rows through this relation (updateBy*)",
          entities: ["pgCodecRelation"],
        },
        [nestedBehavior.delete]: {
          description:
            "nested mutations: can delete related rows through this relation (deleteBy*, deleteOthers)",
          entities: ["pgCodecRelation"],
        },
        [nestedBehavior.deleteOthers]: {
          description:
            "nested mutations: expose `deleteOthers` on this (reverse) relation",
          entities: ["pgCodecRelation"],
        },
      },
    },

    entityBehavior: {
      pgCodecRelation: {
        inferred: {
          provides: ["default"],
          before: ["inferred", "override"],
          callback(behavior) {
            return [...Object.values(nestedBehavior), behavior];
          },
        },
      },
    },
  },
};
