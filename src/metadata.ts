import type { PgCodecRelation } from "postgraphile/@dataplan/pg";

import type {
  NestedConstraint,
  NestedKeyField,
  NestedMutationsState,
  NestedRelationField,
  NestedTable,
  NestedUnique,
  NestedUpdaterField,
  PgTableResource,
} from "./interfaces.ts";
import { nestedBehavior } from "./PgNestedMutationsBehaviorPlugin.ts";
import { resolveOptions } from "./options.ts";

type SortKey = NestedUnique["sortKey"];

/** Postgres ordering of int2[] values */
function compareIntArrays(a: number[], b: number[]): number {
  const l = Math.min(a.length, b.length);
  for (let i = 0; i < l; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** V4: `order by conrelid, conkey, confrelid, confkey, conname` */
export function compareSortKeys(a: SortKey, b: SortKey): number {
  return (
    a[0] - b[0] ||
    compareIntArrays(a[1], b[1]) ||
    a[2] - b[2] ||
    compareIntArrays(a[3], b[3]) ||
    (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0)
  );
}

/** V4: `select distinct on (conrelid, conkey, confrelid, confkey)` */
function distinctKey(k: SortKey) {
  return JSON.stringify([k[0], k[1], k[2], k[3]]);
}

function isTableResource(build: GraphileBuild.Build, resource: any) {
  if (resource.parameters) return false;
  if (!resource.codec.attributes) return false;
  if (resource.codec.isAnonymous) return false;
  if (resource.codec.polymorphism) return false;
  if (resource.isVirtual) return false;
  return build.pgTableResource(resource.codec) === resource;
}

/**
 * V4's `omit(entity)` (no permission) only matched a bare `@omit`. The V4
 * preset turns that into a set of negative behaviors; we treat an entity as
 * "bare omitted" when none of the relevant behaviors survive.
 */
function uniqueIsBareOmitted(
  build: GraphileBuild.Build,
  resource: PgTableResource,
  unique: NestedUnique["unique"],
) {
  const m = (filter: string) =>
    build.behavior.pgResourceUniqueMatches([resource, unique], filter as any);
  return (
    !m("query:resource:single") &&
    !m("constraint:resource:update") &&
    !m("constraint:resource:delete")
  );
}

function attributeIsBareOmitted(
  build: GraphileBuild.Build,
  resource: PgTableResource,
  attributeName: string,
) {
  const m = (filter: string) =>
    build.behavior.pgCodecAttributeMatches(
      [resource.codec, attributeName],
      filter as any,
    );
  return (
    !m("attribute:select") && !m("attribute:insert") && !m("attribute:update")
  );
}

function attributeMatches(
  build: GraphileBuild.Build,
  resource: PgTableResource,
  attributeName: string,
  filter: string,
) {
  return !!build.behavior.pgCodecAttributeMatches(
    [resource.codec, attributeName],
    filter as any,
  );
}

function relationMatches(
  build: GraphileBuild.Build,
  relation: PgCodecRelation | null,
  filter: string,
) {
  if (!relation) return false;
  return !!build.behavior.pgCodecRelationMatches(relation, filter as any);
}

function resourceMatches(
  build: GraphileBuild.Build,
  resource: PgTableResource,
  filter: string,
) {
  return !!build.behavior.pgResourceMatches(resource, filter as any);
}

export function buildNestedState(
  build: GraphileBuild.Build,
): NestedMutationsState {
  const { inflection } = build;
  const options = resolveOptions(build.options);

  const resources = Object.values(build.pgResources).filter((r) =>
    isTableResource(build, r),
  ) as PgTableResource[];
  const resourceByCodec = new Map(resources.map((r) => [r.codec, r]));

  // ---------------------------------------------------------------------------
  // Tables and their unique constraints
  // ---------------------------------------------------------------------------
  const tables = new Map<PgTableResource, NestedTable>();
  for (const resource of resources) {
    const codec = resource.codec;
    const seen = new Set<string>();
    const uniques: NestedUnique[] = [];
    for (const unique of resource.uniques ?? []) {
      const info = unique.extensions?.nestedMutations;
      if (!info) continue;
      const nestedUnique: NestedUnique = {
        name: info.constraintName,
        tags: (unique.extensions?.tags as any) ?? {},
        attributes: unique.attributes as string[],
        isPrimary: !!unique.isPrimary,
        unique,
        sortKey: info.sortKey,
      };
      uniques.push(nestedUnique);
    }
    uniques.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
    // Apply V4's `distinct on` (keeps the first by conname)
    const deduped: NestedUnique[] = [];
    for (const u of uniques) {
      const k = distinctKey(u.sortKey);
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(u);
    }

    const tableTypeName = inflection.tableType(codec);
    const nodeIdHandler =
      typeof build.getNodeIdHandler === "function"
        ? build.getNodeIdHandler(tableTypeName) ?? null
        : null;
    const primaryKey = deduped.find((u) => u.isPrimary) ?? null;

    const insertableAttributes = new Set<string>();
    const updatableAttributes = new Set<string>();
    for (const attributeName of Object.keys(codec.attributes)) {
      if (
        attributeMatches(build, resource, attributeName, "attribute:insert")
      ) {
        insertableAttributes.add(attributeName);
      }
      if (
        attributeMatches(build, resource, attributeName, "attribute:update")
      ) {
        updatableAttributes.add(attributeName);
      }
    }

    tables.set(resource, {
      resource,
      codec,
      tableFieldName: inflection.nestedTableFieldName(resource),
      inputTypeName: build.getGraphQLTypeNameByPgCodec(codec, "input") ?? null,
      patchTypeName: build.getGraphQLTypeNameByPgCodec(codec, "patch") ?? null,
      uniques: deduped,
      primaryKey,
      nodeIdHandler,
      connectorFields: [],
      deleterFields: [],
      updaterFields: new Map(),
      insertableAttributes,
      updatableAttributes,
      nullableKeyFieldNames: new Map(),
    });
  }

  // ---------------------------------------------------------------------------
  // Foreign key constraints (paired forward/backward relations)
  // ---------------------------------------------------------------------------
  const constraintsById = new Map<string, NestedConstraint>();
  for (const resource of resources) {
    const relations = resource.getRelations() as Record<
      string,
      PgCodecRelation
    >;
    for (const [relationName, relation] of Object.entries(relations)) {
      const info = relation.extensions?.nestedMutations;
      if (!info) continue;
      const remote = relation.remoteResource as PgTableResource;
      if (!tables.has(remote)) continue;
      let c = constraintsById.get(info.constraintId);
      if (!c) {
        const referencing = relation.isReferencee ? remote : resource;
        const referenced = relation.isReferencee ? resource : remote;
        c = {
          id: info.constraintId,
          name: info.constraintName,
          tags: (relation.extensions?.tags as any) ?? {},
          resource: referencing,
          foreignResource: referenced,
          keyAttributes: relation.isReferencee
            ? relation.remoteAttributes
            : relation.localAttributes,
          foreignKeyAttributes: relation.isReferencee
            ? relation.localAttributes
            : relation.remoteAttributes,
          forwardRelation: null,
          forwardRelationName: null,
          backwardRelation: null,
          backwardRelationName: null,
          sortKey: info.sortKey,
        };
        constraintsById.set(info.constraintId, c);
      }
      if (relation.isReferencee) {
        c.backwardRelation = relation;
        c.backwardRelationName = relationName;
      } else {
        c.forwardRelation = relation;
        c.forwardRelationName = relationName;
      }
    }
  }
  const allConstraints = [...constraintsById.values()].sort((a, b) =>
    compareSortKeys(a.sortKey, b.sortKey),
  );
  {
    // V4's `distinct on`
    const seen = new Set<string>();
    for (let i = 0; i < allConstraints.length; i++) {
      const k = distinctKey(allConstraints[i].sortKey);
      if (seen.has(k)) {
        allConstraints.splice(i--, 1);
      } else {
        seen.add(k);
      }
    }
  }
  /** The relation entity that carries the constraint's behaviors */
  const anyRelation = (c: NestedConstraint) =>
    c.forwardRelation ?? c.backwardRelation;
  /** V4: `!omit(constraint, 'read')` */
  const constraintReadable = (c: NestedConstraint) =>
    relationMatches(build, anyRelation(c), "resource:select");

  // ---------------------------------------------------------------------------
  // Per-table connect/delete/update field descriptors (V4 root mutation hooks)
  // ---------------------------------------------------------------------------
  const nodeIdFieldName = inflection.nodeIdFieldName?.() ?? null;
  for (const table of tables.values()) {
    const { resource } = table;
    const keyUniques = table.uniques
      .filter((u) => !uniqueIsBareOmitted(build, resource, u.unique))
      .filter(
        (u) =>
          !u.attributes.some(
            (a) => !attributeMatches(build, resource, a, "attribute:select"),
          ),
      );
    for (const unique of keyUniques) {
      table.connectorFields.push({
        unique,
        fieldName: inflection.nestedConnectByKeyField({
          table: resource,
          constraint: unique,
        }),
        typeName: inflection.nestedConnectByKeyInputType({
          table: resource,
          constraint: unique,
        }),
      });
      table.deleterFields.push({
        unique,
        fieldName: inflection.nestedDeleteByKeyField({
          table: resource,
          constraint: unique,
        }),
        typeName: inflection.nestedDeleteByKeyInputType({
          table: resource,
          constraint: unique,
        }),
      });
    }
    if (nodeIdFieldName && table.primaryKey && table.nodeIdHandler) {
      table.connectorFields.push({
        unique: null,
        fieldName: inflection.nestedConnectByNodeIdField(),
        typeName: inflection.nestedConnectByNodeIdInputType({
          table: resource,
        }),
      });
      table.deleterFields.push({
        unique: null,
        fieldName: inflection.nestedDeleteByNodeIdField(),
        typeName: inflection.nestedDeleteByNodeIdInputType({ table: resource }),
      });
    }
  }

  for (const table of tables.values()) {
    const { resource } = table;
    for (const constraint of allConstraints) {
      if (
        constraint.resource !== resource &&
        constraint.foreignResource !== resource
      ) {
        continue;
      }
      if (!constraintReadable(constraint)) continue;
      if (
        constraint.keyAttributes.some(
          (a) =>
            !attributeMatches(
              build,
              constraint.resource,
              a,
              "attribute:select",
            ),
        )
      ) {
        continue;
      }
      const foreignResource =
        constraint.resource === resource
          ? constraint.foreignResource
          : constraint.resource;
      const foreignTable = tables.get(foreignResource)!;
      if (!foreignTable.patchTypeName) continue;
      const relation =
        constraint.resource === resource
          ? constraint.forwardRelation
          : constraint.backwardRelation;
      if (
        !relationMatches(
          build,
          relation ?? anyRelation(constraint),
          nestedBehavior.update,
        )
      ) {
        continue;
      }
      const patchFieldName = inflection.patchField(
        inflection.nestedTableFieldName(foreignResource),
      );
      const fields: NestedUpdaterField[] = [];
      const keyUniques = foreignTable.uniques
        .filter((u) => !uniqueIsBareOmitted(build, foreignResource, u.unique))
        .filter(
          (u) =>
            !u.attributes.some(
              (a) =>
                !attributeMatches(
                  build,
                  foreignResource,
                  a,
                  "attribute:select",
                ),
            ),
        );
      for (const keyConstraint of keyUniques) {
        fields.push({
          unique: keyConstraint,
          patchFieldName,
          fieldName: inflection.nestedUpdateByKeyField({
            table: foreignResource,
            constraint: keyConstraint,
          }),
          typeName: inflection.nestedUpdateByKeyInputType({
            table: foreignResource,
            constraint,
            keyConstraint,
          }),
        });
      }
      if (
        nodeIdFieldName &&
        foreignTable.primaryKey &&
        foreignTable.nodeIdHandler
      ) {
        fields.push({
          unique: null,
          patchFieldName,
          fieldName: inflection.nestedUpdateByNodeIdField(),
          typeName: inflection.nestedUpdateByNodeIdInputType({
            table: resource,
            constraint,
          }),
        });
      }
      table.updaterFields.set(constraint.id, fields);
    }
  }

  // ---------------------------------------------------------------------------
  // Nested relation fields per table (V4 NestedTypesPlugin)
  // ---------------------------------------------------------------------------
  const fieldsByTable = new Map<PgTableResource, NestedRelationField[]>();
  for (const table of tables.values()) {
    const { resource } = table;
    if (!table.inputTypeName) continue;
    const related = allConstraints
      .filter((c) => c.resource === resource || c.foreignResource === resource)
      .filter(constraintReadable);
    if (!related.length) continue;
    const fields: NestedRelationField[] = [];
    fieldsByTable.set(resource, fields);
    const whitelist = options.nestedMutationsList;
    const tableTypeName = table.inputTypeName;
    if (whitelist && !whitelist[tableTypeName]) continue;

    for (const constraint of related) {
      // V4: self-referential constraints only produce the forward field
      const isForward = constraint.resource === resource;
      const foreignResource = isForward
        ? constraint.foreignResource
        : constraint.resource;
      const foreignTable = tables.get(foreignResource)!;
      const relation = isForward
        ? constraint.forwardRelation
        : constraint.backwardRelation;
      const behaviorEntity = relation ?? anyRelation(constraint);

      const canConnect = relationMatches(
        build,
        behaviorEntity,
        nestedBehavior.connect,
      );
      const connectable =
        canConnect &&
        foreignTable.uniques.some(
          (u) =>
            !u.attributes.some((a) =>
              attributeIsBareOmitted(build, foreignResource, a),
            ),
        );
      const creatable =
        resourceMatches(build, foreignResource, "resource:insert") &&
        relationMatches(build, behaviorEntity, nestedBehavior.insert) &&
        !constraint.keyAttributes.some(
          (a) =>
            !attributeMatches(
              build,
              constraint.resource,
              a,
              "attribute:insert",
            ),
        );
      // V4: `!omit(foreignTable, 'update') && !omit(constraint, 'update')`;
      // only used to decide whether the relation is exposed at all.
      const updateable =
        resourceMatches(build, foreignResource, "resource:update") &&
        relationMatches(build, behaviorEntity, nestedBehavior.update);
      const deleteable =
        options.nestedMutationsDeleteOthers &&
        !!foreignTable.primaryKey &&
        resourceMatches(build, foreignResource, "resource:delete") &&
        relationMatches(build, behaviorEntity, nestedBehavior.delete);

      if (
        (!connectable && !creatable && !deleteable && !updateable) ||
        !resourceMatches(build, foreignResource, "resource:select")
      ) {
        continue;
      }

      const isUnique = hasUniqueOver(foreignTable, constraint);
      // V4 counted FKs on the foreign table pointing at this table.
      const multipleFKs =
        allConstraints
          .filter((c) => c.resource === foreignResource)
          .filter((c) => c.foreignResource === resource)
          .filter(constraintReadable).length > 1;

      const details = {
        constraint,
        table: resource,
        foreignTable: foreignResource,
        isForward,
      };
      const fieldName = inflection.nestedFieldName({
        ...details,
        isUnique,
        multipleFKs,
      });
      const enabled =
        !whitelist || !!whitelist[tableTypeName]?.includes(fieldName);

      fields.push({
        table,
        foreignTable,
        constraint,
        isForward,
        fieldName,
        connectorTypeName: inflection.nestedConnectorType(details),
        createTypeName: inflection.nestedCreateInputType(details),
        isUnique,
        creatable,
        deleteable,
        localAttributes: isForward
          ? constraint.keyAttributes
          : constraint.foreignKeyAttributes,
        foreignAttributes: isForward
          ? constraint.foreignKeyAttributes
          : constraint.keyAttributes,
        enabled,
        connectorFields: canConnect ? foreignTable.connectorFields : [],
        deleterFields: deleteable ? foreignTable.deleterFields : [],
        updaterFields: table.updaterFields.get(constraint.id) ?? [],
      });
      if (enabled && isForward) {
        for (const attributeName of constraint.keyAttributes) {
          table.nullableKeyFieldNames.set(
            inflection.attribute({ attributeName, codec: table.codec }),
            attributeName,
          );
        }
      }
    }
  }

  return {
    tables,
    fieldsByTable,
    constraints: new Map(allConstraints.map((c) => [c.id, c])),
  };
}

/**
 * V4's uniqueness check compares the constraint's key attribute *numbers*
 * with the foreign table's unique constraints; for forward relations that
 * compares numbers across two different tables. Only used for naming.
 */
function hasUniqueOver(
  foreignTable: NestedTable,
  constraint: NestedConstraint,
) {
  const keyNums = constraint.sortKey[1];
  return foreignTable.uniques.some(
    (u) =>
      u.sortKey[1].length === keyNums.length &&
      u.sortKey[1].every((n, i) => keyNums[i] === n),
  );
}

export type { NestedKeyField };
