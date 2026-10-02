import type { PgCodecRelation } from "postgraphile/@dataplan/pg";
import { object } from "postgraphile/grafast";
import type {
  GraphQLInputFieldConfigMap,
  GraphQLInputType,
} from "postgraphile/graphql";

import { inflectors } from "./inflection.ts";
import type {
  NestedKeyField,
  NestedMutationsState,
  NestedRelationField,
  NestedTable,
  NestedUpdaterField,
  PgTableResource,
} from "./interfaces.ts";
import { buildNestedState } from "./metadata.ts";
import {
  applyDeleteOthers,
  applyNodeId,
  applyUpdatePatch,
  makeApplyCreateField,
  makeApplyKeyAttribute,
  makeApplyLookupField,
  makeApplyNestedField,
  PgNestedInsertStep,
  PgNestedUpdateStep,
} from "./runtime.ts";
import { version } from "./version.ts";

/** V4 `@omit` parsing (only what we need: does it cover `update`?) */
function v4OmitIncludes(omit: unknown, permission: string): boolean {
  if (!omit) return false;
  const list = Array.isArray(omit) ? omit : [omit];
  const letters: Record<string, string> = {
    C: "create",
    R: "read",
    U: "update",
    D: "delete",
  };
  return list.some((entry) => {
    if (entry === true || entry === "*") return true;
    if (typeof entry !== "string") return false;
    const parts =
      entry[0] === ":"
        ? entry
            .slice(1)
            .split("")
            .map((l) => letters[l])
        : entry.split(",").map((p) => p.trim());
    return parts.includes(permission);
  });
}

/**
 * The V4 preset translates `@omit update` on a constraint into `-update`,
 * which would also match our `nestedMutation:update` behavior. V4 ignored a
 * constraint's `@omit update` for nested `updateBy*` fields, so re-enable it
 * straight after the translated entry (an explicit `@behavior` set by the
 * user still comes later and wins).
 */
function keepNestedUpdateDespiteV4Omit(tags: Record<string, any>) {
  const behavior = tags.behavior;
  const list: string[] = Array.isArray(behavior)
    ? [...behavior]
    : typeof behavior === "string"
      ? [behavior]
      : [];
  const idx = list.findIndex((b) =>
    String(b)
      .split(/\s+/)
      .some((token) => token === "-update"),
  );
  if (idx < 0) return;
  list.splice(idx + 1, 0, "+nestedMutation:update");
  tags.behavior = list;
}

const nestedBehaviors = [
  "nestedMutation:connect",
  "nestedMutation:insert",
  "nestedMutation:update",
  "nestedMutation:delete",
  "nestedMutation:deleteOthers",
] as const;

function isTableInputScope(scope: GraphileBuild.ScopeInputObject) {
  return (
    !!scope.pgCodec &&
    !!scope.isPgRowType &&
    !scope.isPgBaseInput &&
    (!!scope.isInputType || !!scope.isPgPatch)
  );
}

export const PgNestedMutationsPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsPlugin",
  description:
    "Nested mutations (create/connect/update/delete related rows) on create and update mutations",
  version,
  after: [
    "smart-tags",
    "PgRelationsPlugin",
    "PgTablesPlugin",
    "PgAttributesPlugin",
    "PgMutationCreatePlugin",
    "PgMutationUpdateDeletePlugin",
    "PgTableNodePlugin",
    "PostGraphileV4CompatibilityPlugin",
  ],

  gather: {
    hooks: {
      pgRelations_relation(_info, event) {
        const { pgConstraint, relation } = event;
        const rawTags = pgConstraint.getTags() as Record<string, any>;
        const v4OmitUpdate = v4OmitIncludes(rawTags.omit, "update");
        const extensions = ((relation as any).extensions ??= {});
        const tags = (extensions.tags ??= {});
        if (v4OmitUpdate) keepNestedUpdateDespiteV4Omit(tags);
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
          v4OmitUpdate,
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
  },

  inflection: {
    add: inflectors,
  },

  schema: {
    behaviorRegistry: {
      add: {
        "nestedMutation:connect": {
          description:
            "nested mutations: can connect existing rows through this relation (connectBy*)",
          entities: ["pgCodecRelation"],
        },
        "nestedMutation:insert": {
          description:
            "nested mutations: can create rows through this relation (create)",
          entities: ["pgCodecRelation"],
        },
        "nestedMutation:update": {
          description:
            "nested mutations: can update related rows through this relation (updateBy*)",
          entities: ["pgCodecRelation"],
        },
        "nestedMutation:delete": {
          description:
            "nested mutations: can delete related rows through this relation (deleteBy*, deleteOthers)",
          entities: ["pgCodecRelation"],
        },
        "nestedMutation:deleteOthers": {
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
            return [...nestedBehaviors, behavior];
          },
        },
      },
    },

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
        const state = buildNestedState(build);
        build.pgNestedMutations.tables = state.tables;
        build.pgNestedMutations.fieldsByTable = state.fieldsByTable;
        build.pgNestedMutations.constraints = state.constraints;
        registerTypes(build, build.pgNestedMutations);
        return _;
      },

      GraphQLInputObjectType_fields(fields, build, context) {
        const { scope, fieldWithHooks } = context;
        if (!isTableInputScope(scope)) return fields;
        const resource = build.pgTableResource(scope.pgCodec as any) as
          | PgTableResource
          | undefined;
        if (!resource) return fields;
        const nestedFields = build.pgNestedMutations.fieldsByTable
          .get(resource)
          ?.filter((f) => f.enabled);
        if (!nestedFields?.length) return fields;

        const {
          inflection,
          graphql: { getNullableType },
        } = build;
        const newFields: GraphQLInputFieldConfigMap = Object.create(null);
        for (const field of nestedFields.filter((f) => f.isForward)) {
          // Allow nulls on keys that have forward mutations available.
          for (const attributeName of field.localAttributes) {
            const keyFieldName = inflection.attribute({
              attributeName,
              codec: resource.codec,
            });
            const type = build.getGraphQLTypeByPgCodec(
              resource.codec.attributes[attributeName].codec,
              "input",
            ) as GraphQLInputType | undefined;
            if (!type) continue;
            newFields[keyFieldName] = {
              ...(fields[keyFieldName] as any),
              type: getNullableType(type) as GraphQLInputType,
            };
          }
          newFields[field.fieldName] = nestedFieldSpec(
            build,
            fieldWithHooks,
            field,
          );
        }
        for (const field of nestedFields.filter((f) => !f.isForward)) {
          newFields[field.fieldName] = nestedFieldSpec(
            build,
            fieldWithHooks,
            field,
          );
        }
        return Object.assign(Object.create(null), fields, newFields);
      },

      GraphQLObjectType_fields_field(field, build, context) {
        const { scope } = context;
        const {
          isPgCreateMutation,
          isPgUpdateMutation,
          pgFieldResource,
          fieldName,
          fieldBehaviorScope,
        } = scope as GraphileBuild.ScopeObjectFieldsField & {
          isPgCreateMutation?: boolean;
          isPgUpdateMutation?: boolean;
          pgFieldResource?: PgTableResource;
        };
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
              inflection.attribute({ attributeName, codec: pgFieldResource.codec }),
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

/** Registers every input type the plugin may reference (V4 parity). */
function registerTypes(build: GraphileBuild.Build, state: NestedMutationsState) {
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
                  ...(isNode ? { isNestedMutationConnectByNodeIdType: true } : null),
                }
              : {
                  isNestedMutationDeleteInputType: true,
                  ...(isNode ? { isNestedMutationDeleteByNodeIdType: true } : null),
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
          `PgNestedMutationsPlugin ${verb} type for ${resource.name}`,
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
        `PgNestedMutationsPlugin patch type for ${foreignResource.name} via ${constraint.name}`,
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
          `PgNestedMutationsPlugin update type for ${foreignResource.name} via ${constraint.name}`,
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
          `PgNestedMutationsPlugin create type for ${field.constraint.name}`,
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
                "nestedMutation:deleteOthers",
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
        `PgNestedMutationsPlugin connector type for ${field.constraint.name}`,
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
  return !!entity && !!build.behavior.pgCodecRelationMatches(entity, filter as any);
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

export type { NestedUpdaterField };
