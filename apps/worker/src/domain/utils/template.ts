/**
 * Template variable interpolation utility
 *
 * Replaces {{variableName}} patterns in text with values from a variables object.
 * Unmatched variables are left unchanged.
 */
export function interpolateVariables(
  text: string,
  variables?: Record<string, string>
): string {
  if (!variables || !text) return text;

  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}
