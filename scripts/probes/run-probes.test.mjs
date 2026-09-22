import test from 'node:test';
import assert from 'node:assert/strict';

import { cloudflareChallenge, failureDetail } from './run-probes.mjs';

test('recognises a Cloudflare managed challenge', () => {
  assert.equal(cloudflareChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' } }), true);
});

test('a plain 403 is a real rejection, not a challenge', () => {
  assert.equal(cloudflareChallenge({ status: 403, headers: {} }), false);
});

test('a gateway error is never mistaken for a challenge', () => {
  assert.equal(cloudflareChallenge({ status: 504, headers: { 'cf-mitigated': 'challenge' } }), false);
});

test('tolerates a response with no headers', () => {
  assert.equal(cloudflareChallenge({ status: 403 }), false);
  assert.equal(cloudflareChallenge(undefined), false);
});

test('an instant gateway error is reported as edge-served', () => {
  const detail = failureDetail({ status: 504, durationMs: 4 }, 3);
  assert.match(detail, /HTTP 504 after 3 attempts/);
  assert.match(detail, /without reaching the origin/);
});

test('a slow gateway error carries its elapsed time', () => {
  assert.match(failureDetail({ status: 502, durationMs: 14800 }, 3), /14800 ms/);
});

test('non-gateway failures keep the plain detail', () => {
  assert.equal(failureDetail({ status: 404, durationMs: 12 }, 3), 'HTTP 404 after 3 attempts');
});
