import { lstat, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(repoRoot, 'showcase-manifest.json');
const maxBytes = 256 * 1024;
const roots = [
  'engine/db/migrations', 'engine/src', 'engine/test', 'web/src', 'shared/src',
  'showcase/src', 'docs',
];
const rootFiles = [
  'README.md', 'package.json', 'pnpm-workspace.yaml', 'docker-compose.yml',
  'engine/package.json', 'engine/tsconfig.json', 'engine/vitest.config.ts',
  'web/package.json', 'web/tsconfig.json', 'web/vite.config.ts',
  'showcase/package.json', 'showcase/tsconfig.json', 'showcase/vite.config.ts',
  'showcase/vitest.config.ts', 'shared/package.json', 'shared/tsconfig.json',
];
const languages = {
  '.css': 'css', '.html': 'html', '.js': 'javascript', '.json': 'json',
  '.md': 'markdown', '.sql': 'sql', '.ts': 'typescript', '.tsx': 'typescript',
  '.yaml': 'yaml', '.yml': 'yaml',
};

const approved = [];
for (const file of rootFiles) await include(file);
for (const root of roots) await walk(root);
approved.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(output, `${JSON.stringify(approved, null, 2)}\n`, 'utf8');
console.log(`wrote ${approved.length} approved source files to ${path.relative(repoRoot, output)}`);

async function walk(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const relative = path.posix.join(relativeDir, entry.name);
    if (excluded(relative)) continue;
    if (entry.isDirectory()) await walk(relative);
    else if (entry.isFile()) await include(relative);
  }
}

async function include(relative) {
  if (excluded(relative) || approved.some((entry) => entry.path === relative)) return;
  const absolute = path.join(repoRoot, relative);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return;
  const resolved = await realpath(absolute);
  if (!insideRepo(resolved)) return;
  const language = languageFor(relative);
  if (!language) return;
  approved.push({ path: relative, language, size: (await stat(resolved)).size });
}

function languageFor(relative) {
  const name = path.posix.basename(relative);
  if (name === 'Dockerfile') return 'dockerfile';
  return languages[path.posix.extname(name).toLowerCase()] ?? null;
}

function excluded(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const name = segments.at(-1) ?? '';
  if (normalized === 'showcase-manifest.json') return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|db|sqlite|sqlite3)$/i.test(name)) return true;
  return segments.some((segment) => [
    '.git', 'node_modules', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__',
    '.cache', 'uploads', 'data', 'logs', '.claude', '.replit',
  ].includes(segment));
}

function insideRepo(resolved) {
  const prefix = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
  return resolved.startsWith(prefix);
}
