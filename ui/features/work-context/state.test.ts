import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachItems,
  createSpace,
  createTask,
  moveItem,
  remoteFromUrl,
  updateSpace,
  visibleItems,
} from './state.ts';
import type { Connection, WorkItem, WorkState } from './types.ts';

void test('refreshing a shared remote item preserves authored context and independent space progress', () => {
  const first = createSpace('Delivery');
  const second = createSpace('Review');
  const remote: WorkItem = {
    ...createTask('Review storage boundaries'),
    id: 'github:github.com:PR_review',
    kind: 'github-pr',
    remote: { provider: 'github', host: 'github.com', scope: 'owner/repo', number: '42' },
    url: 'https://github.com/owner/repo/pull/42',
    remoteState: 'open',
    fetchedAt: '2026-09-12T12:00:00.000Z',
    priority: 'high',
    links: [{ id: 'note', label: 'Design', target: 'design.md' }],
    checklist: [{ id: 'check', text: 'Check confinement', done: true }],
  };
  let state: WorkState = {
    version: 1,
    vaultId: 'vault',
    revision: 0,
    activeSpaceId: first.id,
    spaces: [first, second],
    items: [],
    drafts: [
      {
        itemId: remote.id,
        kind: 'review',
        body: 'Keep this unsent review.',
        updatedAt: remote.fetchedAt!,
      },
    ],
  };
  state = attachItems(attachItems(state, first.id, [remote]), second.id, [remote]);
  state = updateSpace(state, first.id, (space) => moveItem(space, remote.id, space.columns[1].id));
  state = attachItems(state, second.id, [
    {
      ...remote,
      title: 'Storage review updated',
      remoteState: 'closed',
      priority: 'none',
      links: [],
      checklist: [],
    },
  ]);

  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].title, 'Storage review updated');
  assert.equal(state.items[0].remoteState, 'closed');
  assert.equal(state.items[0].priority, 'high');
  assert.deepEqual(state.items[0].links, remote.links);
  assert.deepEqual(state.items[0].checklist, remote.checklist);
  assert.equal(state.drafts[0].body, 'Keep this unsent review.');
  assert.equal(state.spaces[0].members[0].columnId, first.columns[1].id);
  assert.equal(state.spaces[1].members[0].columnId, second.columns[0].id);
});

void test('manual following accepts provider targets but rejects credential and origin confusion', () => {
  const connection: Connection = {
    id: 'account',
    provider: 'github',
    host: 'github.com',
    account: 'reviewer',
  };
  assert.deepEqual(remoteFromUrl('https://github.com/owner/repo/pull/42', connection), {
    provider: 'github',
    host: 'github.com',
    scope: 'owner/repo',
    number: '42',
  });
  for (const url of [
    'https://github.com.evil.test/owner/repo/pull/42',
    'https://token@github.com/owner/repo/pull/42',
    'https://github.com:8443/owner/repo/pull/42',
    'http://github.com/owner/repo/pull/42',
    'https://github.com/owner/repo/pull/42/files',
  ]) {
    assert.throws(() => remoteFromUrl(url, connection));
  }
});

void test('recent updates compare instants across provider timezone formats', () => {
  const space = createSpace('Triage');
  const earlier = { ...createTask('Earlier instant'), updatedAt: '2026-09-12T11:00:00.000+0300' };
  const later = { ...createTask('Later instant'), updatedAt: '2026-09-12T09:00:00Z' };
  space.members = [earlier, later].map((item) => ({
    itemId: item.id,
    columnId: space.columns[0].id,
  }));
  space.view.sort = 'updated';
  assert.deepEqual(
    visibleItems(space, new Map([earlier, later].map((item) => [item.id, item]))).map(
      (item) => item.id,
    ),
    [later.id, earlier.id],
  );
});

void test('Jira cards remain searchable by their human key with stable numeric identity', () => {
  const space = createSpace('Triage');
  const item: WorkItem = {
    ...createTask('Investigate offline refresh'),
    kind: 'jira',
    remote: { provider: 'jira', host: 'example.atlassian.net', scope: 'AD', number: '10001' },
    url: 'https://example.atlassian.net/browse/AD-7',
  };
  space.members = [{ itemId: item.id, columnId: space.columns[0].id }];
  space.view.query = 'ad-7';

  assert.deepEqual(
    visibleItems(space, new Map([[item.id, item]])).map((entry) => entry.id),
    [item.id],
  );
});
