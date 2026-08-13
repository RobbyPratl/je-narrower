export interface ManifestEntry {
  path: string;
  language: string;
  size: number;
}

export interface SourceFile extends ManifestEntry {
  content: string;
}

export interface TreeItem {
  id: string;
  name: string;
  path: string;
  children?: TreeItem[];
}

export const monacoOptions = {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  lineNumbers: 'on' as const,
  folding: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
};

export function buildTree(manifest: ManifestEntry[]): TreeItem[] {
  const root: TreeItem = { id: 'je-narrower', name: 'je-narrower', path: '', children: [] };
  for (const entry of [...manifest].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = entry.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const path = parts.slice(0, i + 1).join('/');
      let item = parent.children!.find((child) => child.name === name);
      if (!item) {
        item = { id: path, name, path, ...(i < parts.length - 1 ? { children: [] } : {}) };
        parent.children!.push(item);
      }
      parent = item;
    }
  }
  sortTree(root);
  return [root];
}

function sortTree(item: TreeItem): void {
  item.children?.sort((a, b) => {
    if (Boolean(a.children) !== Boolean(b.children)) return a.children ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  item.children?.forEach(sortTree);
}
