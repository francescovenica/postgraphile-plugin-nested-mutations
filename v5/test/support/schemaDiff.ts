import {
  buildSchema,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
} from "postgraphile/graphql";

type AnyField = GraphQLField<any, any> | GraphQLInputField;

function fieldSignature(field: AnyField) {
  return {
    type: String(field.type),
    description: field.description ?? null,
    ...("defaultValue" in field && field.defaultValue !== undefined
      ? { defaultValue: JSON.stringify(field.defaultValue) }
      : null),
    ...("args" in field && field.args.length
      ? {
          args: field.args.map((a) => ({
            name: a.name,
            type: String(a.type),
            description: a.description ?? null,
          })),
        }
      : null),
    ...(field.deprecationReason
      ? { deprecationReason: field.deprecationReason }
      : null),
  };
}

function fieldsOf(type: GraphQLNamedType): Record<string, AnyField> | null {
  if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
    return type.getFields() as Record<string, AnyField>;
  }
  return null;
}

function typeSignature(type: GraphQLNamedType) {
  const fields = fieldsOf(type);
  return {
    kind: type.constructor.name,
    description: type.description ?? null,
    ...(fields
      ? {
          fields: Object.fromEntries(
            Object.entries(fields)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([n, f]) => [n, fieldSignature(f)]),
          ),
        }
      : null),
    ...(isEnumType(type)
      ? { values: type.getValues().map((v) => v.name) }
      : null),
    ...(isUnionType(type)
      ? { types: type.getTypes().map((t) => t.name) }
      : null),
  };
}

const userTypes = (schema: GraphQLSchema) =>
  Object.values(schema.getTypeMap()).filter((t) => !t.name.startsWith("__"));

export interface PluginDelta {
  addedTypes: Record<string, ReturnType<typeof typeSignature>>;
  removedTypes: string[];
  changedTypes: Record<
    string,
    {
      addedFields: Record<string, ReturnType<typeof fieldSignature>>;
      removedFields: string[];
      changedFields: Record<
        string,
        {
          before: ReturnType<typeof fieldSignature>;
          after: ReturnType<typeof fieldSignature>;
        }
      >;
    }
  >;
}

/** What the plugin adds/changes on top of the base schema. */
export function pluginDelta(baseSDL: string, pluginSDL: string): PluginDelta {
  const base = buildSchema(baseSDL);
  const plugin = buildSchema(pluginSDL);
  const delta: PluginDelta = {
    addedTypes: {},
    removedTypes: [],
    changedTypes: {},
  };
  for (const type of userTypes(plugin)) {
    const before = base.getType(type.name);
    if (!before) {
      delta.addedTypes[type.name] = typeSignature(type);
      continue;
    }
    const beforeFields = fieldsOf(before);
    const afterFields = fieldsOf(type);
    if (!beforeFields || !afterFields) continue;
    const change: PluginDelta["changedTypes"][string] = {
      addedFields: {},
      removedFields: [],
      changedFields: {},
    };
    for (const [name, field] of Object.entries(afterFields)) {
      const prev = beforeFields[name];
      if (!prev) {
        change.addedFields[name] = fieldSignature(field);
      } else {
        const a = fieldSignature(prev);
        const b = fieldSignature(field);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          change.changedFields[name] = { before: a, after: b };
        }
      }
    }
    for (const name of Object.keys(beforeFields)) {
      if (!afterFields[name]) change.removedFields.push(name);
    }
    if (
      Object.keys(change.addedFields).length ||
      change.removedFields.length ||
      Object.keys(change.changedFields).length
    ) {
      delta.changedTypes[type.name] = change;
    }
  }
  for (const type of userTypes(base)) {
    if (!plugin.getType(type.name)) delta.removedTypes.push(type.name);
  }
  delta.removedTypes.sort();
  for (const change of Object.values(delta.changedTypes)) {
    change.removedFields.sort();
  }
  return delta;
}

/**
 * Field order (from an unsorted SDL print) for the types the plugin added,
 * and the relative order of the fields it added to existing types.
 */
export function pluginFieldOrder(delta: PluginDelta, unsortedSDL: string) {
  const schema = buildSchema(unsortedSDL);
  const order: Record<string, string[]> = {};
  for (const name of Object.keys(delta.addedTypes).sort()) {
    const fields = fieldsOf(schema.getType(name)!);
    if (fields) order[name] = Object.keys(fields);
  }
  for (const [name, change] of Object.entries(delta.changedTypes)) {
    const fields = fieldsOf(schema.getType(name)!);
    if (!fields) continue;
    const added = new Set(Object.keys(change.addedFields));
    order[name] = Object.keys(fields).filter((f) => added.has(f));
  }
  return order;
}

/** Is a graphql-inspector change path about something the plugin touches? */
export function touchesPlugin(delta: PluginDelta, path: string | undefined) {
  if (!path) return false;
  const [typeName, fieldName] = path.split(".");
  if (delta.addedTypes[typeName]) return true;
  const changed = delta.changedTypes[typeName];
  if (changed && fieldName) {
    return (
      fieldName in changed.addedFields ||
      fieldName in changed.changedFields ||
      changed.removedFields.includes(fieldName)
    );
  }
  return false;
}

/**
 * Core (non-plugin) types whose names changed between V4 and V5, paired by
 * case-insensitive name (e.g. V4 `AbInput` vs V5 `ABInput` for table `a_b`).
 */
export function coreTypeRenames(v4BaseSDL: string, v5BaseSDL: string) {
  const v4 = new Set(userTypes(buildSchema(v4BaseSDL)).map((t) => t.name));
  const v5 = new Set(userTypes(buildSchema(v5BaseSDL)).map((t) => t.name));
  const v5OnlyByLower = new Map(
    [...v5].filter((n) => !v4.has(n)).map((n) => [n.toLowerCase(), n]),
  );
  const renames = new Map<string, string>();
  for (const name of v4) {
    if (v5.has(name)) continue;
    const match = v5OnlyByLower.get(name.toLowerCase());
    if (match) renames.set(name, match);
  }
  return renames;
}

/** Applies core type renames to a delta computed from V4 schemas. */
export function renameCoreTypes(
  delta: PluginDelta,
  renames: Map<string, string>,
): PluginDelta {
  if (!renames.size) return delta;
  const pattern = new RegExp(
    `\\b(${[...renames.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "g",
  );
  const json = JSON.stringify(delta, (key, value) => value);
  const renamed = json.replace(pattern, (m) => renames.get(m) ?? m);
  return JSON.parse(renamed);
}
