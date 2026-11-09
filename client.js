/**
 * Proofcard DSH — Client half.
 *
 * Registers three contributions against the shipped DeepSeek Harness Web
 * extension points:
 *
 * - `conversation.composer.dock` — a compact status pill for the latest
 *   receipt (`Proofcard · N unproven` / `Proofcard · verified`). It polls
 *   `GET /proofcard/receipts?limit=5` on the same origin; no CORS.
 * - `settings.section` (id `proofcard`, order 40, label `Proofcard`) — the
 *   receipt pane: header with the latest receipt time/model, Refresh, a
 *   verified/partial/unverified/contradicted stats strip, receipt cards with
 *   verdict chips, claims and their evidence, in-place Accept and Challenge.
 * - the client command surface (`ctx.commandUi`, DSH's `/` command menu — the
 *   palette analogue; the Client has no `palette` slot): a
 *   `Proofcard: latest receipt` action.
 *
 * Styling uses only `--dsw-alias-*` theme tokens. No JSX, no build step, no
 * `document.body` writes, and every contribution is wrapped in a React error
 * boundary so a bad payload can never blank the host slot.
 */
window.__ModuleLoader__.load({
  id: '@local/proofcard-dsh',
  factory(require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    var API = '/proofcard';
    var API_ACTIONS = '/proofcard/actions';
    var POLL_MS = 6000;
    var POLL_LIMIT = 30;
    var MAX_CLAIMS = 6;
    var REQUEST_TIMEOUT_MS = 8000;
    var VERDICTS = ['verified', 'partial', 'unverified', 'contradicted'];

    /* ------------------------------------------------------------------ */
    /* theme tokens (only --dsw-alias-*; verdict colors live on the dots)  */
    /* ------------------------------------------------------------------ */

    var T = {
      bgBase: 'var(--dsw-alias-bg-base)',
      bgLayer: 'var(--dsw-alias-bg-layer-2)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      cardFill: 'var(--dsw-alias-settings-card-fill)',
      cardStroke: 'var(--dsw-alias-settings-card-stroke)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      label: 'var(--dsw-alias-label-primary)',
      labelInverted: 'var(--dsw-alias-label-primary-inverted)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      dimmed: 'var(--dsw-alias-label-dimmed)',
      caption: 'var(--dsw-alias-label-caption)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      link: 'var(--dsw-alias-link)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      business: 'var(--dsw-alias-state-business-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      infoFill: 'var(--dsw-alias-button-info-fill)',
      infoHover: 'var(--dsw-alias-button-info-hover)',
      primaryFill: 'var(--dsw-alias-button-primary-fill)',
      primaryHover: 'var(--dsw-alias-button-primary-hover)',
    };

    var VERDICT_COLOR = {
      verified: T.success,
      partial: T.business,
      unverified: T.warn,
      contradicted: T.error,
    };

    var VERDICT_LABEL = {
      verified: 'verified',
      partial: 'partial',
      unverified: 'unverified',
      contradicted: 'contradicted',
    };

    var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    var S = {
      dockRow: {
        display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0,
        fontSize: 12, lineHeight: '16px',
      },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0,
        font: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer',
        padding: '3px 9px', borderRadius: 999,
        border: '1px solid ' + T.borderL1,
        background: T.bgLayer,
        color: T.secondary,
      },
      pillStrong: { color: T.label, fontWeight: 500 },
      pillMuted: { color: T.dimmed },
      dot: function (color) {
        return { width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' };
      },
      hint: {
        color: T.tertiary, fontSize: 11, lineHeight: '15px', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240,
      },
      page: {
        display: 'flex', flexDirection: 'column', gap: 14, color: T.label,
        fontSize: 13, lineHeight: '20px', minWidth: 0,
      },
      header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 16, lineHeight: '22px', fontWeight: 600, color: T.label },
      headerMeta: { display: 'inline-flex', alignItems: 'center', gap: 6, color: T.secondary, fontSize: 12 },
      button: {
        font: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer',
        borderRadius: 6, padding: '4px 10px', flex: 'none',
        border: '1px solid ' + T.borderL2, background: 'transparent', color: T.label,
      },
      primaryButton: {
        font: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer',
        borderRadius: 6, padding: '4px 10px', flex: 'none',
        border: '1px solid ' + T.infoFill, background: T.infoFill, color: T.labelInverted,
      },
      linkButton: {
        font: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer', padding: 0,
        border: 'none', background: 'transparent', color: T.link, textDecoration: 'underline',
      },
      statsStrip: {
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
      },
      statCell: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
        borderRadius: 999, border: '1px solid ' + T.borderL1, background: T.bgLayer,
        fontSize: 12, lineHeight: '16px', color: T.secondary,
      },
      statValue: { color: T.label, fontWeight: 600 },
      card: {
        border: '1px solid ' + T.cardStroke,
        background: T.cardFill,
        borderRadius: 10, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      cardId: {
        fontFamily: MONO, fontSize: 11, lineHeight: '16px', color: T.secondary,
        padding: '1px 6px', borderRadius: 4, border: '1px solid ' + T.borderL1,
        background: T.bgBase, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', maxWidth: 260,
      },
      meta: { color: T.tertiary, fontSize: 12, lineHeight: '16px' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: function (color) {
        return {
          display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none',
          fontSize: 11, lineHeight: '16px', padding: '0 7px', borderRadius: 999,
          color: color, border: '1px solid ' + color, background: 'transparent',
        };
      },
      chipNeutral: {
        display: 'inline-flex', alignItems: 'center', flex: 'none',
        fontSize: 11, lineHeight: '16px', padding: '0 7px', borderRadius: 999,
        color: T.tertiary, border: '1px solid ' + T.borderL1, background: 'transparent',
      },
      claims: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
      claimRow: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
      claimMain: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
      claimTop: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      claimKind: {
        fontFamily: MONO, fontSize: 10, lineHeight: '14px', color: T.tertiary,
        padding: '0 5px', borderRadius: 4, border: '1px solid ' + T.borderL1,
        background: T.bgBase, flex: 'none',
      },
      claimText: { color: T.label, lineHeight: '18px', overflowWrap: 'anywhere', flex: 1, minWidth: 120 },
      claimMeta: { color: T.tertiary, fontSize: 11, lineHeight: '15px', overflowWrap: 'anywhere' },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      noteInput: {
        font: 'inherit', fontSize: 12, lineHeight: '16px', color: T.label,
        background: T.bgBase, border: '1px solid ' + T.borderL1, borderRadius: 6,
        padding: '4px 8px', minWidth: 180, flex: 1, maxWidth: 320,
      },
      checks: {
        display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2,
        borderTop: '1px solid ' + T.borderL1, marginTop: 2, paddingTop: 8,
      },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
      checkMain: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 },
      checkLabel: { color: T.label, fontSize: 12, lineHeight: '17px', overflowWrap: 'anywhere' },
      checkDetail: { color: T.tertiary, fontSize: 11, lineHeight: '15px', overflowWrap: 'anywhere' },
      checkState: { color: T.secondary, fontSize: 11, lineHeight: '15px', flex: 'none' },
      empty: { color: T.dimmed, fontSize: 13, lineHeight: '20px', padding: '6px 0' },
      offline: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10,
        border: '1px solid ' + T.borderL1, background: T.bgLayer, color: T.secondary,
        fontSize: 12, lineHeight: '18px',
      },
      offlineTitle: { color: T.label, fontWeight: 600, fontSize: 13 },
      errorText: { color: T.error, fontSize: 12, lineHeight: '18px', overflowWrap: 'anywhere' },
      accepted: {
        display: 'inline-flex', alignItems: 'center', gap: 5, color: T.success,
        fontSize: 12, lineHeight: '18px',
      },
      footnote: { color: T.caption, fontSize: 11, lineHeight: '16px' },
      busyText: { color: T.tertiary, fontSize: 11, lineHeight: '15px' },
    };

    /* ------------------------------------------------------------------ */
    /* small utilities                                                     */
    /* ------------------------------------------------------------------ */

    function messageOf(error) {
      try {
        if (error && typeof error.message === 'string' && error.message) return error.message;
        return String(error);
      } catch (failure) {
        return 'unknown error';
      }
    }

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function number(value, fallback) {
      var parsed = typeof value === 'number' ? value : Number(value);
      return isFinite(parsed) ? parsed : (fallback || 0);
    }

    function str(value) {
      return typeof value === 'string' ? value : '';
    }

    function truncate(text, limit) {
      var value = str(text);
      if (!limit || value.length <= limit) return value;
      return value.slice(0, limit - 1) + '…';
    }

    /** Same-origin JSON request with a bounded wait; never rejects unhandled. */
    function fetchJson(path, init) {
      return new Promise(function (resolve, reject) {
        if (typeof fetch !== 'function') {
          reject(new Error('fetch unavailable'));
          return;
        }
        var settled = false;
        var timer = null;
        function settle(error, value) {
          if (settled) return;
          settled = true;
          if (timer !== null) {
            try { clearTimeout(timer); } catch (failure) { /* ignore */ }
            timer = null;
          }
          if (error) reject(error);
          else resolve(value);
        }
        try {
          timer = setTimeout(function () { settle(new Error('request timed out')); }, REQUEST_TIMEOUT_MS);
        } catch (failure) {
          timer = null;
        }
        Promise.resolve()
          .then(function () { return fetch(path, init || {}); })
          .then(function (response) {
            if (!response || response.ok !== true) {
              settle(new Error('HTTP ' + (response && response.status ? response.status : 'error')));
              return;
            }
            return Promise.resolve(response.json()).then(
              function (value) { settle(null, value); },
              function (error) { settle(error || new Error('invalid JSON')); },
            );
          })
          .catch(function (error) { settle(error || new Error('request failed')); });
      });
    }

    function getJson(path) {
      return fetchJson(path, { method: 'GET', headers: { accept: 'application/json' } });
    }

    function postJson(path, body) {
      return fetchJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }

    function timestampMs(value) {
      if (typeof value === 'number' && isFinite(value)) return value > 1e12 ? value : value * 1000;
      if (typeof value === 'string' && value) {
        var parsed = Date.parse(value);
        if (isFinite(parsed)) return parsed;
      }
      return NaN;
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function formatTime(value) {
      var ms = timestampMs(value);
      if (!isFinite(ms)) return 'unknown time';
      try {
        var date = new Date(ms);
        return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
      } catch (failure) {
        return 'unknown time';
      }
    }

    function ageOf(value) {
      var ms = timestampMs(value);
      if (!isFinite(ms)) return '';
      var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (seconds < 45) return 'just now';
      var minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      var hours = Math.round(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.round(hours / 24) + 'd ago';
    }

    /* ------------------------------------------------------------------ */
    /* data normalization (defensive against any envelope drift)           */
    /* ------------------------------------------------------------------ */

    function normalizeReceipts(payload) {
      if (Array.isArray(payload)) return payload.filter(isObject);
      if (!isObject(payload)) return [];
      if (Array.isArray(payload.receipts)) return payload.receipts.filter(isObject);
      if (Array.isArray(payload.items)) return payload.items.filter(isObject);
      if (Array.isArray(payload.data)) return payload.data.filter(isObject);
      if (isObject(payload.receipt)) return [payload.receipt];
      return [];
    }

    function emptyTotals() {
      return {
        receipts: 0, claims: 0, verified: 0, partial: 0,
        unverified: 0, contradicted: 0, accepted_receipts: 0,
      };
    }

    function normalizeStats(payload) {
      if (!isObject(payload)) return null;
      var source = isObject(payload.totals) ? payload.totals : payload;
      var totals = emptyTotals();
      var keys = Object.keys(totals);
      var hasAny = false;
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index];
        if (typeof source[key] !== 'undefined') {
          totals[key] = number(source[key], 0);
          hasAny = true;
        }
      }
      return hasAny ? totals : null;
    }

    function claimCounts(claims) {
      var counts = { claims: 0, verified: 0, partial: 0, unverified: 0, contradicted: 0 };
      var list = Array.isArray(claims) ? claims : [];
      counts.claims = list.length;
      for (var position = 0; position < list.length; position += 1) {
        var verdict = str(list[position] && list[position].verdict);
        if (Object.prototype.hasOwnProperty.call(counts, verdict)) counts[verdict] += 1;
      }
      return counts;
    }

    /** Assertions are narrative; they never count toward the verified/trust metric. */
    function verifiableCounts(receipt) {
      if (!isObject(receipt) || !Array.isArray(receipt.claims)) return receiptCounts(receipt);
      return claimCounts(receipt.claims.filter(function (claim) {
        return claim && claim.kind !== 'assertion';
      }));
    }

    function narrativeCount(receipt) {
      if (!isObject(receipt) || !Array.isArray(receipt.claims)) return 0;
      return receipt.claims.filter(function (claim) { return claim && claim.kind === 'assertion'; }).length;
    }

    function receiptCounts(receipt) {
      if (!isObject(receipt)) return claimCounts([]);
      if (Array.isArray(receipt.claims)) return claimCounts(receipt.claims);
      var counts = claimCounts([]);
      var stats = isObject(receipt.stats) ? receipt.stats : null;
      if (stats) {
        for (var index = 0; index < keysOf(counts).length; index += 1) {
          var key = keysOf(counts)[index];
          counts[key] = number(stats[key], 0);
        }
      }
      return counts;
    }

    function keysOf(object) {
      return Object.keys(object || {});
    }

    function totalsFromReceipts(receipts) {
      var totals = emptyTotals();
      totals.receipts = receipts.length;
      for (var index = 0; index < receipts.length; index += 1) {
        var counts = verifiableCounts(receipts[index]);
        totals.claims += counts.claims;
        totals.verified += counts.verified;
        totals.partial += counts.partial;
        totals.unverified += counts.unverified;
        totals.contradicted += counts.contradicted;
        if (receipts[index] && receipts[index].accepted === true) totals.accepted_receipts += 1;
      }
      return totals;
    }

    function unprovenOf(receipt) {
      var counts = receiptCounts(receipt);
      return counts.unverified + counts.contradicted;
    }

    /* ------------------------------------------------------------------ */
    /* timer helpers: disposable through the plugin's ctx                  */
    /* ------------------------------------------------------------------ */

    function startInterval(ctx, fn, delay) {
      try {
        if (ctx && typeof ctx.interval === 'function') return ctx.interval(fn, delay);
      } catch (failure) { /* fall through */ }
      try {
        if (ctx && typeof ctx.setInterval === 'function') return ctx.setInterval(fn, delay);
      } catch (failure) { /* fall through */ }
      try {
        if (typeof setInterval === 'function') {
          var id = setInterval(fn, delay);
          return function () { clearInterval(id); };
        }
      } catch (failure) { /* fall through */ }
      return function () {};
    }

    /* ------------------------------------------------------------------ */
    /* shared state store (one poll loop for every consumer)               */
    /* ------------------------------------------------------------------ */

    function createStore(ctx) {
      var listeners = [];
      var disposed = false;
      var token = 0;
      var stopTimer = null;
      var activeSessionId = null;
      var composerBridge = null;
      var state = {
        phase: 'loading',
        receipts: [],
        stats: emptyTotals(),
        error: null,
        refreshing: false,
        notice: null,
        noticeUntil: 0,
        drawerOpen: false,
        drawerReceiptId: null,
        filter: 'session',
      };

      function snapshot() {
        return state;
      }

      function publish(patch) {
        if (disposed) return;
        var next = {};
        var key;
        for (key in state) {
          if (Object.prototype.hasOwnProperty.call(state, key)) next[key] = state[key];
        }
        for (key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
        }
        state = next;
        var copy = listeners.slice();
        for (var index = 0; index < copy.length; index += 1) {
          try { copy[index](); } catch (failure) { /* listener failures never break polling */ }
        }
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return function () {};
        listeners.push(listener);
        return function () {
          var at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      }

      function refresh(quiet) {
        if (disposed) return Promise.resolve();
        if (quiet !== true) publish({ refreshing: true, error: null });
        var myToken = token + 1;
        token = myToken;
        var receiptsRequest = getJson(API + '/receipts?limit=' + POLL_LIMIT).then(
          function (payload) { return { ok: true, receipts: normalizeReceipts(payload) }; },
          function (error) { return { ok: false, error: messageOf(error) }; },
        );
        var statsRequest = getJson(API + '/stats').then(
          function (payload) { return normalizeStats(payload); },
          function () { return null; },
        );
        return Promise.all([receiptsRequest, statsRequest]).then(function (results) {
          if (disposed || myToken !== token) return;
          var listed = results[0];
          if (!listed.ok) {
            publish({ phase: 'offline', error: listed.error, refreshing: false });
            return;
          }
          publish({
            phase: listed.receipts.length > 0 ? 'online' : 'empty',
            receipts: listed.receipts,
            stats: results[1] || totalsFromReceipts(listed.receipts),
            error: null,
            refreshing: false,
          });
        }, function (error) {
          if (disposed || myToken !== token) return;
          publish({ phase: 'offline', error: messageOf(error), refreshing: false });
        });
      }

      function notify(text) {
        var message = str(text);
        if (!message) return;
        publish({ notice: message, noticeUntil: Date.now() + 6000 });
      }

      function openDrawer(receiptId) {
        publish({ drawerOpen: true, drawerReceiptId: receiptId ? str(receiptId) : null });
      }

      function closeDrawer() {
        publish({ drawerOpen: false });
      }

      function setFilter(filter) {
        publish({ filter: filter === 'all' ? 'all' : 'session' });
      }

      function setSession(sessionId) {
        activeSessionId = sessionId ? str(sessionId) : null;
      }

      function getSession() {
        return activeSessionId;
      }

      function setComposerBridge(bridge) {
        composerBridge = typeof bridge === 'function' ? bridge : null;
      }

      function insertIntoComposer(text) {
        var message = str(text);
        if (!message || typeof composerBridge !== 'function') return false;
        try { return composerBridge(message) !== false; } catch (failure) { return false; }
      }

      function start() {
        if (disposed) return;
        stopTimer = startInterval(ctx, function () { refresh(true); }, POLL_MS);
        refresh(true);
      }

      function dispose() {
        if (disposed) return;
        disposed = true;
        listeners.length = 0;
        if (typeof stopTimer === 'function') {
          try { stopTimer(); } catch (failure) { /* ignore */ }
        }
        stopTimer = null;
      }

      return {
        snapshot: snapshot,
        subscribe: subscribe,
        refresh: refresh,
        notify: notify,
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,
        setFilter: setFilter,
        setSession: setSession,
        getSession: getSession,
        setComposerBridge: setComposerBridge,
        insertIntoComposer: insertIntoComposer,
        start: start,
        dispose: dispose,
      };
    }

    /* ------------------------------------------------------------------ */
    /* navigation: open Settings -> Proofcard, or explain that SDK has none */
    /* ------------------------------------------------------------------ */

    /**
     * The shipped Client exposes no public "open Settings at section X" call
     * (the shell's open/select store is private to ui-settings-general). Probe
     * any future SDK surface defensively; when none exists the caller renders
     * an explanatory hint instead of throwing.
     */
    function openProofcard(ctx, store, sectionId) {
      var id = sectionId || 'proofcard';
      try {
        if (ctx && ctx.layout && typeof ctx.layout.openSettings === 'function') {
          ctx.layout.openSettings(id);
          return true;
        }
        if (ctx && ctx.settings && typeof ctx.settings.openSection === 'function') {
          ctx.settings.openSection(id);
          return true;
        }
        if (ctx && ctx.ui && typeof ctx.ui.openSettings === 'function') {
          ctx.ui.openSettings(id);
          return true;
        }
      } catch (failure) {
        /* fall through to the explanatory hint */
      }
      try { store.notify('Open Settings → Proofcard'); } catch (failure) { /* ignore */ }
      return false;
    }

    /* ------------------------------------------------------------------ */
    /* palette analogue: the client command menu (`ctx.commandUi`)         */
    /* ------------------------------------------------------------------ */

    function paletteContribution(ctx, store) {
      return {
        name: 'proofcard',
        available: function () { return true; },
        label: function () { return 'Proofcard: latest receipt'; },
        description: function () {
          return 'Review the latest proof receipt in Settings → Proofcard';
        },
        ui: {
          kind: 'action',
          run: function () { store.openDrawer(null); },
        },
      };
    }

    function registerPalette(ctx, store) {
      var contribution = paletteContribution(ctx, store);
      function install(scope) {
        try {
          var target = scope && scope.commandUi ? scope.commandUi : (ctx && ctx.commandUi);
          if (!target || typeof target.register !== 'function') return;
          var dispose = target.register(contribution);
          if (typeof dispose !== 'function') return;
          if (scope && typeof scope.effect === 'function') {
            scope.effect(function () { return dispose; });
          } else if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(function () { return dispose; });
          }
        } catch (failure) {
          /* the palette is optional; never break the rest of the plugin */
        }
      }
      try {
        if (ctx && ctx.commandUi) {
          install(ctx);
          return;
        }
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['commandUi'], function (scope) { install(scope); });
        }
      } catch (failure) {
        /* optional surface */
      }
    }

    /* ------------------------------------------------------------------ */
    /* React plumbing                                                      */
    /* ------------------------------------------------------------------ */

    function useStore(store) {
      var state = React.useState(0);
      var force = state[1];
      React.useEffect(function () {
        return store.subscribe(function () {
          force(function (count) { return count + 1; });
        });
      }, [store]);
      return store.snapshot();
    }

    /**
     * React error boundary: a bad receipt payload degrades that one slot entry
     * to a single line instead of blanking the host slot.
     */
    function guarded(Inner, label, bind) {
      var Base = (React && React.Component) || function () {};
      function Guard(props) {
        Base.call(this, props);
        this.state = { failed: false };
      }
      Guard.prototype = Object.create(Base.prototype);
      Guard.prototype.constructor = Guard;
      Guard.getDerivedStateFromError = function () {
        return { failed: true };
      };
      Guard.prototype.componentDidCatch = function (error) {
        try { console.warn('Proofcard: ' + label + ' render failed', error); } catch (failure) { /* ignore */ }
      };
      Guard.prototype.render = function () {
        if (this.state.failed) return h('span', { style: S.offlineTitle }, 'Proofcard UI unavailable');
        try {
          var extra = typeof bind === 'function' ? bind(this.props) : null;
          return h(Inner, Object.assign({}, this.props, extra || {}));
        } catch (error) {
          try { console.warn('Proofcard: ' + label + ' threw', error); } catch (failure) { /* ignore */ }
          return h('span', { style: S.offlineTitle }, 'Proofcard UI unavailable');
        }
      };
      return Guard;
    }

    /* ------------------------------------------------------------------ */
    /* composer-dock pill                                                  */
    /* ------------------------------------------------------------------ */

    function DockView(props) {
      var store = props.store;
      var snapshot = useStore(store);
      var hintState = React.useState(false);
      var hintOpen = hintState[0];
      var setHintOpen = hintState[1];

      React.useEffect(function () {
        store.setSession(props.sessionId);
      }, [props.sessionId]);

      function onClick() {
        store.openDrawer(null);
      }

      function openSettings() {
        var opened = openProofcard(props.ctx, store);
        setHintOpen(!opened);
      }

      /* A quiet entry point while the first poll is in flight. */
      if (snapshot.phase === 'loading') {
        return h('div', { style: S.dockRow },
          h('span', { style: S.pill, title: 'Proofcard is loading receipts…' },
            h('span', { style: S.dot(T.idle), 'aria-hidden': true }),
            h('span', { style: S.pillMuted }, 'Proofcard')));
      }

      if (snapshot.phase === 'offline') {
        return h('div', { style: S.dockRow },
          h('button', {
            type: 'button',
            style: S.pill,
            title: 'Proofcard host is offline — ' + (snapshot.error || 'no answer from /proofcard'),
            onClick: onClick,
          },
            h('span', { style: S.dot(T.idle), 'aria-hidden': true }),
            h('span', { style: S.pillMuted }, 'Proofcard · offline')),
          snapshot.notice && Date.now() < snapshot.noticeUntil
            ? h('span', { style: S.hint }, snapshot.notice)
            : null);
      }

      var receipts = Array.isArray(snapshot.receipts) ? snapshot.receipts : [];
      var latest = receipts.length > 0 ? receipts[0] : null;
      /* Quiet but discoverable when there is nothing to report yet. */
      if (!latest) {
        return h('div', { style: S.dockRow },
          h('span', { style: S.pill, title: 'No receipts yet — finish a turn to create one.' },
            h('span', { style: S.dot(T.idle), 'aria-hidden': true }),
            h('span', { style: S.pillMuted }, 'Proofcard')));
      }

      var counts = verifiableCounts(latest);
      var narrative = narrativeCount(latest);
      var unproven = counts.unverified + counts.contradicted;
      var allVerified = counts.claims > 0 && counts.verified === counts.claims;
      var tone = T.idle;
      var text = 'Proofcard';
      var strong = S.pillMuted;
      if (latest.accepted) {
        tone = T.success;
        text = 'Proofcard · reviewed';
        strong = S.pillStrong;
      } else if (counts.claims === 0) {
        tone = narrative > 0 ? T.business : T.idle;
        text = narrative > 0 ? 'Proofcard · narrative' : 'Proofcard';
        strong = narrative > 0 ? { color: T.secondary } : S.pillMuted;
      } else if (unproven > 0) {
        tone = T.warn;
        text = 'Proofcard · ' + unproven + ' unproven';
        strong = S.pillStrong;
      } else if (allVerified) {
        tone = T.success;
        text = 'Proofcard · verified';
        strong = S.pillStrong;
      } else if (counts.partial > 0) {
        tone = T.business;
        text = 'Proofcard · ' + counts.verified + '/' + counts.claims + ' verified';
        strong = { color: T.secondary };
      } else {
        text = 'Proofcard · ' + (counts.claims > 0 ? counts.verified + '/' + counts.claims + ' verified' : 'no claims');
        strong = S.pillMuted;
      }

      var titleText = 'Latest receipt ' + (str(latest.id) || '(unknown id)')
        + ' · ' + formatTime(latest.created_at)
        + (str(latest.model) ? ' · ' + str(latest.model) : '')
        + ' — open Settings → Proofcard';
      var noticeVisible = snapshot.notice && Date.now() < snapshot.noticeUntil;

      return h('div', { style: S.dockRow },
        h('button', {
          type: 'button',
          style: S.pill,
          title: titleText,
          'aria-label': titleText,
          onClick: onClick,
        },
          h('span', { style: S.dot(tone), 'aria-hidden': true }),
          h('span', { style: strong }, text)),
        noticeVisible || hintOpen
          ? h('span', { style: S.hint }, snapshot.notice || 'Open Settings → Proofcard')
          : null);
    }

    /* ------------------------------------------------------------------ */
    /* settings section                                                    */
    /* ------------------------------------------------------------------ */

    function VerdictChip(props) {
      var verdict = props.verdict;
      var count = props.count;
      var color = VERDICT_COLOR[verdict] || T.tertiary;
      return h('span', { style: S.chip(color), title: VERDICT_LABEL[verdict] + ': ' + count },
        h('span', { style: S.dot(color), 'aria-hidden': true }),
        h('span', null, VERDICT_LABEL[verdict] + ' ' + count));
    }

    function ClaimRow(props) {
      var claim = isObject(props.claim) ? props.claim : {};
      var verdict = str(claim.verdict) || 'unverified';
      var color = VERDICT_COLOR[verdict] || T.idle;
      var kind = str(claim.kind) || 'claim';
      var evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
      var note = truncate(claim.note, 180);
      return h('div', { style: S.claimRow },
        h('span', { style: S.dot(color), 'aria-hidden': true, title: VERDICT_LABEL[verdict] || verdict }),
        h('div', { style: S.claimMain },
          h('div', { style: S.claimTop },
            h('span', { style: S.claimKind }, kind),
            h('span', { style: S.claimText }, str(claim.text) || '(no claim text)')),
          h('span', { style: S.claimMeta },
            evidence.length + ' evidence' + (note ? ' · ' + note : ''))));
    }

    function CheckRow(props) {
      var check = isObject(props.check) ? props.check : {};
      var ran = check.ran === true;
      var ok = check.ok === true;
      var color = !ran ? T.idle : (ok ? T.success : T.error);
      var state = !ran ? 'not run' : (ok ? 'ok' : 'failed');
      return h('div', { style: S.checkRow },
        h('span', { style: S.dot(color), 'aria-hidden': true }),
        h('div', { style: S.checkMain },
          h('span', { style: S.checkLabel }, str(check.label) || str(check.kind) || 'check'),
          h('span', { style: S.checkDetail },
            'ran: ' + (ran ? 'yes' : 'no') + ' · ok: ' + (ran ? (ok ? 'yes' : 'no') : '—')
            + (str(check.detail) ? ' · ' + truncate(check.detail, 220) : ''))),
        h('span', { style: S.checkState }, state));
    }

    function ReceiptCard(props) {
      var receipt = isObject(props.receipt) ? props.receipt : {};
      var store = props.store;
      var id = str(receipt.id);
      var counts = receiptCounts(receipt);
      var claims = Array.isArray(receipt.claims) ? receipt.claims : [];
      var shown = claims.slice(0, MAX_CLAIMS);
      var hidden = Math.max(0, claims.length - shown.length);
      var noteState = React.useState('');
      var note = noteState[0];
      var setNote = noteState[1];
      var busyState = React.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var failureState = React.useState(null);
      var failure = failureState[0];
      var setFailure = failureState[1];
      var checksState = React.useState(null);
      var checks = checksState[0];
      var setChecks = checksState[1];

      function accept() {
        if (!id || busy) return;
        setBusy('accept');
        setFailure(null);
        postJson(API_ACTIONS + '/receipts/' + encodeURIComponent(id) + '/accept', { note: note })
          .then(function (payload) {
            if (!isObject(payload) || payload.ok === false) {
              throw new Error(str(payload && payload.error) || 'accept failed');
            }
            return store.refresh();
          })
          .catch(function (error) {
            setFailure('Accept failed: ' + messageOf(error));
          })
          .then(function () { setBusy(null); });
      }

      function challenge() {
        if (!id || busy) return;
        setBusy('challenge');
        setFailure(null);
        postJson(API_ACTIONS + '/receipts/' + encodeURIComponent(id) + '/challenge', { run: true })
          .then(function (payload) {
            if (!isObject(payload) || payload.ok === false) {
              throw new Error(str(payload && payload.error) || 'challenge failed');
            }
            setChecks(Array.isArray(payload.checks) ? payload.checks : []);
            return store.refresh();
          })
          .catch(function (error) {
            setFailure('Challenge failed: ' + messageOf(error));
          })
          .then(function () { setBusy(null); });
      }

      var accepted = receipt.accepted === true;
      var chips = [];
      for (var index = 0; index < VERDICTS.length; index += 1) {
        var verdict = VERDICTS[index];
        if (counts[verdict] > 0) chips.push(h(VerdictChip, { key: verdict, verdict: verdict, count: counts[verdict] }));
      }
      if (chips.length === 0) chips.push(h('span', { key: 'none', style: S.chipNeutral }, 'no claims'));

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('span', { style: S.cardId, title: id || '(missing id)' }, id || '(missing id)'),
          h('span', { style: S.meta },
            formatTime(receipt.created_at)
            + (str(receipt.model) ? ' · ' + str(receipt.model) : '')
            + (number(receipt.turn, 0) > 0 ? ' · turn ' + number(receipt.turn, 0) : '')),
          accepted ? h('span', { style: S.accepted }, '✓ accepted') : null),
        h('div', { style: S.chips }, chips),
        shown.length > 0
          ? h('div', { style: S.claims }, shown.map(function (claim, position) {
            return h(ClaimRow, { key: str(claim && claim.id) || String(position), claim: claim });
          }))
          : h('span', { style: S.empty }, 'This receipt has no extracted claims.'),
        hidden > 0 ? h('span', { style: S.footnote }, '+' + hidden + ' more claim(s) not shown') : null,
        h('div', { style: S.actions },
          h('input', {
            type: 'text',
            style: S.noteInput,
            placeholder: 'optional note',
            value: note,
            maxLength: 500,
            'aria-label': 'Optional note recorded with the acceptance',
            onChange: function (event) {
              setNote(str(event && event.target && event.target.value).slice(0, 500));
            },
          }),
          h('button', {
            type: 'button',
            style: accepted || busy ? { ...S.primaryButton, opacity: 0.55, cursor: 'default' } : S.primaryButton,
            disabled: accepted || busy !== null,
            title: accepted ? 'This receipt is already accepted' : 'Accept this receipt as an accurate record',
            onClick: accepted || busy ? undefined : accept,
          }, busy === 'accept' ? 'Accepting…' : (accepted ? 'Accepted' : 'Accept')),
          h('button', {
            type: 'button',
            style: busy ? { ...S.button, opacity: 0.55, cursor: 'default' } : S.button,
            disabled: busy !== null,
            title: 'Re-run safe file checks and record a challenge',
            onClick: busy ? undefined : challenge,
          }, busy === 'challenge' ? 'Challenging…' : 'Challenge')),
        failure !== null ? h('span', { style: S.errorText }, failure) : null,
        accepted && str(receipt.accept_note)
          ? h('span', { style: S.footnote },
            'Accepted by ' + (str(receipt.accepted_by) || 'user') + ': ' + truncate(receipt.accept_note, 300))
          : null,
        checks !== null
          ? h('div', { style: S.checks },
            h('span', { style: S.cardId }, 'challenge checks'),
            checks.length === 0
              ? h('span', { style: S.empty }, 'This challenge proposed no runnable checks.')
              : checks.map(function (check, index) {
                return h(CheckRow, { key: String(index), check: check });
              }))
          : null);
    }

    function StatsStrip(props) {
      var stats = isObject(props.stats) ? props.stats : emptyTotals();
      return h('div', { style: S.statsStrip },
        h('span', { style: S.statCell },
          h('span', { style: S.dot(T.success), 'aria-hidden': true }),
          h('span', null, 'verified'),
          h('span', { style: S.statValue }, String(number(stats.verified, 0)))),
        h('span', { style: S.statCell },
          h('span', { style: S.dot(T.business), 'aria-hidden': true }),
          h('span', null, 'partial'),
          h('span', { style: S.statValue }, String(number(stats.partial, 0)))),
        h('span', { style: S.statCell },
          h('span', { style: S.dot(T.warn), 'aria-hidden': true }),
          h('span', null, 'unverified'),
          h('span', { style: S.statValue }, String(number(stats.unverified, 0)))),
        h('span', { style: S.statCell },
          h('span', { style: S.dot(T.error), 'aria-hidden': true }),
          h('span', null, 'contradicted'),
          h('span', { style: S.statValue }, String(number(stats.contradicted, 0)))));
    }

    function SettingsView(props) {
      var store = props.store;
      var snapshot = useStore(store);
      var receipts = Array.isArray(snapshot.receipts) ? snapshot.receipts : [];
      var latest = receipts.length > 0 ? receipts[0] : null;

      var headerMeta = latest
        ? h('span', { style: S.headerMeta },
          h('span', { style: S.dot(T.idle), 'aria-hidden': true }),
          h('span', null,
            'latest ' + formatTime(latest.created_at)
            + (ageOf(latest.created_at) ? ' · ' + ageOf(latest.created_at) : '')
            + (str(latest.model) ? ' · ' + str(latest.model) : '')))
        : h('span', { style: S.headerMeta }, 'no receipts yet');

      var body;
      if (snapshot.phase === 'loading') {
        body = h('span', { style: S.empty }, 'Loading receipts…');
      } else if (snapshot.phase === 'offline') {
        body = h('div', { style: S.offline },
          h('span', { style: S.offlineTitle }, 'Proofcard host is offline.'),
          h('span', null, 'The page could not reach /proofcard. Check that the Proofcard Host row is enabled, then retry.'),
          snapshot.error ? h('span', { style: S.errorText }, snapshot.error) : null,
          h('button', {
            type: 'button',
            style: S.button,
            onClick: function () { store.refresh(); },
          }, 'Retry'));
      } else if (receipts.length === 0) {
        body = h('div', { style: S.offline },
          h('span', { style: S.offlineTitle }, 'No receipts yet — finish a turn.'),
          h('span', null, 'A receipt is recorded after each completed turn. It never gates or rewrites the turn.'));
      } else {
        body = h('div', { style: S.page },
          receipts.map(function (receipt, index) {
            return h(ReceiptCard, {
              key: str(receipt && receipt.id) || String(index),
              receipt: receipt,
              store: store,
            });
          }));
      }

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('span', { style: S.title }, 'Proofcard'),
          headerMeta,
          h('button', {
            type: 'button',
            style: snapshot.refreshing ? { ...S.button, opacity: 0.55 } : S.button,
            disabled: snapshot.refreshing === true,
            title: 'Refresh receipts now',
            onClick: function () { store.refresh(); },
          }, snapshot.refreshing ? 'Refreshing…' : 'Refresh')),
        h(StatsStrip, { stats: snapshot.stats }),
        h('span', { style: S.footnote },
          'Every completed turn becomes one receipt: the claims made, the evidence behind them, and one click to accept or challenge.'),
        body);
    }

    /* ------------------------------------------------------------------ */
    /* rich surfaces: inline turn card + slide-over drawer                 */
    /* ------------------------------------------------------------------ */

    var PROOFCARD_CSS = [
      '.pc-card{transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease;box-sizing:border-box}',
      '.pc-card:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 1px 0 rgba(0,0,0,.02)}',
      '.pc-btn{transition:background .12s ease,border-color .12s ease,color .12s ease;font:inherit;cursor:pointer}',
      '.pc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pc-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.pc-claim:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pc-drawer{animation:pc-slide .18s ease-out both}',
      '.pc-backdrop{animation:pc-fade .16s ease-out both;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 55%,transparent)}',
      '.pc-grow{animation:pc-grow .22s ease-out both;transform-origin:left center}',
      '@keyframes pc-slide{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}',
      '@keyframes pc-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes pc-grow{from{transform:scaleX(.2);opacity:.4}to{transform:scaleX(1);opacity:1}}',
      '.pc-scroll{scrollbar-width:thin}',
      '.pc-title-mark{flex:none;display:inline-flex;align-items:center;justify-content:center}',
      '.pc-sparkline path{vector-effect:non-scaling-stroke}',
    ].join('\n');

    function PcStyle() {
      return h('style', { key: 'proofcard-css' }, PROOFCARD_CSS);
    }

    function ShieldGlyph(props) {
      var size = (props && props.size) || 16;
      var color = (props && props.color) || T.success;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { flex: 'none' },
      },
        h('path', {
          d: 'M12 2.8l7 2.6v5.3c0 4.4-2.9 8.2-7 9.5-4.1-1.3-7-5.1-7-9.5V5.4l7-2.6z',
          stroke: color, strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8.7 11.9l2.2 2.2 4.4-4.6', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function sealColor(receipt) {
      var counts = verifiableCounts(receipt);
      if (counts.claims === 0) return T.idle;
      if (counts.contradicted > 0) return T.error;
      if (counts.unverified > 0) return T.warn;
      if (counts.partial > 0) return T.business;
      return T.success;
    }

    function trustPct(receipt) {
      var counts = verifiableCounts(receipt);
      if (!counts.claims) return 0;
      return Math.round((100 * counts.verified) / counts.claims);
    }

    function turnNumberOf(turn) {
      if (typeof turn === 'number') return turn;
      if (!turn || typeof turn !== 'object') return null;
      var candidates = [turn.turn, turn.number, turn.index, turn.ordinal, turn.seq];
      for (var index = 0; index < candidates.length; index += 1) {
        if (typeof candidates[index] === 'number') return candidates[index];
      }
      return null;
    }

    function findReceiptForTurn(receipts, sessionId, turn) {
      var number = turnNumberOf(turn);
      var eligible = (receipts || []).filter(function (receipt) {
        return receipt && (sessionId === undefined || sessionId === null || receipt.session_id === sessionId);
      });
      if (eligible.length === 0) return null;
      if (number !== null) {
        for (var index = 0; index < eligible.length; index += 1) {
          if (Number(eligible[index].turn) === Number(number)) return eligible[index];
        }
        return null;
      }
      return eligible[0] || null;
    }

    function VerdictRing(props) {
      var receipt = props.receipt;
      var size = props.size || 54;
      var counts = verifiableCounts(receipt);
      var pct = trustPct(receipt);
      var stroke = Math.max(4, Math.round(size / 11));
      var radius = (size - stroke) / 2;
      var circumference = 2 * Math.PI * radius;
      var color = counts.claims === 0 ? T.idle : sealColor(receipt);
      var center = size / 2;
      var centerText = counts.claims === 0 ? '—' : counts.verified + '/' + counts.claims;
      return h('div', {
        style: { position: 'relative', width: size, height: size, flex: 'none' },
        title: counts.claims === 0
          ? 'Narrative only — nothing checkable to verify'
          : pct + '% of checkable claims verified (' + counts.verified + ' of ' + counts.claims + ')',
        'aria-label': counts.claims === 0 ? 'no checkable claims' : counts.verified + ' of ' + counts.claims + ' verified',
      },
        h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': true },
          h('circle', { cx: center, cy: center, r: radius, fill: 'none', stroke: T.borderL1, strokeWidth: stroke }),
          h('circle', {
            cx: center, cy: center, r: radius, fill: 'none', stroke: color, strokeWidth: stroke,
            strokeLinecap: 'round', strokeDasharray: circumference,
            strokeDashoffset: circumference * (1 - (counts.claims ? pct / 100 : 0)),
            transform: 'rotate(-90 ' + center + ' ' + center + ')',
            style: { transition: 'stroke-dashoffset .35s ease' },
          })),
        h('span', {
          style: {
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: Math.max(9, Math.round(size / 4.6)),
            fontWeight: 650, color: T.label, letterSpacing: '-0.02em',
          },
        }, centerText));
    }

    function VerdictBar(props) {
      var receipt = props.receipt;
      var counts = verifiableCounts(receipt);
      if (counts.claims === 0) {
        var narrative = narrativeCount(receipt);
        return h('div', {
          style: {
            display: 'flex', alignItems: 'center', height: 7, width: '100%',
            borderRadius: 999, background: T.bgLayer1, border: '1px solid ' + T.borderL1,
            boxSizing: 'border-box', paddingLeft: 6,
          },
          title: narrative > 0 ? 'Narrative only — no checkable claims' : 'No checkable claims',
        },
          h('span', { style: { fontSize: 9, color: T.tertiary } }, narrative > 0 ? 'narrative' : 'no checkable claims'));
      }
      var total = counts.claims;
      var parts = [
        ['verified', counts.verified], ['partial', counts.partial],
        ['unverified', counts.unverified], ['contradicted', counts.contradicted],
      ];
      return h('div', {
        style: {
          display: 'flex', height: 7, width: '100%', borderRadius: 999, overflow: 'hidden',
          background: T.bgLayer1, border: '1px solid ' + T.borderL1, boxSizing: 'border-box',
        },
        title: parts.filter(function (part) { return part[1] > 0; })
          .map(function (part) { return part[1] + ' ' + part[0]; }).join(' · '),
      },
        parts.map(function (part) {
          if (!part[1]) return null;
          return h('span', {
            key: part[0],
            className: 'pc-grow',
            style: {
              width: (100 * part[1]) / (total || 1) + '%', background: VERDICT_COLOR[part[0]],
              transition: 'width .3s ease',
            },
            title: part[1] + ' ' + part[0],
          });
        }));
    }

    function Sparkline(props) {
      var receipts = (props.receipts || []).slice(0, 10).reverse();
      if (receipts.length < 2) return null;
      var width = 120;
      var height = 26;
      var points = receipts.map(function (receipt, index) {
        var x = (width * index) / (receipts.length - 1);
        var y = height - 2 - ((height - 4) * trustPct(receipt)) / 100;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return h('svg', {
        width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
        className: 'pc-sparkline', 'aria-hidden': true,
        style: { flex: 'none', overflow: 'visible' },
      },
        h('polyline', { points: points, fill: 'none', stroke: T.success, strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round', opacity: 0.85 }),
        h('polyline', { points: '0,' + height + ' ' + points + ' ' + width + ',' + height, fill: T.success, opacity: 0.08, stroke: 'none' }));
    }

    function VerdictChip(props) {
      var verdict = props.verdict;
      var count = props.count;
      if (!count) return null;
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
          fontSize: 11, lineHeight: '18px', padding: '0 7px', borderRadius: 999,
          color: VERDICT_COLOR[verdict] || T.secondary,
          background: 'color-mix(in srgb, ' + (VERDICT_COLOR[verdict] || T.secondary) + ' 10%, transparent)',
        },
      },
        h('span', { style: S.dot(VERDICT_COLOR[verdict] || T.secondary), 'aria-hidden': true }),
        String(count) + ' ' + (VERDICT_LABEL[verdict] || verdict));
    }

    function RichClaimRow(props) {
      var claim = props.claim || {};
      var expandedState = React.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
      var color = VERDICT_COLOR[claim.verdict] || T.secondary;
      return h('div', { style: { borderTop: '1px solid ' + T.borderL1 } },
        h('button', {
          type: 'button',
          className: 'pc-claim pc-btn',
          onClick: function () { setExpanded(!expanded); },
          'aria-expanded': expanded,
          style: {
            width: '100%', display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '8px 4px', background: 'transparent', border: 'none',
            textAlign: 'left', color: T.label, borderRadius: 6,
          },
        },
          h('span', { style: { ...S.dot(color), marginTop: 6 } }),
          h('span', { style: { flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '19px' } },
            h('span', { style: { color: T.tertiary, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em', marginRight: 6 } }, claim.source === 'tool' ? 'tool evidence' : String(claim.kind || 'claim').replace(/_/g, ' ')),
            h('span', null, str(claim.text) || '(no text)')),
          evidence.length > 0
            ? h('span', { style: { ...S.chipNeutral, flex: 'none' }, title: evidence.length + ' evidence item(s)' }, String(evidence.length))
            : null,
          h('span', { style: { color: T.tertiary, flex: 'none', fontSize: 11, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }, 'aria-hidden': true }, '›')),
        expanded
          ? h('div', { style: { padding: '0 4px 10px 22px', display: 'flex', flexDirection: 'column', gap: 6 } },
            claim.note ? h('div', { style: { color: T.secondary, fontSize: 12 } }, claim.note) : null,
            evidence.map(function (item, index) {
              return h('div', {
                key: str(item && item.id) || String(index),
                style: {
                  border: '1px solid ' + T.borderL1, borderRadius: 8, padding: '7px 9px',
                  background: T.bgBase, display: 'flex', flexDirection: 'column', gap: 3,
                },
              },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { ...S.cardId, maxWidth: 180 } }, str(item.id) || 'evidence'),
                  h('span', { style: { color: T.secondary, fontSize: 11.5 } }, str(item.what))),
                item.excerpt
                  ? h('div', { style: { fontFamily: MONO, fontSize: 11, lineHeight: '15px', color: T.tertiary, overflowWrap: 'anywhere' } }, str(item.excerpt))
                  : null);
            }))
          : null);
    }

    function acceptReceipt(store, receipt, note) {
      return postJson(API_ACTIONS + '/receipts/' + encodeURIComponent(receipt.id) + '/accept', { note: note || '' })
        .then(function () { store.notify('Receipt accepted.'); return store.refresh(); });
    }

    function challengeReceipt(store, receipt, claimId) {
      var body = { run: true };
      if (claimId) body.claim_id = claimId;
      return postJson(API_ACTIONS + '/receipts/' + encodeURIComponent(receipt.id) + '/challenge', body);
    }

    function repairRequest(receipt, challengeResult) {
      var claims = (receipt.claims || []).filter(function (claim) {
        return claim.verdict === 'contradicted';
      });
      var lines = [
        'Proofcard challenge for receipt ' + receipt.id + (claims.length > 0
          ? ' found claims that are not backed by the recorded evidence.'
          : ' found checks that failed against the current workspace.'),
        '',
      ];
      claims.forEach(function (claim) {
        lines.push('- [' + claim.verdict + '] "' + str(claim.text) + '"' + (claim.note ? ' — ' + claim.note : ''));
      });
      var failedChecks = ((challengeResult && challengeResult.checks) || []).filter(function (check) {
        return check.ok === false;
      });
      if (failedChecks.length) {
        lines.push('', 'Checks that failed:');
        failedChecks.forEach(function (check) {
          lines.push('- ' + str(check.label) + (check.detail ? ' — ' + str(check.detail) : ''));
        });
      }
      lines.push('', 'Please fix the work so these claims become true and re-run the checks, or retract/correct the claims explicitly. Show the command or path evidence for anything you re-claim.');
      return lines.join('\n');
    }

    function RichReceiptCard(props) {
      var receipt = props.receipt;
      var store = props.store;
      var compact = props.compact === true;
      var busyState = React.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var failureState = React.useState(null);
      var failure = failureState[0];
      var setFailure = failureState[1];
      var challengeState = React.useState(null);
      var challengeResult = challengeState[0];
      var setChallengeResult = challengeState[1];
      var counts = verifiableCounts(receipt);
      var allCounts = receiptCounts(receipt);
      var narrative = narrativeCount(receipt);
      var claims = (receipt.claims || []).slice(0, compact ? 3 : 30);
      var unproven = counts.unverified + counts.contradicted;

      function accept() {
        setBusy('accept');
        setFailure(null);
        acceptReceipt(store, receipt).catch(function (error) {
          setFailure(messageOf(error));
        }).then(function () { setBusy(null); });
      }

      function challenge() {
        setBusy('challenge');
        setFailure(null);
        challengeReceipt(store, receipt).then(function (result) {
          setChallengeResult(result);
          var checks = (result && result.checks) || [];
          if (checks.length === 0) store.notify('Challenge recorded — these claims need manual review; no automatic checks apply.');
          return store.refresh();
        }).catch(function (error) {
          setFailure(messageOf(error));
        }).then(function () { setBusy(null); });
      }

      if (allCounts.claims === 0 || (props.slimNarrative === true && counts.claims === 0)) {
        var slimText = allCounts.claims === 0
          ? 'No checkable claims'
          : (narrative > 0 ? 'Narrative only · ' + narrative + ' assertion' + (narrative === 1 ? '' : 's') : 'No checkable claims');
        return h('div', {
          className: 'pc-card',
          style: {
            border: '1px solid ' + T.borderL1,
            borderLeft: '3px solid ' + T.idle,
            background: T.cardFill,
            borderRadius: 10,
            padding: '7px 10px',
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
          },
        },
          h(ShieldGlyph, { size: 14, color: T.idle }),
          h('span', { style: { color: T.label, fontWeight: 600, fontSize: 12 } }, 'Proofcard'),
          h('span', { style: { color: T.tertiary, fontSize: 11 } }, formatTime(receipt.created_at)),
          h('span', { style: { flex: 1, minWidth: 0, color: T.secondary, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            slimText + (receipt.evidence_count ? ' · ' + receipt.evidence_count + ' evidence' : '')),
          receipt.accepted ? h('span', { style: { color: T.success, fontSize: 11 } }, 'reviewed') : null,
          h('button', {
            type: 'button', className: 'pc-btn',
            style: { ...S.button, padding: '2px 8px' },
            onClick: function () { store.openDrawer(receipt.id); },
          }, 'Details'));
      }

      return h('div', {
        className: 'pc-card',
        style: {
          border: '1px solid ' + (receipt.accepted ? T.borderL1 : sealColor(receipt) + '55'),
          borderLeft: '3px solid ' + sealColor(receipt),
          background: T.cardFill,
          borderRadius: 12,
          display: 'flex', flexDirection: 'column', minWidth: 0,
          overflow: 'hidden',
        },
      },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', padding: compact ? '9px 10px 8px' : '12px 12px 10px', minWidth: 0 } },
          h(VerdictRing, { receipt: receipt, size: compact ? 38 : 52 }),
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h(ShieldGlyph, { size: compact ? 13 : 15, color: sealColor(receipt) }),
              h('span', { style: { color: T.label, fontWeight: 600, fontSize: compact ? 12.5 : 13.5 } }, 'Proofcard'),
              h('span', { style: { color: T.tertiary, fontSize: 11 } }, formatTime(receipt.created_at)),
              receipt.accepted ? h('span', { style: { ...S.chipNeutral, color: T.success, borderColor: T.success } }, 'accepted') : null),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h(VerdictChip, { verdict: 'verified', count: counts.verified }),
              h(VerdictChip, { verdict: 'partial', count: counts.partial }),
              h(VerdictChip, { verdict: 'unverified', count: counts.unverified }),
              h(VerdictChip, { verdict: 'contradicted', count: counts.contradicted }),
              narrative > 0
                ? h('span', {
                  style: { ...S.chipNeutral, color: T.tertiary },
                  title: 'Narrative assertions are not counted in the trust metric',
                }, narrative + ' narrative')
                : null,
              allCounts.claims === 0 ? h('span', { style: { color: T.tertiary, fontSize: 11 } }, 'no claims') : null)),
          compact
            ? h('button', {
              type: 'button', className: 'pc-btn',
              style: { ...S.button, padding: '3px 8px', flex: 'none' },
              onClick: function () { store.openDrawer(receipt.id); },
              title: 'Open the full receipt drawer',
            }, 'Details')
            : null),
        h('div', { style: { padding: compact ? '0 10px 8px' : '0 12px 10px' } }, h(VerdictBar, { receipt: receipt })),
        claims.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
            claims.map(function (claim, index) {
              return h(RichClaimRow, { key: str(claim.id) || String(index), claim: claim });
            }))
          : h('div', { style: { padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 2 } },
            h('span', { style: { color: T.secondary, fontSize: 12 } }, 'No checkable claims recorded for this turn.'),
            h('span', { style: { color: T.tertiary, fontSize: 11 } },
              String(receipt.evidence_count || 0) + ' evidence · '
              + String((receipt.tools_used || []).length) + ' tools'
              + (narrative > 0 ? ' · ' + narrative + ' narrative' : ''))),
        compact
          ? null
          : h('div', { style: { borderTop: '1px solid ' + T.borderL1, padding: '9px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { color: T.tertiary, fontSize: 11, flex: 1, minWidth: 120 } },
              String(receipt.evidence_count || 0) + ' evidence · ' + String((receipt.tools_used || []).length) + ' tools'
              + (receipt.accepted ? ' · accepted' : '')),
            h('button', {
              type: 'button', className: 'pc-btn', style: S.button,
              disabled: busy === 'accept' || receipt.accepted,
              title: 'Mark this receipt as reviewed. It leaves the unproven count and is recorded as accepted.',
              onClick: accept,
            }, receipt.accepted ? 'Reviewed' : (busy === 'accept' ? 'Marking…' : 'Mark reviewed')),
            allCounts.claims > 0
              ? h('button', {
                type: 'button', className: 'pc-btn',
                style: S.primaryButton, disabled: busy === 'challenge',
                onClick: challenge,
              }, busy === 'challenge' ? 'Challenging…' : 'Challenge' + (unproven > 0 ? ' ' + unproven : ''))
              : null,
            h('button', {
              type: 'button', className: 'pc-btn', style: S.button,
              onClick: function () { store.openDrawer(receipt.id); },
            }, 'Details')),
        compact && allCounts.claims > 0
          ? h('div', { style: { padding: '0 10px 9px', display: 'flex', gap: 8 } },
            h('button', {
              type: 'button', className: 'pc-btn', style: { ...S.primaryButton, padding: '3px 9px' },
              disabled: busy === 'challenge', onClick: challenge,
            }, busy === 'challenge' ? 'Challenging…' : 'Challenge'),
            h('button', {
              type: 'button', className: 'pc-btn', style: { ...S.button, padding: '3px 9px' },
              disabled: busy === 'accept' || receipt.accepted,
              title: 'Mark this receipt as reviewed. It leaves the unproven count and is recorded as accepted.',
              onClick: accept,
            }, receipt.accepted ? 'Reviewed' : (busy === 'accept' ? 'Marking…' : 'Mark reviewed')))
          : null,
        challengeResult
          ? (function () {
            var checks = challengeResult.checks || [];
            var proposed = challengeResult.proposed || [];
            return h('div', { style: { padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 } },
              checks.map(function (check, index) {
                return h('div', { key: String(index), style: { fontSize: 11.5, color: check.ok === false ? T.error : T.secondary } },
                  (check.ok === true ? '✓ ' : check.ok === false ? '✗ ' : '· ') + str(check.label) + (check.detail ? ' — ' + str(check.detail) : ''));
              }),
              checks.length === 0
                ? h('div', { style: { color: T.secondary, fontSize: 11.5 } },
                  'Challenge recorded. ' + (proposed.length > 0
                    ? 'These claims need manual review; none of the proposed checks can run automatically.'
                    : 'These are narrative claims — there is no automatic check to run. Use the evidence above or ask the agent to make a concrete, checkable claim.'))
                : null,
              proposed.length > 0
                ? h('div', { style: { color: T.tertiary, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 } },
                  proposed.slice(0, 4).map(function (check, index) {
                    return h('div', { key: String(index) }, '· ' + str(check.label));
                  }))
                : null,
              (function () {
                var badClaims = (receipt.claims || []).some(function (claim) {
                  return claim.verdict === 'contradicted';
                });
                var badChecks = checks.some(function (check) { return check.ok === false; });
                if (!badClaims && !badChecks) return null;
                return h('button', {
                  type: 'button',
                  className: 'pc-btn',
                  style: { ...S.primaryButton, alignSelf: 'flex-start' },
                  onClick: function () {
                    var ok = store.insertIntoComposer(repairRequest(receipt, challengeResult));
                    store.notify(ok
                      ? 'Repair request inserted into the composer — press Send.'
                      : 'Could not reach the composer; open Settings → Proofcard and copy the challenge notes.');
                  },
                }, 'Ask agent to fix');
              })());
          })()
          : null,
        failure ? h('div', { style: { padding: '0 12px 10px', color: T.error, fontSize: 11.5 } }, failure) : null);
    }

    function TurnTailCard(props) {
      var store = props.store;
      var snapshot = useStore(store);
      React.useEffect(function () {
        store.setSession(props.sessionId);
      }, [props.sessionId]);
      React.useEffect(function () {
        var actions = props.inputActions;
        if (!actions || typeof actions.insertText !== 'function') return undefined;
        store.setComposerBridge(function (text) {
          try {
            var span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined;
            return actions.insertText(text, span) !== false;
          } catch (failure) { return false; }
        });
        return function () { store.setComposerBridge(null); };
      }, [props.inputActions, store]);
      var receipt = findReceiptForTurn(snapshot.receipts, props.sessionId, props.turn);
      if (!receipt) return null;
      return h('div', { style: { padding: '2px 0 6px' } },
        h(PcStyle),
        h(RichReceiptCard, { receipt: receipt, store: store, compact: true }));
    }

    function ProofcardHeaderAction(props) {
      var store = props.store;
      return h('button', {
        type: 'button',
        className: 'pc-btn',
        title: 'Open Proofcard receipts for this session',
        onClick: function () { store.setSession(props.sessionId); store.openDrawer(null); },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          font: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer',
          padding: '3px 9px', borderRadius: 999,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        },
      },
        h(ShieldGlyph, { size: 13, color: T.success }),
        'Proofcard');
    }

    function DrawerHost(props) {
      var store = props.store;
      var snapshot = useStore(store);
      var sessionId = props.sessionId || (typeof store.getSession === 'function' ? store.getSession() : null);
      var bodyState = React.useState(null);
      var selectedId = bodyState[0];
      var setSelectedId = bodyState[1];
      var escEffect = React.useEffect(function () {
        if (!snapshot.drawerOpen) return undefined;
        function onKey(event) {
          if (event && event.key === 'Escape') store.closeDrawer();
        }
        try { document.addEventListener('keydown', onKey); } catch (failure) { /* ignore */ }
        return function () {
          try { document.removeEventListener('keydown', onKey); } catch (failure) { /* ignore */ }
        };
      }, [snapshot.drawerOpen, store]);

      if (!snapshot.drawerOpen) return null;
      var receipts = (snapshot.receipts || []).filter(function (receipt) {
        if (snapshot.filter === 'all' || !sessionId) return true;
        return receipt.session_id === sessionId;
      });
      var selected = null;
      var wanted = selectedId || snapshot.drawerReceiptId;
      if (wanted) {
        for (var index = 0; index < receipts.length; index += 1) {
          if (receipts[index].id === wanted) { selected = receipts[index]; break; }
        }
      }
      if (!selected) selected = receipts[0] || null;
      var totals = totalsFromReceipts(receipts);

      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 60 } },
        h(PcStyle),
        h('div', {
          className: 'pc-backdrop',
          onClick: function () { store.closeDrawer(); },
          style: { position: 'absolute', inset: 0 },
        }),
        h('aside', {
          className: 'pc-drawer',
          role: 'dialog',
          'aria-label': 'Proofcard receipts',
          style: {
            position: 'absolute', top: 0, right: 0, bottom: 0,
            width: 'min(440px, 94vw)', background: T.bgBase,
            borderLeft: '1px solid ' + T.borderL2,
            boxShadow: '-18px 0 40px rgba(0,0,0,.18)',
            display: 'flex', flexDirection: 'column', minHeight: 0,
          },
        },
          h('header', { style: { display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px 10px' } },
            h(ShieldGlyph, { size: 20, color: sealColor(selected) }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 15, fontWeight: 650, color: T.label } }, 'Proofcard'),
              h('div', { style: { fontSize: 11.5, color: T.tertiary } },
                receipts.length + ' receipt' + (receipts.length === 1 ? '' : 's') + ' · '
                + (snapshot.phase === 'offline' ? 'bridge offline' : 'live · ' + totals.verified + '/' + totals.claims + ' claims verified'))),
            h(Sparkline, { receipts: receipts }),
            h('button', {
              type: 'button', className: 'pc-btn', 'aria-label': 'Close Proofcard',
              style: { ...S.button, padding: '3px 9px' }, onClick: function () { store.closeDrawer(); },
            }, '✕')),
          h('div', { style: { display: 'flex', gap: 6, padding: '0 16px 10px' } },
            h('button', {
              type: 'button', className: 'pc-btn',
              style: snapshot.filter === 'session' ? S.primaryButton : S.button,
              onClick: function () { store.setFilter('session'); },
            }, 'This session'),
            h('button', {
              type: 'button', className: 'pc-btn',
              style: snapshot.filter === 'all' ? S.primaryButton : S.button,
              onClick: function () { store.setFilter('all'); },
            }, 'All receipts'),
            h('button', {
              type: 'button', className: 'pc-btn', style: { ...S.button, marginLeft: 'auto' },
              disabled: snapshot.refreshing, onClick: function () { store.refresh(); },
            }, snapshot.refreshing ? 'Refreshing…' : 'Refresh')),
          h('div', {
            className: 'pc-scroll',
            style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 18px', display: 'flex', flexDirection: 'column', gap: 10 },
          },
            receipts.length === 0
              ? h('div', { style: { ...S.card, alignItems: 'center', padding: 28, gap: 8 } },
                h(ShieldGlyph, { size: 38, color: T.idle }),
                h('span', { style: { color: T.label, fontWeight: 600 } }, 'No receipts yet'),
                h('span', { style: { color: T.secondary, fontSize: 12, textAlign: 'center' } },
                  'Finish a turn and Proofcard will record the claims it made, the evidence behind them, and what you can re-check.'))
              : receipts.slice(0, 30).map(function (receipt, index) {
                return h(RichReceiptCard, {
                  key: str(receipt.id) || String(index),
                  receipt: receipt,
                  store: store,
                  compact: false,
                  slimNarrative: true,
                });
              })),
          h('footer', { style: { borderTop: '1px solid ' + T.borderL1, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { flex: 1, color: T.tertiary, fontSize: 11 } },
              'Observe-only. Local ledger. No model calls.'),
            h('button', {
              type: 'button', className: 'pc-btn', style: S.linkButton,
              onClick: function () { store.closeDrawer(); },
            }, 'Close'))));
    }

    /* ------------------------------------------------------------------ */
    /* plugin registration                                                 */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        var store = createStore(ctx);
        /* Hook-owning function components (the slot's props plus our store/ctx). The
         * inline try/catch keeps a bad receipt payload from blanking the host slot. */
        function ProofcardDock(props) {
          try {
            return DockView(Object.assign({}, props, { store: store, ctx: ctx }));
          } catch (error) {
            try { console.warn('Proofcard: composer dock render failed', error); } catch (failure) { /* ignore */ }
            return h('span', { style: S.offlineTitle }, 'Proofcard UI unavailable');
          }
        }
        function ProofcardSettings(props) {
          try {
            return SettingsView(Object.assign({}, props, { store: store, ctx: ctx, close: props && props.close }));
          } catch (error) {
            try { console.warn('Proofcard: settings render failed', error); } catch (failure) { /* ignore */ }
            return h('span', { style: S.offlineTitle }, 'Proofcard UI unavailable');
          }
        }

        /* Resources owned by the plugin fiber: the poll timer and the store. */
        try {
          if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(function () {
              store.start();
              return function () { store.dispose(); };
            });
          } else {
            store.start();
            if (ctx && typeof ctx.onDispose === 'function') {
              ctx.onDispose(function () { store.dispose(); });
            }
          }
        } catch (failure) {
          /* polling is best-effort; never fail plugin activation over it */
          try { store.dispose(); } catch (ignored) { /* ignore */ }
        }

        try {
          ctx.slots.inject('conversation.composer.dock', function () {
            return ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'proofcard-dock',
              order: 20,
            }, ProofcardDock);
          });
        } catch (failure) {
          /* the slot is absent in some compositions; the settings pane still works */
        }

        try {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'proofcard',
              order: 40,
              label: 'Proofcard',
            }, ProofcardSettings);
          });
        } catch (failure) {
          /* the settings shell is absent in headless compositions */
        }

        /* Inline receipt card after every completed turn — the primary surface. */
        function ProofcardTurnTail(props) {
          try {
            return TurnTailCard(Object.assign({}, props, { store: store }));
          } catch (error) {
            try { console.warn('Proofcard: turn card render failed', error); } catch (failure) { /* ignore */ }
            return null;
          }
        }
        try {
          ctx.slots.inject('conversation.chat.turnTail', function () {
            return ctx.slots.register({
              name: 'conversation.chat.turnTail',
              id: 'proofcard-turn',
              order: 30,
            }, ProofcardTurnTail);
          });
        } catch (failure) {
          /* chat composition absent */
        }

        /* Always-visible entry point in the session header. */
        try {
          ctx.slots.inject('conversation.session.header.actions', function () {
            return ctx.slots.register({
              name: 'conversation.session.header.actions',
              id: 'proofcard-header',
              order: 30,
            }, function (props) {
              return h(ProofcardHeaderAction, Object.assign({}, props, { store: store }));
            });
          });
        } catch (failure) {
          /* header composition absent */
        }

        /* Slide-over details drawer, reachable from the pill, header action and cards. */
        function ProofcardDrawerHost(props) {
          try {
            return DrawerHost(Object.assign({}, props, { store: store }));
          } catch (error) {
            try { console.warn('Proofcard: drawer render failed', error); } catch (failure) { /* ignore */ }
            return null;
          }
        }
        try {
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({
              name: 'shell.overlay',
              id: 'proofcard-drawer',
              order: 70,
            }, ProofcardDrawerHost);
          });
        } catch (failure) {
          /* overlay layer absent */
        }

        registerPalette(ctx, store);

        return function () {
          try { store.dispose(); } catch (failure) { /* ignore */ }
        };
      },
    };
  },
});
