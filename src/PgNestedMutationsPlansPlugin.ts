import { object } from "postgraphile/grafast";

import type { PgTableResource } from "./interfaces.ts";
import { PgNestedInsertStep, PgNestedUpdateStep } from "./runtime.ts";
import { version } from "./version.ts";

export const PgNestedMutationsPlansPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsPlansPlugin",
  description:
    "Runs create/update mutations of tables with nested fields through the nested mutation steps",
  version,
  after: ["PgNestedMutationsTypesPlugin"],

  schema: {
    hooks: {
      GraphQLObjectType_fields_field(field, build, context) {
        const { scope } = context;
        const {
          isPgCreateMutation,
          isPgUpdateMutation,
          fieldName,
          fieldBehaviorScope,
        } = scope;
        const pgFieldResource = scope.pgFieldResource as
          | PgTableResource
          | undefined;
        if (!(isPgCreateMutation || isPgUpdateMutation) || !pgFieldResource) {
          return field;
        }
        const state = build.pgNestedMutations;
        const table = state.tables.get(pgFieldResource);
        const nestedFields = state.fieldsByTable
          .get(pgFieldResource)
          ?.filter((f) => f.enabled);
        if (!table || !nestedFields?.length) return field;
        const { inflection } = build;

        if (isPgCreateMutation) {
          return {
            ...field,
            plan(_$root: any, fieldArgs: any) {
              const $insert = new PgNestedInsertStep(
                pgFieldResource,
                state,
                fieldArgs.getRaw(["input", "clientMutationId"]),
              );
              fieldArgs.apply($insert);
              return object({ result: $insert });
            },
          } as typeof field;
        }

        // Update: work out which unique (or node ID) this field uses.
        if (fieldBehaviorScope === "nodeId:resource:update") {
          const pk = table.primaryKey;
          if (!pk || !table.nodeIdHandler) return field;
          const nodeIdFieldName = inflection.nodeIdFieldName();
          return {
            ...field,
            plan(_$root: any, fieldArgs: any) {
              const $update = new PgNestedUpdateStep(
                pgFieldResource,
                state,
                {
                  mode: "node",
                  $nodeId: fieldArgs.getRaw(["input", nodeIdFieldName]),
                  pk: pk.attributes,
                },
                fieldArgs.getRaw(["input", "clientMutationId"]),
              );
              fieldArgs.apply($update);
              return object({ result: $update });
            },
          } as typeof field;
        }
        const unique = pgFieldResource.uniques.find(
          (u: any) =>
            inflection.updateByKeysField({
              resource: pgFieldResource as any,
              unique: u,
            }) === fieldName,
        );
        if (!unique) return field;
        const keyFields = (unique.attributes as string[]).map(
          (attributeName) =>
            [
              attributeName,
              inflection.attribute({
                attributeName,
                codec: pgFieldResource.codec,
              }),
            ] as const,
        );
        return {
          ...field,
          plan(_$root: any, fieldArgs: any) {
            const keys = Object.fromEntries(
              keyFields.map(([attributeName, argName]) => [
                attributeName,
                fieldArgs.getRaw(["input", argName]),
              ]),
            );
            const $update = new PgNestedUpdateStep(
              pgFieldResource,
              state,
              { mode: "keys", keys },
              fieldArgs.getRaw(["input", "clientMutationId"]),
            );
            fieldArgs.apply($update);
            return object({ result: $update });
          },
        } as typeof field;
      },
    },
  },
};
