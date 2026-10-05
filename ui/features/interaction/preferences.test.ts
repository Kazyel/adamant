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

void test('document tabs are shown by default and accept older saved preferences', () => {
  const { showDocumentTabs: _showDocumentTabs, ...legacy } = defaultEditorPreferences;
  assert.equal(defaultEditorPreferences.showDocumentTabs, true);
  assert.equal(validEditorPreferences(legacy), true);
  for (const showDocumentTabs of [true, false]) {
    assert.equal(validEditorPreferences({ ...legacy, showDocumentTabs }), true);
  }
  for (const showDocumentTabs of ['true', 'false', null, 0, 1, {}]) {
    assert.equal(validEditorPreferences({ ...legacy, showDocumentTabs }), false);
  }
});

void test('Markdown font preferences accept older files and validate independent fonts and sizes', () => {
  const {
    editorFont: _editorFont,
    readingFont: _readingFont,
    readingFontSize: _readingFontSize,
    ...legacy
  } = defaultEditorPreferences;
  assert.equal(validEditorPreferences(legacy), true);

  assert.equal(
    validEditorPreferences({
      ...legacy,
      editorFont: 'jetbrainsMono',
      readingFont: 'libron',
      readingFontSize: 24,
    }),
    true,
  );
  assert.equal(
    validEditorPreferences({ ...legacy, editorFont: 'libron', readingFont: 'inter' }),
    true,
  );
  for (const key of ['interfaceFont', 'editorFont', 'readingFont']) {
    for (const local of ['Arial', 'Noto Sans', 'IBM Plex Mono', 'São Paulo', 'inherit']) {
      assert.equal(validEditorPreferences({ ...legacy, [key]: { local } }), true);
    }
    for (const font of ['Arial', 'inherit', 'toString', '', null, 1, {}]) {
      assert.equal(validEditorPreferences({ ...legacy, [key]: font }), false);
    }
    for (const local of ['', '   ', 'Bad\nFont', 'Bad\u0000Font', 'Bad\u007fFont', null, 1, {}]) {
      assert.equal(validEditorPreferences({ ...legacy, [key]: { local } }), false);
    }
  }
  for (const readingFontSize of [12, 32]) {
    assert.equal(validEditorPreferences({ ...legacy, readingFontSize }), true);
  }
  for (const readingFontSize of [11, 33, NaN, Infinity, '17', null]) {
    assert.equal(validEditorPreferences({ ...legacy, readingFontSize }), false);
  }
  for (const fontSize of [8, 48]) {
    assert.equal(validEditorPreferences({ ...legacy, fontSize }), true);
  }
  for (const fontSize of [7, 49, NaN, Infinity]) {
    assert.equal(validEditorPreferences({ ...legacy, fontSize }), false);
  }
});

void test('interface font remains optional for saved preferences and accepts bundled or local families', () => {
  assert.equal(defaultEditorPreferences.interfaceFont, undefined);
  for (const interfaceFont of [
    undefined,
    'inter',
    'libron',
    'jetbrainsMono',
    { local: 'Noto Sans' },
  ]) {
    assert.equal(validEditorPreferences({ ...defaultEditorPreferences, interfaceFont }), true);
  }
});
