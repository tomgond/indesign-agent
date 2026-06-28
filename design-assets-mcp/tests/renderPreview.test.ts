import { describe, expect, it } from 'vitest';

import { renderPreview } from '../src/svg/renderPreview.js';

describe('renderPreview', () => {
  it('enforces a byte cap', () => {
    expect(() => renderPreview('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', { maxBytes: 1 })).toThrow(/PREVIEW_TOO_LARGE/);
  });
});
