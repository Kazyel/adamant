import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultEditorPreferences, validEditorPreferences } from './types.ts';

void test('appearance preserves older preferences and rejects unsupported saved themes', () => {
  const { theme: _theme, ...legacy } = defaultEditorPreferences;
  assert.equal(validEditorPreferences(legacy), true);
  for (const theme of ['dark', 'light']) {
    assert.equal(validEditorPreferences({ ...legacy, theme }), true);
  }
  for (const theme of ['sepia', '', null, 1, {}]) {
    assert.equal(validEditorPreferences({ ...legacy, theme }), false);
  }
});
