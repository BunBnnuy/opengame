/** Explicit copy metadata; never infer it from a channel or the last copy. */
export const templateEntries = ['website', 'editor'] as const;
export type TemplateEntry = typeof templateEntries[number];
export const copyAttemptPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
