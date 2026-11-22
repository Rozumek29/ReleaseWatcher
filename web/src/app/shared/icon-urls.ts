/** jsDelivr mirror of https://github.com/selfhst/icons – keep in sync with `iconUrls()` in `src/domain.ts`. */
const SELFHST_CDN = 'https://cdn.jsdelivr.net/gh/selfhst/icons';
const SELFHST_FORMATS = ['svg', 'png', 'webp'] as const;
const SELFHST_PATTERN = /^sh:(?<slug>[a-z0-9]+(?:[-_][a-z0-9]+)*)(?:\.(?<format>svg|png|webp))?$/;

/**
 * Image URLs of a custom icon as the server resolves them (for the live preview while typing): `sh:<slug>` →
 * selfh.st/icons (SVG, PNG, WebP), an http(s) URL as it is, anything else none.
 */
export function iconUrls(icon: string): string[] {
  const value = icon.trim();
  const shorthand = value.toLowerCase().match(SELFHST_PATTERN);
  if (shorthand) {
    const slug = shorthand.groups?.['slug'] ?? '';
    const format = shorthand.groups?.['format'];
    return (format ? [format] : SELFHST_FORMATS).map((f) => `${SELFHST_CDN}/${f}/${slug}.${f}`);
  }
  return /^https?:\/\/\S+$/i.test(value) ? [value] : [];
}
