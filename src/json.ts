/** Parses JSON stored in a column; `fallback` for NULL, empty or invalid text. The shape is not checked. */
export function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) {
    return fallback;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** A JSON array of strings stored in a column (other items are dropped); `[]` for anything else. */
export function parseStringArray(json: string | null): string[] {
  const parsed = parseJson<unknown>(json, null);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}
