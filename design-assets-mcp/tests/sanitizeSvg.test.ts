import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { sanitizeSvg } from '../src/svg/sanitizeSvg.js';

const fixture = (name: string) => fs.readFileSync(path.join(new URL('./fixtures', import.meta.url).pathname, name), 'utf8');

describe('sanitizeSvg', () => {
  it('accepts a safe svg', () => {
    const result = sanitizeSvg(fixture('safe-icon.svg'));
    expect(result.svgText).toContain('<svg');
    expect(result.safetyReport.passed).toBe(true);
  });

  it('rejects hostile fixtures', () => {
    expect(() => sanitizeSvg(fixture('hostile-script.svg'))).toThrow(/script/i);
    expect(() => sanitizeSvg(fixture('hostile-foreign-object.svg'))).toThrow(/foreignObject/i);
    expect(() => sanitizeSvg(fixture('hostile-css-url.svg'))).toThrow(/style|url/i);
    expect(() => sanitizeSvg(fixture('hostile-external-href.svg'))).toThrow(/href/i);
    expect(() => sanitizeSvg(fixture('hostile-doctype.svg'))).toThrow(/DOCTYPE|ENTITY|External entities/i);
  });
});
