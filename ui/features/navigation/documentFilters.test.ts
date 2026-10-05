import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDocumentFilters, matchesDocumentFilters, tagError } from './documentFilters.ts';

void test('document filters combine all tags, any selected type and exact folder boundaries', () => {
  const filters = {
    directory: 'work/api',
    tags: ['backend', 'decisions'],
    kinds: ['markdown' as const, 'pdf' as const],
  };
  const note = {
    path: 'work/api/design.md',
    kind: 'markdown' as const,
    tags: ['backend', 'decisions', 'other'],
  };
  assert.equal(matchesDocumentFilters(note, filters), true);
  assert.equal(matchesDocumentFilters({ ...note, path: 'work/apis/design.md' }, filters), false);
  assert.equal(matchesDocumentFilters({ ...note, tags: ['backend'] }, filters), false);
  assert.equal(matchesDocumentFilters({ ...note, kind: 'docx' }, filters), false);
  assert.equal(
    matchesDocumentFilters({ ...note, path: 'work/api/nested/design.md' }, filters),
    true,
  );
  assert.equal(
    matchesDocumentFilters({ ...note, path: 'elsewhere.md', tags: [] }, emptyDocumentFilters),
    true,
  );
});
void test('tag validation uses UTF-8 bytes and rejects controls while retaining case', () => {
  assert.equal(tagError('revisão'), null);
  assert.equal(tagError('Tag Name'), null);
  assert.equal(tagError('é'.repeat(64)), null);
  assert.ok(tagError('é'.repeat(65)));
  assert.ok(tagError('two\nlines'));
  assert.ok(tagError('\u0085'));
  assert.ok(tagError('   '));
  const tags = Array.from({ length: 64 }, (_, index) => `tag-${index}`);
  assert.ok(tagError('another', tags));
  assert.equal(tagError('tag-0', tags), null);
});
