import type {
  GraphQLInputFieldConfigMap,
  GraphQLInputType,
} from "postgraphile/graphql";

import type { NestedRelationField, PgTableResource } from "./interfaces.ts";
import { makeApplyNestedField } from "./runtime.ts";
import { version } from "./version.ts";

function isTableInputScope(scope: GraphileBuild.ScopeInputObject) {
  return (
    !!scope.pgCodec &&
    !!scope.isPgRowType &&
    !scope.isPgBaseInput &&
    (!!scope.isInputType || !!scope.isPgPatch)
  );
}

function tableResource(
  build: GraphileBuild.Build,
  scope: GraphileBuild.ScopeInputObject,
) {
  if (!isTableInputScope(scope)) return undefined;
  return build.pgTableResource(scope.pgCodec as any) as
    | PgTableResource
    | undefined;
}

export const PgNestedMutationsFieldsPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsFieldsPlugin",
  description:
    "Adds the nested relation fields to table input and patch types",
  version,
  after: ["PgNestedMutationsTypesPlugin"],

  schema: {
    hooks: {
      GraphQLInputObjectType_fields(fields, build, context) {
        const { scope, fieldWithHooks } = context;
        const resource = tableResource(build, scope);
        if (!resource) return fields;
        const state = build.pgNestedMutations;
        const nestedFields = state.fieldsByTable
          .get(resource)
          ?.filter((f) => f.enabled);
        if (!nestedFields?.length) return fields;

        const newFields: GraphQLInputFieldConfigMap = Object.create(null);
        // V4 re-adds a forward key that was omitted from the input, as a
        // nullable field. Keys that exist are made nullable in the hook below.
        const nullableKeys = state.tables.get(resource)?.nullableKeyFieldNames;
        for (const [keyFieldName, attributeName] of nullableKeys ?? []) {
          if (keyFieldName in fields) continue;
          const type = build.getGraphQLTypeByPgCodec(
            resource.codec.attributes[attributeName].codec,
            "input",
          ) as GraphQLInputType | undefined;
          if (type) {
            newFields[keyFieldName] = {
              type: build.graphql.getNullableType(type) as GraphQLInputType,
            };
          }
        }
        for (const field of nestedFields) {
          newFields[field.fieldName] = nestedFieldSpec(
            build,
            fieldWithHooks,
            field,
          );
        }
        return build.extend(
          fields,
          newFields,
          `PgNestedMutationsFieldsPlugin nested fields for ${resource.name}`,
        );
      },

      GraphQLInputObjectType_fields_field(field, build, context) {
        const { scope } = context;
        const resource = tableResource(build, scope);
        if (!resource) return field;
        // Allow nulls on keys that have forward mutations available.
        const nullableKeys = build.pgNestedMutations.tables.get(resource)
          ?.nullableKeyFieldNames;
        if (!nullableKeys?.has(scope.fieldName)) return field;
        return {
          ...field,
          type: build.graphql.getNullableType(field.type),
        };
      },
    },
  },
};

function nestedFieldSpec(
  build: GraphileBuild.Build,
  fieldWithHooks: GraphileBuild.ContextInputObjectFields["fieldWithHooks"],
  field: NestedRelationField,
) {
  return fieldWithHooks(
    {
      fieldName: field.fieldName,
      isNestedMutationField: true,
    },
    () => ({
      type: build.getInputTypeByName(field.connectorTypeName),
      apply: makeApplyNestedField(field),
    }),
  );
}
