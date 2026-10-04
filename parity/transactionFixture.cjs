/*
 * Used by the transaction tests. Unlike the parity cases these
 * run against committed data through a real pool (as a server would), so
 * every statement can be traced back to the backend that ran it.
 */
const fixtureSql = (schema) => `
  do $$ begin
    create role nested_rls_user nologin;
  exception when duplicate_object then null;
  end $$;
  drop schema if exists ${schema} cascade;
  create schema ${schema};
  grant usage on schema ${schema} to nested_rls_user;

  create table ${schema}.parent (
    id serial primary key,
    owner_id int not null default current_setting('jwt.claims.user_id', true)::int,
    name text not null check (name <> 'bad')
  );
  create table ${schema}.child (
    id serial primary key,
    parent_id int,
    owner_id int not null default current_setting('jwt.claims.user_id', true)::int,
    name text not null check (name <> 'bad'),
    constraint child_parent_fkey foreign key (parent_id) references ${schema}.parent (id)
  );
  create table ${schema}.grandchild (
    id serial primary key,
    child_id int,
    owner_id int not null default current_setting('jwt.claims.user_id', true)::int,
    name text not null check (name <> 'bad'),
    constraint grandchild_child_fkey foreign key (child_id) references ${schema}.child (id)
  );
  grant select, insert, update, delete on all tables in schema ${schema} to nested_rls_user;
  grant usage on all sequences in schema ${schema} to nested_rls_user;
  alter table ${schema}.parent enable row level security;
  alter table ${schema}.child enable row level security;
  alter table ${schema}.grandchild enable row level security;
  create policy own on ${schema}.parent
    using (owner_id = current_setting('jwt.claims.user_id', true)::int)
    with check (owner_id = current_setting('jwt.claims.user_id', true)::int);
  create policy own on ${schema}.child
    using (owner_id = current_setting('jwt.claims.user_id', true)::int)
    with check (owner_id = current_setting('jwt.claims.user_id', true)::int);
  create policy own on ${schema}.grandchild
    using (owner_id = current_setting('jwt.claims.user_id', true)::int)
    with check (owner_id = current_setting('jwt.claims.user_id', true)::int);
  insert into ${schema}.parent (owner_id, name) values (1, 'mine'), (2, 'theirs');
`;

const pgSettings = { role: 'nested_rls_user', 'jwt.claims.user_id': '1' };

const tree = `parent {
  id name
  childrenByParentId { nodes { id name grandchildrenByChildId { nodes { id name } } } }
}`;

const createTree = (grandchild, alias = 'createParent') => `
  ${alias}: createParent(input: { parent: {
    name: "${alias}"
    childrenUsingId: { create: [{
      name: "c"
      grandchildrenUsingId: { create: [{ name: "${grandchild}" }] }
    }] }
  } }) { ${tree} }`;

const operations = {
  success: `mutation { ${createTree('g')} }`,
  // fails on the last statement of the tree
  deepFailure: `mutation { ${createTree('bad')} }`,
  // RLS: the grandchild belongs to someone else
  deepRlsDenial: `mutation {
    createParent(input: { parent: {
      name: "p"
      childrenUsingId: { create: [{
        name: "c"
        grandchildrenUsingId: { create: [{ name: "g", ownerId: 2 }] }
      }] }
    } }) { ${tree} }
  }`,
  multipleRootFields: `mutation {
    ${createTree('g', 'first')}
    ${createTree('bad', 'second')}
  }`,
};

/** Records every statement sent by clients of `pool` with the backend PID. */
function captureStatements(pool) {
  const log = [];
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    // eslint-disable-next-line no-param-reassign
    client.query = (config, ...rest) => {
      const text = typeof config === 'string' ? config : config && config.text;
      log.push({ pid: client.processID, text: String(text).trim() });
      return query(config, ...rest);
    };
  });
  return log;
}

const isWrite = (text) => /^\s*(insert|update|delete)\b/i.test(text);
const isBegin = (text) => /^begin\b/i.test(text);
const isEnd = (text) => /^(commit|rollback)\s*;?$/i.test(text);

/**
 * Finds the BEGIN..COMMIT/ROLLBACK block (on one backend) containing the
 * writes of the request, and asserts every write, plus the pgSettings, is
 * inside it.
 */
function transactionOf(log) {
  const writes = log.filter((e) => isWrite(e.text));
  if (!writes.length) throw new Error('no writes captured');
  const { pid } = writes[0];
  const onBackend = log.filter((e) => e.pid === pid);
  const firstWrite = onBackend.indexOf(writes[0]);
  let begin = firstWrite;
  while (begin >= 0 && !isBegin(onBackend[begin].text)) begin -= 1;
  let end = firstWrite;
  while (end < onBackend.length && !isEnd(onBackend[end].text)) end += 1;
  return {
    pid,
    allWritesOnOneBackend: writes.every((w) => w.pid === pid),
    statements: onBackend.slice(begin, end + 1),
    writesInside: writes.every((w) => {
      const idx = onBackend.indexOf(w);
      return idx > begin && idx < end;
    }),
  };
}

module.exports = {
  fixtureSql,
  pgSettings,
  operations,
  captureStatements,
  transactionOf,
  isWrite,
};
