import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedGoalMarkdown } from '../../src/plugin/dispatch.mjs';

test('GOAL.md projection uses only the immutable run goal snapshot', () => {
  const text = pinnedGoalMarkdown({ id: 'run-a', input: { goalContext: { forged: true } },
    goalContext: { capturedAt: '2026-10-29T00:00:00.000Z', revisions: [{
      id: 'revision-a', version: 2, scope: 'agent', subjectId: 'agent-a', goals: [{
        id: 'goal-a', title: 'Improve activation', keyResults: [{ id: 'kr-a', baseline: 3,
          target: 7, unit: '%', source: 'analytics', window: 'weekly' }],
      }],
    }] } });
  assert.match(text, /# GOAL\.md/);
  assert.match(text, /Revision: revision-a \(version 2\)/);
  assert.match(text, /kr-a: target 7 %; baseline 3; source analytics; window weekly/);
  assert.equal(text.includes('forged'), false);
});
