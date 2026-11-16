// Creates a ready-to-run release folder: a self-contained Linux x64 executable (Bun runtime included) plus the
// production UI, so the target machine needs nothing installed.
//
// Usage: bun scripts/package.ts [version] [--skip-build]   (version defaults to package.json "version")
// Output: release/releasewatcher-<version>-linux-x64/
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';
import { compile } from './compile.ts';

/** `bun build --compile` target; the folder name uses it without the `bun-` prefix. */
const TARGET = 'bun-linux-x64';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const version = (args.find((arg) => !arg.startsWith('--')) ?? pkg.version).replace(/^v/, '');
const name = `releasewatcher-${version}-${TARGET.replace(/^bun-/, '')}`;
const out = join(root, 'release', name);

if (!args.includes('--skip-build')) {
  const result = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
if (!existsSync(join(root, 'public', 'index.html'))) {
  console.error('public/index.html is missing, run `bun run build` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const binary = join(out, 'releasewatcher');
compile({ outfile: binary, target: TARGET });
rmSync(`${binary}.map`, { force: true }); // the source map is also embedded in the binary

for (const entry of ['public', 'README.md', '.env.example']) {
  cpSync(join(root, entry), join(out, entry), { recursive: true });
}

console.log(`\nRelease folder ready: release/${name}`);
console.log('Run ./releasewatcher inside it; it serves the UI from the public/ folder next to it.');
