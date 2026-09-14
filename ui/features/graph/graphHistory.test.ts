import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberGraph, travelGraph, type GraphHistory } from './graphHistory.ts';
import type { GraphSnapshot } from './graphTypes.ts';

const original: GraphSnapshot = {
  nodes: ['a', 'b'].map((key) => ({
    key,
    path: `${key}.md`,
    kind: 'markdown',
    id: key,
    identity: key,
    problem: null,
    x: null,
    y: null,
  })),
  edges: [],
  revision: 1,
  generation: 1,
  complete: true,
  indexing: { state: 'ready', scannedEntries: 2, indexedDocuments: 2, message: null },
};
const empty: GraphHistory = { past: [], future: [] };

void test('undo and redo restore movement and connections without rolling back the saved revision or file resolution', () => {
  const moved = { ...original, nodes: original.nodes.map((node) => ({ ...node, x: 50, y: 80 })) };
  const linked = { ...moved, edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const history = rememberGraph(rememberGraph(empty, original, moved), moved, linked);
  const saved = {
    ...linked,
    revision: 7,
    nodes: linked.nodes.map((node) => ({ ...node, path: `renamed/${node.path}` })),
  };
  const undoLink = travelGraph(history, saved, 'undo')!;
  assert.deepEqual(undoLink.snapshot.edges, []);
  assert.equal(undoLink.snapshot.revision, 7);
  assert.equal(undoLink.snapshot.nodes[0].path, 'renamed/a.md');
  const undoMove = travelGraph(undoLink.history, undoLink.snapshot, 'undo')!;
  assert.equal(undoMove.snapshot.nodes[0].x, null);
  assert.equal(undoMove.snapshot.revision, 7);
  const redoMove = travelGraph(undoMove.history, undoMove.snapshot, 'redo')!;
  const redoLink = travelGraph(redoMove.history, redoMove.snapshot, 'redo')!;
  assert.deepEqual(redoLink.snapshot, saved);
  assert.equal(travelGraph(redoLink.history, redoLink.snapshot, 'redo'), null);
});

void test('a new edit clears redo, no-op edits preserve it, and history is bounded', () => {
  const linked = { ...original, edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const undone = travelGraph(rememberGraph(empty, original, linked), linked, 'undo')!;
  assert.equal(
    rememberGraph(undone.history, undone.snapshot, { ...undone.snapshot }),
    undone.history,
  );
  const branched = rememberGraph(undone.history, undone.snapshot, linked);
  assert.deepEqual(branched.future, []);
  let history = empty;
  for (let index = 0; index < 120; index++) {
    history = rememberGraph(history, original, linked);
  }
  assert.equal(history.past.length, 100);
  const removed = rememberGraph(empty, linked, original);
  assert.deepEqual(travelGraph(removed, original, 'undo')?.snapshot.edges, linked.edges);
});
