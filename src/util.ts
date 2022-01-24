import assert from "assert";

/**
 * Makes a type-assertion function for a type {@link T}, using just a single {@link key}.
 */
export function guard<T>(key: keyof T) {
  return (a: any): a is T => a?.[key] !== undefined;
}

/**
 * @param a first value
 * @param b second value
 * @returns `true` if {@link a} deepy equals {@link b}.
 */
export function isDeepEqual(a: any, b: any): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}
