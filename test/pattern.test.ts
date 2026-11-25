import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { matchPattern, MAX_PATTERN_LENGTH, PatternError, validatePattern } from '../src/pattern.ts';

describe('validatePattern', () => {
  it('accepts a valid pattern', () => {
    assert.equal(validatePattern('^TS-(.+)$'), null);
    assert.equal(validatePattern('(?<version>\\d+\\.\\d+)'), null);
  });

  it('rejects empty, too long and invalid patterns with a sentence', () => {
    assert.match(validatePattern('  ') ?? '', /Enter a version pattern/);
    assert.match(validatePattern('a'.repeat(MAX_PATTERN_LENGTH + 1)) ?? '', /at most 500 characters/);
    assert.match(validatePattern('(abc') ?? '', /not a valid regular expression/);
  });
});

describe('matchPattern', () => {
  it('returns group 1, the named group or the whole match, trimmed and case-insensitive', async () => {
    assert.deepEqual(await matchPattern('^TS-(.+)$', ['TS-25.10.8', 'TrueNAS-9.10.2-U5', 'ts-1.0']), [
      ['25.10.8'],
      null,
      ['1.0'],
    ]);
    assert.deepEqual(await matchPattern('(x)?v(?<version>[\\d.]+)', ['v1.2.3']), [['1.2.3']]);
    assert.deepEqual(await matchPattern('\\d+\\.\\d+', ['Version 4.5 now']), [['4.5']]);
    assert.deepEqual(await matchPattern('ver:(\\s*[\\d.]+\\s*)', ['ver: 1.2 ']), [['1.2']]);
  });

  it('returns every match with all', async () => {
    assert.deepEqual(await matchPattern('v(\\d+\\.\\d+)', ['v1.0 and V2.1', 'none'], { all: true }), [
      ['1.0', '2.1'],
      null,
    ]);
    assert.deepEqual(await matchPattern('v(\\d+\\.\\d+)', ['v1.0 and v2.1']), [['1.0']]);
  });

  it('skips the worker for no texts and rejects an invalid pattern', async () => {
    assert.deepEqual(await matchPattern('a', []), []);
    await assert.rejects(matchPattern('(a', ['a']), PatternError);
  });

  it('terminates a catastrophic pattern after the timeout', async () => {
    const started = Date.now();
    await assert.rejects(
      matchPattern('^(a+)+$', [`${'a'.repeat(40)}!`], { timeoutMs: 200 }),
      (error: unknown) => error instanceof PatternError && /took too long/.test(error.message),
    );
    assert.ok(Date.now() - started < 2000);
    // The server still works afterwards.
    assert.deepEqual(await matchPattern('(\\d+)', ['x1']), [['1']]);
  });
});
