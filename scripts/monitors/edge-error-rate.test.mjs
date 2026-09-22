import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSettings, evaluate, buildTotalsQuery, buildBreakdownQuery } from './edge-error-rate.mjs';

const policy = JSON.parse(
  await (await import('node:fs/promises')).readFile(new URL('../../config/policy.json', import.meta.url), 'utf8'),
);

test('hub policy produces usable monitor settings', () => {
  const settings = resolveSettings(policy);
  assert.equal(settings.window_minutes, 30);
  assert.deepEqual(settings.statuses, [502, 504]);
});

test('503 stays out of the default statuses so the kill switch is not an outage', () => {
  assert.ok(!resolveSettings(policy).statuses.includes(503));
});

test('rejects settings that would be interpolated unsafely into HogQL', () => {
  assert.throws(() => resolveSettings(policy, { statuses: ["504' OR 1=1 --"] }), /integer HTTP status codes/);
  assert.throws(() => resolveSettings(policy, { window_minutes: 0 }), /positive integer/);
});

test('queries only ever carry validated integers', () => {
  const settings = resolveSettings(policy);
  for (const query of [buildTotalsQuery(settings), buildBreakdownQuery(settings)]) {
    assert.match(query, /IN \('502', '504'\)/);
    assert.match(query, /INTERVAL 30 MINUTE/);
  }
});

test('the September 13 outage rate breaches the threshold', () => {
  // Observed in the log bridge: roughly 10 gateway errors per 15 minutes
  // against roughly 75 edge requests, sustained for about 29 hours.
  const verdict = evaluate({ gatewayErrors: 20, totalRequests: 150 }, resolveSettings(policy));
  assert.equal(verdict.alert, true);
  assert.ok(verdict.errorRate > 0.1);
});

test('a quiet edge does not alert', () => {
  assert.equal(evaluate({ gatewayErrors: 0, totalRequests: 400 }, resolveSettings(policy)).alert, false);
});

test('a handful of errors in heavy traffic does not alert', () => {
  const verdict = evaluate({ gatewayErrors: 12, totalRequests: 20000 }, resolveSettings(policy));
  assert.equal(verdict.breachedCount, true);
  assert.equal(verdict.breachedRate, false);
  assert.equal(verdict.alert, false);
});

test('a high rate on a tiny sample does not alert', () => {
  assert.equal(evaluate({ gatewayErrors: 2, totalRequests: 3 }, resolveSettings(policy)).alert, false);
});

test('an empty window alerts as stale telemetry, never as a healthy edge', () => {
  // The cloudflare_http_requests feed stopped on 2026-09-14; the resulting
  // absence of 504s was read as recovery for over a week.
  const verdict = evaluate({ gatewayErrors: 0, totalRequests: 0 }, resolveSettings(policy));
  assert.equal(verdict.stale, true);
  assert.equal(verdict.alert, true);
});

test('a healthy window is not marked stale', () => {
  assert.equal(evaluate({ gatewayErrors: 0, totalRequests: 400 }, resolveSettings(policy)).stale, false);
});
