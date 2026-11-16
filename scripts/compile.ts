// Compiles the server into a single self-contained executable (Bun runtime included, no `bun install` needed).
// The UI is not embedded: the binary serves `public/` from the directory it lives in.
//
// Usage: bun scripts/compile.ts [--target=bun-linux-x64] [--outfile=dist/releasewatcher]
//   --target   any `bun build --compile` target (bun-linux-x64, bun-linux-arm64, bun-windows-x64, bun-darwin-arm64,
//              …-musl, …); defaults to the current platform.
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

export function compile(options: { outfile: string; target?: string | undefined }): void {
  const args = [
    'build',
    './src/main.ts',
    '--compile',
    // --bytecode defaults to CommonJS, which has no top-level await (used by src/main.ts).
    '--format=esm',
    '--minify',
    '--keep-names',
    '--sourcemap',
    '--bytecode',
    `--outfile=${options.outfile}`,
    ...(options.target ? [`--target=${options.target}`] : []),
  ];
  const result = Bun.spawnSync([process.execPath, ...args], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

if (import.meta.main) {
  const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  compile({ outfile: option('outfile') ?? 'dist/releasewatcher', target: option('target') });
}
