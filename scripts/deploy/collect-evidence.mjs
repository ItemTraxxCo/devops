/**
 * Deploy evidence bundle builder. Composes run, commit, and health data
 * (already fetched into WORKDIR) into evidence.json + evidence.md, with an
 * optional AI deploy-impact summary.
 *
 * Env:
 *   WORKDIR            directory containing run.json, commit.json, health.json (required)
 *   REPOSITORY         owner/repo (required)
 *   RUN_ID             deploy run id (required)
 *   SHA                deployed commit sha (required)
 *   WORKFLOW_NAME      deploy workflow name (optional)
 *   SURFACES           comma-separated deploy surfaces (optional)
 *   PROMPT_PATH        prompt template override (optional)
 *   AI_API_KEY         enables AI impact summary (optional; NVIDIA NIM or Anthropic)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askModel, hasApiKey, renderPrompt } from '../ai/llm-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const workdir = requireEnv('WORKDIR');
const repository = requireEnv('REPOSITORY');
const runId = requireEnv('RUN_ID');
const sha = requireEnv('SHA');
const workflowName = process.env.WORKFLOW_NAME || 'unknown';
const surfaces = (process.env.SURFACES || 'unknown').split(',').map((s) => s.trim()).filter(Boolean);
const promptPath = process.env.PROMPT_PATH || resolve(HERE, '../../prompts/deploy-impact-summary.md');

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(workdir, name), 'utf8'));
  } catch {
    return null;
  }
}

const run = readJson('run.json');
const commit = readJson('commit.json');
const health = readJson('health.json');

const evidence = {
  generated_at: new Date().toISOString(),
  repository,
  run: {
    id: runId,
    name: run?.name || workflowName,
    url: run?.html_url || null,
    conclusion: run?.conclusion || null,
    started_at: run?.run_started_at || null,
    completed_at: run?.updated_at || null,
    branch: run?.head_branch || null,
  },
  sha,
  surfaces,
  commit: {
    message: commit?.commit?.message || null,
    author: commit?.commit?.author || null,
    date: commit?.commit?.date || null,
    files: commit?.files || [],
  },
  health: health || { url: null, http_status: null },
  ai_summary: null,
};

if (hasApiKey()) {
  try {
    const template = readFileSync(promptPath, 'utf8');
    const user = renderPrompt(template, {
      WORKFLOW_NAME: workflowName,
      SURFACES: surfaces.join(', ') || 'unknown',
      COMMIT_MESSAGE: evidence.commit.message || '(unavailable)',
      FILES: evidence.commit.files.map((f) => `${f.status} ${f.filename}`).slice(0, 200).join('\n') || '(unavailable)',
      HEALTH: JSON.stringify(evidence.health),
    });
    evidence.ai_summary = await askModel({ user, maxTokens: 1000 });
  } catch (err) {
    evidence.ai_summary = `AI summary failed: ${String(err.message || err).slice(0, 200)}`;
  }
}

const shortSha = sha.slice(0, 7);
const md = [];
md.push(`## Deploy evidence: ${workflowName}`);
md.push('');
md.push(`- **Repository:** ${repository}`);
md.push(`- **Commit:** \`${shortSha}\` on \`${evidence.run.branch || 'unknown'}\``);
md.push(`- **Run:** ${evidence.run.url || `run ${runId}`} (${evidence.run.conclusion || 'unknown'})`);
md.push(`- **Surfaces:** ${surfaces.join(', ') || 'unknown'}`);
md.push(`- **Health probe:** ${evidence.health.url || 'n/a'} → HTTP ${evidence.health.http_status || 'n/a'}`);
md.push(`- **Generated:** ${evidence.generated_at}`);
md.push('');
if (evidence.commit.message) {
  md.push('### Commit');
  md.push('');
  md.push('```');
  md.push(evidence.commit.message.slice(0, 1000));
  md.push('```');
  md.push('');
}
if (evidence.commit.files.length > 0) {
  md.push(`### Changed files (${evidence.commit.files.length})`);
  md.push('');
  for (const file of evidence.commit.files.slice(0, 50)) {
    md.push(`- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`);
  }
  if (evidence.commit.files.length > 50) {
    md.push(`- …and ${evidence.commit.files.length - 50} more`);
  }
  md.push('');
}
if (evidence.ai_summary) {
  md.push('### Deploy impact summary (AI)');
  md.push('');
  md.push(evidence.ai_summary);
  md.push('');
} else {
  md.push('_AI impact summary skipped: AI_API_KEY is not configured for this repository._');
  md.push('');
}

writeFileSync(join(workdir, 'evidence.json'), JSON.stringify(evidence, null, 2));
writeFileSync(join(workdir, 'evidence.md'), md.join('\n'));
console.log(`Evidence bundle written to ${workdir} (ai: ${Boolean(evidence.ai_summary)})`);
