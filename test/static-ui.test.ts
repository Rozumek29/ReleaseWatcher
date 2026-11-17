import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { acceptsZstd, isHashedAsset, matchesEtag } from '../src/static-ui.ts';

describe('isHashedAsset', () => {
  it('recognises file names with an Angular build hash', () => {
    for (const path of ['/main-QT5IUOY2.js', '/chunk-B-Wp3YLy.js', '/chunk-gXZXB6Wp.js', '/styles-LKQPNTTF.css', '/media/inter-ABCD1234.woff2']) {
      assert.ok(isHashedAsset(path), path);
    }
  });

  it('does not treat plain names as hashed', () => {
    for (const path of ['/index.html', '/favicon.ico', '/apple-touch-icon.png', '/bell.svg', '/3rdpartylicenses.txt', '/some-longname.js']) {
      assert.ok(!isHashedAsset(path), path);
    }
  });
});

describe('acceptsZstd', () => {
  it('reads Accept-Encoding including q-values', () => {
    assert.ok(acceptsZstd('gzip, deflate, br, zstd'));
    assert.ok(acceptsZstd('zstd;q=0.5'));
    assert.ok(acceptsZstd('ZSTD'));
    assert.ok(!acceptsZstd('gzip, br'));
    assert.ok(!acceptsZstd('zstd;q=0'));
    assert.ok(!acceptsZstd(null));
  });
});

describe('matchesEtag', () => {
  it('compares If-None-Match lists weakly', () => {
    assert.ok(matchesEtag('"abc"', '"abc"'));
    assert.ok(matchesEtag('"x", W/"abc"', '"abc"'));
    assert.ok(matchesEtag('*', '"abc"'));
    assert.ok(!matchesEtag('"abc-zstd"', '"abc"'));
    assert.ok(!matchesEtag(null, '"abc"'));
  });
});
