/* Smart tags and @omit on relations, tables and columns (see relations.cjs). */
const base = `
  create table p.parent (
    id serial primary key,
    name text not null
  );
  create table p.child (
    id serial primary key,
    parent_id integer,
    name text not null,
    constraint child_parent_fkey foreign key (parent_id)
      references p.parent (id)
  );
  insert into p.parent (name) values ('p1');
  insert into p.child (parent_id, name) values (1, 'c1'), (1, 'c2');
`;

const createParentWithChildren = (field) => `mutation {
  createParent(input: { parent: {
    name: "p2"
    ${field}: { create: [{ name: "c3" }] }
  } }) { parent { id name childrenByParentId { nodes { id name parentId } } } }
}`;

module.exports = [
  {
    name: '@omit create on the foreign key',
    setup: `${base}
      comment on constraint child_parent_fkey on p.child is E'@omit create';`,
    operations: [
      {
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: { connectById: [{ id: 1 }], deleteById: [{ id: 2 }] }
          } }) { parent { id childrenByParentId { nodes { id name } } } }
        }`,
      },
    ],
  },
  {
    name: '@omit delete on the foreign key',
    setup: `${base}
      comment on constraint child_parent_fkey on p.child is E'@omit delete';`,
    operations: [{ source: createParentWithChildren('childrenUsingId') }],
  },
  {
    name: '@omit update on the foreign key (V4 keeps nested updateBy)',
    setup: `${base}
      comment on constraint child_parent_fkey on p.child is E'@omit update';`,
    operations: [
      {
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: { updateById: [{ id: 1, childPatch: { name: "c1!" } }] }
          } }) { parent { id childrenByParentId { nodes { id name } } } }
        }`,
      },
    ],
  },
  {
    name: '@omit update,delete on the foreign table',
    setup: `${base}
      comment on table p.child is E'@omit update,delete';`,
    operations: [{ source: createParentWithChildren('childrenUsingId') }],
  },
  {
    name: '@omit create on the foreign key column',
    setup: `${base}
      comment on column p.child.parent_id is E'@omit create';`,
    operations: [],
  },
  {
    name: '@omit read on the foreign key column',
    setup: `${base}
      comment on column p.child.parent_id is E'@omit read,create,update,delete,all,many';`,
    operations: [],
  },
  {
    name: '@omit on a unique constraint removes its connect/delete/update fields',
    setup: `${base}
      alter table p.child add constraint child_name_key unique (name);
      comment on constraint child_name_key on p.child is E'@omit';`,
    operations: [],
  },
  {
    name: 'unique constraint adds connectBy/deleteBy/updateBy fields',
    setup: `${base}
      alter table p.child add constraint child_name_key unique (name);`,
    operations: [
      {
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: {
              updateByName: [{ name: "c1", childPatch: { name: "c1 renamed" } }]
              deleteByName: [{ name: "c2" }]
            }
          } }) { parent { id childrenByParentId { nodes { id name } } } }
        }`,
      },
    ],
  },
  {
    name: '@name, @fieldName and @foreignFieldName on the constraint',
    setup: `${base}
      comment on constraint child_parent_fkey on p.child is
        E'@name kinship\\n@fieldName mum\\n@foreignFieldName kids';`,
    operations: [
      {
        source: `mutation {
          createParent(input: { parent: {
            name: "p2"
            kids: { create: [{ name: "c3" }] }
          } }) { parent { id name kids { nodes { id name } } } }
        }`,
      },
      {
        source: `mutation {
          createChild(input: { child: {
            name: "c4"
            mum: { connectById: { id: 1 } }
          } }) { child { id name mum { id name } } }
        }`,
      },
    ],
  },
  {
    name: '@forwardMutationName and @reverseMutationName',
    setup: `${base}
      comment on constraint child_parent_fkey on p.child is
        E'@forwardMutationName theParent\\n@reverseMutationName theChildren';`,
    operations: [
      {
        source: `mutation {
          createParent(input: { parent: {
            name: "p2"
            theChildren: { create: [{ name: "c3" }] }
          } }) { parent { id childrenByParentId { nodes { id name } } } }
        }`,
      },
    ],
  },
  {
    name: 'table and column renames with @name',
    setup: `${base}
      comment on table p.child is E'@name kid';
      comment on column p.child.parent_id is E'@name guardian_id';`,
    operations: [
      {
        source: `mutation {
          createParent(input: { parent: {
            name: "p2"
            kidsUsingId: { create: [{ name: "c3" }] }
          } }) { parent { id kidsByGuardianId { nodes { id name guardianId } } } }
        }`,
      },
    ],
  },
  {
    name: 'nestedMutationsDeleteOthers disabled and old unique field names',
    setup: `${base}
      delete from p.child where id = 2;
      alter table p.child add constraint child_parent_id_key unique (parent_id);`,
    options: {
      graphileBuildOptions: {
        nestedMutationsDeleteOthers: false,
        nestedMutationsOldUniqueFields: true,
      },
    },
    operations: [],
  },
];
