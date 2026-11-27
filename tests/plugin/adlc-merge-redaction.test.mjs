import assert from 'node:assert/strict';
import test from 'node:test';
import { redactedMessage } from '../../src/plugin/adlc-merge-discovery.mjs';

const redact = message => redactedMessage(new Error(message));

test('discovery log redaction keeps secrets hidden in compact JSON next to URLs', () => {
  const bearer = redact('{"url":"https://api.example.com/x?a=1","authorization":"Bearer opaque123"}');
  assert.ok(!bearer.includes('opaque123'), bearer);
  assert.ok(!bearer.includes('a=1'), bearer);

  const secret = redact('{"url":"https://h/a","note":"#1","client_secret": "abc"}');
  assert.ok(!secret.includes('abc'), secret);
});

test('discovery log redaction strips signed URL queries and prefixed secrets', () => {
  const message = redact("https://example.com/team's/report?X-Amz-Signature=private-value " +
    'https://u:p@example.com/x#frag client_secret=private-client db_password=private-db');
  for (const value of ['private-value', 'u:p', 'frag', 'private-client', 'private-db']) {
    assert.ok(!message.includes(value), `${value} leaked: ${message}`);
  }
  assert.ok(message.includes("https://example.com/team's/report"), message);
});
