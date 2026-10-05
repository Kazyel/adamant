import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshGraph } from './graphRefresh.ts';
import type { GraphNode, GraphSnapshot } from './graphTypes.ts';

function node(key: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    key,
    path: `${key}.md`,
    kind: 'markdown',
    tags: [],
    id: key,
    identity: key,
    problem: null,
    x: null,
    y: null,
    ...overrides,
  };
}

const original: GraphSnapshot = {
  nodes: [node('a', { x: 50, y: 80 }), node('b')],
  edges: [{ id: 'ab', source: 'a', target: 'b' }],
  revision: 1,
  generation: 1,
  complete: true,
  indexing: { state: 'ready', scannedEntries: 2, indexedDocuments: 2, message: null },
  references: {
    edges: [],
    indexing: { state: 'ready', scannedEntries: 2, indexedDocuments: 2, message: null },
    canContinue: false,
  },
};

void test('tag changes refresh filters without replacing manual graph positions or connections', () => {
  const refreshed = refreshGraph(original, {
    ...original,
    nodes: [node('a', { tags: ['work'], x: 999 }), node('b')],
  });
  assert.deepEqual(refreshed.nodes[0].tags, ['work']);
  assert.equal(refreshed.nodes[0].x, 50);
  assert.equal(refreshed.nodes[0].y, 80);
  assert.equal(refreshed.nodes[1], original.nodes[1]);
  assert.equal(refreshed.edges, original.edges);
});

void test('inventory and Markdown relations refresh without changing manual edges or positions', () => {
  const refreshed = refreshGraph(original, {
    ...original,
    generation: 2,
    nodes: [node('a', { path: 'renamed.md', x: 999 }), node('b'), node('c')],
    edges: [],
    references: {
      ...original.references,
      edges: [{ source: 'b', target: 'a' }],
    },
  });
  assert.equal(refreshed.edges, original.edges);
  assert.equal(refreshed.revision, original.revision);
  assert.equal(refreshed.nodes[0].path, 'renamed.md');
  assert.equal(refreshed.nodes[0].x, 50);
  assert.equal(refreshed.nodes[0].y, 80);
  assert.equal(refreshed.nodes.length, 3);
  assert.equal(refreshed.generation, 2);
  assert.deepEqual(refreshed.references.edges, [{ source: 'b', target: 'a' }]);
});

void test('UUID adoption and unique UUID renames preserve live keys and reference endpoints', () => {
  const current = {
    ...original,
    nodes: [node('path:a.md', { path: 'a.md', id: null, x: 12 }), node('b')],
  };
  const refreshed = refreshGraph(current, {
    ...original,
    nodes: [node('uuid:a', { path: 'a.md', id: 'a' }), node('uuid:b', { id: 'b', path: 'new.md' })],
    references: {
      ...original.references,
      edges: [{ source: 'uuid:a', target: 'uuid:b' }],
    },
  });
  assert.deepEqual(
    refreshed.nodes.map(({ key }) => key),
    ['path:a.md', 'b'],
  );
  assert.equal(refreshed.nodes[0].x, 12);
  assert.equal(refreshed.nodes[0].id, 'a');
  assert.equal(refreshed.nodes[1].path, 'new.md');
  assert.deepEqual(refreshed.references.edges, [{ source: 'path:a.md', target: 'b' }]);
});

void test('another writer cannot replace the live manual graph or advance its conflict revision', () => {
  const refreshed = refreshGraph(original, {
    ...original,
    revision: 2,
    nodes: [node('uuid:a', { id: 'a' }), node('b'), node('c')],
    edges: [{ id: 'bc', source: 'b', target: 'c' }],
    references: {
      ...original.references,
      edges: [
        { source: 'uuid:a', target: 'b' },
        { source: 'c', target: 'b' },
      ],
    },
  });
  assert.equal(refreshed.revision, 1);
  assert.deepEqual(refreshed.nodes, original.nodes);
  assert.equal(refreshed.edges, original.edges);
  assert.deepEqual(refreshed.references.edges, [{ source: 'a', target: 'b' }]);
});

void test('confirmed removal drops nodes and their manual and Markdown connections', () => {
  const linked = {
    ...original,
    references: { ...original.references, edges: [{ source: 'a', target: 'b' }] },
  };
  const refreshed = refreshGraph(linked, { ...original, nodes: [node('a')] });
  assert.deepEqual(
    refreshed.nodes.map(({ key }) => key),
    ['a'],
  );
  assert.deepEqual(refreshed.edges, []);
  assert.deepEqual(refreshed.references.edges, []);
});

void test('ambiguous identities stay unresolved while replacement files do not inherit old connections', () => {
  const refreshed = refreshGraph(original, {
    ...original,
    nodes: [
      node('a', { identity: '', problem: 'Identity is ambiguous.' }),
      node('replacement', { path: 'replacement.md', id: 'replacement' }),
      node('b', { identity: '', problem: 'Identity is ambiguous.' }),
      node('copy1', { id: 'b' }),
      node('copy2', { id: 'b' }),
    ],
    references: { ...original.references, edges: [{ source: 'replacement', target: 'copy1' }] },
  });
  assert.equal(refreshed.edges, original.edges);
  assert.equal(refreshed.nodes.find(({ key }) => key === 'a')?.id, 'a');
  assert.equal(refreshed.nodes.find(({ key }) => key === 'b')?.id, 'b');
  assert.deepEqual(refreshed.references.edges, [{ source: 'replacement', target: 'copy1' }]);
});

void test('an incomplete inventory keeps unseen files and their manual connections', () => {
  const refreshed = refreshGraph(original, { ...original, nodes: [node('a')], complete: false });
  assert.equal(refreshed.nodes, original.nodes);
  assert.equal(refreshed.edges, original.edges);
});

void test('a revision conflict does not prevent confirmed file removal', () => {
  const refreshed = refreshGraph(original, { ...original, revision: 2, nodes: [node('a')] });
  assert.equal(refreshed.revision, 1);
  assert.deepEqual(
    refreshed.nodes.map(({ key }) => key),
    ['a'],
  );
  assert.equal(refreshed.nodes[0], original.nodes[0]);
  assert.deepEqual(refreshed.edges, []);
});

void test('restoring a file recovers saved positions and connections until another graph save', () => {
  const removed = refreshGraph(original, { ...original, nodes: [node('a')] });
  const restored = refreshGraph(removed, original);
  assert.deepEqual(restored.nodes, original.nodes);
  assert.deepEqual(restored.edges, original.edges);
});

void test('reference-only refreshes retain node objects and the layout input array', () => {
  const refreshed = refreshGraph(original, {
    ...original,
    nodes: original.nodes.map((node) => ({ ...node })),
    references: { ...original.references, edges: [{ source: 'a', target: 'b' }] },
  });
  assert.equal(refreshed.nodes, original.nodes);
  assert.equal(refreshed.edges, original.edges);
  assert.deepEqual(refreshed.references.edges, [{ source: 'a', target: 'b' }]);

  const renamed = refreshGraph(refreshed, {
    ...refreshed,
    nodes: [node('a', { path: 'renamed.md' }), node('b')],
  });
  assert.notEqual(renamed.nodes, refreshed.nodes);
  assert.equal(renamed.nodes[0].path, 'renamed.md');
  assert.equal(renamed.nodes[0].x, 50);
  assert.equal(renamed.nodes[1], refreshed.nodes[1]);
});
