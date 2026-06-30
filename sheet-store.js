/*
 * sheet-store.js — Google-Sheets data layer for "22" (v3).
 *
 * The shared event log lives in a single Google Sheet. An Apps Script Web App
 * (backend/Code.gs), deployed "Execute as: Me" / "Who has access: Anyone",
 * exposes that Sheet as a CORS-open JSON API via ContentService. Both the PWA
 * (browser fetch) and an iOS Shortcut read/write it through that one /exec URL.
 * No custom server, no DB host — the Sheet IS the database, human-editable.
 *
 * The PWA stores ONLY the /exec URL (the unguessable secret) on-device. It GETs
 * the state ({log, v}) and POSTs the merged event log back.
 *
 * Two CORS gotchas this layer bakes in (proven by keep-in-touch):
 *   1. POST sends a text/plain body (no custom Content-Type header) so the
 *      browser issues NO CORS preflight — Apps Script web apps cannot answer
 *      an OPTIONS preflight, so any application/json POST would be blocked.
 *   2. GET on /exec 302-redirects to script.googleusercontent.com; if the
 *      browser isn't signed into the right Google account the redirected body
 *      is login/error HTML, and a bare res.json() throws an opaque SyntaxError.
 *      We read .text() and JSON.parse it ourselves, surfacing a clear message.
 *
 * Apps Script caches nothing aggressively, but intermediaries can — so we
 * ALWAYS cache-bust reads (mirrors the gist-store contract).
 *
 * Universal module: CommonJS (Node/tests) + browser global (window.SheetStore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SheetStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const PROJECT = 'aligners';   // single project tab; multi-project isn't needed

  // Allow tests to inject a fetch + a deterministic cache-buster.
  function makeStore(opts) {
    opts = opts || {};
    const _fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    // cacheBuster() must return a changing value; tests pass a counter.
    const cacheBuster = opts.cacheBuster ||
      (() => String(Date.now()) + '-' + Math.round((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0));
    if (!_fetch) throw new Error('sheet-store: no fetch available');

    let execUrl = opts.execUrl || null;   // the Apps Script /exec URL (the secret)
    let token = opts.token || null;        // optional SHARED_TOKEN

    function setCredentials(url, tok) { execUrl = url || null; token = tok || null; }
    function isConfigured() { return !!execUrl; }

    function emptyState() { return { log: [], v: SCHEMA_VERSION }; }

    // Coerce any backend response into the canonical {log, v} shape.
    function normalizeState(data) {
      if (!data || typeof data !== 'object') return emptyState();
      return { log: Array.isArray(data.log) ? data.log : [], v: data.v || SCHEMA_VERSION };
    }

    // Build the endpoint URL: ?project=…&token=…&cb=… (cb on reads only).
    function endpoint(withCacheBust) {
      if (!execUrl) throw new Error('sheet-store: not configured (no /exec URL)');
      const u = new URL(execUrl);
      u.searchParams.set('project', PROJECT);
      if (token) u.searchParams.set('token', token);
      if (withCacheBust) u.searchParams.set('cb', cacheBuster());
      return u.toString();
    }

    // Fetch JSON, guarding the /exec redirect-to-HTML case. A non-JSON body
    // (login/error HTML) becomes a clear, actionable error instead of an opaque
    // SyntaxError that callers swallow into "connected but no data".
    async function fetchJson(url, init) {
      const res = await _fetch(url, init);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch (_) {
        throw new Error(res.ok
          ? 'The Google Sheet returned a non-JSON response. On mobile this usually means this browser isn’t signed into the Google account that owns the script, or the web-app access isn’t set to “Anyone”.'
          : 'Google Sheet request failed (HTTP ' + res.status + ').');
      }
      if (data && data.error) throw new Error(data.error);   // backend {error:"unauthorized"} etc.
      return data;
    }

    // Read the event log (cache-busted). Returns {state:{log,v}}.
    async function read() {
      const data = await fetchJson(endpoint(true), { method: 'GET', cache: 'no-store' });
      return { state: normalizeState(data) };
    }

    // Append/replace the event log. The backend dedupes by id and persists the
    // union, so sending the full local log is safe (idempotent). text/plain body
    // (NO Content-Type header) keeps the browser from issuing a CORS preflight.
    // Returns the persisted {log, v}.
    async function appendLog(newLog) {
      if (!execUrl) throw new Error('sheet-store: not configured (no /exec URL)');
      const body = JSON.stringify({ log: Array.isArray(newLog) ? newLog : [], v: SCHEMA_VERSION });
      const data = await fetchJson(endpoint(false), { method: 'POST', body });
      // Backend echoes the persisted state ({log,v}); fall back to what we sent.
      if (data && Array.isArray(data.log)) return normalizeState(data);
      return { log: Array.isArray(newLog) ? newLog : [], v: SCHEMA_VERSION };
    }

    // Verify the URL is reachable + returns parseable state. Returns {ok, count}.
    async function validateUrl() {
      try {
        const { state } = await read();
        return { ok: true, count: state.log.length };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    return {
      SCHEMA_VERSION, PROJECT,
      setCredentials, isConfigured, emptyState, normalizeState,
      read, appendLog, validateUrl,
      get execUrl() { return execUrl; },
    };
  }

  return { makeStore, SCHEMA_VERSION, PROJECT };
}));
