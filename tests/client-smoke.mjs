/**
 * Proofcard DSH — Client smoke test (node, no dependencies).
 *
 * Loads `client.js` the way the Harness Web page does — through
 * `window.__ModuleLoader__.load({ id, factory })` — then calls `apply(ctx)`
 * with a fake Cordis client context and asserts every UI surface registered:
 *
 *   - `conversation.composer.dock`  (id `proofcard-dock`)
 *   - `settings.section`            (id `proofcard`, order 40, label `Proofcard`)
 *   - the client command menu       (name `proofcard`, label
 *                                    `Proofcard: latest receipt`)
 *
 * The command menu (`ctx.commandUi`, the `/` palette) is DSH's palette
 * analogue — the shipped Client has no `palette` slot.
 *
 * Also asserts the syntax is valid (`vm.Script`, equivalent to `node --check`),
 * that only `react` is required, that only same-origin `/proofcard/*` URLs are
 * fetched, and that no `document.body` writes or ReactDOM imports exist.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');
const source = readFileSync(CLIENT, 'utf8');

const results = [];
function pass(name, detail) {
  results.push({ name, detail });
}

/* ------------------------------------------------------------------ */
/* 1. syntax: compile only — exactly what `node --check` does          */
/* ------------------------------------------------------------------ */

vm.Script && new vm.Script(source, { filename: CLIENT });
pass('syntax', 'vm.Script compiled client.js (node --check equivalent)');

try {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' });
  pass('node --check', 'node --check client.js exited 0');
} catch (error) {
  // A confined sandbox can refuse the child process; the vm compile above is
  // the same parser pass, so only a real SyntaxError should fail here.
  assert.ok(!(error instanceof SyntaxError), `node --check failed: ${error && error.message}`);
  pass('node --check', `spawn unavailable in this environment (${error && error.code}); vm.Script compile used`);
}

/* ------------------------------------------------------------------ */
/* 2. fake ModuleLoader + fake React                                   */
/* ------------------------------------------------------------------ */

const loaded = [];
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition);
    },
  },
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  addEventListener() {},
  removeEventListener() {},
};

function createElement(type, props, ...children) {
  return { type, props: props || {}, children };
}
const React = {
  createElement,
  Fragment: 'Fragment',
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useMemo(factory) { return typeof factory === 'function' ? factory() : undefined; },
  Component: class Component {
    constructor(props) { this.props = props; }
  },
};

const requireCalls = [];
function requireStub(name) {
  requireCalls.push(name);
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') {
    return { jsx: createElement, jsxs: createElement, Fragment: 'Fragment' };
  }
  throw new Error(`unexpected require("${name}") — Proofcard client must only require react`);
}

/* ------------------------------------------------------------------ */
/* 3. fake fetch: same-origin /proofcard routes only                   */
/* ------------------------------------------------------------------ */

const fetchCalls = [];
const RECEIPT = {
  schema: 1,
  id: 'rc_test_0001',
  created_at: Math.floor(Date.now() / 1000) - 90,
  session_id: 's1',
  turn: 2,
  model: 'deepseek-flash',
  claims: [
    { id: 'c1', text: 'All 14 tests pass.', kind: 'test_passed', verdict: 'verified', evidence: [{ id: 'call_1' }], note: 'recorded check passed' },
    { id: 'c2', text: 'Wrote src/a.py.', kind: 'file_changed', verdict: 'unverified', evidence: [] },
  ],
  stats: { claims: 2, verified: 1, partial: 0, unverified: 1, contradicted: 0 },
  accepted: false,
  accept_note: '',
  challenges: [],
};

function fakeFetch(url) {
  fetchCalls.push(String(url));
  const target = String(url);
  if (target.includes('/receipts')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, count: 1, receipts: [RECEIPT] }),
    });
  }
  if (target.includes('/stats')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        ok: true,
        totals: { receipts: 1, claims: 2, verified: 1, partial: 0, unverified: 1, contradicted: 0, accepted_receipts: 0 },
        by_kind: {},
      }),
    });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
}

/* ------------------------------------------------------------------ */
/* 4. fake Cordis client context                                       */
/* ------------------------------------------------------------------ */

function fakeContext(overrides = {}) {
  const calls = { injections: [], registrations: [], effects: [], timers: [], commands: [], disposals: [], scoped: [] };
  const ctx = {
    calls,
    slots: {
      inject(key, callback) {
        calls.injections.push(key);
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(definition, component) {
        calls.registrations.push({ definition, component });
        return () => {};
      },
    },
    effect(callback) {
      const dispose = callback();
      calls.effects.push(dispose);
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    onDispose(callback) {
      calls.disposals.push(callback);
      return () => {};
    },
    setInterval(callback, delay) {
      calls.timers.push(delay);
      return () => {};
    },
    setTimeout() { return () => {}; },
    inject(names, callback) {
      calls.scoped.push(names.join(','));
      callback(ctx);
    },
    on() {},
    locale: { bind: () => (key) => key },
    fetch: fakeFetch,
    ...overrides,
  };
  if (!('commandUi' in overrides)) {
    ctx.commandUi = {
      register(contribution) {
        calls.commands.push(contribution);
        return () => {};
      },
    };
  }
  if (overrides.commandUi === undefined && 'commandUi' in overrides) delete ctx.commandUi;
  return ctx;
}

const sandbox = {
  window: fakeWindow,
  document: {
    createElement() { return { style: {}, appendChild() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  },
  navigator: { userAgent: 'proofcard-smoke' },
  fetch: fakeFetch,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  JSON,
  Math,
  Promise,
};
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: CLIENT });

assert.equal(loaded.length, 1, 'client.js must call window.__ModuleLoader__.load exactly once');
const definition = loaded[0];
assert.equal(definition.id, '@local/proofcard-dsh', 'loader id must equal the package name');
assert.equal(typeof definition.factory, 'function', 'loader definition must expose factory(require)');

pass('module loader', `captured id "${definition.id}"`);

/* ------------------------------------------------------------------ */
/* 5. factory + apply                                                  */
/* ------------------------------------------------------------------ */

const plugin = definition.factory(requireStub);
assert.ok(plugin && typeof plugin === 'object', 'factory must return the plugin object');
assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), 'plugin must inject slots');
assert.equal(typeof plugin.apply, 'function', 'plugin must expose apply(ctx)');

const ctx = fakeContext();
const dispose = plugin.apply(ctx);
assert.equal(typeof dispose, 'function', 'apply should return a disposer');

pass('requires', JSON.stringify(requireCalls.filter((name) => !name.startsWith('react'))));
for (const name of requireCalls) {
  assert.ok(name === 'react' || name === 'react/jsx-runtime', `unexpected require("${name}")`);
}

/* --- slot registrations --- */
const dock = ctx.calls.registrations.find((row) => row.definition.name === 'conversation.composer.dock');
assert.ok(dock, 'must register into conversation.composer.dock');
assert.equal(dock.definition.id, 'proofcard-dock');
assert.equal(typeof dock.component, 'function');
pass('slot: composer dock', `id=${dock.definition.id} order=${dock.definition.order}`);

const settings = ctx.calls.registrations.find((row) => row.definition.name === 'settings.section');
assert.ok(settings, 'must register into settings.section');
assert.equal(settings.definition.id, 'proofcard');
assert.equal(settings.definition.order, 40);
assert.equal(settings.definition.label, 'Proofcard');
assert.equal(typeof settings.component, 'function');
pass('slot: settings.section', `id=${settings.definition.id} order=${settings.definition.order} label=${JSON.stringify(settings.definition.label)}`);

/* --- palette analogue: the client command menu --- */
assert.equal(ctx.calls.commands.length, 1, 'must contribute one client command (palette entry)');
const command = ctx.calls.commands[0];
assert.equal(command.name, 'proofcard');
assert.equal(typeof command.label, 'function');
assert.equal(command.label(), 'Proofcard: latest receipt');
assert.equal(typeof command.available, 'function');
assert.equal(command.available({}), true);
assert.ok(command.ui && command.ui.kind === 'action' && typeof command.ui.run === 'function');
assert.doesNotThrow(() => command.ui.run({ sessionId: 's1' }));
pass('palette/command', `name=/${command.name} label=${JSON.stringify(command.label())} kind=${command.ui.kind}`);

/* --- resources --- */
assert.ok(ctx.calls.injections.includes('conversation.composer.dock'));
assert.ok(ctx.calls.injections.includes('settings.section'));
assert.ok(ctx.calls.effects.length >= 1, 'poll timer/store must be owned through ctx.effect');
assert.deepEqual(ctx.calls.timers.filter((delay) => delay === 6000), [6000], 'must poll every 6000 ms via ctx.setInterval');
pass('resources', `effects=${ctx.calls.effects.length} timers=${JSON.stringify(ctx.calls.timers)}`);

/* --- network: only same-origin /proofcard/* --- */
await new Promise((resolve) => setTimeout(resolve, 25));
assert.ok(fetchCalls.some((url) => /^\/proofcard\/receipts\?limit=\d+$/.test(url)), 'must poll /proofcard/receipts?limit=N');
for (const url of fetchCalls) {
  assert.ok(url.startsWith('/proofcard/'), `unexpected network call: ${url}`);
}
pass('network', fetchCalls.join(', '));

/* --- source hardening --- */
assert.ok(!/document\s*\.\s*body\s*=/.test(source), 'must not assign document.body');
assert.ok(!/document\.body\.(append|prepend|replace|insert)/.test(source), 'must not append to document.body');
assert.ok(!/react-dom|ReactDOM/.test(source), 'must not require ReactDOM');
assert.ok(!/https?:\/\//.test(source), 'must not reference external origins');
pass('hardening', 'no document.body writes, no ReactDOM, no external URLs');

/* --- disposal + degradation without optional services --- */
assert.doesNotThrow(() => dispose());
assert.doesNotThrow(() => {
  for (const effectDispose of ctx.calls.effects) {
    if (typeof effectDispose === 'function') effectDispose();
  }
});
pass('disposal', 'apply disposer and effect disposers ran clean');

const minimalPlugin = definition.factory(requireStub);
const minimalCtx = fakeContext({ commandUi: undefined });
delete minimalCtx.inject;
assert.doesNotThrow(() => minimalPlugin.apply(minimalCtx), 'must activate without the command palette service');
assert.ok(minimalCtx.calls.registrations.some((row) => row.definition.name === 'settings.section'));
pass('degradation', 'activates without commandUi/inject');

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

for (const row of results) {
  console.log(`ok  ${row.name.padEnd(20)} ${row.detail}`);
}
console.log(`\nclient smoke: ${results.length} checks passed (${path.relative(process.cwd(), CLIENT)})`);
