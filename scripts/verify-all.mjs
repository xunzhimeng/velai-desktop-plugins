import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateArchiveForDesktop } from './lib/validator.mjs';
import { createPluginHarness } from './lib/sandbox.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const pluginsRoot = join(root, 'plugins');
const distRoot = join(root, 'dist');

const dirs = readdirSync(pluginsRoot)
  .filter(name => statSync(join(pluginsRoot, name)).isDirectory())
  .sort();

let passed = 0;

for (const dir of dirs) {
  const pluginDir = join(pluginsRoot, dir);
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
  const archivePath = join(distRoot, `${manifest.plugin_id}.nmas-plugin`);
  if (!existsSync(archivePath)) {
    throw new Error(`缺少归档文件: ${archivePath}，请先运行 npm run build`);
  }
  const raw = readFileSync(archivePath, 'utf8');
  const info = validateArchiveForDesktop(raw);

  const verifyFile = join(pluginDir, 'verify.mjs');
  if (!existsSync(verifyFile)) {
    throw new Error(`插件 ${dir} 缺少 verify.mjs 测试文件`);
  }
  const mod = await import(pathToFileURL(verifyFile).href);
  if (typeof mod.verify !== 'function') {
    throw new Error(`插件 ${dir}/verify.mjs 必须导出 verify 函数`);
  }
  await mod.verify({
    pluginDir,
    manifest,
    createHarness: opts => createPluginHarness(pluginDir, manifest, opts),
  });
  passed += 1;
  console.log(`[PASS] ${info.plugin_id} (${info.name}) v${info.version}`);
}

console.log(`\n全部 ${passed} 个插件通过契约校验与沙箱功能测试！`);
