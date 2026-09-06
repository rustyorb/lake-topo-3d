/**
 * Provider-neutral LLM access for the optional enrichment steps (depth/geology recon,
 * chart-image reading). The app never depends on this: every fact it can get from
 * OpenStreetMap, 3DEP, IDNR or Wikipedia is fetched first.
 *
 * Configure with LLM_PROVIDER = none | anthropic | openai | openrouter | ollama | lmstudio | venice | gemini | custom
 * (auto-detected from whichever API key is set when unset), LLM_MODEL, LLM_VISION_MODEL,
 * LLM_BASE_URL (OpenAI-compatible base, e.g. http://localhost:11434/v1), LLM_API_KEY.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

export type ProviderName = 'none' | 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'venice' | 'gemini' | 'custom';

export interface LlmImage { base64: string; mimeType: string }

export interface LlmRequest {
  system: string;
  prompt: string;
  images?: LlmImage[];
  /** Ask the provider for JSON where it supports it; the result is always parsed leniently. */
  json?: boolean;
  /** Providers with native web search (gemini, anthropic) use it when true. */
  webSearch?: boolean;
  maxTokens?: number;
}

export interface LlmResult {
  text: string;
  provider: ProviderName;
  model: string;
  /** URLs the provider's search grounding cited, when available. */
  sources: Array<{ title: string; uri: string }>;
  searchGrounded: boolean;
}

const PLACEHOLDER = /^(MY_|your[-_])/i;
const env = (k: string) => { const v = process.env[k]; return v && !PLACEHOLDER.test(v) ? v : undefined; };

const DEFAULT_MODELS: Record<ProviderName, { text: string; vision: string; base?: string; keyVar?: string }> = {
  none: { text: '', vision: '' },
  anthropic: { text: 'claude-opus-5', vision: 'claude-opus-5', keyVar: 'ANTHROPIC_API_KEY' },
  openai: { text: 'gpt-5', vision: 'gpt-5', base: 'https://api.openai.com/v1', keyVar: 'OPENAI_API_KEY' },
  openrouter: { text: 'anthropic/claude-opus-5', vision: 'anthropic/claude-opus-5', base: 'https://openrouter.ai/api/v1', keyVar: 'OPENROUTER_API_KEY' },
  ollama: { text: 'llama3.1', vision: 'llava', base: 'http://localhost:11434/v1' },
  lmstudio: { text: 'local-model', vision: 'local-model', base: 'http://localhost:1234/v1' },
  venice: { text: 'llama-3.3-70b', vision: 'qwen-2.5-vl', base: 'https://api.venice.ai/api/v1', keyVar: 'VENICE_API_KEY' },
  gemini: { text: 'gemini-3.5-flash', vision: 'gemini-3.1-flash-lite', keyVar: 'GEMINI_API_KEY' },
  custom: { text: 'default', vision: 'default' },
};

export function resolveProvider(): { provider: ProviderName; model: string; visionModel: string; baseUrl?: string; apiKey?: string } {
  let provider = (env('LLM_PROVIDER') || '').toLowerCase() as ProviderName;
  if (!provider) {
    if (env('ANTHROPIC_API_KEY')) provider = 'anthropic';
    else if (env('OPENAI_API_KEY')) provider = 'openai';
    else if (env('OPENROUTER_API_KEY')) provider = 'openrouter';
    else if (env('GEMINI_API_KEY')) provider = 'gemini';
    else if (env('VENICE_API_KEY')) provider = 'venice';
    else if (env('OLLAMA_BASE_URL')) provider = 'ollama';
    else if (env('LMSTUDIO_BASE_URL')) provider = 'lmstudio';
    else provider = 'none';
  }
  if (!(provider in DEFAULT_MODELS)) provider = 'none';
  const d = DEFAULT_MODELS[provider];
  const baseUrl =
    env('LLM_BASE_URL') ||
    (provider === 'ollama' ? env('OLLAMA_BASE_URL') : provider === 'lmstudio' ? env('LMSTUDIO_BASE_URL') : undefined) ||
    d.base;
  const apiKey = env('LLM_API_KEY') || (d.keyVar ? env(d.keyVar) : undefined);
  if (provider === 'custom' && !baseUrl) provider = 'none';
  if (d.keyVar && !apiKey && provider !== 'none') return { provider: 'none', model: '', visionModel: '' };
  return { provider, model: env('LLM_MODEL') || d.text, visionModel: env('LLM_VISION_MODEL') || env('LLM_MODEL') || d.vision, baseUrl, apiKey };
}

export function llmAvailable(): boolean {
  return resolveProvider().provider !== 'none';
}

export function llmDescription(): { provider: ProviderName; model: string; visionModel: string } {
  const r = resolveProvider();
  return { provider: r.provider, model: r.model, visionModel: r.visionModel };
}

/** Pulls the first balanced JSON object out of model output (handles ```json fences and prose). */
export function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(c.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return null;
}

async function fetchJson(url: string, init: RequestInit, ms: number): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 300)}`);
    return JSON.parse(body);
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------ providers

async function callOpenAICompatible(req: LlmRequest, cfg: ReturnType<typeof resolveProvider>): Promise<LlmResult> {
  const model = req.images?.length ? cfg.visionModel : cfg.model;
  const content: any[] = [];
  for (const img of req.images || []) content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
  content.push({ type: 'text', text: req.prompt });
  const body: any = {
    model,
    messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.images?.length ? content : req.prompt }],
    max_tokens: req.maxTokens ?? 4000,
    temperature: 0.2,
  };
  if (req.json && (cfg.provider === 'openai' || cfg.provider === 'openrouter' || cfg.provider === 'ollama')) body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/rustyorb/lake-topo-3d'; headers['X-Title'] = 'lake-topo-3d'; }
  const j = await fetchJson(`${cfg.baseUrl!.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, 180_000);
  const msg = j.choices?.[0]?.message;
  const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => p.text || '').join('') : '';
  return { text, provider: cfg.provider, model: j.model || model, sources: [], searchGrounded: false };
}

async function callAnthropic(req: LlmRequest, cfg: ReturnType<typeof resolveProvider>): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: env('LLM_BASE_URL') });
  const model = req.images?.length ? cfg.visionModel : cfg.model;
  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of req.images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: img.base64 } });
  }
  content.push({ type: 'text', text: req.prompt });
  const tools: Anthropic.Beta.BetaToolUnion[] = req.webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 } as Anthropic.Beta.BetaToolUnion] : [];
  const response = await client.beta.messages.create({
    model,
    max_tokens: req.maxTokens ?? 8000,
    system: req.system,
    messages: [{ role: 'user', content }],
    tools: tools.length ? tools : undefined,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  } as any);
  const sources: Array<{ title: string; uri: string }> = [];
  let text = '';
  for (const block of response.content as any[]) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === 'web_search_result' && r.url) sources.push({ title: r.title || r.url, uri: r.url });
    }
  }
  if ((response as any).stop_reason === 'refusal') throw new Error('model refused the request');
  return { text, provider: 'anthropic', model: (response as any).model || model, sources, searchGrounded: sources.length > 0 };
}

async function callGemini(req: LlmRequest, cfg: ReturnType<typeof resolveProvider>): Promise<LlmResult> {
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: { headers: { 'User-Agent': 'lake-topo-3d' } } });
  const model = req.images?.length ? cfg.visionModel : cfg.model;
  const parts: any[] = [];
  for (const img of req.images || []) parts.push({ inlineData: { data: img.base64, mimeType: img.mimeType } });
  parts.push({ text: `${req.system}\n\n${req.prompt}` });
  const config: any = {};
  if (req.webSearch) config.tools = [{ googleSearch: {} }];
  else if (req.json) config.responseMimeType = 'application/json';
  const response = await ai.models.generateContent({ model, contents: parts, config });
  const sources: Array<{ title: string; uri: string }> = [];
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (Array.isArray(chunks)) for (const ch of chunks) if (ch.web?.uri) sources.push({ title: ch.web.title || ch.web.uri, uri: ch.web.uri });
  return { text: response.text || '', provider: 'gemini', model, sources, searchGrounded: sources.length > 0 };
}

export async function complete(req: LlmRequest): Promise<LlmResult> {
  const cfg = resolveProvider();
  switch (cfg.provider) {
    case 'none':
      throw new Error('No LLM provider configured (set LLM_PROVIDER or an API key)');
    case 'anthropic':
      return callAnthropic(req, cfg);
    case 'gemini':
      return callGemini(req, cfg);
    default:
      return callOpenAICompatible(req, cfg);
  }
}
