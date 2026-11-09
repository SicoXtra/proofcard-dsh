/** Receipt construction, Markdown rendering and read-only challenges. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractClaims } from './claims.js';
import { summarizeEvidence } from './evidence.js';
import { redact } from './redact.js';

export const SCHEMA = 1;

const TEST_MARKERS = ['pytest', 'test', 'spec', 'assert', '0 failed', 'passed', 'passing'];
const TEST_COMMAND_RE = /^(?:python\s+-m\s+)?(?:pytest|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|dotnet\s+test)\b/i;
const SAFE_READ_COMMANDS = /^(?:pytest|python\s+-m\s+pytest|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|git\s+(?:status|diff|log|show)|ls|dir|pwd|test\s+-[efd])\b/i;

const norm = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const pathKey = (value) => norm(value).replace(/\\/g, '/').replace(/^\.\//, '');
const evidenceText = (item) => norm(`${item?.args_text || ''} ${item?.result || ''}`);

function resolvePath(cwd, target) {
  const expanded = String(target || '').replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '');
  return path.resolve(cwd || process.cwd(), expanded);
}

function ref(item, match) {
  const tool = String(item?.tool || 'tool');
  let what;
  if (item?.command) what = `ran \`${String(item.command).slice(0, 120)}\``;
  else if (item?.files?.length) what = `touched \`${String(item.files[0]).slice(0, 120)}\``;
  else if (item?.url) what = `fetched \`${String(item.url).slice(0, 120)}\``;
  else {
    const excerpt = String(item?.result || '').replace(/\s+/g, ' ').slice(0, 110);
    what = excerpt ? `${tool} returned "${excerpt}"` : `${tool} call`;
  }
  const value = { id: String(item?.id || ''), tool, what, match: Math.round(Number(match) * 100) / 100 };
  const excerpt = String(item?.result || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (excerpt) value.excerpt = excerpt;
  return value;
}

function failed(item) {
  return item?.ok === false;
}

function judgeTestPassed(claim, items) {
  const command = norm(claim?.subject?.command || '');
  const candidates = [];
  for (const item of items) {
    const text = evidenceText(item);
    if (!TEST_MARKERS.some((marker) => text.includes(marker))) continue;
    const execLike = item.caps?.includes('terminal') || Boolean(item.command);
    if (!execLike) continue;
    let score = 0.3;
    if (command && norm(item.args_text || '').includes(command)) score += 0.6;
    if (['passed', 'passing', '0 failed', 'success', 'green', 'ok'].some((word) => text.includes(word))) score += 0.2;
    candidates.push([score, item]);
  }
  if (!candidates.length) return ['unverified', 0.2, [], 'no test or check output was recorded'];
  candidates.sort((left, right) => right[0] - left[0]);
  const refs = candidates.slice(0, 2).map(([score, item]) => ref(item, Math.min(score, 1)));
  const successes = candidates.filter(([, item]) => !failed(item));
  const failures = candidates.filter(([, item]) => failed(item));
  if (successes.length && !failures.length) return ['verified', 0.9, refs, 'a recorded check succeeded'];
  if (failures.length && !successes.length) return ['contradicted', 0.8, refs, 'the closest recorded check failed'];
  if (successes.length && failures.length) return ['partial', 0.5, refs, 'one check passed and another failed'];
  return ['partial', 0.4, refs, 'check output exists but is inconclusive'];
}

function judgeFileChanged(claim, items, cwd) {
  const subject = claim?.subject || {};
  const paths = (subject.paths || []).filter(Boolean);
  const action = String(subject.action || 'changed').toLowerCase();
  if (!paths.length) return ['unverified', 0.2, [], 'no concrete path in the claim'];
  const verdicts = [];
  const refs = [];
  const notes = [];
  for (const target of paths.slice(0, 4)) {
    const key = pathKey(target);
    const resolved = resolvePath(cwd, target);
    let exists = false;
    try { exists = fs.existsSync(resolved); } catch { exists = false; }
    const mentioned = items.filter((item) => key && (pathKey(item.args_text || '').includes(key) || pathKey(JSON.stringify(item.files || [])).includes(key)));
    const failures = mentioned.filter((item) => failed(item));
    const successes = mentioned.filter((item) => !failed(item));
    const writeLike = successes.filter((item) => item.caps?.includes('write')
      || (item.caps?.includes('terminal') && key && pathKey(item.args_text || '').includes(key)));
    for (const item of [...failures, ...successes].slice(0, 2)) refs.push(ref(item, failed(item) ? 0.6 : 0.8));
    if (['deleted', 'removed'].includes(action)) {
      if (!exists && mentioned.length) { verdicts.push('verified'); notes.push(`${target} is gone and a matching call was recorded`); }
      else if (!exists) { verdicts.push('unverified'); notes.push(`${target} is gone, but no matching delete call was recorded`); }
      else if (failures.length) { verdicts.push('contradicted'); notes.push(`${target} still exists and the delete call failed`); }
      else { verdicts.push('partial'); notes.push(`${target} still exists`); }
      continue;
    }
    if (writeLike.length) { verdicts.push('verified'); notes.push(`${target} was written by a successful tool call`); }
    else if (exists) { verdicts.push('partial'); notes.push(`${target} exists, but no write call for it was recorded`); }
    else if (failures.length) { verdicts.push('contradicted'); notes.push(`${target} is missing and the matching call failed`); }
    else { verdicts.push('contradicted'); notes.push(`${target} does not exist`); }
  }
  if (verdicts.includes('contradicted') && !verdicts.includes('verified')) return ['contradicted', 0.8, refs, notes.slice(0, 2).join('; ')];
  if (verdicts.every((verdict) => verdict === 'verified')) return ['verified', 0.9, refs, notes.slice(0, 2).join('; ')];
  if (verdicts.includes('contradicted')) return ['partial', 0.5, refs, notes.slice(0, 2).join('; ')];
  return ['partial', 0.55, refs, notes.slice(0, 2).join('; ')];
}

function judgeFileExists(claim, items, cwd) {
  const paths = (claim?.subject?.paths || []).filter(Boolean);
  if (!paths.length) return ['unverified', 0.2, [], 'no concrete path in the claim'];
  const existing = [];
  for (const target of paths.slice(0, 4)) {
    try { if (fs.existsSync(resolvePath(cwd, target))) existing.push(target); } catch { /* ignore */ }
  }
  const refs = items.slice(0, 1).map((item) => ref(item, 0.4));
  if (existing.length) return ['verified', 0.85, refs, `filesystem confirms: ${existing.slice(0, 2).join(', ')}`];
  return ['contradicted', 0.75, refs, `path not found: ${paths[0]}`];
}

function matchCommand(wanted, items) {
  const key = norm(wanted);
  const successes = [];
  const failures = [];
  for (const item of items) {
    const recorded = norm(item.command || '');
    if (!recorded) continue;
    if (!key || recorded.includes(key) || key.includes(recorded)) (failed(item) ? failures : successes).push(item);
  }
  return [successes, failures];
}

function judgeCommandRan(claim, items) {
  const command = String(claim?.subject?.command || '');
  if (!command) return ['unverified', 0.2, [], 'no concrete command in the claim'];
  const [successes, failures] = matchCommand(command, items);
  const refs = [...successes, ...failures].slice(0, 2).map((item) => ref(item, 0.8));
  if (successes.length && !failures.length) return ['verified', 0.9, refs, `recorded command matches \`${command.slice(0, 80)}\``];
  if (failures.length && !successes.length) return ['contradicted', 0.8, refs, `recorded command failed: \`${command.slice(0, 80)}\``];
  if (successes.length || failures.length) return ['partial', 0.5, refs, 'a related command ran, but not this exact one'];
  return ['unverified', 0.2, [], 'no matching command was recorded'];
}

function judgeUrlFetched(claim, items) {
  const url = String(claim?.subject?.url || '');
  if (!url) return ['unverified', 0.2, [], 'no URL in the claim'];
  const key = norm(url);
  const matches = items.filter((item) => norm(item.url || '').includes(key) || norm(item.args_text || '').includes(key) || evidenceText(item).includes(key));
  const refs = matches.slice(0, 2).map((item) => ref(item, 0.75));
  if (matches.some((item) => !failed(item))) return ['verified', 0.85, refs, 'a fetch/browse call named this URL'];
  if (matches.length) return ['contradicted', 0.7, refs, 'the matching fetch failed'];
  return ['unverified', 0.2, [], 'no fetch/browse call named this URL'];
}

function judgeCommit(claim, items) {
  const subjectCommand = String(claim?.subject?.command || '');
  const candidates = items.filter((item) => /^(?:git|gh)\b/.test(norm(item.command || ''))
    || /\bgit\s+(?:commit|push|merge|tag)\b|\bgh\s+pr\b/.test(evidenceText(item)));
  const refs = candidates.slice(0, 2).map((item) => ref(item, 0.7));
  if (subjectCommand) {
    const [successes, failures] = matchCommand(subjectCommand, candidates);
    if (successes.length) return ['verified', 0.9, refs, 'matching git command succeeded'];
    if (failures.length) return ['contradicted', 0.75, refs, 'matching git command failed'];
  }
  if (candidates.some((item) => !failed(item))) return ['verified', 0.75, refs, 'a git/gh command ran successfully'];
  if (candidates.length) return ['contradicted', 0.7, refs, 'the git/gh command failed'];
  return ['unverified', 0.2, [], 'no git/gh command was recorded'];
}

function judgeMessageSent(_claim, items) {
  const candidates = items.filter((item) => item.caps?.includes('send'));
  const refs = candidates.slice(0, 2).map((item) => ref(item, 0.7));
  if (candidates.some((item) => !failed(item))) return ['verified', 0.75, refs, 'a send/message tool succeeded'];
  if (candidates.length) return ['contradicted', 0.7, refs, 'the send/message tool failed'];
  return ['unverified', 0.2, [], 'no send/message tool call was recorded'];
}

function judgeCount(claim, items) {
  const subject = claim?.subject || {};
  const count = subject.count;
  const noun = norm(subject.noun || '');
  if (!Number.isInteger(count)) return ['unverified', 0.2, [], 'no concrete count in the claim'];
  const successes = [];
  const failures = [];
  for (const item of items) {
    const text = evidenceText(item);
    if (text.includes(String(count)) && (!noun || text.includes(noun.slice(0, 4)))) (failed(item) ? failures : successes).push(item);
  }
  const refs = [...successes, ...failures].slice(0, 2).map((item) => ref(item, 0.55));
  if (successes.length) return ['verified', 0.6, refs, `a successful result mentions ${count} ${noun || 'items'}`];
  if (failures.length) return ['contradicted', 0.55, refs, 'the matching result failed'];
  return ['unverified', 0.2, [], 'no result mentions that count'];
}

function judgeAssertion(claim, items) {
  const changes = items.filter((item) => item.ok !== false
    && (item.caps?.includes('write') || item.caps?.includes('terminal')));
  if (changes.length) {
    return ['partial', 0.45, changes.slice(0, 2).map((item) => ref(item, 0.6)),
      'narrative assertion; the turn recorded code/command changes, but the statement itself is not independently checkable'];
  }
  return ['unverified', 0.15, [], 'a summary statement with no checkable subject'];
}

/**
 * Tool evidence is itself a set of checkable facts: a write that succeeded touched a
 * path, a terminal call ran a command, a web call fetched a URL. Record those as
 * evidence-derived claims so a tool-heavy turn is not "0 claims" just because the
 * prose was narrative. They are marked `source: 'tool'` and verified by the same judges.
 */
function deriveEvidenceClaims(items, limit, existing = []) {
  const out = [];
  const seen = new Set();
  const existingPaths = new Set();
  const existingCommands = new Set();
  const existingUrls = new Set();
  let hasTestClaim = false;
  for (const claim of existing) {
    const subject = claim && claim.subject ? claim.subject : {};
    if (claim && claim.kind === 'test_passed') hasTestClaim = true;
    for (const path of subject.paths || []) existingPaths.add(pathKey(path));
    if (subject.command) existingCommands.add(String(subject.command));
    if (subject.url) existingUrls.add(String(subject.url));
  }
  if (!Number.isInteger(limit) || limit <= 0) return out;
  const fileLike = (value) => typeof value === 'string' && /\.[A-Za-z0-9]{1,8}$/.test(value.trim());
  for (const item of items) {
    if (!item || item.ok === false) continue;
    if (item.caps?.includes('write')) {
      for (const path of item.files || []) {
        if (!fileLike(path)) continue;
        const identity = pathKey(path);
        if (existingPaths.has(identity)) continue;
        const key = `file:${identity}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: 'file_changed',
          text: `Tool call ${item.tool} wrote ${path}.`,
          subject: { paths: [path], action: 'updated' },
          source: 'tool',
        });
        if (out.length >= limit) return out;
      }
    }
    const command = typeof item.command === 'string' && item.command.trim();
    if (command) {
      const testLike = /\b(?:pytest|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|vitest|jest)\b/i.test(command)
        || /\b\d+\s+(?:passed|failed|skipped)\b/i.test(String(item.result || ''));
      const key = `${testLike ? 'test' : 'cmd'}:${command}`;
      if (!seen.has(key) && !(testLike && hasTestClaim) && !existingCommands.has(command)) {
        seen.add(key);
        out.push({
          kind: testLike ? 'test_passed' : 'command_ran',
          text: `Tool call ${item.tool} ran \`${command}\`.`,
          subject: { command },
          source: 'tool',
        });
        if (out.length >= limit) return out;
      }
    }
    if (item.url && !existingUrls.has(item.url)) {
      const key = `url:${item.url}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          kind: 'url_fetched',
          text: `Tool call ${item.tool} fetched ${item.url}.`,
          subject: { url: item.url },
          source: 'tool',
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const JUDGES = {
  test_passed: (claim, items) => judgeTestPassed(claim, items),
  file_changed: (claim, items, cwd) => judgeFileChanged(claim, items, cwd),
  file_exists: (claim, items, cwd) => judgeFileExists(claim, items, cwd),
  command_ran: (claim, items) => judgeCommandRan(claim, items),
  url_fetched: (claim, items) => judgeUrlFetched(claim, items),
  commit: (claim, items) => judgeCommit(claim, items),
  message_sent: (claim, items) => judgeMessageSent(claim, items),
  count: (claim, items) => judgeCount(claim, items),
  assertion: (claim, items) => judgeAssertion(claim, items),
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonical(receipt) {
  const fields = ['schema', 'id', 'created_at', 'session_id', 'turn', 'model', 'cwd',
    'user_request', 'answer_excerpt', 'claims', 'stats', 'evidence_count', 'tools_used',
    'files_touched', 'commands', 'duration_ms', 'prev_hash'];
  const payload = {};
  for (const field of fields) payload[field] = receipt[field];
  return stableStringify(payload);
}

export function receiptHash(receipt) {
  return crypto.createHash('sha256').update(canonical(receipt)).digest('hex');
}

export function buildReceipt(options = {}) {
  if (!options || typeof options !== 'object') options = {};
  const {
    sessionId = null, turn = null, cwd = process.cwd(), model = null,
    userRequest = '', answer = '', evidence = [], prevHash = null, config = {},
  } = options;
  const items = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  const maxClaims = Number.isInteger(config.maxClaims) ? config.maxClaims : 12;
  const claims = extractClaims(String(answer || ''), maxClaims);
  const evidenceClaims = deriveEvidenceClaims(items, Math.max(0, maxClaims - claims.length), claims);
  for (const claim of evidenceClaims) claims.push(claim);
  claims.forEach((claim, index) => { claim.id = `c${index + 1}`; });
  for (const claim of claims) {
    claim.text = redact(String(claim.text || '')).slice(0, 300);
    const subject = claim.subject || {};
    if (subject.command) subject.command = redact(String(subject.command));
    if (subject.url) subject.url = redact(String(subject.url));
    if (Array.isArray(subject.paths)) subject.paths = subject.paths.map((item) => redact(String(item)));
    const judge = JUDGES[claim.kind] || JUDGES.assertion;
    let verdict;
    try { verdict = judge(claim, items, cwd); } catch { verdict = ['unverified', 0.1, [], 'verification error']; }
    claim.verdict = ['verified', 'partial', 'unverified', 'contradicted'].includes(verdict[0]) ? verdict[0] : 'unverified';
    claim.confidence = Math.max(0, Math.min(1, Number(verdict[1]) || 0));
    claim.evidence = verdict[2] || [];
    claim.note = verdict[3] || '';
    if (config.storeToolOutput === false) {
      for (const evidenceRef of claim.evidence) {
        delete evidenceRef.excerpt;
        // A `what` derived from the result text must not leak the result when the
        // setting is off; command/path/url-derived descriptions are safe to keep.
        if (typeof evidenceRef.what === 'string' && evidenceRef.what.startsWith(`${evidenceRef.tool} returned `)) {
          evidenceRef.what = `${evidenceRef.tool} call`;
        }
      }
    }
  }

  const stats = { claims: claims.length, verified: 0, partial: 0, unverified: 0, contradicted: 0 };
  for (const claim of claims) stats[claim.verdict] += 1;
  stats.verified_pct = claims.length ? Math.round((100 * stats.verified) / claims.length) : 0;

  const summary = summarizeEvidence(items);
  const created = Date.now() / 1000;
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const random = crypto.randomBytes(2).toString('hex');
  const receipt = {
    schema: SCHEMA,
    id: `rc_${stamp}_${random}`,
    created_at: created,
    session_id: sessionId,
    turn,
    model,
    cwd: String(cwd || process.cwd()),
    user_request: redact(String(userRequest || '').slice(0, 1600)).slice(0, 400),
    answer_excerpt: redact(String(answer || '').slice(0, 4800)).slice(0, 1200),
    claims,
    stats,
    evidence_count: summary.evidence_count,
    tools_used: summary.tools_used,
    files_touched: summary.files_touched,
    commands: summary.commands,
    duration_ms: summary.duration_ms,
    prev_hash: prevHash || null,
    hash: '',
    accepted: false,
    accepted_at: null,
    accepted_by: null,
    accept_note: '',
    challenges: [],
  };
  receipt.hash = receiptHash(receipt);
  return receipt;
}

export function claimBadge(verdict) {
  return { verified: '✅', partial: '🟡', unverified: '⚠️', contradicted: '❌' }[verdict] || '•';
}

export function receiptMarkdown(receipt) {
  if (!receipt || typeof receipt !== 'object') return 'No receipt.';
  const stats = receipt.stats || {};
  const lines = [
    `# Proofcard receipt \`${receipt.id || '?'}\``,
    '',
    `**Created:** ${new Date((Number(receipt.created_at) || Date.now() / 1000) * 1000).toISOString().replace('T', ' ').slice(0, 19)}  `,
    `**Session:** \`${receipt.session_id || '—'}\`  `,
    `**Model:** \`${receipt.model || '—'}\`  `,
    `**Verdicts:** ✅ ${stats.verified || 0} verified · 🟡 ${stats.partial || 0} partial · ⚠️ ${stats.unverified || 0} unverified · ❌ ${stats.contradicted || 0} contradicted`,
    '',
  ];
  if (receipt.user_request) lines.push('## Request', '', String(receipt.user_request), '');
  lines.push('## Claims', '');
  if (!(receipt.claims || []).length) lines.push('_No verifiable completion claims were detected in the reply._', '');
  for (const claim of receipt.claims || []) {
    lines.push(`- ${claimBadge(claim.verdict)} **${claim.kind}** — ${String(claim.text || '').slice(0, 400)}`);
    for (const item of claim.evidence || []) lines.push(`    - evidence: \`${item.id}\` ${item.what}`);
    if (claim.note) lines.push(`    - _note:_ ${claim.note}`);
  }
  lines.push('');
  if (receipt.commands?.length) {
    lines.push('## Commands recorded', '', '| Command | Exit | OK |', '|---|---|---|');
    for (const command of receipt.commands) lines.push(`| \`${String(command.command).slice(0, 160)}\` | ${command.exit_code ?? ''} | ${command.ok} |`);
    lines.push('');
  }
  if (receipt.files_touched?.length) {
    lines.push('## Files touched', '');
    for (const file of receipt.files_touched.slice(0, 40)) lines.push(`- \`${file}\``);
    lines.push('');
  }
  if (receipt.challenges?.length) {
    lines.push('## Challenges', '');
    for (const challenge of receipt.challenges) lines.push(`- claim \`${challenge.claim_id || '?'}\` at ${challenge.at || ''}: ${challenge.outcome || ''}`);
    lines.push('');
  }
  lines.push('## Integrity', '', `- hash: \`${receipt.hash || ''}\``, `- previous: \`${receipt.prev_hash || '—'}\``, `- accepted: ${receipt.accepted}`, '',
    '_Proofcard records evidence; it does not replace your judgement. Generated locally._');
  return lines.join('\n');
}

export function proposedChecks(receipt, claimId = null) {
  const checks = [];
  const recordedCommands = (receipt?.commands || []).map((item) => String(item?.command || '')).filter(Boolean);
  for (const claim of receipt?.claims || []) {
    if (claimId && claim.id !== claimId) continue;
    const kind = claim.kind;
    const subject = claim.subject || {};
    if (['file_changed', 'file_exists'].includes(kind)) {
      const gone = kind === 'file_changed' && ['deleted', 'removed'].includes(String(subject.action || '').toLowerCase());
      for (const target of (subject.paths || []).slice(0, 2)) {
        checks.push(gone
          ? { claim_id: claim.id, kind: 'file_absent', label: `Check that ${target} is gone`, path: target, command: null, url: null, safe_to_run: true }
          : { claim_id: claim.id, kind: 'file_exists', label: `Check that ${target} exists`, path: target, command: null, url: null, safe_to_run: true });
      }
    }
    let command = subject.command;
    if (['test_passed', 'command_ran', 'commit'].includes(kind) && !command) {
      for (const recorded of recordedCommands) {
        if (kind === 'test_passed' && TEST_COMMAND_RE.test(recorded.trim())) { command = recorded; break; }
      }
    }
    if (['test_passed', 'command_ran', 'commit'].includes(kind) && command) {
      checks.push({
        claim_id: claim.id, kind: 'command', label: `Re-run \`${String(command).slice(0, 140)}\``,
        command: String(command).slice(0, 400), path: null, url: null,
        safe_to_run: SAFE_READ_COMMANDS.test(String(command).trim()),
      });
    } else if (kind === 'test_passed' && !command) {
      checks.push({ claim_id: claim.id, kind: 'manual', label: "Find and re-run the project's test command", command: null, path: null, url: null, safe_to_run: false });
    }
    if (kind === 'url_fetched' && subject.url) {
      checks.push({ claim_id: claim.id, kind: 'url', label: `Open ${String(subject.url).slice(0, 160)}`, command: null, path: null, url: String(subject.url).slice(0, 500), safe_to_run: false });
    }
    if (['message_sent', 'count', 'assertion'].includes(kind)) {
      checks.push({ claim_id: claim.id, kind: 'manual', label: `Review the ${kind.replace(/_/g, ' ')} claim against the recorded evidence`, command: null, path: null, url: null, safe_to_run: false });
    }
  }
  return checks;
}

export function runChecks(checks, { cwd = process.cwd(), allowCommands = false } = {}) {
  const results = [];
  for (const check of checks || []) {
    if (!check || typeof check !== 'object') continue;
    const result = { ...check, ran: false, ok: null };
    try {
      if (check.kind === 'file_exists' && check.path) {
        const resolved = resolvePath(cwd, check.path);
        result.ran = true;
        result.ok = fs.existsSync(resolved);
        result.detail = `${resolved} ${result.ok ? 'exists' : 'does not exist'}`;
      } else if (check.kind === 'file_absent' && check.path) {
        const resolved = resolvePath(cwd, check.path);
        const exists = fs.existsSync(resolved);
        result.ran = true;
        result.ok = !exists;
        result.detail = `${resolved} ${exists ? 'still exists' : 'is gone'}`;
      } else if (check.kind === 'command' && allowCommands && check.safe_to_run && check.command
        && SAFE_READ_COMMANDS.test(String(check.command).trim())) {
        const run = spawnSync(check.command, {
          cwd: cwd || process.cwd(), shell: true, timeout: 20_000, encoding: 'utf8',
        });
        result.ran = true;
        result.ok = run.status === 0;
        result.exit_code = run.status;
        result.detail = `${run.stdout || ''}${run.stderr || ''}`.replace(/\s+/g, ' ').trim().slice(0, 600);
      } else {
        result.detail = 'manual check — open it yourself';
      }
    } catch (error) {
      result.ok = false;
      result.detail = `check failed: ${error?.message || error}`;
    }
    results.push(result);
  }
  return results;
}
