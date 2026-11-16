// Creates the two release artifacts:
//   release/releasewatcher-<version>/            ready-to-run folder (server sources + production UI) for Bun;
//                                                no `bun install` needed, the server has no runtime dependencies
//   release/releasewatcher-<version>-linux-x64   single self-contained executable (Bun runtime + UI embedded)
//
// Usage: bun scripts/package.ts [version] [--skip-build]   (version defaults to package.json "version")
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';
import { compile } from './compile.ts';

/** `bun build --compile` target of the executable; its file name uses it without the `bun-` prefix. */
const TARGET = 'bun-linux-x64';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const version = (args.find((arg) => !arg.startsWith('--')) ?? pkg.version).replace(/^v/, '');
const name = `releasewatcher-${version}`;
const out = join(root, 'release', name);
const binary = join(root, 'release', `${name}-${TARGET.replace(/^bun-/, '')}`);

if (!args.includes('--skip-build')) {
  const result = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

// 1. Folder for Bun.
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

// 2. Self-contained executable.
rmSync(binary, { force: true });
await compile({ outfile: binary, target: TARGET });

console.log(`\nRelease ready in release/:`);
console.log(`  ${name}/                 run with: bun start   (needs Bun)`);
console.log(`  ${name}-${TARGET.replace(/^bun-/, '')}    run with: ./${name}-${TARGET.replace(/^bun-/, '')}   (needs nothing)`);
