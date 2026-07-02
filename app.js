/*
 * app.js — the "22" PWA controller (Google-Sheets backed, v3).
 *
 * Data source (KIT model): the DEV hosts ONE stateless relay (backend/Code.gs).
 * The USER only pastes their own plain Google Sheet URL. sheet-store.js forwards
 * that Sheet URL to the relay, which opens the user's Sheet directly. No per-user
 * Apps Script. The wear math lives in WearCore. The flow:
 *   - First run: setup screen collects the user's Google Sheet URL.
 *   - Toggle/edit: applyEvent locally (optimistic) -> POST the merged log.
 *   - Load/refresh/visibility/interval: GET the Sheet (cache-busted) -> derive ->
 *     render. Offline: render from the local cache; queue writes; flush later.
 *
 * Mirrors v1 (gist-backed) one-for-one; only the data layer + credential differ.
 */
(function () {
  'use strict';
  const Core = window.WearCore;
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
  const RING_R = 108, RING_CIRC = 2 * Math.PI * RING_R;

  // DEV-SET, once: the generic stateless Sheets relay this app talks to. It stores
  // NO data — the user's Sheet URL is sent per request; the relay opens THAT Sheet.
  // The dev deploys the relay once and hardcodes its /exec URL here so users never
  // touch Apps Script. (Empty until the dev bakes it in post-deploy.)
  const DEFAULT_RELAY_URL = 'https://script.google.com/macros/s/AKfycbwftbEkA6ADduGHB_wpB4P8eHoyXb0yYJObl3mtIoM9fmqsXMmooImxDj6poDpenFnMKg/exec';

  // ---- persistent settings + offline cache --------------------------------
  const LS = {
    relay: 'aligners.relayUrl',      // dev relay URL (usually DEFAULT_RELAY_URL)
    sheet: 'aligners.sheetUrl',      // the user's OWN Google Sheet URL
    log: 'aligners.log.v1', queueDirty: 'aligners.dirty',
  };
  const get = (k) => localStorage.getItem(k);
  const set = (k, v) => localStorage.setItem(k, v);
  const loadLocalLog = () => { try { return JSON.parse(get(LS.log)) || []; } catch (_) { return []; } };
  const saveLocalLog = (log) => set(LS.log, JSON.stringify(log));
  const relayUrl = () => (get(LS.relay) || DEFAULT_RELAY_URL || '').trim();

  let store = SheetStore.makeStore({ relayUrl: relayUrl(), sheetUrl: get(LS.sheet) });
  let online = true, snap = null, tickTimer = null, pushing = false;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app'), setupEl = $('setup');
  const els = {};
  ['toggle','ringFill','stateLabel','bigValue','bigCaption','actionHint','wornToday','outToday',
   'targetLabel','historyStrip','conn','lastSync','settingsBtn','shortcutHelp','deployHelp',
   'editToggle','editPanel','editType','editTime','editAdd','eventList',
   'setupUrl','setupConnect','setupStatus'
  ].forEach(id => els[id] = $(id));

  // ---- formatting ----
  const fmtHM = (min) => { min = Math.max(0, Math.round(min)); const h = Math.floor(min/60), m = min%60;
    return h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`; };
  const fmtMs = (ms) => fmtHM(ms/60000);

  // ---- screen routing ------------------------------------------------------
  function showSetup() { setupEl.hidden = false; appEl.hidden = true; }
  function showApp() { setupEl.hidden = true; appEl.hidden = false; }

  // ---- setup flow ----------------------------------------------------------
  async function doConnect() {
    const sheet = (els.setupUrl.value || '').trim();
    if (!sheet) { setupMsg('Paste your Google Sheet link first.', true); return; }
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/.+/.test(sheet)) {
      setupMsg('That doesn’t look like a Google Sheet link. Open your Sheet and copy the URL from the address bar (it starts with docs.google.com/spreadsheets/d/…).', true); return;
    }
    const relay = relayUrl();
    if (!relay) { setupMsg('This app isn’t wired to a relay yet — tell the developer.', true); return; }
    setupMsg('Connecting to your Sheet…');
    const s = SheetStore.makeStore({ relayUrl: relay, sheetUrl: sheet });
    const v = await s.validate();
    if (!v.ok) { setupMsg('Couldn’t open that Sheet: ' + (v.error || 'unknown error'), true); return; }
    // If the Sheet URL changed, drop the previous Sheet's cached log immediately —
    // otherwise the app would render the OLD Sheet's data for ~2s until the new
    // fetch lands. On a shared device that would briefly show one person's log to
    // the next. Clearing here means a switch shows a clean empty state, never
    // another Sheet's data.
    if ((get(LS.sheet) || '') !== sheet) { saveLocalLog([]); set(LS.queueDirty, '0'); }
    set(LS.relay, relay); set(LS.sheet, sheet);
    store = s;
    setupMsg('Connected — found ' + v.count + ' events. Starting…');
    await enterApp();
  }

  function setupMsg(t, isErr) {
    els.setupStatus.textContent = t;
    els.setupStatus.style.color = isErr ? 'var(--red)' : 'var(--muted)';
  }

  async function enterApp() {
    showApp();
    render(localSnapshot());
    await refresh();
    startTick();
  }

  // ---- snapshot from whatever log we have ----------------------------------
  function localSnapshot() { return Core.deriveSnapshot(loadLocalLog(), Date.now(), TZ, {}); }
  function setOnline(v) { online = v; els.conn.classList.toggle('off', !v); els.conn.title = v ? 'Synced' : 'Offline (queued)'; }

  // ---- the toggle ----------------------------------------------------------
  async function toggle() {
    const cur = snap ? snap.state : Core.currentState(loadLocalLog());
    const type = cur === 'IN' ? 'OUT' : 'IN';
    const ev = { type, at: Date.now(), src: 'tap', id: Core.makeId(Date.now()) };
    const r = Core.applyEvent(loadLocalLog(), ev, Date.now());
    if (!r.applied) return;
    saveLocalLog(r.log);
    render(localSnapshot());
    if (navigator.vibrate) navigator.vibrate(type === 'OUT' ? 20 : [15, 40, 15]);
    await persist();
  }

  // Persist the local log to the Sheet (read-modify-merge to avoid clobbering
  // events logged elsewhere, e.g. by Siri, since we were last in sync). The
  // backend also dedupes by id, so this is doubly safe.
  async function persist() {
    if (pushing) return;
    pushing = true;
    try {
      const remote = await store.read();           // cache-busted
      const merged = mergeLogs(remote.state.log, loadLocalLog());
      const saved = await store.appendLog(merged);
      saveLocalLog(saved.log);
      set(LS.queueDirty, '0');
      setOnline(true);
      render(Core.deriveSnapshot(saved.log, Date.now(), TZ, {}));
    } catch (e) {
      set(LS.queueDirty, '1');                       // mark we owe a write
      setOnline(false);
    } finally { pushing = false; }
  }

  // Union two event logs by id; order by time. (Idempotent + dedup.)
  function mergeLogs(a, b) {
    const byId = new Map();
    for (const e of [...(a || []), ...(b || [])]) if (e && e.id) byId.set(e.id, e);
    return Core.sortLog([...byId.values()]);
  }

  // ---- refresh from Sheet --------------------------------------------------
  async function refresh() {
    if (!store.isConfigured()) { showSetup(); return; }
    try {
      const remote = await store.read();
      // If we have unflushed local writes, merge + push them.
      if (get(LS.queueDirty) === '1') {
        const merged = mergeLogs(remote.state.log, loadLocalLog());
        const saved = await store.appendLog(merged);
        saveLocalLog(saved.log); set(LS.queueDirty, '0');
        setOnline(true);
        render(Core.deriveSnapshot(saved.log, Date.now(), TZ, {}));
        return;
      }
      saveLocalLog(remote.state.log);
      setOnline(true);
      render(Core.deriveSnapshot(remote.state.log, Date.now(), TZ, {}));
    } catch (e) {
      setOnline(false);
      render(localSnapshot());
    }
  }

  // ---- render --------------------------------------------------------------
  function render(s) {
    if (!s) return;
    snap = s;
    const out = s.state === 'OUT';
    const warn = out && (s.budgetRemainingMs <= 30 * 60000);
    appEl.classList.toggle('is-out', out);
    appEl.classList.toggle('is-warn', warn);
    els.stateLabel.textContent = s.state;
    els.targetLabel.textContent = (s.wornTargetH || 22) + 'h';
    els.wornToday.textContent = fmtHM(s.wornMinToday);
    els.outToday.textContent = fmtHM(s.outMinToday);

    if (out) {
      const leftMs = s.budgetRemainingMs;
      if (s.overBudget) {
        els.bigValue.textContent = '+' + fmtMs(-leftMs);
        els.bigCaption.textContent = 'over budget';
        els.actionHint.textContent = 'Put them back in now 🚨';
      } else {
        els.bigValue.textContent = fmtMs(leftMs);
        els.bigCaption.textContent = 'out-budget left';
        els.actionHint.textContent = 'Tap when you put them back in';
      }
    } else {
      els.bigValue.textContent = fmtHM(Math.max(0, s.budgetRemainingMin));
      els.bigCaption.textContent = 'out-budget left';
      els.actionHint.textContent = 'Tap when you take them out';
    }

    const frac = Core.clamp(s.budgetRemainingMs / (s.targetOutMin * 60000), 0, 1);
    els.ringFill.style.strokeDasharray = RING_CIRC.toFixed(1);
    els.ringFill.style.strokeDashoffset = (RING_CIRC * (1 - frac)).toFixed(1);

    renderHistory(s.history || []);
    renderEventList();
    els.lastSync.textContent = (online ? 'synced ' : 'offline ') + new Date(s.nowMs || Date.now()).toLocaleTimeString();
  }

  function renderHistory(history) {
    const days = history.slice().reverse();
    const maxWorn = Math.max(22 * 60, ...days.map(d => d.wornMin || 0), 1);
    els.historyStrip.innerHTML = '';
    if (!days.length) { els.historyStrip.innerHTML = '<p style="color:var(--muted);font-size:13px;margin:0">No history yet.</p>'; return; }
    for (const d of days) {
      const pct = Math.max(6, Math.round((d.wornMin / maxWorn) * 100));
      const wd = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })[0];
      const div = document.createElement('div');
      div.className = 'hbar' + (d.hitTarget ? '' : ' miss');
      div.innerHTML = `<div class="hrs">${Math.floor(d.wornMin/60)}h</div><div class="bar" style="height:${pct}px"></div><div class="day">${wd}</div>`;
      div.title = `${d.date}: worn ${fmtHM(d.wornMin)}, out ${fmtHM(d.outMin)}`;
      els.historyStrip.appendChild(div);
    }
  }

  // ---- live countdown tick (visual only) ----------------------------------
  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      if (!snap || snap.state !== 'OUT' || !snap.currentWindowStartedAt) return;
      const elapsedSinceSnap = Math.max(0, Date.now() - (snap.nowMs || Date.now()));
      const cap = snap.targetOutMin * 60000;
      const leftMs = Math.min(cap, snap.budgetRemainingMs - elapsedSinceSnap);
      const over = leftMs < 0;
      els.bigValue.textContent = (over ? '+' : '') + fmtMs(Math.abs(leftMs));
      els.bigCaption.textContent = over ? 'over budget' : 'out-budget left';
      appEl.classList.toggle('is-warn', leftMs <= 30 * 60000);
      els.ringFill.style.strokeDashoffset = (RING_CIRC * (1 - Core.clamp(leftMs / cap, 0, 1))).toFixed(1);
    }, 1000);
  }
  function stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  // ---- manual editing ------------------------------------------------------
  function renderEventList() {
    const log = Core.sortLog(loadLocalLog());
    const today = Core.localDayString(Date.now(), TZ);
    const [lo, hi] = Core.dayBounds(today, TZ);
    const todays = log.filter(e => e.at >= lo && e.at < hi);
    els.eventList.innerHTML = '';
    if (!todays.length) { els.eventList.innerHTML = '<li style="justify-content:center;color:var(--muted)">No events today</li>'; return; }
    for (const e of todays) {
      const li = document.createElement('li');
      const t = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      li.innerHTML = `<span><span class="ev-type ${e.type}">${e.type === 'OUT' ? 'OUT' : 'IN '}</span> ${t}</span>`;
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '✕'; del.title = 'Delete';
      del.onclick = () => deleteEvent(e.id);
      li.appendChild(del);
      els.eventList.appendChild(li);
    }
  }

  async function addEvent() {
    const type = els.editType.value, val = els.editTime.value;
    if (!val) { els.editTime.focus(); return; }
    const at = new Date(val).getTime();
    const r = Core.applyEvent(loadLocalLog(), { type, at, src: 'manual', id: Core.makeId(at) }, Date.now());
    if (!r.applied) { els.actionHint.textContent = 'That would duplicate the current state.'; return; }
    saveLocalLog(r.log); render(localSnapshot());
    await persist();
  }

  // Deletion can't merge-union (the point is removal). The append-only Sheet
  // backend never deletes rows, so removing an event must be done in the Sheet
  // by hand; here we drop it from the local cache for an immediate correction.
  async function deleteEvent(id) {
    saveLocalLog(loadLocalLog().filter(e => e.id !== id));
    render(localSnapshot());
    els.actionHint.textContent = 'Removed locally. To remove it everywhere, delete its row in the Sheet.';
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    // setup screen handlers
    els.setupConnect.addEventListener('click', doConnect);
    if (els.deployHelp) els.deployHelp.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Setup is just two steps:\n\n1. Make a blank Google Sheet (sheets.new).\n2. Share → General access → “Anyone with the link” → Editor. Copy the link.\n\nPaste that link here. That’s it — no code, no Apps Script.');
    });

    // app handlers
    els.toggle.addEventListener('click', toggle);
    els.settingsBtn.addEventListener('click', () => {
      // re-open setup to change/replace the URL
      els.setupStatus.textContent = '';
      els.setupUrl.value = store.sheetUrl || get(LS.sheet) || '';
      showSetup();
    });
    els.shortcutHelp.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Voice + lock-screen reminders use two iOS Shortcuts named “Aligners Off” and “Aligners On”. Each logs one event to your Sheet and creates a native reminder. Build them once from the project’s shortcuts recipe.');
    });
    els.editToggle.addEventListener('click', () => {
      const open = els.editPanel.hidden;
      els.editPanel.hidden = !open;
      if (open) {
        const n = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
        els.editTime.value = n.toISOString().slice(0, 16);
        renderEventList();
      }
    });
    els.editAdd.addEventListener('click', addEvent);

    window.addEventListener('online', () => { setOnline(true); refresh(); });
    window.addEventListener('offline', () => setOnline(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && store.isConfigured()) refresh(); });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});

    // route: configured -> app, else setup
    if (store.isConfigured()) { enterApp(); }
    else { showSetup(); }

    // periodic resync (picks up Siri-logged events + midnight reset);
    // only while the app screen is showing (setup hidden) and tab visible.
    setInterval(() => {
      if (!document.hidden && store.isConfigured() && setupEl.hidden) refresh();
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
