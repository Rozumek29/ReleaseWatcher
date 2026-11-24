import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { body, compile, jsonObject, readBody, readOptionalBody, RequestValidationError, validate, z } from '../src/validation.ts';

const schema = body({
  name: z.string().max(5),
  count: z.int().min(1).nullish(),
  tags: z.array(z.string()).max(2).nullish(),
  response: jsonObject<{ id: string }>().optional(),
});

const messageOf = (value: unknown): string => {
  try {
    validate(value, schema);
  } catch (error) {
    assert.ok(error instanceof RequestValidationError);
    return error.message;
  }
  assert.fail('expected a validation error');
};

const request = (text: string) => new Request('http://localhost/', { method: 'POST', body: text });

describe('validation', () => {
  it('returns the parsed body without unknown properties', () => {
    assert.deepEqual(validate({ name: 'abc', count: null, extra: 1, response: { id: 'x', more: true } }, schema), {
      name: 'abc',
      count: null,
      response: { id: 'x', more: true },
    });
  });

  it('describes the first problem with its path', () => {
    assert.equal(messageOf({}), "body must have required property 'name'");
    assert.equal(messageOf({ name: 5 }), 'body/name must be string');
    assert.equal(messageOf({ name: null }), 'body/name must be string');
    assert.equal(messageOf({ name: 'too long' }), 'body/name must NOT have more than 5 characters');
    assert.equal(messageOf({ name: 'a', count: 1.5 }), 'body/count must be integer');
    assert.equal(messageOf({ name: 'a', count: 0 }), 'body/count must be >= 1');
    assert.equal(messageOf({ name: 'a', tags: ['a', 'b', 'c'] }), 'body/tags must NOT have more than 2 items');
    assert.equal(messageOf({ name: 'a', tags: ['a', 1] }), 'body/tags/1 must be string');
    assert.equal(messageOf({ name: 'a', response: [] }), 'body/response must be object');
    assert.equal(messageOf([]), 'body must be object');
  });

  it('compiles schemas and refuses ones that cannot be compiled', () => {
    assert.doesNotThrow(() => compile(z.object({ a: z.string() })));
    assert.throws(() => compile(z.object({ a: z.string().refine(async () => true) })));
    assert.throws(() => compile(z.coerce.number()));
  });

  it('reads a JSON body', async () => {
    assert.deepEqual(await readBody(request('{"name":"a"}'), schema), { name: 'a' });
    await assert.rejects(readBody(request('{'), schema), new RequestValidationError('body must be valid JSON'));
    await assert.rejects(readBody(request(''), schema), new RequestValidationError('body must be valid JSON'));
  });

  it('treats an empty optional body as an empty object', async () => {
    const options = body({ backup: z.boolean().nullish() });
    assert.deepEqual(await readOptionalBody(request(''), options), {});
    assert.deepEqual(await readOptionalBody(request(' \n'), options), {});
    assert.deepEqual(await readOptionalBody(request('{"backup":true}'), options), { backup: true });
    await assert.rejects(readOptionalBody(request('{"backup":1}'), options), new RequestValidationError('body/backup must be boolean'));
  });
});
