/** Deterministic Proofcard DSH demo: a scripted turn becomes a receipt. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeToolCall } from '../evidence.js';
import { buildReceipt, proposedChecks, receiptMarkdown, runChecks } from '../receipts.js';
import { ReceiptStore } from '../store.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'proofcard-dsh-demo-'));
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'src', 'export.ts'), 'export function exportRows(rows) { return rows; }\n');
fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');

const evidence = [
  normalizeToolCall({ callId: 'call_1', name: 'pwsh', arguments: { command: 'npm test' }, resultText: '14 passed, 0 failed in 0.62s' }),
  normalizeToolCall({ callId: 'call_2', name: 'write', arguments: { path: 'src/export.ts' }, resultText: 'Wrote 58 bytes' }),
  normalizeToolCall({ callId: 'call_3', name: 'edit', arguments: { path: 'CHANGELOG.md' }, resultText: 'Updated CHANGELOG.md' }),
  normalizeToolCall({ callId: 'call_4', name: 'web_fetch', arguments: { url: 'https://docs.example.com/export' }, resultText: 'HTTP 404 Not Found', isError: true }),
];

const receipt = buildReceipt({
  sessionId: 'demo-session',
  turn: 3,
  cwd: workspace,
  model: 'deepseek-flash',
  userRequest: 'Fix the failing export test and update the changelog.',
  answer: 'All 14 tests pass. I created `src/export.ts` and updated CHANGELOG.md. I also fetched https://docs.example.com/export to check the format. The refactor is complete.',
  evidence,
  prevHash: null,
  config: { maxClaims: 12 },
});

console.log('='.repeat(78));
console.log('Proofcard DSH demo — a scripted DSH turn becomes a receipt');
console.log('='.repeat(78));
console.log(receiptMarkdown(receipt));
console.log('='.repeat(78));
console.log('Proposed checks:');
for (const check of proposedChecks(receipt)) {
  console.log(`- [${check.claim_id}] ${check.label} (safe: ${check.safe_to_run})`);
}
const results = runChecks(proposedChecks(receipt), { cwd: workspace, allowCommands: false });
for (const result of results) {
  if (result.ran) console.log(`  -> ${result.label}: ${result.ok ? 'PASS' : 'FAIL'} — ${result.detail}`);
}
const store = new ReceiptStore(path.join(workspace, 'proofcard-data'));
store.append(receipt);
store.accept(receipt.id, 'Evidence checks out; shipping it.');
store.appendChallenge(receipt.id, { claim_id: 'c4', outcome: 'URL still returns 404 — follow up.' });
console.log('='.repeat(78));
console.log(`accepted: ${store.get(receipt.id).accepted} — ${store.get(receipt.id).accept_note}`);
console.log(`stats: ${JSON.stringify(store.stats().totals)}`);
console.log('='.repeat(78));
fs.rmSync(workspace, { recursive: true, force: true });
