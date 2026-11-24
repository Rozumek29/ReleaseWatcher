/**
 * Request validation with Zod. Every body schema is compiled ahead of use (`z.compile()`, https://zod.dev/compile):
 * valid input is checked by generated code, invalid input falls back to the standard parser for the issues.
 * Unknown object properties are dropped.
 */
import * as z from 'zod';

export { z };

/** Thrown for malformed requests; turned into a 400 problem response by the server. */
export class RequestValidationError extends Error {
  override name = 'RequestValidationError';
}

/**
 * Compiles a request schema. `strict` throws when the schema cannot be compiled at all (e.g. something async or
 * recursive), so it fails at startup – and in the tests – instead of silently running on the standard parser.
 * Unsupported children of an object (`z.coerce.*`, async checks) only run on the standard parser – avoid them.
 */
export function compile<T extends z.ZodType>(schema: T): T {
  return z.compile(schema, { strict: true });
}

/** A body schema: an object, compiled, unknown properties dropped. */
export const body = <Shape extends z.ZodRawShape>(shape: Shape) => compile(z.object(shape));

/** Any JSON object, passed through unchanged (e.g. WebAuthn responses validated by their own library). */
export const jsonObject = <T extends object>() =>
  z.custom<T>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'must be object');

/** Message of an issue in the style of the former JSON-schema validator, e.g. `body/name must be string`. */
function describeIssue(issue: z.core.$ZodIssue, root: string): string {
  const segments = [root, ...issue.path.map(String)];
  const path = segments.join('/');
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined && segments.length > 1) {
        return `${segments.slice(0, -1).join('/')} must have required property '${segments.at(-1)}'`;
      }
      return `${path} must be ${issue.expected === 'int' ? 'integer' : issue.expected}`;
    case 'too_big':
      if (issue.origin === 'string') return `${path} must NOT have more than ${issue.maximum} characters`;
      if (issue.origin === 'array') return `${path} must NOT have more than ${issue.maximum} items`;
      return `${path} must be <= ${issue.maximum}`;
    case 'too_small':
      return `${path} must be >= ${issue.minimum}`;
    default:
      return `${path} ${issue.message}`;
  }
}

/** Validates `value` and returns the parsed copy (unknown properties dropped). Throws on failure. */
export function validate<T extends z.ZodType>(value: unknown, schema: T, root = 'body'): z.output<T> {
  const result = schema.safeParse(value, { reportInput: true });
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new RequestValidationError(issue ? describeIssue(issue, root) : `${root} is not valid`);
  }
  return result.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestValidationError('body must be valid JSON');
  }
}

/** Parses and validates a JSON request body. */
export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new RequestValidationError('body must be valid JSON');
  }
  return validate(json, schema);
}

/**
 * Like `readBody()`, for endpoints whose body may be left out: an empty body counts as `{}`. Reads the text first
 * because `request.json()` rejects an empty body.
 */
export async function readOptionalBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const text = await request.text();
  return validate(text.trim() ? parseJson(text) : {}, schema);
}

/** Parses a positive integer route parameter. */
export function parseId(raw: string, path = 'params/id'): number {
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) {
    throw new RequestValidationError(`${path} must be integer`);
  }
  if (id < 1) {
    throw new RequestValidationError(`${path} must be >= 1`);
  }
  return id;
}
