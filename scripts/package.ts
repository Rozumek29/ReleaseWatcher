// Creates the release artifacts:
//   release/releasewatcher-<version>/                     ready-to-run folder (server sources + production UI + the
//                                                         runtime dependencies in node_modules) for Bun; no
//                                                         `bun install` needed
//   release/releasewatcher-<version>-linux-x64            single self-contained executable (Bun runtime + UI
//                                                         embedded) for x64 CPUs with AVX2 (Haswell, 2013, and newer)
//   release/releasewatcher-<version>-linux-x64-baseline   the same for older x64 CPUs without AVX2
//   release/releasewatcher-<version>-linux-arm64          the same for 64-bit ARM (Raspberry Pi 4/5 with a 64-bit OS …)
//
// Usage: bun scripts/package.ts [version] [--skip-build]   (version defaults to package.json "version")
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';
import { compile } from './compile.ts';

/**
 * `bun build --compile` targets of the executables; their file names use them without the `bun-` prefix. The
 * default Bun build needs AVX2 and crashes with "Illegal instruction" on older CPUs – `-baseline` runs on any x64 CPU.
 */
const TARGETS = ['bun-linux-x64', 'bun-linux-x64-baseline', 'bun-linux-arm64'];

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const version = (args.find((arg) => !arg.startsWith('--')) ?? pkg.version).replace(/^v/, '');
const name = `releasewatcher-${version}`;
const out = join(root, 'release', name);
const binaryName = (target: string) => `${name}-${target.replace(/^bun-/, '')}`;

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
// Runtime-only package.json: no workspaces, no dev tooling – only the runtime dependencies.
const runtimePkg = {
  name: pkg.name,
  version,
  private: true,
  description: pkg.description,
  type: pkg.type,
  engines: pkg.engines,
  scripts: { start: 'bun src/main.ts', serve: 'bun src/main.ts' },
  dependencies: pkg.dependencies,
};
await Bun.write(join(out, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');
// Ship the dependencies with the folder (plain node_modules layout), so it runs without `bun install`.
const install = Bun.spawnSync([process.execPath, 'install', '--production', '--linker=hoisted', '--no-save'], {
  cwd: out,
  stdio: ['inherit', 'inherit', 'inherit'],
});
if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);

// 2. Self-contained executables.
for (const target of TARGETS) {
  const binary = join(root, 'release', binaryName(target));
  rmSync(binary, { force: true });
  await compile({ outfile: binary, target, version });
}

console.log(`\nRelease ready in release/:`);
console.log(`  ${name}/    run with: bun start   (needs Bun)`);
for (const target of TARGETS) {
  console.log(`  ${binaryName(target)}    run with: ./${binaryName(target)}   (needs nothing)`);
}
