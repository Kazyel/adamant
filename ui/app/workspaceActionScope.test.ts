import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorkbenchAction } from './workspaceActionScope.ts';

void test('document changes stay in the workbench while navigation and application commands remain global', () => {
  for (const id of ['tab-close', 'note-save', 'notes-save-all', 'note-reload', 'view-edit']) {
    assert.equal(isWorkbenchAction(id), true, id);
  }
  for (const id of [
    'note-create',
    'tab-next',
    'tab-previous',
    'tab-reopen',
    'history-back',
    'history-forward',
    'document-quick-open',
    'preferences',
  ]) {
    assert.equal(isWorkbenchAction(id), false, id);
  }
});
