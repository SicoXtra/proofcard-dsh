#!/usr/bin/env node
/**
 * Independent end-to-end test for Proofcard DSH (verifier-owned).
 *
 * Runs the real Host entrypoint against a mock Cordis context, feeds a synthetic
 * two-turn session log (turn 1 passes, turn 2 fails but the agent claims success),
 * then exercises the receipt chain, the six agent tools, the `/proofcard` HTTP
 * routes (including a run:true file challenge), persistence across a fresh store,
 * the prompt context, and handler latency.
 *
 * Zero dependencies:
 *   node proofcard-dsh/tests/e2e.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// --------------------------------------------------------------------------- harness

const steps = [];
function step(name, fn) {
  steps.push({ name, fn });
}
const cleanups = [];
function tmpdir(prefix = 'proofcard-dsh-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// --------------------------------------------------------------------------- import host

assert.ok(fs.existsSync(path.join(ROOT, 'index.js')), 'missing Host entrypoint index.js');
const host = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const { ReceiptStore } = await import(pathToFileURL(path.join(ROOT, 'store.js')).href);
assert.equal(typeof host.apply, 'function', 'index.js must export apply(ctx, config)');

// --------------------------------------------------------------------------- mock cordis ctx

function makeCtx() {
  const captured = { events: new Map(), tools: new Map(), prompts: [], routes: [], disposers: [] };
  const ctx = {
    captured,
    on(name, handler) {
      if (!captured.events.has(name)) captured.events.set(name, []);
      captured.events.get(name).push(handler);
      return () => {};
    },
    tools: {
      register(definition) { captured.tools.set(definition.name, definition); return () => {}; },
      restrict() { throw new Error('observe-only plugin must not restrict tools'); },
      guard() { throw new Error('observe-only plugin must not guard tools'); },
    },
    systemPrompt: {
      context(definition) { captured.prompts.push(definition); return () => {}; },
      section(definition) { captured.prompts.push(definition); return () => {}; },
    },
    webServer: { register(route) { captured.routes.push(route); return () => {}; } },
    effect(fn) { const disposer = fn(); captured.disposers.push(disposer); return () => {}; },
    get(name) { return ctx[name]; },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return ctx;
}

function mockSession(id, cwd) {
  return { id, header: { cwd } };
}
function ev(type, data) {
  return { type, seq: 1, time: Date.now() / 1000, data };
}
function emit(ctx, session, event) {
  const handlers = ctx.captured.events.get('session/event') || [];
  for (const handler of handlers) handler(session, event);
}
function userMessage(text) {
  return ev('user/message', { role: 'user', content: [{ type: 'text', text }] });
}
function assistantMessage(text, turn) {
  return ev('assistant/message', {
    turn, step: 1, stream: [],
    message: {
      role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
      content: [{ type: 'text', text }],
    },
  });
}
function toolCall(turn, callId, name, args) {
  return ev('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
}
function toolResult(turn, callId, text, { isError = false, error } = {}) {
  return ev('tool/result', {
    turn, step: 1,
    message: {
      role: 'tool', content: [{ type: 'text', text }],
      toolCallId: callId, source: { kind: 'tool', callId }, isError,
    },
    ...(error ? { error } : {}),
  });
}
function turnStart(turn) {
  return ev('turn/start', { turn });
}
function turnEnd(turn, kind = 'completed') {
  return ev('turn/end', { turn, reason: { kind } });
}

// --------------------------------------------------------------------------- boot plugin

const workspace = tmpdir('proofcard-workspace-');
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'src', 'a.py'), 'VALUE = 1\n');

const dataDir = path.join(tmpdir('proofcard-data-'), 'proofcard');
const ctx = makeCtx();
host.apply(ctx, { dataDir, maxClaims: 12, retentionDays: 30 });

const promptDefinition = ctx.captured.prompts[0];
const promptText = promptDefinition ? (typeof promptDefinition.text === 'function' ? promptDefinition.text({}) : promptDefinition.text) : '';
assert.equal(typeof promptText, 'string', 'no prompt context text');
assert.ok(promptText.length > 0 && promptText.length <= 400, `prompt text length ${promptText.length}`);

const route = ctx.captured.routes.find((item) => item.path === '/proofcard');
assert.ok(route && route.kind === 'prefix' && typeof route.resource === 'function', 'no /proofcard prefix resource');

async function request(pathname, options = {}) {
  const response = await route.resource(new Request(`http://localhost${pathname}`, options));
  assert.equal(typeof response.status, 'number', 'route did not return a Response');
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, text, json, headers: response.headers };
}
async function postJson(pathname, body) {
  return request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function mustTool(name) {
  const definition = ctx.captured.tools.get(name);
  assert.ok(definition, `missing tool ${name}`);
  return definition;
}

// --------------------------------------------------------------------------- step 1: two turns

step('turn 1 (passing) produces a verified receipt; turn 2 (failing) contradicts the claim', () => {
  const session = mockSession('session-e2e', workspace);

  // ---- turn 1: agent runs the suite, writes a file, and claims both.
  emit(ctx, session, turnStart(1));
  emit(ctx, session, userMessage('Fix the export and run the tests'));
  emit(ctx, session, toolCall(1, 'call_pytest_1', 'pwsh', { command: 'pytest -q' }));
  emit(ctx, session, toolResult(1, 'call_pytest_1', '14 passed, 0 failed in 0.6s'));
  emit(ctx, session, toolCall(1, 'call_write_1', 'write', { path: 'src/a.py', content: 'VALUE = 1\n' }));
  emit(ctx, session, toolResult(1, 'call_write_1', 'wrote 12 bytes'));
  emit(ctx, session, assistantMessage('All 14 tests pass. Created `src/a.py`.', 1));
  emit(ctx, session, turnEnd(1));

  // ---- turn 2: the suite now fails, but the assistant still claims it passed.
  emit(ctx, session, turnStart(2));
  emit(ctx, session, userMessage('The CI still fails; re-run the tests'));
  emit(ctx, session, toolCall(2, 'call_pytest_2', 'pwsh', { command: 'pytest -q' }));
  emit(ctx, session, toolResult(2, 'call_pytest_2', '1 failed, 13 passed\nexit code: 1', {
    isError: true, error: { name: 'CommandError', code: 'exit_1', reason: 'tests failed' },
  }));
  emit(ctx, session, assistantMessage('All 14 tests pass.', 2));
  emit(ctx, session, turnEnd(2));

  const store = new ReceiptStore(dataDir);
  const list = store.list(10, 'session-e2e');
  assert.equal(list.length, 2, `expected 2 receipts, got ${list.length}`);

  const [turn2, turn1] = list; // list is newest first
  assert.equal(turn1.turn, 1);
  assert.equal(turn2.turn, 2);
  assert.equal(turn1.session_id, 'session-e2e');
  assert.equal(turn1.prev_hash, null);
  assert.equal(turn2.prev_hash, turn1.hash, 'hash chain not linked');
  assert.match(turn1.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(turn2.hash, turn1.hash);

  const claims1 = Object.fromEntries(turn1.claims.map((claim) => [claim.kind, claim]));
  assert.equal(claims1.test_passed.verdict, 'verified', JSON.stringify(claims1.test_passed));
  assert.equal(claims1.file_changed.verdict, 'verified', JSON.stringify(claims1.file_changed));
  assert.equal(turn1.stats.verified, 2);
  assert.equal(turn1.evidence_count, 2);
  assert.deepEqual([...turn1.tools_used].sort(), ['pwsh', 'write']);
  assert.ok(turn1.files_touched.includes('src/a.py'));
  assert.ok(turn1.commands.some((command) => command.command === 'pytest -q' && command.ok === true));

  const claims2 = Object.fromEntries(turn2.claims.map((claim) => [claim.kind, claim]));
  assert.equal(claims2.test_passed.verdict, 'contradicted', JSON.stringify(claims2.test_passed));
  assert.ok(claims2.test_passed.evidence.length >= 1);
  assert.ok(claims2.test_passed.note.toLowerCase().includes('fail'), claims2.test_passed.note);
  assert.equal(turn2.stats.contradicted, 1);

  // Contract id shape (also used by the tool schema text).
  for (const receipt of [turn1, turn2]) {
    assert.match(receipt.id, /^rc_\d{8}_\d{6}_[0-9a-f]{4,}$/, `receipt id ${receipt.id}`);
  }

  // Append-only ledger: one line per receipt.
  const ledger = fs.readFileSync(path.join(dataDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(ledger.length, 2);
  for (const line of ledger) assert.doesNotThrow(() => JSON.parse(line));

  // Observe-only: every session/event listener returns undefined (no directive shapes).
  for (const handler of ctx.captured.events.get('session/event') || []) {
    const result = handler(session, ev('unknown/type', {}));
    assert.equal(result, undefined, 'session/event handler returned a directive');
  }
});

// --------------------------------------------------------------------------- step 2: six tools

step('six agent tools return JSON and expose both receipts', async () => {
  const exec = { agent: { id: 'session-e2e' } };

  const listed = await mustTool('proofcard_list').execute({ limit: 10 }, exec);
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 2);
  assert.equal(listed.receipts[0].id, new ReceiptStore(dataDir).list(10)[0].id);

  const latest = new ReceiptStore(dataDir).latest('session-e2e');
  const shown = await mustTool('proofcard_show').execute({}, exec);
  assert.equal(shown.ok, true);
  assert.equal(shown.receipt.id, latest.id);
  assert.ok(shown.markdown.includes('Proofcard receipt'));

  const accepted = await mustTool('proofcard_accept').execute({ note: 'turn 2 reviewed' }, exec);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.accepted_at !== undefined && accepted.accepted_at !== null, true);

  const stats = await mustTool('proofcard_stats').execute({}, exec);
  assert.equal(stats.ok, true);
  assert.equal(stats.totals.receipts, 2);
  assert.ok(stats.totals.claims >= 3);
  assert.ok(stats.totals.contradicted >= 1);
  assert.ok(stats.by_kind.test_passed);

  const exported = await mustTool('proofcard_export').execute({ format: 'markdown' }, exec);
  assert.equal(exported.ok, true);
  assert.equal(exported.format, 'markdown');
  assert.ok(exported.content.includes('Proofcard receipt'));
  assert.ok(exported.content.includes(latest.hash));

  for (const name of ['proofcard_list', 'proofcard_show', 'proofcard_accept', 'proofcard_challenge', 'proofcard_stats', 'proofcard_export']) {
    const definition = mustTool(name);
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
  }
});

// --------------------------------------------------------------------------- step 3: challenge route

step('Challenge via POST /proofcard/receipts/{id}/challenge run:true re-checks the file', async () => {
  const store = new ReceiptStore(dataDir);
  const turn1 = store.list(10, 'session-e2e')[1];
  const fileClaim = turn1.claims.find((claim) => claim.kind === 'file_changed');
  assert.ok(fileClaim, 'turn 1 has no file_changed claim');

  const proposed = await postJson(`/proofcard/receipts/${turn1.id}/challenge`, { claim_id: fileClaim.id, run: false });
  assert.equal(proposed.status, 200, proposed.text);
  assert.ok(Array.isArray(proposed.json.checks) && proposed.json.checks.length >= 1);
  const fileCheck = proposed.json.checks.find((check) => check.kind === 'file_exists');
  assert.ok(fileCheck, `no file_exists check: ${JSON.stringify(proposed.json.checks)}`);

  const challenged = await postJson(`/proofcard/receipts/${turn1.id}/challenge`, { claim_id: fileClaim.id, run: true });
  assert.equal(challenged.status, 200, challenged.text);
  const ranChecks = (challenged.json.checks || []).filter((check) => check.ran);
  assert.ok(ranChecks.length >= 1, 'run:true executed no checks');
  assert.ok(ranChecks.some((check) => check.kind === 'file_exists' && check.ok === true),
    `file check did not pass: ${JSON.stringify(ranChecks)}`);
  // Default allowCommandRerun=false: no command may be executed by the route.
  assert.ok(ranChecks.every((check) => check.kind === 'file_exists'),
    `a command check ran without allowCommandRerun: ${JSON.stringify(ranChecks)}`);

  const persisted = new ReceiptStore(dataDir).get(turn1.id);
  assert.ok(Array.isArray(persisted.challenges) && persisted.challenges.length >= 2,
    `challenges not persisted: ${JSON.stringify(persisted.challenges)}`);
});

// --------------------------------------------------------------------------- step 4: persistence

step('receipts, acceptance and challenges persist across a fresh store', () => {
  const fresh = new ReceiptStore(dataDir);
  const list = fresh.list(10, 'session-e2e');
  assert.equal(list.length, 2);
  assert.equal(list[0].prev_hash, list[1].hash);
  assert.equal(list[0].accepted, true, 'accept event did not persist');
  assert.equal(list[0].accept_note, 'turn 2 reviewed');
  const turn1 = list[1];
  assert.ok(turn1.challenges.length >= 1);
  const ledger = fs.readFileSync(path.join(dataDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(ledger.length, 2, 'accept/challenge rewrote the ledger');
  assert.ok(fs.existsSync(path.join(dataDir, 'events.jsonl')));
});

// --------------------------------------------------------------------------- step 5: latency

step('route handler latency p95 stays small', async () => {
  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now();
    const result = await request('/proofcard/receipts?limit=20');
    samples.push(performance.now() - started);
    assert.equal(result.status, 200);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`    route latency: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (40 samples)`);
  assert.ok(p95 < 100, `route p95 ${p95.toFixed(1)} ms exceeds 100 ms`);
});

// --------------------------------------------------------------------------- step 6: static checks

step('every JS file passes node --check and the bundle manifest is consistent', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(ROOT);
  assert.ok(files.length >= 6, `only found ${files.length} JS files`);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `node --check failed for ${path.relative(ROOT, file)}:\n${result.stderr}`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'client.js')), 'missing client.js');
  const clientCheck = spawnSync(process.execPath, ['--check', path.join(ROOT, 'client.js')], { encoding: 'utf8' });
  assert.equal(clientCheck.status, 0, `client.js node --check failed:\n${clientCheck.stderr}`);

  const pkg = readJson(path.join(ROOT, 'package.json'));
  assert.equal(pkg.name, '@local/proofcard-dsh');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'], './client.js');
  assert.ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web');
  assert.ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')));
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('@local/proofcard-dsh'), 'patch does not name the plugin package');
  assert.ok(fs.existsSync(path.join(ROOT, 'icon.svg')), 'missing icon.svg');
  const localeDir = path.join(ROOT, 'locale');
  assert.ok(fs.existsSync(localeDir) && fs.readdirSync(localeDir).some((name) => name.endsWith('.json')),
    'missing locale JSON files');
});

// --------------------------------------------------------------------------- runner

let passed = 0;
const failures = [];
for (const { name, fn } of steps) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(`     ${error && error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n     ') : error}`);
  }
}
while (cleanups.length) {
  try { cleanups.pop()(); } catch { /* best effort */ }
}
console.log(`\n${passed}/${steps.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFailures:');
  for (const { name } of failures) console.error(` - ${name}`);
  process.exitCode = 1;
}
