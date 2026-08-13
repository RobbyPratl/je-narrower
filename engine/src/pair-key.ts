/** Canonical account pairing: lexical sort, always. */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
