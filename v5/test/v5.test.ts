/*
 * V5-only features: per-relation behaviors, inflector overrides, options in
 * `preset.schema`, and use without the V4 compatibility preset.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GraphQLInputObjectType } from "postgraphile/graphql";
import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { makeV4Preset } from "postgraphile/presets/v4";

import { PgNestedMutationsPreset } from "../src/index.ts";
import { buildSchema, execute, withRolledBackClient } from "./support/harness.ts";

const setup = (constraintComment = "") => `
  create table p.parent (id serial primary key, name text not null);
  create table p.child (
    id serial primary key,
    parent_id int,
    name text not null,
    constraint child_parent_fkey foreign key (parent_id) references p.parent (id)
  );
  ${constraintComment}
`;

const v4Preset = (extra: GraphileConfig.Preset = {}): GraphileConfig.Preset => ({
  extends: [PostGraphileAmberPreset, makeV4Preset({}), PgNestedMutationsPreset],
  ...extra,
});

const fieldsOf = (schema: any, typeName: string) =>
  Object.keys((schema.getType(typeName) as GraphQLInputObjectType).getFields());

test("behaviors toggle nested operations per relation", async () => {
  await withRolledBackClient(async (client) => {
    await client.query(
      setup(`comment on constraint child_parent_fkey on p.child is
        E'@behavior -nestedMutation:insert -nestedMutation:deleteOthers -nestedMutation:update';`),
    );
    const { schema } = await buildSchema(client, v4Preset());
    assert.deepEqual(fieldsOf(schema, "ChildParentFkeyInverseInput"), [
      "connectById",
      "connectByNodeId",
      "deleteById",
      "deleteByNodeId",
    ]);
    assert.deepEqual(fieldsOf(schema, "ChildParentFkeyInput"), [
      "connectById",
      "connectByNodeId",
      "deleteById",
      "deleteByNodeId",
    ]);
  });
});

test("`@omit update` with `-nestedMutation:update` hides nested updateBy* fields", async () => {
  await withRolledBackClient(async (client) => {
    await client.query(
      setup(`comment on constraint child_parent_fkey on p.child is
        E'@omit update\\n@behavior -nestedMutation:update';`),
    );
    const { schema } = await buildSchema(client, v4Preset());
    const fields = fieldsOf(schema, "ChildParentFkeyInverseInput");
    assert.ok(!fields.includes("updateById"));
    assert.ok(fields.includes("connectById"));
  });
});

test("removing every nested behavior removes the nested field", async () => {
  await withRolledBackClient(async (client) => {
    await client.query(
      setup(`comment on constraint child_parent_fkey on p.child is
        E'@behavior -nestedMutation:connect -nestedMutation:insert -nestedMutation:update -nestedMutation:delete';`),
    );
    const { schema } = await buildSchema(client, v4Preset());
    assert.equal(schema.getType("ChildParentFkeyInverseInput"), undefined);
    assert.ok(!fieldsOf(schema, "ParentInput").includes("childrenUsingId"));
  });
});

test("inflectors can be overridden", async () => {
  await withRolledBackClient(async (client) => {
    await client.query(setup());
    const { schema } = await buildSchema(
      client,
      v4Preset({
        plugins: [
          {
            name: "RenameNestedPlugin",
            version: "0.0.0",
            inflection: {
              replace: {
                nestedConnectorType(previous, _options, details) {
                  return `Nested${previous!(details)}`;
                },
                nestedFieldName(_previous, _options, details) {
                  return details.isForward ? "theParent" : "theChildren";
                },
              },
            },
          },
        ],
      }),
    );
    assert.ok(schema.getType("NestedChildParentFkeyInput"));
    assert.ok(fieldsOf(schema, "ParentInput").includes("theChildren"));
    assert.ok(fieldsOf(schema, "ChildInput").includes("theParent"));
  });
});

test("options are read from preset.schema", async () => {
  await withRolledBackClient(async (client) => {
    await client.query(setup());
    const { schema } = await buildSchema(
      client,
      v4Preset({
        schema: {
          nestedMutationsSimpleFieldNames: true,
          nestedMutationsDeleteOthers: false,
        },
      }),
    );
    assert.ok(fieldsOf(schema, "ParentInput").includes("children"));
    assert.ok(fieldsOf(schema, "ChildInput").includes("parent"));
    assert.ok(!fieldsOf(schema, "ChildParentFkeyInverseInput").includes("deleteOthers"));
  });
});

test("works without the V4 preset (native V5 naming)", async () => {
  await withRolledBackClient(async (client) => {
    await client.query(setup("insert into p.parent (name) values ('existing');"));
    const built = await buildSchema(client, {
      extends: [PostGraphileAmberPreset, PgNestedMutationsPreset],
    });
    const parentFields = fieldsOf(built.schema, "ParentInput");
    assert.deepEqual(parentFields, ["rowId", "name", "childrenUsingRowId"]);
    const result = await execute(
      built,
      `mutation {
        createChild(input: { child: {
          name: "c"
          parentToParentId: { connectByRowId: { rowId: 1 } }
        } }) { child { rowId name parentByParentId { rowId name } } }
      }`,
    );
    assert.deepEqual(result, {
      data: {
        createChild: {
          child: {
            rowId: 1,
            name: "c",
            parentByParentId: { rowId: 1, name: "existing" },
          },
        },
      },
    });
  });
});
