/*
 * Atomicity: a failure anywhere in a nested mutation tree must leave the
 * database untouched, and results must match V4 (see relations.cjs).
 */
const nodeId = (...parts) =>
  Buffer.from(JSON.stringify(parts)).toString('base64');

const threeLevels = `
  create table p.parent (
    id serial primary key,
    name text not null check (name <> 'bad')
  );
  create table p.child (
    id serial primary key,
    parent_id integer,
    name text not null unique check (name <> 'bad'),
    constraint child_parent_fkey foreign key (parent_id)
      references p.parent (id)
  );
  create table p.grandchild (
    id serial primary key,
    child_id integer,
    name text not null check (name <> 'bad'),
    constraint grandchild_child_fkey foreign key (child_id)
      references p.child (id)
  );
  insert into p.parent (name) values ('existing parent');
  insert into p.child (parent_id, name) values (1, 'existing child 1'), (1, 'existing child 2');
  insert into p.grandchild (child_id, name) values (1, 'existing grandchild');
`;

const tree = `parent {
  id name
  childrenByParentId { nodes { id name grandchildrenByChildId { nodes { id name } } } }
}`;

const createTree = ({ parent = 'p', child = 'c', grandchild = 'g', extra = '' }) => `
  mutation {
    createParent(input: { parent: {
      name: "${parent}"
      childrenUsingId: { create: [{
        name: "${child}"
        grandchildrenUsingId: { create: [{ name: "${grandchild}" }] ${extra} }
      }] }
    } }) { ${tree} }
  }`;

const fails = { errors: true, dbUnchanged: true };

module.exports = [
  {
    name: 'failure at each level of a 3-level nested create rolls everything back',
    setup: threeLevels,
    operations: [
      // first operation (forward create runs before anything else)
      {
        source: `mutation {
          createGrandchild(input: { grandchild: {
            name: "g"
            childToChildId: { create: {
              name: "c"
              parentToParentId: { create: { name: "bad" } }
            } }
          } }) { grandchild { id } }
        }`,
        expect: fails,
      },
      // root row
      { source: createTree({ parent: 'bad' }), expect: fails },
      // middle
      { source: createTree({ child: 'bad' }), expect: fails },
      // last
      { source: createTree({ grandchild: 'bad' }), expect: fails },
      // success, to prove the same tree works
      { source: createTree({}) },
    ],
  },
  {
    name: 'constraint violation mid-tree rolls back earlier siblings',
    setup: threeLevels,
    operations: [
      {
        source: `mutation {
          createParent(input: { parent: {
            name: "p"
            childrenUsingId: { create: [
              { name: "dup", grandchildrenUsingId: { create: [{ name: "g1" }] } },
              { name: "dup" }
            ] }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
    ],
  },
  {
    name: 'invalid nodeId and missing rows deep in the tree roll back',
    setup: threeLevels,
    operations: [
      {
        source: createTree({
          extra: `connectByNodeId: [{ nodeId: "W10=" }]`,
        }),
        expect: fails,
      },
      {
        source: createTree({
          extra: `connectByNodeId: [{ nodeId: "${nodeId('parents', 1)}" }]`,
        }),
        expect: fails,
      },
      {
        source: createTree({ extra: `connectById: [{ id: 999 }]` }),
        expect: fails,
      },
      {
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            name: "renamed"
            childrenUsingId: {
              updateById: [{ id: 1, childPatch: {
                name: "renamed child"
                grandchildrenUsingId: { updateById: [{ id: 999, grandchildPatch: { name: "x" } }] }
              } }]
            }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
      {
        source: `mutation {
          createChild(input: { child: {
            name: "orphan"
            parentToParentId: { connectById: { id: 999 } }
          } }) { child { id } }
        }`,
        expect: fails,
      },
    ],
  },
  {
    name: 'deleteOthers is rolled back when a later operation fails',
    setup: threeLevels,
    operations: [
      {
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: {
              deleteOthers: true
              create: [{ name: "bad" }]
            }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
      {
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: {
              updateById: [{ id: 1, childPatch: { name: "kept" } }]
              deleteOthers: true
              create: [{ name: "fresh" }]
            }
          } }) { ${tree} }
        }`,
      },
    ],
  },
  {
    name: 'multiple root mutation fields where the second one fails',
    setup: threeLevels,
    operations: [
      {
        source: `mutation {
          first: createParent(input: { parent: {
            name: "first"
            childrenUsingId: { create: [{ name: "first child" }] }
          } }) { ${tree} }
          second: createParent(input: { parent: {
            name: "second"
            childrenUsingId: { create: [{ name: "bad" }] }
          } }) { ${tree} }
        }`,
        expect: { errors: true },
      },
    ],
  },
];
