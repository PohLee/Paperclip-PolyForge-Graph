import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAutomationModeCeiling } from '../../src/host/automation-mode.mjs';

test('project mode ceiling permits lower modes and requires an explicit full-auto opt-in', () => {
  assert.throws(() => assertAutomationModeCeiling('assisted', { automationMode: 'manual' }), /ceiling/);
  assert.throws(() => assertAutomationModeCeiling('autonomous', { automationMode: 'assisted', allowFullAuto: true }), /ceiling/);
  assert.throws(() => assertAutomationModeCeiling('autonomous', { automationMode: 'full-auto' }), /ceiling/);
  assert.doesNotThrow(() => assertAutomationModeCeiling('assisted', { automationMode: 'full-auto' }));
  assert.doesNotThrow(() => assertAutomationModeCeiling('autonomous', { automationMode: 'full-auto', allowFullAuto: true }));
});
