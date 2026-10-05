import assert from 'node:assert/strict';
import test from 'node:test';
import { graphNodeRadii } from './graphDrawing.ts';
import type { GraphPoint } from './graphLayout.ts';

function point(key: string): GraphPoint {
  return {
    x: 0,
    y: 0,
    node: {
      key,
      path: `${key}.md`,
      kind: 'markdown',
      tags: [],
      id: key,
      identity: key,
      problem: null,
      x: null,
      y: null,
    },
  };
}

void test('node sizes grow with connected files and stop at the maximum, retaining selection emphasis', () => {
  const points = [point('hub'), ...Array.from({ length: 100 }, (_, index) => point(String(index)))];
  const edges = points.slice(1).map(({ node }) => ({
    id: node.key,
    source: 'hub',
    target: node.key,
  }));
  const sizes = [0, 1, 4, 16, 100].map((count) =>
    graphNodeRadii(points, edges.slice(0, count), null).get('hub')!,
  );

  assert.ok(sizes[0] < sizes[1]);
  assert.ok(sizes[1] < sizes[2]);
  assert.ok(sizes[2] < sizes[3]);
  assert.equal(sizes[3], sizes[4]);
  assert.ok(sizes[4] <= 14);

  const selected = graphNodeRadii(points, edges, 'hub');
  const unselected = graphNodeRadii(points, edges, null);
  assert.ok(selected.get('hub')! > unselected.get('hub')!);
  assert.ok(selected.get('hub')! <= 16);
  assert.equal(selected.get('0'), unselected.get('0'));
});

void test('repeated, reversed, self and missing-target links do not inflate the number of connected files', () => {
  const points = [point('a'), point('b'), point('isolated')];
  const edge = { id: 'ab', source: 'a', target: 'b' };
  const expected = graphNodeRadii(points, [edge], null);
  const actual = graphNodeRadii(
    points,
    [
      edge,
      { ...edge, id: 'duplicate' },
      { id: 'reverse', source: 'b', target: 'a' },
      { id: 'self', source: 'a', target: 'a' },
      { id: 'missing', source: 'a', target: 'missing' },
    ],
    null,
  );

  assert.deepEqual(actual, expected);
  assert.ok(actual.get('a')! > actual.get('isolated')!);
  assert.equal(actual.get('a'), actual.get('b'));
});
