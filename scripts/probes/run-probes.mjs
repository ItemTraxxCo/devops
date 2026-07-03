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
 *     "bodyContains": "kill_switch",        // optional substring assertion
 *     "attempts": 3,                         // default 3
 *     "backoffMs": 1000,                     // default 1000, doubles per retry
 *     "allowKillSwitchSkip": true            // default false
 *   }]
 * }
 */

import { readFileSync, appendFileSync } from 'node:fs';

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
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, body: text.slice(0, 4096), error: null };
  } catch (err) {
    return { status: 0, body: '', error: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
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

function retryable(status) {
  return status === 0 || status >= 500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runProbe(probe, config) {
  const attempts = probe.attempts ?? 3;
  let backoff = probe.backoffMs ?? 1000;
  let last = { status: 0, body: '', error: 'not run' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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

    if (!retryable(last.status)) break;

    if (last.status === 503 && probe.allowKillSwitchSkip && (await killSwitchActive(config))) {
      return {
        name: probe.name,
        url: probe.url,
        outcome: 'skipped',
        httpStatus: last.status,
        attempts: attempt,
        detail: 'Kill switch active; intentional maintenance skip.',
      };
    }

    if (attempt < attempts) {
      await sleep(backoff);
      backoff *= 2;
    }
  }

  if (retryable(last.status)) {
    return {
      name: probe.name,
      url: probe.url,
      outcome: 'fail',
      httpStatus: last.status,
      attempts,
      detail: last.error || `HTTP ${last.status} after ${attempts} attempts`,
    };
  }

  if (!statusAccepted(last.status, probe.expect)) {
    return {
      name: probe.name,
      url: probe.url,
      outcome: 'fail',
      httpStatus: last.status,
      attempts: 1,
      detail: `HTTP ${last.status} not in expected set ${JSON.stringify(probe.expect ?? { statusRange: [200, 399] })}`,
    };
  }

  if (probe.bodyContains && !last.body.includes(probe.bodyContains)) {
    return {
      name: probe.name,
      url: probe.url,
      outcome: 'fail',
      httpStatus: last.status,
      attempts: 1,
      detail: `Body does not contain "${probe.bodyContains}"`,
    };
  }

  return {
    name: probe.name,
    url: probe.url,
    outcome: 'pass',
    httpStatus: last.status,
    attempts: 1,
    detail: 'ok',
  };
}

function renderMarkdown(results) {
  const icon = { pass: '✅', fail: '❌', skipped: '⏭️' };
  const lines = ['## Synthetic probe results', '', '| Probe | Outcome | HTTP | Detail |', '| --- | --- | --- | --- |'];
  for (const r of results.probes) {
    lines.push(`| ${r.name} | ${icon[r.outcome] || ''} ${r.outcome} | ${r.httpStatus} | ${r.detail} |`);
  }
  lines.push('');
  lines.push(`**${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped.**`);
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const validateOnly = argv.includes('--validate');

  const config = loadConfig(argv.filter((a) => a !== '--validate'));
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
    console.log(`   ${result.outcome} (HTTP ${result.httpStatus}): ${result.detail}`);
    probeResults.push(result);
  }

  const results = {
    total: probeResults.length,
    passed: probeResults.filter((r) => r.outcome === 'pass').length,
    failed: probeResults.filter((r) => r.outcome === 'fail').length,
    skipped: probeResults.filter((r) => r.outcome === 'skipped').length,
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

await main();
