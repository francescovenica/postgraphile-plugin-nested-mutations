/*
 * Deliberate V4 -> V5 differences of the plugin itself. The V5 parity suite
 * asserts that each case differs from V4 in exactly the listed way (and
 * matches everywhere else), so these stay verified rather than ignored.
 */
module.exports = [
  {
    file: 'cases-smartTags',
    case: '@omit update,delete on the foreign table',
    reason:
      'V4 still offered nested updateBy* on a table with `@omit update` (it built ' +
      'its own `ChildPatch`, and the update really ran). V5 respects the omit: ' +
      'without update permission on the foreign table there are no nested ' +
      'updateBy* fields.',
    schemaChanges: [
      "Type 'ChildOnChildForChildParentFkeyUsingChildPkeyUpdate' was removed",
      "Type 'updateChildOnChildForChildParentFkeyPatch' was removed",
      "Type 'ParentOnChildForChildParentFkeyNodeIdUpdate' was removed",
      "Type 'ChildPatch' was removed",
      "Input field 'updateById' was removed from input object type 'ChildParentFkeyInverseInput'",
      "Input field 'updateByNodeId' was removed from input object type 'ChildParentFkeyInverseInput'",
    ],
  },
  {
    file: 'cases-smartTags',
    case: '@omit update on the foreign key (V4 keeps nested updateBy)',
    reason:
      'V4 ignored a constraint-level `@omit update` for nested updateBy* fields. ' +
      'V5 no longer parses V4 `@omit` itself and leaves it to the V4 preset, which ' +
      'turns `@omit update` into a negative `update` behavior on the relation, so ' +
      'the nested updateBy* fields are not offered.',
    schemaChanges: [
      "Input field 'updateById' was removed from input object type 'ChildParentFkeyInput'",
      "Input field 'updateById' was removed from input object type 'ChildParentFkeyInverseInput'",
      "Input field 'updateByNodeId' was removed from input object type 'ChildParentFkeyInput'",
      "Input field 'updateByNodeId' was removed from input object type 'ChildParentFkeyInverseInput'",
      "Type 'ChildOnChildForChildParentFkeyNodeIdUpdate' was removed",
      "Type 'ChildOnChildForChildParentFkeyUsingChildPkeyUpdate' was removed",
      "Type 'ParentOnChildForChildParentFkeyNodeIdUpdate' was removed",
      "Type 'ParentOnChildForChildParentFkeyUsingParentPkeyUpdate' was removed",
      "Type 'updateChildOnChildForChildParentFkeyPatch' was removed",
      "Type 'updateParentOnChildForChildParentFkeyPatch' was removed",
    ],
    adjust: {
      fromOperation: 0,
      result() {
        return {
          data: null,
          errors: [
            {
              message:
                'Field "updateById" is not defined by type "ChildParentFkeyInverseInput". Did you mean "deleteById"?',
              path: null,
            },
          ],
        };
      },
      // The whole request is rejected, so the child row keeps its name.
      dbState(state) {
        state.child[0].name = 'c1';
        return state;
      },
    },
  },
  {
    file: 'cases-smartTags',
    case: '@omit read on the foreign key column',
    reason:
      'With the FK column omitted for read/create/update, V4 still exposed nested ' +
      'connect/delete on the relation and re-added the omitted column to ' +
      '`ChildInput`/`ChildPatch`; a reverse connect then wrote the omitted ' +
      'column. V5 (V4 preset) treats a constraint over an unreadable column as ' +
      'unreadable, so the relation gets no nested fields.',
    schemaChanges: [
      "Type 'ChildParentFkeyInput' was removed",
      "Type 'ParentParentPkeyConnect' was removed",
      "Type 'ParentNodeIdConnect' was removed",
      "Type 'ParentParentPkeyDelete' was removed",
      "Type 'ParentNodeIdDelete' was removed",
      "Type 'ChildParentFkeyInverseInput' was removed",
      "Type 'ChildChildPkeyConnect' was removed",
      "Type 'ChildNodeIdConnect' was removed",
      "Type 'ChildChildPkeyDelete' was removed",
      "Type 'ChildNodeIdDelete' was removed",
      "Input field 'parentId' was removed from input object type 'ChildInput'",
      "Input field 'parentToParentId' was removed from input object type 'ChildInput'",
      "Input field 'childrenUsingId' was removed from input object type 'ParentInput'",
      "Input field 'parentId' was removed from input object type 'ChildPatch'",
      "Input field 'parentToParentId' was removed from input object type 'ChildPatch'",
      "Input field 'childrenUsingId' was removed from input object type 'ParentPatch'",
    ],
  },
  {
    file: 'cases-transactions',
    case: 'invalid nodeId and missing rows deep in the tree roll back',
    operation: 3,
    reason:
      "V4 crashed with a TypeError (\"Cannot read properties of undefined (reading 'id')\") " +
      'in its secondary nested-update path when a deep updateById matched no row. ' +
      'V5 raises the intended "unmatched update". Both roll back everything; the ' +
      'database state is compared as usual.',
    errorMessages: ['unmatched update'],
  },
  {
    file: 'cases-relations',
    case: 'foreign key referencing a non-primary-key unique column',
    reason:
      'A forward `create` through an FK that references a non-primary-key ' +
      'unique column left the FK NULL in V4 (it read the new row\'s primary ' +
      'key columns only). V5 sets the referenced value. Expected V4 results ' +
      'and database states are adjusted by exactly that from this operation on.',
    adjust: {
      fromOperation: 0,
      result(result, operation) {
        if (operation !== 0) return result;
        const { player } = result.data.createPlayer;
        player.teamCode = 'blue';
        player.teamByTeamCode = { code: 'blue', name: 'Blue team' };
        return result;
      },
      dbState(state) {
        const p1 = state.player.find((row) => row.id === 1);
        p1.team_code = 'blue';
        return state;
      },
    },
  },
];

