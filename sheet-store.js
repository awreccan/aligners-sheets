/*
 * sheet-store.js — Google-Sheets data layer for "22" (v3), KIT model.
 *
 * The DEV hosts ONE stateless relay (backend/Code.gs, deployed once). The USER
 * only pastes their own plain Google Sheet URL. This layer talks to the dev's
 * relay and forwards the user's Sheet URL as ?sheet_url=… on every request, so
 * the relay opens THAT user's Sheet (openByUrl) and reads/writes their log there.
 * No per-user Apps Script, no /exec for the user — just a Sheet link.
 *
 * The PWA stores on-device: the dev relay URL (baked-in default) + the user's
 * own Sheet URL. It GETs the state ({log,v}) and POSTs the merged event log.
 *
 * Two CORS gotchas baked in (proven by keep-in-touch):
 *   1. POST sends a text/plain body (no custom Content-Type header) so the
 *      browser issues NO CORS preflight — Apps Script can't answer OPTIONS.
 *   2. GET on /exec 302-redirects to script.googleusercontent.com; a non-JSON
 *      body (login/error HTML) is surfaced as a clear error, not an opaque
 *      SyntaxError.
 *
 * Reads are ALWAYS cache-busted (mirrors the gist-store contract).
 *
 * Universal module: CommonJS (Node/tests) + browser global (window.SheetStore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SheetStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  // Allow tests to inject a fetch + a deterministic cache-buster.
  function makeStore(opts) {
    opts = opts || {};
    const _fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const cacheBuster = opts.cacheBuster ||
      (() => String(Date.now()) + '-' + Math.round((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0));
    if (!_fetch) throw new Error('sheet-store: no fetch available');

    let relayUrl = opts.relayUrl || null;   // the DEV's relay /exec URL (baked-in)
    let sheetUrl = opts.sheetUrl || null;   // the USER's own Google Sheet URL

    function setCredentials(relay, sheet) {
      relayUrl = relay || relayUrl;         // relay rarely changes (dev default)
      sheetUrl = sheet || null;
    }
    // Configured = we have both the dev relay AND the user's Sheet URL.
    function isConfigured() { return !!relayUrl && !!sheetUrl; }

    function emptyState() { return { log: [], v: SCHEMA_VERSION }; }

    function normalizeState(data) {
      if (!data || typeof data !== 'object') return emptyState();
      return { log: Array.isArray(data.log) ? data.log : [], v: data.v || SCHEMA_VERSION };
    }

    // Build the relay endpoint: <relay>?sheet_url=…&cb=… (cb on reads only).
    function endpoint(withCacheBust) {
      if (!relayUrl) throw new Error('sheet-store: not configured (no relay URL)');
      if (!sheetUrl) throw new Error('sheet-store: not configured (no Sheet URL)');
      const u = new URL(relayUrl);
      u.searchParams.set('sheet_url', sheetUrl);
      if (withCacheBust) u.searchParams.set('cb', cacheBuster());
      return u.toString();
    }

    // Map backend error codes into clear, actionable user-facing messages.
    function messageForError(code, detail) {
      switch (code) {
        case 'no-sheet': return 'Paste your Google Sheet link first.';
        case 'bad-sheet-url': return 'That Sheet link didn’t open. Copy the full URL from your Sheet’s address bar.';
        case 'no-access': return 'The relay can’t open that Sheet. In the Sheet: Share → General access → “Anyone with the link” → Editor.';
        default: return detail || code || 'Sheet request failed.';
      }
    }

    // HARD TIMEOUT: without it a hung relay fetch never settles, so the caller's
    // busy/pushing guard never clears and the toggle button dies permanently.
    async function fetchJson(url, init) {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
      let res;
      try {
        res = await _fetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('Sheet request timed out (no response in 15s).');
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch (_) {
        throw new Error(res.ok
          ? 'The relay returned a non-JSON response (the web-app access may not be set to “Anyone”).'
          : 'Sheet request failed (HTTP ' + res.status + ').');
      }
      if (data && data.error) throw new Error(messageForError(data.error, data.detail));
      return data;
    }

    // Read the event log (cache-busted). Returns {state:{log,v}}.
    async function read() {
      const data = await fetchJson(endpoint(true), { method: 'GET', cache: 'no-store' });
      return { state: normalizeState(data) };
    }

    // Append/replace the event log. The relay dedupes by id and persists the
    // union, so sending the full local log is safe (idempotent). text/plain body
    // (NO Content-Type header) keeps the browser from issuing a CORS preflight.
    async function appendLog(newLog) {
      if (!isConfigured()) throw new Error('sheet-store: not configured');
      const body = JSON.stringify({
        sheet_url: sheetUrl,           // also in body so POST works even if the
        log: Array.isArray(newLog) ? newLog : [], v: SCHEMA_VERSION,   // query is stripped
      });
      const data = await fetchJson(endpoint(false), { method: 'POST', body });
      if (data && Array.isArray(data.log)) return normalizeState(data);
      return { log: Array.isArray(newLog) ? newLog : [], v: SCHEMA_VERSION };
    }

    // Verify the user's Sheet is reachable + returns parseable state. {ok,count}.
    async function validate() {
      try {
        const { state } = await read();
        return { ok: true, count: state.log.length };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    return {
      SCHEMA_VERSION,
      setCredentials, isConfigured, emptyState, normalizeState,
      read, appendLog, validate,
      get relayUrl() { return relayUrl; },
      get sheetUrl() { return sheetUrl; },
    };
  }

  return { makeStore, SCHEMA_VERSION };
}));
