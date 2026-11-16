// Creates a ready-to-run release folder: server sources and the production UI build, so the target machine
// only needs Bun (no `bun install`, no Angular build – the server has no runtime dependencies).
//
// Usage: bun scripts/package.ts [version] [--skip-build]   (version defaults to package.json "version")
// Output: release/releasewatcher-<version>/
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';

const root = join(import.meta.dir, '..');
const versionArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const version = (versionArg ?? pkg.version).replace(/^v/, '');
const name = `releasewatcher-${version}`;
const out = join(root, 'release', name);

if (!process.argv.includes('--skip-build')) {
  const result = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
if (!existsSync(join(root, 'public', 'index.html'))) {
  console.error('public/index.html is missing, run `bun run build` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const entry of ['src', 'public', 'README.md', '.env.example', 'Dockerfile', 'docker-compose.yml']) {
  cpSync(join(root, entry), join(out, entry), { recursive: true });
}

// Runtime-only package.json: no workspaces, no dev tooling, no dependencies.
const runtimePkg = {
  name: pkg.name,
  version,
  private: true,
  description: pkg.description,
  type: pkg.type,
  engines: pkg.engines,
  scripts: { start: 'bun src/main.ts', serve: 'bun src/main.ts' },
};
await Bun.write(join(out, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');

console.log(`\nRelease folder ready: release/${name}`);
console.log('Run it with: bun start   (or: bun src/main.ts)');
