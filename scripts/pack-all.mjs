import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildArchiveFromDir, sha256 } from './lib/archive.mjs';
import { validateArchiveForDesktop } from './lib/validator.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const pluginsRoot = join(root, 'plugins');
const distRoot = join(root, 'dist');
const checkOnly = process.argv.includes('--check');

mkdirSync(distRoot, { recursive: true });

const dirs = readdirSync(pluginsRoot)
  .filter(name => statSync(join(pluginsRoot, name)).isDirectory())
  .sort();

const catalog = [];
let totalTools = 0;

for (const dir of dirs) {
  const pluginDir = join(pluginsRoot, dir);
  const built = buildArchiveFromDir(pluginDir);
  const summary = validateArchiveForDesktop(built.text);
  totalTools += summary.toolsCount;

  const outFile = join(distRoot, `${built.manifest.plugin_id}.nmas-plugin`);
  if (checkOnly) {
    const existing = readFileSync(outFile, 'utf8');
    assert.equal(existing, built.text, `${outFile} 与源码不一致，请先运行 npm run build`);
  } else {
    writeFileSync(outFile, built.text, 'utf8');
  }

  catalog.push({
    dir,
    plugin_id: built.manifest.plugin_id,
    name: built.manifest.name,
    version: built.manifest.version,
    manifest_version: built.manifest.manifest_version,
    host_api: built.manifest.host_api,
    file: `dist/${built.manifest.plugin_id}.nmas-plugin`,
    bytes: built.bytes,
    file_sha256: sha256(built.text),
    package_digest: built.packageDigest,
    icon: built.manifest.ui?.icon ?? 'app',
    surfaces: built.manifest.ui?.surfaces ?? ['workspace'],
    permissions: built.manifest.permissions,
    data_scope: built.manifest.data?.[0]?.scope ?? 'none',
    settings_count: (built.manifest.settings ?? []).length,
    secret_slots: (built.manifest.settings ?? []).filter(s => s.secret).map(s => s.key),
    ai: built.manifest.ai ?? null,
    actions: built.manifest.actions.map(a => a.id),
    tools: built.manifest.tools.map(t => ({ id: t.id, title: t.title, permissions: t.permissions })),
    http: (built.manifest.http ?? []).map(h =>
      `${h.methods.join('/')} https://${h.host}${h.path_prefix ? `${h.path_prefix}*` : h.path}${h.credential ? ` [secret:${h.credential.slot}]` : ''}`,
    ),
  });

  console.log(
    `[OK] ${built.manifest.plugin_id.padEnd(22)} v${built.manifest.version} (api=${built.manifest.host_api})  ${String(built.bytes).padStart(6)} B  tools=${summary.toolsCount}  actions=${summary.actionsCount}`,
  );
}

assert.ok(totalTools <= 96, `全部插件合计 Agent Tools (${totalTools}) 不能超过 Velai Desktop v2 账号预留上限 96`);

const catalogText = `${JSON.stringify({ schema_version: 2, repository: 'xunzhimeng/velai-desktop-plugins', total_plugins: catalog.length, total_tools: totalTools, plugins: catalog }, null, 2)}\n`;
const catalogPath = join(root, 'catalog.json');
if (checkOnly) {
  assert.equal(readFileSync(catalogPath, 'utf8'), catalogText, 'catalog.json 与源码不一致，请先运行 npm run build');
} else {
  writeFileSync(catalogPath, catalogText, 'utf8');
}

console.log(`\n共打包 ${catalog.length} 个插件，合计 Agent Tools: ${totalTools}/96`);
