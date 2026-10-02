export interface NestedMutationsOptions {
  nestedMutationsSimpleFieldNames: boolean;
  nestedMutationsDeleteOthers: boolean;
  nestedMutationsOldUniqueFields: boolean;
  nestedMutationsList: Record<string, ReadonlyArray<string>> | undefined;
}

/** Same defaults as V4's `graphileBuildOptions`. */
export function resolveOptions(
  schemaOptions: GraphileBuild.SchemaOptions | undefined,
): NestedMutationsOptions {
  const {
    nestedMutationsSimpleFieldNames = false,
    nestedMutationsDeleteOthers = true,
    nestedMutationsOldUniqueFields = false,
    nestedMutationsList,
  } = schemaOptions ?? {};
  return {
    nestedMutationsSimpleFieldNames,
    nestedMutationsDeleteOthers,
    nestedMutationsOldUniqueFields,
    nestedMutationsList,
  };
}
