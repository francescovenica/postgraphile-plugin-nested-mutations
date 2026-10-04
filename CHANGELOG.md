# Changes

## v2.0.0

- **Breaking:** PostGraphile V5 only. The package is ESM and exports
  `PgNestedMutationsPreset` (add it to your preset's `extends`). The
  PostGraphile V4 plugin stays in v1.x. See MIGRATION.md.
- With the V4 compatibility preset the schema and behaviour match v1.x;
  deliberate differences are documented in MIGRATION.md and
  parity/known-differences.cjs.
- The preset is split into one plugin per concern:
  `PgNestedMutationsInflectionPlugin`, `…GatherPlugin`, `…BehaviorPlugin`,
  `…TypesPlugin`, `…FieldsPlugin` and `…PlansPlugin`.
- New per-relation behaviors `nestedMutation:connect`, `:insert`, `:update`,
  `:delete` and `:deleteOthers`; new inflectors `nestedFieldName` and
  `nestedTableFieldName`.
- `nestedMutationsList` is optional (unset means no filtering).
- `@omit` is no longer parsed by the plugin; the V4 preset translates it.
  A constraint with `@omit update` now hides nested `updateBy*` fields.
- Tests run on Vitest: the v1.x integration tests run against the V5 plugin,
  plus replays of v1.x recordings, transaction and RLS tests.

## v1.1.0

- Add support for --classic-ids.
- Re-order operations so that deleteOthers is done before inserting a
  new row.
- Fix parenthesis wrapping for tables with multiple keys.

## v1.0.1

- Correctly release the savepoint on error (thanks @sijad).

## v1.0.0

- Bump dependencies.
- Guard against creating updater fields where constraint is not available.

## v1.0.0-alpha.22

- Fix bug where if an update mutation was called that did not locate
  a row, we'd still try and extract the PKs.

## v1.0.0-alpha.21

- Really fix `updateByNodeId`. Thanks for the report @ken0x0a!

## v1.0.0-alpha.20

- Fix case where a mutation specified `nestedMutationField: null`.

## v1.0.0-alpha.19

- `deleteOthers` now is not in the schema where the foreign table
  has `@omit delete`.
- Fixed error that prevented `updateByNodeId` from working.

## v1.0.0-alpha.18

- Correctly handle `null` values to connect and update fields.

## v1.0.0-alpha.17

- Add support for `@fieldName` and `@foreignFieldName` smart comments on
  foreign keys to match those used in PostGraphile. The original
  `@forwardMutationName` and `@reverseMutationName` smart comments will
  remain to allow for renaming the fields just for nested mutations.

## v1.0.0-alpha.16

- Support `deleteOthers` where there are no other records modified. Thanks
  @srp.

## v1.0.0-alpha.15

- The patch type for nested updates now correctly omits the keys that are
  the subject of the nested mutation.

## v1.0.0-alpha.14

- Support for updating nested records.

## v1.0.0-alpha.13

- 1:1 relationships no longer allow a list of objects, or allow multiple
  operations, preventing a constraint violation.

## v1.0.0-alpha.11

- _BREAKING_ One-to-one relationships are now correctly named in the singular. To
  keep using the old behaviour, use the `nestedMutationsOldUniqueFields` option.
- _BREAKING_ The `connect` field has been removed. In its place is `connectByNodeId`
  which takes a nodeId, and `connnectBy<PK Fields>` for the table's primary key and
  each unique key.
- Nested mutations on update mutations are now supported.
- Existing rows can be now be `connected`.
- Multiple actions per nested type may now be specified (i.e. create some records
  and connect others).
- A new field has been added on nested mutations: `deleteOthers`. When set to `true`,
  any related rows not updated or created in the nested mutation will be deleted. To
  keep a row that is not being created or updated, specify it for update with no
  modified fields.
- Relationships between two tables that have multiple relationships are now supported.
  Previously, the last constraint would overwrite the others. These will usually end
  up with some pretty awkward names, so the use of smart comments to name the relationships
  is recommended.
- Improved test suite.

## v1.0.0-alpha.7

Relationships using composite keys are now supported, and this has meant creating
a custom field name for the nested mutation, rather than piggybacking an existing ID
field. See the examples below for the new GraphQL schema that is generated.
