/**
 * Makes a type-assertion function for a type {@link T}, using just a single {@link key}.
 */
export function guard<T>(key: keyof T) {
  return (a: any): a is T => typeof a?.[key] === "string";
}
