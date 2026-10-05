import assert from 'node:assert/strict';
import test from 'node:test';
import { noteTemplates, templateText } from './noteTemplates.ts';

void test('optional templates create bodies without copying identity or imposing metadata', () => {
  assert.equal(templateText('blank', 'empty.md'), '');
  for (const template of noteTemplates.filter((item) => item.id !== 'blank')) {
    const text = templateText(template.id, 'notes/My note.md');
    assert.ok(text.startsWith('# My note\n\n'));
    assert.equal(text.includes('id:'), false);
    assert.equal(text.startsWith('---'), false);
    for (const section of template.sections) {
      assert.ok(text.includes(`## ${section}\n`));
    }
  }
  assert.ok(templateText('meeting', 'Weekly.md').includes('- [ ]'));
});
void test('template titles escape Markdown punctuation from the chosen filename', () => {
  assert.ok(templateText('study', '[API] <draft>.md').startsWith('# \\[API\\] \\<draft\\>\n'));
});
