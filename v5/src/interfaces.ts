// Load the global type augmentations of graphile-build / graphile-build-pg
import type {} from "postgraphile";
import type {} from "postgraphile/graphile-build";
import type {} from "postgraphile/graphile-build-pg";
import type {
  PgCodecRelation,
  PgCodecWithAttributes,
  PgResource,
  PgResourceUnique,
} from "postgraphile/@dataplan/pg";
import type { NodeIdHandler } from "postgraphile/grafast";

/** A table-like resource the plugin operates on. */
export type PgTableResource = PgResource<
  string,
  PgCodecWithAttributes,
  ReadonlyArray<PgResourceUnique>,
  undefined,
  any
>;

/**
 * Details stored on a relation during the gather phase. V5 relations don't
 * keep the constraint they came from; V4 used the constraint name in type
 * names and its introspection order for field order, so we keep both.
 */
export interface NestedRelationGatherInfo {
  /** pg_constraint.conname */
  constraintName: string;
  /** pg_constraint oid, used to pair the forward/backward relations */
  constraintId: string;
  /** V4 ordering: conrelid, conkey, confrelid, confkey, conname */
  sortKey: [number, number[], number, number[], string];
  /** Whether this is a self-referential constraint */
  isSelfReference: boolean;
  /**
   * The constraint carried a V4 `@omit update`. V4 ignored this for the
   * nested `updateBy*` fields, so the gather phase re-enables
   * `nestedMutation:update` for parity; we still need it for V4's
   * "is anything possible on this relation" check.
   */
  v4OmitUpdate: boolean;
}

export interface NestedUniqueGatherInfo {
  constraintName: string;
  sortKey: [number, number[], number, number[], string];
}

/** A unique constraint (incl. the primary key) as V4 saw it. */
export interface NestedUnique {
  name: string;
  tags: Record<string, any>;
  attributes: readonly string[];
  isPrimary: boolean;
  unique: PgResourceUnique;
  sortKey: NestedUniqueGatherInfo["sortKey"];
}

/**
 * A foreign key constraint as V4 saw it. `resource` is the referencing table
 * (V4's `constraint.class`), `foreignResource` the referenced one
 * (`constraint.foreignClass`).
 */
export interface NestedConstraint {
  id: string;
  name: string;
  tags: Record<string, any>;
  resource: PgTableResource;
  foreignResource: PgTableResource;
  /** Referencing attributes (V4: `keyAttributes`) */
  keyAttributes: readonly string[];
  /** Referenced attributes (V4: `foreignKeyAttributes`) */
  foreignKeyAttributes: readonly string[];
  /** Relation on `resource` pointing at `foreignResource` */
  forwardRelation: PgCodecRelation | null;
  forwardRelationName: string | null;
  /** Relation on `foreignResource` pointing back at `resource` */
  backwardRelation: PgCodecRelation | null;
  backwardRelationName: string | null;
  sortKey: NestedRelationGatherInfo["sortKey"];
  v4OmitUpdate: boolean;
}

/** A `connectBy*`/`deleteBy*` field (or the node ID variant). */
export interface NestedKeyField {
  fieldName: string;
  typeName: string;
  /** null for the node ID variant */
  unique: NestedUnique | null;
}

/** An `updateBy*` field (or the node ID variant). */
export interface NestedUpdaterField extends NestedKeyField {
  patchFieldName: string;
}

export interface NestedTable {
  resource: PgTableResource;
  codec: PgCodecWithAttributes;
  /** `inflection.tableFieldName(resource)` */
  tableFieldName: string;
  inputTypeName: string | null;
  patchTypeName: string | null;
  uniques: NestedUnique[];
  primaryKey: NestedUnique | null;
  nodeIdHandler: NodeIdHandler | null;
  connectorFields: NestedKeyField[];
  deleterFields: NestedKeyField[];
  /** keyed by constraint id */
  updaterFields: Map<string, NestedUpdaterField[]>;
  /** Attributes the nested logic may write on insert/update (V4 `omit`) */
  insertableAttributes: Set<string>;
  updatableAttributes: Set<string>;
}

/** One nested relation field on a table's input/patch type. */
export interface NestedRelationField {
  table: NestedTable;
  foreignTable: NestedTable;
  constraint: NestedConstraint;
  isForward: boolean;
  fieldName: string;
  connectorTypeName: string;
  createTypeName: string;
  /**
   * V4: a unique/primary constraint on `foreignTable` covers exactly the
   * constraint's key attribute numbers. For reverse relations this means the
   * relation holds a single row.
   */
  isUnique: boolean;
  creatable: boolean;
  deleteable: boolean;
  /**
   * Attributes on `table` set from the far side: for forward relations the
   * referencing attributes; for reverse relations, the referenced ones.
   */
  localAttributes: readonly string[];
  /** Matching attributes on `foreignTable` */
  foreignAttributes: readonly string[];
  /** Whether it was listed in `nestedMutationsList` (if set) */
  enabled: boolean;
  connectorFields: NestedKeyField[];
  deleterFields: NestedKeyField[];
  updaterFields: NestedUpdaterField[];
}

export interface NestedMutationsState {
  tables: Map<PgTableResource, NestedTable>;
  /** Nested fields per table, in V4 order */
  fieldsByTable: Map<PgTableResource, NestedRelationField[]>;
  /** Foreign key constraints by oid, in V4 order */
  constraints: Map<string, NestedConstraint>;
}

export interface NestedConnectorTypeDetails {
  constraint: NestedConstraint;
  table: PgTableResource;
  foreignTable: PgTableResource;
  isForward: boolean;
}

export interface NestedFieldNameDetails extends NestedConnectorTypeDetails {
  /**
   * V4 semantics: the referencing table has a unique constraint over exactly
   * the FK attributes (only meaningful for reverse relations).
   */
  isUnique: boolean;
  /**
   * V4 semantics: more than one (readable) FK on `foreignTable` references
   * `table`.
   */
  multipleFKs: boolean;
}

export interface NestedTableConstraintDetails {
  table: PgTableResource;
  constraint: NestedUnique;
}

export interface NestedUpdateDetails {
  table: PgTableResource;
  constraint: NestedConstraint;
}

export interface NestedUpdateByKeyDetails extends NestedUpdateDetails {
  keyConstraint: NestedUnique;
}

declare global {
  namespace GraphileBuild {
    interface SchemaOptions {
      /**
       * Use simple field names for nested mutations (`parent` rather than
       * `parentToParentId`) when only one relation exists between the
       * tables. Defaults to `false`.
       */
      nestedMutationsSimpleFieldNames?: boolean;
      /** Expose `deleteOthers` on reverse relations. Defaults to `true`. */
      nestedMutationsDeleteOthers?: boolean;
      /** Use plural names for one-to-one relations (backwards compat). */
      nestedMutationsOldUniqueFields?: boolean;
      /**
       * Allow list of nested fields, keyed by the table's input type name
       * (e.g. `ParentInput`). When set, only listed fields are added.
       */
      nestedMutationsList?: Record<string, ReadonlyArray<string>>;
    }

    interface Inflection {
      nestedTableFieldName(this: Inflection, resource: PgTableResource): string;
      nestedFieldName(
        this: Inflection,
        details: NestedFieldNameDetails,
      ): string;
      nestedConnectorType(
        this: Inflection,
        details: NestedConnectorTypeDetails,
      ): string;
      nestedCreateInputType(
        this: Inflection,
        details: NestedConnectorTypeDetails,
      ): string;
      nestedConnectByNodeIdField(this: Inflection): string;
      nestedConnectByKeyField(
        this: Inflection,
        details: NestedTableConstraintDetails,
      ): string;
      nestedConnectByNodeIdInputType(
        this: Inflection,
        details: { table: PgTableResource },
      ): string;
      nestedConnectByKeyInputType(
        this: Inflection,
        details: NestedTableConstraintDetails,
      ): string;
      nestedDeleteByNodeIdField(this: Inflection): string;
      nestedDeleteByKeyField(
        this: Inflection,
        details: NestedTableConstraintDetails,
      ): string;
      nestedDeleteByNodeIdInputType(
        this: Inflection,
        details: { table: PgTableResource },
      ): string;
      nestedDeleteByKeyInputType(
        this: Inflection,
        details: NestedTableConstraintDetails,
      ): string;
      nestedUpdateByNodeIdField(this: Inflection): string;
      nestedUpdateByKeyField(
        this: Inflection,
        details: NestedTableConstraintDetails,
      ): string;
      nestedUpdateByNodeIdInputType(
        this: Inflection,
        details: NestedUpdateDetails,
      ): string;
      nestedUpdatePatchType(
        this: Inflection,
        details: NestedUpdateDetails,
      ): string;
      nestedUpdateByKeyInputType(
        this: Inflection,
        details: NestedUpdateByKeyDetails,
      ): string;
    }

    interface BehaviorStrings {
      "nestedMutation:connect": true;
      "nestedMutation:insert": true;
      "nestedMutation:update": true;
      "nestedMutation:delete": true;
      "nestedMutation:deleteOthers": true;
    }

    interface Build {
      pgNestedMutations: NestedMutationsState;
    }

    interface ScopeInputObject {
      isNestedMutationInputType?: boolean;
      isNestedMutationConnectorType?: boolean;
      isNestedMutationCreateInputType?: boolean;
      isNestedMutationConnectInputType?: boolean;
      isNestedMutationConnectByNodeIdType?: boolean;
      isNestedMutationDeleteInputType?: boolean;
      isNestedMutationDeleteByNodeIdType?: boolean;
      isNestedMutationUpdateInputType?: boolean;
      isNestedMutationUpdateByNodeIdType?: boolean;
      isNestedMutationPatchType?: boolean;
      isNestedInverseMutation?: boolean;
      pgNestedTable?: PgTableResource;
      pgNestedForeignTable?: PgTableResource;
    }

    interface ScopeInputObjectFieldsField {
      isNestedMutationField?: boolean;
    }
  }

  namespace DataplanPg {
    interface PgCodecRelationExtensions {
      nestedMutations?: NestedRelationGatherInfo;
    }
    interface PgResourceUniqueExtensions {
      nestedMutations?: NestedUniqueGatherInfo;
    }
  }
}
