import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { shouldAdoptMachineApp } from '../src/machine-apps.ts';

describe('shouldAdoptMachineApp', () => {
  const repo = { installedVersionUrl: null, installedVersionApp: null };

  it('takes an app that reports a version for a repository without a source or with one entered by hand', () => {
    assert.equal(shouldAdoptMachineApp(repo, true), true);
    assert.equal(shouldAdoptMachineApp(repo, false), false);
  });

  it('keeps a version URL and another app', () => {
    assert.equal(shouldAdoptMachineApp({ ...repo, installedVersionUrl: 'https://vault.lan/api/version' }, true), false);
    assert.equal(shouldAdoptMachineApp({ ...repo, installedVersionApp: { kind: 'docker', id: 1 } }, true), false);
  });
});
