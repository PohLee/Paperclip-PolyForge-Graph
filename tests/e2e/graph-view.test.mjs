import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, graphNodeState } from '../../src/plugin/graph-layout.mjs';

test('workflow map preserves branch, join and rework connections without placing a join before its inputs', () => {
  const graph = { nodes: [{ id: 'start' }, { id: 'left' }, { id: 'right' }, { id: 'longer' }, { id: 'join', reworkTarget: 'start' }], edges: [
    { from: 'start', to: 'left', when: 'left' }, { from: 'start', to: 'right', when: 'right' }, { from: 'left', to: 'join' }, { from: 'right', to: 'longer' }, { from: 'longer', to: 'join' },
  ] };
  const diagram = layoutGraph(graph), positions = Object.fromEntries(diagram.nodes.map(node => [node.id, node]));
  assert.equal(diagram.edges.length, 6);
  assert.equal(diagram.edges.filter(edge => edge.rework).length, 1);
  assert.equal(diagram.edges.find(edge => edge.from === 'start' && edge.to === 'left').when, 'left');
  for (const edge of graph.edges) assert.ok(positions[edge.from].y < positions[edge.to].y);
  assert.notEqual(positions.left.x, positions.right.x);
});

test('a terminal run never displays an old ready node as active and definition view has no invented state', () => {
  assert.equal(graphNodeState('n', { run: { status: 'stopped', nodeStates: { n: { status: 'pending' } } }, ready: [{ id: 'n' }] }), 'pending');
  assert.equal(graphNodeState('n'), 'definition');
  assert.equal(graphNodeState('n', { run: { status: 'completed', nodeStates: { n: { status: 'pending' } } } }), 'not_run');
  assert.equal(graphNodeState('n', { run: { status: 'running', nodeStates: {} }, blocked: [{ id: 'n' }], ready: [{ id: 'n' }] }), 'blocked');
});
