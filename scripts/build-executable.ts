// Builds the server and the built UI into a single self-contained executable (Bun runtime included, nothing else
// needed on the target machine) with `Bun.build({ compile })`. Build the UI first (`bun run build`).
//
// Usage: bun scripts/build-executable.ts [--target=bun-linux-x64] [--outfile=dist/releasewatcher] [--version=1.2.3]
//   --target   any `Bun.build` compile target (e.g. bun-linux-arm64); defaults to the current platform.
//   --version  version shown in the UI (a leading `v` is dropped); defaults to package.json.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** Path of the generated entry point; it exists only in memory (`Bun.build({ files })`). */
const ENTRY = join(root, 'scripts', 'executable-entry.ts');

/**
 * Source of the entry point: embeds every file of `public/` (`with { type: 'file' }`), registers them in
 * `embeddedUi` and only then loads `src/main.ts` (dynamic import, so it runs after the map is filled and after the
 * polyfills).
 */
async function entrySource(): Promise<string> {
  const files = (await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: join(root, 'public') })))
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
  const lines = [
    // Polyfill needed by @simplewebauthn/server → @peculiar/x509 → tsyringe. It is CommonJS, which the bundler
    // initialises lazily at its import site – inside the library that comes too late (the ESM modules that need
    // it are hoisted before it), so load it here, before main.ts.
    "import 'reflect-metadata';",
    "import { embeddedUi } from '../src/embedded-ui.ts';",
    ...files.map((file, i) => `import f${i} from ${JSON.stringify(`../public/${file}`)} with { type: 'file' };`),
    ...files.map((file, i) => `embeddedUi.set(${JSON.stringify(`/${file}`)}, f${i});`),
    "await import('../src/main.ts');",
  ];
  return lines.join('\n') + '\n';
}

export async function buildExecutable(options: {
  outfile: string;
  target?: string | undefined;
  version?: string | undefined;
}): Promise<void> {
  if (!existsSync(join(root, 'public', 'index.html'))) {
    console.error('public/index.html is missing, run `bun run build` first.');
    process.exit(1);
  }
  const result = await Bun.build({
    entrypoints: [ENTRY],
    files: { [ENTRY]: await entrySource() },
    compile: {
      outfile: options.outfile,
      ...(options.target ? { target: options.target as Bun.Build.CompileTarget } : {}),
    },
    // Bytecode defaults to CommonJS, which has no top-level await (used by src/main.ts).
    format: 'esm',
    minify: { whitespace: true, syntax: true, identifiers: true, keepNames: true },
    sourcemap: 'linked',
    bytecode: true,
    // Read by src/app-version.ts.
    ...(options.version
      ? { define: { 'process.env.RELEASEWATCHER_VERSION': JSON.stringify(options.version.replace(/^v/, '')) } }
      : {}),
    throw: false,
  });
  for (const log of result.logs) {
    console.error(log);
  }
  if (!result.success) {
    process.exit(1);
  }
  // The source map is embedded in the executable; drop the extra copy written next to it.
  for (const map of [`${options.outfile}.map`, `${options.outfile.replace(/\.exe$/, '')}.map`]) {
    rmSync(map, { force: true });
  }
}

if (import.meta.main) {
  const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  await buildExecutable({
    outfile: option('outfile') ?? 'dist/releasewatcher',
    target: option('target'),
    version: option('version'),
  });
}
