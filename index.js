/**
 * Proofcard DSH — Host half.
 *
 * Observe-only proof receipts. The plugin watches the committed session log,
 * builds one receipt per completed turn from the claims in the assistant reply
 * plus the tool calls/results that actually happened, persists those receipts
 * in the profile's plugin data dir, and exposes them:
 *
 * - six agent tools (`proofcard_*`),
 * - one short prompt context telling the model to state claims concretely,
 * - JSON HTTP routes under `/proofcard` for the Client UI.
 *
 * Nothing here gates, rewrites, or delays a turn. Every callback is wrapped;
 * nothing in this module throws out of a session hook or a tool handler.
 */

import path from 'node:path';
import os from 'node:os';

import { ReceiptStore } from './store.js';
import { buildReceipt, receiptMarkdown, proposedChecks, runChecks } from './receipts.js';
import { normalizeToolCall } from './evidence.js';

export const inject = ['tools', 'systemPrompt', 'webServer'];

const PLUGIN_NAME = 'proofcard-dsh';
const PLUGIN_VERSION = '1.0.0';
const ROUTE_PREFIX = '/proofcard';
// webServer resource routes serve GET/HEAD only; mutating calls go through this
// prefix, served by a real Node handler so POST is not rejected with 405.
const ACTION_PREFIX = '/proofcard/actions';

/** Row defaults; also mirrored by cordis.patch.yml. */
const DEFAULTS = {
  dataDir: '',
  maxClaims: 12,
  storeToolOutput: true,
  retentionDays: 30,
  allowCommandRerun: false,
  ambientPrompt: true,
};

/** Kept under ~400 chars: it is ambient context injected into every request. */
const PROMPT_TEXT =
  'When you report finished work, state each completion claim concretely: the exact command you ran and its result, the files you created or changed, and any count. Proofcard re-checks those claims against the recorded session log after each turn, so never claim work that did not happen.';

// Bounds so a long session cannot grow plugin memory without limit.
const MAX_EVIDENCE_PER_TURN = 200;
const MAX_PENDING_CALLS = 200;
const MAX_SESSIONS = 64;
const MAX_RESULT_CHARS = 4000;
const MAX_ARGUMENT_CHARS = 4000;
const MAX_REQUEST_CHARS = 4000;
const MAX_ANSWER_CHARS = 16000;
const MAX_ID_CHARS = 200;

// ---------------------------------------------------------------------------
// Small, defensive helpers (core is trusted; the session feed is not).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function clampInt(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.trunc(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toTurn(value, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Read message text from a message, a `{ message }` wrapper, a text block, or a string. */
function messageText(value) {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return '';
  if (typeof value.text === 'string') return value.text;
  const direct = contentText(value.content);
  if (direct) return direct;
  if (isPlainObject(value.message)) return messageText(value.message);
  return '';
}

function eventPayload(event) {
  return isPlainObject(event) && isPlainObject(event.data) ? event.data : {};
}

function sessionIdOf(session) {
  if (!isPlainObject(session)) return '';
  if (typeof session.id === 'string') return clampText(session.id, MAX_ID_CHARS);
  if (typeof session.id === 'number') return String(session.id);
  return '';
}

function sessionCwd(session) {
  if (!isPlainObject(session) || !isPlainObject(session.header)) return '';
  const cwd = session.header.cwd;
  return typeof cwd === 'string' ? clampText(cwd, 1000) : '';
}

/** Debug-only reporting: silent unless PROOFCARD_DEBUG is set in the environment. */
function report(where, failure) {
  try {
    if (process.env.PROOFCARD_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[${PLUGIN_NAME}] ${where}:`, failure);
    }
  } catch {
    /* logging must never break the hook */
  }
}

/**
 * Tool output renderer. The tools pipeline calls `render(args, value)`, so the
 * second parameter is the executed result — the first is only the model's input
 * and must never be displayed as the output.
 */
function renderValue(_args, value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (typeof text !== 'string') text = '';
  return [{ type: 'text', text }];
}

function toolError(failure) {
  const message = isPlainObject(failure) && typeof failure.message === 'string' ? failure.message : String(failure ?? 'tool_failed');
  return { ok: false, error: clampText(message, 500) };
}

function challengeId() {
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 7);
  return `ch_${stamp}_${salt}`;
}

function normalizeConfig(config) {
  const raw = isPlainObject(config) ? config : {};
  const settings = { ...DEFAULTS };
  if (typeof raw.dataDir === 'string') settings.dataDir = raw.dataDir.trim();
  settings.maxClaims = clampInt(raw.maxClaims, DEFAULTS.maxClaims, 1, 50);
  if (raw.storeToolOutput === false) settings.storeToolOutput = false;
  settings.retentionDays = clampInt(raw.retentionDays, DEFAULTS.retentionDays, 0, 3650);
  if (raw.allowCommandRerun === true) settings.allowCommandRerun = true;
  if (raw.ambientPrompt === false) settings.ambientPrompt = false;
  if (raw.enabled === false) settings.enabled = false;
  return settings;
}

/** config.dataDir → DSH_PROFILE_DIR/proofcard → DSH_HOME/proofcard → ~/.dsh/proofcard */
function resolveDataDir(configured) {
  try {
    if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());
    const profileDir = process.env.DSH_PROFILE_DIR;
    if (typeof profileDir === 'string' && profileDir.trim()) return path.join(profileDir.trim(), 'proofcard');
    const dshHome = process.env.DSH_HOME;
    if (typeof dshHome === 'string' && dshHome.trim()) return path.join(dshHome.trim(), 'proofcard');
    return path.join(os.homedir(), '.dsh', 'proofcard');
  } catch (failure) {
    report('resolveDataDir', failure);
    return path.join(os.tmpdir(), 'proofcard-dsh');
  }
}

// ---------------------------------------------------------------------------
// Agent tools. Handlers always resolve to a plain JSON value and never throw.
// ---------------------------------------------------------------------------

function createToolDefinitions(store, settings) {
  const output = {
    schema: { type: 'object', additionalProperties: true },
    // DSH hands render the (args, value) pair; some call sites pass only the value.
    // Treat the second argument when present, otherwise the first, as the result value.
    render: (first, second) => renderValue(null, second === undefined ? first : second),
  };

  function summarizeReceipt(receipt) {
    const source = isPlainObject(receipt) ? receipt : {};
    const claims = Array.isArray(source.claims) ? source.claims : [];
    return {
      id: source.id,
      created_at: source.created_at,
      session_id: source.session_id,
      turn: source.turn,
      model: typeof source.model === 'string' ? source.model : '',
      stats: isPlainObject(source.stats) ? source.stats : {},
      accepted: source.accepted === true,
      claims: claims.map((claim) => {
        const entry = isPlainObject(claim) ? claim : {};
        return {
          id: entry.id,
          text: clampText(typeof entry.text === 'string' ? entry.text : '', 200),
          kind: entry.kind,
          verdict: entry.verdict,
        };
      }),
    };
  }

  /** `id` argument, else the newest receipt for the calling agent's session. */
  function allProposedChecks(receipt, claimId) {
    try {
      const checks = proposedChecks(receipt, claimId ?? undefined);
      return Array.isArray(checks) ? checks : [];
    } catch (failure) {
      report('proposedChecks', failure);
      return [];
    }
  }

  function resolveReceipt(args, exec) {
    const raw = isPlainObject(args) ? args : {};
    const explicitId = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (explicitId) return store.get(clampText(explicitId, MAX_ID_CHARS));
    const agent = isPlainObject(exec) && isPlainObject(exec.agent) ? exec.agent : undefined;
    const agentId = agent && typeof agent.id === 'string' ? agent.id : undefined;
    return store.latest(agentId);
  }

  function safeProposedChecks(receipt, claimId) {
    try {
      const checks = proposedChecks(receipt, claimId ?? undefined);
      if (!Array.isArray(checks)) return [];
      // Only file-oriented, self-declared safe checks may run from a challenge.
      return checks.filter((check) => !isPlainObject(check) || check.safe_to_run !== false);
    } catch (failure) {
      report('proposedChecks', failure);
      return [];
    }
  }

  function safeRunChecks(checks, receipt, allowCommands) {
    if (!Array.isArray(checks) || checks.length === 0) return [];
    try {
      const cwd = isPlainObject(receipt) && typeof receipt.cwd === 'string' ? receipt.cwd : '';
      const result = runChecks(checks, { cwd, allowCommands: allowCommands === true });
      return Array.isArray(result) ? result : [];
    } catch (failure) {
      report('runChecks', failure);
      return [];
    }
  }

  function recordChallenge(receipt, { claimId, run, note, checks, by }) {
    return store.appendChallenge(receipt.id, {
      id: challengeId(),
      at: Date.now(),
      by,
      claim_id: claimId,
      run,
      note,
      checks,
    });
  }

  return [
    {
      name: 'proofcard_list',
      description:
        'List Proofcard receipts for this session or all sessions. A receipt records the completion claims from one finished turn, their verdicts (verified, partial, unverified, contradicted), and the tool evidence behind them.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum receipts to return (default 20).' },
          session_id: { type: 'string', description: 'Only receipts from this session id. Omit to list every session.' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        try {
          const raw = isPlainObject(args) ? args : {};
          const limit = clampInt(raw.limit, 20, 1, 100);
          const sessionId = typeof raw.session_id === 'string' && raw.session_id.trim() ? raw.session_id.trim() : undefined;
          const receipts = store.list(limit, sessionId);
          const latest = store.latest(sessionId);
          return {
            ok: true,
            count: receipts.length,
            session_id: sessionId ?? null,
            latest_id: isPlainObject(latest) ? latest.id ?? null : null,
            receipts: receipts.map(summarizeReceipt),
          };
        } catch (failure) {
          return toolError(failure);
        }
      },
    },
    {
      name: 'proofcard_show',
      description:
        'Show one Proofcard receipt in full, including every claim, its evidence, and a markdown summary. Omit id to show the latest receipt for this session.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Receipt id such as rc_20261107_171500_ab12. Omit for the latest receipt.' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        try {
          const receipt = resolveReceipt(args, exec);
          if (!isPlainObject(receipt)) return { ok: false, error: 'receipt_not_found' };
          let markdown = '';
          try {
            markdown = String(receiptMarkdown(receipt) ?? '');
          } catch (failure) {
            report('receiptMarkdown', failure);
          }
          return { ok: true, id: receipt.id, receipt, markdown };
        } catch (failure) {
          return toolError(failure);
        }
      },
    },
    {
      name: 'proofcard_accept',
      description:
        'Accept a Proofcard receipt as an accurate record of a finished turn. Omit id to accept the latest receipt for this session.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Receipt id. Omit for the latest receipt.' },
          note: { type: 'string', description: 'Optional short note recorded with the acceptance.' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        try {
          const raw = isPlainObject(args) ? args : {};
          const receipt = resolveReceipt(raw, exec);
          if (!isPlainObject(receipt)) return { ok: false, error: 'receipt_not_found' };
          const note = clampText(typeof raw.note === 'string' ? raw.note : '', 2000);
          const accepted = store.accept(receipt.id, note, 'agent');
          if (!isPlainObject(accepted)) return { ok: false, error: 'accept_failed', id: receipt.id };
          return {
            ok: true,
            id: accepted.id,
            accepted: accepted.accepted === true,
            accepted_at: accepted.accepted_at ?? null,
            receipt: summarizeReceipt(accepted),
          };
        } catch (failure) {
          return toolError(failure);
        }
      },
    },
    {
      name: 'proofcard_challenge',
      description:
        'Challenge a Proofcard receipt or one claim in it. Without run, this records the challenge together with the proposed read-only checks. With run=true, it also re-checks those checks (commands only when this profile allows reruns) and records the results on the receipt.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Receipt id. Omit for the latest receipt.' },
          claim_id: { type: 'string', description: 'Only challenge this claim id. Omit to challenge the whole receipt.' },
          run: { type: 'boolean', description: 'Re-check the proposed safe file assertions on disk before recording the challenge.' },
          note: { type: 'string', description: 'Optional short note recorded with the challenge.' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        try {
          const raw = isPlainObject(args) ? args : {};
          const receipt = resolveReceipt(raw, exec);
          if (!isPlainObject(receipt)) return { ok: false, error: 'receipt_not_found' };
          const claimId = typeof raw.claim_id === 'string' && raw.claim_id.trim() ? raw.claim_id.trim() : null;
          const run = raw.run === true;
          // A challenge always carries the proposal; run=true additionally executes the safe checks.
          const proposed = safeProposedChecks(receipt, claimId);
          const checks = run ? safeRunChecks(proposed, receipt, settings.allowCommandRerun) : proposed;
          const updated = recordChallenge(receipt, {
            claimId,
            run,
            note: clampText(typeof raw.note === 'string' ? raw.note : '', 2000),
            checks,
            by: 'agent',
          });
          if (!isPlainObject(updated)) return { ok: false, error: 'challenge_failed', id: receipt.id };
          return { ok: true, id: updated.id, claim_id: claimId, run, checks, receipt: summarizeReceipt(updated) };
        } catch (failure) {
          return toolError(failure);
        }
      },
    },
    {
      name: 'proofcard_stats',
      description: 'Show Proofcard verdict totals and claim-kind counts across recent receipts.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      async execute() {
        try {
          const stats = store.stats(100);
          const source = isPlainObject(stats) ? stats : {};
          return { ok: true, totals: isPlainObject(source.totals) ? source.totals : {}, by_kind: isPlainObject(source.by_kind) ? source.by_kind : {} };
        } catch (failure) {
          return toolError(failure);
        }
      },
    },
    {
      name: 'proofcard_export',
      description:
        'Export a Proofcard receipt as markdown (default) or JSON so it can be pasted into a report or saved elsewhere. Omit id to export the latest receipt for this session.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Receipt id. Omit for the latest receipt.' },
          format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format; markdown by default.' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        try {
          const raw = isPlainObject(args) ? args : {};
          const receipt = resolveReceipt(raw, exec);
          if (!isPlainObject(receipt)) return { ok: false, error: 'receipt_not_found' };
          const format = raw.format === 'json' ? 'json' : 'markdown';
          let content = '';
          if (format === 'json') {
            content = JSON.stringify(receipt, null, 2);
          } else {
            try {
              content = String(receiptMarkdown(receipt) ?? '');
            } catch (failure) {
              report('receiptMarkdown', failure);
            }
          }
          return { ok: true, id: receipt.id, format, content };
        } catch (failure) {
          return toolError(failure);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  if (!isPlainObject(ctx)) return;
  const settings = normalizeConfig(config);
  if (settings.enabled === false) return;

  let store;
  let dataDir;
  try {
    dataDir = resolveDataDir(settings.dataDir);
    store = new ReceiptStore(dataDir);
  } catch (failure) {
    report('ReceiptStore', failure);
    return;
  }

  function service(name) {
    try {
      if (typeof ctx.get === 'function') return ctx.get(name);
      return ctx[name];
    } catch (failure) {
      report(`ctx.get(${name})`, failure);
      return undefined;
    }
  }

  /** Owning-context effect: every registration is removed when the plugin unloads. */
  function ownEffect(run) {
    try {
      if (typeof ctx.effect === 'function') return ctx.effect(run);
      const disposer = run();
      if (typeof ctx.on === 'function' && typeof disposer === 'function') ctx.on('dispose', disposer);
      return disposer;
    } catch (failure) {
      report('ctx.effect', failure);
      return undefined;
    }
  }

  // Retention runs once at activation; appends never evict inside a turn.
  try {
    if (typeof store.prune === 'function') store.prune(settings.retentionDays);
  } catch (failure) {
    report('store.prune', failure);
  }

  // ----- session capture ---------------------------------------------------

  const sessions = new Map();

  function evictOldestSession() {
    let oldestKey = '';
    let oldestSeen = Infinity;
    for (const [key, value] of sessions) {
      if (value.lastSeen < oldestSeen) {
        oldestSeen = value.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey) sessions.delete(oldestKey);
  }

  function sessionState(session, sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        turn: 0,
        cwd: '',
        model: '',
        userRequest: '',
        answer: '',
        pending: new Map(),
        ignored: new Set(),
        evidence: [],
        lastSeen: Date.now(),
      };
      sessions.set(sessionId, state);
      if (sessions.size > MAX_SESSIONS) evictOldestSession();
    }
    state.lastSeen = Date.now();
    const cwd = sessionCwd(session);
    if (cwd) state.cwd = cwd;
    return state;
  }

  function resetTurnBuffer(state) {
    state.pending = new Map();
    state.ignored = new Set();
    state.evidence = [];
    state.userRequest = '';
    state.answer = '';
    state.model = '';
  }

  /** Remember a call id whose result must never become evidence (bounded FIFO). */
  function rememberIgnored(state, callId) {
    state.ignored.add(callId);
    while (state.ignored.size > MAX_PENDING_CALLS) {
      const first = state.ignored.values().next();
      if (first.done) break;
      state.ignored.delete(first.value);
    }
  }

  function captureToolCall(state, data) {
    const callId = typeof data.callId === 'string' ? clampText(data.callId, MAX_ID_CHARS) : '';
    const name = typeof data.name === 'string' ? clampText(data.name, MAX_ID_CHARS) : '';
    if (!callId || !name) return;
    if (name.startsWith('proofcard_')) {
      // Our own tools are never evidence, but remember the call so its result is skipped too.
      rememberIgnored(state, callId);
      return;
    }
    state.pending.set(callId, {
      name,
      arguments: clampText(typeof data.arguments === 'string' ? data.arguments : '', MAX_ARGUMENT_CHARS),
      startedAt: Date.now(),
    });
    while (state.pending.size > MAX_PENDING_CALLS) {
      const first = state.pending.keys().next();
      if (first.done) break;
      state.pending.delete(first.value);
    }
  }
  function captureToolResult(state, data) {
    const message = isPlainObject(data.message) ? data.message : {};
    const source = isPlainObject(message.source) ? message.source : {};
    const callId = clampText(
      typeof source.callId === 'string'
        ? source.callId
        : typeof message.toolCallId === 'string'
          ? message.toolCallId
          : typeof data.callId === 'string'
            ? data.callId
            : '',
      MAX_ID_CHARS,
    );
    const pending = callId ? state.pending.get(callId) : undefined;
    if (callId) state.pending.delete(callId);
    if (callId && state.ignored.has(callId)) {
      state.ignored.delete(callId);
      return;
    }
    // A result with no paired call is not evidence: the call was skipped (internal),
    // arrived before we subscribed, or is malformed. Never invent a generic tool name.
    if (!pending) return;
    if (state.evidence.length >= MAX_EVIDENCE_PER_TURN) return;

    const isError = message.isError === true || isPlainObject(data.error);
    let error = '';
    if (isPlainObject(data.error)) {
      error = clampText(
        typeof data.error.reason === 'string'
          ? data.error.reason
          : typeof data.error.message === 'string'
            ? data.error.message
            : typeof data.error.name === 'string'
              ? data.error.name
              : '',
        500,
      );
    }

    let item;
    try {
      item = normalizeToolCall({
        callId: callId || `call_${state.evidence.length + 1}`,
        name: pending.name,
        arguments: pending.arguments,
        resultText: clampText(contentText(message.content), MAX_RESULT_CHARS),
        isError,
        error,
        durationMs: Math.max(0, Date.now() - pending.startedAt),
      });
    } catch (failure) {
      report('normalizeToolCall', failure);
      return;
    }
    if (item) state.evidence.push(item);
  }

  function captureAssistant(state, data) {
    const message = isPlainObject(data.message) ? data.message : {};
    const text = messageText(message);
    if (text) state.answer = clampText(text, MAX_ANSWER_CHARS);
    const source = isPlainObject(message.source) ? message.source : {};
    const model =
      typeof source.model === 'string' && source.model
        ? source.model
        : typeof source.provider === 'string'
          ? source.provider
          : '';
    if (model) state.model = clampText(model, 200);
  }

  function lastHash(sessionId) {
    try {
      const hash = store.lastHash(sessionId);
      return typeof hash === 'string' ? hash : null;
    } catch (failure) {
      report('store.lastHash', failure);
      return null;
    }
  }

  function finalizeTurn(session, state, turnHint) {
    const turn = toTurn(turnHint, state.turn);
    state.turn = turn;
    const evidence = state.evidence.slice();
    const userRequest = state.userRequest;
    const answer = state.answer;
    const model = state.model;
    const cwd = state.cwd || sessionCwd(session) || '';
    resetTurnBuffer(state);
    if (!answer && evidence.length === 0) return; // nothing to review

    let receipt;
    try {
      receipt = buildReceipt({
        session,
        sessionId: state.sessionId,
        turn,
        cwd,
        model,
        userRequest,
        answer,
        evidence,
        prevHash: lastHash(state.sessionId),
        config: {
          maxClaims: settings.maxClaims,
          storeToolOutput: settings.storeToolOutput,
          retentionDays: settings.retentionDays,
        },
      });
    } catch (failure) {
      report('buildReceipt', failure);
      return;
    }
    if (!isPlainObject(receipt)) return;
    try {
      store.append(receipt);
    } catch (failure) {
      report('store.append', failure);
    }
  }

  function handleSessionEvent(session, event) {
    try {
      if (!isPlainObject(event) || typeof event.type !== 'string') return;
      const sessionId = sessionIdOf(session);
      if (!sessionId) return;
      const data = eventPayload(event);
      const state = sessionState(session, sessionId);

      switch (event.type) {
        case 'turn/start':
          resetTurnBuffer(state);
          state.turn = toTurn(data.turn, state.turn + 1);
          return;
        case 'step/start':
        case 'step/end':
          if (data.turn !== undefined) state.turn = toTurn(data.turn, state.turn);
          return;
        case 'user/message': {
          const text = messageText(data);
          if (text) state.userRequest = clampText(text, MAX_REQUEST_CHARS);
          return;
        }
        case 'tool/call':
          captureToolCall(state, data);
          return;
        case 'tool/result':
          captureToolResult(state, data);
          return;
        case 'assistant/message':
          captureAssistant(state, data);
          return;
        case 'turn/end': {
          if (data.turn !== undefined) state.turn = toTurn(data.turn, state.turn);
          const reason = isPlainObject(data.reason) ? data.reason : {};
          const kind = typeof data.reason === 'string' ? data.reason : reason.kind;
          if (kind !== 'completed') {
            resetTurnBuffer(state); // aborted / blocked / errored turns never produce receipts
            return;
          }
          finalizeTurn(session, state, data.turn);
          return;
        }
        default:
          return;
      }
    } catch (failure) {
      report('session/event', failure);
    }
  }

  if (typeof ctx.on === 'function') {
    ownEffect(() => ctx.on('session/event', handleSessionEvent));
  }

  // ----- prompt context ----------------------------------------------------

  const promptService = service('systemPrompt');
  if (promptService && typeof promptService.context === 'function' && settings.ambientPrompt) {
    ownEffect(() =>
      promptService.context({
        name: 'proofcard',
        order: 125,
        interpolate: false,
        text: () => PROMPT_TEXT,
      }),
    );
  }

  // ----- tools -------------------------------------------------------------

  const toolsService = service('tools');
  if (toolsService && typeof toolsService.register === 'function') {
    for (const definition of createToolDefinitions(store, settings)) {
      ownEffect(() => toolsService.register(definition));
    }
  }

  // ----- HTTP bridge for the Client ---------------------------------------

  function jsonResponse(body, status = 200, extraHeaders = {}) {
    let text;
    try {
      text = JSON.stringify(body ?? null);
    } catch (failure) {
      report('jsonResponse', failure);
      text = '{"ok":false,"error":"serialization_failed"}';
    }
    return new Response(text, {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders,
      },
    });
  }

  function notFound(pathname) {
    return jsonResponse({ ok: false, error: 'not_found', path: pathname }, 404);
  }

  function methodNotAllowed(allow) {
    return jsonResponse({ ok: false, error: 'method_not_allowed', allow }, 405, { allow });
  }

  function safeStats() {
    try {
      const stats = store.stats(100);
      return isPlainObject(stats) ? stats : { totals: {}, by_kind: {} };
    } catch (failure) {
      report('store.stats', failure);
      return { totals: {}, by_kind: {} };
    }
  }

  function healthBody() {
    let total = 0;
    try {
      total = store.list(500).length;
    } catch (failure) {
      report('store.list', failure);
    }
    return {
      ok: true,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      dataDir,
      receipts: total,
      maxClaims: settings.maxClaims,
      retentionDays: settings.retentionDays,
      allowCommandRerun: settings.allowCommandRerun,
      ambientPrompt: settings.ambientPrompt,
      timestamp: Date.now(),
    };
  }

  function pathSegments(pathname) {
    const clean = pathname.replace(/\/+$/, '');
    let relative = clean;
    if (clean === ROUTE_PREFIX) relative = '';
    else if (clean.startsWith(`${ROUTE_PREFIX}/`)) relative = clean.slice(ROUTE_PREFIX.length);
    return relative
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
  }

  function allProposedChecks(receipt, claimId) {
    try {
      const checks = proposedChecks(receipt, claimId ?? undefined);
      return Array.isArray(checks) ? checks : [];
    } catch (failure) {
      report('proposedChecks', failure);
      return [];
    }
  }

  function safeProposedChecks(receipt, claimId) {
    try {
      const checks = proposedChecks(receipt, claimId ?? undefined);
      if (!Array.isArray(checks)) return [];
      return checks.filter((check) => !isPlainObject(check) || check.safe_to_run !== false);
    } catch (failure) {
      report('proposedChecks', failure);
      return [];
    }
  }

  function safeRunChecks(checks, receipt, allowCommands) {
    if (!Array.isArray(checks) || checks.length === 0) return [];
    try {
      const cwd = isPlainObject(receipt) && typeof receipt.cwd === 'string' ? receipt.cwd : '';
      const result = runChecks(checks, { cwd, allowCommands: allowCommands === true });
      return Array.isArray(result) ? result : [];
    } catch (failure) {
      report('runChecks', failure);
      return [];
    }
  }

  /**
   * Node handler for mutating calls. `webServer` resource routes answer GET/HEAD only and
   * reject other methods with 405 before the resource runs, so POSTs are served here and
   * translated into the same Request/Response pipeline as the read routes.
   */
  async function handleActionRequest(req, res) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const method = String(req.method || 'GET').toUpperCase();
      const incoming = new URL(req.url || '/', 'http://127.0.0.1');
      let pathname = incoming.pathname;
      if (pathname === ACTION_PREFIX) pathname = ROUTE_PREFIX;
      else if (pathname.startsWith(`${ACTION_PREFIX}/`)) {
        pathname = `${ROUTE_PREFIX}${pathname.slice(ACTION_PREFIX.length)}`;
      }
      const headers = {};
      for (const [key, value] of Object.entries(req.headers || {})) {
        if (Array.isArray(value)) headers[key] = value.join(', ');
        else if (value !== undefined) headers[key] = String(value);
      }
      const init = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks);
      const request = new Request(`http://127.0.0.1${pathname}${incoming.search}`, init);
      const response = await handleHttpRequest(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        try { res.setHeader(key, value); } catch { /* ignore invalid header */ }
      });
      const body = Buffer.from(await response.arrayBuffer());
      res.end(method === 'HEAD' ? undefined : body);
    } catch (failure) {
      try { report('webServer.handler', failure); } catch { /* ignore */ }
      try {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end('{"ok":false,"error":"handler_failed"}');
      } catch { /* response already closed */ }
    }
  }

  async function handleHttpRequest(request) {    try {
      const requestUrl = isPlainObject(request) && typeof request.url === 'string' ? request.url : `${ROUTE_PREFIX}/health`;
      const url = new URL(requestUrl, 'http://127.0.0.1');
      const segments = pathSegments(url.pathname);
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET';

      if (segments.length === 0) {
        return jsonResponse({
          ok: true,
          name: PLUGIN_NAME,
          version: PLUGIN_VERSION,
          routes: [
            `GET ${ROUTE_PREFIX}/health`,
            `GET ${ROUTE_PREFIX}/receipts`,
            `GET ${ROUTE_PREFIX}/receipts/{id}`,
            `POST ${ACTION_PREFIX}/receipts/{id}/accept`,
            `POST ${ACTION_PREFIX}/receipts/{id}/challenge`,
            `GET ${ROUTE_PREFIX}/stats`,
            '(mutations are served by a Node handler at /proofcard/actions; reads at /proofcard)',
          ],
        });
      }

      if (segments[0] === 'health') return jsonResponse(healthBody());

      if (segments[0] === 'stats') {
        if (method !== 'GET') return methodNotAllowed('GET');
        return jsonResponse({ ok: true, ...safeStats() });
      }

      if (segments[0] !== 'receipts') return notFound(url.pathname);

      // GET /proofcard/receipts?limit=20&session_id=…&latest=1
      if (segments.length === 1) {
        if (method !== 'GET') return methodNotAllowed('GET');
        const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
        const sessionId = (url.searchParams.get('session_id') || '').trim() || undefined;
        const latestFlag = ['1', 'true', 'yes'].includes((url.searchParams.get('latest') || '').toLowerCase());
        let receipts;
        try {
          const latest = latestFlag ? store.latest(sessionId) : null;
          receipts = latestFlag ? (latest ? [latest] : []) : store.list(limit, sessionId);
        } catch (failure) {
          report('store.list', failure);
          return jsonResponse({ ok: false, error: 'store_unavailable' }, 500);
        }
        return jsonResponse({ ok: true, count: receipts.length, receipts });
      }

      const id = clampText(segments[1] ?? '', MAX_ID_CHARS);
      if (!id) return notFound(url.pathname);

      // GET /proofcard/receipts/{id}
      if (segments.length === 2) {
        if (method !== 'GET') return methodNotAllowed('GET');
        let receipt;
        try {
          receipt = store.get(id);
        } catch (failure) {
          report('store.get', failure);
          return jsonResponse({ ok: false, error: 'store_unavailable' }, 500);
        }
        if (!receipt) return jsonResponse({ ok: false, error: 'receipt_not_found', id }, 404);
        return jsonResponse({ ok: true, receipt });
      }

      if (segments.length !== 3) return notFound(url.pathname);
      const action = segments[2];
      if (action !== 'accept' && action !== 'challenge') return notFound(url.pathname);
      if (method !== 'POST') return methodNotAllowed('POST');

      let body;
      try {
        const parsed = await request.json();
        body = isPlainObject(parsed) ? parsed : {};
      } catch {
        return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
      }
      const note = clampText(typeof body.note === 'string' ? body.note : '', 2000);

      if (action === 'accept') {
        let receipt;
        try {
          receipt = store.accept(id, note, 'web');
        } catch (failure) {
          report('store.accept', failure);
          return jsonResponse({ ok: false, error: 'store_unavailable' }, 500);
        }
        if (!receipt) return jsonResponse({ ok: false, error: 'receipt_not_found', id }, 404);
        return jsonResponse({ ok: true, receipt });
      }

      // POST /proofcard/receipts/{id}/challenge { claim_id?, run?, note? }
      let receipt;
      try {
        receipt = store.get(id);
      } catch (failure) {
        report('store.get', failure);
        return jsonResponse({ ok: false, error: 'store_unavailable' }, 500);
      }
      if (!receipt) return jsonResponse({ ok: false, error: 'receipt_not_found', id }, 404);

      const claimId = typeof body.claim_id === 'string' && body.claim_id.trim() ? body.claim_id.trim() : null;
      const run = body.run === true;
      // A challenge always carries the proposal; run=true additionally executes the safe,
      // read-only checks (command reruns stay gated by config). Never record an empty list.
      const proposed = safeProposedChecks(receipt, claimId);
      const proposedAll = allProposedChecks(receipt, claimId);
      const checks = run ? safeRunChecks(proposed, receipt, settings.allowCommandRerun) : proposed;
      let updated;
      try {
        updated = store.appendChallenge(id, {
          id: challengeId(),
          at: Date.now(),
          by: 'web',
          claim_id: claimId,
          run,
          note,
          checks,
        });
      } catch (failure) {
        report('store.appendChallenge', failure);
        return jsonResponse({ ok: false, error: 'store_unavailable' }, 500);
      }
      if (!updated) return jsonResponse({ ok: false, error: 'challenge_failed', id }, 500);
      return jsonResponse({ ok: true, id, claim_id: claimId, run, checks, proposed: proposedAll, receipt: updated });
    } catch (failure) {
      report('http', failure);
      return jsonResponse({ ok: false, error: 'internal_error' }, 500);
    }
  }

  const webServer = service('webServer');
  if (webServer && typeof webServer.register === 'function') {
    ownEffect(() =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        resource: handleHttpRequest,
      }),
    );
    ownEffect(() =>
      webServer.register({
        kind: 'prefix',
        path: ACTION_PREFIX,
        handler: handleActionRequest,
      }),
    );
  }
}
