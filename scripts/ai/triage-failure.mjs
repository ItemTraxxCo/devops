/**
 * CI failure triage: deterministic ownership classification plus optional
 * AI root-cause analysis of failed workflow logs.
 *
 * Env:
 *   LOGS_PATH          concatenated failed-job logs (required)
 *   CONTEXT_PATH       run context JSON: {repository, run_id, run_url,
 *                      workflow_name, branch, sha, failed_jobs[]} (required)
 *   OUTPUT_PATH        triage markdown destination (required)
 *   PROMPT_PATH        prompt template override (optional)
 *   AI_API_KEY         enables AI analysis (optional; NVIDIA NIM or Anthropic)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askModel, hasApiKey, renderPrompt } from './llm-client.mjs';
import { classifyOwnership } from '../alerts/ownership.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_LOG_CHARS = 40000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function sanitizeText(value, maxLength = 4000) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .slice(0, maxLength);
}

const logsPath = requireEnv('LOGS_PATH');
const contextPath = requireEnv('CONTEXT_PATH');
const outputPath = requireEnv('OUTPUT_PATH');
const promptPath = process.env.PROMPT_PATH || resolve(HERE, '../../prompts/workflow-failure-triage.md');

const context = JSON.parse(readFileSync(contextPath, 'utf8'));
const fullLogs = readFileSync(logsPath, 'utf8');
const logs = fullLogs.length > MAX_LOG_CHARS ? fullLogs.slice(-MAX_LOG_CHARS) : fullLogs;

const ownership = classifyOwnership(logs);

const lines = [];
lines.push(`## CI failure triage: ${context.workflow_name || 'unknown workflow'}`);
lines.push('');
lines.push(`- **Run:** ${context.run_url || 'n/a'}`);
lines.push(`- **Branch:** \`${context.branch || 'unknown'}\` at \`${(context.sha || '').slice(0, 7) || 'unknown'}\``);
lines.push(`- **Failed jobs:** ${(context.failed_jobs || []).map((j) => `\`${j}\``).join(', ') || 'none detected'}`);
lines.push(`- **Likely ownership area:** ${ownership.area}`);
if (ownership.signals.length > 0) {
  lines.push(`- **Signals:** ${ownership.signals.map((s) => `\`${s}\``).join(', ')}`);
}
lines.push('');

let aiSection;
if (hasApiKey()) {
  try {
    const template = readFileSync(promptPath, 'utf8');
    const user = renderPrompt(template, {
      WORKFLOW_NAME: context.workflow_name || 'unknown',
      RUN_URL: context.run_url || 'n/a',
      BRANCH: context.branch || 'unknown',
      FAILED_JOBS: (context.failed_jobs || []).join(', ') || 'none',
      OWNERSHIP: ownership.area,
      LOGS: logs,
    });
    const answer = await askModel({ user, maxTokens: 4000 });
    aiSection = `### AI analysis\n\n${sanitizeText(answer, 6000)}`;
  } catch (err) {
    aiSection = `### AI analysis\n\n_AI triage failed (${sanitizeText(err.message || err, 200)}); deterministic triage above still applies._`;
  }
} else {
  aiSection = '### AI analysis\n\n_Skipped: AI_API_KEY is not configured for this repository._';
}
lines.push(aiSection);
lines.push('');

writeFileSync(outputPath, lines.join('\n'));
console.log(`Triage written to ${outputPath} (ownership: ${ownership.area}, ai: ${hasApiKey()})`);
