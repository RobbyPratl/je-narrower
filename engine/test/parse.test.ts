import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGlFile } from '../src/ingest/parse.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('parseGlFile', () => {
  it('parses gl_p1.csv', async () => {
    const { rows } = await parseGlFile(path.join(repoRoot, 'data/exports/gl_p1.csv'));
    expect(rows).toHaveLength(2628);
    expect(rows[0]?.debit).toBeTypeOf('number');
  });
});
