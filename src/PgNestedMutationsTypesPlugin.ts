import type { PgCodecRelation } from "postgraphile/@dataplan/pg";
import type { GraphQLInputFieldConfigMap } from "postgraphile/graphql";

import type {
  NestedKeyField,
  NestedMutationsState,
  NestedRelationField,
  NestedTable,
} from "./interfaces.ts";
import { buildNestedState } from "./metadata.ts";
import { nestedBehavior } from "./PgNestedMutationsBehaviorPlugin.ts";
import {
  applyDeleteOthers,
  applyNodeId,
  applyUpdatePatch,
  makeApplyCreateField,
  makeApplyKeyAttribute,
  makeApplyLookupField,
} from "./runtime.ts";
import { version } from "./version.ts";

export const PgNestedMutationsTypesPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsTypesPlugin",
  description:
    "Works out the nested mutation fields and registers their input types",
  version,
  after: [
    "PgNestedMutationsInflectionPlugin",
    "PgNestedMutationsBehaviorPlugin",
    "PgRelationsPlugin",
    "PgTablesPlugin",
    "PgAttributesPlugin",
    "PgMutationCreatePlugin",
    "PgMutationUpdateDeletePlugin",
    "PgTableNodePlugin",
    "PostGraphileV4CompatibilityPlugin",
  ],

  schema: {
    hooks: {
      build(build) {
        return build.extend(
          build,
          {
            pgNestedMutations: {
              tables: new Map(),
              fieldsByTable: new Map(),
              constraints: new Map(),
            } as NestedMutationsState,
          },
          "Adding nested mutations state",
        );
      },

      init(_, build) {
        Object.assign(build.pgNestedMutations, buildNestedState(build));
        registerTypes(build, build.pgNestedMutations);
        return _;
      },
    },
  },
};

/** Registers every input type the plugin may reference (V4 parity). */
function registerTypes(
  build: GraphileBuild.Build,
  state: NestedMutationsState,
) {
  const {
    inflection,
    graphql: { GraphQLNonNull, GraphQLList, GraphQLID, GraphQLBoolean },
  } = build;
  const nodeIdFieldName = inflection.nodeIdFieldName?.() ?? "id";
  const registered = new Set<string>();
  const register = (
    typeName: string,
    scope: GraphileBuild.ScopeInputObject,
    spec: () => {
      description: string;
      fields: () => GraphQLInputFieldConfigMap;
    },
    origin: string,
  ) => {
    if (registered.has(typeName)) return;
    registered.add(typeName);
    build.registerInputObjectType(typeName, scope, spec as any, origin);
  };

  const keyAttributeFields = (
    table: NestedTable,
    attributes: readonly string[],
  ): GraphQLInputFieldConfigMap => {
    const out: GraphQLInputFieldConfigMap = Object.create(null);
    for (const attributeName of attributes) {
      const attribute = table.codec.attributes[attributeName];
      out[inflection.attribute({ attributeName, codec: table.codec })] = {
        description: attribute.description,
        type: new GraphQLNonNull(
          build.getGraphQLTypeByPgCodec(attribute.codec, "input") as any,
        ),
        extensions: {
          grafast: { apply: makeApplyKeyAttribute(attributeName) },
        },
      } as any;
    }
    return out;
  };

  // Connect / delete lookup types, per table (V4 root mutation hooks)
  for (const table of state.tables.values()) {
    const { resource, tableFieldName } = table;
    for (const [list, verb] of [
      [table.connectorFields, "connect"],
      [table.deleterFields, "delete"],
    ] as const) {
      const pastVerb = verb === "connect" ? "connected" : "deleted";
      for (const keyField of list) {
        const isNode = keyField.unique === null;
        register(
          keyField.typeName,
          {
            isNestedMutationInputType: true,
            ...(verb === "connect"
              ? {
                  isNestedMutationConnectInputType: true,
                  ...(isNode
                    ? { isNestedMutationConnectByNodeIdType: true }
                    : null),
                }
              : {
                  isNestedMutationDeleteInputType: true,
                  ...(isNode
                    ? { isNestedMutationDeleteByNodeIdType: true }
                    : null),
                }),
            pgNestedTable: resource,
          },
          () =>
            isNode
              ? {
                  description: `The globally unique \`ID\` look up for the row to ${verb}.`,
                  fields: () => ({
                    [nodeIdFieldName]: {
                      description: `The globally unique \`ID\` which identifies a single \`${tableFieldName}\` to be ${pastVerb}.`,
                      type: new GraphQLNonNull(GraphQLID),
                      extensions: { grafast: { apply: applyNodeId } },
                    } as any,
                  }),
                }
              : {
                  description: `The fields on \`${tableFieldName}\` to look up the row to ${verb}.`,
                  fields: () =>
                    keyAttributeFields(table, keyField.unique!.attributes),
                },
          `PgNestedMutationsTypesPlugin ${verb} type for ${resource.name}`,
        );
      }
    }
  }

  // Update types, per (table, constraint) (V4 NestedUpdatersPlugin)
  for (const table of state.tables.values()) {
    for (const [constraintId, updaterFields] of table.updaterFields) {
      if (!updaterFields.length) continue;
      const constraint = findConstraint(state, constraintId);
      if (!constraint) continue;
      const foreignResource =
        constraint.resource === table.resource
          ? constraint.foreignResource
          : constraint.resource;
      const foreignTable = state.tables.get(foreignResource)!;
      const foreignTableFieldName = foreignTable.tableFieldName;
      const patchTypeName = inflection.nestedUpdatePatchType({
        table: foreignResource,
        constraint,
      });
      const omittedFields = constraint.keyAttributes.map((attributeName) =>
        inflection.attribute({
          attributeName,
          codec: constraint.resource.codec,
        }),
      );
      register(
        patchTypeName,
        {
          isNestedMutationPatchType: true,
          pgNestedTable: foreignResource,
        },
        () => ({
          description: `An object where the defined keys will be set on the \`${foreignTableFieldName}\` being updated.`,
          fields: () =>
            copyInputFields(
              build,
              foreignTable.patchTypeName!,
              (name) => !omittedFields.includes(name),
            ),
        }),
        `PgNestedMutationsTypesPlugin patch type for ${foreignResource.name} via ${constraint.name}`,
      );

      for (const updaterField of updaterFields) {
        const isNode = updaterField.unique === null;
        register(
          updaterField.typeName,
          {
            isNestedMutationInputType: true,
            isNestedMutationUpdateInputType: true,
            ...(isNode ? { isNestedMutationUpdateByNodeIdType: true } : null),
            pgNestedTable: foreignResource,
          },
          () =>
            isNode
              ? {
                  description:
                    "The globally unique `ID` look up for the row to update.",
                  fields: () => ({
                    [nodeIdFieldName]: {
                      description: `The globally unique \`ID\` which identifies a single \`${foreignTableFieldName}\` to be connected.`,
                      type: new GraphQLNonNull(GraphQLID),
                      extensions: { grafast: { apply: applyNodeId } },
                    } as any,
                    [updaterField.patchFieldName]: {
                      description: `An object where the defined keys will be set on the \`${foreignTableFieldName}\` being updated.`,
                      type: new GraphQLNonNull(
                        build.getInputTypeByName(foreignTable.patchTypeName!),
                      ),
                      extensions: { grafast: { apply: applyUpdatePatch } },
                    } as any,
                  }),
                }
              : {
                  description: `The fields on \`${foreignTableFieldName}\` to look up the row to update.`,
                  fields: () => ({
                    [updaterField.patchFieldName]: {
                      description: `An object where the defined keys will be set on the \`${foreignTableFieldName}\` being updated.`,
                      type: new GraphQLNonNull(
                        build.getInputTypeByName(patchTypeName),
                      ),
                      extensions: { grafast: { apply: applyUpdatePatch } },
                    } as any,
                    ...keyAttributeFields(
                      foreignTable,
                      updaterField.unique!.attributes,
                    ),
                  }),
                },
          `PgNestedMutationsTypesPlugin update type for ${foreignResource.name} via ${constraint.name}`,
        );
      }
    }
  }

  // Connector + create types, per nested field (V4 NestedTypesPlugin)
  for (const fields of state.fieldsByTable.values()) {
    for (const field of fields) {
      const { table, foreignTable, isForward, isUnique } = field;
      const foreignTableName = foreignTable.tableFieldName;
      const tableTypeName = table.inputTypeName!;
      const canCreate = field.creatable && !!foreignTable.inputTypeName;
      if (canCreate) {
        register(
          field.createTypeName,
          {
            isNestedMutationInputType: true,
            isNestedMutationCreateInputType: true,
            isNestedInverseMutation: !isForward,
            pgNestedTable: table.resource,
            pgNestedForeignTable: foreignTable.resource,
          },
          () => ({
            description: `The \`${foreignTableName}\` to be created by this mutation.`,
            fields: () => copyInputFields(build, foreignTable.inputTypeName!),
          }),
          `PgNestedMutationsTypesPlugin create type for ${field.constraint.name}`,
        );
      }

      const wrap = (typeName: string) => {
        const type = build.getInputTypeByName(typeName);
        return isForward || isUnique
          ? type
          : new GraphQLList(new GraphQLNonNull(type));
      };
      const isList = !(isForward || isUnique);

      register(
        field.connectorTypeName,
        {
          isNestedMutationConnectorType: true,
          isNestedInverseMutation: !isForward,
          pgNestedTable: table.resource,
          pgNestedForeignTable: foreignTable.resource,
        },
        () => ({
          description: `Input for the nested mutation of \`${foreignTableName}\` in the \`${tableTypeName}\` mutation.`,
          fields: () => {
            const operations: GraphQLInputFieldConfigMap = Object.create(null);
            if (!isForward && field.deleteable) {
              const deleteOthersAllowed = relationAllows(
                build,
                field,
                nestedBehavior.deleteOthers,
              );
              if (deleteOthersAllowed) {
                operations.deleteOthers = {
                  description: `Flag indicating whether all other \`${foreignTableName}\` records that match this relationship should be removed.`,
                  type: GraphQLBoolean,
                  extensions: { grafast: { apply: applyDeleteOthers } },
                } as any;
              }
            }
            for (const keyField of field.connectorFields) {
              operations[keyField.fieldName] = {
                description: `The primary key(s) for \`${foreignTableName}\` for the far side of the relationship.`,
                type: wrap(keyField.typeName),
                extensions: {
                  grafast: {
                    apply: makeApplyLookupField("connect", keyField, isList),
                  },
                },
              } as any;
            }
            for (const keyField of field.deleterFields) {
              operations[keyField.fieldName] = {
                description: `The primary key(s) for \`${foreignTableName}\` for the far side of the relationship.`,
                type: wrap(keyField.typeName),
                extensions: {
                  grafast: {
                    apply: makeApplyLookupField("delete", keyField, isList),
                  },
                },
              } as any;
            }
            for (const updaterField of field.updaterFields) {
              operations[updaterField.fieldName] = {
                description: `The primary key(s) and patch data for \`${foreignTableName}\` for the far side of the relationship.`,
                type: wrap(updaterField.typeName),
                extensions: {
                  grafast: {
                    apply: makeApplyLookupField(
                      "update",
                      updaterField as NestedKeyField,
                      isList,
                    ),
                  },
                },
              } as any;
            }
            if (canCreate) {
              const createType = build.getInputTypeByName(field.createTypeName);
              operations.create = {
                description: `A \`${foreignTable.inputTypeName}\` object that will be created and connected to this object.`,
                type: isForward
                  ? createType
                  : new GraphQLList(new GraphQLNonNull(createType)),
                extensions: {
                  grafast: { apply: makeApplyCreateField(!isForward) },
                },
              } as any;
            }
            return operations;
          },
        }),
        `PgNestedMutationsTypesPlugin connector type for ${field.constraint.name}`,
      );
    }
  }
}

function relationAllows(
  build: GraphileBuild.Build,
  field: NestedRelationField,
  filter: string,
) {
  const relation: PgCodecRelation | null = field.isForward
    ? field.constraint.forwardRelation
    : field.constraint.backwardRelation;
  const entity =
    relation ??
    field.constraint.forwardRelation ??
    field.constraint.backwardRelation;
  return (
    !!entity && !!build.behavior.pgCodecRelationMatches(entity, filter as any)
  );
}

function findConstraint(state: NestedMutationsState, constraintId: string) {
  return state.constraints.get(constraintId) ?? null;
}

/** V4 copied `_fields` from the source input type, nested fields included. */
function copyInputFields(
  build: GraphileBuild.Build,
  typeName: string,
  filter: (name: string) => boolean = () => true,
): GraphQLInputFieldConfigMap {
  const source = build.getInputTypeByName(typeName) as any;
  const out: GraphQLInputFieldConfigMap = Object.create(null);
  for (const [name, f] of Object.entries<any>(source.getFields())) {
    if (!filter(name)) continue;
    out[name] = {
      description: f.description,
      type: f.type,
      defaultValue: f.defaultValue,
      deprecationReason: f.deprecationReason,
      extensions: f.extensions,
    };
  }
  return out;
}
