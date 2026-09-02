'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { parseDelegation } = require('./codex-delegation');

const PROVIDER_ID = 'llmtownsquare_bridge';
const PROVIDER_MODEL = 'townsquare-bridge';
const PROVIDER_HEADER = 'x-llmtownsquare-token';
const PROXY_SOURCE_PREFIX = 'townsquare_claude_proxy:';
const BOOTSTRAP_PROMPT = 'Initialize the native Claude transport proxy.';
const RUNTIME_CONTEXT_RE = /^<(?:app-context|skills_instructions|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|recommended_plugins|environment_context)>/;
const NATIVE_DELEGATION_TOOL = 'send_message_to_thread';
const NATIVE_DELEGATION_NAMESPACES = new Set(['codex_app', 'codex_tui']);

function providerConfig(baseUrl, token) {
  return {
    name: 'LLM Town Square Bridge',
    base_url: String(baseUrl).replace(/\/$/, ''),
    wire_api: 'responses',
    requires_openai_auth: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    http_headers: { [PROVIDER_HEADER]: token },
  };
}

async function ensureProviderToken(file) {
  try {
    const current = (await fs.promises.readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(current)) return current;
  } catch {}
  const directory = path.dirname(file);
  const created = await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory()) throw new Error(`provider token path is not a directory: ${directory}`);
  if (created !== undefined) await fs.promises.chmod(directory, 0o700).catch(() => {});
  const token = crypto.randomBytes(32).toString('hex');
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await fs.promises.rename(temporary, file);
  await fs.promises.chmod(file, 0o600).catch(() => {});
  return token;
}

function proxySource(sessionId) {
  return `${PROXY_SOURCE_PREFIX}${encodeURIComponent(String(sessionId))}`;
}

function proxySessionId(threadSource) {
  if (typeof threadSource !== 'string' || !threadSource.startsWith(PROXY_SOURCE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(threadSource.slice(PROXY_SOURCE_PREFIX.length)) || undefined;
  } catch {
    return undefined;
  }
}

function latestUserText(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type !== 'message' || item?.role !== 'user' || !Array.isArray(item.content)) continue;
    const texts = item.content
      .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
      .map((part) => part.text);
    if (texts.length) return texts.join('');
  }
  return undefined;
}

function functionOutputTexts(output) {
  if (typeof output === 'string') return [output];
  if (!Array.isArray(output)) return [];
  return output
    .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text);
}

/** Find the current native task-tool delegation without replaying an older Responses turn. */
function latestDelegation(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let itemIndex = input.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = input[itemIndex];
    if (item?.type === 'function_call_output') {
      if (
        item.name !== NATIVE_DELEGATION_TOOL ||
        !NATIVE_DELEGATION_NAMESPACES.has(item.namespace)
      ) return undefined;
      const texts = functionOutputTexts(item.output);
      for (let textIndex = texts.length - 1; textIndex >= 0; textIndex -= 1) {
        const delegation = parseDelegation(texts[textIndex]);
        if (delegation) return delegation;
      }
      return undefined;
    }
    if (item?.type === 'message' && item?.role === 'user' && Array.isArray(item.content)) {
      const texts = item.content
        .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
        .map((part) => part.text);
      if (!texts.length || texts.every((text) => RUNTIME_CONTEXT_RE.test(text.trimStart()))) continue;
      return undefined;
    }
  }
  return undefined;
}

function turnMetadata(headers, body) {
  const header = headers?.['x-codex-turn-metadata'];
  const raw = Array.isArray(header) ? header[0] : header;
  const canonical = raw || body?.client_metadata?.['x-codex-turn-metadata'];
  if (typeof canonical !== 'string') return undefined;
  try {
    const parsed = JSON.parse(canonical);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function completedResponseSse(model = PROVIDER_MODEL) {
  const id = `resp_tsq_${crypto.randomBytes(12).toString('hex')}`;
  const created = { type: 'response.created', response: { id } };
  const completed = {
    type: 'response.completed',
    response: {
      id,
      model,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
  return `event: response.created\ndata: ${JSON.stringify(created)}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_MODEL,
  PROVIDER_HEADER,
  BOOTSTRAP_PROMPT,
  providerConfig,
  ensureProviderToken,
  proxySource,
  proxySessionId,
  latestUserText,
  latestDelegation,
  turnMetadata,
  completedResponseSse,
  safeTokenEqual,
};
