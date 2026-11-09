/** Evidence normalisation and summary for Proofcard DSH. */

import { redact } from './redact.js';

export const FAILURE_MARKERS = [
  'exit code: 1', 'exit code: 2', 'exit code: 3', 'exit code: 127', 'returncode: 1',
  'traceback (most recent call last)', 'command not found', 'no such file or directory',
  'permission denied', '0 passed', 'failed', 'failure', 'error:', 'is not recognized as',
  'fatal:', 'assertionerror', 'npm err!', 'segmentation fault',
];

const TERMINAL_HINTS = ['bash', 'pwsh', 'shell', 'terminal', 'exec', 'process', 'run_code'];
const WRITE_HINTS = ['write', 'edit', 'patch', 'apply', 'create', 'append', 'replace'];
const READ_HINTS = ['read', 'search', 'glob', 'grep', 'find', 'list'];
const WEB_HINTS = ['web', 'fetch', 'http', 'url', 'download', 'browser', 'curl'];
const SEND_HINTS = ['send', 'email', 'message', 'telegram', 'discord', 'slack', 'notify', 'post'];

const EXIT_RE = /(?:exit\s*code|returncode|return\s*code)\s*[:=]?\s*(-?\d{1,3})/i;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function classifyTool(name) {
  const lowered = String(name || '').toLowerCase();
  const caps = [];
  if (TERMINAL_HINTS.some((hint) => lowered.includes(hint))) caps.push('terminal');
  if (WRITE_HINTS.some((hint) => lowered.includes(hint))) caps.push('write');
  if (READ_HINTS.some((hint) => lowered.includes(hint))) caps.push('read');
  if (WEB_HINTS.some((hint) => lowered.includes(hint))) caps.push('web');
  if (SEND_HINTS.some((hint) => lowered.includes(hint))) caps.push('send');
  if (caps.length === 0) caps.push('other');
  return caps;
}

export function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function bounded(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return redact(String(text || '').slice(0, limit * 4)).slice(0, limit);
}

function argDict(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: args };
    } catch {
      return { value: args };
    }
  }
  return {};
}

function recordCommand(args) {
  for (const key of ['command', 'cmd', 'shell_command', 'script', 'argv', 'args']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return redact(value.trim().slice(0, 1600)).slice(0, 400);
    if (Array.isArray(value) && value.length) return redact(value.map(String).join(' ').slice(0, 1600)).slice(0, 400);
  }
  return null;
}

function recordFiles(args) {
  const found = [];
  for (const key of ['path', 'file', 'file_path', 'paths', 'files', 'target', 'target_path', 'old_path', 'new_path', 'filename', 'destination']) {
    const value = args[key];
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) found.push(...value.filter((item) => typeof item === 'string'));
  }
  const unique = [];
  const seen = new Set();
  for (const raw of found) {
    const path = redact(String(raw).trim().slice(0, 960)).slice(0, 240);
    if (path && !seen.has(path)) {
      seen.add(path);
      unique.push(path);
    }
  }
  return unique.slice(0, 20);
}

function recordUrl(args) {
  for (const key of ['url', 'uri', 'href', 'endpoint']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return redact(value.trim().slice(0, 2000)).slice(0, 500);
  }
  return null;
}

function exitCode(result, args) {
  const match = String(result || '').match(EXIT_RE);
  if (match) return Number(match[1]);
  for (const key of ['exit_code', 'returncode', 'return_code']) {
    const value = args[key];
    if (Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

function failureState(isError, result) {
  if (isError) return [false, 'tool reported an error'];
  const lowered = String(result || '').toLowerCase();
  const cleaned = lowered
    .replace(/\b0\s+(?:failed|failures?|errors?)\b/g, ' ')
    .replace(/\bno\s+(?:failures?|errors?|failed)\b/g, ' ');
  if (/\b[1-9]\d*\s+passed\b/.test(cleaned) && !/\b[1-9]\d*\s+failed\b/.test(cleaned)) return [true, null];
  for (const marker of FAILURE_MARKERS) {
    if (cleaned.includes(marker)) return [false, marker];
  }
  return [true, null];
}

export function normalizeToolCall(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const name = String(input.name || '').trim();
  if (!name || name.toLowerCase().startsWith('proofcard_')) return null;
  const args = argDict(input.arguments ?? input.args);
  const result = bounded(input.resultText, 2000);
  const [ok, failureReason] = failureState(Boolean(input.isError), result);
  let parsedExit = exitCode(result, args);
  if (parsedExit !== null && parsedExit !== 0) {
    // keep ok=false when the tool reported a failing exit code
  }
  const resolvedOk = parsedExit !== null && parsedExit !== 0 ? false : ok;
  return {
    id: String(input.callId || `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    tool: name,
    caps: classifyTool(name),
    args_text: bounded(JSON.stringify(args), 600),
    result,
    ok: resolvedOk,
    failure_reason: resolvedOk ? null : (failureReason || `exit code ${parsedExit}`),
    error: input.error ? bounded(JSON.stringify(input.error), 500) : null,
    duration_ms: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
    at: Date.now() / 1000,
    command: recordCommand(args),
    files: recordFiles(args),
    url: recordUrl(args),
    exit_code: parsedExit,
  };
}

export function summarizeEvidence(items) {
  const tools = [];
  const files = [];
  const commands = [];
  const seenTools = new Set();
  const seenFiles = new Set();
  const seenCommands = new Set();
  let duration = 0;
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.tool === 'string' && !seenTools.has(item.tool)) {
      seenTools.add(item.tool);
      tools.push(item.tool);
    }
    for (const path of item.files || []) {
      if (typeof path === 'string' && !seenFiles.has(path)) {
        seenFiles.add(path);
        files.push(path);
      }
    }
    if (typeof item.command === 'string' && item.command.trim()) {
      const command = redact(item.command);
      const key = command.split(/\s+/).join(' ').toLowerCase();
      if (!seenCommands.has(key)) {
        seenCommands.add(key);
        commands.push({ command: command.slice(0, 400), exit_code: item.exit_code ?? null, ok: Boolean(item.ok) });
      }
    }
    if (Number.isFinite(item.duration_ms) && item.duration_ms > 0) duration += item.duration_ms;
  }
  return {
    tools_used: tools.slice(0, 40),
    files_touched: files.slice(0, 80),
    commands: commands.slice(0, 20),
    duration_ms: duration,
    evidence_count: (items || []).length,
  };
}
