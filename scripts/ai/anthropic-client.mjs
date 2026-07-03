/**
 * Minimal Anthropic Messages API client for CI scripts.
 * No dependencies; requires Node >= 18 (global fetch).
 *
 * Env:
 *   ANTHROPIC_API_KEY  required for askClaude()
 *   ITX_AI_MODEL       optional model override (default: claude-sonnet-5)
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function askClaude({ system, user, model, maxTokens = 1500, timeoutMs = 90000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const resolvedModel = model || process.env.ITX_AI_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Anthropic API returned ${res.status}: ${detail}`);
    }

    const data = await res.json();
    return (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Replace {{NAME}} placeholders in a prompt template. */
export function renderPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : ''
  );
}

/**
 * Extract the first JSON object from a model response that may wrap it
 * in markdown fences or prose. Returns null when nothing parses.
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced ? fenced[1] : null, text].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try next candidate
    }
  }
  return null;
}
