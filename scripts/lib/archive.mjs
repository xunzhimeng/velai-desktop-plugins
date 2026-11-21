import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function buildArchiveFromDir(pluginDir) {
  const manifestPath = join(pluginDir, 'manifest.json');
  const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const filePaths = [rawManifest.backend];
  if (rawManifest.page) filePaths.push(rawManifest.page);
  const migrationPath = join(pluginDir, 'data', 'migration.json');
  if (existsSync(migrationPath)) filePaths.push('data/migration.json');
  filePaths.sort();

  const files = filePaths.map(relPath => {
    const content = readFileSync(join(pluginDir, relPath), 'utf8');
    return { path: relPath, content };
  });

  const manifest = {
    ...rawManifest,
    files: files.map(({ path, content }) => ({ path, sha256: sha256(content) })),
  };

  const archiveObject = canonicalize({
    format: 'nmas-plugin',
    version: 1,
    manifest,
    files,
  });
  const text = JSON.stringify(archiveObject);
  const archiveDigest = sha256(text);
  const backendContent = files.find(f => f.path === manifest.backend).content;
  const boundSource = `// nmas-package-sha256:${archiveDigest}\n${backendContent}`;
  const packageDigest = sha256(boundSource);

  return {
    manifest,
    files,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    archiveDigest,
    packageDigest,
  };
}
