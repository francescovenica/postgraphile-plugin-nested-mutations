[![Package on npm](https://img.shields.io/npm/v/postgraphile-plugin-nested-mutations.svg)](https://www.npmjs.com/package/postgraphile-plugin-nested-mutations)

# postgraphile-plugin-nested-mutations
This plugin implements nested mutations based on both forward and reverse foreign
key relationships in PostGraphile V5.  Nested mutations can be of infinite depth.

Requires `postgraphile@^5` and Node.js 22.18+ (the package is ESM).  For
PostGraphile V4, use version 1.x of this package.  Upgrading from 1.x?  See
[MIGRATION.md](MIGRATION.md).

## Getting Started

```bash
npm install postgraphile-plugin-nested-mutations
```

Add `PgNestedMutationsPreset` to your preset's `extends`:

```js
// graphile.config.mjs
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber';
import { makePgService } from 'postgraphile/adaptors/pg';
import { PgNestedMutationsPreset } from 'postgraphile-plugin-nested-mutations';

export default {
  extends: [PostGraphileAmberPreset, PgNestedMutationsPreset],
  pgServices: [
    makePgService({
      connectionString: process.env.DATABASE_URL,
      schemas: ['app_public'],
    }),
  ],
};
```

The field and type names in this README (`childrenUsingId`,
`parentToParentId`, ...) are the ones generated with PostGraphile's V4
compatibility preset, which produces the same schema as version 1.x of this
plugin:

```js
import { makeV4Preset } from 'postgraphile/presets/v4';

export default {
  extends: [PostGraphileAmberPreset, makeV4Preset({}), PgNestedMutationsPreset],
  // ...
};
```

The plugins are also exported individually (`PgNestedMutationsInflectionPlugin`,
`PgNestedMutationsGatherPlugin`, `PgNestedMutationsBehaviorPlugin`,
`PgNestedMutationsTypesPlugin`, `PgNestedMutationsFieldsPlugin` and
`PgNestedMutationsPlansPlugin`) if you assemble your own preset; include all six.

### Plugin Options

Options go in `preset.schema`:

```js
export default {
  extends: [PostGraphileAmberPreset, PgNestedMutationsPreset],
  schema: {
    nestedMutationsSimpleFieldNames: true,
    nestedMutationsDeleteOthers: false,
  },
};
```

<details>

<summary>nestedMutationsSimpleFieldNames</summary>

Use simple field names for nested mutations.  Instead of names suffixed with
`tableBy<Key>` and `tableUsing<Key>`, tables with a single foreign key relationship
between them will have their nested relation fields named `table`.  Defaults to
`false`.
</details>

<details>

<summary>nestedMutationsDeleteOthers</summary>

Controls whether the `deleteOthers` field is available on nested mutations.  Defaults
to `true`.
</details>

<details>

<summary>nestedMutationsOldUniqueFields</summary>

If enabled, plural names for one-to-one relations will be used.  For backwards
compatibility.  Defaults to `false`.
</details>

<details>

<summary>nestedMutationsList</summary>

Only add the listed nested fields, keyed by input type name, e.g.
`{ ParentInput: ['childrenUsingId'] }`.  When unset (the default), every nested
field is added.
</details>

## Usage

This plugin creates an additional field on each GraphQL `Input` type for every forward
and reverse foreign key relationship on a table, with the same name as the foreign table.

Each nested mutation field will have the following fields. They will accept an array if
the relationship is a one-to-many relationship, or a single input if they are one-to-one.

### Connect to Existing Record
#### `connectByNodeId`
Connect using a `nodeId` from the nested table.

#### `connectBy<K>`
Connect using any readable primary key or unique constraint on the nested table.

### Creating New Records
#### `create`
Create a new record in the nested table.

### Delete existing Record
#### `deleteByNodeId`
Delete using a `nodeId` from the nested table.

#### `deleteBy<K>`
Delete using any readable primary key or unique constraint on the nested table.

### Updating Records
#### `updateByNodeId`
Update a record using a `nodeId` from the nested table.

#### `updatedBy<K>`
Update a record using any readable primary key or unique constraint on the nested table.

## Example

```sql
create table parent (
  id serial primary key,
  name text not null
);

create table child (
  id serial primary key,
  parent_id integer,
  name text not null,
  constraint child_parent_fkey foreign key (parent_id)
    references p.parent (id)
);
```

A nested mutation against this schema, using `Parent` as the base mutation
would look like this:

``` graphql
mutation {
  createParent(input: {
    parent: {
      name: "Parent 1"
      childrenUsingId: {
        connectById: [{
          id: 1
        }]
        create: [{
          name: "Child 1"
        }, {
          name: "Child 2"
        }]
      }
    }
  }) {
    parent {
      id
      name
      childrenByParentId {
        nodes {
          id
          name
        }
      }
    }
  }
}
```

Or using `Child` as the base mutation:

``` graphql
mutation {
  createChild(input: {
    child: {
      name: "Child 1"
      parentToParentId: {
        create: {
          name: "Parent of Child 1"
        }
      }
    },
  }) {
    child {
      id
      name
      parentByParentId {
        id
        name
      }
    }
  }
}
```

## Smart Comments

[Smart comments](https://www.graphile.org/postgraphile/smart-comments/) are supported for 
renaming the nested mutation fields.

```sql
comment on constraint child_parent_fkey on child is
  E'@fieldName parent\n@foreignFieldName children';
```

## Behaviors

Each nested operation can be turned off per relation with
[behaviors](https://postgraphile.org/postgraphile/next/behavior), all on by default:

| Behavior | Controls |
| --- | --- |
| `nestedMutation:connect` | `connectBy*` / `connectByNodeId` |
| `nestedMutation:insert` | `create` |
| `nestedMutation:update` | `updateBy*` / `updateByNodeId` |
| `nestedMutation:delete` | `deleteBy*` / `deleteByNodeId` (and `deleteOthers`) |
| `nestedMutation:deleteOthers` | `deleteOthers` |

```sql
comment on constraint child_parent_fkey on child is
  E'@behavior -nestedMutation:insert -nestedMutation:deleteOthers';
```

The core `-insert`, `-update`, `-delete` and `-select` behaviors (and the
V4 preset's `@omit` tags, which translate to them) on the tables, relations,
columns and unique constraints are respected too.

## Inflection

All names are generated by inflectors that can be overridden with
`inflection.replace` (`nestedFieldName`, `nestedConnectorType`,
`nestedCreateInputType`, `nestedConnectByKeyField`, ...).  See
[MIGRATION.md](MIGRATION.md#inflectors) for the full list.

## Development

```bash
npm ci
TEST_DATABASE_URL=postgres://... npm test
```

The test suite includes the original (V4) integration tests, run against this
plugin, and replays recordings of the V4 plugin's results (`parity/golden`)
comparing schema, results and database state.
