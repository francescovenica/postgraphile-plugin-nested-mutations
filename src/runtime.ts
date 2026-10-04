/*
 * Runtime side of the plugin.
 *
 * At execution time Grafast walks the mutation's `input` argument and calls
 * each input field's `apply` callback. Core attribute fields call
 * `target.set(attributeName, value)`; the nested fields below record what was
 * asked for into a small tree of plain objects (`NestedRow` and friends).
 * `PgNestedInsertStep`/`PgNestedUpdateStep` then run that tree against
 * Postgres inside a single transaction on a single client, obtained through
 * the executor context's `withPgClient(pgSettings, ...)` exactly like the core
 * mutation steps do.
 */
import type {
  PgClient,
  PgCodec,
  PgExecutorContext,
  PgResourceUnique,
} from "postgraphile/@dataplan/pg";
import {
  PgInsertSingleStep,
  PgUpdateSingleStep,
  sqlValueWithCodec,
} from "postgraphile/@dataplan/pg";
import type { ExecutionDetails, Step } from "postgraphile/grafast";
import { bakedInputRuntime } from "postgraphile/grafast";
import { sql, type SQL } from "postgraphile/pg-sql2";

import type {
  NestedKeyField,
  NestedMutationsState,
  NestedRelationField,
  NestedTable,
  NestedUpdaterField,
  PgTableResource,
} from "./interfaces.ts";

// -----------------------------------------------------------------------------
// Input tree
// -----------------------------------------------------------------------------

/** A value read back from Postgres as text; written back with a cast. */
class PgText {
  readonly text: string | null;
  constructor(text: string | null) {
    this.text = text;
  }
}

/** One row to insert or update, plus its nested relation operations. */
export class NestedRow {
  readonly meta: Record<string, unknown> = Object.create(null);
  /** attribute name -> value (JS value as produced by input baking, or PgText) */
  readonly values = new Map<string, unknown>();
  readonly relations: NestedRelationInput[] = [];
  readonly table: NestedTable;
  readonly mode: "insert" | "update";

  constructor(table: NestedTable, mode: "insert" | "update") {
    this.table = table;
    this.mode = mode;
  }

  // The subset of the core mutation query builder API that core `apply`
  // callbacks use.
  set(attributeName: string, value: unknown) {
    this.values.set(attributeName, value);
  }
  setBuilder() {
    return this;
  }
  setMeta(key: string, value: unknown) {
    this.meta[key] = value;
  }
  getMetaRaw(key: string) {
    return this.meta[key];
  }

  addRelation(field: NestedRelationField, keyCount: number) {
    const relation = new NestedRelationInput(field, keyCount);
    this.relations.push(relation);
    return relation;
  }
}

/** Identifies a single row, by unique key or node ID. */
export class NestedKeyLookup {
  readonly values = new Map<string, unknown>();
  nodeId: unknown = undefined;
  readonly table: NestedTable;
  readonly keyField: NestedKeyField;
  constructor(table: NestedTable, keyField: NestedKeyField) {
    this.table = table;
    this.keyField = keyField;
  }
  set(attributeName: string, value: unknown) {
    this.values.set(attributeName, value);
  }
}

export class NestedUpdateLookup extends NestedKeyLookup {
  readonly patch: NestedRow;
  constructor(table: NestedTable, keyField: NestedUpdaterField) {
    super(table, keyField);
    this.patch = new NestedRow(table, "update");
  }
}

/** The operations requested for one nested relation field of a row. */
export class NestedRelationInput {
  readonly connects: NestedKeyLookup[] = [];
  readonly deletes: NestedKeyLookup[] = [];
  readonly updates: NestedUpdateLookup[] = [];
  readonly creates: NestedRow[] = [];
  deleteOthers = false;
  readonly field: NestedRelationField;
  /** Number of keys present on the input object (V4 1:1 check) */
  readonly keyCount: number;
  constructor(field: NestedRelationField, keyCount: number) {
    this.field = field;
    this.keyCount = keyCount;
  }
}

// -----------------------------------------------------------------------------
// `apply` callbacks for the plugin's input fields
// -----------------------------------------------------------------------------

/** Nested relation field on a table input/patch type. */
export function makeApplyNestedField(field: NestedRelationField) {
  return function applyNestedField(target: unknown, value: unknown) {
    // Only act on our own row builders; e.g. if the table input type is used
    // as a function argument it is "baked" into a plain object instead.
    if (!(target instanceof NestedRow) || value == null) return;
    return target.addRelation(field, Object.keys(value as object).length);
  };
}

export function applyDeleteOthers(target: unknown, value: unknown) {
  if (target instanceof NestedRelationInput && value) {
    target.deleteOthers = true;
  }
}

type LookupKind = "connect" | "delete" | "update";

export function makeApplyLookupField(
  kind: LookupKind,
  keyField: NestedKeyField,
  isList: boolean,
) {
  return function applyLookupField(target: unknown, value: unknown) {
    if (!(target instanceof NestedRelationInput) || value == null) return;
    const foreignTable = target.field.foreignTable;
    const make = () => {
      if (kind === "update") {
        const lookup = new NestedUpdateLookup(
          foreignTable,
          keyField as NestedUpdaterField,
        );
        target.updates.push(lookup);
        return lookup;
      }
      const lookup = new NestedKeyLookup(foreignTable, keyField);
      (kind === "connect" ? target.connects : target.deletes).push(lookup);
      return lookup;
    };
    // For list types Grafast calls a function target once per item.
    return isList ? make : make();
  };
}

export function makeApplyCreateField(isList: boolean) {
  return function applyCreateField(target: unknown, value: unknown) {
    if (!(target instanceof NestedRelationInput) || value == null) return;
    const make = () => {
      const row = new NestedRow(target.field.foreignTable, "insert");
      target.creates.push(row);
      return row;
    };
    return isList ? make : make();
  };
}

export function makeApplyKeyAttribute(attributeName: string) {
  return function applyKeyAttribute(
    target: unknown,
    value: unknown,
    info: { schema: any; field: any },
  ) {
    if (!(target instanceof NestedKeyLookup)) return;
    target.set(
      attributeName,
      bakedInputRuntime(info.schema, info.field.type, value),
    );
  };
}

export function applyNodeId(target: unknown, value: unknown) {
  if (target instanceof NestedKeyLookup) {
    target.nodeId = value;
  }
}

export function applyUpdatePatch(target: unknown, value: unknown) {
  if (!(target instanceof NestedUpdateLookup) || value == null) return;
  return target.patch;
}

// -----------------------------------------------------------------------------
// SQL execution
// -----------------------------------------------------------------------------

type TextRow = Record<string, string | null>;

function attributeCodec(table: NestedTable, attributeName: string): PgCodec {
  return table.codec.attributes[attributeName].codec;
}

function sqlAttributeValue(
  table: NestedTable,
  attributeName: string,
  value: unknown,
): SQL {
  const codec = attributeCodec(table, attributeName);
  if (value instanceof PgText) {
    return sql`${sql.value(value.text)}::${codec.sqlType}`;
  }
  return sqlValueWithCodec(value, codec);
}

function tableSql(table: NestedTable): SQL {
  const from = table.resource.from;
  if (typeof from === "function" || !sql.isSQL(from)) {
    throw new Error(
      `Nested mutations are only supported on tables (${table.resource.name})`,
    );
  }
  return from as SQL;
}

/** V4: `(a = $1) and (b = $2)` */
function andEquals(table: NestedTable, entries: Array<[string, unknown]>): SQL {
  return sql.parens(
    sql.join(
      entries.map(
        ([attributeName, value]) =>
          sql`(${sql.identifier(attributeName)} = ${sqlAttributeValue(
            table,
            attributeName,
            value,
          )})`,
      ),
      " and ",
    ),
  );
}

/** Decodes a node ID for `table`, throwing V4's errors. */
export function nodeIdToEntries(
  table: NestedTable,
  nodeId: unknown,
): Array<[string, unknown]> {
  const handler = table.nodeIdHandler;
  const pk = table.primaryKey;
  if (!handler || !pk) {
    throw new Error("Invalid ID");
  }
  const decoded = handler.codec.decode(nodeId as string);
  if (!handler.match(decoded)) {
    throw new Error("Mismatched type");
  }
  const identifiers = handler.getIdentifiers(decoded);
  if (identifiers.length !== pk.attributes.length) {
    throw new Error("Invalid ID");
  }
  return pk.attributes.map((a, i) => [a, identifiers[i]]);
}

function lookupWhere(lookup: NestedKeyLookup): SQL {
  const { table, keyField } = lookup;
  if (keyField.unique === null) {
    return andEquals(table, nodeIdToEntries(table, lookup.nodeId));
  }
  return andEquals(
    table,
    keyField.unique.attributes.map((a) => [a, lookup.values.get(a)]),
  );
}

export class NestedMutationEngine {
  /** Attributes we always read back for a table (as text) */
  private returnAttributesCache = new Map<NestedTable, string[]>();
  private readonly state: NestedMutationsState;
  private readonly client: PgClient;

  constructor(state: NestedMutationsState, client: PgClient) {
    this.state = state;
    this.client = client;
  }

  private returnAttributes(table: NestedTable): string[] {
    let attrs = this.returnAttributesCache.get(table);
    if (!attrs) {
      const set = new Set<string>(table.primaryKey?.attributes ?? []);
      for (const fields of this.state.fieldsByTable.values()) {
        for (const f of fields) {
          if (f.table === table) f.localAttributes.forEach((a) => set.add(a));
          if (f.foreignTable === table) {
            f.foreignAttributes.forEach((a) => set.add(a));
          }
        }
      }
      attrs = [...set];
      this.returnAttributesCache.set(table, attrs);
    }
    return attrs;
  }

  private returning(table: NestedTable): SQL {
    const attrs = this.returnAttributes(table);
    if (attrs.length === 0) return sql`1 as "?column?"`;
    return sql.join(
      attrs.map(
        (a) => sql`${sql.identifier(a)}::text as ${sql.identifier(a)}`,
      ),
      ", ",
    );
  }

  async query(text: SQL, arrayMode = false): Promise<any[]> {
    const compiled = sql.compile(text);
    const { rows } = await this.client.query<any>({
      text: compiled.text,
      values: compiled.values as any[],
      arrayMode,
    });
    return rows as any[];
  }

  /**
   * Writes `row` (and everything nested in it). For updates, `where`
   * identifies the row. Returns the row's key attributes as text, or null if
   * no row was found to update.
   */
  async writeRow(row: NestedRow, where: SQL | null): Promise<TextRow | null> {
    const { table } = row;
    const forward = row.relations.filter((r) => r.field.isForward);
    const reverse = row.relations.filter((r) => !r.field.isForward);

    // 1. Forward relations: resolve the referenced row first, then set the FK.
    for (const relation of forward) {
      await this.processForward(row, relation);
    }

    // 2. The row itself.
    const target = tableSql(table);
    const entries = [...row.values.entries()];
    let rows: TextRow[];
    if (row.mode === "insert") {
      const query =
        entries.length > 0
          ? sql`insert into ${target} (${sql.join(
              entries.map(([a]) => sql.identifier(a)),
              ", ",
            )}) values (${sql.join(
              entries.map(([a, v]) => sqlAttributeValue(table, a, v)),
              ", ",
            )}) returning ${this.returning(table)}`
          : sql`insert into ${target} default values returning ${this.returning(
              table,
            )}`;
      rows = await this.query(query);
    } else {
      if (!where) throw new Error("Update requires a condition");
      const query =
        entries.length > 0
          ? sql`update ${target} set ${sql.join(
              entries.map(
                ([a, v]) =>
                  sql`${sql.identifier(a)} = ${sqlAttributeValue(table, a, v)}`,
              ),
              ", ",
            )} where ${where} returning ${this.returning(table)}`
          : sql`select ${this.returning(table)} from ${target} where ${where}`;
      rows = await this.query(query);
    }
    const written = rows[0] ?? null;
    if (!written) return null;

    // 3. Reverse relations, now that the row (and its keys) exist.
    for (const relation of reverse) {
      await this.processReverse(written, relation);
    }
    return written;
  }

  private setForeignKey(
    row: NestedRow,
    field: NestedRelationField,
    source: TextRow,
  ) {
    const allowed =
      row.mode === "insert"
        ? row.table.insertableAttributes
        : row.table.updatableAttributes;
    field.localAttributes.forEach((attributeName, i) => {
      // V4 dropped values for attributes the role/tags can't write.
      if (!allowed.has(attributeName)) return;
      row.values.set(
        attributeName,
        new PgText(source[field.foreignAttributes[i]] ?? null),
      );
    });
  }

  private async selectKeys(lookup: NestedKeyLookup): Promise<TextRow | null> {
    const { table } = lookup;
    const rows = await this.query(
      sql`select ${this.returning(table)} from ${tableSql(table)} where ${lookupWhere(lookup)}`,
    );
    return rows[0] ?? null;
  }

  private async processForward(row: NestedRow, relation: NestedRelationInput) {
    const { field } = relation;

    // V4 order: connect, deleteBy, updateBy, create (last one wins).
    for (const lookup of relation.connects) {
      const found = await this.selectKeys(lookup);
      if (!found) throw new Error("invalid connect keys");
      this.setForeignKey(row, field, found);
    }

    // V4 quirk, kept for parity: on a *forward* relation `deleteBy*` only
    // looks the row up and links it; it does not delete it.
    for (const lookup of relation.deletes) {
      const found = await this.selectKeys(lookup);
      if (!found) throw new Error("invalid connect keys");
      this.setForeignKey(row, field, found);
    }

    for (const lookup of relation.updates) {
      const updated = await this.writeRow(lookup.patch, lookupWhere(lookup));
      if (!updated) throw new Error("unmatched row for update");
      this.setForeignKey(row, field, updated);
    }

    for (const create of relation.creates) {
      const created = await this.writeRow(create, null);
      if (!created) throw new Error("Unable to create nested row.");
      this.setForeignKey(row, field, created);
    }
  }

  private async processReverse(parent: TextRow, relation: NestedRelationInput) {
    const { field } = relation;
    const { foreignTable } = field;
    // On the child (foreign) table: the referencing attributes, and the
    // values they must take to point at `parent`.
    const fkEntries: Array<[string, PgText]> = field.foreignAttributes.map(
      (a, i) => [a, new PgText(parent[field.localAttributes[i]] ?? null)],
    );
    const primaryKey = foreignTable.primaryKey?.attributes ?? null;
    const modifiedRows: TextRow[] = [];
    const target = tableSql(foreignTable);

    if (field.isUnique && relation.keyCount > 1) {
      throw new Error("Unique relations may only create or connect a single row.");
    }

    for (const lookup of relation.connects) {
      const rows = await this.query(
        sql`update ${target} set ${sql.join(
          fkEntries.map(
            ([a, v]) =>
              sql`${sql.identifier(a)} = ${sqlAttributeValue(foreignTable, a, v)}`,
          ),
          ", ",
        )} where ${lookupWhere(lookup)} returning ${this.returning(foreignTable)}`,
      );
      if (primaryKey) {
        if (!rows[0]) throw new Error("Unable to update/select parent row.");
        modifiedRows.push(rows[0]);
      }
    }

    for (const lookup of relation.deletes) {
      // V4: deletes by key only (not restricted to this parent).
      await this.query(sql`delete from ${target} where ${lookupWhere(lookup)}`);
    }

    for (const lookup of relation.updates) {
      const where = sql`${lookupWhere(lookup)} and ${andEquals(
        foreignTable,
        fkEntries,
      )}`;
      const updated = await this.writeRow(lookup.patch, where);
      if (!updated) throw new Error("unmatched update");
      if (primaryKey) modifiedRows.push(updated);
    }

    if (relation.deleteOthers) {
      if (!primaryKey) {
        throw new Error(
          "`deleteOthers` is not supported on foreign relations with no primary key.",
        );
      }
      // V4 semantics: keep rows that differ from *every* modified row in
      // *every* primary key attribute.
      const keep = modifiedRows.map(
        (r) =>
          sql`(${sql.join(
            primaryKey.map(
              (a) =>
                sql`${sql.identifier(a)} <> ${sqlAttributeValue(
                  foreignTable,
                  a,
                  new PgText(r[a] ?? null),
                )}`,
            ),
            " and ",
          )})`,
      );
      await this.query(
        sql`delete from ${target} where ${andEquals(foreignTable, fkEntries)}${
          keep.length ? sql` and (${sql.join(keep, " and ")})` : sql.blank
        }`,
      );
    }

    for (const create of relation.creates) {
      for (const [a, v] of fkEntries) create.values.set(a, v);
      const created = await this.writeRow(create, null);
      if (created && primaryKey) modifiedRows.push(created);
    }
  }

  /**
   * Re-reads the root row after all nested work, selecting exactly what the
   * payload asked for (`selects` built by the core step), in the same
   * transaction.
   */
  async selectPayload(
    table: NestedTable,
    keys: TextRow,
    alias: SQL,
    selects: ReadonlyArray<SQL>,
  ): Promise<any[] | null> {
    const pk = table.primaryKey!.attributes;
    const where = sql.join(
      pk.map(
        (a) =>
          sql`${alias}.${sql.identifier(a)} = ${sqlAttributeValue(
            table,
            a,
            new PgText(keys[a] ?? null),
          )}`,
      ),
      " and ",
    );
    const fragments = selects.length
      ? sql.join(
          selects.map((frag, idx) => sql`${frag} as ${sql.identifier(String(idx))}`),
          ",\n",
        )
      : sql`1`;
    const rows = await this.query(
      sql`select ${fragments} from ${tableSql(table)} as ${alias} where ${where}`,
      true,
    );
    return rows[0] ?? null;
  }
}

// -----------------------------------------------------------------------------
// Steps
// -----------------------------------------------------------------------------

interface CoreMutationStepInternals {
  contextId: number;
  applyDepIds: number[];
  selects: ReadonlyArray<SQL>;
  alias: SQL;
  attributes: Array<{ name: string; depId: number; pgCodec: PgCodec }>;
}

async function runInTransaction<T>(
  context: PgExecutorContext,
  callback: (client: PgClient) => Promise<T>,
): Promise<T> {
  const { withPgClient, pgSettings } = context;
  // `withPgClient` applies pgSettings (role, JWT claims...) with
  // `set_config(..., true)` inside a transaction; `withTransaction` nests
  // inside it (or opens one), so every statement below runs on this single
  // client, between one BEGIN and its COMMIT/ROLLBACK.
  return withPgClient(pgSettings, (client) =>
    client.withTransaction((tx) => callback(tx)),
  );
}

function buildRootRow(
  step: CoreMutationStepInternals,
  table: NestedTable,
  mode: "insert" | "update",
  values: ExecutionDetails["values"],
  i: number,
) {
  const row = new NestedRow(table, mode);
  for (const { depId, name } of step.attributes) {
    const value = values[depId].at(i);
    if (value !== undefined) row.set(name, value);
  }
  for (const applyDepId of step.applyDepIds) {
    const callback = values[applyDepId].unaryValue() as any;
    if (Array.isArray(callback)) {
      callback.forEach((cb) => cb?.(row));
    } else {
      callback?.(row);
    }
  }
  return row;
}

function payloadTuple(row: NestedRow, tuple: any[]) {
  return { __proto__: null, m: row.meta, t: tuple, c: 1, n: [] };
}

/**
 * `create*` mutation for a table with nested fields. Extends the core step
 * so that everything downstream (payload fields, `getMeta`, edges...) keeps
 * working unchanged; only execution differs.
 */
export class PgNestedInsertStep extends PgInsertSingleStep<any> {
  static $$export = {
    moduleName: "postgraphile-plugin-nested-mutations",
    exportName: "PgNestedInsertStep",
  };
  private readonly clientMutationIdDepId: number | null;
  private readonly nestedState: NestedMutationsState;

  constructor(
    resource: PgTableResource,
    nestedState: NestedMutationsState,
    $clientMutationId: Step | null,
  ) {
    super(resource as any);
    this.nestedState = nestedState;
    this.clientMutationIdDepId = $clientMutationId
      ? this.addDependency($clientMutationId)
      : null;
  }

  getMeta(key: string): any {
    // V4 returned `clientMutationId` even when the row could not be read
    // back; take it straight from the input.
    if (key === "clientMutationId" && this.clientMutationIdDepId !== null) {
      return this.getDep(this.clientMutationIdDepId);
    }
    return super.getMeta(key);
  }

  async execute(details: ExecutionDetails): Promise<any> {
    const { indexMap, values } = details;
    const self = this as unknown as CoreMutationStepInternals;
    const table = this.nestedState.tables.get(this.resource as any)!;
    const contextDep = values[self.contextId];
    return indexMap(async (i) => {
      const context = contextDep.at(i) as PgExecutorContext;
      const row = buildRootRow(self, table, "insert", values, i);
      return runInTransaction(context, async (client) => {
        const engine = new NestedMutationEngine(this.nestedState, client);
        const keys = await engine.writeRow(row, null);
        // V4: tables without a primary key give a null payload record.
        if (!keys || !table.primaryKey) return null;
        const tuple = await engine.selectPayload(
          table,
          keys,
          self.alias,
          self.selects,
        );
        return tuple ? payloadTuple(row, tuple) : null;
      });
    });
  }
}

export type UpdateTarget =
  | { mode: "node" }
  | { mode: "keys"; unique: PgResourceUnique };

/** `update*` mutation (by node ID or by unique key) with nested fields. */
export class PgNestedUpdateStep extends PgUpdateSingleStep<any> {
  static $$export = {
    moduleName: "postgraphile-plugin-nested-mutations",
    exportName: "PgNestedUpdateStep",
  };
  private readonly clientMutationIdDepId: number | null;
  private readonly nodeIdDepId: number | null;
  private readonly keyDepIds: Array<[string, number]>;
  private readonly nestedState: NestedMutationsState;

  constructor(
    resource: PgTableResource,
    nestedState: NestedMutationsState,
    target:
      | { mode: "node"; $nodeId: Step; pk: readonly string[] }
      | { mode: "keys"; keys: Record<string, Step> },
    $clientMutationId: Step | null,
  ) {
    // The core step insists on a getBy spec covering a unique. We identify
    // the row ourselves at execution time (so that a bad node ID raises V4's
    // errors instead of being silently inhibited), so pass the raw values.
    const getBy =
      target.mode === "node"
        ? Object.fromEntries(target.pk.map((a) => [a, target.$nodeId]))
        : target.keys;
    super(resource as any, getBy as any);
    this.nestedState = nestedState;
    this.clientMutationIdDepId = $clientMutationId
      ? this.addDependency($clientMutationId)
      : null;
    if (target.mode === "node") {
      this.nodeIdDepId = this.addDependency(target.$nodeId);
      this.keyDepIds = [];
    } else {
      this.nodeIdDepId = null;
      this.keyDepIds = Object.entries(target.keys).map(([a, $v]) => [
        a,
        this.addDependency($v),
      ]);
    }
  }

  getMeta(key: string): any {
    if (key === "clientMutationId" && this.clientMutationIdDepId !== null) {
      return this.getDep(this.clientMutationIdDepId);
    }
    return super.getMeta(key);
  }

  async execute(details: ExecutionDetails): Promise<any> {
    const { indexMap, values } = details;
    const self = this as unknown as CoreMutationStepInternals;
    const table = this.nestedState.tables.get(this.resource as any)!;
    const contextDep = values[self.contextId];
    return indexMap(async (i) => {
      const context = contextDep.at(i) as PgExecutorContext;
      const row = buildRootRow(self, table, "update", values, i);
      const entries =
        this.nodeIdDepId !== null
          ? nodeIdToEntries(table, values[this.nodeIdDepId].at(i))
          : this.keyDepIds.map(
              ([a, depId]) => [a, values[depId].at(i)] as [string, unknown],
            );
      const where = andEquals(table, entries);
      return runInTransaction(context, async (client) => {
        const engine = new NestedMutationEngine(this.nestedState, client);
        const keys = await engine.writeRow(row, where);
        // V4: no row matched, or no primary key -> null payload record.
        if (!keys || !table.primaryKey) return null;
        const tuple = await engine.selectPayload(
          table,
          keys,
          self.alias,
          self.selects,
        );
        return tuple ? payloadTuple(row, tuple) : null;
      });
    });
  }
}
