import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Tree, type NodeRendererProps } from 'react-arborist';
import { MarkdownView } from './MarkdownView';
import { buildTree, monacoOptions, type ManifestEntry, type SourceFile, type TreeItem } from './viewer';

type Tab = 'demo' | 'source';
const Editor = lazy(() => import('@monaco-editor/react'));

export function App() {
  const [tab, setTab] = useState<Tab>(() => location.pathname === '/source' ? 'source' : 'demo');

  useEffect(() => {
    const onPopState = () => setTab(location.pathname === '/source' ? 'source' : 'demo');
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  function select(next: Tab) {
    history.pushState({}, '', `/${next}`);
    setTab(next);
  }

  return (
    <main className="shell">
      <header>
        <div className="project">JE Narrower</div>
        <nav aria-label="Showcase views">
          <button className={tab === 'demo' ? 'active' : ''} onClick={() => select('demo')}>Demo</button>
          <button className={tab === 'source' ? 'active' : ''} onClick={() => select('source')}>Source</button>
        </nav>
      </header>
      {tab === 'demo' ? <Demo /> : <Source />}
    </main>
  );
}

function Demo() {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section className="demo">
      <div className="demo-action"><a href="/demo-app/" target="_blank" rel="noreferrer">Open demo in full view</a></div>
      {!loaded && !failed && <div className="demo-state">Loading demo…</div>}
      {failed && <div className="demo-state error">The demo could not be loaded.</div>}
      <iframe
        src="/demo-app/"
        title="JE Narrower demo"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </section>
  );
}

function Source() {
  const [manifest, setManifest] = useState<ManifestEntry[]>([]);
  const [selected, setSelected] = useState('README.md');
  const [file, setFile] = useState<SourceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });

  useEffect(() => {
    fetch('/api/showcase/tree')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Source manifest unavailable')))
      .then((body: { files: ManifestEntry[] }) => setManifest(body.files))
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(() => {
    const update = () => setViewport({ width: innerWidth, height: innerHeight });
    addEventListener('resize', update);
    return () => removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    setFile(null);
    setError(null);
    setRaw(false);
    fetch(`/api/showcase/file?path=${encodeURIComponent(selected)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('File unavailable')))
      .then((body: SourceFile) => setFile(body))
      .catch((cause: Error) => setError(cause.message));
  }, [selected]);

  const tree = useMemo(() => buildTree(manifest), [manifest]);
  const compact = viewport.width < 760;
  const treePanel = (
    <aside className={compact ? `tree drawer ${drawer ? 'open' : ''}` : 'tree'}>
      {compact && <button className="close" onClick={() => setDrawer(false)} aria-label="Close files">×</button>}
      <Tree<TreeItem>
        data={tree}
        openByDefault
        width="100%"
        height={Math.max(300, viewport.height - 76)}
        disableDrag
        disableDrop
        onActivate={(node) => {
          if (!node.data.children) {
            setSelected(node.data.path);
            setDrawer(false);
          }
        }}
      >
        {TreeNode}
      </Tree>
    </aside>
  );

  return (
    <section className="source">
      {treePanel}
      <div className="viewer">
        <div className="viewer-head">
          {compact && <button className="files" onClick={() => setDrawer(true)}>Files</button>}
          <span className="breadcrumb">je-narrower / {selected}</span>
          {file?.language === 'markdown' && (
            <div className="toggle" aria-label="Markdown view">
              <button className={!raw ? 'active' : ''} onClick={() => setRaw(false)}>Rendered</button>
              <button className={raw ? 'active' : ''} onClick={() => setRaw(true)}>Raw</button>
            </div>
          )}
        </div>
        <div className="content">
          {error && <div className="state error">{error}</div>}
          {!error && !file && <div className="state">Loading source…</div>}
          {file && file.language === 'unsupported' && <div className="state">This file cannot be displayed.</div>}
          {file && file.language === 'markdown' && !raw && <MarkdownView content={file.content} />}
          {file && (file.language !== 'markdown' || raw) && file.language !== 'unsupported' && (
            <Suspense fallback={<div className="state">Loading code viewer…</div>}>
              <Editor
                path={file.path}
                language={raw ? 'markdown' : file.language}
                value={file.content}
                options={monacoOptions}
                theme="vs-light"
              />
            </Suspense>
          )}
        </div>
      </div>
      {compact && drawer && <button className="backdrop" onClick={() => setDrawer(false)} aria-label="Close files" />}
    </section>
  );
}

function TreeNode({ node, style }: NodeRendererProps<TreeItem>) {
  return (
    <div style={style} className={`tree-node ${node.isSelected ? 'selected' : ''}`} onClick={() => node.isInternal ? node.toggle() : node.activate()}>
      <span className="chevron">{node.isInternal ? (node.isOpen ? '▾' : '▸') : ''}</span>
      <span>{node.data.name}</span>
    </div>
  );
}
