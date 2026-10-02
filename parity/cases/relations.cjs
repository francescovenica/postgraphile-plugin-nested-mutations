/*
 * Edge-case fixtures run against both V4 (__tests__/parity/cases.test.js,
 * which records parity/golden/cases-*.json) and V5 (v5/test/parity.test.ts,
 * which replays and compares).
 *
 * Case shape: { name, setup, options?, operations: [{ source,
 * variableValues?, pgSettings?, expect?: { errors?: boolean,
 * dbUnchanged?: boolean } }] }
 */
const nodeId = (...parts) =>
  Buffer.from(JSON.stringify(parts)).toString('base64');

const compositeSetup = `
  create table p.org (
    org_id int,
    code text,
    name text not null,
    primary key (org_id, code)
  );
  create table p.member (
    id serial primary key,
    org_id int,
    org_code text,
    name text not null,
    constraint member_org_fkey foreign key (org_id, org_code)
      references p.org (org_id, code)
  );
  insert into p.org values (1, 'a', 'Org A'), (1, 'b', 'Org B');
  insert into p.member (org_id, org_code, name) values
    (1, 'a', 'm1'), (1, 'a', 'm2'), (1, 'b', 'm3'), (null, null, 'loner');
`;

const orgSelection = `
  org {
    orgId
    code
    name
    membersByOrgIdAndOrgCode { nodes { id orgId orgCode name } }
  }
`;
const memberSelection = `
  member {
    id
    orgId
    orgCode
    name
    orgByOrgIdAndOrgCode { orgId code name }
  }
`;

const oneToOneSetup = `
  create table p.account (
    id serial primary key,
    email text not null unique
  );
  create table p.profile (
    id serial primary key,
    account_id int not null unique,
    bio text,
    constraint profile_account_fkey foreign key (account_id)
      references p.account (id)
  );
  insert into p.account (email) values ('one@example.com'), ('two@example.com');
  insert into p.profile (account_id, bio) values (1, 'first');
`;
const accountSelection = `
  account { id email profileByAccountId { id accountId bio } }
`;

const selfRefSetup = `
  create table p.category (
    id serial primary key,
    parent_id int,
    name text not null,
    constraint category_parent_fkey foreign key (parent_id)
      references p.category (id)
  );
  insert into p.category (parent_id, name) values (null, 'root'), (1, 'leaf');
`;
const categorySelection = `
  category {
    id
    name
    categoryByParentId { id name categoryByParentId { id name } }
    categoriesByParentId { nodes { id name } }
  }
`;

const multiFkSetup = `
  create table p.person (
    id serial primary key,
    name text not null
  );
  create table p.message (
    id serial primary key,
    sender_id int not null,
    recipient_id int,
    body text,
    constraint message_sender_fkey foreign key (sender_id)
      references p.person (id),
    constraint message_recipient_fkey foreign key (recipient_id)
      references p.person (id)
  );
  insert into p.person (name) values ('alice'), ('bob');
  insert into p.message (sender_id, recipient_id, body) values (1, 2, 'hi bob');
`;
const messageSelection = `
  message {
    id
    body
    personBySenderId { id name }
    personByRecipientId { id name }
  }
`;
const personSelection = `
  person {
    id
    name
    messagesBySenderId { nodes { id body recipientId } }
    messagesByRecipientId { nodes { id body senderId } }
  }
`;

module.exports = [
  {
    name: 'composite keys: reverse create, connect and deleteOthers',
    setup: compositeSetup,
    operations: [
      {
        source: `mutation {
          createOrg(input: { org: {
            orgId: 2, code: "x", name: "Org X"
            membersUsingOrgIdAndCode: {
              create: [{ name: "x1" }, { name: "x2" }]
              connectById: [{ id: 4 }]
            }
          } }) { ${orgSelection} }
        }`,
      },
      {
        source: `mutation {
          updateOrgByOrgIdAndCode(input: {
            orgId: 1, code: "a"
            orgPatch: {
              name: "Org A2"
              membersUsingOrgIdAndCode: {
                updateById: [{ id: 1, memberPatch: { name: "m1 renamed" } }]
                deleteOthers: true
              }
            }
          }) { ${orgSelection} }
        }`,
      },
    ],
  },
  {
    name: 'composite keys: forward create, connect, connectByNodeId and updateBy',
    setup: compositeSetup,
    operations: [
      {
        source: `mutation {
          createMember(input: { member: {
            name: "new"
            orgToOrgIdAndOrgCode: { create: { orgId: 3, code: "c", name: "Org C" } }
          } }) { ${memberSelection} }
        }`,
      },
      {
        source: `mutation {
          createMember(input: { member: {
            name: "joins b"
            orgToOrgIdAndOrgCode: { connectByOrgIdAndCode: { orgId: 1, code: "b" } }
          } }) { ${memberSelection} }
        }`,
      },
      {
        source: `mutation {
          createMember(input: { member: {
            name: "joins b by node"
            orgToOrgIdAndOrgCode: { connectByNodeId: { nodeId: "${nodeId(
              'orgs',
              1,
              'b',
            )}" } }
          } }) { ${memberSelection} }
        }`,
      },
      {
        source: `mutation {
          updateMemberById(input: {
            id: 4
            memberPatch: {
              orgToOrgIdAndOrgCode: {
                updateByOrgIdAndCode: { orgId: 1, code: "a", orgPatch: { name: "Org A via member" } }
              }
            }
          }) { ${memberSelection} }
        }`,
      },
      {
        source: `mutation {
          createMember(input: { member: {
            name: "nowhere"
            orgToOrgIdAndOrgCode: { connectByOrgIdAndCode: { orgId: 9, code: "z" } }
          } }) { ${memberSelection} }
        }`,
        expect: { errors: true, dbUnchanged: true },
      },
    ],
  },
  {
    name: 'one-to-one: singular reverse field',
    setup: oneToOneSetup,
    operations: [
      {
        source: `mutation {
          createAccount(input: { account: {
            email: "three@example.com"
            profileUsingId: { create: [{ bio: "third" }] }
          } }) { ${accountSelection} }
        }`,
      },
      {
        source: `mutation {
          updateAccountById(input: {
            id: 1
            accountPatch: {
              profileUsingId: {
                updateByAccountId: { accountId: 1, profilePatch: { bio: "first, edited" } }
              }
            }
          }) { ${accountSelection} }
        }`,
      },
      {
        source: `mutation {
          updateAccountById(input: {
            id: 2
            accountPatch: { profileUsingId: { connectById: { id: 1 } } }
          }) { ${accountSelection} }
        }`,
      },
      {
        source: `mutation {
          createAccount(input: { account: {
            email: "four@example.com"
            profileUsingId: { create: [{ bio: "x" }], connectById: { id: 1 } }
          } }) { ${accountSelection} }
        }`,
        expect: { errors: true, dbUnchanged: true },
      },
      {
        source: `mutation {
          createProfile(input: { profile: {
            bio: "with new account"
            accountToAccountId: { create: { email: "five@example.com" } }
          } }) { profile { id bio accountByAccountId { id email } } }
        }`,
      },
    ],
  },
  {
    name: 'self-referencing foreign key',
    setup: selfRefSetup,
    operations: [
      {
        source: `mutation {
          createCategory(input: { category: {
            name: "grandchild"
            categoryToParentId: {
              create: {
                name: "child"
                categoryToParentId: { create: { name: "new root" } }
              }
            }
          } }) { ${categorySelection} }
        }`,
      },
      {
        source: `mutation {
          updateCategoryById(input: {
            id: 2
            categoryPatch: {
              name: "leaf moved"
              categoryToParentId: {
                updateById: { id: 1, categoryPatch: { name: "root renamed" } }
              }
            }
          }) { ${categorySelection} }
        }`,
      },
      {
        source: `mutation {
          updateCategoryById(input: {
            id: 1
            categoryPatch: { categoryToParentId: { connectById: { id: 3 } } }
          }) { ${categorySelection} }
        }`,
      },
    ],
  },
  {
    name: 'multiple foreign keys to the same table',
    setup: multiFkSetup,
    operations: [
      {
        source: `mutation {
          createMessage(input: { message: {
            body: "hello"
            personToSenderId: { create: { name: "carol" } }
            personToRecipientId: { connectById: { id: 1 } }
          } }) { ${messageSelection} }
        }`,
      },
      {
        source: `mutation {
          createPerson(input: { person: {
            name: "dave"
            messagesToSenderIdUsingId: { create: [{ body: "from dave" }] }
            messagesToRecipientIdUsingId: { connectById: [{ id: 1 }] }
          } }) { ${personSelection} }
        }`,
      },
      {
        source: `mutation {
          updatePersonById(input: {
            id: 1
            personPatch: {
              messagesToSenderIdUsingId: {
                updateById: [{ id: 1, messagePatch: { body: "edited" } }]
              }
            }
          }) { ${personSelection} }
        }`,
      },
    ],
  },
  {
    name: 'multiple foreign keys to the same table with simple field names',
    setup: multiFkSetup,
    options: {
      graphileBuildOptions: { nestedMutationsSimpleFieldNames: true },
    },
    operations: [
      {
        source: `mutation {
          createPerson(input: { person: {
            name: "erin"
            messagesToSenderIdUsingId: { create: [{ body: "from erin" }] }
          } }) { ${personSelection} }
        }`,
      },
    ],
  },
  {
    name: 'nestedMutationsList limits the nested fields',
    setup: multiFkSetup,
    options: {
      graphileBuildOptions: {
        nestedMutationsList: {
          MessageInput: ['personToSenderId'],
          PersonInput: ['messagesToRecipientIdUsingId'],
        },
      },
    },
    operations: [
      {
        source: `mutation {
          createMessage(input: { message: {
            body: "listed"
            personToSenderId: { create: { name: "frank" } }
          } }) { ${messageSelection} }
        }`,
      },
    ],
  },
  {
    name: 'nested input passed through variables',
    setup: compositeSetup,
    operations: [
      {
        source: `mutation ($input: CreateOrgInput!) {
          createOrg(input: $input) { ${orgSelection} }
        }`,
        variableValues: {
          input: {
            org: {
              orgId: 5,
              code: 'v',
              name: 'Org V',
              membersUsingOrgIdAndCode: {
                create: [{ name: 'v1' }, { name: 'v2' }, { name: 'v3' }],
                connectById: [{ id: 4 }],
              },
            },
          },
        },
      },
      {
        source: `mutation ($id: Int!, $patch: MemberPatch!) {
          updateMemberById(input: { id: $id, memberPatch: $patch }) { ${memberSelection} }
        }`,
        variableValues: {
          id: 4,
          patch: {
            name: 'loner joins',
            orgToOrgIdAndOrgCode: {
              connectByOrgIdAndCode: { orgId: 1, code: 'a' },
            },
          },
        },
      },
      {
        source: `mutation ($members: [MemberOrgFkeyMemberCreateInput!]) {
          createOrg(input: { org: {
            orgId: 6, code: "w", name: "Org W"
            membersUsingOrgIdAndCode: { create: $members }
          } }) { ${orgSelection} }
        }`,
        variableValues: { members: [] },
      },
    ],
  },
  {
    name: 'deleteBy on a forward relation (V4 links the row, it does not delete it)',
    setup: compositeSetup,
    operations: [
      {
        source: `mutation {
          createMember(input: { member: {
            name: "deleter"
            orgToOrgIdAndOrgCode: { deleteByOrgIdAndCode: { orgId: 1, code: "b" } }
          } }) { ${memberSelection} }
        }`,
      },
      {
        source: `mutation {
          createMember(input: { member: {
            name: "deleter"
            orgToOrgIdAndOrgCode: { deleteByOrgIdAndCode: { orgId: 7, code: "nope" } }
          } }) { ${memberSelection} }
        }`,
        expect: { errors: true, dbUnchanged: true },
      },
    ],
  },
];
