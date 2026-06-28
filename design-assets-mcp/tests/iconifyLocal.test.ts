import { describe, expect, it } from 'vitest';

import { searchIconifyLocal } from '../src/providers/iconifyLocal.js';

describe('iconify local provider', () => {
  it('searches installed collections without throwing', () => {
    const results = searchIconifyLocal('home', 10);
    expect(Array.isArray(results)).toBe(true);
  });
});
