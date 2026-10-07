import { expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical';

it('키 순서와 undefined 값에 무관하다', () => {
  expect(canonicalJson({ b: 1, a: [{ y: 2, x: undefined }] })).toBe(canonicalJson({ a: [{ y: 2 }], b: 1 }));
  expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
});
