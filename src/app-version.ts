import pkg from '../package.json';

/**
 * Version of the running app. Release builds set it at compile time from the Git tag (`scripts/compile.ts
 * --version=…`, `--define`); otherwise it is the `version` of package.json.
 */
export const APP_VERSION: string = process.env.RELEASEWATCHER_VERSION || pkg.version;
