# Proofcard DSH — build contract

**Product:** a DSH-native proof-receipt layer. After each completed turn, the plugin builds a
receipt from the **session log**: the agent's completion claims, the tool calls/results that
actually happened, a verdict per claim, Accept/Challenge, and a live pane. It is
**observe-only** — it never gates, rewrites or delays a turn.

One core (`claims/evidence/receipts/store`), one Host Cordis row, one Client module.
No network, no API keys, no external process. Data lives in the profile's plugin data dir.

## Ownership

| Path | Owner |
|---|---|
| `proofcard-dsh/claims.js`, `evidence.js`, `receipts.js`, `store.js`, `redact.js`, `CONTRACT.md`, `README.md`, `demo/` | lead |
| `proofcard-dsh/package.json`, `cordis.patch.yml`, `index.js`, `locale/`, `icon.svg`, `tests/mock-load.mjs` | dsh-proof-wiring |
| `proofcard-dsh/client.js`, `tests/client-smoke.mjs` | dsh-proof-ui |
| `proofcard-dsh/tests/adversarial.mjs`, `tests/e2e.mjs`, `VERIFICATION.md` | dsh-proof-verifier |

## Data model

```jsonc
// Claim
{ "id":"c1", "text":"All 14 tests pass.", "kind":"test_passed",
  "subject": { "command":"pytest -q", "paths":["src/a.py"], "url":"https://…", "count":14, "noun":"tests", "action":"created" },
  "verdict":"verified", "confidence":0.9,
  "evidence":[{"id":"call_1","tool":"pwsh","what":"ran `pytest -q`","match":0.9,"excerpt":"14 passed"}],
  "note":"the recorded check succeeded" }

// Receipt
{ "schema":1, "id":"rc_20261107_171500_ab12", "created_at":1794064500.1,
  "session_id":"…", "turn":3, "model":"deepseek-flash",
  "cwd":"C:/work/proj", "user_request":"…400…", "answer_excerpt":"…1200…",
  "claims":[claim],
  "stats":{"claims":5,"verified":3,"partial":1,"unverified":1,"contradicted":0},
  "evidence_count":9, "tools_used":["pwsh","read"], "files_touched":["src/a.py"],
  "commands":[{"command":"pytest -q","exit_code":0,"ok":true}],
  "duration_ms":4200, "prev_hash":null, "hash":"…",
  "accepted":false, "accepted_at":null, "accepted_by":null, "accept_note":"",
  "challenges":[] }
```

Claim kinds: `test_passed`, `file_changed`, `file_exists`, `command_ran`, `url_fetched`,
`commit`, `message_sent`, `count`, `assertion`. Verdicts: `verified`, `partial`,
`unverified`, `contradicted`. Claim text/`user_request`/`answer_excerpt`/commands/paths/URLs
are credential-redacted before storage.

## Host capture (dsh-proof-wiring)

Subscribe to the post-commit session feed:

```js
ctx.on('session/event', (session, event) => { /* event.type, event.data, session.id, session.header.cwd */ })
```

Maintain a per-session, per-turn buffer:

- `user/message` → the turn's request text
- `tool/call` → `{ callId, name, arguments }` (arguments is a JSON string)
- `tool/result` → pair by `data.message.source.callId`; result text from
  `data.message.content` blocks (`{type:'text', text}`); `data.message.isError`, `data.error`
- `assistant/message` → keep the **last** assistant text for the turn (`data.message.content`)
- `step/start` / `step/end` / `turn/start` → turn number
- `turn/end` with `data.reason.kind === 'completed'` → call
  `receipts.buildReceipt({ session, turn, cwd, userRequest, answer, evidence, prevHash })`,
  append to the store, clear the turn buffer.

Only completed turns produce receipts. Skip our own `proofcard_*` tools.

Host also registers:

- six tools (same names as the Hermes plugin) via `ctx.tools.register({
  name, description, parameters, output: { schema, render(args,value) { return [{type:'text',text}] } },
  execute(args, exec) { … } })`:
  `proofcard_list`, `proofcard_show`, `proofcard_accept`, `proofcard_challenge`,
  `proofcard_stats`, `proofcard_export`.
  Handlers never throw; return a JSON value. `latest` resolves against `exec.agent?.id`.
- prompt context: `ctx.systemPrompt.context({ name:'proofcard', order:125, interpolate:false,
  text: () => 'When you report finished work, state each completion claim concretely: …' })`.
  Only non-empty text should be injected; keep it under ~400 chars.
- HTTP routes for the Client via `ctx.webServer.register({ kind:'prefix', path:'/proofcard',
  resource: async (request) => new Response(...) })`:
  - `GET /proofcard/receipts?limit=20`
  - `GET /proofcard/receipts/{id}`
  - `POST /proofcard/receipts/{id}/accept` `{note?}`
  - `POST /proofcard/receipts/{id}/challenge` `{claim_id?, run?}` (run only safe file checks)
  - `GET /proofcard/stats`
  - `GET /proofcard/health`
  All JSON, `cache-control: no-store`, CORS not needed (same origin).
- data dir: `process.env.DSH_PROFILE_DIR + '/proofcard'` when set, else
  `process.env.DSH_HOME + '/proofcard'`, else `~/.dsh/proofcard`; `config.dataDir` overrides.
- config: `{ enabled, maxClaims, storeToolOutput, retentionDays, allowCommandRerun,
  ambientPrompt }` with defaults `true, 12, true, 30, false, true`.

## Core API (lead)

```js
// claims.js
export function extractClaims(text, maxClaims = 12) -> Claim[]
// evidence.js
export function normalizeToolCall({ callId, name, arguments, resultText, isError, error, durationMs })
export function summarizeEvidence(items) -> { tools_used, files_touched, commands, duration_ms, evidence_count }
// receipts.js
export function buildReceipt({ sessionId, turn, cwd, model, userRequest, answer, evidence, prevHash, config }) -> Receipt
export function receiptMarkdown(receipt) -> string
export function proposedChecks(receipt, claimId) -> Check[]
export function runChecks(checks, { cwd, allowCommands }) -> Check[]   // read-only file checks; commands only when allowed
// store.js
export class ReceiptStore {
  constructor(dataDir)
  append(receipt) -> boolean
  latest(sessionId?) -> receipt|null
  list(limit=20, sessionId?) -> receipt[]
  get(id) -> receipt|null
  accept(id, note, by) -> receipt|null
  appendChallenge(id, challenge) -> receipt|null
  stats(limit=100) -> { totals, by_kind }
  lastHash(sessionId) -> string|null
  prune(days) -> number
}
```

Core is dependency-free, never throws on malformed input, and builds a receipt in
< 50 ms for a 4k reply + 100 tool events. `store.js` is importable standalone by index.js.

## Client (dsh-proof-ui)

`client.js` in the `window.__ModuleLoader__.load({ id, factory(require){…} })` format used by
the decoration template. Register:

- a **composer-dock status pill** (`conversation.composer.dock`): `Proofcard · N unproven`
  for the latest receipt, quiet when all verified/empty; click opens Settings → Proofcard.
- a **Settings section** (`settings.section`, id `proofcard`, label `Proofcard`): header with
  bridge status and Refresh, receipt cards (time, model, verdict chips, claims with colored
  dots + evidence counts), **Accept** and **Challenge** buttons, challenge results inline,
  and a stats strip. Data from `fetch('/proofcard/receipts')` (same origin) and POSTs.
- a `palette` entry `Proofcard: latest receipt`.
All timers/listeners via `ctx.setInterval`/`ctx.dispose`; only `--dsw-alias-*` theme tokens;
no JSX; no `document.body` writes; `node --check` clean.

## Verification (dsh-proof-verifier)

`tests/adversarial.mjs` (node, no deps) for core: negations/code fences/non-English/huge
replies, false "verified", failed-command contradiction, missing paths, secret redaction in
claims/commands/replies, hash chain, store corruption/concurrency, performance.
`tests/e2e.mjs`: mock Cordis ctx → feed a synthetic session event sequence (user message,
pwsh call+result with "14 passed", write call+result, assistant reply claiming both,
turn/end) → assert receipt verdicts, tools JSON, webServer routes via a mock request,
prompt-context text, store persistence, and that no event handler throws on garbage.
Then run `node --check` on all JS, and write `VERIFICATION.md` with evidence and limits.

## Acceptance (Lead)

- Bundle installs into the current `desktop` profile (`plugin_manager install_bundle`), Host
  row active, six tools visible via `Tool.listTools`.
- A real DSH turn (ask this agent to run a command, then check after the turn) produces a
  receipt visible in `proofcard_list` and the pane.
- Client slot registrations visible through Client `Slots.listSubTree`.
- Tests green: `node proofcard-dsh/tests/*.mjs`.
