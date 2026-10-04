# Migrating from PostGraphile V4 to V5

Version 2 of this package supports PostGraphile V5 only. The PostGraphile V4
plugin lives on in version 1.x.

With PostGraphile V5 and its V4 compatibility preset (`makeV4Preset`), the V5
plugin produces the same nested-mutation schema as V4: the same type names,
field names, arguments, nullability, list-ness, descriptions and field order.
It also behaves the same at runtime, so client operations don't need to
change. Differences are listed under [Known differences](#known-differences).
Each one is checked by the test suite.

Requirements: `postgraphile@^5`, Node.js 22.18+ (the package is ESM).

## Configuration

### V4 (version 1.x)

```js
const PostGraphileNestedMutations = require('postgraphile-plugin-nested-mutations');

app.use(
  postgraphile(DATABASE_URL, ['app_public'], {
    appendPlugins: [PostGraphileNestedMutations],
    graphileBuildOptions: {
      nestedMutationsSimpleFieldNames: true,
      nestedMutationsDeleteOthers: false,
    },
  }),
);
```

### V5 (version 2)

```js
// graphile.config.mjs
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber';
import { makeV4Preset } from 'postgraphile/presets/v4';
import { makePgService } from 'postgraphile/adaptors/pg';
import { PgNestedMutationsPreset } from 'postgraphile-plugin-nested-mutations';

export default {
  extends: [
    PostGraphileAmberPreset,
    makeV4Preset({
      /* your other V4 options: jwtSecret, pgSettings, ignoreRBAC, ... */
    }),
    PgNestedMutationsPreset,
  ],
  pgServices: [
    makePgService({
      connectionString: process.env.DATABASE_URL,
      schemas: ['app_public'],
    }),
  ],
  schema: {
    nestedMutationsSimpleFieldNames: true,
    nestedMutationsDeleteOthers: false,
  },
};
```

If you build your own preset, the plugins are also exported individually:
`PgNestedMutationsInflectionPlugin`, `PgNestedMutationsGatherPlugin`,
`PgNestedMutationsBehaviorPlugin`, `PgNestedMutationsTypesPlugin`,
`PgNestedMutationsFieldsPlugin` and `PgNestedMutationsPlansPlugin`. Include
all six.

### Options

The option names and defaults are unchanged. In V5 they go in
`preset.schema` instead of `graphileBuildOptions`. Passing them inside
`makeV4Preset({ graphileBuildOptions })` works too, because the V4 preset
copies them into `preset.schema`.

| Option | Default | Effect |
| --- | --- | --- |
| `nestedMutationsSimpleFieldNames` | `false` | Simple field names (`parent`, `children`) when only one relation exists between the tables |
| `nestedMutationsDeleteOthers` | `true` | Expose `deleteOthers` on reverse relations |
| `nestedMutationsOldUniqueFields` | `false` | Plural names for one-to-one relations |
| `nestedMutationsList` | unset | Allow list keyed by input type name, e.g. `{ ParentInput: ['childrenUsingId'] }`. When unset, every nested field is added |

### pgSettings, roles and RLS

There's nothing specific to the plugin here. Configure `pgSettings` (or
`jwtSecret` and friends) the way V5 expects: through `makeV4Preset({ pgSettings })`,
`makePgService({ pgSettings })` or `preset.grafast.context`. Every nested
statement runs with those settings. See [Transactions](#transactions).

## Smart tags and behaviors

All V4 smart tags keep working:

| Smart tag | Where | Effect (same as V4) |
| --- | --- | --- |
| `@name` | constraint | Renames the plugin's types (`<Name>Input`, `...For<Name>...`) |
| `@fieldName`, `@foreignFieldName` | FK constraint | Forward / reverse nested field name |
| `@forwardMutationName`, `@reverseMutationName` | FK constraint | Same, for nested mutations only |
| `@omit create` | table / FK constraint / FK column | No nested `create` |
| `@omit delete` | table / FK constraint | No nested `deleteBy*` / `deleteOthers` |
| `@omit read` | table / FK constraint | No nested field for that relation |
| `@omit` | unique constraint | No `connectBy*`/`deleteBy*`/`updateBy*` for that key |

`@omit` is read through V5 behaviors, not by reading the tags directly. The
V4 preset translates `@omit` into behaviors (`-insert`, `-update`, `-delete`,
`-select`, ...), and the plugin checks those behaviors on the resource,
relation, attribute or unique constraint. Any other source of those behaviors
(`@behavior` tags, or V5's RBAC behaviors with `ignoreRBAC: false`) therefore
affects the nested fields too. The test fixtures introspect as a superuser, so
RBAC-derived behaviors aren't covered by the parity tests.

The plugin also registers its own behaviors on relations (`pgCodecRelation`),
all on by default:

| Behavior | Controls |
| --- | --- |
| `nestedMutation:connect` | `connectBy*` / `connectByNodeId` |
| `nestedMutation:insert` | `create` |
| `nestedMutation:update` | `updateBy*` / `updateByNodeId` |
| `nestedMutation:delete` | `deleteBy*` / `deleteByNodeId` (and `deleteOthers`) |
| `nestedMutation:deleteOthers` | `deleteOthers` |

```sql
comment on constraint child_parent_fkey on app_public.child is
  E'@behavior -nestedMutation:insert -nestedMutation:deleteOthers';
```

The behaviors use the `forwardBehavior`/`backwardBehavior` tags (or
`preset.schema.defaultBehavior`) like any other relation behavior. The create
toggle is called `nestedMutation:insert` because graphile-build rejects
behavior filters that end in `create`.

V4 ignored `@omit update` on an FK constraint when deciding whether to add
nested `updateBy*` fields. To keep the schema the same, the plugin
re-enables `nestedMutation:update` right after the V4 preset's `-update`. An
explicit `@behavior -nestedMutation:update` still turns them off.

## Inflectors

Every V4 inflector exists in V5 with the same name and output, and can be
overridden with `inflection.replace`:

`nestedConnectorType`, `nestedCreateInputType`, `nestedConnectByNodeIdField`,
`nestedConnectByKeyField`, `nestedConnectByNodeIdInputType`,
`nestedConnectByKeyInputType`, `nestedDeleteByNodeIdField`,
`nestedDeleteByKeyField`, `nestedDeleteByNodeIdInputType`,
`nestedDeleteByKeyInputType`, `nestedUpdateByNodeIdField`,
`nestedUpdateByKeyField`, `nestedUpdateByNodeIdInputType`,
`nestedUpdatePatchType`, `nestedUpdateByKeyInputType`.

New inflectors:

- `nestedFieldName(details)`: in V4 this was `build.pgNestedFieldName`, which
  couldn't be overridden. Its details include `isUnique` and `multipleFKs`,
  computed exactly as V4 did.
- `nestedTableFieldName(resource)`: V4's `tableFieldName` rule (camelCase of
  the singularized table name). V5's own `tableFieldName` differs for names
  like `a_b` (`ab` instead of V4's `aB`), so the plugin uses this inflector for
  every name and description it generates.

The `details` arguments now carry V5 objects: `table`/`foreignTable` are
`PgResource`s, `constraint`/`keyConstraint` are the plugin's descriptors
(`name`, `tags`, attribute names, the relations). The keys are the same as in
V4.

```js
const RenamePlugin = {
  name: 'RenameNestedPlugin',
  version: '1.0.0',
  inflection: {
    replace: {
      nestedConnectorType(previous, options, details) {
        return `Nested${previous(details)}`;
      },
    },
  },
};
```

## How the V5 version works

### Execution strategy

`create*` and `update*` mutations of tables with nested fields are planned
with subclasses of the core `PgInsertSingleStep` / `PgUpdateSingleStep`
(`PgNestedInsertStep` / `PgNestedUpdateStep`). Only their `execute` differs,
so everything the payload plans against those steps keeps working:
`get()`, `record()`, `getMeta()`, edges and so on.

At execution time, Grafast walks the mutation's `input` argument and calls
each input field's `apply` callback, just as for core mutations. The core
attribute fields set column values, with the core value handling, onto the
plugin's row builder. The plugin's nested fields record their operations
into a small tree. Input-dependent shapes therefore work naturally: lists of
any length, `null`s, input passed through variables, and any depth.

The step then runs the tree imperatively:

1. forward relations (connect → `deleteBy` → `updateBy` → create), before the
   row is written, setting the FK;
2. the row itself (`insert … returning` / `update … returning`);
3. reverse relations (connect → delete → update → `deleteOthers` → create),
   using the written row's keys;
4. a re-select of the root row, choosing exactly the columns the payload asked
   for (the core step's `selects`).

All SQL is built with `pg-sql2` and the attribute codecs.

The other strategy, building nested writes as Grafast steps at plan time,
was rejected. Plans are built once per operation shape, but nested input is
data-dependent: list lengths, which branches are present, and FK values only
known after an earlier write. Expressing V4's ordering (forward writes before
the row, reverse writes after it, `deleteOthers` relative to the others) and
atomicity as a step graph would need per-shape plans and couldn't guarantee
that every statement shares one transaction. The runtime approach mirrors V4
and keeps the whole tree in one place.

### Transactions

Each root mutation field obtains its client the same way core mutations do,
through the executor context's `withPgClient(pgSettings, …)`, and then calls
`client.withTransaction(…)`:

```
BEGIN
SELECT set_config(...)        -- role, JWT claims: pgSettings, transaction-local
SAVEPOINT tx1
INSERT … parent / child / grandchild …
SELECT … parent (payload re-select)
RELEASE SAVEPOINT tx1
COMMIT                        -- or ROLLBACK on any error
```

Every statement of a nested mutation, at any depth, runs on the same backend,
inside that transaction, with RLS and `pgSettings` applied. Any error (a
constraint violation, an invalid node ID, a missing row on
connect/update, an RLS denial, a thrown error) rolls the whole tree back.
When the client is already inside a transaction (for example in tests),
savepoints are used instead.

**Several root mutation fields in one request.** V4 runs the request in one
transaction with a savepoint per field. V5 runs each field in its own
transaction. Either way, if the second field fails it is rolled back on its
own, and the first one's changes persist. The tests check this against V4.

**Payload relations.** The payload's root row is re-read inside the
transaction. Relations selected from it (for example
`parent { childrenByParentId { … } }`) are planned by V5 core and run
afterwards, in their own transaction with the same `pgSettings`. V5 core does
this for every mutation. They see the committed state, so results match V4.

## Known differences

### Plugin differences (deliberate)

These are verified by `parity/known-differences.cjs`:

1. **`@omit update` on the foreign table.** V4 still offered nested
   `updateBy*` on such a table (it built its own `XPatch` type), and the update
   really ran. V5 hides these fields, because the role/tags don't allow
   updates on that table.
2. **FK column omitted for read/create/update.** V4 still offered nested
   connect/delete on the relation and re-added the omitted column to
   `XInput`/`XPatch`. A reverse connect then wrote the omitted column. With the
   V4 preset, a constraint over an unreadable column is itself unreadable, so
   V5 adds no nested fields for it.
3. **Error message when a deep `updateBy*` matches no row.** V4 crashed with
   `TypeError: Cannot read properties of undefined (reading 'id')`. V5 raises
   the intended `unmatched update`. Both roll back.
4. **Forward `create` through an FK to a non-primary-key unique column.** V4
   left the FK `NULL`, because it read only the new row's primary key. V5 sets
   the referenced value, so the row is actually linked.

### V4 bugs fixed at runtime

These follow from V4's code. The tests compare V5 with V4 wherever V4's
outcome is deterministic:

- On forward relations, V4 ran its secondary nested `updateBy*` path without
  awaiting it, so its errors were swallowed and didn't roll back. V5 awaits
  everything.
- V4 ran sibling nested writes concurrently under identically named
  savepoints. A failure (for example a unique violation between two created
  children) left the transaction aborted, so the request's COMMIT silently
  rolled back other root fields too. V5 runs nested writes sequentially in
  V4's order, so a failure rolls back only its own mutation field.
- V4 applied a nested `updateBy*` patch twice (once restricted to the
  relation, once more without that restriction). V5 applies it once, with the
  restriction.
- V4 used `returning *` / `select *` internally, which needs SELECT on every
  column. V5 only reads the key columns it needs plus the columns the payload
  asks for.

### V4 behavior kept for parity

- On a **forward** relation, `deleteBy*` only looks the row up and links it.
  It doesn't delete it.
- On a reverse relation, `deleteBy*` deletes by key without checking that the
  row belongs to the parent (RLS still applies).
- `deleteOthers` with a composite primary key keeps rows that share any key
  value with a modified row (V4's `a <> x and b <> y` condition).
- `create` on a one-to-one reverse relation is still a list.
- An update matching no row returns a `null` record (with `clientMutationId`),
  not an error. So does any create/update on a table without a primary key.
- Error messages: `invalid connect keys`, `unmatched row for update`,
  `unmatched update`, `Unable to update/select parent row.`,
  `Unique relations may only create or connect a single row.`,
  `Mismatched type`, `Invalid ID`.

### Core V4 → V5 differences (not the plugin)

`parity/report.md` lists every difference left between the full V4+plugin
and V5+plugin schemas. None of them is in a type or field the plugin adds or
changes. They are V5 core changes, even with the V4 preset:

- connection `edges` items are nullable (`[XEdge]!` vs `[XEdge!]!`);
- `orderBy` on payload edges is non-null;
- descriptions on `xById` root fields;
- legacy deprecated relation fields (`legacyRelations`);
- core type and field names for tables like `a_b` (`ABInput` vs V4
  `AbInput`). Plugin descriptions that mention a core type name follow
  V5's name;
- graphql-js 16 validation message wording.

### Not supported

- Schema export (`graphile-export`): the plugin's plans aren't wrapped in
  `EXPORTABLE`.
- Polymorphic and function-backed resources: only tables, as in V4.

## Tests and the parity harness

```sh
npm ci
TEST_DATABASE_URL=postgres://… npm test
```

- `__tests__/integration` holds the V4 plugin's integration tests, unchanged
  apart from their helpers, which now build the schema with V5, the V4 preset
  and this plugin. Their schema snapshots are V5 schemas.
- `parity/golden` holds recordings made with the V4 plugin: the setup,
  options, schema with and without the plugin, and each operation's result
  plus a dump of every table afterwards (composite keys, one-to-one,
  self-reference, multiple FKs, smart tags, `@omit`, transactions, RLS).
  `__tests__/parity.test.ts` replays all of them. It compares the plugin's
  schema delta (and field order), each result, and the database state. It also
  writes `parity/report.md` from a graphql-inspector diff of the full schemas.
- `__tests__/transaction.test.ts` runs a 3-level nested mutation with
  `pgSettings` through V5's real request handling on a pool. It captures
  every statement with its backend PID and checks: one backend, one
  BEGIN … COMMIT/ROLLBACK, `set_config` inside it, nothing left behind on
  failure, and multiple root fields; outcomes are compared with the V4
  recording in `parity/golden/transactions-v4.json`.
