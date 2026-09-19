/*
 * LLM access: ChatGPT only, deliberately with no fallback provider.
 *
 * Every request goes to OpenAI's Responses API and is constrained server-side
 * to the caller's JSON shape (`text.format` structured outputs), so callers
 * always get the schema they asked for or an error — never a best-effort
 * answer from a different model. Nothing here does arithmetic — callers hand
 * over figures that are already computed.
 *
 * Configuration (with no key set, callers get LlmUnavailable and can still
 * show their own computed figures):
 *   OPENAI_API_KEY   enables ChatGPT (required for every AI feature)
 *   OPENAI_MODEL     pins the model  (default gpt-4.1)
 *
 * A caller that needs facts off the internet rather than off its own prompt
 * passes `webSearch: true` — ChatGPT runs the searches server-side through
 * the Responses API `web_search` tool. Requests carrying file attachments
 * (PDFs, images) ride as native `input_file` / `input_image` parts, so
 * attachment-heavy work like renewal pack analysis needs nothing else either.
 */

import OpenAI from 'openai';

export class LlmUnavailableError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.status = 503;
    this.code = 'llm_unavailable';
    this.attempts = attempts;
  }
}

const openaiKey = () => process.env.OPENAI_API_KEY || '';

export const openaiModel = () => process.env.OPENAI_MODEL || 'gpt-4.1';

/** Which provider this deployment can actually reach — ChatGPT or nothing. */
export function llmProviders() {
  return [
    { provider: 'openai', model: openaiModel(), configured: Boolean(openaiKey()) },
  ];
}

const firstJsonObject = (s) => {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in the response');
  return JSON.parse(s.slice(start, end + 1));
};

/** Server-side web search: ChatGPT runs the searches, nothing is fetched here. */
const WEB_SEARCH_TOOL = { type: 'web_search' };

// `reasoning.effort` is only accepted by reasoning model families (a pinned
// gpt-5, say); sending it to anything else — the default gpt-4.1 included —
// is a 400.
const supportsReasoning = (model) => /^(gpt-5|o\d)/.test(model);

/**
 * File attachments -> Responses API input parts. PDFs ride as input_file and
 * images as input_image, each preceded by a label so the model knows which
 * upload it is reading. Text-like files never come through here — callers
 * inline those into the prompt.
 */
function attachmentParts(attachments) {
  return attachments.flatMap((a) => [
    { type: 'input_text', text: a.label || `Attached file: ${a.filename}` },
    a.media_type === 'application/pdf'
      ? { type: 'input_file', filename: a.filename, file_data: `data:application/pdf;base64,${a.data}` }
      : { type: 'input_image', image_url: `data:${a.media_type};base64,${a.data}` },
  ]);
}

/** ChatGPT, constrained to the schema by the Responses API itself. */
async function callOpenai({ system, prompt, schema, schemaName, maxTokens, effort, webSearch, attachments = [] }) {
  const client = new OpenAI({ apiKey: openaiKey() });
  const model = openaiModel();
  const response = await client.responses.create({
    model,
    instructions: system,
    input: [{
      role: 'user',
      content: [...attachmentParts(attachments), { type: 'input_text', text: prompt }],
    }],
    max_output_tokens: maxTokens,
    ...(webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    ...(supportsReasoning(model) ? { reasoning: { effort } } : {}),
    text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
  });

  // A refusal comes back as a 200 with a refusal part instead of text.
  const refusal = (response.output || [])
    .flatMap((item) => (item.type === 'message' ? item.content || [] : []))
    .find((part) => part.type === 'refusal');
  if (refusal) throw new Error(`ChatGPT declined the request: ${refusal.refusal || 'unspecified'}`);
  if (response.status === 'incomplete') {
    throw new Error(`ChatGPT stopped before finishing (${response.incomplete_details?.reason || 'unknown'})`);
  }
  const body = (response.output_text || '').trim();
  if (!body) throw new Error('ChatGPT returned no content');
  return { data: firstJsonObject(body), model: response.model || model };
}

/**
 * Ask ChatGPT for a JSON object matching `schema`. Returns
 * { provider, model, data, attempts }; throws LlmUnavailableError when no key
 * is configured or the request failed — there is no fallback provider.
 *
 * `clients` is an injection point for tests — production passes nothing.
 */
export async function completeJson({
  system,
  prompt,
  schema,
  schemaName = 'analysis',
  maxTokens = 16000,
  effort = 'medium',
  webSearch = false,
  // Binary files (PDFs, images) as { filename, media_type, data (base64), label? }.
  attachments = [],
}, clients = {}) {
  const run = clients.openai || callOpenai;
  const configured = clients.openai ? true : Boolean(openaiKey());

  if (!configured) {
    throw new LlmUnavailableError(
      webSearch
        ? 'No AI provider is configured for internet research. Set OPENAI_API_KEY.'
        : 'No AI provider is configured. Set OPENAI_API_KEY.',
      [{ provider: 'openai', status: 'not_configured' }],
    );
  }
  try {
    const { data, model } = await run({ system, prompt, schema, schemaName, maxTokens, effort, webSearch, attachments });
    return { provider: 'openai', model, data, attempts: [{ provider: 'openai', status: 'ok' }] };
  } catch (e) {
    throw new LlmUnavailableError(
      `ChatGPT could not complete the request: ${e.message}`,
      [{ provider: 'openai', status: 'failed', error: e.message }],
    );
  }
}
