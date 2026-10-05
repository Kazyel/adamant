import assert from 'node:assert/strict';
import test from 'node:test';
import { graphConnections, connectionOrigins, removeManualConnection } from './graphConnections.ts';
import { graphRecord, type GraphSnapshot } from './graphTypes.ts';
import { graphNeighbors } from './graphLayout.ts';
import { rememberGraph, travelGraph } from './graphHistory.ts';

const indexing = { state: 'ready', scannedEntries: 3, indexedDocuments: 3, message: null } as const;
function graph(): GraphSnapshot {
  return {
    nodes: ['a', 'b', 'c'].map((key) => ({
      key,
      path: `${key}.md`,
      id: null,
      identity: `path:${key}.md`,
      kind: 'markdown',
      tags: [],
      problem: null,
      x: 0,
      y: 0,
    })),
    edges: [{ id: 'manual', source: 'b', target: 'a' }],
    references: {
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
        { source: 'b', target: 'c' },
      ],
      indexing,
      canContinue: false,
    },
    revision: 1,
    generation: 1,
    complete: true,
    indexing,
  };
}

void test('manual links, repeated references and backlinks share one visual edge with both origins', () => {
  const snapshot = graph();
  const connections = graphConnections(snapshot);
  assert.equal(connections.length, 2);
  assert.equal(connectionOrigins(connections[0], 'a'), 'Manual · Link and backlink');
  assert.equal(connectionOrigins(connections[1], 'b'), 'Link in this note');
  assert.equal(connectionOrigins(connections[1], 'c'), 'Backlink');
  assert.deepEqual(graphNeighbors('b', connections), new Set(['b', 'a', 'c']));
  assert.deepEqual(graphRecord(snapshot).edges, snapshot.edges);
  assert.equal('references' in graphRecord(snapshot), false);
});

void test('removing Markdown drops only derived connections; undo changes only manual origins', () => {
  const original = graph();
  const removed = { ...original, references: { ...original.references, edges: [] } };
  assert.equal(graphConnections(removed).length, 1);
  assert.equal(connectionOrigins(graphConnections(removed)[0], 'b'), 'Manual');
  const linked = {
    ...original,
    edges: [...original.edges, { id: 'bc', source: 'b', target: 'c' }],
  };
  const history = rememberGraph({ past: [], future: [] }, original, linked);
  const refreshed = {
    ...linked,
    references: { ...linked.references, edges: [{ source: 'c', target: 'b' }] },
  };
  const undone = travelGraph(history, refreshed, 'undo')!;
  assert.deepEqual(undone.snapshot.references, refreshed.references);
  assert.equal(connectionOrigins(graphConnections(undone.snapshot)[1], 'b'), 'Backlink');
  assert.equal(graphConnections(undone.snapshot).length, 2);
  assert.deepEqual(rememberGraph(history, linked, refreshed), history);
});

void test('missing endpoints and self references do not introduce phantom graph nodes', () => {
  const snapshot = graph();
  snapshot.references.edges = [
    { source: 'a', target: 'a' },
    { source: 'a', target: 'missing' },
  ];
  assert.equal(graphConnections(snapshot).length, 1);
});

void test('removing a manual connection preserves Markdown origins and undo/redo restores only the manual edge', () => {
  const original = graph();
  original.edges.push({ id: 'other', source: 'a', target: 'c' });
  const connection = graphConnections(original)[0];
  const removed = removeManualConnection(original, connection);
  assert.deepEqual(removed.edges, [{ id: 'other', source: 'a', target: 'c' }]);
  assert.equal(removed.references, original.references);
  assert.equal(removed.nodes, original.nodes);
  assert.equal(original.edges.length, 2);
  assert.equal(
    connectionOrigins(
      graphConnections(removed).find((edge) => edge.id === connection.id)!,
      'a',
    ),
    'Link and backlink',
  );
  assert.equal('references' in graphRecord(removed), false);

  const history = rememberGraph({ past: [], future: [] }, original, removed);
  const refreshed = {
    ...removed,
    references: { ...removed.references, edges: [{ source: 'a', target: 'b' }] },
    revision: 2,
  };
  const undone = travelGraph(history, refreshed, 'undo')!;
  assert.deepEqual(undone.snapshot.edges, original.edges);
  assert.equal(undone.snapshot.references, refreshed.references);
  const redone = travelGraph(undone.history, undone.snapshot, 'redo')!;
  assert.deepEqual(redone.snapshot.edges, removed.edges);
  assert.equal(redone.snapshot.revision, 2);
  assert.equal(redone.snapshot.references, refreshed.references);

  const manualOnly = { ...original, references: { ...original.references, edges: [] } };
  assert.equal(graphConnections(removeManualConnection(manualOnly, connection)).length, 1);
});
