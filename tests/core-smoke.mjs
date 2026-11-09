/** Lead-owned smoke test for the Proofcard DSH core (not the verifier suites). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractClaims } from '../claims.js';
import { normalizeToolCall, summarizeEvidence } from '../evidence.js';
import { buildReceipt, proposedChecks, runChecks, receiptMarkdown } from '../receipts.js';
import { ReceiptStore } from '../store.js';
import { redact } from '../redact.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proofcard-core-'));
try {
  // claims
  const claims = extractClaims('All 14 tests pass. I created `src/a.py`. Tests did not pass elsewhere.');
  assert.ok(claims.some((claim) => claim.kind === 'test_passed'), 'missing test_passed');
  assert.ok(claims.some((claim) => claim.kind === 'file_changed'), 'missing file_changed');
  assert.equal(extractClaims('Did all tests pass?').length, 0, 'question should be dropped');
  assert.equal(extractClaims('I did not create src/a.py.').length, 0, 'negation should be dropped');

  // evidence
  const good = normalizeToolCall({ callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'pytest -q' }), resultText: '14 passed, 0 failed in 0.6s' });
  const bad = normalizeToolCall({ callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'pytest -q' }), resultText: '1 failed, 13 passed' });
  const write = normalizeToolCall({ callId: 'c3', name: 'write', arguments: JSON.stringify({ path: 'src/a.py' }), resultText: 'Wrote 10 bytes' });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.ok(good.command.includes('pytest'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'a.py'), 'x');

  const receipt = buildReceipt({
    sessionId: 's1', turn: 1, cwd: tmp, model: 'deepseek-flash',
    userRequest: 'fix it', answer: 'All 14 tests pass. I created `src/a.py`.',
    evidence: [good, write], prevHash: null, config: { maxClaims: 12 },
  });
  const byKind = Object.fromEntries(receipt.claims.map((claim) => [claim.kind, claim]));
  assert.equal(byKind.test_passed.verdict, 'verified');
  assert.equal(byKind.file_changed.verdict, 'verified');
  assert.equal(receipt.stats.verified, 2);
  assert.equal(receipt.hash.length, 64);
  assert.ok(receiptMarkdown(receipt).includes(receipt.id));

  // contradiction + partial
  const badReceipt = buildReceipt({
    sessionId: 's2', answer: 'All tests pass.', evidence: [bad],
  });
  assert.equal(badReceipt.claims[0].verdict, 'contradicted');
  const readOnly = normalizeToolCall({ callId: 'r1', name: 'read', arguments: JSON.stringify({ path: 'README.md' }), resultText: 'Docs: all tests pass in CI' });
  const readReceipt = buildReceipt({ sessionId: 's3', answer: 'All tests pass.', evidence: [readOnly] });
  assert.notEqual(readReceipt.claims[0].verdict, 'verified', 'a README must not verify a test claim');

  // redaction
  assert.ok(redact('key sk-abcdefghijklmnopqrstuvwxyz123456').includes('[REDACTED]'));
  const secretTool = normalizeToolCall({
    callId: 'sec', name: 'pwsh',
    arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://x.test' }),
    resultText: 'ok',
  });
  assert.ok(!JSON.stringify(secretTool).includes('abcdefghijklmnopqrstuvwxyz012345'));

  // checks
  const checks = proposedChecks(receipt);
  assert.ok(checks.some((check) => check.kind === 'file_exists'));
  const results = runChecks(checks, { cwd: tmp, allowCommands: false });
  assert.ok(results.some((result) => result.ran && result.ok === true));

  // store
  const store = new ReceiptStore(path.join(tmp, 'data'));
  assert.equal(store.append(receipt), true);
  assert.equal(store.append(receipt), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.accept(receipt.id, 'ok').accepted, true);
  assert.equal(store.appendChallenge(receipt.id, { claim_id: 'c1', outcome: 'checked' }).challenges.length, 1);
  assert.equal(store.stats().totals.receipts, 1);
  assert.equal(new ReceiptStore(path.join(tmp, 'data')).get(receipt.id).accepted, true);

  // chain
  const second = buildReceipt({ sessionId: 's1', answer: 'Done.', evidence: [], prevHash: receipt.hash });
  assert.equal(second.prev_hash, receipt.hash);
  assert.notEqual(second.hash, receipt.hash);

  // performance
  const started = performance.now();
  const bigEvidence = Array.from({ length: 100 }, (_, index) => normalizeToolCall({
    callId: `p${index}`, name: 'pwsh', arguments: JSON.stringify({ command: `pytest test_${index}.py` }), resultText: '1 passed',
  }));
  const big = buildReceipt({ sessionId: 'big', answer: 'All 100 tests pass. '.repeat(200), evidence: bigEvidence, config: { maxClaims: 12 } });
  const elapsed = performance.now() - started;
  assert.ok(big.stats.claims <= 12);
  assert.ok(elapsed < 250, `receipt build too slow: ${elapsed.toFixed(1)} ms`);

  console.log(`core-smoke OK — claims ${receipt.stats.claims}, hash ${receipt.hash.slice(0, 12)}, 100-event build ${elapsed.toFixed(1)} ms`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
