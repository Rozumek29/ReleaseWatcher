import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import {
  appNameFromScript,
  DETECT_SCRIPT,
  detectedApps,
  KNOWN_APPS,
  normalizeAppName,
  parseDetectOutput,
  repositoryFromScript,
} from '../src/proxmox/detect.ts';

const none = () => ({ repository: null, name: null });
const known = (name: string) => KNOWN_APPS.get(normalizeAppName(name)) ?? none();

describe('app detection', () => {
  it('runs in a real shell and reports small version files in the home directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rw-detect-'));
    try {
      writeFileSync(join(home, '.vaultwarden'), '1.34.3\n');
      writeFileSync(join(home, '.big'), 'x'.repeat(500));
      const proc = Bun.spawn(['sh', '-c', DETECT_SCRIPT], { stdout: 'pipe', env: { ...process.env, HOME: home } });
      const output = await new Response(proc.stdout).text();
      assert.equal(await proc.exited, 0);
      const probe = parseDetectOutput(output);
      assert.equal(probe.scriptSlug, null);
      assert.deepEqual(
        probe.versionFiles.map((f) => [f.appName, f.version]),
        [['vaultwarden', '1.34.3']],
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('parses the update script slug and version-like files only', () => {
    const probe = parseDetectOutput(
      [
        'update\tct/vaultwarden.sh',
        'file\t/root/.vaultwarden\t1.34.3',
        'file\t/root/.lesshst\t.less-history-file:',
        'file\t/opt/Paperless-ngx_version.txt\tv2.15.0',
        'file\t/root/.app\t3f2a9c1d',
      ].join('\n'),
    );
    assert.equal(probe.scriptSlug, 'vaultwarden');
    assert.deepEqual(
      probe.versionFiles.map((f) => f.appName),
      ['vaultwarden', 'Paperless-ngx', 'app'],
    );
  });

  it('ignores an update script that does not point to a community-scripts script', () => {
    assert.equal(parseDetectOutput('update\t\n').scriptSlug, null);
  });

  it('reads the repository from the Source header of a community-scripts script', () => {
    const script = [
      '#!/usr/bin/env bash',
      '# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE',
      '# Source: https://docs.paperless-ngx.com/ | Github: https://github.com/paperless-ngx/paperless-ngx',
      '',
      'APP="Paperless-ngx"',
    ].join('\n');
    assert.equal(repositoryFromScript(script), 'paperless-ngx/paperless-ngx');
    assert.equal(appNameFromScript(script), 'Paperless-ngx');
  });

  it('falls back to the release helpers of the update function', () => {
    const script = [
      '# Source: https://example.org/',
      'APP="Example"',
      '  if check_for_gh_release "example" "acme/example-server"; then',
    ].join('\n');
    assert.equal(repositoryFromScript(script), 'acme/example-server');
    assert.equal(repositoryFromScript('# Source: https://example.org/\nAPP="X"\napt install x'), null);
  });

  it('suggests the community-scripts application with its version file and update command', () => {
    const apps = detectedApps(
      parseDetectOutput('update\tct/vaultwarden.sh\nfile\t/root/.vaultwarden\t1.34.3\nfile\t/root/.bw_web_builds\tv2025.1.0'),
      known,
    );
    assert.deepEqual(apps, [
      {
        name: 'Vaultwarden',
        slug: 'vaultwarden',
        versionCommand: 'cat /root/.vaultwarden',
        installedVersion: '1.34.3',
        updateCommand: 'update',
        repository: 'dani-garcia/vaultwarden',
      },
    ]);
  });

  it('matches the version file by the repository name when the slug differs', () => {
    const apps = detectedApps(parseDetectOutput('update\tct/adguard.sh\nfile\t/root/.adguardhome\tv0.107.0\nfile\t/root/.x\t1'), known);
    assert.equal(apps[0]?.versionCommand, 'cat /root/.adguardhome');
    assert.equal(apps[0]?.repository, 'AdguardTeam/AdGuardHome');
  });

  it('suggests /opt version files and known dot files without a community-scripts script', () => {
    const apps = detectedApps(
      parseDetectOutput(
        ['file\t/opt/My App_version.txt\t1.0.0', 'file\t/root/.unknown\t2.0.0', 'file\t/root/.jellyfin\t10.10.0'].join('\n'),
      ),
      known,
    );
    assert.deepEqual(
      apps.map((a) => [a.name, a.versionCommand, a.repository, a.updateCommand]),
      [
        ['My App', "cat '/opt/My App_version.txt'", null, null],
        ['Jellyfin', 'cat /root/.jellyfin', 'jellyfin/jellyfin', null],
      ],
    );
  });
});
