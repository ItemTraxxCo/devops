import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSettings,
  evaluate,
  buildTotalsQuery,
  buildBreakdownQuery,
  sanitizeCell,
  normalizeBreakdown,
  renderMarkdown,
} from './edge-error-rate.mjs';

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
  assert.throws(() => resolveSettings(policy, { bridge_source: "x' OR 1=1 --" }), /must be one of/);
});

test('bridge_source resolves to a program literal, not the configured string', () => {
  const settings = resolveSettings(policy, { bridge_source: 'cloudflare_http_requests' });
  // Same text, but the object identity is the allowlist entry rather than the
  // value that came out of the policy file.
  assert.equal(settings.bridge_source, 'cloudflare_http_requests');
  assert.ok(buildTotalsQuery(settings).includes("'cloudflare_http_requests'"));
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

test('a query cell cannot inject a step output or break the summary table', () => {
  assert.equal(sanitizeCell('ok\nalert=true'), 'ok alert=true');
  assert.equal(sanitizeCell('a|b'), 'a\\|b');
  assert.equal(sanitizeCell(null), '');
  assert.equal(sanitizeCell('x'.repeat(500)).length, 200);
});

test('query results are normalised into a fixed shape', () => {
  const rows = normalizeBreakdown([['504', 'itemtraxx.com', '/', 12]]);
  assert.deepEqual(rows, [{ status: '504', zone: 'itemtraxx.com', path: '/', errors: 12 }]);
});

test('normalising tolerates a malformed or oversized response', () => {
  assert.deepEqual(normalizeBreakdown(null), []);
  assert.deepEqual(normalizeBreakdown([[]]), [{ status: '', zone: '', path: '', errors: 0 }]);
  assert.equal(normalizeBreakdown(Array.from({ length: 50 }, () => ['504', 'z', '/', 1])).length, 15);
});

test('a hostile path in the response cannot escape the summary table', () => {
  const settings = resolveSettings(policy);
  const verdict = evaluate({ gatewayErrors: 20, totalRequests: 150 }, settings);
  const markdown = renderMarkdown(verdict, normalizeBreakdown([['504', 'z', '/a|b\n| evil |', 3]]), settings);
  const tableRows = markdown.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(tableRows.length, 3); // header, separator, one data row
});
