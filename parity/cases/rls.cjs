/*
 * Row level security: every nested statement must run with the request's
 * role and JWT claims (pgSettings), and a denial anywhere rolls back the
 * whole mutation (see relations.cjs for the case format).
 */
const setup = `
  do $$ begin
    create role nested_rls_user nologin;
  exception when duplicate_object then null;
  end $$;
  grant usage on schema p to nested_rls_user;

  create table p.parent (
    id serial primary key,
    owner_id int not null default current_setting('jwt.claims.user_id', true)::int,
    name text not null
  );
  create table p.child (
    id serial primary key,
    parent_id int,
    owner_id int not null default current_setting('jwt.claims.user_id', true)::int,
    name text not null,
    constraint child_parent_fkey foreign key (parent_id) references p.parent (id)
  );
  create table p.grandchild (
    id serial primary key,
    child_id int,
    owner_id int not null default current_setting('jwt.claims.user_id', true)::int,
    name text not null,
    constraint grandchild_child_fkey foreign key (child_id) references p.child (id)
  );
  grant select, insert, update, delete on all tables in schema p to nested_rls_user;
  grant usage on all sequences in schema p to nested_rls_user;

  alter table p.parent enable row level security;
  alter table p.child enable row level security;
  alter table p.grandchild enable row level security;
  create policy own on p.parent
    using (owner_id = current_setting('jwt.claims.user_id', true)::int)
    with check (owner_id = current_setting('jwt.claims.user_id', true)::int);
  create policy own on p.child
    using (owner_id = current_setting('jwt.claims.user_id', true)::int)
    with check (owner_id = current_setting('jwt.claims.user_id', true)::int);
  create policy own on p.grandchild
    using (owner_id = current_setting('jwt.claims.user_id', true)::int)
    with check (owner_id = current_setting('jwt.claims.user_id', true)::int);

  insert into p.parent (owner_id, name) values (1, 'mine'), (2, 'theirs');
  insert into p.child (parent_id, owner_id, name) values (1, 1, 'my child'), (2, 2, 'their child');
  insert into p.grandchild (child_id, owner_id, name) values (1, 1, 'my grandchild'), (2, 2, 'their grandchild');
`;

const user1 = { role: 'nested_rls_user', 'jwt.claims.user_id': '1' };
const fails = { errors: true, dbUnchanged: true };
const tree = `parent {
  id ownerId name
  childrenByParentId { nodes { id ownerId name grandchildrenByChildId { nodes { id ownerId name } } } }
}`;

module.exports = [
  {
    name: 'RLS: allowed nested writes succeed with the request role',
    setup,
    operations: [
      {
        pgSettings: user1,
        source: `mutation {
          createParent(input: { parent: {
            name: "new"
            childrenUsingId: { create: [{
              name: "new child"
              grandchildrenUsingId: { create: [{ name: "new grandchild" }] }
            }] }
          } }) { ${tree} }
        }`,
      },
      {
        pgSettings: user1,
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: { updateById: [{ id: 1, childPatch: { name: "renamed" } }] }
          } }) { ${tree} }
        }`,
      },
    ],
  },
  {
    name: 'RLS: denied nested writes roll back the whole mutation',
    setup,
    operations: [
      {
        // WITH CHECK violation on a nested insert
        pgSettings: user1,
        source: `mutation {
          createParent(input: { parent: {
            name: "new"
            childrenUsingId: { create: [{ name: "not mine", ownerId: 2 }] }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
      {
        // connecting a row the role cannot see
        pgSettings: user1,
        source: `mutation {
          createParent(input: { parent: {
            name: "new"
            childrenUsingId: { connectById: [{ id: 2 }] }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
      {
        // updating a row the role cannot see
        pgSettings: user1,
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            name: "renamed"
            childrenUsingId: { updateById: [{ id: 2, childPatch: { name: "stolen" } }] }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
      {
        // denial three levels down rolls back the parent
        pgSettings: user1,
        source: `mutation {
          createParent(input: { parent: {
            name: "new"
            childrenUsingId: { create: [{
              name: "new child"
              grandchildrenUsingId: { create: [{ name: "not mine", ownerId: 2 }] }
            }] }
          } }) { ${tree} }
        }`,
        expect: fails,
      },
      {
        // forward connect to an invisible parent
        pgSettings: user1,
        source: `mutation {
          createChild(input: { child: {
            name: "new child"
            parentToParentId: { connectById: { id: 2 } }
          } }) { child { id name parentId } }
        }`,
        expect: fails,
      },
      {
        // deleting an invisible row affects nothing (no error in V4)
        pgSettings: user1,
        source: `mutation {
          updateParentById(input: { id: 1, parentPatch: {
            childrenUsingId: { deleteById: [{ id: 2 }] }
          } }) { ${tree} }
        }`,
      },
      {
        // updating an invisible root row
        pgSettings: user1,
        source: `mutation {
          updateParentById(input: { id: 2, parentPatch: { name: "stolen" } }) { ${tree} }
        }`,
      },
    ],
  },
];
