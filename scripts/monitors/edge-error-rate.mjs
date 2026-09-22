/**
 * Edge gateway-error monitor.
 *
 * Synthetic probes run from GitHub-hosted runners cannot observe Cloudflare
 * edge faults: the managed firewall challenges the runner (HTTP 403
 * `cf-mitigated: challenge`) before the edge would serve the fault, so a probe
 * sees a healthy-looking challenge while real clients receive 502/504. This
 * monitor closes that blind spot by reading the Cloudflare Logpush records the
 * log bridge already ships to PostHog, where the edge status code is recorded
 * as observed by real traffic.
 *
 * Usage:
 *   node edge-error-rate.mjs [--config config/policy.json] [--window-minutes N]
 *
 * Env:
 *   POSTHOG_API_KEY     personal API key with query:read; absent = clean skip
 *   POSTHOG_PROJECT_ID  numeric PostHog project id
 *   POSTHOG_HOST        defaults to https://us.posthog.com
 *   GITHUB_OUTPUT       when set, `alert=`/`summary=`/`results=` are appended
 *   GITHUB_STEP_SUMMARY when set, a markdown report is appended
 *
 * Exits 1 when the alert threshold is breached so callers can wire their
 * existing failure-notification path to the job result.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  enabled: true,
  window_minutes: 30,
  statuses: [502, 504],
  min_errors: 10,
  min_error_rate: 0.02,
  min_requests: 1,
  bridge_source: 'cloudflare_http_requests',
  severity: 'high',
};

export function resolveSettings(policy, overrides = {}) {
  const configured = policy?.monitors?.edge_error_rate ?? {};
  const settings = { ...DEFAULTS, ...configured, ...overrides };

  if (!Number.isInteger(settings.window_minutes) || settings.window_minutes <= 0) {
    throw new Error('monitors.edge_error_rate.window_minutes must be a positive integer');
  }
  if (!Array.isArray(settings.statuses) || settings.statuses.length === 0) {
    throw new Error('monitors.edge_error_rate.statuses must be a non-empty array');
  }
  // Statuses are interpolated into HogQL, so only accept real status codes.
  if (settings.statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error('monitors.edge_error_rate.statuses must be integer HTTP status codes');
  }
  if (!Number.isInteger(settings.min_errors) || settings.min_errors < 1) {
    throw new Error('monitors.edge_error_rate.min_errors must be a positive integer');
  }
  if (typeof settings.min_error_rate !== 'number' || settings.min_error_rate < 0 || settings.min_error_rate > 1) {
    throw new Error('monitors.edge_error_rate.min_error_rate must be between 0 and 1');
  }
  if (!Number.isInteger(settings.min_requests) || settings.min_requests < 1) {
    throw new Error('monitors.edge_error_rate.min_requests must be a positive integer');
  }
  if (!/^[a-z0-9_]+$/.test(String(settings.bridge_source))) {
    throw new Error('monitors.edge_error_rate.bridge_source must be a bare identifier');
  }

  return settings;
}

/**
 * The kill switch answers with 503, so a maintenance window must not read as an
 * outage. Callers keep 503 out of `statuses` by default; this guard keeps that
 * intent explicit if it is ever configured back in.
 *
 * An empty window is an alert, not a clean bill of health. The Cloudflare
 * http_requests Logpush job stopped delivering on 2026-09-14 and the resulting
 * absence of edge 504s was read as recovery for over a week, when in truth the
 * edge had simply stopped being observed. A monitor that cannot see its subject
 * must say so rather than report zero errors.
 */
export function evaluate(totals, settings) {
  const { gatewayErrors, totalRequests } = totals;

  if (totalRequests < settings.min_requests) {
    return {
      alert: true,
      stale: true,
      gatewayErrors,
      totalRequests,
      errorRate: 0,
      breachedCount: false,
      breachedRate: false,
    };
  }

  const errorRate = gatewayErrors / totalRequests;
  const breachedCount = gatewayErrors >= settings.min_errors;
  const breachedRate = errorRate >= settings.min_error_rate;

  return {
    alert: breachedCount && breachedRate,
    stale: false,
    gatewayErrors,
    totalRequests,
    errorRate,
    breachedCount,
    breachedRate,
  };
}

function statusList(statuses) {
  return statuses.map((status) => `'${status}'`).join(', ');
}

export function buildTotalsQuery(settings) {
  return `
SELECT
  countIf(attributes['http.status_code'] IN (${statusList(settings.statuses)})) AS gateway_errors,
  count() AS total_requests
FROM logs
WHERE timestamp > now() - INTERVAL ${settings.window_minutes} MINUTE
  AND attributes['bridge.source'] = '${settings.bridge_source}'`.trim();
}

export function buildBreakdownQuery(settings) {
  return `
SELECT
  attributes['http.status_code'] AS status,
  attributes['cloudflare.zone'] AS zone,
  attributes['http.path'] AS path,
  count() AS errors
FROM logs
WHERE timestamp > now() - INTERVAL ${settings.window_minutes} MINUTE
  AND attributes['bridge.source'] = '${settings.bridge_source}'
  AND attributes['http.status_code'] IN (${statusList(settings.statuses)})
GROUP BY status, zone, path
ORDER BY errors DESC
LIMIT 15`.trim();
}

async function runQuery(query, { host, projectId, apiKey }) {
  const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`PostHog query failed (HTTP ${res.status}): ${detail.slice(0, 500)}`);
  }

  const payload = await res.json();
  return Array.isArray(payload?.results) ? payload.results : [];
}

export function renderMarkdown(verdict, breakdown, settings) {
  const lines = ['## Edge gateway-error monitor', ''];
  lines.push(
    `Window: last ${settings.window_minutes} min · statuses: ${settings.statuses.join(', ')} · ` +
      `threshold: >=${settings.min_errors} errors and >=${(settings.min_error_rate * 100).toFixed(1)}% of requests`,
  );
  lines.push('');
  if (verdict.stale) {
    lines.push(
      `❌ **No edge request telemetry in the last ${settings.window_minutes} min.** The Cloudflare ` +
        `\`${settings.bridge_source}\` Logpush feed is not delivering, so edge health is currently unobservable. ` +
        'This is reported as a failure on purpose: an absent signal is not a healthy one.',
    );
  } else if (verdict.alert) {
    lines.push(
      `❌ **Edge gateway errors above threshold.** ${verdict.gatewayErrors} of ${verdict.totalRequests} edge requests ` +
        `(${(verdict.errorRate * 100).toFixed(1)}%) returned a gateway error.`,
    );
  } else {
    lines.push(
      `✅ ${verdict.gatewayErrors} of ${verdict.totalRequests} edge requests ` +
        `(${(verdict.errorRate * 100).toFixed(1)}%) returned a gateway error.`,
    );
  }

  if (breakdown.length > 0) {
    lines.push('');
    lines.push('| Status | Zone | Path | Errors |');
    lines.push('| --- | --- | --- | --- |');
    for (const [status, zone, path, errors] of breakdown) {
      lines.push(`| ${status} | ${zone} | ${path} | ${errors} |`);
    }
  }

  return lines.join('\n');
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function parseArgs(argv) {
  const overrides = {};
  let configPath = 'config/policy.json';

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') {
      configPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--window-minutes') {
      overrides.window_minutes = Number.parseInt(argv[i + 1], 10);
      i += 1;
    }
  }

  return { configPath, overrides };
}

async function main() {
  const argv = process.argv.slice(2);
  const { configPath, overrides } = parseArgs(argv);

  let policy = {};
  try {
    policy = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read monitor policy from ${configPath}: ${err.message}`);
  }

  const settings = resolveSettings(policy, overrides);
  if (settings.enabled === false) {
    console.log('Edge gateway-error monitor disabled in policy; skipping.');
    return;
  }

  const apiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/+$/, '');

  // Matches the hub's AI features: a missing key degrades to a clean skip
  // rather than failing the caller's workflow.
  if (!apiKey || !projectId) {
    console.log('POSTHOG_API_KEY or POSTHOG_PROJECT_ID not set; skipping edge gateway-error monitor.');
    writeOutput('alert', 'false');
    writeOutput('summary', 'skipped: PostHog credentials not configured');
    return;
  }

  const client = { host, projectId, apiKey };
  const [totalsRow] = await runQuery(buildTotalsQuery(settings), client);
  const totals = {
    gatewayErrors: Number(totalsRow?.[0] ?? 0),
    totalRequests: Number(totalsRow?.[1] ?? 0),
  };

  const verdict = evaluate(totals, settings);
  const breakdown = verdict.gatewayErrors > 0 ? await runQuery(buildBreakdownQuery(settings), client) : [];

  const markdown = renderMarkdown(verdict, breakdown, settings);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  const summary = verdict.stale
    ? `no edge request telemetry in the last ${settings.window_minutes} min (${settings.bridge_source} feed not delivering)`
    : `${verdict.gatewayErrors} gateway errors of ${verdict.totalRequests} edge requests ` +
      `(${(verdict.errorRate * 100).toFixed(1)}%) in the last ${settings.window_minutes} min`;

  writeOutput('alert', String(verdict.alert));
  writeOutput('summary', summary);
  writeOutput('results', JSON.stringify({ ...verdict, breakdown }));

  if (verdict.alert) {
    console.error(verdict.stale ? `Edge telemetry stale: ${summary}` : `Edge gateway-error threshold breached: ${summary}`);
    process.exit(1);
  }
}

// Only run when executed directly, so the evaluation helpers stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
