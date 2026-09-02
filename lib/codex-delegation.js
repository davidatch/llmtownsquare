'use strict';

/** OpenAI Codex's native task-to-task delegation envelope. */

const DELEGATION_RE =
  /^<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*?)<\/input>\s*<\/codex_delegation>$/;

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function delegatedPrompt(sourceThreadId, input) {
  const source = String(sourceThreadId || '').trim();
  if (!source) throw new Error('native delegation requires a source thread id');
  return (
    '<codex_delegation>\n' +
    `  <source_thread_id>${escapeXml(source)}</source_thread_id>\n` +
    `  <input>${escapeXml(input ?? '')}</input>\n` +
    '</codex_delegation>'
  );
}

function parseDelegation(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(DELEGATION_RE);
  if (!match) return undefined;
  const sourceThreadId = unescapeXml(match[1]).trim();
  if (!sourceThreadId) return undefined;
  return { sourceThreadId, input: unescapeXml(match[2]) };
}

module.exports = { delegatedPrompt, parseDelegation };
