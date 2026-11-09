/** Append-only receipt store for Proofcard DSH. */

import fs from 'node:fs';
import path from 'node:path';

const MAX_MEMORY = 2000;

export class ReceiptStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(String(dataDir));
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch { /* ignore */ }
    this.ledgerPath = path.join(this.dataDir, 'ledger.jsonl');
    this.eventsPath = path.join(this.dataDir, 'events.jsonl');
    this._receipts = [];
    this._byId = new Map();
    this._overlays = new Map();
    this._load();
  }

  _load() {
    this._receipts = [];
    this._byId = new Map();
    this._overlays = new Map();
    this._read(this.ledgerPath, (record) => this._onReceipt(record));
    this._read(this.eventsPath, (record) => this._onEvent(record));
    this._receipts.sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
    if (this._receipts.length > MAX_MEMORY) this._receipts = this._receipts.slice(-MAX_MEMORY);
  }

  _read(file, handler) {
    try {
      if (!fs.existsSync(file)) return;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed);
          if (record && typeof record === 'object') handler(record);
        } catch { /* torn line: skip */ }
      }
    } catch { /* unreadable: treat as empty */ }
  }

  _onReceipt(record) {
    const id = String(record.id || '');
    if (!id || this._byId.has(id)) return;
    if (!Array.isArray(record.claims)) record.claims = [];
    if (!record.stats || typeof record.stats !== 'object') record.stats = {};
    this._byId.set(id, record);
    this._receipts.push(record);
  }

  _onEvent(record) {
    const id = String(record.id || '');
    if (!id) return;
    const overlay = this._overlays.get(id) || {};
    if (record.type === 'accept') {
      overlay.accepted = true;
      overlay.accepted_at = record.at;
      overlay.accepted_by = record.by || 'user';
      overlay.accept_note = record.note || '';
    } else if (record.type === 'challenge') {
      overlay.challenges = [...(overlay.challenges || []), record.challenge || {}];
    }
    this._overlays.set(id, overlay);
  }

  _merge(receipt) {
    const merged = { ...receipt, ...(this._overlays.get(String(receipt.id)) || {}) };
    if (!Array.isArray(merged.challenges)) merged.challenges = [];
    if (merged.accepted === undefined) merged.accepted = false;
    return merged;
  }

  _append(file, record) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  append(receipt) {
    if (!receipt || typeof receipt !== 'object' || !receipt.id) return false;
    if (this._byId.has(String(receipt.id))) return true;
    if (!this._append(this.ledgerPath, receipt)) return false;
    this._onReceipt(receipt);
    return true;
  }

  latest(sessionId = null) {
    for (let index = this._receipts.length - 1; index >= 0; index -= 1) {
      const receipt = this._receipts[index];
      if (sessionId === null || receipt.session_id === sessionId) return this._merge(receipt);
    }
    return null;
  }

  list(limit = 20, sessionId = null) {
    const size = Math.max(1, Math.min(Number(limit) || 20, 200));
    const out = [];
    for (let index = this._receipts.length - 1; index >= 0 && out.length < size; index -= 1) {
      const receipt = this._receipts[index];
      if (sessionId === null || receipt.session_id === sessionId) out.push(this._merge(receipt));
    }
    return out;
  }

  get(id) {
    const receipt = this._byId.get(String(id || ''));
    return receipt ? this._merge(receipt) : null;
  }

  accept(id, note = '', by = 'user') {
    const receipt = this._byId.get(String(id || ''));
    if (!receipt) return null;
    const event = { type: 'accept', id: receipt.id, at: Date.now() / 1000, by: String(by || 'user').slice(0, 80), note: String(note || '').slice(0, 500) };
    if (!this._append(this.eventsPath, event)) return null;
    this._onEvent(event);
    return this._merge(receipt);
  }

  appendChallenge(id, challenge) {
    const receipt = this._byId.get(String(id || ''));
    if (!receipt) return null;
    const event = { type: 'challenge', id: receipt.id, at: Date.now() / 1000, challenge: challenge && typeof challenge === 'object' ? challenge : { outcome: String(challenge) } };
    if (!this._append(this.eventsPath, event)) return null;
    this._onEvent(event);
    return this._merge(receipt);
  }

  lastHash(sessionId = null) {
    for (let index = this._receipts.length - 1; index >= 0; index -= 1) {
      const receipt = this._receipts[index];
      if ((sessionId === null || receipt.session_id === sessionId) && receipt.hash) return String(receipt.hash);
    }
    return null;
  }

  stats(limit = 100) {
    const size = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const recent = this._receipts.slice(-size).map((receipt) => this._merge(receipt));
    const totals = { receipts: recent.length, claims: 0, verified: 0, partial: 0, unverified: 0, contradicted: 0 };
    const byKind = {};
    let accepted = 0;
    const sessions = new Set();
    for (const receipt of recent) {
      const stats = receipt.stats || {};
      for (const key of ['claims', 'verified', 'partial', 'unverified', 'contradicted']) totals[key] += Number(stats[key] || 0);
      if (receipt.accepted) accepted += 1;
      if (receipt.session_id) sessions.add(String(receipt.session_id));
      for (const claim of receipt.claims || []) {
        const kind = String(claim.kind || 'unknown');
        byKind[kind] = byKind[kind] || { claims: 0, verified: 0, unverified: 0, contradicted: 0 };
        byKind[kind].claims += 1;
        if (claim.verdict in byKind[kind]) byKind[kind][claim.verdict] += 1;
      }
    }
    totals.verified_pct = totals.claims ? Math.round((1000 * totals.verified) / totals.claims) / 10 : 0;
    totals.accepted_receipts = accepted;
    totals.sessions = sessions.size;
    return { totals, by_kind: byKind };
  }

  prune(days) {
    const cutoffDays = Number(days);
    if (!Number.isFinite(cutoffDays) || cutoffDays <= 0) return 0;
    const cutoff = Date.now() / 1000 - cutoffDays * 86_400;
    const keep = this._receipts.filter((receipt) => Number(receipt.created_at || 0) >= cutoff);
    const removed = this._receipts.length - keep.length;
    if (removed <= 0) return 0;
    const temp = `${this.ledgerPath}.tmp`;
    try {
      fs.writeFileSync(temp, keep.map((receipt) => JSON.stringify(receipt)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
      fs.renameSync(temp, this.ledgerPath);
    } catch {
      return 0;
    }
    this._receipts = keep;
    this._byId = new Map(keep.map((receipt) => [String(receipt.id), receipt]));
    return removed;
  }
}
