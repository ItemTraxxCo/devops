/**
 * PR risk review: classifies a pull request into ItemTraxx risk categories
 * from changed file paths, with an optional AI narrative.
 *
 * Env:
 *   PR_JSON_PATH       PR metadata JSON: {number, title, body, base, head,
 *                      additions, deletions, changed_files} (required)
 *   FILES_JSON_PATH    changed files JSON: [{filename, status, additions,
 *                      deletions}] (required)
 *   DIFF_PATH          truncated unified diff (required)
 *   OUTPUT_DIR         destination for comment.md + labels.txt (required)
 *   PROMPT_PATH        prompt template override (optional)
 *   AI_API_KEY         enables AI narrative (optional; NVIDIA NIM or Anthropic)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askModel, extractJson, hasApiKey, renderPrompt } from './llm-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER = '<!-- itx-pr-risk-review -->';
const MAX_DIFF_CHARS = 150000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const pr = JSON.parse(readFileSync(requireEnv('PR_JSON_PATH'), 'utf8'));
const files = JSON.parse(readFileSync(requireEnv('FILES_JSON_PATH'), 'utf8'));
const diff = readFileSync(requireEnv('DIFF_PATH'), 'utf8').slice(0, MAX_DIFF_CHARS);
const outputDir = requireEnv('OUTPUT_DIR');
const promptPath = process.env.PROMPT_PATH || resolve(HERE, '../../prompts/pr-risk-review.md');

const CATEGORIES = [
  {
    label: 'risk:auth-sensitive',
    name: 'Auth-sensitive',
    test: (p) =>
      /src\/router\//.test(p) ||
      /authState|sessionTermination|verification|login|logout|password|mfa|jwt|session/i.test(p) ||
      /supabase\/functions\/[^/]*(auth|admin|verify|session)[^/]*\//i.test(p),
  },
  {
    label: 'risk:tenant-boundary',
    name: 'Tenant-boundary-sensitive',
    test: (p) => /tenant|district/i.test(p) && /^(src|supabase)\//.test(p),
  },
  {
    label: 'risk:edge-ingress',
    name: 'Edge-ingress-sensitive',
    test: (p) =>
      p.startsWith('cloudflare/edge-proxy/') ||
      /edgeFunctionClient/.test(p) ||
      p.startsWith('supabase/functions/_shared/'),
  },
  {
    label: 'risk:database',
    name: 'Database (SQL / RLS)',
    test: (p) => p.startsWith('supabase/sql/'),
  },
  {
    label: 'risk:legal-compliance',
    name: 'Legal / compliance text',
    test: (p) => /legal|privacy|dpa|terms|subprocessor|compliance/i.test(p),
  },
  {
    label: 'risk:deploy-config',
    name: 'Deploy / CI configuration',
    test: (p) =>
      p.startsWith('.github/') ||
      /wrangler\.toml|supabase\/config\.toml|vercel\.json|Dockerfile/.test(p) ||
      /^scripts\/deploy/.test(p),
  },
  {
    label: 'risk:dependencies',
    name: 'Dependencies',
    test: (p) => /(^|\/)package(-lock)?\.json$|(^|\/)deno\.lock$/.test(p),
  },
];

const paths = files.map((f) => f.filename);
const matched = new Map();
for (const category of CATEGORIES) {
  const hits = paths.filter((p) => category.test(p));
  if (hits.length > 0) {
    matched.set(category.label, { ...category, hits });
  }
}

const frontendOnly =
  matched.size === 0 &&
  paths.length > 0 &&
  paths.every((p) => /^(src|public)\//.test(p) || p === 'index.html');
if (frontendOnly) {
  matched.set('risk:frontend-only', {
    label: 'risk:frontend-only',
    name: 'Frontend-only',
    hits: paths,
  });
}

let ai = null;
let aiNote = '';
if (hasApiKey()) {
  try {
    const template = readFileSync(promptPath, 'utf8');
    const user = renderPrompt(template, {
      TITLE: pr.title || '',
      BASE: pr.base || '',
      FILES: paths.slice(0, 200).join('\n'),
      CATEGORIES: [...matched.values()].map((c) => c.name).join(', ') || 'none matched',
      DIFF: diff,
    });
    const answer = await askModel({ user, maxTokens: 1200 });
    ai = extractJson(answer);
    if (!ai) {
      aiNote = '_AI reviewer returned an unparseable response; deterministic classification above still applies._';
    }
  } catch (err) {
    aiNote = `_AI review failed (${String(err.message || err).slice(0, 200)}); deterministic classification above still applies._`;
  }
} else {
  aiNote = '_AI narrative skipped: AI_API_KEY is not configured for this repository._';
}

const lines = [];
lines.push(MARKER);
lines.push('## PR risk review');
lines.push('');
if (matched.size === 0) {
  lines.push('No risk categories matched the changed files.');
} else {
  lines.push('| Category | Matched files |');
  lines.push('| --- | --- |');
  for (const category of matched.values()) {
    const sample = category.hits.slice(0, 3).map((h) => `\`${h}\``).join(', ');
    const more = category.hits.length > 3 ? ` (+${category.hits.length - 3} more)` : '';
    lines.push(`| ${category.name} | ${sample}${more} |`);
  }
}
lines.push('');

if (ai) {
  lines.push(`**Overall risk (AI):** ${ai.overall_risk || 'unknown'}`);
  lines.push('');
  if (ai.summary) {
    lines.push(String(ai.summary));
    lines.push('');
  }
  if (Array.isArray(ai.review_focus) && ai.review_focus.length > 0) {
    lines.push('**Review focus:**');
    for (const item of ai.review_focus.slice(0, 6)) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }
  if (Array.isArray(ai.missing_tests) && ai.missing_tests.length > 0) {
    lines.push('**Possibly missing tests:**');
    for (const item of ai.missing_tests.slice(0, 6)) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }
} else if (aiNote) {
  lines.push(aiNote);
  lines.push('');
}

lines.push('---');
lines.push('_Generated by the ItemTraxx DevOps hub (`reusable-pr-risk-review`)._');

writeFileSync(join(outputDir, 'comment.md'), lines.join('\n'));
writeFileSync(join(outputDir, 'labels.txt'), [...matched.keys()].join('\n'));
console.log(`Risk review complete: ${[...matched.keys()].join(', ') || 'no categories'} (ai: ${Boolean(ai)})`);
