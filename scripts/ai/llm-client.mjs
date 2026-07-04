/**
 * Minimal multi-provider LLM client for CI scripts.
 * No dependencies; requires Node >= 18 (global fetch).
 *
 * Providers:
 *   nvidia     NVIDIA NIM (OpenAI-compatible chat completions).
 *              Auto-selected when the key starts with "nvapi-".
 *   anthropic  Anthropic Messages API. Default for any other key.
 *
 * Env:
 *   AI_API_KEY         provider API key (ANTHROPIC_API_KEY accepted as legacy)
 *   ITX_AI_PROVIDER    force provider: "nvidia" | "anthropic" (optional)
 *   ITX_AI_MODEL       model override (optional)
 */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULT_MODELS = {
  nvidia: 'nvidia/nemotron-3-ultra-550b-a55b',
  anthropic: 'claude-sonnet-5',
};

export function getApiKey() {
  return process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
}

export function hasApiKey() {
  return Boolean(getApiKey());
}

export function resolveProvider(apiKey = getApiKey()) {
  const forced = (process.env.ITX_AI_PROVIDER || '').trim().toLowerCase();
  if (forced === 'nvidia' || forced === 'anthropic') return forced;
  return apiKey.startsWith('nvapi-') ? 'nvidia' : 'anthropic';
}

async function fetchJson(url, { headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`LLM API returned ${res.status}: ${detail}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function askModel({ system, user, model, maxTokens = 1500, timeoutMs = 120000 }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('AI_API_KEY is not set');
  }

  const provider = resolveProvider(apiKey);
  const resolvedModel = model || process.env.ITX_AI_MODEL || DEFAULT_MODELS[provider];

  if (provider === 'nvidia') {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const data = await fetchJson(NVIDIA_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: {
        model: resolvedModel,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages,
      },
      timeoutMs,
    });
    return String(data?.choices?.[0]?.message?.content ?? '').trim();
  }

  const data = await fetchJson(ANTHROPIC_URL, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: {
      model: resolvedModel,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }],
    },
    timeoutMs,
  });
  return (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
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
