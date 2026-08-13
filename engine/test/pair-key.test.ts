import { describe, expect, it } from 'vitest';
import { pairKey } from '../src/pair-key.js';

describe('pairKey', () => {
  it('sorts lexically', () => {
    expect(pairKey('b', 'a')).toEqual(['a', 'b']);
    expect(pairKey('a', 'b')).toEqual(['a', 'b']);
  });
});
