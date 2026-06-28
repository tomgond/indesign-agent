import { describe, expect, it } from 'vitest';

import { searchTabler, getTablerSvg } from '../src/providers/tabler.js';

describe('tabler provider', () => {
  it('finds a local icon', () => {
    const results = searchTabler('home', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('tabler');
  });

  it('returns svg for an icon', () => {
    const results = searchTabler('home', 5);
    const svg = getTablerSvg(results[0].providerAssetId);
    expect(svg).toContain('<svg');
  });
});
