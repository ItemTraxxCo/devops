/**
 * Deterministic ownership classification for ItemTraxx CI/deploy failures.
 * Maps failure log text to the most likely surface so alerts and triage
 * summaries carry an ownership hint even without AI.
 */

const RULES = [
  {
    area: 'Cloudflare Worker (edge proxy)',
    pattern: /wrangler|cloudflare|edge-proxy|kv namespace|worker\.js|10021/gi,
  },
  {
    area: 'Supabase Edge Functions',
    pattern: /supabase functions|supabase\/functions|deno (check|test|lint)|edge function|functions\/v1/gi,
  },
  {
    area: 'Vite app (frontend build)',
    pattern: /vue-tsc|vite build|rollup|bundle budget|chunk size|perf:budget|perf:images/gi,
  },
  {
    area: 'E2E tests (Playwright)',
    pattern: /playwright|test:e2e|chromium/gi,
  },
  {
    area: 'Env/config drift',
    pattern: /VITE_[A-Z_]+ is (not set|missing|undefined)|env parity|required-env|missing environment variable/gi,
  },
  {
    area: 'Kill-switch state',
    pattern: /kill switch|kill_switch|maintenance mode/gi,
  },
  {
    area: 'Security tooling',
    pattern: /npm audit|codeql|security-audit|audit-level|vulnerabilit/gi,
  },
  {
    area: 'Database (SQL / RLS)',
    pattern: /supabase\/sql|postgres|row level security|\brls\b|migration/gi,
  },
];

/**
 * @param {string} text Failure log text.
 * @returns {{ area: string, signals: string[] }}
 */
export function classifyOwnership(text) {
  const input = String(text || '');
  let best = { area: 'Unknown (inspect run logs)', score: 0, signals: [] };

  for (const rule of RULES) {
    const matches = input.match(rule.pattern) || [];
    if (matches.length > best.score) {
      const signals = [...new Set(matches.map((m) => m.toLowerCase()))].slice(0, 5);
      best = { area: rule.area, score: matches.length, signals };
    }
  }

  return { area: best.area, signals: best.signals };
}
