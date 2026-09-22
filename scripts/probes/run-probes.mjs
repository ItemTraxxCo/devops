/**
 * Config-driven synthetic HTTP probe runner with retries and ItemTraxx
 * kill-switch awareness.
 *
 * Usage:
 *   node run-probes.mjs [config.json]          run probes
 *   node run-probes.mjs --validate config.json validate config only
 *
 * Env:
 *   PROBES_CONFIG_JSON   inline JSON config; overrides the config file
 *   GITHUB_OUTPUT        when set, `results=<json>` is appended
 *   GITHUB_STEP_SUMMARY  when set, a markdown table is appended
 *
 * Config schema:
 * {
 *   "statusUrl": "https://edge.example.com/functions/system-status",
 *   "origin": "https://example.com",
 *   "probes": [{
 *     "name": "public-site",
 *     "url": "https://example.com",
 *     "method": "GET",                      // default GET
 *     "headers": {"Accept": "text/html"},  // optional
 *     "body": "{\"plan\":\"core\"}",       // optional string
 *     "expect": {"status": [200]},          // or {"statusRange": [200, 499]}
 *     "retryStatus": [403],                 // optional extra statuses to retry
 *     "bodyContains": "kill_switch",        // optional substring assertion
 *     "attempts": 3,                         // default 3
 *     "backoffMs": 1000,                     // default 1000, doubles per retry
 *     "allowKillSwitchSkip": true            // default false
 *   }]
 * }
 *
 * Outcomes: `pass`, `fail`, `skipped` (kill switch) and `challenged`.
 * Cloudflare's managed firewall challenges non-browser clients such as
 * GitHub-hosted runners, so a challenged probe answered from the edge but
 * never reached the application: its assertion is unverified, not satisfied.
 * Challenges do not fail the run — they are the normal case from CI — but they
 * are reported separately so a run that verified nothing cannot read as a
 * clean pass. Edge faults that a challenged probe cannot see are covered by
 * scripts/monitors/edge-error-rate.mjs, which reads real client outcomes.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 ItemTraxxProbe/1.0';

function loadConfig(argv) {
  const inline = process.env.PROBES_CONFIG_JSON;
  if (inline && inline.trim()) {
    return JSON.parse(inline);
  }
  const filePath = argv.find((a) => !a.startsWith('--'));
  if (!filePath) {
    throw new Error('No config: pass a config file path or set PROBES_CONFIG_JSON');
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function normalizeHttpUrl(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${fieldName} must use http or https`);
  }
  return url.toString();
}

function normalizeOrigin(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${fieldName} must use http or https`);
  }
  return url.origin;
}

function normalizeOptionalString(value, fieldName, maxLength = 1024) {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.slice(0, maxLength);
}

function normalizeHeaders(headers, fieldName) {
  if (headers == null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) {
      throw new Error(`${fieldName} contains an invalid header name`);
    }
    if (typeof value !== 'string') {
      throw new Error(`${fieldName}.${key} must be a string`);
    }
    normalized[key] = value.slice(0, 512);
  }
  return normalized;
}

function normalizeExpect(expect, fieldName) {
  if (expect == null) return undefined;
  if (typeof expect !== 'object' || Array.isArray(expect)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const normalized = {};
  if (expect.status !== undefined) {
    if (!Array.isArray(expect.status) || expect.status.some((status) => !Number.isInteger(status))) {
      throw new Error(`${fieldName}.status must be an array of integers`);
    }
    normalized.status = expect.status;
  }
  if (expect.statusRange !== undefined) {
    if (
      !Array.isArray(expect.statusRange) ||
      expect.statusRange.length !== 2 ||
      expect.statusRange.some((status) => !Number.isInteger(status))
    ) {
      throw new Error(`${fieldName}.statusRange must be [min, max]`);
    }
    normalized.statusRange = expect.statusRange;
  }
  return normalized;
}

function normalizeConfig(rawConfig) {
  const probes = Array.isArray(rawConfig?.probes) ? rawConfig.probes : [];
  return {
    statusUrl: rawConfig?.statusUrl ? normalizeHttpUrl(rawConfig.statusUrl, 'statusUrl') : undefined,
    origin: rawConfig?.origin ? normalizeOrigin(rawConfig.origin, 'origin') : undefined,
    probes: probes.map((probe, index) => ({
      name: normalizeOptionalString(probe?.name, `probes[${index}].name`, 128),
      url: normalizeHttpUrl(probe?.url, `probes[${index}].url`),
      method: normalizeOptionalString(probe?.method, `probes[${index}].method`, 16)?.toUpperCase() || 'GET',
      headers: normalizeHeaders(probe?.headers, `probes[${index}].headers`),
      body: normalizeOptionalString(probe?.body, `probes[${index}].body`, 4096),
      expect: normalizeExpect(probe?.expect, `probes[${index}].expect`),
      retryStatus: normalizeStatusList(probe?.retryStatus, `probes[${index}].retryStatus`),
      bodyContains: normalizeOptionalString(probe?.bodyContains, `probes[${index}].bodyContains`, 256),
      attempts: Number.isInteger(probe?.attempts) ? probe.attempts : 3,
      backoffMs: Number.isInteger(probe?.backoffMs) ? probe.backoffMs : 1000,
      allowKillSwitchSkip: probe?.allowKillSwitchSkip === true,
      userAgent: normalizeOptionalString(probe?.userAgent, `probes[${index}].userAgent`, 256),
    })),
  };
}

function normalizeStatusList(value, fieldName) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((status) => !Number.isInteger(status))) {
    throw new Error(`${fieldName} must be an array of integers`);
  }
  return value;
}

function validateConfig(config) {
  const errors = [];
  if (!Array.isArray(config.probes) || config.probes.length === 0) {
    errors.push('probes must be a non-empty array');
  }
  for (const [i, probe] of (config.probes || []).entries()) {
    if (!probe.name) errors.push(`probes[${i}].name is required`);
    if (!probe.url || !/^https?:\/\//.test(probe.url)) {
      errors.push(`probes[${i}].url must be an http(s) URL`);
    }
    if (probe.expect?.status && !Array.isArray(probe.expect.status)) {
      errors.push(`probes[${i}].expect.status must be an array`);
    }
    if (probe.expect?.statusRange && probe.expect.statusRange.length !== 2) {
      errors.push(`probes[${i}].expect.statusRange must be [min, max]`);
    }
  }
  return errors;
}

async function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return {
      status: res.status,
      body: text.slice(0, 4096),
      headers: Object.fromEntries(res.headers),
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    return {
      status: 0,
      body: '',
      headers: {},
      durationMs: Date.now() - startedAt,
      error: String(err.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const GATEWAY_STATUSES = [502, 503, 504];

export function cloudflareChallenge(res) {
  return res?.status === 403 && /challenge/i.test(res?.headers?.['cf-mitigated'] || '');
}

/**
 * A gateway error returned in milliseconds was produced by the edge itself;
 * a genuine upstream timeout takes seconds. Surfacing the elapsed time keeps
 * that distinction in the alert instead of leaving it to be rediscovered.
 */
export function failureDetail(res, attempts) {
  const base = `HTTP ${res.status} after ${attempts} attempts`;
  if (!GATEWAY_STATUSES.includes(res.status)) return base;
  return `${base} (gateway error in ${res.durationMs} ms; a sub-second gateway error means the edge answered without reaching the origin)`;
}

async function killSwitchActive(config) {
  if (!config.statusUrl) return false;
  const res = await httpRequest(config.statusUrl, {
    headers: { Accept: 'application/json', Origin: config.origin || '' },
  });
  if (res.status < 200 || res.status >= 300) return false;
  try {
    return JSON.parse(res.body)?.kill_switch?.enabled === true;
  } catch {
    return false;
  }
}

function statusAccepted(status, expect) {
  if (expect?.status) return expect.status.includes(status);
  if (expect?.statusRange) {
    const [min, max] = expect.statusRange;
    return status >= min && status <= max;
  }
  return status >= 200 && status < 400;
}

function retryable(status, probe) {
  return status === 0 || status >= 500 || probe.retryStatus.includes(status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runProbe(probe, config) {
  const attempts = probe.attempts ?? 3;
  let backoff = probe.backoffMs ?? 1000;
  let last = { status: 0, body: '', error: 'not run' };
  let attemptCount = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptCount = attempt;
    last = await httpRequest(probe.url, {
      method: probe.method || 'GET',
      headers: {
        'User-Agent': probe.userAgent || DEFAULT_UA,
        ...(config.origin ? { Origin: config.origin } : {}),
        ...(probe.body ? { 'Content-Type': 'application/json' } : {}),
        ...(probe.headers || {}),
      },
      body: probe.body,
    });

    // Retrying a challenge only burns backoff: it is a stable verdict.
    if (cloudflareChallenge(last)) break;

    if (!retryable(last.status, probe)) break;

    if (last.status === 503 && probe.allowKillSwitchSkip && (await killSwitchActive(config))) {
      return {
        name: probe.name,
        url: probe.url,
        outcome: 'skipped',
        httpStatus: last.status,
        attempts: attempt,
        durationMs: last.durationMs,
        detail: 'Kill switch active; intentional maintenance skip.',
      };
    }

    if (attempt < attempts) {
      await sleep(backoff);
      backoff *= 2;
    }
  }

  if (cloudflareChallenge(last) && !statusAccepted(last.status, probe.expect)) {
    return {
        name: probe.name,
        url: probe.url,
        outcome: 'challenged',
        httpStatus: last.status,
        attempts: attemptCount,
        durationMs: last.durationMs,
        detail: 'Cloudflare challenged this request; the probe assertion was not evaluated.',
      };
  }

  if (retryable(last.status, probe)) {
    return {
        name: probe.name,
        url: probe.url,
        outcome: 'fail',
        httpStatus: last.status,
        attempts: attemptCount,
        durationMs: last.durationMs,
        detail: last.error || failureDetail(last, attempts),
      };
  }

  if (!statusAccepted(last.status, probe.expect)) {
    return {
        name: probe.name,
        url: probe.url,
        outcome: 'fail',
        httpStatus: last.status,
        attempts: attemptCount,
        durationMs: last.durationMs,
        detail: `HTTP ${last.status} not in expected set ${JSON.stringify(probe.expect ?? { statusRange: [200, 399] })}`,
      };
  }

  if (probe.bodyContains && !last.body.includes(probe.bodyContains)) {
    return {
        name: probe.name,
        url: probe.url,
        outcome: 'fail',
        httpStatus: last.status,
        attempts: attemptCount,
        durationMs: last.durationMs,
        detail: `Body does not contain "${probe.bodyContains}"`,
      };
  }

  return {
    name: probe.name,
    url: probe.url,
    outcome: 'pass',
    httpStatus: last.status,
    attempts: attemptCount,
    durationMs: last.durationMs,
    detail: 'ok',
  };
}

function renderMarkdown(results) {
  const icon = { pass: '✅', fail: '❌', skipped: '⏭️', challenged: '🛡️' };
  const lines = [
    '## Synthetic probe results',
    '',
    '| Probe | Outcome | HTTP | ms | Detail |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of results.probes) {
    lines.push(
      `| ${r.name} | ${icon[r.outcome] || ''} ${r.outcome} | ${r.httpStatus} | ${r.durationMs ?? ''} | ${r.detail} |`,
    );
  }
  lines.push('');
  lines.push(
    `**${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped, ${results.challenged} challenged.**`,
  );

  if (results.passed === 0 && results.challenged > 0) {
    lines.push('');
    lines.push(
      '> ⚠️ Every non-skipped probe was challenged by Cloudflare, so this run verified nothing about edge health. ' +
        'Treat it as inconclusive rather than green. Edge faults that challenges hide are covered by the edge ' +
        'gateway-error monitor, which reads real client outcomes from the log bridge.',
    );
  }

  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const validateOnly = argv.includes('--validate');

  const config = normalizeConfig(loadConfig(argv.filter((a) => a !== '--validate')));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('Invalid probe config:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  if (validateOnly) {
    console.log(`Probe config OK (${config.probes.length} probes).`);
    return;
  }

  const probeResults = [];
  for (const probe of config.probes) {
    console.log(`== probe: ${probe.name} (${probe.url})`);
    const result = await runProbe(probe, config);
    console.log(`   ${result.outcome} (HTTP ${result.httpStatus}, ${result.durationMs} ms): ${result.detail}`);
    probeResults.push(result);
  }

  const results = {
    total: probeResults.length,
    passed: probeResults.filter((r) => r.outcome === 'pass').length,
    failed: probeResults.filter((r) => r.outcome === 'fail').length,
    skipped: probeResults.filter((r) => r.outcome === 'skipped').length,
    challenged: probeResults.filter((r) => r.outcome === 'challenged').length,
    probes: probeResults,
  };

  const markdown = renderMarkdown(results);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  console.log(markdown);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `results=${JSON.stringify(results)}\n`);
  }

  if (results.failed > 0) {
    process.exit(1);
  }
}

// Only run when executed directly, so the classification helpers stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
