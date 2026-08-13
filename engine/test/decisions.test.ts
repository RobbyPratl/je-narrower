import { describe, it, expect } from 'vitest';
import { CONCLUSIONS } from '../src/decisions/record.js';

describe('decisions', () => {
  it('defines allowed conclusions', () => {
    expect(CONCLUSIONS).toContain('appropriate-recurring');
    expect(CONCLUSIONS).toContain('requires-procedures');
    expect(CONCLUSIONS).toContain('set-aside');
    expect(CONCLUSIONS).toHaveLength(5);
  });
});
