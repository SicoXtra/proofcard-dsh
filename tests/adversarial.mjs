#!/usr/bin/env node
/**
 * Independent adversarial tests for Proofcard DSH (verifier-owned).
 *
 * Zero dependencies; run with any Node >= 20:
 *   node proofcard-dsh/tests/adversarial.mjs
 *
 * Covers the core engine (claims, evidence, receipts, redaction, store) plus the
 * Host surface (session/event capture, six tools, /proofcard routes, prompt context)
 * and the Client module load. Spec: proofcard-dsh/CONTRACT.md.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CLAIM_KINDS, extractClaims } from '../claims.js';
import { classifyTool, normalizeToolCall, summarizeEvidence } from '../evidence.js';
import {
  buildReceipt, proposedChecks, receiptHash, receiptMarkdown, runChecks,
} from '../receipts.js';
import { ReceiptStore } from '../store.js';
import { redact } from '../redact.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// --------------------------------------------------------------------------- harness

const tests = [];
let currentSection = 'general';
function section(name) {
  currentSection = name;
}
function test(name, fn) {
  tests.push({ name: `${currentSection} :: ${name}`, fn });
}
const cleanups = [];
function tmpdir(prefix = 'proofcard-dsh-adv-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
function words(text) {
  return text.toLowerCase();
}
function byKind(receipt) {
  return Object.fromEntries((receipt.claims || []).map((claim) => [claim.kind, claim]));
}
function validKinds() {
  return new Set(CLAIM_KINDS);
}
function assertClaimShape(claim) {
  assert.ok(claim && typeof claim === 'object', 'claim must be an object');
  assert.equal(typeof claim.id, 'string');
  assert.match(claim.id, /^c\d+$/);
  assert.equal(typeof claim.text, 'string');
  assert.ok(claim.text.length > 0 && claim.text.length <= 400, `claim text length ${claim.text.length}`);
  assert.ok(validKinds().has(claim.kind), `unknown claim kind ${claim.kind}`);
  assert.ok(claim.subject && typeof claim.subject === 'object' && !Array.isArray(claim.subject));
}

// --------------------------------------------------------------------------- claims

section('claims');
test('positive claim kinds are extracted (9 kinds)', () => {
  const cases = [
    ['All 14 tests pass.', 'test_passed'],
    ['The test suite succeeded.', 'test_passed'],
    ['pytest -q is green.', 'test_passed'],
    ['Created `src/a.py`.', 'file_changed'],
    ['Updated README.md.', 'file_changed'],
    ['Deleted old.txt.', 'file_changed'],
    ['Ran `npm run build`.', 'command_ran'],
    ['Fetched https://example.com/page.', 'url_fetched'],
    ['Committed the fix.', 'commit'],
    ['Found 12 files.', 'count'],
    ['The refactor is complete.', 'assertion'],
    ['Sent the summary to Telegram.', 'message_sent'],
  ];
  for (const [text, kind] of cases) {
    const kinds = extractClaims(text).map((claim) => claim.kind);
    assert.ok(kinds.includes(kind), `${JSON.stringify(text)} should yield ${kind}; got ${kinds}`);
  }
});

test('file_exists contract triggers: backticked path, dotted config, bare "path exists"', () => {
  const backticked = extractClaims('`src/a.py` exists.');
  assert.equal(backticked[0]?.kind, 'file_exists', JSON.stringify(backticked));
  assert.ok(backticked[0].subject.paths.includes('src/a.py'));

  const dotted = extractClaims('The config file `config.yaml` is present.');
  assert.equal(dotted[0]?.kind, 'file_exists', JSON.stringify(dotted));
  assert.ok(dotted[0].subject.paths.includes('config.yaml'));

  const bare = extractClaims('src/a.py exists.');
  assert.equal(bare[0]?.kind, 'file_exists', JSON.stringify(bare));
});

test('negations are dropped, not reported as claims', () => {
  const negated = [
    'All tests did NOT pass.',
    'The tests did not pass.',
    "The tests didn't pass.",
    'I did not create `src/a.py`.',
    "I haven't created `src/a.py`.",
    'I never created `src/a.py`.',
    'I have not updated README.md.',
    'The migration failed to run.',
    'I was unable to run `pytest -q`.',
    'The file is not present.',
    'No tests failed.',
    'Nothing failed.',
  ];
  for (const text of negated) {
    assert.deepEqual(extractClaims(text), [], `negated sentence became a claim: ${JSON.stringify(text)}`);
  }
});

test('future tense, plans and questions are dropped', () => {
  for (const text of [
    'Did all the tests pass?',
    'Should I update README.md?',
    'I will create `src/a.py`.',
    "I'll run `pytest -q` next.",
    'We should update README.md.',
    'Next step: create `src/a.py`.',
    'TODO create `src/a.py`.',
  ]) {
    assert.deepEqual(extractClaims(text), [], `non-completion sentence became a claim: ${JSON.stringify(text)}`);
  }
});

test('fenced code blocks are ignored, prose around them is not', () => {
  const fenced = 'Here is the log:\n```\nAll 14 tests pass.\nCreated `src/a.py`.\n```\n';
  assert.deepEqual(extractClaims(fenced), []);

  const mixed = '```python\n# All tests pass\nprint("created `x.py`")\n```\nI updated `README.md`.\n';
  const claims = extractClaims(mixed);
  assert.equal(claims.length, 1, JSON.stringify(claims));
  assert.equal(claims[0].kind, 'file_changed');
  assert.ok(claims[0].subject.paths.includes('README.md'));
  assert.ok(!JSON.stringify(claims).includes('x.py'));
});

test('markdown tables do not crash and never emit invalid claims', () => {
  const table = '| Step | Result |\n|---|---|\n| tests | all tests pass |\n| file | created `src/a.py` |\n\nAll 14 tests pass.\n';
  const claims = extractClaims(table);
  assert.ok(Array.isArray(claims));
  assert.ok(claims.some((claim) => claim.kind === 'test_passed'));
  for (const claim of claims) assertClaimShape(claim);
});

test('non-English replies do not produce English false positives', () => {
  for (const text of [
    'Tous les tests passent.',
    'Alle Tests bestehen.',
    '所有测试通过。',
    'Los tests pasaron correctamente.',
    'Все тесты прошли.',
  ]) {
    assert.deepEqual(extractClaims(text), [], `false positive on ${JSON.stringify(text)}`);
  }
});

test('20k-char reply is bounded, valid and fast', () => {
  const reply = 'All 14 tests pass (pytest -q). Created `src/a.py`. Fetched https://example.com/x. '.repeat(300).slice(0, 20000);
  assert.ok(reply.length >= 20000);
  const started = performance.now();
  const claims = extractClaims(reply);
  const elapsed = performance.now() - started;
  assert.ok(claims.length <= 12, `claims ${claims.length}`);
  assert.ok(elapsed < 500, `20k extraction took ${elapsed.toFixed(1)} ms`);
  for (const claim of claims) assertClaimShape(claim);
});

test('duplicate claims are deduplicated', () => {
  const claims = extractClaims('Created `src/a.py`. Created `src/a.py` again.');
  assert.equal(claims.length, 1, JSON.stringify(claims));
  const repeated = extractClaims('All tests pass. All tests pass. All tests pass.');
  assert.equal(repeated.length, 1, JSON.stringify(repeated));
});

test('"all tests pass" without and with a recorded command', () => {
  const plain = extractClaims('All tests pass.');
  assert.equal(plain[0].kind, 'test_passed');
  assert.equal(plain[0].subject.noun, 'tests');
  assert.equal(plain[0].subject.command, undefined);

  const named = extractClaims('All 12 tests pass (pytest -q).');
  assert.equal(named[0].kind, 'test_passed');
  assert.equal(named[0].subject.count, 12);
  assert.equal(named[0].subject.command, 'pytest -q');
});

test('ambiguous chatter is dropped rather than guessed', () => {
  const chatter = [
    'It is what it is.',
    'Sounds good to me.',
    'Let me know if you need anything else.',
    'Here is a quick overview of the project layout.',
    'Thanks for waiting.',
    'The report is attached below.',
  ];
  for (const text of chatter) {
    assert.deepEqual(extractClaims(text), [], `chatter became a claim: ${JSON.stringify(text)}`);
  }
});

test('maxClaims cap, zero, default and clamp', () => {
  const many = Array.from({ length: 25 }, (_, index) => `Updated \`src/file_${index}.py\`.`).join(' ');
  assert.equal(extractClaims(many, 5).length, 5);
  assert.equal(extractClaims(many, 0).length, 0);
  assert.equal(extractClaims(many).length, 12);
  assert.ok(extractClaims(many, 1000).length <= 30);
});

test('claim shape, ids and sequential numbering', () => {
  const claims = extractClaims('All 12 tests pass. Created `src/a.py`. Fetched https://example.com.');
  claims.forEach((claim, index) => {
    assertClaimShape(claim);
    assert.equal(claim.id, `c${index + 1}`);
  });
});

test('non-string input never throws', () => {
  for (const value of [null, undefined, 42, Buffer.from('All tests pass'), ['All tests pass'], { text: 'x' }]) {
    assert.deepEqual(extractClaims(value), []);
  }
});

test('instructional and example-only text is not a completion claim', () => {
  const instructional = [
    'Use **Accept**, or **Challenge** to get read-only checks (e.g., `src/...` exists, re-run `pytest`) recorded on the receipt.',
    'For example, run `pytest` to check the suite.',
    'Run `pytest` and check the result.',
    'You should call `pytest` now.',
    'Open Settings -> Proofcard to review receipts.',
    'The file `src/...` exists.',
  ];
  for (const text of instructional) {
    assert.deepEqual(extractClaims(text), [], `instructional/example text became a claim: ${JSON.stringify(text)}`);
  }
  // Real completion statements in the same style still work.
  assert.deepEqual(extractClaims('All 14 tests pass.').map((claim) => claim.kind), ['test_passed']);
  assert.deepEqual(extractClaims('Created `src/a.py`.').map((claim) => claim.kind), ['file_changed']);
});

// --------------------------------------------------------------------------- evidence

section('evidence');
test('successful pytest is ok with command metadata', () => {
  const item = normalizeToolCall({
    callId: 'c1', name: 'pwsh',
    arguments: JSON.stringify({ command: 'pytest -q' }),
    resultText: '14 passed in 0.6s', durationMs: 610,
  });
  assert.equal(item.ok, true);
  assert.equal(item.command, 'pytest -q');
  assert.equal(item.exit_code, null);
  assert.equal(item.duration_ms, 610);
  assert.ok(item.caps.includes('terminal'));
});

test('"12 passed, 0 failed" is success, not a failure', () => {
  for (const resultText of ['14 passed, 0 failed in 0.6s', '0 failed, 14 passed', '0 failed', 'All 14 tests passed. 0 failed.']) {
    const item = normalizeToolCall({ callId: 'c1', name: 'pwsh', arguments: '{"command":"pytest -q"}', resultText });
    assert.equal(item.ok, true, `success summary misclassified: ${JSON.stringify(resultText)} (${item.failure_reason})`);
  }
});

test('failed outputs are ok=false', () => {
  const failures = [
    { resultText: '1 failed, 13 passed' },
    { resultText: '0 passed, 3 errors' },
    { resultText: 'Traceback (most recent call last):\nAssertionError' },
    { resultText: 'command not found: pytest' },
    { resultText: 'tests failed\nexit code: 1' },
    { resultText: 'looks fine', isError: true },
  ];
  for (const options of failures) {
    const item = normalizeToolCall({ callId: 'c', name: 'pwsh', arguments: '{"command":"pytest -q"}', ...options });
    assert.equal(item.ok, false, `failure classified as ok: ${JSON.stringify(options)}`);
  }
  const exitOne = normalizeToolCall({ callId: 'c', name: 'pwsh', arguments: '{"command":"pytest -q"}', resultText: 'exit code: 1' });
  assert.equal(exitOne.exit_code, 1);
});

test('write evidence records the touched file', () => {
  const item = normalizeToolCall({
    callId: 'w1', name: 'write', arguments: JSON.stringify({ path: 'src/a.py', content: 'x' }), resultText: 'wrote 10 bytes',
  });
  assert.equal(item.ok, true);
  assert.deepEqual(item.files, ['src/a.py']);
  assert.ok(item.caps.includes('write'));
  assert.ok(classifyTool('write').includes('write'));
});

test('internal proofcard_* tools are ignored', () => {
  for (const name of ['proofcard_list', 'proofcard_show', 'proofcard_accept', 'proofcard_challenge']) {
    assert.equal(normalizeToolCall({ callId: 'x', name, arguments: '{}', resultText: '{}' }), null);
  }
});

test('results are truncated and secret-bearing metadata redacted', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const item = normalizeToolCall({
    callId: 's1', name: 'pwsh',
    arguments: JSON.stringify({ command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://x.test` }),
    resultText: `${secret} ` + 'x'.repeat(5000),
  });
  assert.ok(item.result.length <= 2000, `result length ${item.result.length}`);
  assert.ok(item.args_text.length <= 600, `args length ${item.args_text.length}`);
  const dumped = JSON.stringify(item);
  assert.ok(!dumped.includes(secret), 'result secret leaked');
  assert.ok(!dumped.includes('abcdefghijklmnopqrstuvwxyz012345'), 'bearer token leaked through command/args');
  assert.ok(dumped.includes('[REDACTED]'));
});

test('normalizeToolCall never throws on malformed input', () => {
  for (const value of [undefined, null, {}, { name: '' }, { name: 'pwsh' },
    { name: 'pwsh', arguments: ['a', 1] }, { name: 'pwsh', arguments: 'not json' },
    { name: 'pwsh', arguments: { command: 5, path: null } },
    { name: 'pwsh', resultText: { nested: true }, durationMs: 'soon' },
    { name: 'pwsh', resultText: null, error: { code: 1 } }]) {
    assert.doesNotThrow(() => normalizeToolCall(value), `threw on ${JSON.stringify(value)}`);
  }
});

test('summarizeEvidence arithmetic and malformed items', () => {
  const items = [
    normalizeToolCall({ callId: 'a', name: 'pwsh', arguments: '{"command":"pytest -q"}', resultText: '14 passed', durationMs: 10 }),
    normalizeToolCall({ callId: 'b', name: 'pwsh', arguments: '{"command":"pytest -q"}', resultText: '14 passed', durationMs: 10 }),
    normalizeToolCall({ callId: 'c', name: 'pwsh', arguments: '{"command":"npm run build"}', resultText: 'built', durationMs: 5 }),
    normalizeToolCall({ callId: 'd', name: 'write', arguments: '{"path":"src/a.py"}', resultText: 'wrote' }),
    normalizeToolCall({ callId: 'e', name: 'write', arguments: '{"path":"src/a.py"}', resultText: 'wrote' }),
  ];
  const summary = summarizeEvidence(items);
  assert.deepEqual(summary.tools_used, ['pwsh', 'write']);
  assert.deepEqual(summary.files_touched, ['src/a.py']);
  assert.deepEqual(summary.commands.map((item) => item.command), ['pytest -q', 'npm run build']);
  assert.equal(summary.duration_ms, 25);
  assert.equal(summary.evidence_count, 5);
  const junk = summarizeEvidence([null, 5, 'x', {}, { tool: 5, files: 'nope', command: 5, duration_ms: 'x' }]);
  assert.equal(junk.evidence_count, 5);
  assert.deepEqual(junk.tools_used, []);
});

// --------------------------------------------------------------------------- redaction

section('redaction');
test('known credential shapes are redacted', () => {
  const secrets = {
    openai: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    aws: 'AKIAIOSFODNN7EXAMPLE',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    password: 'password=SuperSecret123',
    bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  };
  for (const [name, secret] of Object.entries(secrets)) {
    const output = redact(`value: ${secret} end`);
    assert.ok(output.includes('[REDACTED]'), `${name} not redacted: ${output}`);
    const raw = secret.includes('=') ? secret.split('=')[1] : name === 'bearer' ? 'abcdefghijklmnopqrstuvwxyz' : secret;
    assert.ok(!output.includes(raw), `${name} secret survived: ${output}`);
  }
});

test('normal prose is untouched', () => {
  const prose = 'All 14 tests pass. Created src/a.py and updated README.md. The task list is done; the token budget was fine. Password policy is documented separately.';
  assert.equal(redact(prose), prose);
});

test('empty and non-string input never throws', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(typeof redact(12345), 'string');
});

// --------------------------------------------------------------------------- receipts

section('receipts');
function makeDir() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'VALUE = 1\n');
  return dir;
}
function pytestOk(callId = 'call_test') {
  return normalizeToolCall({ callId, name: 'pwsh', arguments: JSON.stringify({ command: 'pytest -q' }), resultText: '14 passed, 0 failed in 0.6s' });
}
function pytestFail(callId = 'call_fail') {
  return normalizeToolCall({ callId, name: 'pwsh', arguments: JSON.stringify({ command: 'pytest -q' }), resultText: '1 failed, 13 passed\nexit code: 1' });
}
function writeOk(callId = 'call_write', file = 'src/a.py') {
  return normalizeToolCall({ callId, name: 'write', arguments: JSON.stringify({ path: file, content: 'VALUE = 1\n' }), resultText: 'wrote 12 bytes' });
}

test('receipt schema, defaults and stats arithmetic', () => {
  const cwd = makeDir();
  const receipt = buildReceipt({
    sessionId: 'sess-1', turn: 2, model: 'deepseek-flash', cwd,
    userRequest: 'fix the export', answer: 'All 14 tests pass. Created `src/a.py`. Fetched https://example.com.',
    evidence: [pytestOk(), writeOk()], prevHash: null, config: { maxClaims: 12 },
  });
  for (const field of ['schema', 'id', 'created_at', 'session_id', 'turn', 'model', 'cwd', 'user_request',
    'answer_excerpt', 'claims', 'stats', 'evidence_count', 'tools_used', 'files_touched', 'commands',
    'duration_ms', 'prev_hash', 'hash', 'accepted', 'accepted_at', 'accepted_by', 'accept_note', 'challenges']) {
    assert.ok(field in receipt, `missing receipt field ${field}`);
  }
  assert.equal(receipt.schema, 1);
  assert.match(receipt.id, /^rc_\d{8}_\d{6}_[0-9a-f]{4,}$/);
  assert.equal(receipt.session_id, 'sess-1');
  assert.equal(receipt.turn, 2);
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.prev_hash, null);
  assert.match(receipt.hash, /^[0-9a-f]{64}$/);
  const stats = receipt.stats;
  assert.equal(stats.claims, receipt.claims.length);
  assert.equal(stats.verified + stats.partial + stats.unverified + stats.contradicted, stats.claims);
  assert.equal(receipt.evidence_count, 2);
  assert.ok(receipt.tools_used.includes('pwsh'));
  assert.ok(receipt.files_touched.includes('src/a.py'));
  for (const claim of receipt.claims) {
    assertClaimShape(claim);
    assert.ok(['verified', 'partial', 'unverified', 'contradicted'].includes(claim.verdict));
    assert.ok(claim.confidence >= 0 && claim.confidence <= 1);
    assert.ok(Array.isArray(claim.evidence));
    assert.equal(typeof claim.note, 'string');
  }
});

test('passing pytest evidence verifies a test claim', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()], config: { maxClaims: 12 } });
  const claim = byKind(receipt).test_passed;
  assert.equal(claim.verdict, 'verified');
  assert.ok(claim.evidence.length >= 1);
  assert.equal(claim.evidence[0].id, 'call_test');
});

test('exit code 1 / "1 failed" contradicts a test claim', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestFail()] });
  assert.equal(byKind(receipt).test_passed.verdict, 'contradicted');
  const zeroPassed = buildReceipt({
    sessionId: 's', answer: 'All tests pass.',
    evidence: [normalizeToolCall({ callId: 'z', name: 'pwsh', arguments: '{"command":"pytest -q"}', resultText: '0 passed, 3 errors' })],
  });
  assert.equal(byKind(zeroPassed).test_passed.verdict, 'contradicted');
});

test('a README that claims tests pass must NOT verify a test claim', () => {
  const read = normalizeToolCall({ callId: 'r1', name: 'read', arguments: JSON.stringify({ path: 'README.md' }), resultText: 'Docs: all tests pass in CI' });
  const receipt = buildReceipt({ sessionId: 's', answer: 'All tests pass.', evidence: [read] });
  assert.notEqual(byKind(receipt).test_passed.verdict, 'verified');
});

test('claimed missing path is contradicted', () => {
  const cwd = makeDir();
  const receipt = buildReceipt({ sessionId: 's', cwd, answer: 'Created `src/missing.py`.', evidence: [] });
  const claim = byKind(receipt).file_changed;
  assert.equal(claim.kind, 'file_changed');
  assert.equal(claim.verdict, 'contradicted');
  assert.ok(claim.note.includes('missing.py'));
});

test('write-like evidence for a created path is verified', () => {
  const cwd = makeDir();
  const receipt = buildReceipt({ sessionId: 's', cwd, answer: 'Created `src/a.py`.', evidence: [writeOk()] });
  assert.equal(byKind(receipt).file_changed.verdict, 'verified');
});

test('read-only mention of an existing path is at most partial', () => {
  const cwd = makeDir();
  const read = normalizeToolCall({ callId: 'r1', name: 'read', arguments: JSON.stringify({ path: 'src/a.py' }), resultText: 'VALUE = 1' });
  const receipt = buildReceipt({ sessionId: 's', cwd, answer: 'Updated `src/a.py`.', evidence: [read] });
  assert.equal(byKind(receipt).file_changed.verdict, 'partial');
});

test('unrelated evidence leaves a claim unverified', () => {
  const web = normalizeToolCall({ callId: 'w1', name: 'web_search', arguments: '{"query":"cats"}', resultText: '5 results about cats' });
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [web] });
  assert.equal(byKind(receipt).test_passed.verdict, 'unverified');
  assert.deepEqual(byKind(receipt).test_passed.evidence, []);
});

test('failed-then-passing run is not contradicted', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestFail('c1'), pytestOk('c2')] });
  assert.notEqual(byKind(receipt).test_passed.verdict, 'contradicted');
});

test('multiple matching calls prefer the exact command match', () => {
  const loose = normalizeToolCall({ callId: 'loose', name: 'pwsh', arguments: '{}', resultText: 'tests passed' });
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass (pytest -q).', evidence: [loose, pytestOk('exact')] });
  const claim = byKind(receipt).test_passed;
  assert.equal(claim.verdict, 'verified');
  assert.equal(claim.evidence[0].id, 'exact', JSON.stringify(claim.evidence));
});

test('storeToolOutput=false must drop result excerpts from the receipt', () => {
  const receipt = buildReceipt({
    sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()],
    config: { maxClaims: 12, storeToolOutput: false },
  });
  const dumped = JSON.stringify(receipt);
  assert.ok(!dumped.includes('14 passed, 0 failed in 0.6s'), 'tool result excerpt stored despite storeToolOutput=false');
  for (const claim of receipt.claims) {
    for (const ref of claim.evidence) {
      assert.equal(ref.excerpt, undefined, `evidence excerpt stored despite storeToolOutput=false: ${JSON.stringify(ref)}`);
    }
  }
});

test('malformed evidence never throws and yields a valid receipt', () => {
  const junk = [null, 5, 'x', {}, { ok: null, result: null, command: 5, files: 'nope' },
    { args_text: 5, files: [null, 1], command: ['a'] }];
  assert.doesNotThrow(() => buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: junk }));
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: junk });
  assert.ok(['verified', 'partial', 'unverified', 'contradicted'].includes(byKind(receipt).test_passed.verdict));
});

test('malformed payloads never throw', () => {
  for (const payload of [undefined, null, {}, { answer: null }, { answer: 42 },
    { userRequest: { nested: true }, answer: ['x'] }, { evidence: 'not-an-array', config: 'nope' }]) {
    assert.doesNotThrow(() => buildReceipt(payload), `threw on ${JSON.stringify(payload)}`);
  }
});

test('no claims receipt is valid', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'Thanks, that makes sense. Let me know if you need anything else.' });
  assert.deepEqual(receipt.claims, []);
  assert.equal(receipt.stats.claims, 0);
  assert.match(receipt.hash, /^[0-9a-f]{64}$/);
});

test('truncation bounds and maxClaims config', () => {
  const receipt = buildReceipt({
    sessionId: 's', answer: 'All 14 tests pass. ' + 'x'.repeat(9000), userRequest: 'u'.repeat(5000),
    config: { maxClaims: 3 }, evidence: [],
  });
  assert.ok(receipt.user_request.length <= 400);
  assert.ok(receipt.answer_excerpt.length <= 1200);
  assert.ok(receipt.claims.length <= 3);
});

test('secrets in reply, request, commands and URLs are never stored', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const bearer = 'abcdefghijklmnopqrstuvwxyz012345';
  const command = `curl -H "Authorization: Bearer ${bearer}" https://x.test`;
  const evidence = [normalizeToolCall({ callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command }), resultText: 'ok' })];
  const receipt = buildReceipt({
    sessionId: 's', userRequest: `my key is ${secret}`, answer: `Stored the key ${secret} and ran the command.`, evidence,
  });
  const dumped = JSON.stringify(receipt);
  assert.ok(!dumped.includes(secret), 'reply/request secret leaked into the receipt');
  assert.ok(!dumped.includes(bearer), 'bearer token leaked into commands');
  assert.ok(dumped.includes('[REDACTED]'));
});

test('hash is independently recomputable from the contract fields', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()] });
  const fields = ['schema', 'id', 'created_at', 'session_id', 'turn', 'model', 'cwd', 'user_request',
    'answer_excerpt', 'claims', 'stats', 'evidence_count', 'tools_used', 'files_touched', 'commands',
    'duration_ms', 'prev_hash'];
  const stable = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  };
  const payload = {};
  for (const field of fields) payload[field] = receipt[field];
  const expected = crypto.createHash('sha256').update(stable(payload)).digest('hex');
  assert.equal(receipt.hash, expected, 'stored hash does not match the contract canonical hash');
});

test('hash chain links and tampering is detectable', () => {
  const first = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()], prevHash: null });
  const second = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()], prevHash: first.hash });
  assert.equal(second.prev_hash, first.hash);
  assert.notEqual(second.hash, first.hash);
  assert.notEqual(receiptHash(second), first.hash);

  const tampered = clone(first);
  tampered.claims[0].verdict = 'contradicted';
  assert.notEqual(receiptHash(tampered), first.hash, 'tamper not detected');
  const tamperedAnswer = clone(first);
  tamperedAnswer.answer_excerpt += ' (edited)';
  assert.notEqual(receiptHash(tamperedAnswer), first.hash, 'answer tamper not detected');
});

test('accept/challenge overlay fields do not change the integrity hash', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()] });
  const baseline = receipt.hash;
  receipt.accepted = true;
  receipt.accepted_at = 123;
  receipt.accepted_by = 'user';
  receipt.accept_note = 'ok';
  receipt.challenges = [{ claim_id: 'c1', outcome: 'passed' }];
  assert.equal(receiptHash(receipt), baseline);
});

test('deterministic output for identical input', () => {
  const cwd = makeDir();
  const options = { sessionId: 's', turn: 1, cwd, answer: 'All 14 tests pass. Created `src/a.py`.', evidence: [pytestOk(), writeOk()] };
  const a = buildReceipt({ ...options });
  const b = buildReceipt({ ...options });
  // ids/created_at are time/random-derived; the content hash is computed over them, so
  // normalise those identity fields before comparing the deterministic parts.
  a.id = 'rc_fixed'; a.created_at = 1; a.hash = receiptHash(a);
  b.id = 'rc_fixed'; b.created_at = 1; b.hash = receiptHash(b);
  assert.deepEqual(a, b, 'receipt content is not deterministic for identical input');
});

test('performance: 4k reply + 100 tool events under 100 ms', () => {
  const evidence = Array.from({ length: 100 }, (_, index) => normalizeToolCall({
    callId: `p${index}`, name: 'pwsh', arguments: JSON.stringify({ command: `pytest test_${index}.py` }), resultText: '1 passed',
  }));
  const answer = 'All 100 tests pass (pytest -q). Created `src/a.py`. Fetched https://example.com/x. '.repeat(70).slice(0, 4000);
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const receipt = buildReceipt({ sessionId: 'perf', answer, evidence, config: { maxClaims: 12 } });
    best = Math.min(best, performance.now() - started);
    assert.ok(receipt.stats.claims <= 12);
  }
  assert.ok(best < 100, `4k+100 evidence build took ${best.toFixed(1)} ms (budget 100 ms)`);
  console.log(`    performance: 4k reply + 100 events = ${best.toFixed(1)} ms (best of 5)`);
});

test('markdown rendering and non-object safety', () => {
  const receipt = buildReceipt({ sessionId: 's', answer: 'All 14 tests pass.', evidence: [pytestOk()], turn: 1, model: 'm' });
  const markdown = receiptMarkdown(receipt);
  assert.ok(markdown.includes(receipt.id));
  assert.ok(markdown.includes(receipt.hash));
  assert.ok(markdown.toLowerCase().includes('test_passed'));
  assert.equal(receiptMarkdown(null), 'No receipt.');
  assert.equal(typeof receiptMarkdown({}), 'string');
});

test('proposed checks shape and safety', () => {
  const cwd = makeDir();
  const receipt = buildReceipt({ sessionId: 's', cwd, answer: 'All 14 tests pass (pytest -q). Created `src/a.py`.', evidence: [pytestOk(), writeOk()] });
  const checks = proposedChecks(receipt);
  assert.ok(checks.length > 0);
  for (const check of checks) {
    assert.ok(['file_exists', 'command', 'url', 'manual'].includes(check.kind));
    assert.equal(typeof check.safe_to_run, 'boolean');
    assert.ok('claim_id' in check);
  }
  const fileCheck = checks.find((check) => check.kind === 'file_exists');
  assert.ok(fileCheck && fileCheck.safe_to_run);
  const commandCheck = checks.find((check) => check.kind === 'command');
  assert.ok(commandCheck && commandCheck.safe_to_run && commandCheck.command === 'pytest -q');
  const unsafe = proposedChecks({ commands: [], claims: [{ id: 'c1', kind: 'command_ran', subject: { command: 'rm -rf /' } }] });
  assert.ok(unsafe.length === 1 && unsafe[0].safe_to_run === false);
  assert.ok(proposedChecks(receipt, receipt.claims[0].id).every((check) => check.claim_id === receipt.claims[0].id));
  assert.deepEqual(proposedChecks(receipt, 'missing'), []);
});

test('runChecks is read-only and never throws', () => {
  const cwd = makeDir();
  const checks = [
    { claim_id: 'c1', kind: 'file_exists', path: path.join(cwd, 'src/a.py'), safe_to_run: true },
    { claim_id: 'c1', kind: 'file_exists', path: path.join(cwd, 'src/missing.py'), safe_to_run: true },
    { claim_id: 'c1', kind: 'manual', safe_to_run: false },
    { claim_id: 'c2', kind: 'command', command: 'rm -rf /', safe_to_run: true },
    { claim_id: 'c3', kind: 'command', command: 'pytest -q', safe_to_run: true },
  ];
  const results = runChecks(checks, { cwd, allowCommands: false });
  assert.equal(results.length, 5);
  assert.equal(results[0].ran, true);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ran, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[2].ran, false);
  assert.equal(results[3].ran, false, 'dangerous command ran');
  assert.equal(results[4].ran, false, 'command ran with allowCommands=false');
  assert.doesNotThrow(() => runChecks([null, 5, {}, { kind: 'nope' }], { cwd, allowCommands: false }));
  if (process.platform === 'win32') {
    const ran = runChecks([{ kind: 'command', command: 'dir', safe_to_run: true }], { cwd, allowCommands: true });
    assert.equal(ran[0].ran, true);
    assert.equal(ran[0].ok, true);
  }
});

// --------------------------------------------------------------------------- store

section('store');
function fakeReceipt(id, { session = 's1', createdAt = Date.now() / 1000, verdict = 'verified', claims = 1 } = {}) {
  const stats = { claims, verified: 0, partial: 0, unverified: 0, contradicted: 0 };
  stats[verdict] = claims;
  return {
    schema: 1, id, created_at: createdAt, session_id: session,
    claims: Array.from({ length: claims }, (_, index) => ({ id: `c${index + 1}`, kind: 'test_passed', verdict })),
    stats, hash: `hash_${id}`, prev_hash: null, accepted: false,
  };
}

test('append/list/get/latest/lastHash', () => {
  const dir = tmpdir();
  const store = new ReceiptStore(path.join(dir, 'data'));
  assert.equal(store.latest(), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('nope'), null);
  assert.equal(store.lastHash('s1'), null);
  const base = 1_700_000_000;
  for (let index = 0; index < 3; index += 1) {
    assert.equal(store.append(fakeReceipt(`rc_${index}`, { session: `s${index % 2}`, createdAt: base + index })), true);
  }
  assert.deepEqual(store.list(10).map((row) => row.id), ['rc_2', 'rc_1', 'rc_0']);
  assert.equal(store.latest().id, 'rc_2');
  assert.equal(store.latest('s1').id, 'rc_1');
  assert.equal(store.get('rc_0').id, 'rc_0');
  assert.equal(store.lastHash('s1'), 'hash_rc_1');
  assert.equal(store.list(2).length, 2);
});

test('accept and challenge are append-only overlays', () => {
  const dir = tmpdir();
  const dataDir = path.join(dir, 'data');
  const store = new ReceiptStore(dataDir);
  const receipt = fakeReceipt('rc_accept');
  store.append(receipt);
  const ledgerBefore = fs.readFileSync(path.join(dataDir, 'ledger.jsonl'), 'utf8');

  const accepted = store.accept('rc_accept', 'verified manually', 'alice');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.accepted_by, 'alice');
  assert.equal(accepted.accept_note, 'verified manually');
  assert.equal(typeof accepted.accepted_at, 'number');
  assert.equal(store.accept('missing'), null);

  const challenged = store.appendChallenge('rc_accept', { claim_id: 'c1', outcome: 'passed' });
  assert.equal(challenged.challenges.length, 1);
  assert.equal(store.appendChallenge('missing', {}), null);

  assert.equal(fs.readFileSync(path.join(dataDir, 'ledger.jsonl'), 'utf8'), ledgerBefore,
    'accept/challenge rewrote the immutable ledger');
  const reloaded = new ReceiptStore(dataDir);
  assert.equal(reloaded.get('rc_accept').accepted, true);
  assert.equal(reloaded.get('rc_accept').challenges.length, 1);
  assert.equal(reloaded.get('rc_accept').hash, receipt.hash);
});

test('stats totals and limits', () => {
  const dir = tmpdir();
  const store = new ReceiptStore(path.join(dir, 'data'));
  const base = 1_700_000_000;
  for (let index = 0; index < 3; index += 1) {
    store.append(fakeReceipt(`rc_stat_${index}`, {
      createdAt: base + index, verdict: index === 2 ? 'contradicted' : 'verified', claims: 2,
    }));
  }
  store.accept('rc_stat_1');
  const stats = store.stats(100);
  assert.equal(stats.totals.receipts, 3);
  assert.equal(stats.totals.claims, 6);
  assert.equal(stats.totals.verified, 4);
  assert.equal(stats.totals.contradicted, 2);
  assert.equal(stats.totals.accepted_receipts, 1);
  assert.equal(stats.totals.sessions, 1);
  assert.ok('test_passed' in stats.by_kind);
  assert.equal(store.stats(1).totals.receipts, 1);
});

test('corrupt and torn JSONL lines are tolerated', () => {
  const dir = tmpdir();
  const dataDir = path.join(dir, 'data');
  const store = new ReceiptStore(dataDir);
  store.append(fakeReceipt('rc_good'));
  fs.appendFileSync(path.join(dataDir, 'ledger.jsonl'), '{not json}\n{"id": "torn", "claims": [\n', 'utf8');
  fs.appendFileSync(path.join(dataDir, 'events.jsonl'), 'garbage\n', 'utf8');
  const reloaded = new ReceiptStore(dataDir);
  assert.ok(reloaded.get('rc_good'));
  assert.deepEqual(reloaded.list(10).map((row) => row.id), ['rc_good']);
  assert.equal(reloaded.append(fakeReceipt('rc_after_corrupt')), true);
});

test('8 concurrent appends keep the ledger parseable', async () => {
  const dir = tmpdir();
  const dataDir = path.join(dir, 'data');
  const store = new ReceiptStore(dataDir);
  const workers = Array.from({ length: 8 }, (_, worker) => (async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
      store.append(fakeReceipt(`rc_conc_${worker}_${index}`, { session: `s${worker % 3}` }));
    }
  })());
  await Promise.all(workers);
  assert.equal(store.list(200).length, 80);
  const lines = fs.readFileSync(path.join(dataDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 80);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(new ReceiptStore(dataDir).list(200).length, 80);
});

test('retention prune removes old receipts and rewrites the ledger', () => {
  const dir = tmpdir();
  const dataDir = path.join(dir, 'data');
  const store = new ReceiptStore(dataDir);
  const now = Date.now() / 1000;
  store.append(fakeReceipt('rc_ancient', { createdAt: now - 100 * 86_400 }));
  store.append(fakeReceipt('rc_recent', { createdAt: now - 86_400 }));
  assert.equal(store.prune(0), 0);
  assert.equal(store.prune('nonsense'), 0);
  assert.equal(store.prune(30), 1);
  assert.deepEqual(store.list(10).map((row) => row.id), ['rc_recent']);
  assert.deepEqual(new ReceiptStore(dataDir).list(10).map((row) => row.id), ['rc_recent']);
});

test('invalid appends and idempotent appends', () => {
  const dir = tmpdir();
  const store = new ReceiptStore(path.join(dir, 'data'));
  for (const value of [null, undefined, {}, 5, 'receipt', { id: '' }]) {
    assert.doesNotThrow(() => store.append(value));
    assert.equal(store.append(value), false);
  }
  const receipt = fakeReceipt('rc_dupe');
  assert.equal(store.append(receipt), true);
  assert.equal(store.append(clone(receipt)), true);
  assert.equal(store.list(10).length, 1);
});

// --------------------------------------------------------------------------- host / routes / client
// The Host and Client halves are owned by other builders; these tests load whatever
// is present. Missing files fail loudly (they are acceptance surfaces).

section('host');
const INDEX = path.join(ROOT, 'index.js');
async function importIndex() {
  assert.ok(fs.existsSync(INDEX), 'missing Host entrypoint index.js');
  return import(pathToFileURL(INDEX).href);
}

function makeCtx() {
  const captured = {
    events: {},
    tools: new Map(),
    promptContexts: [],
    routes: [],
    effects: [],
    disposers: [],
  };
  const ctx = {
    captured,
    on(name, handler) {
      (captured.events[name] ||= []).push(handler);
      return () => {};
    },
    tools: {
      register(definition) {
        captured.tools.set(definition.name, definition);
        return () => {};
      },
      restrict() { return () => {}; },
      guard() { return () => {}; },
    },
    systemPrompt: {
      context(definition) { captured.promptContexts.push(definition); return () => {}; },
      section(definition) { captured.promptContexts.push(definition); return () => {}; },
    },
    webServer: {
      register(route) { captured.routes.push(route); return () => {}; },
    },
    effect(fn) {
      const disposer = fn();
      captured.effects.push(disposer);
      return () => {};
    },
    get(name) { return ctx[name]; },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return ctx;
}

function mockSession(id = 'session-1', cwd = process.cwd()) {
  return { id, header: { cwd }, seq: 0 };
}
function emit(ctx, session, event) {
  const handlers = ctx.captured.events['session/event'] || [];
  for (const handler of handlers) handler(session, event);
}
function event(type, data) {
  return { type, seq: 1, time: Date.now() / 1000, data };
}
function userMessage(text) {
  return event('user/message', { role: 'user', content: [{ type: 'text', text }] });
}
function assistantMessage(text, turn = 1) {
  return event('assistant/message', {
    turn, step: 1, stream: [],
    message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
  });
}
function toolCall(callId, name, args, turn = 1) {
  return event('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
}
function toolResult(callId, text, { turn = 1, isError = false, error } = {}) {
  return event('tool/result', {
    turn, step: 1,
    message: {
      role: 'tool', content: [{ type: 'text', text }], toolCallId: callId,
      source: { kind: 'tool', callId }, isError,
    },
    ...(error ? { error } : {}),
  });
}
function turnStart(turn = 1) {
  return event('turn/start', { turn });
}
function turnEnd(turn = 1, kind = 'completed') {
  return event('turn/end', { turn, reason: { kind } });
}
function feedTurn(ctx, session, { turn = 1, request = 'do the work', reply, tools = [] } = {}) {
  emit(ctx, session, event('turn/start', { turn }));
  emit(ctx, session, userMessage(request));
  for (const tool of tools) {
    emit(ctx, session, toolCall(tool.callId, tool.name, tool.arguments, turn));
    emit(ctx, session, toolResult(tool.callId, tool.resultText, { turn, isError: tool.isError, error: tool.error }));
  }
  emit(ctx, session, assistantMessage(reply, turn));
  emit(ctx, session, turnEnd(turn));
}

async function makeHost(config = {}) {
  const module = await importIndex();
  assert.equal(typeof module.apply, 'function', 'index.js must export apply(ctx, config)');
  const ctx = makeCtx();
  const dir = tmpdir();
  module.apply(ctx, { dataDir: path.join(dir, 'data'), ...config });
  return { module, ctx, dir, dataDir: path.join(dir, 'data') };
}

test('Host registers session/event, six tools, a prompt context and the /proofcard route', async () => {
  const { ctx } = await makeHost();
  assert.ok((ctx.captured.events['session/event'] || []).length >= 1, 'no session/event listener');
  assert.equal(ctx.captured.tools.size, 6, `tools: ${[...ctx.captured.tools.keys()]}`);
  for (const name of ['proofcard_list', 'proofcard_show', 'proofcard_accept', 'proofcard_challenge', 'proofcard_stats', 'proofcard_export']) {
    assert.ok(ctx.captured.tools.has(name), `missing tool ${name}`);
  }
  assert.ok(ctx.captured.promptContexts.length >= 1, 'no prompt context registered');
  assert.ok(ctx.captured.routes.length >= 1, 'no webServer route registered');
  const route = ctx.captured.routes[0];
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/proofcard');
  assert.equal(typeof route.resource, 'function');
});

test('completed turns produce receipts; non-completed turns do not', async () => {
  const { ctx, dataDir } = await makeHost();
  const session = mockSession();
  feedTurn(ctx, session, { reply: 'All 14 tests pass.' });
  feedTurn(ctx, session, { turn: 2, reply: 'Should not be recorded.', });
  // second turn ended as completed above; make a non-completed third turn:
  emit(ctx, session, event('turn/start', { turn: 3 }));
  emit(ctx, session, userMessage('another'));
  emit(ctx, session, assistantMessage('All 14 tests pass.', 3));
  emit(ctx, session, turnEnd(3, 'aborted'));
  const store = new ReceiptStore(dataDir);
  assert.equal(store.list(10).length, 2, 'only completed turns should produce receipts');
});

test('tool calls are paired to results, proofcard_* calls skipped', async () => {
  const cwd = makeDir();
  const { ctx, dataDir } = await makeHost();
  const session = mockSession('session-pair', cwd);
  feedTurn(ctx, session, {
    reply: 'All 14 tests pass. Created `src/a.py`.',
    tools: [
      { callId: 'call_test', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed, 0 failed' },
      { callId: 'call_write', name: 'write', arguments: { path: 'src/a.py' }, resultText: 'wrote 12 bytes' },
      { callId: 'call_internal', name: 'proofcard_list', arguments: {}, resultText: '{}' },
    ],
  });
  const receipt = new ReceiptStore(dataDir).latest('session-pair');
  assert.ok(receipt, 'no receipt stored');
  assert.equal(receipt.evidence_count, 2, `internal tool counted: ${JSON.stringify(receipt.tools_used)}`);
  assert.ok(!receipt.tools_used.includes('proofcard_list'));
  assert.equal(byKind(receipt).test_passed.verdict, 'verified');
  assert.equal(byKind(receipt).file_changed.verdict, 'verified');
});

test('handler never throws on garbage, unknown events or malformed payloads', async () => {
  const { ctx, dataDir } = await makeHost();
  const session = mockSession();
  const handlers = ctx.captured.events['session/event'];
  const garbage = [
    null, undefined, {}, { }, [],
    { type: 'does/not-exist', data: {} },
    event('tool/call', null), event('tool/result', null), event('assistant/message', null),
    event('turn/end', null), event('user/message', null),
    event('turn/end', { reason: null }),
    event('tool/result', { message: { content: 'not-an-array' } }),
    event('assistant/message', { message: { content: [{ type: 'text', text: 42 }] } }),
  ];
  for (const handler of handlers) {
    for (const value of garbage) {
      assert.doesNotThrow(() => handler(session, value), `threw on ${JSON.stringify(value)}`);
      assert.doesNotThrow(() => handler(null, value));
      assert.doesNotThrow(() => handler(session));
    }
  }
  // 1 MB result should not throw or blow the ledger.
  feedTurn(ctx, session, {
    reply: 'All tests pass.',
    tools: [{ callId: 'big', name: 'pwsh', arguments: { command: 'npm run build' }, resultText: 'x'.repeat(1_000_000) }],
  });
  const receipt = new ReceiptStore(dataDir).latest('session-1');
  assert.ok(receipt);
  assert.ok(receipt.evidence_count >= 1);
});

test('duplicate call ids do not crash the host', async () => {
  const { ctx } = await makeHost();
  const session = mockSession('session-dup');
  feedTurn(ctx, session, {
    reply: 'All 14 tests pass.',
    tools: [
      { callId: 'same', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed' },
      { callId: 'same', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed' },
    ],
  });
});

test('host does not mutate the event objects it receives', async () => {
  const { ctx } = await makeHost();
  const session = mockSession('session-mutate');
  const events = [
    event('turn/start', { turn: 1 }),
    userMessage('do it'),
    toolCall('call_1', 'pwsh', { command: 'pytest -q' }),
    toolResult('call_1', '14 passed'),
    assistantMessage('All 14 tests pass.', 1),
    turnEnd(1),
  ];
  const before = events.map(clone);
  for (const item of events) emit(ctx, session, item);
  assert.deepEqual(events, before, 'host mutated a passed event object');
});

test('prompt context is non-empty, bounded, and disabled by ambientPrompt=false', async () => {
  const { ctx } = await makeHost();
  const definition = ctx.captured.promptContexts[0];
  assert.ok(definition, 'no prompt context');
  const text = typeof definition.text === 'function' ? definition.text({}) : definition.text;
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0 && text.length <= 400, `prompt text length ${text.length}`);
  assert.ok(definition.name === 'proofcard');

  const { ctx: offCtx } = await makeHost({ ambientPrompt: false });
  assert.deepEqual(offCtx.captured.promptContexts, []);
});

test('config enabled=false disables capture', async () => {
  const { ctx, dataDir } = await makeHost({ enabled: false });
  feedTurn(ctx, mockSession('session-disabled'), { reply: 'All 14 tests pass.' });
  assert.equal(new ReceiptStore(dataDir).list(10).length, 0);
});

test('a tool/result for a skipped proofcard_* call never becomes evidence', async () => {
  const { ctx, dataDir } = await makeHost();
  const session = mockSession('session-internal-result');
  feedTurn(ctx, session, {
    reply: 'All 14 tests pass.',
    tools: [
      { callId: 'call_test', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed, 0 failed' },
      { callId: 'call_internal', name: 'proofcard_list', arguments: {}, resultText: '{"receipts":[]}' },
    ],
  });
  const receipt = new ReceiptStore(dataDir).latest('session-internal-result');
  assert.ok(receipt);
  assert.equal(receipt.evidence_count, 1, `skipped internal result became evidence: ${JSON.stringify(receipt.tools_used)}`);
  assert.ok(!receipt.tools_used.includes('tool'), `orphan result recorded as a "tool": ${JSON.stringify(receipt.tools_used)}`);
});

test('host tolerates a bare or partial ctx and missing services', async () => {
  const { apply } = await importIndex();
  const dir = tmpdir();
  const bareCtxs = [
    undefined, null, {},
    { on() { return () => {}; } },
    { on() { return () => {}; }, tools: { register() { return () => {}; } } },
    {
      on() { return () => {}; },
      tools: { register() { return () => {}; } },
      systemPrompt: { context() { return () => {}; } },
      webServer: { register() { return () => {}; } },
      effect(fn) { return fn(); },
    },
    { on() { throw new Error('boom'); }, tools: null, systemPrompt: null, webServer: null,
      effect() { throw new Error('boom'); }, get() { throw new Error('boom'); } },
  ];
  for (const ctx of bareCtxs) {
    assert.doesNotThrow(() => apply(ctx, { dataDir: path.join(dir, `bare-${bareCtxs.indexOf(ctx)}`), ambientPrompt: true }),
      `apply threw for ${JSON.stringify(ctx)}`);
  }
});

test('data dir follows DSH_PROFILE_DIR then DSH_HOME when config.dataDir is empty', async () => {
  const { apply } = await importIndex();
  const saved = {
    profile: process.env.DSH_PROFILE_DIR,
    home: process.env.DSH_HOME,
  };
  const profileDir = tmpdir('proofcard-profile-');
  const homeDir = tmpdir('proofcard-home-');
  const feed = (moduleCtx, sessionId) => {
    const session = mockSession(sessionId, process.cwd());
    feedTurn(moduleCtx, session, { reply: 'All 14 tests pass.' });
  };
  try {
    delete process.env.DSH_PROFILE_DIR;
    delete process.env.DSH_HOME;
    process.env.DSH_PROFILE_DIR = profileDir;
    const profileCtx = makeCtx();
    apply(profileCtx, {});
    feed(profileCtx, 'session-profile');
    assert.ok(fs.existsSync(path.join(profileDir, 'proofcard', 'ledger.jsonl')), 'DSH_PROFILE_DIR not honoured');

    delete process.env.DSH_PROFILE_DIR;
    process.env.DSH_HOME = homeDir;
    const homeCtx = makeCtx();
    apply(homeCtx, {});
    feed(homeCtx, 'session-home');
    assert.ok(fs.existsSync(path.join(homeDir, 'proofcard', 'ledger.jsonl')), 'DSH_HOME not honoured');
  } finally {
    if (saved.profile === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = saved.profile;
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
  }
});

test('six tool handlers return JSON values and never throw on garbage', async () => {
  const cwd = makeDir();
  const { ctx } = await makeHost();
  const session = mockSession('session-tools', cwd);
  feedTurn(ctx, session, {
    reply: 'All 14 tests pass. Created `src/a.py`.',
    tools: [
      { callId: 'call_test', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed, 0 failed' },
      { callId: 'call_write', name: 'write', arguments: { path: 'src/a.py' }, resultText: 'wrote' },
    ],
  });
  const expected = ['proofcard_list', 'proofcard_show', 'proofcard_accept', 'proofcard_challenge', 'proofcard_stats', 'proofcard_export'];
  for (const name of expected) {
    const definition = ctx.captured.tools.get(name);
    assert.ok(definition, `missing tool ${name}`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 40, `${name} description too short`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    const rendered = definition.output.render({}, { ok: true });
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text' && typeof rendered[0].text === 'string');
    for (const args of [undefined, null, {}, { limit: 'abc' }, { id: 42 }, { run: 'maybe' }, { format: 'bogus' }]) {
      let value;
      try {
        value = await definition.execute(args, { agent: { id: 'session-tools' } });
      } catch (error) {
        assert.fail(`${name} threw on args ${JSON.stringify(args)}: ${error.message}`);
      }
      assert.doesNotThrow(() => JSON.stringify(value), `${name} returned non-serialisable value`);
      assert.ok(value && typeof value === 'object');
    }
  }
  const exec = { agent: { id: 'session-tools' } };
  const list = await ctx.captured.tools.get('proofcard_list').execute({ limit: 10 }, exec);
  assert.equal(list.ok, true);
  assert.ok(list.count >= 1 && list.receipts.length >= 1);
  const id = list.receipts[0].id;
  const show = await ctx.captured.tools.get('proofcard_show').execute({ id }, exec);
  assert.equal(show.ok, true);
  assert.equal(show.receipt.id, id);
  assert.ok(show.markdown.includes('Proofcard receipt'));
  const accepted = await ctx.captured.tools.get('proofcard_accept').execute({ id, note: 'tool ok' }, exec);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  const challenged = await ctx.captured.tools.get('proofcard_challenge').execute({ id, claim_id: 'c1', run: true }, exec);
  assert.equal(challenged.ok, true);
  assert.ok(Array.isArray(challenged.checks));
  const stats = await ctx.captured.tools.get('proofcard_stats').execute({}, exec);
  assert.equal(stats.ok, true);
  assert.ok(stats.totals.receipts >= 1);
  const exported = await ctx.captured.tools.get('proofcard_export').execute({ id, format: 'json' }, exec);
  assert.equal(exported.ok, true);
  assert.equal(exported.format, 'json');
  assert.doesNotThrow(() => JSON.parse(exported.content));
});

test('host bounds per-turn evidence and session memory', async () => {
  const { ctx, dataDir } = await makeHost();
  const session = mockSession('session-bounded');
  emit(ctx, session, event('turn/start', { turn: 1 }));
  emit(ctx, session, userMessage('run lots of checks'));
  for (let index = 0; index < 250; index += 1) {
    emit(ctx, session, toolCall(`call_${index}`, 'pwsh', { command: `pytest test_${index}.py` }, 1));
    emit(ctx, session, toolResult(`call_${index}`, '1 passed', { turn: 1 }));
  }
  emit(ctx, session, assistantMessage('All 250 tests pass.', 1));
  emit(ctx, session, turnEnd(1));
  // The host keeps at most 200 evidence items for one turn.
  const receipt = new ReceiptStore(dataDir).list(10, 'session-bounded')[0];
  assert.ok(receipt);
  assert.ok(receipt.evidence_count <= 200, `per-turn evidence bound exceeded: ${receipt.evidence_count}`);

  // 70 sessions must not grow memory without bound or break the feed.
  for (let index = 0; index < 70; index += 1) {
    const other = mockSession(`session-many-${index}`);
    emit(ctx, other, turnStart(index + 1));
    emit(ctx, other, userMessage('do work'));
    emit(ctx, other, assistantMessage('Done.', index + 1));
    emit(ctx, other, turnEnd(index + 1));
  }
});

test('retentionDays prunes old receipts when the Host is applied', async () => {
  const dir = tmpdir();
  const dataDir = path.join(dir, 'data');
  const seeded = new ReceiptStore(dataDir);
  const now = Date.now() / 1000;
  seeded.append({ ...fakeReceipt('rc_old', { createdAt: now - 100 * 86_400 }), session_id: 'old-session' });
  seeded.append({ ...fakeReceipt('rc_keep', { createdAt: now - 86_400 }), session_id: 'keep-session' });
  const { apply } = await importIndex();
  const ctx = makeCtx();
  apply(ctx, { dataDir, retentionDays: 30 });
  assert.deepEqual(new ReceiptStore(dataDir).list(10).map((row) => row.id), ['rc_keep']);
});

test('observe-only: Host registers no enforcement surface and no external network access', async () => {
  const { ctx } = await makeHost();
  assert.deepEqual(Object.keys(ctx.captured.events).sort(), ['session/event'],
    `unexpected Host event subscriptions: ${Object.keys(ctx.captured.events)}`);
  assert.ok(!ctx.captured.tools.has('proofcard_override'));
  const source = fs.readFileSync(INDEX, 'utf8');
  for (const marker of ['tools.guard(', 'tools.restrict(', "'pre-step'", "'pre-execute'",
    "'post-execute'", 'systemPrompt.section(']) {
    assert.ok(!source.includes(marker), `Host contains an enforcement surface: ${marker}`);
  }
  const jsFiles = ['index.js', 'claims.js', 'evidence.js', 'receipts.js', 'store.js', 'redact.js'];
  for (const file of jsFiles) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const marker of ["from 'node:http'", "from 'node:https'", "from 'node:net'",
      "from 'node:dns'", "require('https')", 'XMLHttpRequest', 'new WebSocket', 'fetch(http']) {
      assert.ok(!text.includes(marker), `${file} contains network access: ${marker}`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'bundle must have zero runtime dependencies');
  assert.equal(pkg.devDependencies, undefined, 'bundle must have zero dev dependencies');
});

test('config enabled=false creates no data dir and stores nothing', async () => {
  const dir = tmpdir();
  const dataDir = path.join(dir, 'disabled-data');
  const { apply } = await importIndex();
  const ctx = makeCtx();
  apply(ctx, { dataDir, enabled: false });
  assert.ok(!fs.existsSync(dataDir), 'disabled plugin created its data directory');
  feedTurn(ctx, mockSession('session-disabled-dir'), { reply: 'All 14 tests pass.' });
  assert.ok(!fs.existsSync(dataDir));
});

test('host passes config through: maxClaims and storeToolOutput', async () => {
  const { ctx, dataDir } = await makeHost({ maxClaims: 2, storeToolOutput: false });
  const session = mockSession('session-config');
  feedTurn(ctx, session, {
    reply: 'All 14 tests pass. Created `src/a.py`. Fetched https://example.com. The refactor is complete.',
    tools: [{ callId: 'c1', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed, 0 failed' }],
  });
  const receipt = new ReceiptStore(dataDir).latest('session-config');
  assert.ok(receipt);
  assert.ok(receipt.claims.length <= 2, `maxClaims not passed through: ${receipt.claims.length} claims`);
  const dumped = JSON.stringify(receipt);
  assert.ok(!dumped.includes('14 passed, 0 failed'), 'storeToolOutput=false not passed through to the receipt');
});

test('challenge command re-run stays opt-in behind allowCommandRerun', async () => {
  if (process.platform !== 'win32') return;
  const { ctx, dataDir } = await makeHost({ allowCommandRerun: true });
  const session = mockSession('session-rerun');
  feedTurn(ctx, session, {
    reply: 'Ran `dir`.',
    tools: [{ callId: 'c1', name: 'pwsh', arguments: { command: 'dir' }, resultText: 'Volume in drive C' }],
  });
  const receipt = new ReceiptStore(dataDir).latest('session-rerun');
  const claim = receipt.claims.find((item) => item.kind === 'command_ran');
  assert.ok(claim, JSON.stringify(receipt.claims));
  const challenged = await ctx.captured.tools.get('proofcard_challenge').execute({ id: receipt.id, claim_id: claim.id, run: true }, { agent: { id: 'session-rerun' } });
  assert.equal(challenged.ok, true);
  const ran = (challenged.checks || []).filter((check) => check.ran);
  assert.ok(ran.length >= 1, 'allowCommandRerun=true did not run the allow-listed command');
  assert.ok(ran.every((check) => check.kind === 'command'));
});

test('tool output.render describes the result value, not the arguments', async () => {
  const { ctx } = await makeHost();
  const exec = { agent: { id: 'session-render' } };
  const renderedText = (definition, args, value) => {
    const blocks = definition.output.render(args, value);
    assert.ok(Array.isArray(blocks) && blocks.length >= 1, `${definition.name} render returned no blocks`);
    return blocks.map((block) => (typeof block === 'string' ? block : block && block.text ? block.text : '')).join('\n');
  };
  const list = ctx.captured.tools.get('proofcard_list');
  const listArgs = { limit: 5, sentinel: 'ARGS-ONLY-SENTINEL' };
  const listValue = await list.execute(listArgs, exec);
  assert.equal(listValue.ok, true);
  const listText = renderedText(list, listArgs, listValue);
  assert.ok(listText.includes('"ok"') || listText.includes('"count"'),
    `render did not describe the list result: ${listText}`);
  assert.ok(!listText.includes('ARGS-ONLY-SENTINEL'),
    `render displayed the arguments instead of the result: ${listText}`);

  const show = ctx.captured.tools.get('proofcard_show');
  const showArgs = { id: 'rc_missing_render' };
  const showValue = await show.execute(showArgs, exec);
  assert.equal(showValue.ok, false);
  const showText = renderedText(show, showArgs, showValue);
  assert.ok(showText.includes('receipt_not_found'), `render lost the error value: ${showText}`);
});

section('routes');
async function routeRequest(ctx, url, options = {}) {
  const route = ctx.captured.routes[0];
  assert.ok(route && route.resource, 'no /proofcard resource registered');
  const request = new Request(url, options);
  return route.resource(request);
}
async function jsonOf(response) {
  assert.ok(response && typeof response === 'object', 'route did not return a Response');
  assert.equal(typeof response.status, 'number');
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, text, json: parsed, headers: response.headers };
}

test('empty store: health/receipts/stats return 200 (never 500)', async () => {
  const { ctx } = await makeHost();
  for (const pathname of ['/proofcard/health', '/proofcard/receipts', '/proofcard/stats']) {
    const result = await jsonOf(await routeRequest(ctx, `http://localhost${pathname}`));
    assert.equal(result.status, 200, `${pathname} -> ${result.status} ${result.text}`);
    assert.ok(result.json && typeof result.json === 'object', `${pathname} is not JSON`);
  }
});

test('receipts list/detail/accept/challenge/stats routes', async () => {
  const cwd = makeDir();
  const { ctx } = await makeHost();
  const session = mockSession('session-routes', cwd);
  feedTurn(ctx, session, {
    reply: 'All 14 tests pass. Created `src/a.py`.',
    tools: [
      { callId: 'call_test', name: 'pwsh', arguments: { command: 'pytest -q' }, resultText: '14 passed, 0 failed' },
      { callId: 'call_write', name: 'write', arguments: { path: 'src/a.py' }, resultText: 'wrote' },
    ],
  });
  const list = await jsonOf(await routeRequest(ctx, 'http://localhost/proofcard/receipts?limit=10'));
  assert.equal(list.status, 200);
  const rows = list.json.receipts || list.json;
  assert.ok(Array.isArray(rows) && rows.length === 1, list.text.slice(0, 400));
  const id = rows[0].id;
  assert.ok(id);

  const detail = await jsonOf(await routeRequest(ctx, `http://localhost/proofcard/receipts/${id}`));
  assert.equal(detail.status, 200, detail.text.slice(0, 300));
  assert.equal(detail.json.id || detail.json.receipt?.id, id);

  const missing = await jsonOf(await routeRequest(ctx, 'http://localhost/proofcard/receipts/rc_does_not_exist'));
  assert.equal(missing.status, 404);

  const accepted = await jsonOf(await routeRequest(ctx, `http://localhost/proofcard/receipts/${id}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'route ok' }),
  }));
  assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
  assert.equal(JSON.stringify(accepted.json).includes('accepted'), true);

  const challenged = await jsonOf(await routeRequest(ctx, `http://localhost/proofcard/receipts/${id}/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim_id: 'c1', run: false }),
  }));
  assert.equal(challenged.status, 200, challenged.text.slice(0, 300));
  assert.ok(Array.isArray(challenged.json.checks), challenged.text.slice(0, 300));

  const stats = await jsonOf(await routeRequest(ctx, 'http://localhost/proofcard/stats'));
  assert.equal(stats.status, 200);
  assert.ok(stats.json.totals && stats.json.totals.receipts >= 1);

  const health = await jsonOf(await routeRequest(ctx, 'http://localhost/proofcard/health'));
  assert.equal(health.status, 200);
});

test('bad requests are clean 4xx, never 500', async () => {
  const { ctx } = await makeHost();
  const badJson = await routeRequest(ctx, 'http://localhost/proofcard/receipts/rc_x/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  const badResult = await jsonOf(badJson);
  assert.ok([400, 404, 422].includes(badResult.status), `bad JSON -> ${badResult.status}`);
  assert.notEqual(badResult.status, 500);

  const unknown = await jsonOf(await routeRequest(ctx, 'http://localhost/proofcard/unknown'));
  assert.ok([404, 400].includes(unknown.status), `unknown route -> ${unknown.status}`);
  assert.ok(resultHasNoStoreHeader(unknown), 'cache-control: no-store missing');
  for (const pathname of ['/proofcard/health', '/proofcard/receipts']) {
    const result = await jsonOf(await routeRequest(ctx, `http://localhost${pathname}`));
    assert.ok(resultHasNoStoreHeader(result), `${pathname} missing cache-control: no-store`);
  }
});

function resultHasNoStoreHeader(result) {
  const cache = result.headers.get('cache-control') || '';
  return /no-store/i.test(cache);
}

section('client');
test('node --check passes for every JS file in the bundle', () => {
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
});

test('client.js loads through a fake ModuleLoader and registers UI surfaces', async () => {
  const clientPath = path.join(ROOT, 'client.js');
  assert.ok(fs.existsSync(clientPath), 'missing client.js');
  let loaded = null;
  const effects = [];
  const hookCalls = { useState: 0, useEffect: 0 };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useCallback: (fn) => fn,
    useEffect: (fn) => { hookCalls.useEffect += 1; try { const cleanup = fn(); if (cleanup) effects.push(cleanup); } catch { /* component effect failures are caught by the UI boundary */ } },
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (initial) => { hookCalls.useState += 1; return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  };
  const slotRegistrations = [];
  const commandRegistrations = [];
  const disposers = [];
  let intervalsStarted = 0;
  let intervalsCleared = 0;
  const requests = [];
  const receipt = {
    id: 'rc_20261107_171500_ab12', created_at: 1_700_000_000, turn: 1, model: 'deepseek-flash',
    stats: { claims: 2, verified: 1, partial: 0, unverified: 0, contradicted: 1 },
    accepted: false,
    claims: [
      { id: 'c1', kind: 'test_passed', text: 'All 14 tests pass.', verdict: 'verified', evidence: [{ id: 'call_1', tool: 'pwsh', what: 'ran `pytest -q`' }] },
      { id: 'c2', kind: 'file_changed', text: 'Created `src/a.py`.', verdict: 'contradicted', evidence: [] },
    ],
  };
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { __ModuleLoader__: { load(entry) { loaded = entry; return entry; } } };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body || null });
    const payload = String(url).includes('/stats')
      ? { ok: true, totals: receipt.stats }
      : { ok: true, count: 1, receipts: [receipt] };
    return { ok: true, status: 200, async json() { return payload; } };
  };
  try {
    await import(`${pathToFileURL(clientPath).href}?adv=${Date.now()}`);
    assert.ok(loaded, 'client.js did not call window.__ModuleLoader__.load');
    assert.equal(loaded.id, '@local/proofcard-dsh');
    assert.equal(typeof loaded.factory, 'function');
    const factoryResult = loaded.factory((name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement, Fragment: 'Fragment' };
      throw new Error(`unexpected require(${JSON.stringify(name)})`);
    });
    assert.ok(factoryResult && typeof factoryResult.apply === 'function', 'client module has no apply()');
    assert.ok(Array.isArray(factoryResult.inject) && factoryResult.inject.includes('slots'));

    const commandUi = { register(definition) { commandRegistrations.push(definition); return () => {}; } };
    const ctx = {
      slots: {
        inject(owner, callback) { return callback(); },
        register(definition, component) { slotRegistrations.push({ definition, component }); return () => {}; },
      },
      locale: { t: (key) => key, get: (key) => key },
      commandUi,
      inject(services, callback) {
        if (Array.isArray(services) && services.includes('commandUi')) callback({ commandUi, effect: (fn) => fn() });
        return () => {};
      },
      on() { return () => {}; },
      effect(fn) { const disposer = fn(); disposers.push(disposer); return () => {}; },
      onDispose(fn) { disposers.push(fn); },
      setInterval() { intervalsStarted += 1; return () => { intervalsCleared += 1; }; },
      interval() { intervalsStarted += 1; return () => { intervalsCleared += 1; }; },
      setTimeout() { return () => {}; },
    };
    assert.doesNotThrow(() => factoryResult.apply(ctx));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const byName = (name) => slotRegistrations.find((entry) => entry.definition.name === name);
    const dock = byName('conversation.composer.dock');
    const settings = byName('settings.section');
    assert.ok(dock, `no composer dock registration: ${JSON.stringify(slotRegistrations.map((entry) => entry.definition))}`);
    assert.ok(settings, `no settings section registration: ${JSON.stringify(slotRegistrations.map((entry) => entry.definition))}`);
    assert.equal(dock.definition.id, 'proofcard-dock');
    assert.equal(settings.definition.id, 'proofcard');
    assert.equal(settings.definition.label, 'Proofcard');
    assert.ok(commandRegistrations.length >= 1, 'no palette/command registration');
    assert.ok(commandRegistrations.some((definition) => /proofcard/i.test(String(definition.name || ''))));
    assert.ok(commandRegistrations.some((definition) => /latest receipt/i.test(String(definition.label ? definition.label() : ''))));

    // The store must actually call the same-origin Host routes.
    assert.ok(requests.length >= 2, `expected receipts+stats requests, got ${requests.length}`);
    assert.ok(requests.every((entry) => entry.url.startsWith('/proofcard')), `non-relative request: ${JSON.stringify(requests)}`);
    assert.ok(requests.some((entry) => entry.url.includes('/proofcard/receipts?limit=')));
    assert.ok(requests.some((entry) => entry.url.includes('/proofcard/stats')));

    // Both components must render through the fake React runtime without throwing.
    // `guarded()` returns a class component, so mount it the way React would and resolve
    // nested function components until a host element (or null) is reached.
    function resolveComponent(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 8) return node;
      if (typeof node.type !== 'function') return node;
      const Component = node.type;
      const props = node.props || {};
      if (Component.prototype && typeof Component.prototype.render === 'function') {
        const instance = new Component(props);
        instance.props = props;
        return resolveComponent(instance.render(), depth + 1);
      }
      return resolveComponent(Component(props), depth + 1);
    }
    for (const [label, entry, props] of [['dock', dock, {}], ['settings', settings, { close() {} }]]) {
      let tree;
      assert.doesNotThrow(() => { tree = resolveComponent({ type: entry.component, props }); }, `${label} component threw during render`);
      if (!tree) console.log(`    client-debug ${label}: tree=${tree} hooks=${JSON.stringify(hookCalls)} requests=${requests.length}`);
      assert.ok(tree && typeof tree === 'object', `${label} component rendered nothing`);
    }
    assert.ok(hookCalls.useState > 0, 'client components did not use React state hooks');

    // Resource ownership: the plugin effect disposer must stop the poll timer.
    assert.ok(intervalsStarted >= 1, 'client never started its poll timer');
    for (const disposer of disposers) {
      if (typeof disposer === 'function') assert.doesNotThrow(() => disposer());
    }
    assert.ok(intervalsCleared >= 1, 'client poll timer was not cleared on dispose');
    for (const cleanup of effects) if (typeof cleanup === 'function') assert.doesNotThrow(() => cleanup());

    const source = fs.readFileSync(clientPath, 'utf8');
    assert.ok(!/document\.body\s*=/.test(source), 'client.js writes document.body');
    assert.ok(!/\bReactDOM\b/.test(source), 'client.js ships its own ReactDOM');
    const varTokens = [...source.matchAll(/var\(--[a-z0-9-]+/g)].map((match) => match[0]);
    assert.ok(varTokens.length >= 10, 'client.js barely uses theme tokens');
    for (const token of varTokens) {
      assert.ok(token.startsWith('var(--dsw-alias-'), `non-theme CSS variable in client: ${token}`);
    }
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(source), 'client.js hardcodes a hex colour');
    assert.ok(source.includes('/accept') && source.includes('/challenge'), 'client has no Accept/Challenge requests');
    assert.ok(/run:\s*true/.test(source), 'client Challenge does not request a run');
    for (const verdict of ['verified', 'partial', 'unverified', 'contradicted']) {
      assert.ok(source.includes(verdict), `client has no verdict chip for ${verdict}`);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('package and patch manifest are consistent', () => {
  const pkgPath = path.join(ROOT, 'package.json');
  const patchPath = path.join(ROOT, 'cordis.patch.yml');
  assert.ok(fs.existsSync(pkgPath), 'missing package.json');
  assert.ok(fs.existsSync(patchPath), 'missing cordis.patch.yml');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, '@local/proofcard-dsh');
  assert.ok(pkg.dsh && pkg.dsh.client, 'package.json has no dsh.client section');
  assert.ok(pkg.exports && pkg.exports['./client'], 'package.json has no ./client export');
  const patch = fs.readFileSync(patchPath, 'utf8');
  assert.ok(patch.includes('proofcard-dsh') || patch.includes('@local/proofcard-dsh'), 'patch does not name the plugin row');
});

// --------------------------------------------------------------------------- runner

async function main() {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok   ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`FAIL ${name}`);
      console.error(`     ${error && error.stack ? String(error.stack).split('\n').slice(0, 6).join('\n     ') : error}`);
    }
  }
  while (cleanups.length) {
    try { cleanups.pop()(); } catch { /* best effort */ }
  }
  console.log(`\n${passed}/${tests.length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const { name } of failures) console.error(` - ${name}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('fatal:', error);
  process.exitCode = 1;
});
