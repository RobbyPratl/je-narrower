import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView';
import { buildTree, monacoOptions } from './viewer';

describe('source viewer', () => {
  it('builds a project-only tree with README available at the root', () => {
    const [root] = buildTree([
      { path: 'README.md', language: 'markdown', size: 10 },
      { path: 'engine/src/server.ts', language: 'typescript', size: 20 },
    ]);
    expect(root).toMatchObject({ id: 'je-narrower', name: 'je-narrower' });
    expect(root?.children?.some((item) => item.path === 'README.md')).toBe(true);
  });

  it('locks Monaco into a read-only code-viewing configuration', () => {
    expect(monacoOptions).toMatchObject({
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      lineNumbers: 'on',
      folding: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
  });

  it('renders GFM Markdown and sanitizes embedded HTML', () => {
    const html = renderToStaticMarkup(
      <MarkdownView content={'# README\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>'} />,
    );
    expect(html).toContain('<h1>README</h1>');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script>');
  });
});
