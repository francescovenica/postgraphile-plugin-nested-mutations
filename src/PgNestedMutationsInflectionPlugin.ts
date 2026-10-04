import { resolveOptions } from "./options.ts";
import { version } from "./version.ts";

/*
 * Ports of the V4 inflectors. Names and outputs are identical; the `details`
 * objects carry V5 entities (resources, and the plugin's own constraint /
 * unique descriptors) instead of V4 introspection objects.
 */

const constraintName = (c: { name: string; tags: Record<string, any> }) =>
  (typeof c.tags?.name === "string" && c.tags.name) || c.name;

const attributeNames = (
  inflection: GraphileBuild.Inflection,
  resource: { codec: any },
  attributes: readonly string[],
) =>
  attributes.map((attributeName) =>
    inflection.attribute({ attributeName, codec: resource.codec }),
  );

export const PgNestedMutationsInflectionPlugin: GraphileConfig.Plugin = {
  name: "PgNestedMutationsInflectionPlugin",
  description: "Inflectors for nested mutation fields and input types",
  version,
  inflection: {
    add: {
      /**
       * V4's `inflection.tableFieldName(table)`: camelCase of the singularized
       * table name. V5's `tableFieldName` goes through `tableType` first, which
       * differs for names like `a_b` (V4 `aB`, V5 `ab`); every nested-mutation
       * name and description is based on this inflector instead.
       */
      nestedTableFieldName(_options, resource): string {
        return this.camelCase(this._singularizedCodecName(resource.codec));
      },

      /**
       * V4: `build.pgNestedFieldName`. The name of the nested field added to the
       * table's input/patch type.
       */
      nestedFieldName(options, details): string {
        const {
          nestedMutationsSimpleFieldNames,
          nestedMutationsOldUniqueFields,
        } = resolveOptions(options.schema);
        const {
          constraint,
          foreignTable,
          isForward,
          isUnique,
          multipleFKs,
        } = details;
        const {
          fieldName,
          foreignFieldName,
          forwardMutationName,
          reverseMutationName,
        } = constraint.tags ?? {};
        const tableFieldName = this.nestedTableFieldName(foreignTable);
        const keyNames = attributeNames(
          this,
          constraint.resource,
          constraint.keyAttributes,
        );
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
          if (typeof forwardMutationName === "string")
            return forwardMutationName;
          if (typeof fieldName === "string") return fieldName;
          if (nestedMutationsSimpleFieldNames && !multipleFKs) {
            return this.camelCase(`${tableFieldName}`);
          }
          return this.camelCase(
            `${tableFieldName}_to_${keyNames.join("_and_")}`,
          );
        }

        if (typeof reverseMutationName === "string") return reverseMutationName;
        if (typeof foreignFieldName === "string") return foreignFieldName;
        if (!multipleFKs) {
          return nestedMutationsSimpleFieldNames
            ? computedReverseMutationName
            : this.camelCase(
                `${computedReverseMutationName}_using_${foreignKeyNames.join(
                  "_and_",
                )}`,
              );
        }
        return this.camelCase(
          `${computedReverseMutationName}_to_${keyNames.join(
            "_and_",
          )}_using_${foreignKeyNames.join("_and_")}`,
        );
      },

      nestedConnectorType(_options, details): string {
        const { constraint, isForward } = details;
        return this.upperCamelCase(
          `${constraintName(constraint)}_${isForward ? "" : "Inverse"}_input`,
        );
      },

      nestedCreateInputType(_options, details): string {
        const { constraint, foreignTable } = details;
        // V4 used the raw table name here (not the inflected one).
        const tableName =
          foreignTable.extensions?.pg?.name ?? foreignTable.codec.name;
        return this.upperCamelCase(
          `${constraintName(constraint)}_${tableName}_create_input`,
        );
      },

      nestedConnectByNodeIdField(_options): string {
        return this.camelCase(`connect_by_${this.nodeIdFieldName()}`);
      },

      nestedConnectByKeyField(_options, details): string {
        const { table, constraint } = details;
        return this.camelCase(
          `connect_by_${attributeNames(this, table, constraint.attributes).join(
            "_and_",
          )}`,
        );
      },

      nestedConnectByNodeIdInputType(_options, details): string {
        return this.upperCamelCase(
          `${this.nestedTableFieldName(details.table)}_node_id_connect`,
        );
      },

      nestedConnectByKeyInputType(_options, details): string {
        const { table, constraint } = details;
        return this.upperCamelCase(
          `${this.nestedTableFieldName(table)}_${constraintName(
            constraint,
          )}_connect`,
        );
      },

      nestedDeleteByNodeIdField(_options): string {
        return this.camelCase(`delete_by_${this.nodeIdFieldName()}`);
      },

      nestedDeleteByKeyField(_options, details): string {
        const { table, constraint } = details;
        return this.camelCase(
          `delete_by_${attributeNames(this, table, constraint.attributes).join(
            "_and_",
          )}`,
        );
      },

      nestedDeleteByNodeIdInputType(_options, details): string {
        return this.upperCamelCase(
          `${this.nestedTableFieldName(details.table)}_node_id_delete`,
        );
      },

      nestedDeleteByKeyInputType(_options, details): string {
        const { table, constraint } = details;
        return this.upperCamelCase(
          `${this.nestedTableFieldName(table)}_${constraintName(
            constraint,
          )}_delete`,
        );
      },

      nestedUpdateByNodeIdField(_options): string {
        return this.camelCase(`update_by_${this.nodeIdFieldName()}`);
      },

      nestedUpdateByKeyField(_options, details): string {
        const { table, constraint } = details;
        return this.camelCase(
          `update_by_${attributeNames(this, table, constraint.attributes).join(
            "_and_",
          )}`,
        );
      },

      nestedUpdateByNodeIdInputType(_options, details): string {
        const { table, constraint } = details;
        const tableFieldName = this.nestedTableFieldName(table);
        const parentTableFieldName = this.nestedTableFieldName(
          constraint.resource,
        );
        return this.upperCamelCase(
          `${tableFieldName}_on_${parentTableFieldName}_for_${constraintName(
            constraint,
          )}_node_id_update`,
        );
      },

      nestedUpdatePatchType(_options, details): string {
        const { table, constraint } = details;
        const tableFieldName = this.nestedTableFieldName(table);
        const parentTableFieldName = this.nestedTableFieldName(
          constraint.resource,
        );
        // NOTE: camelCase (not upperCamelCase), as in V4.
        return this.camelCase(
          `update_${tableFieldName}_on_${parentTableFieldName}_for_${constraintName(
            constraint,
          )}_patch`,
        );
      },

      nestedUpdateByKeyInputType(_options, details): string {
        const { table, constraint, keyConstraint } = details;
        const tableFieldName = this.nestedTableFieldName(table);
        const parentTableFieldName = this.nestedTableFieldName(
          constraint.resource,
        );
        return this.upperCamelCase(
          `${tableFieldName}_on_${parentTableFieldName}_for_${constraintName(
            constraint,
          )}_using_${constraintName(keyConstraint)}_update`,
        );
      },
    },
  },
};
