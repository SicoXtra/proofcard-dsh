#!/usr/bin/env node
/**
 * Mock-load test for the Proofcard DSH Host half. No dependencies, Node 22+.
 *
 * Loads the real core modules and `index.js`, drives them through a fake Cordis
 * context, feeds one synthetic completed turn through the `session/event` feed,
 * then asserts the receipt, the six tools, the prompt context, and the
 * `/proofcard` HTTP bridge. Everything is written under a temp dir and removed.
 *
 * Run: node proofcard-dsh/tests/mock-load.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const checks = [];

async function check(label, run) {
  try {
    await run();
    checks.push({ label, ok: true });
    console.log(`  ok   ${label}`);
  } catch (error) {
    checks.push({ label, ok: false, error });
    console.log(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createMockContext() {
  const log = {
    tools: [],
    promptContexts: [],
    routes: [],
    listeners: new Map(),
    effects: [],
    disposers: [],
  };
  const services = {
    tools: {
      register(definition) {
        log.tools.push(definition);
        return () => {
          const index = log.tools.indexOf(definition);
          if (index >= 0) log.tools.splice(index, 1);
        };
      },
    },
    systemPrompt: {
      context(entry) {
        log.promptContexts.push(entry);
        return () => {
          const index = log.promptContexts.indexOf(entry);
          if (index >= 0) log.promptContexts.splice(index, 1);
        };
      },
    },
    webServer: {
      register(route) {
        log.routes.push(route);
        return () => {
          const index = log.routes.indexOf(route);
          if (index >= 0) log.routes.splice(index, 1);
        };
      },
    },
  };

  const ctx = {
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    webServer: services.webServer,
    get(name) {
      return services[name];
    },
    on(name, listener) {
      const list = log.listeners.get(name) ?? [];
      list.push(listener);
      log.listeners.set(name, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(run) {
      const disposer = run();
      log.effects.push(disposer);
      log.disposers.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
  };

  return { ctx, log, services };
}

function eventFeed(session, log) {
  let seq = 0;
  const listeners = log.listeners.get('session/event') ?? [];
  return (type, data) => {
    const event = { type, seq: (seq += 1), time: Date.now(), data };
    for (const listener of listeners) listener(session, event);
    return event;
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'proofcard-mock-'));
  const profileDir = path.join(tempRoot, 'profile');
  const dshHome = path.join(tempRoot, 'home');
  const workspace = path.join(tempRoot, 'work');
  const dataDir = path.join(profileDir, 'proofcard');
  const savedEnv = {
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_HOME: process.env.DSH_HOME,
  };

  try {
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(
      path.join(workspace, 'src', 'export.py'),
      'def export_rows(rows):\n    return list(rows)\n',
      'utf8',
    );
    // The plugin resolves its data dir from the environment at apply() time.
    process.env.DSH_PROFILE_DIR = profileDir;
    process.env.DSH_HOME = dshHome;

    // ---- core modules (real files, loaded from the package root) ----------
    const coreFiles = ['claims.js', 'evidence.js', 'receipts.js', 'store.js', 'redact.js'];
    const core = {};
    for (const file of coreFiles) {
      core[file] = await import(pathToFileURL(path.join(packageDir, file)).href);
    }

    await check('core modules export the CONTRACT API', () => {
      assert.equal(typeof core['claims.js'].extractClaims, 'function', 'claims.extractClaims');
      assert.equal(typeof core['evidence.js'].normalizeToolCall, 'function', 'evidence.normalizeToolCall');
      assert.equal(typeof core['evidence.js'].summarizeEvidence, 'function', 'evidence.summarizeEvidence');
      assert.equal(typeof core['receipts.js'].buildReceipt, 'function', 'receipts.buildReceipt');
      assert.equal(typeof core['receipts.js'].receiptMarkdown, 'function', 'receipts.receiptMarkdown');
      assert.equal(typeof core['receipts.js'].proposedChecks, 'function', 'receipts.proposedChecks');
      assert.equal(typeof core['receipts.js'].runChecks, 'function', 'receipts.runChecks');
      assert.equal(typeof core['store.js'].ReceiptStore, 'function', 'store.ReceiptStore');
      assert.equal(typeof core['redact.js'].redact, 'function', 'redact.redact');
    });

    // ---- load the Host plugin through a fake Cordis context --------------
    const plugin = await import(pathToFileURL(path.join(packageDir, 'index.js')).href);
    const { ctx, log } = createMockContext();

    await check('index.js exports apply() and the declared services', () => {
      assert.equal(typeof plugin.apply, 'function', 'apply must be a function');
      assert.ok(Array.isArray(plugin.inject), 'inject must be an array');
      for (const service of ['tools', 'systemPrompt', 'webServer']) {
        assert.ok(plugin.inject.includes(service), `inject must include ${service}`);
      }
    });

    await check('apply() runs without throwing', async () => {
      await plugin.apply(ctx, { dataDir: '' });
    });

    // ---- registration surface --------------------------------------------
    const expectedTools = [
      'proofcard_list',
      'proofcard_show',
      'proofcard_accept',
      'proofcard_challenge',
      'proofcard_stats',
      'proofcard_export',
    ];

    await check('six proofcard tools are registered', () => {
      const names = log.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...expectedTools].sort());
      for (const tool of log.tools) {
        assert.equal(typeof tool.description, 'string', `${tool.name}.description`);
        assert.ok(tool.description.length > 20, `${tool.name}.description is useful`);
        assert.equal(typeof tool.parameters, 'object', `${tool.name}.parameters`);
        assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters.type`);
        assert.equal(typeof tool.output, 'object', `${tool.name}.output`);
        assert.equal(typeof tool.output.schema, 'object', `${tool.name}.output.schema`);
        assert.equal(typeof tool.output.render, 'function', `${tool.name}.output.render`);
        assert.equal(typeof tool.execute, 'function', `${tool.name}.execute`);
        // DSH calls output.render(args, value): the rendered text must be the result value,
        // never the model's arguments.
        const blocks = tool.output.render({ sentinelArgs: true }, { ok: true, marker: 'VALUE' });
        assert.ok(Array.isArray(blocks) && blocks[0].type === 'text', `${tool.name}.output.render`);
        assert.ok(blocks[0].text.includes('"marker":"VALUE"'), `${tool.name}.output.render renders the result value`);
        assert.ok(!blocks[0].text.includes('sentinelArgs'), `${tool.name}.output.render must not render args`);
        const stringBlocks = tool.output.render({ sentinelArgs: true }, 'plain result');
        assert.deepEqual(stringBlocks, [{ type: 'text', text: 'plain result' }], `${tool.name}.output.render string value`);
      }
    });

    await check('prompt context is registered with the contract shape', () => {
      assert.equal(log.promptContexts.length, 1);
      const entry = log.promptContexts[0];
      assert.equal(entry.name, 'proofcard');
      assert.equal(entry.order, 125);
      assert.equal(entry.interpolate, false);
      assert.equal(typeof entry.text, 'function');
      const text = entry.text();
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0 && text.length < 400, `prompt text length ${text.length}`);
    });

    await check('prefix route /proofcard is registered', () => {
      assert.ok(log.routes.length >= 1);
      const route = log.routes.find((candidate) => typeof candidate.resource === 'function');
      assert.ok(route, 'no /proofcard resource route');
      assert.equal(route.path, '/proofcard');
      assert.equal(typeof route.resource, 'function');
    });

    await check('session/event listener and effects are owned', () => {
      const listeners = log.listeners.get('session/event') ?? [];
      assert.equal(listeners.length, 1);
      // listener + prompt + 6 tools + route
      assert.ok(log.effects.length >= 9, `effects: ${log.effects.length}`);
      for (const disposer of log.effects) assert.equal(typeof disposer, 'function');
    });

    // ---- synthetic completed turn ----------------------------------------
    const session = {
      id: 'sess_mock_001',
      header: { version: 1, id: 'sess_mock_001', createdAt: Date.now(), cwd: workspace, isSeeded: false },
    };
    const emit = eventFeed(session, log);

    emit('user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'Fix the export and run the tests.' }],
      source: { kind: 'user' },
    });
    emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'pytest -q' }) });
    emit('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'c1',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'text', text: '14 passed, 0 failed' }],
        isError: false,
      },
    });
    emit('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c2',
      name: 'write',
      arguments: JSON.stringify({ path: 'src/export.py', content: 'def export_rows(rows):\n    return list(rows)\n' }),
    });
    emit('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'c2',
        source: { kind: 'tool', callId: 'c2' },
        content: [{ type: 'text', text: 'Wrote src/export.py (52 bytes)' }],
        isError: false,
      },
    });
    emit('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'All 14 tests pass. I created `src/export.py`.' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
      },
      stream: [],
    });
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } });

    // A non-completed turn must not add a receipt.
    emit('user/message', { role: 'user', content: [{ type: 'text', text: 'Ignore me.' }], source: { kind: 'user' } });
    emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });

    // ---- receipt assertions ----------------------------------------------
    const { ReceiptStore } = core['store.js'];
    const store = new ReceiptStore(dataDir);

    await check('exactly one receipt lands in the temp data dir', () => {
      assert.ok(existsSync(dataDir), `data dir ${dataDir} exists`);
      const files = readdirSync(dataDir);
      assert.ok(files.length >= 1, 'data dir contains files');
      const receipts = store.list(50);
      assert.equal(receipts.length, 1, `receipts: ${receipts.length}`);
      assert.equal(receipts[0].session_id, 'sess_mock_001');
    });

    const receipts = store.list(50);
    const receipt = receipts[0];

    await check('receipt has a verified test_passed claim', () => {
      const claims = Array.isArray(receipt.claims) ? receipt.claims : [];
      const claim = claims.find((entry) => entry.kind === 'test_passed');
      assert.ok(claim, 'test_passed claim missing');
      assert.equal(claim.verdict, 'verified', `verdict: ${claim.verdict}`);
    });

    await check('receipt has a verified or partial file_changed claim', () => {
      const claims = Array.isArray(receipt.claims) ? receipt.claims : [];
      const claim = claims.find((entry) => entry.kind === 'file_changed');
      assert.ok(claim, 'file_changed claim missing');
      assert.ok(['verified', 'partial'].includes(claim.verdict), `verdict: ${claim.verdict}`);
    });

    await check('receipt stats count at least two claims', () => {
      const stats = receipt.stats;
      assert.equal(typeof stats, 'object');
      assert.ok(Number(stats.claims) >= 2, `stats.claims: ${stats.claims}`);
      assert.ok(Array.isArray(receipt.claims) && receipt.claims.length >= 2);
    });

    await check('receipt captures the request, answer, tools, and hash chain', () => {
      assert.match(String(receipt.user_request ?? ''), /Fix the export/);
      assert.match(String(receipt.answer_excerpt ?? ''), /14 tests/);
      assert.ok(Array.isArray(receipt.tools_used) && receipt.tools_used.includes('pwsh'));
      assert.ok(Array.isArray(receipt.files_touched) && receipt.files_touched.some((file) => String(file).includes('export.py')));
      assert.equal(typeof receipt.hash, 'string');
      assert.ok(receipt.hash.length > 0);
      assert.ok(Array.isArray(receipt.commands) && receipt.commands.some((command) => String(command.command ?? '').includes('pytest')));
    });

    await check('store.latest resolves the current session', () => {
      const latest = store.latest('sess_mock_001');
      assert.ok(latest);
      assert.equal(latest.id, receipt.id);
      assert.equal(store.latest('sess_other'), null);
    });

    // ---- tool handlers (never throw, return plain JSON) -------------------
    const tools = new Map(log.tools.map((tool) => [tool.name, tool]));
    const exec = { agent: { id: 'sess_mock_001' } };
    const fileClaim = (Array.isArray(receipt.claims) ? receipt.claims : []).find((claim) => claim.kind === 'file_changed');
    const fileClaimId = fileClaim ? fileClaim.id : undefined;
    const challengeCount = () => {
      const current = new ReceiptStore(dataDir).get(receipt.id);
      return Array.isArray(current?.challenges) ? current.challenges.length : 0;
    };

    await check('proofcard_list returns the receipt summary', async () => {
      const value = await tools.get('proofcard_list').execute({}, exec);
      assert.equal(value.ok, true);
      assert.equal(value.count, 1);
      assert.equal(value.receipts[0].id, receipt.id);
    });

    await check('proofcard_show returns receipt + markdown', async () => {
      const value = await tools.get('proofcard_show').execute({}, exec);
      assert.equal(value.ok, true);
      assert.equal(value.id, receipt.id);
      assert.equal(typeof value.markdown, 'string');
      assert.ok(value.markdown.length > 0);
    });

    await check('proofcard_stats returns totals', async () => {
      const value = await tools.get('proofcard_stats').execute({}, exec);
      assert.equal(value.ok, true);
      assert.equal(typeof value.totals, 'object');
    });

    await check('proofcard_export returns markdown by default', async () => {
      const value = await tools.get('proofcard_export').execute({}, exec);
      assert.equal(value.ok, true);
      assert.equal(value.format, 'markdown');
      assert.ok(value.content.length > 0);
    });

    await check('unknown receipt id degrades instead of throwing', async () => {
      const value = await tools.get('proofcard_show').execute({ id: 'rc_missing' }, exec);
      assert.equal(value.ok, false);
      assert.equal(value.error, 'receipt_not_found');
    });

    await check('proofcard_challenge without run proposes checks and records run:false', async () => {
      const before = challengeCount();
      const value = await tools.get('proofcard_challenge').execute({ claim_id: fileClaimId }, exec);
      assert.equal(value.ok, true);
      assert.equal(value.run, false);
      assert.ok(Array.isArray(value.checks) && value.checks.length >= 1, 'proposal must not be empty');
      assert.ok(value.checks.some((check) => check.kind === 'file_exists'), 'proposal has no file_exists check');
      assert.ok(value.checks.every((check) => check.ran === undefined), 'proposal must not execute checks');
      const persisted = new ReceiptStore(dataDir).get(receipt.id);
      assert.equal(persisted.challenges.length, before + 1, 'proposal challenge not recorded');
      const recorded = persisted.challenges[persisted.challenges.length - 1];
      assert.equal(recorded.run, false);
      assert.ok(Array.isArray(recorded.checks) && recorded.checks.length >= 1, 'empty challenge recorded');
    });

    await check('proofcard_challenge records a challenge with safe checks', async () => {
      const value = await tools.get('proofcard_challenge').execute({ run: true, note: 'agent check' }, exec);
      assert.equal(value.ok, true);
      assert.equal(value.id, receipt.id);
      assert.equal(value.run, true);
      assert.ok(Array.isArray(value.checks));
      const ranChecks = value.checks.filter((check) => check.ran === true);
      assert.ok(ranChecks.length >= 1, 'run:true executed no checks');
      assert.ok(ranChecks.every((check) => check.kind === 'file_exists'), 'command check ran without allowCommandRerun');
      // A fresh store instance reloads the event overlay the plugin appended.
      const updated = new ReceiptStore(dataDir).get(receipt.id);
      assert.ok(updated, 'receipt still readable');
      assert.ok(Array.isArray(updated.challenges) && updated.challenges.length >= 1);
    });

    // ---- HTTP bridge ------------------------------------------------------
    const base = 'http://127.0.0.1';
    const route = log.routes.find((candidate) => typeof candidate.resource === 'function');

    await check('GET /proofcard/receipts returns JSON', async () => {
      const response = await route.resource(new Request(`${base}/proofcard/receipts?limit=5`));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.count, 1);
      assert.equal(payload.receipts.length, 1);
      assert.equal(payload.receipts[0].id, receipt.id);
    });

    await check('GET /proofcard/receipts/{id} returns the receipt', async () => {
      const response = await route.resource(new Request(`${base}/proofcard/receipts/${encodeURIComponent(receipt.id)}`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.receipt.id, receipt.id);
    });

    await check('GET /proofcard/health reports the bridge', async () => {
      const response = await route.resource(new Request(`${base}/proofcard/health`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.name, 'proofcard-dsh');
      assert.equal(payload.version, '1.0.0');
      assert.equal(payload.receipts, 1);
    });

    await check('GET /proofcard/stats returns totals', async () => {
      const response = await route.resource(new Request(`${base}/proofcard/stats`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(typeof payload.totals, 'object');
    });

    await check('POST accept records the acceptance', async () => {
      const response = await route.resource(
        new Request(`${base}/proofcard/receipts/${encodeURIComponent(receipt.id)}/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: 'looks right' }),
        }),
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.receipt.accepted, true);
      assert.equal(payload.receipt.accept_note, 'looks right');
    });

    await check('POST challenge run=false proposes checks and records them', async () => {
      const before = challengeCount();
      const response = await route.resource(
        new Request(`${base}/proofcard/receipts/${encodeURIComponent(receipt.id)}/challenge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claim_id: fileClaimId, run: false }),
        }),
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.run, false);
      assert.ok(Array.isArray(payload.checks) && payload.checks.length >= 1, 'proposal must not be empty');
      assert.ok(payload.checks.some((check) => check.kind === 'file_exists'), 'proposal has no file_exists check');
      assert.ok(payload.checks.every((check) => check.ran === undefined), 'proposal must not execute checks');
      const persisted = new ReceiptStore(dataDir).get(receipt.id);
      assert.equal(persisted.challenges.length, before + 1, 'proposal challenge not recorded');
    });

    await check('POST challenge with run=true re-checks and records', async () => {
      const response = await route.resource(
        new Request(`${base}/proofcard/receipts/${encodeURIComponent(receipt.id)}/challenge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ run: true }),
        }),
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.run, true);
      assert.ok(Array.isArray(payload.checks));
      const ranChecks = payload.checks.filter((check) => check.ran === true);
      assert.ok(ranChecks.length >= 1, 'run:true executed no checks');
      assert.ok(
        ranChecks.some((check) => check.kind === 'file_exists' && check.ok === true),
        `file check did not pass: ${JSON.stringify(ranChecks)}`,
      );
      assert.ok(
        ranChecks.every((check) => check.kind === 'file_exists'),
        'a command check ran without allowCommandRerun',
      );
      assert.ok(Array.isArray(payload.receipt.challenges) && payload.receipt.challenges.length >= 1);
    });

    await check('POST accept with invalid JSON answers 400', async () => {
      const response = await route.resource(
        new Request(`${base}/proofcard/receipts/${encodeURIComponent(receipt.id)}/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        }),
      );
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error, 'invalid_json');
    });

    await check('unknown route answers 404 JSON', async () => {
      const response = await route.resource(new Request(`${base}/proofcard/nope`));
      assert.equal(response.status, 404);
      const payload = await response.json();
      assert.equal(payload.error, 'not_found');
    });

    await check('garbage session events never throw', () => {
      const listeners = log.listeners.get('session/event') ?? [];
      const listener = listeners[0];
      const garbage = [
        [null, null],
        [{}, { type: 'tool/result', data: null }],
        [session, { type: 'tool/call', data: { callId: 'g1' } }],
        [session, { type: 'turn/end', data: { reason: 'weird' } }],
        [session, { type: 'unknown/type', data: {} }],
        [session, {}],
      ];
      for (const [fakeSession, fakeEvent] of garbage) {
        assert.doesNotThrow(() => listener(fakeSession, fakeEvent));
      }
    });

    // The buffered garbage above must not have produced another receipt.
    await check('garbage events do not append receipts', () => {
      assert.equal(store.list(50).length, 1);
    });

    await check('skipped proofcard_* and unpairable results never become evidence', async () => {
      const isolated = createMockContext();
      const isolatedDir = path.join(tempRoot, 'pairing-data');
      await plugin.apply(isolated.ctx, { dataDir: isolatedDir });
      const isolatedSession = {
        id: 'sess_pairing_001',
        header: { version: 1, id: 'sess_pairing_001', createdAt: Date.now(), cwd: workspace, isSeeded: false },
      };
      const feed = eventFeed(isolatedSession, isolated.log);

      feed('user/message', { role: 'user', content: [{ type: 'text', text: 'Run the tests.' }], source: { kind: 'user' } });
      feed('tool/call', { turn: 1, step: 1, callId: 'call_test', name: 'pwsh', arguments: JSON.stringify({ command: 'pytest -q' }) });
      feed('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_test' },
          content: [{ type: 'text', text: '14 passed, 0 failed' }],
          isError: false,
        },
      });
      // Our own tool: the call must be skipped and its result must not leak as evidence.
      feed('tool/call', { turn: 1, step: 1, callId: 'call_internal', name: 'proofcard_list', arguments: '{}' });
      feed('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_internal' },
          content: [{ type: 'text', text: '{"receipts":[]}' }],
          isError: false,
        },
      });
      // A result whose call never arrived (listener attached late) is unpairable evidence.
      feed('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_ghost' },
          content: [{ type: 'text', text: 'ghost output' }],
          isError: false,
        },
      });
      feed('assistant/message', {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'All 14 tests pass.' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
        },
        stream: [],
      });
      feed('turn/end', { turn: 1, reason: { kind: 'completed' } });

      const receipts = new ReceiptStore(isolatedDir).list(10);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].evidence_count, 1, `evidence_count: ${receipts[0].evidence_count}`);
      assert.deepEqual(receipts[0].tools_used, ['pwsh']);
    });

    await check('apply() degrades without optional services and honors dataDir', async () => {
      const partial = createMockContext();
      delete partial.services.systemPrompt;
      delete partial.services.webServer;
      delete partial.ctx.systemPrompt;
      delete partial.ctx.webServer;
      const overrideDir = path.join(tempRoot, 'override-data');
      await plugin.apply(partial.ctx, { dataDir: overrideDir, ambientPrompt: false });
      assert.equal(partial.log.tools.length, 6, 'tools still register');
      assert.equal(partial.log.promptContexts.length, 0, 'no prompt context without systemPrompt');
      assert.equal(partial.log.routes.length, 0, 'no route without webServer');
      assert.ok(existsSync(overrideDir), 'config.dataDir override is used');
    });
  } finally {
    if (savedEnv.DSH_PROFILE_DIR === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = savedEnv.DSH_PROFILE_DIR;
    if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedEnv.DSH_HOME;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();

const failed = checks.filter((entry) => !entry.ok);
console.log('');
if (failed.length > 0) {
  console.error(`mock-load: ${checks.length - failed.length}/${checks.length} checks passed, ${failed.length} failed`);
  for (const entry of failed) {
    console.error(` - ${entry.label}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`PASS mock-load: ${checks.length}/${checks.length} checks — 6 tools, prompt context, prefix route, 1 receipt, route JSON`);
}
