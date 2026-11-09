# Proofcard DSH — independent verification report

**Verifier:** `proof-verifier` (independent of the plugin authors; this role wrote only
`tests/adversarial.mjs`, `tests/e2e.mjs`, and this report — no plugin source was edited).
**Date:** 2026-11-07 (Africa/Blantyre). **Target:** Proofcard DSH bundle
`@local/proofcard-dsh` 1.0.0, installed in the `desktop` profile.
**Spec:** [`CONTRACT.md`](CONTRACT.md). **Bundle authoring references:**
`cordis-plugin-development` skill (`references/practices.md`, `references/host-plugin.md`,
`references/ui-plugin.md`), and live Host/Client inspection via `cordis_inspect_query`.

**Verdict: PASS.** All test suites are green, every defect found during verification has been
fixed and re-tested (except one accepted data-path caveat documented in §6), and the installed
plugin is live: six `proofcard_*` tools answer with real JSON, the ambient prompt is injected,
the `/proofcard/*` HTTP routes answer 200 over the real webserver, and real session events
produced persisted, hash-chained receipts. Residual risks and unverified surfaces are listed in
[§7](#7-residual-risks) and [§8](#8-not-verified); none is an observed failure.

---

## 1. Environment

| Item | Value |
|---|---|
| OS | Microsoft Windows 11 Pro, NT 10.0.26300.0 (64-bit) |
| Harness | DeepSeek Harness (DSH) desktop profile; `DSH_PROFILE=desktop`, `DSH_PROFILE_DIR=<DSH_PROFILE_DIR>` |
| Harness checkout inspected for API contracts | `<DSH_INSTALL>\resources\app.asar\dsh\` |
| Node.js | v22.20.0 (tests run with plain `node`, zero dependencies) |
| Bundle | `@local/proofcard-dsh@1.0.0`, installed as a link (`link:<repo>`), `enabled: true` |
| Bundle patch row | `include:proofcard-dsh` (`name: '@local/proofcard-dsh'`) |
| Live data dir (resolved) | `<home>\.dsh\proofcard` (`ledger.jsonl` + `events.jsonl`) |
| Test artifacts | [`tests/adversarial.mjs`](tests/adversarial.mjs), [`tests/e2e.mjs`](tests/e2e.mjs) |

The verifier wrote exactly three files: `tests/adversarial.mjs`, `tests/e2e.mjs`, and
`VERIFICATION.md`.

## 2. Command results (exact)

All commands run from `proofcard-dsh/` unless noted.

| Command | Result |
|---|---|
| `node tests/adversarial.mjs` | **82/82 passed, 0 failed** |
| `node tests/e2e.mjs` | **6/6 passed, 0 failed** |
| `node tests/mock-load.mjs` (wiring owner) | `PASS mock-load: 33/33 checks — 6 tools, prompt context, prefix route, 1 receipt, route JSON` |
| `node tests/client-smoke.mjs` (UI owner) | `client smoke: 12 checks passed (client.js)` |
| `node tests/core-smoke.mjs` (lead) | `core-smoke OK — claims 2, hash …, 100-event build 7.5–19.8 ms` |
| `node demo/demo.mjs` | runs; prints a receipt with 4 claims, 2 verified / 1 unverified / 1 contradicted, accept + read-only checks (`Evidence checks out; shipping it.`) |
| `node --check` every `*.js`/`*.mjs` (13 files) | 0 failures |
| `node --check client.js` | exit 0 |

### 2.1 Live-install checks (real running plugin, not mocks)

| Check | Evidence |
|---|---|
| Bundle installed + enabled | `plugin_manager list_bundles` → `@local/proofcard-dsh 1.0.0`, `enabled: true`, `installed: true`, row `proofcard-dsh`; install result was `application: "applied"` (Lead) |
| Host row active in Config | `cordis_inspect_query host Config.listConfigs {"name":"@local/proofcard-dsh"}` → entry `include:proofcard-dsh` |
| Six tools visible to the Agent | `cordis_inspect_query host Tool.listTools` → `proofcard_list`, `proofcard_show`, `proofcard_accept`, `proofcard_challenge`, `proofcard_stats`, `proofcard_export` with the registered schemas; also observed as injected tool schemas in the running session |
| Prompt context injected | The session system prompt shows the 285-char Proofcard guidance ("When you report finished work, state each completion claim concretely…") |
| HTTP bridge live | `GET http://127.0.0.1:59895/proofcard/health` → `200 {"ok":true,"name":"proofcard-dsh","version":"1.0.0","dataDir":"<dataDir>","receipts":2,"maxClaims":12,"retentionDays":30,"allowCommandRerun":false,"ambientPrompt":true,…}` |
| Receipts route live | `GET /proofcard/receipts?limit=2` → `200 {"ok":true,"count":2,"receipts":[…]}` |
| Live tool round-trip (render fix verified) | `proofcard_stats` → `{"ok":true,"totals":{"receipts":2,"claims":4,…},"by_kind":{…}}`; `proofcard_list {"limit":3}` → real receipt list; `proofcard_show {"id":"rc_does_not_exist"}` → `{"ok":false,"error":"receipt_not_found"}` — the result value, not the arguments |
| Real capture → receipt | `~/.dsh/proofcard/ledger.jsonl` (9,587 bytes) holds 2 receipts produced from real committed turns: `rc_20261107_174403_ba37` (session `session-45d7dc…`, turn 8, 3 claims, 12 evidence items, 8 recorded commands, contract id format) and `rc_20261107_174724_af41` (teammate session, turn 3). Both were built by the live `session/event` → `turn/end` path |
| Client slots | Verified by Lead through live Client inspection: `conversation.composer.dock` → `proofcard-dock` (order 20, active); `settings.section` → `proofcard` (order 40, active, label `Proofcard`). The verifier's own `Slots.listSubTree` Client query timed out in this session (no page-inspect channel); the registration contract is independently covered by the fake-`ModuleLoader` test (§4.8) |

## 3. Coverage matrix

### 3.1 Claim extraction (`adversarial.mjs`)

| Case | Evidence |
|---|---|
| All nine claim kinds extracted (test_passed, file_changed, file_exists, command_ran, url_fetched, commit, message_sent, count, assertion) | "positive claim kinds" |
| Contract `file_exists` triggers: backticked path + `exists`, dotted config path, bare `path exists` | "file_exists contract triggers" |
| Negations dropped (did NOT pass, didn't, have not, haven't, never, failed to, unable to, not present, "No tests failed") | "negations are dropped" |
| Future tense, plans, questions, TODO dropped | "future tense…" |
| Fenced code blocks ignored; prose outside still extracted | "fenced code blocks…" |
| Markdown tables do not crash and never emit invalid claims | "markdown tables…" |
| Non-English replies produce no English false positives (fr/de/zh/es/ru) | "non-English replies…" |
| 20k-char reply bounded (≤ `maxClaims`), valid shape, extraction budget | "20k-char reply…" |
| Duplicates deduplicated | "duplicate claims…" |
| "all tests pass" with and without a recorded command; `(pytest -q)` captured without trailing `)` | "'all tests pass' without and with a recorded command" |
| Ambiguous chatter dropped, not guessed | "ambiguous chatter…" |
| `maxClaims` cap / zero / default / clamp | "maxClaims cap…" |
| Claim shape, sequential ids, kind membership | "claim shape, ids…" |
| Non-string input never throws | "non-string input…" |
| **Tightened extraction**: imperative/instructional sentences, "e.g./for example" segments, and placeholder paths (`src/...`) are NOT completion claims; real positive claims still extracted | "instructional and example-only text is not a completion claim" |

### 3.2 Evidence (`adversarial.mjs`)

Successful pytest → `ok:true` with command/caps; `"N passed, 0 failed"` is success, not failure;
failed output / `exit code: 1` / `isError` → `ok:false`; `write` records touched path; internal
`proofcard_*` calls ignored; result truncation to 2,000 chars and args to 600 with credential
redaction (including command/URL metadata); malformed inputs (`null`, arrays, non-JSON args,
wrong types) never throw; `summarizeEvidence` arithmetic and malformed-item tolerance.

### 3.3 Receipts and verdicts (`adversarial.mjs`)

Schema fields/defaults; 64-hex hash; stats arithmetic; passing pytest → **verified**; `exit code:
1` / "1 failed" / "0 passed" → **contradicted**; a README that claims tests pass must **not**
verify; claimed missing path → **contradicted**; write-like evidence → **verified**; read-only
mention → **partial**; unrelated evidence → **unverified**; failed-then-passing not contradicted;
multiple matching calls prefer the exact command; malformed evidence/payload never throws;
truncation (400/1,200) and `maxClaims`; secrets in reply/request/commands/URLs never stored;
independent hash recomputation from the CONTRACT field list; chain links + tamper detection +
overlay invariance; deterministic content for identical input; **perf** (4k reply + 100 events);
Markdown rendering; proposed-check shape/safety and read-only `runChecks` semantics (incl.
allow-listed command execution when enabled); `storeToolOutput=false` drops result excerpts.

### 3.4 Store (`adversarial.mjs`)

append/list/get/latest/lastHash ordering and limits; accept/challenge are append-only overlays
(ledger bytes unchanged, reload sees them); stats totals/limits/by-kind; corrupt + torn JSONL
lines tolerated; 8 async workers × 10 appends → 80 complete JSON lines; `prune(days)` retention;
invalid appends; idempotent append by id; directory creation.

### 3.5 Host (`adversarial.mjs`)

`register/apply` surface; six tools; prompt context; `/proofcard` prefix route; completed turns
only (aborted turn → no receipt); call/result pairing and skipped `proofcard_*` calls/results;
orphan results never become evidence; garbage/unknown events, malformed payloads and duplicate
call ids never throw; passed event objects are not mutated; per-turn evidence bound of 200 and
multi-session behaviour; observable-only (only `session/event` + dispose listener; no
guard/restrict/waterfall registration); config passthrough (`maxClaims`, `storeToolOutput`,
`retentionDays` prune-at-apply, `enabled:false` creates no data dir); `dataDir` →
`DSH_PROFILE_DIR/proofcard` → `DSH_HOME/proofcard` fallbacks; opt-in command re-run behind
`allowCommandRerun`; tool `output.render(args, value)` must render the **value** (not the args);
six tool handlers return JSON and never throw on garbage; zero runtime dependencies and no network
imports.

### 3.6 HTTP routes (`adversarial.mjs` e2e via mock `Request` + live curl-equivalent)

Empty store: `/proofcard/health`, `/proofcard/receipts`, `/proofcard/stats` → 200 JSON (never
500). With a receipt: list/detail/accept/challenge/stats/health → 200; unknown id → 404; bad JSON
body → 400; unknown path → 404; `cache-control: no-store` present. `run:true` challenge executes
only file checks when `allowCommandRerun` is false.

### 3.7 Client (`adversarial.mjs`)

`node --check`; fake `window.__ModuleLoader__.load({id, factory})` load; factory requires only
`react`/`react/jsx-runtime`; `apply(ctx)` registers `conversation.composer.dock` (`id:
proofcard-dock`) and `settings.section` (`id: proofcard`, `label: Proofcard`) plus a `commandUi`
palette contribution ("Proofcard: latest receipt"); same-origin `/proofcard/receipts?limit=…` and
`/proofcard/stats` fetches; poll timer cleared on dispose; both guarded components render through a
fake React runtime; no `document.body` writes, no bundled ReactDOM, only `--dsw-alias-*` CSS
variables, no hard-coded hex colours; Accept/Challenge request paths present; all four verdict
names present. Bundle manifest consistency (`package.json` name/type/exports/`dsh.client`, patch
row, icon, locale files).

### 3.8 End-to-end (`e2e.mjs`, real Host `apply` on a mock Cordis ctx)

Two-turn session: turn 1 runs passing pytest + a write and claims both; turn 2 runs a **failing**
test suite while the assistant still says "All 14 tests pass" → exactly 2 receipts, correct
turn/claim verdicts (verified/verified then contradicted), `prev_hash` chain link, stats, ids in
CONTRACT format, append-only ledger lines, session/event handlers return no directive. Six tools
return JSON (`list`, `show` + Markdown, `accept`, `stats`, `export` Markdown/JSON); Challenge via
`POST /proofcard/receipts/{id}/challenge {run:false}` proposes checks and `{run:true}` executes the
file check and records the challenge (no command runs without `allowCommandRerun`); persistence
across a fresh `ReceiptStore` (acceptance + challenges survive, ledger not rewritten); route
latency p95; `node --check` for all JS and manifest consistency.

## 4. Performance (measured on this machine)

| Measurement | Result |
|---|---|
| `buildReceipt` — 4k-char reply + 100 tool events (best of 5) | **6.5 ms** (CONTRACT budget `<50 ms`; verifier ceiling 100 ms) |
| Host end-to-end capture — 2 turns × 100 tool call/result pairs (build + store both receipts) | **76.4 ms total** |
| Receipt size | ~1,303 bytes for a small receipt; live receipt with 12 evidence items/8 commands = **7,051 bytes**; 2 live receipts = 9,587 bytes |
| HTTP route handler (`GET /receipts?limit=20`, 40 samples, mock server) | median **0.37–0.54 ms**, p95 **1.61–3.00 ms** (two runs) |
| Tool `execute` handler (mock definition, 60 samples) | median **0.01 ms**, p95 **0.09 ms** (excludes DSH executor/pipeline overhead; live route + live tool calls above) |
| `extractClaims` on a 20k-char reply | **36.1 ms**, bounded claim count |
| `redact` on 20k chars | **1.3 ms** |
| Store cold load — 5,000 receipts (0.77 MB ledger) | **26 ms** |
| `core-smoke` 100-event receipt build | 7.5–19.8 ms across runs |

## 5. Defects found, fixed and re-verified

Every code defect below was reported to the owning builder with a minimal reproduction, fixed in
the workspace, re-tested, and re-verified where a live installation was involved.

| # | Severity | Area | Defect | Status / regression |
|---|---|---|---|---|
| D1 | P1 correctness | `evidence.js` | `normalizeToolCall(null)` threw `TypeError` (default parameter only covers `undefined`), violating "core never throws on malformed input". | **Fixed** — "normalizeToolCall never throws on malformed input" |
| D2 | P1 correctness | `receipts.js` | `buildReceipt(null)` threw `TypeError` (destructured default only covers `undefined`). | **Fixed** — "malformed payloads never throw" |
| D3 | P1 correctness | `receipts.js` | Receipt id format was `rc_YYYYMMDDHHMMSS_xxxx`; CONTRACT and the tool schema say `rc_YYYYMMDD_HHMMSS_xxxx`. | **Fixed** — "receipt schema, defaults and stats arithmetic"; live id `rc_20261107_174403_ba37` matches |
| D4 | P1 correctness | `index.js` | A `tool/result` for a deliberately skipped `proofcard_*` call (no pending entry) was recorded as evidence under tool name `"tool"`, inflating `evidence_count`/`tools_used`. | **Fixed** — "tool calls are paired…" and "a tool/result for a skipped proofcard_* call never becomes evidence" |
| D5 | P2 config/privacy | `receipts.js` + `index.js` | `storeToolOutput=false` was documented but a no-op: raw tool-result excerpts still appeared in receipt claim evidence. | **Fixed** — "storeToolOutput=false must drop result excerpts…" + Host config-passthrough test |
| D6 | P2 API behaviour | `index.js` | Challenge propose-only (`run:false`) returned `checks: []` and appended an empty challenge event; `run:true` was the only path that computed proposals. | **Fixed** — proposals are now always computed and recorded non-empty (`run:false` records the proposal list); "Challenge via POST …" e2e step |
| D7 | **P1 live** | `index.js` | DSH calls `output.render(args, value)`; the plugin declared `render: renderValue` with `function renderValue(value)`, so every live `proofcard_*` tool card displayed its **arguments** instead of the JSON result (observed live: `proofcard_stats` → `{}`, `proofcard_list {"limit":5}` → `{"limit":5}`, `proofcard_show {"id":"…"}` → `{"id":"…"}`). Mocks missed it because they call `execute()` directly. | **Fixed** — hybrid `render(first, second)` wrapper now renders the value (one-arg legacy call still works); regression "tool output.render describes the result value, not the arguments"; **live re-test after Host reload**: `proofcard_stats` → real totals, `proofcard_list` → real receipts, `proofcard_show` missing → `{"ok":false,"error":"receipt_not_found"}` |
| D8 | P2 doc/environment | data dir | Live Host resolves `dataDir = <home>\.dsh\proofcard`, not `<profile>/proofcard`, because the Host process exposes neither `DSH_PROFILE_DIR` nor `DSH_HOME` (the shell does). CONTRACT's documented fallback is implemented correctly; consequence is one shared ledger across profiles and a README claim that was inaccurate for this install. | **Accepted + documented** — README now states the fallback chain and recommends `config.dataDir` for per-profile isolation; live ledger deliberately not migrated. See §7.6 |
| — | P3 polish | `claims.js` | Ordinary instructional text ("Use **Accept**… (e.g., `src/...` exists, re-run `pytest`)") produced instruction-derived claims in the earliest live receipts. | **Fixed** — imperative/instructional and "e.g./for example" segments and placeholder paths are dropped; regression "instructional and example-only text is not a completion claim". The two pre-fix live receipts keep their historical claims |
| — | P3 polish | `client.js` | Composer pill is a subdued visible pill (`Proofcard · verified` / `Proofcard`) when all claims are proven/empty/loading rather than absent; UI strings are English-only although `locale/en|zh.json` carry bundle metadata. | **Accepted/interpretation** — Load read "quiet" as visually subdued rather than hidden and kept it as the discoverable entry point; locale files are bundle-display metadata, not a Client i18n table. Documented here |

## 6. Observe-only / safety audit

- Host registers exactly one session listener (`session/event`) plus the dispose fallback; no
  `tools.guard`/`tools.restrict`, no `pre-*`/`transform_*` waterfall, no prompt assembly
  replacement. Nothing can gate, rewrite or delay a turn; session handlers return `undefined`.
- Six tools use the standard `ToolDefinition` contract (`execute(args, exec)`, `output.render`);
  handlers and HTTP routes never throw to the caller (JSON error values instead).
- No network access: zero runtime dependencies; no `node:http(s)/net/dns` imports, no
  `XMLHttpRequest`/`WebSocket`; the Client's only requests are same-origin `/proofcard/*`.
- Secret handling: claim text, `user_request`, `answer_excerpt`, commands/paths/URLs and evidence
  excerpts pass through the credential-redaction filter (OpenAI/GitHub/AWS/Slack/Google/Stripe,
  JWTs, PEM keys, Bearer tokens, `password=`), verified at core and receipt level.
- Per-turn evidence is bounded (200 items), pending calls bounded (200), sessions bounded (64),
  inputs bounded (results/args 4,000 pre-redaction, request 4,000, answer 16,000); the stored
  receipt is further bounded (400 / 1,200 / 2,000 / 600).
- Hash chain: `prev_hash` per session, SHA-256 over the CONTRACT field list; independent
  recomputation, tamper detection and overlay exclusion are tested.

## 7. Residual risks

1. **Heuristic extraction.** Precision-first, English-oriented rule table: unusual phrasing can be
   missed or misclassified; `maxClaims` (default 12) drops claims beyond the cap. This is a receipt
   aid, not an auditor or security boundary.
2. **Evidence is only the committed session log.** Tool calls from before the plugin loaded, in a
   subagent's shell, or in another session cannot be matched and are marked `unverified` (never
   silently verified). Pending turn buffers are in memory: a process restart between a tool call
   and `turn/end` loses that turn's evidence (the receipt can still be created from the reply).
3. **Hash chain is tamper-evident, not signed.** An attacker with write access to the ledger can
   rewrite the whole chain; deletion of trailing receipts is not detectable without a separately
   retained head hash. Chain is per session.
4. **Retention runs once at Host apply/load** (`prune(retentionDays)`); a long-running Host does
   not prune between reloads. Ledger growth is linear (~1.3–7 KB per receipt depending on evidence;
   5,000 receipts ≈ 0.77 MB). `events.jsonl` (accept/challenge) is retained.
5. **Per-turn bounds can truncate**: at most 200 evidence items/turn; result/argument text is
   capped before storage, so a very large output can lose the relevant tail.
6. **Data-dir fallback (live):** the installed Host lacks `DSH_PROFILE_DIR`/`DSH_HOME`, so this
   install shares `~/.dsh/proofcard` across profiles. Set `config.dataDir` for per-profile
   isolation (README documents this). This is accepted, not a test failure.
7. **Module reload semantics (live):** the bundle is a workspace junction, but the running Host
   keeps the module generation it loaded; workspace edits require a Host restart/reload. This was
   directly observed: D7's fix was present on disk and in tests while the live tools still served
   the pre-fix renderer until the Host was reloaded.
8. **HTTP routes have no plugin-level auth beyond the shared webserver's same-origin policy**
   (CONTRACT: CORS not needed). Locally that is appropriate; do not expose the dashboard publicly
   with untrusted plugins.
9. **Client i18n:** visible strings are English; `locale/*.json` only provide bundle metadata.
   `Slots.listSubTree` Client inspection timed out from the verifier session, so live slot
   rendering was confirmed by the Lead, not pixel-verified here.
10. **Cross-process concurrency** of ledger appends (agent Host + any other writer) was not
    exercised; the store is append-only and torn lines are tolerated on read, and 8 in-process
    concurrent writers are tested.

## 8. Not verified

Nothing below should be read as evidence in this report:

- **Client pixels / real interaction** in the running page: slot occupants were verified by the
  Lead via Client inspection; the verifier's Client `Slots.listSubTree` query timed out (no
  page-inspect response in this session). Accept/Challenge button clicks were exercised through
  the fake-React render + route/tool tests, not by clicking the live page.
- **Live dashboard page rendering/auth** (the webserver routes were exercised live over HTTP for
  read-only endpoints; the HTML page itself and any auth middleware were not).
- **Live challenge execution or accept mutation** on the demo ledger (avoided to preserve the
  demo; the same paths are covered by e2e/tool tests).
- **Command re-run on the live install** (`allowCommandRerun=true`) — the engine/allow-list path is
  tested with mock data; live config has it disabled.
- **Long-running soak / crash / disk-full / permission-denied** behaviour.
- **Non-Windows platforms** (one `dir`-based opt-in test is Windows-only and skipped elsewhere).
- **Cross-process concurrent ledger writes.**
- **Secret-redaction completeness** beyond the adversarial corpus (redaction is best-effort).
- **Installation itself** was performed by the Lead (`plugin_manager install_bundle` →
  `application: "applied"`); the verifier verified the installed state, live routes, live tool
  round-trip and persisted receipts afterwards.
- **A model turn authored by the verifier after install** — the historical receipts in the live
  ledger come from real Lead/teammate turns and were inspected; the verifier did not script a
  separate model-driven turn (this session's own turns are captured by the live listener but the
  receipt is only written at `turn/end`).

## 9. Reproduce

From `...\default-workspace\proofcard-dsh`:

```powershell
# verifier suites (Node >= 22, zero dependencies)
node tests/adversarial.mjs
node tests/e2e.mjs

# owner suites + static checks
node tests/mock-load.mjs
node tests/client-smoke.mjs
node tests/core-smoke.mjs
node demo/demo.mjs
node --check client.js
Get-ChildItem -Recurse -File -Include *.js,*.mjs | Where-Object FullName -notmatch node_modules | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw "syntax error in $($_.FullName)" } }

# live plugin surface (installed, Host running)
cordis_inspect_query host Tool.listTools                      # expect six proofcard_* tools
cordis_inspect_query host Config.listConfigs {"name":"@local/proofcard-dsh"}
Invoke-WebRequest http://127.0.0.1:59895/proofcard/health
Invoke-WebRequest http://127.0.0.1:59895/proofcard/receipts?limit=5
# then call the tools from an Agent turn, e.g. proofcard_stats / proofcard_list / proofcard_show
```

Live re-test after the D7 render fix (Host reloaded) confirmed the tool cards now show the JSON
results (`proofcard_stats` real totals; `proofcard_list` real receipts; missing id →
`{"ok":false,"error":"receipt_not_found"}`).

---

*Verification artifacts: [`tests/adversarial.mjs`](tests/adversarial.mjs) (82 checks),
[`tests/e2e.mjs`](tests/e2e.mjs) (6 end-to-end steps), this report. Written by an independent
verifier; the bundle under test was not modified by this role.*
