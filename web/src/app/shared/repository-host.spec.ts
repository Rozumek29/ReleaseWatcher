import { describe, expect, it } from 'vitest';
import { unknownRepositoryHost } from './repository-host';

describe('unknownRepositoryHost', () => {
  it('returns the host of a repository URL whose provider is not known', () => {
    expect(unknownRepositoryHost('https://git.example.com/me/app')).toBe('git.example.com');
    expect(unknownRepositoryHost('git.example.com:3000/me/app')).toBe('git.example.com:3000');
  });

  it('ignores GitHub, well-known hosts and incomplete input', () => {
    for (const input of [
      'owner/repo',
      'https://github.com/owner/repo',
      'https://codeberg.org/forgejo/forgejo',
      'gitlab.com/group/project',
      'https://git.example.com/me',
      'git.example.com',
      '',
    ]) {
      expect(unknownRepositoryHost(input)).toBeNull();
    }
  });
});
