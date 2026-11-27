import assert from 'node:assert/strict';
import test from 'node:test';
import { errorSummary } from '../../src/plugin/adlc-merge-discovery.mjs';

test('discovery warnings carry no free-form error text', () => {
  const messages = [
    '{"url":"https://api.example.com/x?a=1","authorization":"Bearer opaque123"}',
    '{"url":"https://h","password":"p@ssw0rd"}',
    'https://token-service:8443/sign?expires=60&X-Amz-Signature=private',
    '{"url":"https://h/p?q=1","client_secret":"prefix\\"sensitive-tail"}',
  ];
  for (const message of messages) {
    const summary = errorSummary(new Error(message));
    assert.deepEqual(summary, { name: 'Error', code: null });
  }
});

test('discovery warnings keep only allowlisted error names and codes', () => {
  assert.deepEqual(errorSummary(Object.assign(new TypeError('x'), { code: 'ECONNRESET' })), { name: 'TypeError', code: 'ECONNRESET' });
  assert.deepEqual(errorSummary(Object.assign(new Error('x'), { code: '40001' })), { name: 'Error', code: '40001' });
  const hostile = Object.assign(new Error('x'), { name: 'Bearer secret-value', code: 'token=secret-value' });
  assert.deepEqual(errorSummary(hostile), { name: 'Error', code: null });
  assert.deepEqual(errorSummary('not an error'), { name: 'Error', code: null });
});
