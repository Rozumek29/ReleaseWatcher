/**
 * Why a version pattern can't be used, checked in the browser before saving (the server checks it again and also
 * limits its run time); null = fine or empty.
 */
export function versionPatternError(pattern: string): string | null {
  const value = pattern.trim();
  if (!value) {
    return null;
  }
  try {
    new RegExp(value, 'i');
    return null;
  } catch {
    return 'This is not a valid regular expression.';
  }
}
