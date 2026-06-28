import { describe, expect, it } from 'vitest';

import { hashSvg } from '../src/svg/hash.js';

describe('hashSvg', () => {
  it('hashes deterministically', () => {
    expect(hashSvg('<svg/>')).toBe(hashSvg('<svg/>'));
  });
});
