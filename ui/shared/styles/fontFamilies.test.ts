import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFontFamily } from './fontFamilies.ts';

void test('local families resolve as one quoted name with an offline fallback', () => {
  assert.equal(
    resolveFontFamily({ local: ' Noto Sans ' }),
    '"Noto Sans", "Adamant Sans", sans-serif',
  );
  assert.equal(resolveFontFamily({ local: 'serif' }), '"serif", "Adamant Sans", sans-serif');
  assert.equal(resolveFontFamily({ local: '' }), '"Adamant Sans", sans-serif');
  assert.equal(resolveFontFamily('libron'), '"Libron", Georgia, serif');
});

void test('local font names cannot escape CSS strings or close the Markdown style element', () => {
  assert.equal(
    resolveFontFamily({ local: 'Font"\\</style>, serif' }),
    '"Font\\22 \\5c \\3c /style\\3e , serif", "Adamant Sans", sans-serif',
  );
});
