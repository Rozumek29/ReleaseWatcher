/**
 * Tiny request validator replacing the JSON-schema validation Fastify used to do. It supports only what the
 * API needs; unknown object properties are dropped (like Fastify's default `removeAdditional`).
 */

export type Schema =
  | { type: 'string'; nullable?: boolean; maxLength?: number }
  | { type: 'boolean'; nullable?: boolean }
  | { type: 'number' | 'integer'; nullable?: boolean; minimum?: number }
  | { type: 'array'; nullable?: boolean; maxItems?: number; items: Schema }
  | ObjectSchema;

export interface ObjectSchema {
  type: 'object';
  nullable?: boolean;
  properties: Readonly<Record<string, Schema>>;
  required?: readonly string[];
}

/** Thrown for malformed requests; turned into a 400 problem response by the server. */
export class RequestValidationError extends Error {
  override name = 'RequestValidationError';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates `value` against `schema` and returns a copy without unknown properties. Throws on failure. */
export function validate(value: unknown, schema: Schema, path: string): unknown {
  if (value === null && schema.nullable) {
    return null;
  }
  const fail = (message: string): never => {
    throw new RequestValidationError(`${path} ${message}`);
  };

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return fail('must be string');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return fail(`must NOT have more than ${schema.maxLength} characters`);
      }
      return value;
    case 'boolean':
      return typeof value === 'boolean' ? value : fail('must be boolean');
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be number');
      if (schema.type === 'integer' && !Number.isInteger(value)) return fail('must be integer');
      if (schema.minimum !== undefined && value < schema.minimum) return fail(`must be >= ${schema.minimum}`);
      return value;
    case 'array':
      if (!Array.isArray(value)) return fail('must be array');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return fail(`must NOT have more than ${schema.maxItems} items`);
      }
      return value.map((item, i) => validate(item, schema.items, `${path}/${i}`));
    case 'object': {
      if (!isPlainObject(value)) return fail('must be object');
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) fail(`must have required property '${key}'`);
      }
      const result: Record<string, unknown> = {};
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (value[key] !== undefined) {
          result[key] = validate(value[key], propertySchema, `${path}/${key}`);
        }
      }
      return result;
    }
  }
}

/** Parses and validates a JSON request body. */
export async function readBody<T>(request: Request, schema: ObjectSchema): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RequestValidationError('body must be valid JSON');
  }
  return validate(body, schema, 'body') as T;
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
