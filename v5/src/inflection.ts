import type {
  NestedConnectorTypeDetails,
  NestedFieldNameDetails,
  NestedTableConstraintDetails,
  NestedUpdateByKeyDetails,
  NestedUpdateDetails,
} from "./interfaces.ts";
import { resolveOptions } from "./options.ts";

/*
 * Ports of the V4 inflectors. Names and outputs are identical; the `details`
 * objects carry V5 entities (resources, and the plugin's own constraint /
 * unique descriptors) instead of V4 introspection objects.
 */

const constraintName = (c: { name: string; tags: Record<string, any> }) =>
  (typeof c.tags?.name === "string" && c.tags.name) || c.name;

const attributeNames = (
  inflection: GraphileBuild.Inflection,
  resource: NestedTableConstraintDetails["table"],
  attributes: readonly string[],
) =>
  attributes.map((attributeName) =>
    inflection.attribute({ attributeName, codec: resource.codec }),
  );

export const inflectors = {
  /**
   * V4's `inflection.tableFieldName(table)`: camelCase of the singularized
   * table name. V5's `tableFieldName` goes through `tableType` first, which
   * differs for names like `a_b` (V4 `aB`, V5 `ab`); every nested-mutation
   * name and description is based on this inflector instead.
   */
  nestedTableFieldName(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    resource: NestedTableConstraintDetails["table"],
  ): string {
    return this.camelCase(this._singularizedCodecName(resource.codec));
  },

  /**
   * V4: `build.pgNestedFieldName`. The name of the nested field added to the
   * table's input/patch type.
   */
  nestedFieldName(
    this: GraphileBuild.Inflection,
    options: GraphileConfig.ResolvedPreset,
    details: NestedFieldNameDetails,
  ): string {
    const { nestedMutationsSimpleFieldNames, nestedMutationsOldUniqueFields } =
      resolveOptions(options.schema);
    const { constraint, foreignTable, isForward, isUnique, multipleFKs } =
      details;
    const { fieldName, foreignFieldName, forwardMutationName, reverseMutationName } =
      constraint.tags ?? {};
    const tableFieldName = this.nestedTableFieldName(foreignTable);
    const keyNames = attributeNames(this, constraint.resource, constraint.keyAttributes);
    const foreignKeyNames = attributeNames(
      this,
      constraint.foreignResource,
      constraint.foreignKeyAttributes,
    );

    const computedReverseMutationName = this.camelCase(
      `${
        isUnique
          ? nestedMutationsOldUniqueFields
            ? this.pluralize(tableFieldName)
            : tableFieldName
          : this.pluralize(tableFieldName)
      }`,
    );

    if (isForward) {
      if (typeof forwardMutationName === "string") return forwardMutationName;
      if (typeof fieldName === "string") return fieldName;
      if (nestedMutationsSimpleFieldNames && !multipleFKs) {
        return this.camelCase(`${tableFieldName}`);
      }
      return this.camelCase(`${tableFieldName}_to_${keyNames.join("_and_")}`);
    }

    if (typeof reverseMutationName === "string") return reverseMutationName;
    if (typeof foreignFieldName === "string") return foreignFieldName;
    if (!multipleFKs) {
      return nestedMutationsSimpleFieldNames
        ? computedReverseMutationName
        : this.camelCase(
            `${computedReverseMutationName}_using_${foreignKeyNames.join("_and_")}`,
          );
    }
    return this.camelCase(
      `${computedReverseMutationName}_to_${keyNames.join(
        "_and_",
      )}_using_${foreignKeyNames.join("_and_")}`,
    );
  },

  nestedConnectorType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedConnectorTypeDetails,
  ): string {
    const { constraint, isForward } = details;
    return this.upperCamelCase(
      `${constraintName(constraint)}_${isForward ? "" : "Inverse"}_input`,
    );
  },

  nestedCreateInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedConnectorTypeDetails,
  ): string {
    const { constraint, foreignTable } = details;
    // V4 used the raw table name here (not the inflected one).
    const tableName =
      foreignTable.extensions?.pg?.name ?? foreignTable.codec.name;
    return this.upperCamelCase(
      `${constraintName(constraint)}_${tableName}_create_input`,
    );
  },

  nestedConnectByNodeIdField(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
  ): string {
    return this.camelCase(`connect_by_${this.nodeIdFieldName()}`);
  },

  nestedConnectByKeyField(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedTableConstraintDetails,
  ): string {
    const { table, constraint } = details;
    return this.camelCase(
      `connect_by_${attributeNames(this, table, constraint.attributes).join("_and_")}`,
    );
  },

  nestedConnectByNodeIdInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: { table: NestedTableConstraintDetails["table"] },
  ): string {
    return this.upperCamelCase(
      `${this.nestedTableFieldName(details.table)}_node_id_connect`,
    );
  },

  nestedConnectByKeyInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedTableConstraintDetails,
  ): string {
    const { table, constraint } = details;
    return this.upperCamelCase(
      `${this.nestedTableFieldName(table)}_${constraintName(constraint)}_connect`,
    );
  },

  nestedDeleteByNodeIdField(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
  ): string {
    return this.camelCase(`delete_by_${this.nodeIdFieldName()}`);
  },

  nestedDeleteByKeyField(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedTableConstraintDetails,
  ): string {
    const { table, constraint } = details;
    return this.camelCase(
      `delete_by_${attributeNames(this, table, constraint.attributes).join("_and_")}`,
    );
  },

  nestedDeleteByNodeIdInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: { table: NestedTableConstraintDetails["table"] },
  ): string {
    return this.upperCamelCase(
      `${this.nestedTableFieldName(details.table)}_node_id_delete`,
    );
  },

  nestedDeleteByKeyInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedTableConstraintDetails,
  ): string {
    const { table, constraint } = details;
    return this.upperCamelCase(
      `${this.nestedTableFieldName(table)}_${constraintName(constraint)}_delete`,
    );
  },

  nestedUpdateByNodeIdField(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
  ): string {
    return this.camelCase(`update_by_${this.nodeIdFieldName()}`);
  },

  nestedUpdateByKeyField(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedTableConstraintDetails,
  ): string {
    const { table, constraint } = details;
    return this.camelCase(
      `update_by_${attributeNames(this, table, constraint.attributes).join("_and_")}`,
    );
  },

  nestedUpdateByNodeIdInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedUpdateDetails,
  ): string {
    const { table, constraint } = details;
    const tableFieldName = this.nestedTableFieldName(table);
    const parentTableFieldName = this.nestedTableFieldName(constraint.resource);
    return this.upperCamelCase(
      `${tableFieldName}_on_${parentTableFieldName}_for_${constraintName(constraint)}_node_id_update`,
    );
  },

  nestedUpdatePatchType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedUpdateDetails,
  ): string {
    const { table, constraint } = details;
    const tableFieldName = this.nestedTableFieldName(table);
    const parentTableFieldName = this.nestedTableFieldName(constraint.resource);
    // NOTE: camelCase (not upperCamelCase), as in V4.
    return this.camelCase(
      `update_${tableFieldName}_on_${parentTableFieldName}_for_${constraintName(constraint)}_patch`,
    );
  },

  nestedUpdateByKeyInputType(
    this: GraphileBuild.Inflection,
    _options: GraphileConfig.ResolvedPreset,
    details: NestedUpdateByKeyDetails,
  ): string {
    const { table, constraint, keyConstraint } = details;
    const tableFieldName = this.nestedTableFieldName(table);
    const parentTableFieldName = this.nestedTableFieldName(constraint.resource);
    return this.upperCamelCase(
      `${tableFieldName}_on_${parentTableFieldName}_for_${constraintName(
        constraint,
      )}_using_${constraintName(keyConstraint)}_update`,
    );
  },
};
