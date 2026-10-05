import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDocumentFilters } from '../navigation/documentFilters.ts';
import { graphConnections } from './graphConnections.ts';
import { graphRecord, type GraphNode, type GraphSnapshot } from './graphTypes.ts';
import { projectGraph } from './graphProjection.ts';

function node(key: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    key,
    path: `notes/${key}.md`,
    kind: 'markdown',
    tags: ['work'],
    id: key,
    identity: key,
    problem: null,
    x: key.charCodeAt(0),
    y: 20,
    ...overrides,
  };
}

function graph(): GraphSnapshot {
  const indexing = {
    state: 'ready',
    scannedEntries: 6,
    indexedDocuments: 6,
    message: null,
  } as const;
  return {
    nodes: [
      node('a'),
      node('b', { tags: ['work', 'design'] }),
      node('c', { path: 'notes/sub/c.md', tags: ['work', 'design'] }),
      node('d', { path: 'notes-other/d.md' }),
      node('e', { path: 'notes/e.pdf', kind: 'pdf', tags: [] }),
      node('isolated'),
    ],
    edges: [{ id: 'ab', source: 'a', target: 'b' }],
    references: {
      edges: [
        { source: 'b', target: 'a' },
        { source: 'c', target: 'b' },
        { source: 'd', target: 'c' },
        { source: 'e', target: 'a' },
      ],
      indexing,
      canContinue: false,
    },
    indexing,
    generation: 1,
    revision: 1,
    complete: true,
  };
}

void test('local depth includes manual links and backlinks without changing saved graph or node order', () => {
  const snapshot = graph();
  const before = graphRecord(snapshot);
  const connections = graphConnections(snapshot);
  const one = projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', {
    root: 'a',
    depth: 1,
  });
  const two = projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', {
    root: 'a',
    depth: 2,
  });
  assert.deepEqual(
    one.nodes.map(({ key }) => key),
    ['a', 'b', 'e'],
  );
  assert.deepEqual(
    two.nodes.map(({ key }) => key),
    ['a', 'b', 'c', 'e'],
  );
  assert.equal(one.connections.length, 2);
  assert.equal(two.connections.length, 3);
  assert.equal(one.nodes[0], snapshot.nodes[0]);
  assert.deepEqual(graphRecord(snapshot), before);
  assert.equal('tags' in before.nodes[0], false);
  assert.equal(
    projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', null).nodes.length,
    6,
  );
});

void test('filters intersect local scope after traversal, including when an intermediate node is hidden', () => {
  const snapshot = graph();
  const connections = graphConnections(snapshot);
  const result = projectGraph(
    snapshot.nodes,
    connections,
    {
      directory: 'notes/sub',
      tags: ['work', 'design'],
      kinds: ['markdown'],
    },
    'C.MD',
    { root: 'a', depth: 2 },
  );
  assert.deepEqual(
    result.nodes.map(({ key }) => key),
    ['c'],
  );
  assert.equal(result.connections.length, 0);
  const folder = projectGraph(
    snapshot.nodes,
    connections,
    {
      directory: 'notes',
      tags: ['work'],
      kinds: [],
    },
    '',
    null,
  );
  assert.deepEqual(
    folder.nodes.map(({ key }) => key),
    ['a', 'b', 'c', 'isolated'],
  );
});

void test('local view has explicit empty and isolated roots and handles cycles within its depth', () => {
  const snapshot = graph();
  snapshot.references.edges.push({ source: 'a', target: 'c' });
  const connections = graphConnections(snapshot);
  for (const root of [null, 'missing']) {
    assert.equal(
      projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', { root, depth: 2 }).nodes
        .length,
      0,
    );
  }
  assert.deepEqual(
    projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', {
      root: 'isolated',
      depth: 2,
    }).nodes.map(({ key }) => key),
    ['isolated'],
  );
  const cyclic = projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', {
    root: 'a',
    depth: 2,
  });
  assert.deepEqual(
    cyclic.nodes.map(({ key }) => key),
    ['a', 'b', 'c', 'd', 'e'],
  );
  snapshot.nodes[0] = { ...snapshot.nodes[0], identity: '' };
  assert.equal(
    projectGraph(snapshot.nodes, connections, emptyDocumentFilters, '', { root: 'a', depth: 1 })
      .nodes.length,
    0,
  );
});
