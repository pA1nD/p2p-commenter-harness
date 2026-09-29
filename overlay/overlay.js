/* p2p-commenter-harness overlay — injected into a page by an agent.
 *
 * Joins a room on the signalling server, opens a WebRTC data channel to the
 * room's agent (the hub), and speaks the same frames + API the original
 * atelier commenter spoke over WebSocket/HTTP — now tunnelled through that
 * channel. The agent persists everything; nothing is stored server-side.
 *
 * Room: window.__commenterConfig.room · <script data-room> · #cmt=<room> ·
 * sessionStorage (so navigation within the tab keeps the room).
 * Signal: window.__commenterConfig.signal · <script data-signal> · script origin.
 *
 * Shadow-DOM-isolated, vanilla JS. Implements the Claude Design handover
 * pack (default variants only): center-pill avatar bar, numbered-dot pins,
 * right-slide side panel, pill changed badge. Light theme.
 *
 * Visual register, motion timings, and tokens come from the design's
 * `overlay.css` — embedded below verbatim with the alternative-variant
 * rules trimmed out.
 */

(() => {
  if (window.__commenterMounted) return;
  window.__commenterMounted = true;

  const SCRIPT = document.currentScript;
  const CFG    = window.__commenterConfig || {};
  const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
  const hashRoom = (location.hash.match(/[#&]cmt=([A-Za-z0-9_-]{22})/) || [])[1];
  let ROOM = CFG.room || SCRIPT?.dataset.room || hashRoom;
  try { ROOM = ROOM || sessionStorage.getItem('__commenter_room'); } catch {}
  if (!ROOM || !ROOM_RE.test(ROOM)) { window.__commenterMounted = false; return; }
  try { sessionStorage.setItem('__commenter_room', ROOM); } catch {}
  const SIGNAL = String(CFG.signal || SCRIPT?.dataset.signal
    || (SCRIPT?.src ? new URL(SCRIPT.src).origin : 'https://signal.pa1nd.de')).replace(/\/$/, '');
  const SIGNAL_WS = SIGNAL.replace(/^http/, 'ws');

  // The original proxied pages under /p/<slug>-<token>/. Now the overlay runs
  // on the real page, so paths are the page's own and the "project" is the room.
  const SLUG = ROOM, TOKEN = '';
  const PROXY_BASE = '';
  const PAGE_PATH  = location.pathname;

  /* ──────────── identity ──────────── */

  const STORAGE = '__commenter_v1';
  const COLORS = [
    'oklch(0.62 0.16 250)', // accent / blue
    'oklch(0.65 0.16 145)', // green
    'oklch(0.72 0.17 80)',  // amber
    'oklch(0.62 0.18 30)',  // red
    'oklch(0.6 0.18 305)',  // violet
    'oklch(0.7 0.14 200)',  // cyan
  ];
  function deriveColor(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
    return COLORS[((h % COLORS.length) + COLORS.length) % COLORS.length];
  }
  // Single source of truth for "what color is this user?" — checks the live
  // roster first (so the chosen color from the identify modal wins), falls
  // back to a deterministic derive from clientId (used for offline authors
  // of comments/edits we have no roster entry for).
  function colorOf(clientId) {
    if (!clientId) return COLORS[0];
    if (clientId === state.clientId && state.color) return state.color;
    const u = roster.find((r) => r.clientId === clientId);
    return u?.color || deriveColor(clientId);
  }
  const state = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch { return {}; }
  })();
  if (!state.clientId) state.clientId = (crypto.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now().toString(36)));
  if (!state.color) state.color = deriveColor(state.clientId);
  function persist() { try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch {} }
  persist();

  function initialsOf(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return (parts.map((p) => p[0]).join('') || '?').toUpperCase();
  }

  /* ──────────── anchor library ──────────── */

  function buildAnchor(el, opts = {}) {
    // textSnippet WAS included as a resolveAnchor fallback, but it changes
    // every time the element's text is edited — which made anchor_json drift
    // between successive edits of the same element, splitting one logical
    // anchor's history across multiple "rows-with-different-textSnippet"
    // groups. Since the snippet is a snapshot of mutable text, it was already
    // useless as a fallback for edited elements. Drop it; rely on cssSelector
    // + xpath (and optional textQuote for ranged comments) for resolution.
    return {
      cssSelector: cssSelectorFor(el),
      xpath:       xpathFor(el),
      tag:         el.tagName.toLowerCase(),
      textQuote:   opts.textRange ? textQuoteFor(opts.textRange) : null,
    };
  }
  function cssSelectorFor(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && path.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.classList?.length) {
        const stable = [...node.classList].filter((c) => !/^(w--|active|is-|has-)/.test(c)).slice(0, 2);
        if (stable.length) part += '.' + stable.map(CSS.escape).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(' > ');
  }
  function xpathFor(el) {
    const segs = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [node];
      const idx = same.indexOf(node) + 1;
      segs.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
      node = parent;
    }
    return '/html/' + segs.join('/');
  }
  function textQuoteFor(range) {
    const exact = range.toString();
    if (!exact) return null;
    const root = document.body.textContent;
    const idx = root.indexOf(exact);
    if (idx < 0) return { exact, prefix: '', suffix: '' };
    return { exact, prefix: root.slice(Math.max(0, idx - 32), idx), suffix: root.slice(idx + exact.length, idx + exact.length + 32) };
  }
  function resolveAnchor(a) {
    if (!a) return null;
    try { if (a.cssSelector) { const els = document.querySelectorAll(a.cssSelector); if (els.length === 1) return els[0]; } } catch {}
    try { if (a.xpath) { const r = document.evaluate(a.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); if (r.singleNodeValue) return r.singleNodeValue; } } catch {}
    if (a.textSnippet && a.tag) {
      const els = document.getElementsByTagName(a.tag);
      for (const el of els) {
        const t = (el.textContent || '').trim().slice(0, 200);
        if (t === a.textSnippet) return el;
      }
    }
    if (a.textQuote?.exact) {
      const exact = a.textQuote.exact;
      const all = document.body.querySelectorAll('*');
      for (const el of all) if ((el.textContent || '').includes(exact)) return el;
    }
    return null;
  }

  /* ──────────── shadow DOM root + CSS ──────────── */

  const host = document.createElement('div');
  host.id = '__commenter';
  // Make the host itself a fixed-positioned, max-z-index container so the
  // sidebar (and everything else in our shadow) stacks above host-page UI
  // like the "Made in Webflow" badge. Without this, parts of the host page
  // can sit in stacking contexts that escape our inner z-index ordering.
  // Pointer-events:none on the host lets clicks pass through to the host
  // page; our interactive children inside the shadow override with auto.
  host.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 2147483647;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });

  // Google fonts loaded into the shadow root via @import-style link in <style>.
  // Browsers honor @font-face declared in shadow stylesheets for shadow content.
  const fontsLink = document.createElement('link');
  fontsLink.rel = 'stylesheet';
  fontsLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Fraunces:opsz,wght@9..144,400;9..144,600&display=swap';
  root.appendChild(fontsLink);

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .cm-layer {
      --cm-bg:        rgba(255,255,255,0.78);
      --cm-bg-2:      rgba(255,255,255,0.95);
      --cm-bg-3:      #ffffff;
      --cm-fg:        #0F1115;
      --cm-fg-mute:   #475569;
      --cm-fg-ghost:  #94A3B8;
      --cm-line:      rgba(15,17,21,0.08);
      --cm-line-2:    rgba(15,17,21,0.14);
      --cm-accent:    oklch(0.62 0.16 250);
      --cm-accent-12: oklch(0.62 0.16 250 / 0.12);
      --cm-accent-25: oklch(0.62 0.16 250 / 0.25);
      --cm-glass:     rgba(255,255,255,0.72);
      --cm-glass-blur: blur(20px) saturate(160%);
      --cm-r-6: 6px; --cm-r-10: 10px; --cm-r-14: 14px; --cm-r-20: 20px;
      --cm-shadow-pop: 0 1px 0 rgba(255,255,255,0.6) inset, 0 16px 40px rgba(15,17,21,0.18), 0 2px 6px rgba(15,17,21,0.06);
      --cm-shadow-sm:  0 1px 2px rgba(15,17,21,0.06), 0 4px 16px rgba(15,17,21,0.08);
      --cm-font-ui:   "Inter", system-ui, -apple-system, sans-serif;
      --cm-font-mono: "IBM Plex Mono", ui-monospace, monospace;
      font-family: var(--cm-font-ui);
      color: var(--cm-fg);
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 2147483646;
    }
    .cm-layer * { box-sizing: border-box; }
    .cm-layer > *, .cm-layer button, .cm-layer input, .cm-layer textarea, .cm-layer a { pointer-events: auto; }
    .cm-layer button { font-family: inherit; cursor: pointer; }
    .cm-layer kbd {
      font-family: var(--cm-font-mono); font-size: 10px;
      padding: 1px 5px; border-radius: 4px;
      background: var(--cm-line); color: var(--cm-fg-mute);
      border: 0.5px solid var(--cm-line-2);
    }
    .cm-layer :focus-visible { outline: 2px solid var(--cm-accent); outline-offset: 2px; border-radius: 4px; }

    /* ─ identify modal ─ */
    .id-scrim {
      position: fixed; inset: 0; z-index: 100;
      background: rgba(8,10,14,0.55);
      -webkit-backdrop-filter: blur(8px) saturate(140%);
      backdrop-filter: blur(8px) saturate(140%);
      display: grid; place-items: center;
      animation: cm-id-scrim-in .3s ease-out both;
      pointer-events: auto;
    }
    .id-card {
      width: 440px; max-width: calc(100vw - 40px);
      background: #fff; color: var(--cm-fg);
      border-radius: var(--cm-r-20);
      border: 0.5px solid var(--cm-line);
      box-shadow: var(--cm-shadow-pop);
      padding: 28px 28px 24px;
      animation: cm-id-card-in .42s cubic-bezier(.2,.8,.2,1) both;
    }
    @keyframes cm-id-scrim-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes cm-id-card-in {
      from { opacity: 0; transform: translateY(8px) scale(.985); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .id-eyebrow {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--cm-font-mono);
      font-size: 11px; letter-spacing: .04em;
      color: var(--cm-fg-mute);
      margin-bottom: 22px;
    }
    .id-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: oklch(0.65 0.16 145);
      box-shadow: 0 0 0 3px oklch(0.65 0.16 145 / 0.18);
    }
    .id-mark { display: inline-flex; flex: none; }
    .id-mark svg { display: block; }
    .id-attrib { color: var(--cm-fg-mute); }
    .id-attrib a {
      color: inherit;
      text-decoration: underline;
      text-decoration-color: var(--cm-line-2);
      text-underline-offset: 2px;
      transition: text-decoration-color .15s, color .15s;
    }
    .id-attrib a:hover { color: var(--cm-fg); text-decoration-color: var(--cm-accent); }
    .id-sep { opacity: .4; }
    .id-title {
      font-family: "Fraunces", Georgia, serif;
      font-weight: 400; font-size: 32px; line-height: 1.05; letter-spacing: -.02em;
      margin: 0 0 8px;
    }
    .id-sub {
      font-size: 14px; line-height: 1.5;
      color: var(--cm-fg-mute);
      margin: 0 0 22px; max-width: 42ch;
    }
    .id-preview {
      display: flex; align-items: center; gap: 12px;
      padding: 12px;
      border: 0.5px solid var(--cm-line);
      border-radius: var(--cm-r-10);
      background: var(--cm-line);
      margin-bottom: 22px;
    }
    .id-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      display: grid; place-items: center;
      color: white; font-weight: 600; font-size: 13px;
      box-shadow: 0 0 0 2px #fff;
      transition: background .2s;
    }
    .id-preview-meta { flex: 1; min-width: 0; }
    .id-preview-name { font-size: 14px; font-weight: 600; }
    .id-preview-email {
      font-size: 12px; color: var(--cm-fg-mute);
      font-family: var(--cm-font-mono);
      margin-top: 2px;
    }
    .id-preview-tag {
      font-family: var(--cm-font-mono);
      font-size: 10px; letter-spacing: .1em;
      padding: 3px 7px; border-radius: 999px;
      background: var(--cm-accent); color: white;
    }
    .id-field { display: block; margin-bottom: 14px; }
    .id-label {
      display: block; font-family: var(--cm-font-mono);
      font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
      color: var(--cm-fg-mute); margin-bottom: 6px;
    }
    .id-field input {
      width: 100%; padding: 10px 12px;
      font: inherit; font-size: 14px;
      border: 0.5px solid var(--cm-line-2);
      border-radius: var(--cm-r-10);
      background: transparent; color: inherit;
      transition: border-color .15s, background .15s;
    }
    .id-field input:focus { outline: none; border-color: var(--cm-accent); background: var(--cm-accent-12); }
    .id-field-err {
      min-height: 14px;
      font-size: 11px; line-height: 1.2;
      color: oklch(0.55 0.18 30);
      margin-top: 4px;
    }
    .id-swatches { display: flex; gap: 8px; }
    .id-swatch {
      width: 24px; height: 24px; border-radius: 50%;
      border: 0; padding: 0; cursor: pointer;
      transition: transform .15s;
    }
    .id-swatch.sel { transform: scale(1.1); box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px currentColor; }
    .id-foot {
      display: flex; gap: 16px; align-items: flex-start;
      margin-top: 22px; padding-top: 18px;
      border-top: 0.5px solid var(--cm-line);
    }
    .id-legal {
      flex: 1; font-size: 11.5px; line-height: 1.5;
      color: var(--cm-fg-mute);
    }
    .id-cta {
      padding: 11px 18px;
      font-size: 14px; font-weight: 500;
      background: var(--cm-fg); color: #fff;
      border: 0; border-radius: var(--cm-r-10);
      white-space: nowrap;
      transition: background .15s;
    }
    .id-cta:disabled { opacity: 0.4; cursor: not-allowed; }
    .id-cta:hover:not(:disabled) { background: var(--cm-accent); }
    .id-meta-row {
      display: flex; gap: 8px; align-items: center;
      margin-top: 14px;
      font-family: var(--cm-font-mono);
      font-size: 11px; color: var(--cm-fg-ghost);
    }
    .id-meta-sep { opacity: 0.4; }

    /* ─ mobile / small-viewport warning ─ */
    .mw-foot { justify-content: flex-end; }
    .mw-note {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 12px 14px;
      border: 0.5px solid var(--cm-line-2);
      border-radius: var(--cm-r-10);
      background: oklch(0.72 0.17 80 / 0.10);
      margin-bottom: 4px;
    }
    .mw-note-icon {
      flex: none; width: 18px; height: 18px;
      display: grid; place-items: center;
      color: oklch(0.55 0.16 60);
    }
    .mw-note-body {
      font-size: 13px; line-height: 1.5;
      color: var(--cm-fg);
    }
    .mw-rec {
      font-size: 13px; line-height: 1.5;
      color: var(--cm-fg-mute);
      margin: 14px 0 0; max-width: 44ch;
    }
    .mw-rec b { color: var(--cm-fg); font-weight: 600; }

    /* ─ avatar primitive ─ */
    .av {
      position: relative; border: 0; padding: 0; border-radius: 50%;
      display: grid; place-items: center;
      color: white; font-weight: 600;
      flex-shrink: 0;
      transition: transform .15s cubic-bezier(.2,.8,.2,1), box-shadow .15s;
      animation: cm-av-in .26s cubic-bezier(.2,.8,.2,1) both;
      cursor: pointer;
    }
    /* Suppresses the entry animation for avatars that were already rendered
       on a previous frame — avoids self / stable-roster avatars bouncing in
       on every comment_added / edit_committed / brief reconnect. */
    .av.av-no-animate { animation: none; }
    .av span { font-family: var(--cm-font-ui); letter-spacing: -.02em; line-height: 1; }
    .av:hover { transform: translateY(-1px) scale(1.05); }
    .av-edit-dot {
      position: absolute; right: -1px; bottom: -1px;
      width: 8px; height: 8px; border-radius: 50%;
      background: oklch(0.72 0.17 80);
      box-shadow: 0 0 0 1.5px #fff;
      animation: cm-pulse 1.6s ease-in-out infinite;
    }
    .av-you-tag {
      position: absolute; bottom: -10px; left: 50%;
      transform: translateX(-50%);
      font-family: var(--cm-font-mono);
      font-size: 8px; letter-spacing: .1em;
      padding: 1px 4px; border-radius: 3px;
      background: var(--cm-fg); color: #fff;
      pointer-events: none;
      white-space: nowrap;
    }
    @keyframes cm-av-in {
      from { opacity: 0; transform: translateX(-4px) scale(.6); }
      to   { opacity: 1; transform: translateX(0) scale(1); }
    }
    @keyframes cm-pulse {
      0%,100% { box-shadow: 0 0 0 1.5px #fff, 0 0 0 0 oklch(0.72 0.17 80 / .6); }
      50%     { box-shadow: 0 0 0 1.5px #fff, 0 0 0 4px oklch(0.72 0.17 80 / 0); }
    }

    /* ─ me-menu (logout dropdown on the avatar bar) ─ */
    .ab-me-wrap { position: relative; }
    .ab-me-trigger {
      display: inline-flex; align-items: center; gap: 3px;
      border: 0; padding: 2px 5px 2px 2px; background: transparent;
      border-radius: 999px;
      margin-right: 2px;
      transition: background .15s;
      cursor: pointer;
    }
    .ab-me-trigger:hover { background: var(--cm-line); }
    .ab-me-trigger.open { background: var(--cm-line); }
    .ab-me-trigger > .av { box-shadow: 0 0 0 1.5px #fff; }
    .ab-me-caret {
      display: inline-grid; place-items: center;
      color: var(--cm-fg-mute);
      transition: transform .15s;
    }
    .ab-me-trigger.open .ab-me-caret { transform: rotate(180deg); color: var(--cm-fg); }
    .ab-me-menu {
      position: absolute; top: calc(100% + 10px); left: 0;
      min-width: 240px;
      background: #fff;
      border: 0.5px solid var(--cm-line-2);
      border-radius: var(--cm-r-10);
      box-shadow: var(--cm-shadow-pop);
      padding: 6px;
      z-index: 90;
      animation: cm-pop-in .18s cubic-bezier(.2,.8,.2,1);
    }
    .ab-me-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px 10px; }
    .ab-me-meta { min-width: 0; }
    .ab-me-name { font-size: 12.5px; font-weight: 600; color: var(--cm-fg); }
    .ab-me-email { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-mute); margin-top: 1px; word-break: break-all; }
    .ab-me-divider { height: 0.5px; background: var(--cm-line); margin: 2px 0; }
    .ab-me-item {
      display: flex; align-items: center; gap: 9px;
      width: 100%;
      padding: 7px 10px; border-radius: 7px;
      border: 0; background: transparent;
      color: var(--cm-fg); font: inherit; font-size: 12.5px;
      text-align: left;
      cursor: pointer;
    }
    .ab-me-item:hover { background: var(--cm-line); }
    .ab-me-item svg { width: 13px; height: 13px; color: var(--cm-fg-mute); }
    .ab-me-item-danger { color: oklch(0.55 0.18 30); }
    .ab-me-item-danger:hover { background: oklch(0.62 0.18 30 / 0.1); }
    .ab-me-item-danger svg { color: oklch(0.55 0.18 30); }

    /* ─ avatar bar (center-pill) ─ */
    .ab-wrap {
      position: fixed; top: 14px; left: 0; right: 0;
      display: flex; justify-content: center;
      z-index: 50;
      pointer-events: none;
    }
    .ab-wrap > * { pointer-events: auto; }
    /* When dragged, ab-wrap collapses to a left+top anchored container so the
       inner pill stays where the user dropped it. */
    .ab-wrap.ab-positioned { right: auto; justify-content: flex-start; }
    .ab-grip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 22px; padding: 0; margin-right: 4px;
      border: 0; background: transparent; color: var(--cm-fg-ghost);
      border-radius: 6px;
    }
    /* Use .cm-layer .ab-grip (specificity 0,2,0) to beat the global
       .cm-layer button { cursor: pointer; } rule (specificity 0,1,1). */
    .cm-layer .ab-grip { cursor: grab; }
    .cm-layer .ab-grip:active, .cm-layer.ab-dragging .ab-grip { cursor: grabbing; }
    .ab-grip:hover { color: var(--cm-fg-mute); background: var(--cm-line); }
    .ab-grip svg { width: 10px; height: 14px; opacity: .7; }
    .ab-wrap.ab-dragging { user-select: none; }
    .ab-wrap.ab-dragging * { cursor: grabbing !important; }
    .ab-pill {
      display: flex; align-items: center; gap: 4px;
      padding: 6px 6px 6px 10px;
      background: var(--cm-glass);
      -webkit-backdrop-filter: var(--cm-glass-blur);
      backdrop-filter: var(--cm-glass-blur);
      border: 0.5px solid var(--cm-line-2);
      border-radius: 999px;
      box-shadow: var(--cm-shadow-sm);
      font-size: 12.5px;
    }
    .ab-pill-brand {
      display: grid; place-items: center;
      width: 22px; height: 22px;
      margin-right: 4px;
    }
    .ab-brand-mark {
      width: 12px; height: 12px;
      border-radius: 3px;
      background: var(--cm-fg);
      position: relative;
    }
    .ab-brand-mark::after {
      content: ""; position: absolute; right: -3px; bottom: -3px;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--cm-accent);
    }
    .ab-stack { display: flex; align-items: center; }
    .ab-stack > .av { margin-left: -4px; box-shadow: 0 0 0 1.5px #fff; }
    .ab-stack > .av:first-child { margin-left: 0; }
    .ab-pill-divider { width: 1px; height: 18px; background: var(--cm-line-2); margin: 0 4px; }
    .ab-pill-btn {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 9px;
      background: transparent; border: 0; border-radius: 999px;
      color: var(--cm-fg-mute); font: inherit; font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .ab-pill-btn:hover { background: var(--cm-line); color: var(--cm-fg); }
    .ab-pill-btn svg { width: 13px; height: 13px; }
    .ab-update {
      display: flex; align-items: center; gap: 6px;
      margin-left: 4px; padding: 5px 10px;
      background: oklch(0.78 0.18 50); color: #1d2021;
      border: 0; border-radius: 999px;
      font: inherit; font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em;
      cursor: pointer;
      animation: cm-pulse-update 1.6s ease-in-out infinite;
    }
    .ab-update:hover { filter: brightness(1.08); }
    .ab-update svg { width: 12px; height: 12px; }
    @keyframes cm-pulse-update {
      0%, 100% { box-shadow: 0 0 0 0 oklch(0.78 0.18 50 / 0.5); }
      50%      { box-shadow: 0 0 0 6px oklch(0.78 0.18 50 / 0); }
    }
    .ab-pill-cta {
      padding: 5px 12px;
      background: var(--cm-fg); color: #fff;
      border: 0; border-radius: 999px;
      font: inherit; font-size: 12px; font-weight: 500;
      margin-left: 2px;
      transition: background .15s;
    }
    .ab-pill-cta:hover { background: var(--cm-accent); }

    /* ─ hover affordance ─ */
    /* Outline and toolbar are RENDERED AS SIBLINGS, not inside one wrap, so
       they can have independent z-indexes (the outline sits behind pins,
       while the toolbar sits above pins). A wrapped layout would trap both
       inside one stacking context. */
    .ho-outline {
      position: fixed; pointer-events: none;
      border: 1px solid var(--cm-accent-25);
      border-radius: 6px;
      background: var(--cm-accent-12);
      animation: cm-fade .15s ease-out;
      z-index: 35;
    }
    .ho-toolbar {
      /* Sits above the element (design's intended position). The "hover
         bridge" lives in JS (onMouseMove): a forgiving rect that keeps the
         current hover locked while the mouse traverses the gap between
         the element and this toolbar. */
      position: fixed;
      display: flex; align-items: center;
      padding: 2px;
      background: #fff;
      border: 0.5px solid var(--cm-line-2);
      border-radius: 9px;
      box-shadow: var(--cm-shadow-sm);
      pointer-events: auto;
      overflow: hidden;
      animation: cm-toolbar-in .2s cubic-bezier(.2,.8,.2,1);
      z-index: 50;
    }
    .ho-btn {
      display: grid; place-items: center;
      width: 32px; height: 32px;
      border: 0; background: transparent;
      border-radius: 7px;
      color: var(--cm-fg-mute);
    }
    .ho-btn:hover { background: var(--cm-line); color: var(--cm-fg); }
    .ho-btn svg { width: 15px; height: 15px; }
    .ho-sep { width: 1px; height: 18px; background: var(--cm-line); margin: 0 1px; }
    @keyframes cm-toolbar-in {
      from { opacity: 0; transform: translateY(-2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes cm-fade { from { opacity: 0; } to { opacity: 1; } }

    /* ─ first-contribution celebration ─ */
    .fc-scrim {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(15,17,21,.42);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      backdrop-filter: blur(14px) saturate(140%);
      display: grid; place-items: center;
      pointer-events: auto;
      animation: fc-scrim-in .35s ease-out;
    }
    .fc-scrim.fc-leaving { animation: fc-scrim-out .4s ease-in forwards; }
    @keyframes fc-scrim-in  { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fc-scrim-out { to { opacity: 0; } }
    .fc-card {
      position: relative; z-index: 2;
      width: 360px; max-width: calc(100vw - 32px);
      padding: 36px 28px 28px;
      background: #fff;
      border-radius: 16px;
      text-align: center;
      box-shadow: 0 25px 60px -12px rgba(0,0,0,.32), 0 0 0 0.5px rgba(0,0,0,.05);
      animation: fc-card-in .55s cubic-bezier(.2,.8,.2,1) both;
    }
    @keyframes fc-card-in {
      0%   { opacity: 0; transform: translateY(20px) scale(.94); }
      100% { opacity: 1; transform: translateY(0)    scale(1);   }
    }
    .fc-spark {
      display: inline-block; font-size: 34px; line-height: 1;
      color: var(--cm-accent); margin-bottom: 14px;
      animation: fc-spark .9s cubic-bezier(.2,.8,.2,1) .15s both;
    }
    @keyframes fc-spark {
      0%   { opacity: 0; transform: scale(.4) rotate(-30deg); }
      60%  { opacity: 1; transform: scale(1.18) rotate(8deg); }
      100% { opacity: 1; transform: scale(1) rotate(0); }
    }
    .fc-title {
      font-family: "Fraunces", Georgia, serif;
      font-size: 26px; line-height: 1.15; letter-spacing: -.015em;
      margin: 0 0 10px; color: var(--cm-fg);
    }
    .fc-body {
      font-size: 13.5px; line-height: 1.5; color: var(--cm-fg-mute);
      margin: 0 0 22px;
    }
    .fc-cta {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 10px 20px; border-radius: 999px;
      border: 0; background: var(--cm-fg); color: #fff;
      font: inherit; font-size: 13px; font-weight: 600;
      cursor: pointer;
      transition: background .15s;
    }
    .fc-cta:hover { background: var(--cm-accent); }
    .fc-confetti {
      position: fixed; inset: 0; pointer-events: none;
      overflow: hidden; z-index: 1;
    }
    .fc-piece {
      position: absolute; top: -24px;
      border-radius: 1px;
      will-change: transform, opacity;
      animation: fc-fall linear forwards;
    }
    @keyframes fc-fall {
      0%   { transform: translate(0, 0)            rotate(0);          opacity: 1; }
      85%  {                                                            opacity: 1; }
      100% { transform: translate(var(--drift), calc(100vh + 60px)) rotate(var(--rot)); opacity: 0; }
    }

    /* ─ editing-by-other ─ */
    .ebo-wrap { position: fixed; pointer-events: none; z-index: 45; }
    .ebo-outline {
      position: absolute; inset: -4px;
      border: 1px dashed var(--c);
      border-radius: 6px;
      background: color-mix(in oklch, var(--c) 8%, transparent);
      animation: cm-ebo-pulse 2.4s ease-in-out infinite;
    }
    .ebo-tag {
      position: absolute; top: -28px; left: -4px;
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px 4px 4px;
      background: var(--c); color: #fff;
      border-radius: 999px;
      font-size: 11px; font-weight: 500;
      white-space: nowrap; pointer-events: none;
      animation: cm-toolbar-in .2s cubic-bezier(.2,.8,.2,1);
    }
    .ebo-tag .av { width: 18px !important; height: 18px !important; box-shadow: 0 0 0 1.5px #fff; }
    .ebo-tag .av span { font-size: 8px !important; }
    .ebo-tag-dots { display: inline-flex; gap: 2px; margin-left: 2px; }
    .ebo-tag-dots span {
      width: 3px; height: 3px; border-radius: 50%; background: #fff; opacity: .5;
      animation: cm-typing 1.2s ease-in-out infinite;
    }
    .ebo-tag-dots span:nth-child(2) { animation-delay: .15s; }
    .ebo-tag-dots span:nth-child(3) { animation-delay: .3s; }
    @keyframes cm-typing {
      0%,100% { opacity: .3; transform: translateY(0); }
      50%     { opacity: 1; transform: translateY(-1px); }
    }
    @keyframes cm-ebo-pulse {
      0%,100% { background: color-mix(in oklch, var(--c) 8%, transparent); }
      50%     { background: color-mix(in oklch, var(--c) 14%, transparent); }
    }
    .ebo-wrap.ebo-leaving { animation: cm-ebo-out .22s ease forwards; }
    @keyframes cm-ebo-out {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(.985); }
    }

    /* ─ prepaint gate ─
       The host page's images and web fonts settle the layout up to ~1s
       after our snapshot loads. Without gating, badges/pins paint at the
       pre-settle positions and visibly jump 20–30px (sometimes hundreds)
       once layout finishes. We hide them with the .cm-prepaint class on
       the layer until window.load + document.fonts.ready, then fade them
       in. New pins/badges added AFTER the gate opens still get their
       normal entry animation (the gate only suppresses the first paint). */
    .cm-prepaint .pin, .cm-prepaint .cb-wrap {
      opacity: 0 !important; pointer-events: none;
    }
    .pin, .cb-wrap { transition: opacity .35s ease-out; }

    /* ─ comment pin (dot variant) ─ */
    .pin {
      position: fixed; transform: translate(-50%, -50%);
      border: 0; padding: 0; background: transparent;
      z-index: 40;
      animation: cm-pin-drop .3s cubic-bezier(.34,1.56,.64,1);
    }
    .pin.act { z-index: 41; }
    .pin.resolved { opacity: .45; }
    .pin-dot { width: 28px; height: 28px; }
    .pin-dot-inner {
      display: grid; place-items: center;
      width: 28px; height: 28px;
      border-radius: 50% 50% 50% 4px;
      background: var(--c);
      color: #fff;
      font-family: var(--cm-font-ui);
      font-size: 12px; font-weight: 600;
      box-shadow: 0 4px 12px color-mix(in oklch, var(--c) 50%, transparent), 0 0 0 2px #fff;
      transform: rotate(-45deg);
      transition: transform .15s, box-shadow .15s;
    }
    .pin-dot-inner > * { transform: rotate(45deg); }
    .pin-dot-inner svg { width: 13px; height: 13px; }
    .pin-dot:hover .pin-dot-inner { transform: rotate(-45deg) scale(1.08); }
    .pin-dot.act .pin-dot-inner {
      transform: rotate(-45deg) scale(1.12);
      box-shadow: 0 6px 18px color-mix(in oklch, var(--c) 60%, transparent), 0 0 0 2.5px #fff;
    }
    .pin-dot-count {
      position: absolute; top: -3px; right: -3px;
      min-width: 14px; height: 14px; padding: 0 3px;
      border-radius: 999px;
      background: #fff; color: var(--cm-fg);
      font-size: 9px; font-weight: 600;
      display: grid; place-items: center;
      border: 0.5px solid var(--cm-line-2);
    }
    @keyframes cm-pin-drop {
      0%   { opacity: 0; transform: translate(-50%, calc(-50% - 6px)) scale(.6); }
      60%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
      100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    /* ─ comment composer popover ─ */
    .cmp-pop {
      position: fixed;
      width: 320px;
      background: #fff;
      border: 0.5px solid var(--cm-line-2);
      border-radius: var(--cm-r-14);
      box-shadow: var(--cm-shadow-pop);
      padding: 12px; z-index: 60;
      animation: cm-pop-in .22s cubic-bezier(.2,.8,.2,1);
    }
    .cmp-pop-arrow {
      position: absolute; left: -6px; top: 14px;
      width: 10px; height: 10px;
      background: #fff;
      border-left: 0.5px solid var(--cm-line-2);
      border-bottom: 0.5px solid var(--cm-line-2);
      transform: rotate(45deg);
    }
    .cmp-pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .cmp-pop-name { font-size: 12.5px; font-weight: 600; }
    .cmp-pop-meta { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-ghost); margin-left: auto; }
    .cmp-pop-ta {
      width: 100%; padding: 8px 10px; border-radius: 8px;
      border: 0.5px solid var(--cm-line-2);
      background: transparent; color: inherit;
      font: inherit; font-size: 13.5px; line-height: 1.5;
      resize: none; outline: none;
    }
    .cmp-pop-ta:focus { border-color: var(--cm-accent); background: var(--cm-accent-12); }
    .cmp-pop-foot {
      display: flex; align-items: center; justify-content: space-between;
      margin-top: 10px;
    }
    .cmp-pop-hint { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-ghost); }
    .cmp-pop-btns { display: flex; gap: 6px; }
    .cmp-pop-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; border-radius: 7px; border: 0;
      font: inherit; font-size: 12px; font-weight: 500;
    }
    .cmp-pop-btn.ghost { background: transparent; color: var(--cm-fg-mute); }
    .cmp-pop-btn.ghost:hover { background: var(--cm-line); color: var(--cm-fg); }
    .cmp-pop-btn.primary { background: var(--cm-fg); color: #fff; }
    .cmp-pop-btn.primary:hover { background: var(--cm-accent); }
    .cmp-pop-btn.primary:disabled { opacity: .4; cursor: not-allowed; }
    .cmp-pop-btn.ask { display: inline-flex; align-items: center; gap: 5px; background: var(--cm-ask-bg); color: var(--cm-ask); border: 0.5px solid var(--cm-ask-line); }
    .cmp-pop-btn.ask:hover { background: var(--cm-ask-bg-2); }
    .cmp-pop-btn.ask:disabled { opacity: .4; cursor: not-allowed; }
    .cmp-pop-btn.ask svg { width: 11px; height: 11px; }

    /* Ask the agent — a thread/edit can be handed to the agent: asked → working → done */
    .cm-layer { --cm-ask: oklch(0.45 0.18 305); --cm-ask-bg: oklch(0.6 0.18 305 / .08); --cm-ask-bg-2: oklch(0.6 0.18 305 / .16); --cm-ask-line: oklch(0.6 0.18 305 / .35); }
    .ask-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; white-space: nowrap; }
    .ask-chip svg { width: 10px; height: 10px; }
    .ask-chip.ask-asked   { background: var(--cm-ask-bg-2); color: var(--cm-ask); }
    .ask-chip.ask-working { background: oklch(0.72 0.17 80 / .18); color: oklch(0.45 0.13 70); }
    .ask-chip.ask-done    { background: oklch(0.65 0.16 145 / .14); color: oklch(0.42 0.14 145); }
    .ask-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 6px; border: 0.5px solid var(--cm-ask-line); background: var(--cm-ask-bg); font: inherit; font-size: 11.5px; color: var(--cm-ask); cursor: pointer; }
    .ask-btn:hover { background: var(--cm-ask-bg-2); }
    .ask-btn svg { width: 11px; height: 11px; }
    .ask-btn, .ask-chip { white-space: nowrap; }
    .cb-pop-foot { flex-wrap: wrap; align-items: center; }
    .ask-ctl { display: inline-flex; gap: 6px; align-items: center; }
    .sp-thread-head .ask-ctl { margin-left: auto; }
    .sp-thread-head .ask-ctl + .sp-thread-resolve { margin-left: 6px; }
    .pin.ask-asked .pin-dot-inner, .pin.ask-working .pin-dot-inner {
      box-shadow: 0 4px 12px color-mix(in oklch, var(--c) 50%, transparent), 0 0 0 2px #fff, 0 0 0 4px oklch(0.6 0.18 305);
    }
    .pin.ask-working .pin-dot-inner { animation: cm-ask-pulse 1.4s ease-in-out infinite; }
    @keyframes cm-ask-pulse { 50% { box-shadow: 0 0 0 2px #fff, 0 0 0 7px oklch(0.6 0.18 305 / .35); } }
    .sp-reply-btns { display: flex; flex-direction: column; gap: 6px; }
    .sp-reply-ask { width: 30px; height: 30px; border-radius: 8px; border: 0.5px solid var(--cm-ask-line); background: var(--cm-ask-bg); color: var(--cm-ask); display: grid; place-items: center; cursor: pointer; }
    .sp-reply-ask:hover { background: var(--cm-ask-bg-2); }
    .sp-reply-ask:disabled { opacity: .4; cursor: not-allowed; }
    .sp-reply-ask svg { width: 13px; height: 13px; }
    .cmp-pop-btn svg { width: 12px; height: 12px; }
    @keyframes cm-pop-in {
      from { opacity: 0; transform: translateY(4px) scale(.98); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* ─ side panel (right-slide) ─ */
    .sp {
      position: fixed; top: 0; bottom: 0; right: 0;
      width: 380px;
      background: #fff;
      display: flex; flex-direction: column;
      border-left: 0.5px solid var(--cm-line);
      /* The whole .cm-layer already has z-index 2147483646; this is
         the relative order WITHIN the layer. The layer's z-index is what
         puts the sidebar above host-page UI like Webflow's "Made in
         Webflow" badge (z-index ~999). */
      z-index: 70;
      box-shadow: var(--cm-shadow-pop);
      transform: translateX(100%);
      transition: transform .32s cubic-bezier(.2,.8,.2,1);
    }
    .sp.in { transform: translateX(0); }
    .sp-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 12px 12px 16px;
      border-bottom: 0.5px solid var(--cm-line);
    }
    .sp-tabs { display: flex; gap: 2px; padding: 2px; background: var(--cm-line); border-radius: 8px; }
    .sp-tab {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 11px; border-radius: 6px;
      border: 0; background: transparent;
      font: inherit; font-size: 12.5px; font-weight: 500;
      color: var(--cm-fg-mute);
    }
    .sp-tab.act {
      background: #fff; color: var(--cm-fg);
      box-shadow: 0 1px 2px rgba(0,0,0,.06);
    }
    .sp-tab-num {
      font-family: var(--cm-font-mono); font-size: 10px;
      padding: 1px 5px; border-radius: 999px;
      background: var(--cm-line); color: var(--cm-fg-mute);
    }
    .sp-tab.act .sp-tab-num { background: var(--cm-accent-12); color: var(--cm-accent); }
    .sp-back {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 9px 5px 7px; border-radius: 7px;
      border: 0; background: transparent; color: var(--cm-fg-mute);
      font: inherit; font-size: 12.5px;
    }
    .sp-back:hover { background: var(--cm-line); color: var(--cm-fg); }
    .sp-back svg { width: 13px; height: 13px; }
    .sp-head-right { display: flex; gap: 2px; }
    .sp-icon-btn {
      display: grid; place-items: center;
      width: 28px; height: 28px; border-radius: 7px;
      border: 0; background: transparent; color: var(--cm-fg-mute);
    }
    .sp-icon-btn:hover { background: var(--cm-line); color: var(--cm-fg); }
    .sp-icon-btn svg { width: 13px; height: 13px; }
    .sp-body { flex: 1; overflow-y: auto; padding: 6px; }
    .sp-body::-webkit-scrollbar { width: 8px; }
    .sp-body::-webkit-scrollbar-thumb { background: var(--cm-line-2); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
    .sp-item {
      width: 100%;
      display: grid; grid-template-columns: 28px 1fr; gap: 10px;
      text-align: left;
      padding: 12px; border: 0; border-radius: 10px;
      background: transparent; color: inherit;
      font: inherit;
      margin-bottom: 2px;
      cursor: pointer;
      transition: background .15s;
    }
    .sp-item:hover { background: var(--cm-line); }
    .sp-item.resolved { opacity: .55; }
    .sp-item-pin {
      display: grid; place-items: center;
      width: 22px; height: 22px;
      border-radius: 50% 50% 50% 4px;
      background: var(--cm-fg); color: #fff;
      transform: rotate(-45deg);
      margin-top: 2px;
    }
    .sp-item.resolved .sp-item-pin { background: var(--cm-fg-mute); }
    .sp-item-pin-num { transform: rotate(45deg); font-size: 11px; font-weight: 600; }
    .sp-item-pin-check { transform: rotate(45deg); display: inline-flex; align-items: center; justify-content: center; }
    .sp-item-pin-check svg { width: 12px; height: 12px; }
    .sp-item-body { min-width: 0; }
    .sp-item-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .sp-item-name { font-size: 12.5px; font-weight: 600; }
    .sp-item-time { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-ghost); margin-left: auto; }
    .sp-item-text { font-size: 13px; line-height: 1.5; color: var(--cm-fg); margin-bottom: 6px; word-break: break-word; }
    .sp-item.resolved .sp-item-text { text-decoration: line-through; text-decoration-color: var(--cm-fg-ghost); }
    .sp-item-meta { display: flex; gap: 10px; align-items: center; font-size: 11px; color: var(--cm-fg-mute); }
    .sp-item-target code, .sp-item-page code, .sp-edit-page code {
      font-family: var(--cm-font-mono); font-size: 10.5px;
      padding: 1px 5px; border-radius: 4px;
      background: var(--cm-line); color: var(--cm-fg-mute);
    }
    /* Cross-page badge: subtle accent so the page label stands out */
    .sp-item-page code, .sp-edit-page code {
      background: var(--cm-accent-12); color: var(--cm-accent);
    }
    .sp-edit.other-page, .sp-item.other-page { /* leave as normal hover */ }
    .sp-edit-page { font-size: 11px; }
    .sp-edit-head { gap: 6px; }
    .sp-edit-count {
      font-family: var(--cm-font-mono);
      font-size: 10.5px; color: var(--cm-fg-mute);
      background: var(--cm-line); padding: 1px 6px; border-radius: 999px;
    }
    .sp-item-resolved {
      font-family: var(--cm-font-mono);
      font-size: 10px; letter-spacing: .06em;
      padding: 1px 6px; border-radius: 999px;
      background: oklch(0.65 0.16 145 / .15); color: oklch(0.5 0.14 145);
    }
    .sp-edit { padding: 12px; border-radius: 10px; margin-bottom: 2px; }
    .sp-edit:hover { background: var(--cm-line); }
    .sp-edit-head {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 8px; font-size: 11.5px;
    }
    .sp-edit-target { margin-left: auto; color: var(--cm-fg-mute); }
    .sp-edit-target code {
      font-family: var(--cm-font-mono); font-size: 10.5px;
      padding: 1px 5px; border-radius: 4px;
      background: var(--cm-line);
    }
    .sp-edit-diff {
      border-radius: 8px;
      border: 0.5px solid var(--cm-line);
      overflow: hidden;
      font-size: 12px; line-height: 1.45;
    }
    .sp-diff-row { display: grid; grid-template-columns: 18px 1fr; padding: 6px 8px; align-items: start; }
    .sp-diff-mark { font-family: var(--cm-font-mono); font-size: 12px; font-weight: 600; opacity: .6; }
    .sp-diff-old { background: oklch(0.62 0.18 30 / .08); }
    .sp-diff-old .sp-diff-mark { color: oklch(0.5 0.18 30); }
    .sp-diff-new { background: oklch(0.65 0.16 145 / .08); border-top: 0.5px solid var(--cm-line); }
    .sp-diff-new .sp-diff-mark { color: oklch(0.5 0.14 145); }
    /* per-token diff coloring (word-level) */
    .sp-tok-eq  { color: var(--cm-fg-mute); }
    .sp-tok-del { color: oklch(0.42 0.18 30); background: oklch(0.62 0.18 30 / .22); border-radius: 2px; padding: 0 1px; text-decoration: line-through; text-decoration-color: oklch(0.5 0.18 30 / .55); }
    .sp-tok-ins { color: oklch(0.38 0.14 145); background: oklch(0.65 0.16 145 / .22); border-radius: 2px; padding: 0 1px; font-weight: 500; }
    .sp-edit-actions { display: flex; gap: 4px; margin-top: 8px; }
    .sp-edit-act {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 9px; border-radius: 6px;
      border: 0.5px solid var(--cm-line-2); background: transparent;
      font: inherit; font-size: 11.5px; color: var(--cm-fg-mute);
    }
    .sp-edit-act:hover { background: var(--cm-line); color: var(--cm-fg); }
    .sp-edit-act svg { width: 11px; height: 11px; }

    .sp-thread { padding: 0 14px 14px; }
    .sp-thread-head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 0; margin-bottom: 4px;
      font-size: 12px;
    }
    .sp-thread-num {
      font-family: var(--cm-font-mono); font-size: 11px;
      padding: 2px 7px; border-radius: 999px;
      background: var(--cm-fg); color: #fff;
      font-weight: 600;
    }
    .sp-thread-target { color: var(--cm-fg-mute); }
    .sp-thread-target code {
      font-family: var(--cm-font-mono); font-size: 10.5px;
      padding: 1px 5px; border-radius: 4px;
      background: var(--cm-line);
    }
    .sp-thread-resolve {
      margin-left: auto;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 9px; border-radius: 6px;
      border: 0.5px solid var(--cm-line-2); background: transparent;
      font: inherit; font-size: 11.5px; color: var(--cm-fg-mute);
    }
    .sp-thread-resolve:hover {
      background: oklch(0.65 0.16 145 / .12);
      color: oklch(0.5 0.14 145);
      border-color: oklch(0.65 0.16 145 / .3);
    }
    .sp-thread-resolve svg { width: 11px; height: 11px; }
    .sp-msg { padding: 10px 0; border-bottom: 0.5px solid var(--cm-line); }
    .sp-msg:last-of-type { border-bottom: 0; }
    .sp-msg-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .sp-msg-body { font-size: 13px; line-height: 1.55; color: var(--cm-fg); padding-left: 28px; word-break: break-word; }
    .sp-msg-del {
      margin-left: auto;
      width: 22px; height: 22px; border: 0; background: transparent;
      color: var(--cm-fg-ghost); border-radius: 6px;
      display: inline-grid; place-items: center;
      opacity: 0; transition: opacity .15s, background .15s, color .15s;
    }
    .sp-msg:hover .sp-msg-del { opacity: 1; }
    .sp-msg-del:hover { background: oklch(0.62 0.18 30 / 0.1); color: oklch(0.5 0.18 30); }
    .sp-msg-del svg { width: 11px; height: 11px; }
    /* System status events — "Bob resolved this thread · 2m ago" */
    .sp-event {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 0;
      font-size: 11.5px; color: var(--cm-fg-mute);
      border-bottom: 0.5px solid var(--cm-line);
    }
    .sp-event:last-of-type { border-bottom: 0; }
    .sp-event svg { width: 12px; height: 12px; opacity: .7; flex-shrink: 0; }
    .sp-event-text { flex: 1; }
    .sp-event-text strong { color: var(--cm-fg); font-weight: 600; }
    .sp-event-time { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-ghost); }
    .sp-reply {
      display: grid; grid-template-columns: 20px 1fr auto;
      gap: 8px; align-items: flex-start;
      padding-top: 12px; border-top: 0.5px solid var(--cm-line);
      margin-top: 8px;
    }
    .sp-reply-ta {
      width: 100%; padding: 8px 10px; border-radius: 8px;
      border: 0.5px solid var(--cm-line-2);
      background: transparent; color: inherit;
      font: inherit; font-size: 13px; line-height: 1.5;
      resize: none; outline: none;
    }
    .sp-reply-ta:focus { border-color: var(--cm-accent); background: var(--cm-accent-12); }
    .sp-reply-send {
      align-self: flex-end;
      display: grid; place-items: center;
      width: 32px; height: 32px;
      border: 0; border-radius: 8px;
      background: var(--cm-fg); color: #fff;
    }
    .sp-reply-send:disabled { opacity: .3; cursor: not-allowed; }
    .sp-reply-send:hover:not(:disabled) { background: var(--cm-accent); }
    .sp-reply-send svg { width: 14px; height: 14px; }
    .sp-reply-hint {
      font-family: var(--cm-font-mono); font-size: 10.5px;
      color: var(--cm-fg-ghost);
      padding: 4px 4px 0 36px; /* align under the textarea (avatar = 20px + gap) */
    }
    .sp-foot {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-top: 0.5px solid var(--cm-line);
      font-family: var(--cm-font-mono);
      font-size: 11px; color: var(--cm-fg-ghost);
    }
    .sp-foot-l { display: flex; align-items: center; gap: 6px; }
    .sp-foot-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: oklch(0.65 0.16 145);
      animation: cm-pulse-2 1.6s ease-in-out infinite;
    }
    @keyframes cm-pulse-2 {
      0%,100% { box-shadow: 0 0 0 0 oklch(0.65 0.16 145 / .5); }
      50%     { box-shadow: 0 0 0 4px oklch(0.65 0.16 145 / 0); }
    }
    .sp-empty { padding: 64px 28px; text-align: center; }
    .sp-empty-art { display: inline-flex; gap: 8px; margin-bottom: 22px; }
    .sp-empty-dot {
      width: 10px; height: 10px;
      border-radius: 50% 50% 50% 2px;
      background: var(--cm-fg);
      transform: rotate(-45deg);
      opacity: .18;
      animation: cm-empty-bob 1.8s ease-in-out infinite;
      animation-delay: calc(var(--d) * .18s);
    }
    .sp-empty-title {
      font-family: "Fraunces", Georgia, serif;
      font-size: 22px; line-height: 1.1; letter-spacing: -.01em;
      margin-bottom: 8px;
    }
    .sp-empty-body {
      font-size: 13px; line-height: 1.55;
      color: var(--cm-fg-mute);
      max-width: 30ch; margin: 0 auto 22px;
    }
    .sp-empty-hint {
      font-family: var(--cm-font-mono);
      font-size: 11px; color: var(--cm-fg-ghost);
      display: inline-flex; gap: 6px; align-items: center;
    }
    @keyframes cm-empty-bob {
      0%,100% { transform: rotate(-45deg) translateY(0); opacity: .18; }
      50%     { transform: rotate(-45deg) translateY(-4px); opacity: .4; }
    }

    /* ─ changed badge (pill) ─ */
    .cb-wrap { position: fixed; transform: translate(-50%, -100%); z-index: 45; }
    .cb-wrap.cb-resolved .cb-pill { opacity: .45; }
    .cb-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px 3px 6px;
      background: #fff;
      border: 0.5px solid color-mix(in oklch, var(--c) 30%, var(--cm-line-2));
      border-radius: 999px;
      box-shadow: 0 2px 6px color-mix(in oklch, var(--c) 25%, transparent);
      font-family: var(--cm-font-mono);
      font-size: 10px; letter-spacing: .04em; text-transform: uppercase;
      color: var(--cm-fg-mute);
      cursor: pointer;
      animation: cm-badge-in .42s cubic-bezier(.2,.8,.2,1);
    }
    .cb-pill-dot { width: 6px; height: 6px; border-radius: 50%; }
    .cb-pill-text { color: var(--c, var(--cm-fg)); }
    .cb-pop {
      position: absolute; left: 50%; top: 100%;
      transform: translate(-50%, 8px);
      width: 320px;
      background: #fff;
      border: 0.5px solid var(--cm-line-2);
      border-radius: var(--cm-r-14);
      box-shadow: var(--cm-shadow-pop);
      padding: 12px;
      z-index: 80;
      animation: cm-pop-in .2s cubic-bezier(.2,.8,.2,1);
    }
    /* Flipped above the pill when there isn't room below (badge near
       viewport bottom). The 8px gap is preserved on the other side. */
    .cb-pop.cb-pop-up {
      top: auto; bottom: 100%;
      transform: translate(-50%, -8px);
    }
    .cb-pop-title {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px;
      font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
      color: var(--cm-fg-mute);
    }
    .cb-pop-count { font-family: var(--cm-font-mono); font-size: 10px; color: var(--cm-fg-ghost); letter-spacing: 0; text-transform: none; }
    .cb-pop-list  { display: flex; flex-direction: column; gap: 12px; max-height: 320px; overflow-y: auto; padding-right: 2px; }
    .cb-pop-list::-webkit-scrollbar { width: 6px; }
    .cb-pop-list::-webkit-scrollbar-thumb { background: var(--cm-line-2); border-radius: 3px; }
    .cb-pop-entry { display: flex; flex-direction: column; gap: 6px; }
    .cb-pop-entry + .cb-pop-entry { padding-top: 12px; border-top: 0.5px solid var(--cm-line); }
    .cb-pop-loading { font-size: 11.5px; color: var(--cm-fg-mute); padding: 4px 0; }
    .cb-pop-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
    .cb-pop-name { font-weight: 600; }
    .cb-pop-time { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-ghost); margin-left: auto; }
    .cb-pop-diff {
      border-radius: 8px;
      border: 0.5px solid var(--cm-line);
      overflow: hidden;
      font-size: 12px; line-height: 1.45;
    }
    .cb-pop-row { display: grid; grid-template-columns: 18px 1fr; padding: 6px 8px; align-items: start; }
    .cb-pop-mark { font-family: var(--cm-font-mono); font-weight: 600; opacity: .6; }
    .cb-pop-old { background: oklch(0.62 0.18 30 / .08); }
    .cb-pop-old .cb-pop-mark { color: oklch(0.5 0.18 30); }
    .cb-pop-new { background: oklch(0.65 0.16 145 / .08); border-top: 0.5px solid var(--cm-line); }
    .cb-pop-new .cb-pop-mark { color: oklch(0.5 0.14 145); }
    /* per-token diff coloring (word-level) */
    .cb-tok-eq  { color: var(--cm-fg-mute); }
    .cb-tok-del { color: oklch(0.42 0.18 30); background: oklch(0.62 0.18 30 / .22); border-radius: 2px; padding: 0 1px; text-decoration: line-through; text-decoration-color: oklch(0.5 0.18 30 / .55); }
    .cb-tok-ins { color: oklch(0.38 0.14 145); background: oklch(0.65 0.16 145 / .22); border-radius: 2px; padding: 0 1px; font-weight: 500; }
    .cb-pop-foot { display: flex; gap: 6px; margin-top: 10px; }
    .cb-pop-btn {
      flex: 1;
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      padding: 6px 10px; border-radius: 7px;
      border: 0.5px solid var(--cm-line-2); background: transparent;
      font: inherit; font-size: 12px; color: var(--cm-fg);
    }
    .cb-pop-btn:hover { background: var(--cm-line); }
    .cb-pop-btn.primary { background: var(--cm-fg); color: #fff; border-color: transparent; }
    .cb-pop-btn.primary:hover { background: var(--cm-accent); }
    .cb-pop-btn.danger {
      color: oklch(0.5 0.18 30);
      border-color: color-mix(in oklch, oklch(0.62 0.18 30) 35%, var(--cm-line-2));
    }
    .cb-pop-btn.danger:hover {
      background: color-mix(in oklch, oklch(0.62 0.18 30) 10%, transparent);
      color: oklch(0.42 0.18 30);
    }
    .cb-pop-btn svg { width: 11px; height: 11px; }
    /* Keyframes are on .cb-pill (the inner pill); the .cb-wrap handles
       positioning via its own translate(-50%, -100%). The keyframes must
       NOT include translate — at animation end the pill's transform reverts
       to none, and any translate baked into the keyframes would cause the
       pill to "snap" to its untransformed position (a visible settle of
       half-width right + full-height down). Animate scale + opacity only. */
    @keyframes cm-badge-in {
      0%   { opacity: 0; transform: scale(.8); }
      60%  { opacity: 1; transform: scale(1.08); }
      100% { opacity: 1; transform: scale(1); }
    }

    /* ─ live cursor ─
       The cursor layer is fixed and untransitioned; it's translated to
       cancel the local viewer's scroll so children (positioned at PAGE
       coords) appear at the right viewport location. Cursors themselves
       transition left/top so peer movement lerps smoothly between frames. */
    .cm-cursor-layer {
      position: fixed; inset: 0; pointer-events: none; z-index: 30;
      will-change: transform;
    }
    .lc-wrap {
      position: absolute; pointer-events: none;
      transition: left .35s cubic-bezier(.2,.8,.2,1), top .35s cubic-bezier(.2,.8,.2,1);
    }
    .lc-label {
      position: absolute; left: 14px; top: 16px;
      padding: 2px 7px; border-radius: 999px;
      color: #fff; font-size: 11px; font-weight: 500;
      white-space: nowrap;
    }

    /* ─ follow mode ─ */
    .fm-scrim { position: fixed; inset: 0; pointer-events: none; z-index: 75; }
    .fm-edge { position: absolute; background: var(--c); opacity: .85; }
    .fm-edge-t { left: 0; right: 0; top: 0; height: 2px; }
    .fm-edge-b { left: 0; right: 0; bottom: 0; height: 2px; }
    .fm-edge-l { top: 0; bottom: 0; left: 0; width: 2px; }
    .fm-edge-r { top: 0; bottom: 0; right: 0; width: 2px; }
    .fm-arriving .fm-edge-t, .fm-arriving .fm-edge-b { animation: cm-edge-h .5s cubic-bezier(.16,.84,.32,1); }
    .fm-arriving .fm-edge-l, .fm-arriving .fm-edge-r { animation: cm-edge-v .5s cubic-bezier(.16,.84,.32,1); }
    .fm-watching .fm-edge { animation: cm-edge-pulse 2.4s ease-in-out infinite; }
    @keyframes cm-edge-h { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @keyframes cm-edge-v { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    @keyframes cm-edge-pulse { 0%,100% { opacity: .55; } 50% { opacity: .95; } }

    .fm-banner {
      position: fixed; top: 60px; left: 50%;
      transform: translate(-50%, -12px);
      opacity: 0;
      z-index: 76;
      transition: transform .4s cubic-bezier(.16,.84,.32,1), opacity .25s;
    }
    .fm-banner.fm-arriving, .fm-banner.fm-watching { transform: translate(-50%, 0); opacity: 1; }
    .fm-banner-inner {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 8px 8px 12px;
      background: #fff;
      border: 0.5px solid color-mix(in oklch, var(--c) 25%, var(--cm-line-2));
      border-radius: 999px;
      box-shadow: var(--cm-shadow-pop), 0 0 0 3px color-mix(in oklch, var(--c) 15%, transparent);
    }
    .fm-banner-text { display: flex; flex-direction: column; gap: 1px; }
    .fm-banner-title { font-size: 12.5px; }
    .fm-banner-title b { font-weight: 600; }
    .fm-banner-sub { font-family: var(--cm-font-mono); font-size: 10.5px; color: var(--cm-fg-mute); }
    .fm-banner-stop {
      display: grid; place-items: center;
      width: 28px; height: 28px;
      border: 0; border-radius: 999px;
      background: var(--cm-line); color: var(--cm-fg-mute);
    }
    .fm-banner-stop:hover { background: var(--cm-line-2); color: var(--cm-fg); }
    .fm-banner-stop svg { width: 12px; height: 12px; }

    .fm-cursor { position: fixed; z-index: 77; pointer-events: none;
      animation: cm-fm-cursor .52s cubic-bezier(.16,.84,.32,1); }
    .fm-cursor-ring {
      position: absolute;
      width: 40px; height: 40px;
      border-radius: 50%;
      border: 2px solid var(--c);
      transform: translate(-50%, -50%);
      animation: cm-fm-ring 1s ease-out;
    }
    .fm-cursor-dot {
      position: absolute;
      width: 12px; height: 12px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 3px #fff;
    }
    .fm-cursor-label {
      position: absolute; left: 12px; top: 8px;
      padding: 2px 8px; border-radius: 999px;
      color: #fff; font-size: 11px; font-weight: 500;
    }
    @keyframes cm-fm-cursor {
      0%   { opacity: 0; transform: translate(40px, -40px) scale(.6); }
      60%  { opacity: 1; transform: translate(0, 0) scale(1.1); }
      100% { opacity: 1; transform: translate(0, 0) scale(1); }
    }
    @keyframes cm-fm-ring {
      0%   { width: 0; height: 0; opacity: 1; }
      100% { width: 80px; height: 80px; opacity: 0; }
    }

    /* ─ tools dock (bottom-left) ─ */
    .cm-tools {
      position: fixed; bottom: 14px; left: 14px;
      display: flex; align-items: center; gap: 4px;
      padding: 4px;
      background: var(--cm-glass);
      -webkit-backdrop-filter: var(--cm-glass-blur);
      backdrop-filter: var(--cm-glass-blur);
      border: 0.5px solid var(--cm-line-2);
      border-radius: 999px;
      box-shadow: var(--cm-shadow-sm);
      z-index: 50;
    }
    .cm-tool {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border-radius: 999px;
      border: 0; background: transparent; color: var(--cm-fg-mute);
      font: inherit; font-size: 12px; font-weight: 500;
    }
    .cm-tool:hover { background: var(--cm-line); color: var(--cm-fg); }
    .cm-tool.act { background: var(--cm-accent); color: #fff; }
    .cm-tool.act kbd { background: rgba(255,255,255,.2); color: #fff; border-color: rgba(255,255,255,.3); }
    .cm-tool svg { width: 13px; height: 13px; }

    /* diff overlay tints anything not data-c-edited */
    .cm-diff-overlay {
      position: fixed; inset: 0;
      background: radial-gradient(circle at 50% 0%, transparent 0%, rgba(15,17,21,.04) 100%);
      pointer-events: none;
      animation: cm-fade .25s ease-out;
      z-index: 1;
    }

    /* connection toast */
    .cm-conn {
      position: fixed; bottom: 14px; right: 14px;
      font-family: var(--cm-font-mono);
      font-size: 10px; letter-spacing: .04em;
      color: var(--cm-fg-ghost);
      pointer-events: none;
      display: inline-flex; align-items: center; gap: 6px;
      z-index: 40;
    }
    .cm-conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--cm-fg-ghost); }
    .cm-conn-dot.ok { background: oklch(0.65 0.16 145); }
    .cm-conn-dot.err { background: oklch(0.62 0.18 30); }
  `;
  root.appendChild(style);

  const layer = document.createElement('div');
  layer.className = 'cm-layer cm-prepaint';
  root.appendChild(layer);

  // Track focus inside our (closed) shadow so the global E/C/D shortcut
  // handler can opt out — it can't see into the shadow via composedPath.
  let typingInOverlay = false;
  layer.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) typingInOverlay = true;
  });
  layer.addEventListener('focusout', () => { typingInOverlay = false; });

  /* ──────────── icons ──────────── */

  const ICONS = {
    comment: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5V12H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>',
    edit:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5M3 13.5l1.5-4 7-7 2.5 2.5-7 7-4 1.5z"/></svg>',
    send:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2L2 8l5 1.5L14 2zM14 2L9 14l-2-4.5"/></svg>',
    x:       '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
    plus:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>',
    check:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>',
    arrowR:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    arrowL:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H3M7 4L3 8l4 4"/></svg>',
    undo:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h6a4 4 0 0 1 0 8H6M3 5l3-3M3 5l3 3"/></svg>',
    diff:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2v3M3.5 3.5h3M5 7v7M11 14v-3M9.5 12.5h3M11 9V2"/></svg>',
    cursor:  '<svg width="18" height="22" viewBox="0 0 18 22" fill="none"><path d="M2 2L2 18L7 14L10 20L13 18L10 12L16 12L2 2Z" fill="currentColor" stroke="white" stroke-width="1.2"/></svg>',
    crosshair: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg>',
    caret:   '<svg viewBox="0 0 10 6" width="9" height="5" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    grip:    '<svg viewBox="0 0 6 12" fill="currentColor"><circle cx="1.4" cy="1.6" r="1.1"/><circle cx="4.6" cy="1.6" r="1.1"/><circle cx="1.4" cy="6"   r="1.1"/><circle cx="4.6" cy="6"   r="1.1"/><circle cx="1.4" cy="10.4" r="1.1"/><circle cx="4.6" cy="10.4" r="1.1"/></svg>',
    agent:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6z"/></svg>',
    share:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>',
  };
  function ico(name) { return ICONS[name] || ''; }

  /* ──────────── small helpers ──────────── */

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k.startsWith('data-')) n.setAttribute(k, v);
      else if (v != null) n[k] = v;
    }
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (typeof k === 'string') n.appendChild(document.createTextNode(k));
      else n.appendChild(k);
    }
    return n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function timeAgo(t) {
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function targetCode(anchor) {
    if (!anchor) return '?';
    if (anchor.cssSelector?.startsWith('#')) return anchor.cssSelector;
    if (anchor.tag) {
      const cls = anchor.cssSelector?.split(' ').pop() || anchor.tag;
      return cls.length > 28 ? cls.slice(0, 26) + '…' : cls;
    }
    return '?';
  }

  /* ──────────── word-level diff (for edit popovers / side panel) ────────────
   * Tokenize on word / whitespace / punctuation runs, compute LCS, emit
   * a sequence of {op:'eq'|'del'|'ins', val}. Small (<10K chars) edits
   * only — the O(m·n) DP is fine. */
  function tokenize(s) {
    return (s || '').match(/\w+|\s+|[^\w\s]+/g) || [];
  }
  function diffOps(oldText, newText) {
    const a = tokenize(oldText);
    const b = tokenize(newText);
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.unshift({ op: 'eq',  val: a[i - 1] }); i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.unshift({ op: 'ins', val: b[j - 1] }); j--;
      } else {
        ops.unshift({ op: 'del', val: a[i - 1] }); i--;
      }
    }
    return ops;
  }
  // Append diff tokens to a parent for either the "old" or "new" row.
  // For "old": render eq+del (skip ins). For "new": render eq+ins (skip del).
  function appendDiff(parent, ops, side, prefix) {
    for (const o of ops) {
      if (side === 'old' && o.op === 'ins') continue;
      if (side === 'new' && o.op === 'del') continue;
      const cls = prefix + (o.op === 'eq' ? 'eq' : (o.op === 'del' ? 'del' : 'ins'));
      parent.appendChild(el('span', { class: cls }, o.val));
    }
  }

  /* ──────────── persistent state ──────────── */

  let comments = [];        // [{ id, anchor_json, body, author_*, status, created_at, replies:[] }]
  let edits = [];           // [{ id, anchor_json, original_text, new_text, author_*, created_at }]
  let editsByAnchor = new Map();
  let roster = [];          // from WS

  // UI state
  let panelOpen = false;
  let panelMode = 'list';   // 'list' | 'thread'
  let panelTab = 'comments'; // 'comments' | 'edits'
  let activePinId = null;
  let composerCtx = null;   // { anchor, rect } for new comment composer
  let hoverCtx = null;      // { el, rect }
  let editingCtx = null;    // { el, anchor, original }
  let followCtx = null;     // { user, phase: 'arriving'|'watching' }
  let diffMode = false;
  // Tool modes — replaces the old single hoverEnabled boolean. Two distinct
  // workflows:
  //   'edit'    — hover affordance only on text-editable elements; click an
  //               outlined element (or its toolbar's pencil) to edit text.
  //   'comment' — no hover; the cursor is a crosshair, click anywhere to drop
  //               a comment pin at exactly that point (anchored to the
  //               element under the click + a fractional offset).
  //   'off'     — pure browse, page is fully passable.
  // Mode persists across navigations within the same proxy. localStorage,
  // not sessionStorage, so a refreshed tab keeps the last user choice.
  const MODE_KEY = '__commenter_mode';
  let mode = (() => {
    try {
      const v = localStorage.getItem(MODE_KEY);
      if (v === 'edit' || v === 'comment' || v === 'off') return v;
    } catch {}
    return 'comment';
  })();
  // Inject a host-page stylesheet that forces crosshair on EVERY element,
  // including <a> and <button> which would otherwise show their UA-default
  // pointer cursor — misleading because we intercept the click. The element
  // is created lazily and removed when leaving comment mode.
  let commentCursorStyle = null;
  function applyCommentCursor() {
    if (mode === 'comment') {
      if (!commentCursorStyle) {
        commentCursorStyle = document.createElement('style');
        commentCursorStyle.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
        document.head.appendChild(commentCursorStyle);
      }
    } else if (commentCursorStyle) {
      commentCursorStyle.remove();
      commentCursorStyle = null;
    }
  }
  applyCommentCursor();
  function setMode(next) {
    if (next === mode) next = 'off'; // tapping the active tool again disables
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    if (mode !== 'edit') clearHover();
    applyCommentCursor();
    renderTools();
  }

  /* ──────────── mobile / small-viewport warning ──────────── */

  const MOBILE_DISMISS_KEY = '__commenter_mobile_dismissed_v1';
  function isSmallViewport() { return window.innerWidth < 900; }
  function mobileWarningDismissed() {
    try { return sessionStorage.getItem(MOBILE_DISMISS_KEY) === '1'; } catch { return false; }
  }

  function openMobileWarningModal() {
    return new Promise((resolve) => {
      const scrim = el('div', { class: 'id-scrim' });
      const card = el('div', { class: 'id-card' });

      const mark = el('span', { class: 'id-mark', title: 'Atelier' });
      mark.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<rect x="3"  y="3"  width="8" height="8" rx="1" stroke="#d79921" stroke-width="1.5"/>'
        + '<rect x="13" y="3"  width="8" height="8" rx="1" stroke="#689d6a" stroke-width="1.5"/>'
        + '<rect x="3"  y="13" width="8" height="8" rx="1" stroke="#689d6a" stroke-width="1.5"/>'
        + '<rect x="13" y="13" width="8" height="8" rx="1" stroke="#d79921" stroke-width="1.5" fill="rgba(215,153,33,0.18)"/>'
        + '</svg>';
      const attrib = el('span', { class: 'id-attrib' });
      attrib.innerHTML =
        '<a href="https://github.com/pA1nD/p2p-commenter-harness" target="_blank" rel="noopener noreferrer">p2p-commenter-harness</a>'
        + ` <span class="id-sep">·</span> ${escapeHtml(location.host)}`;
      const eyebrow = el('div', { class: 'id-eyebrow' }, mark, attrib);

      const title = el('h2', { class: 'id-title' }, 'Best viewed on desktop');

      const noteIcon = el('span', { class: 'mw-note-icon' });
      noteIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>';
      const note = el('div', { class: 'mw-note' },
        noteIcon,
        el('div', { class: 'mw-note-body' },
          'This review tool isn’t designed for mobile or small screens yet. ' +
          'Some controls won’t fit, and commenting or editing copy may not work as expected.'
        )
      );

      const rec = el('p', { class: 'mw-rec', html:
        'For the best experience, <b>open this link in a desktop browser</b> on a laptop or larger display.'
      });

      const cta = el('button', { type: 'button', class: 'id-cta' }, 'Continue anyway →');
      cta.addEventListener('click', () => {
        try { sessionStorage.setItem(MOBILE_DISMISS_KEY, '1'); } catch {}
        scrim.remove();
        resolve();
      });

      card.appendChild(eyebrow);
      card.appendChild(title);
      card.appendChild(note);
      card.appendChild(rec);
      card.appendChild(el('div', { class: 'id-foot mw-foot' }, cta));

      scrim.appendChild(card);
      layer.appendChild(scrim);
      setTimeout(() => cta.focus(), 60);
      scrim.addEventListener('keydown', (e) => { if (e.key === 'Enter') cta.click(); });
    });
  }

  /* ──────────── identify modal ──────────── */

  function openIdentifyModal(initial = false) {
    return new Promise((resolve) => {
      const scrim = el('div', { class: 'id-scrim' });
      const card = el('div', { class: 'id-card' });
      let nameVal  = state.name  || '';
      let emailVal = state.email || '';
      let colorIdx = (() => {
        const i = COLORS.indexOf(state.color);
        return i >= 0 ? i : 0;
      })();

      const mark = el('span', { class: 'id-mark', title: 'Atelier' });
      mark.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<rect x="3"  y="3"  width="8" height="8" rx="1" stroke="#d79921" stroke-width="1.5"/>'
        + '<rect x="13" y="3"  width="8" height="8" rx="1" stroke="#689d6a" stroke-width="1.5"/>'
        + '<rect x="3"  y="13" width="8" height="8" rx="1" stroke="#689d6a" stroke-width="1.5"/>'
        + '<rect x="13" y="13" width="8" height="8" rx="1" stroke="#d79921" stroke-width="1.5" fill="rgba(215,153,33,0.18)"/>'
        + '</svg>';
      const attrib = el('span', { class: 'id-attrib' });
      attrib.innerHTML =
        '<a href="https://github.com/pA1nD/p2p-commenter-harness" target="_blank" rel="noopener noreferrer">p2p-commenter-harness</a>'
        + ` <span class="id-sep">·</span> ${escapeHtml(location.host)}`;
      const eyebrow = el('div', { class: 'id-eyebrow' }, mark, attrib);

      const title = el('h2', { class: 'id-title' }, "Who's reviewing?");
      const sub = el('p', { class: 'id-sub' },
        'Pick a name and a color so the team knows it’s you when you leave a comment or edit copy.'
      );

      // preview row
      const previewAvatar = el('div', { class: 'id-avatar', style: { background: COLORS[colorIdx] } }, initialsOf(nameVal || 'You'));
      const previewName = el('div', { class: 'id-preview-name' }, nameVal || 'Your name');
      const previewEmail = el('div', { class: 'id-preview-email' }, emailVal || 'name@team.com');
      const preview = el('div', { class: 'id-preview' },
        previewAvatar,
        el('div', { class: 'id-preview-meta' }, previewName, previewEmail),
        el('div', { class: 'id-preview-tag' }, 'YOU')
      );

      const nameInput = el('input', { type: 'text', placeholder: 'Marlowe Kim', autocomplete: 'name', value: nameVal });
      nameInput.addEventListener('input', (e) => {
        nameVal = e.target.value;
        previewName.textContent = nameVal || 'Your name';
        previewAvatar.textContent = initialsOf(nameVal || 'You');
        updateCta();
      });
      // Loose RFC-pragmatic email check — letters/digits/+/.-_ on both sides
      // of an @, dot in domain. Catches typos and "asdf" without being so
      // strict that real edge cases (e.g. .museum TLDs) fail.
      const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
      const emailInput = el('input', { type: 'email', placeholder: 'you@team.com', autocomplete: 'email', value: emailVal });
      const emailErr = el('div', { class: 'id-field-err' });
      const updateCta = () => {
        const okEmail = !emailVal.trim() || isValidEmail(emailVal);
        cta.disabled = !nameVal.trim() || !okEmail;
        emailErr.textContent = (emailVal && !okEmail) ? 'Looks off — use a name@host.tld format.' : '';
      };
      emailInput.addEventListener('input', (e) => {
        emailVal = e.target.value;
        previewEmail.textContent = emailVal || 'name@team.com';
        updateCta();
      });
      emailInput.addEventListener('blur', updateCta);

      const swatches = el('div', { class: 'id-swatches' });
      COLORS.forEach((c, i) => {
        const sw = el('button', { type: 'button', class: 'id-swatch' + (i === colorIdx ? ' sel' : ''), style: { background: c, color: c }, 'aria-label': `Color ${i + 1}` });
        sw.addEventListener('click', () => {
          colorIdx = i;
          previewAvatar.style.background = COLORS[i];
          [...swatches.children].forEach((c2, idx) => c2.classList.toggle('sel', idx === i));
        });
        swatches.appendChild(sw);
      });

      const cta = el('button', { type: 'button', class: 'id-cta', disabled: !nameVal },
        'Join review →'
      );
      cta.addEventListener('click', commit);
      function commit() {
        if (!nameVal.trim()) { updateCta(); nameInput.focus(); return; }
        if (emailVal.trim() && !isValidEmail(emailVal)) { updateCta(); emailInput.focus(); return; }
        state.name = nameVal.trim();
        state.email = emailVal.trim();
        state.color = COLORS[colorIdx];
        persist();
        scrim.remove();
        sendIdentify();
        resolve(true);
      }

      card.appendChild(eyebrow);
      card.appendChild(title);
      card.appendChild(sub);
      card.appendChild(preview);
      card.appendChild(el('label', { class: 'id-field' },
        el('span', { class: 'id-label' }, 'Name'),
        nameInput
      ));
      card.appendChild(el('label', { class: 'id-field' },
        el('span', { class: 'id-label' }, 'Email (optional)'),
        emailInput,
        emailErr,
      ));
      card.appendChild(el('div', { class: 'id-field' },
        el('span', { class: 'id-label' }, 'Color'),
        swatches
      ));
      card.appendChild(el('div', { class: 'id-foot' },
        el('div', { class: 'id-legal' }, 'Your name (and email, if given) is shown next to your comments and saved by the agent hosting this review.'),
        cta
      ));
      const liveCount = roster.filter((r) => r.clientId !== state.clientId).length;
      card.appendChild(el('div', { class: 'id-meta-row' },
        el('span', {}, `${liveCount} reviewer${liveCount === 1 ? '' : 's'} active`)
      ));

      scrim.appendChild(card);
      layer.appendChild(scrim);
      setTimeout(() => nameInput.focus(), 60);

      scrim.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
    });
  }

  /* ──────────── avatar bar (center-pill) ──────────── */

  let avatarBar = null;
  let avatarBarSeenSelf = false;             // first-render entry animation gate for self
  const avatarBarSeenIds = new Set();        // clientIds already rendered, used to suppress repeat entry animations
  const BAR_POS_KEY = '__commenter_bar_pos';
  let barPos = (() => {
    try { return JSON.parse(localStorage.getItem(BAR_POS_KEY) || 'null'); } catch { return null; }
  })();
  function applyBarPosition() {
    if (!avatarBar) return;
    if (barPos) {
      // Re-clamp on every apply so a stored position from a wider screen
      // doesn't strand the pill off the side of a smaller one.
      const minLeft = 4, minTop = 4;
      const maxLeft = Math.max(minLeft, window.innerWidth - 80);
      const maxTop  = Math.max(minTop,  window.innerHeight - 50);
      avatarBar.style.left = Math.max(minLeft, Math.min(maxLeft, barPos.left)) + 'px';
      avatarBar.style.top  = Math.max(minTop,  Math.min(maxTop,  barPos.top))  + 'px';
      avatarBar.classList.add('ab-positioned');
    } else {
      avatarBar.style.left = '';
      avatarBar.style.top  = '';
      avatarBar.classList.remove('ab-positioned');
    }
  }
  function startBarDrag(ev) {
    if (!avatarBar) return;
    ev.preventDefault();
    ev.stopPropagation();
    // On the very first drag the wrap is still full-width centered
    // (top:14, left:0, right:0). avatarBar.getBoundingClientRect() would
    // return the wrap rect (left=0, ~viewportWidth wide), not the visible
    // pill — so the drag offset would yank the pill to the left edge.
    // Use the inner pill's rect, then immediately pin the wrap at that
    // pill's current position so the first mousemove starts smoothly.
    const pill = avatarBar.firstElementChild || avatarBar;
    const r = pill.getBoundingClientRect();
    const dx = ev.clientX - r.left;
    const dy = ev.clientY - r.top;
    barPos = { left: r.left, top: r.top };
    applyBarPosition();
    avatarBar.classList.add('ab-dragging');
    function onMove(e) {
      const left = e.clientX - dx;
      const top  = e.clientY - dy;
      barPos = { left, top };
      applyBarPosition();
    }
    function onUp() {
      avatarBar?.classList.remove('ab-dragging');
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      try { localStorage.setItem(BAR_POS_KEY, JSON.stringify(barPos)); } catch {}
    }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }
  function renderAvatarBar() {
    if (!state.name) {
      avatarBar?.remove();
      avatarBar = null;
      return;
    }
    if (!avatarBar) {
      avatarBar = el('div', { class: 'ab-wrap' });
      layer.appendChild(avatarBar);
    }
    avatarBar.innerHTML = '';

    const pill = el('div', { class: 'ab-pill' });

    // Drag handle so users can move the bar out of the host page's nav.
    // Position persists in localStorage as { left, top } in viewport pixels;
    // re-clamped on each render so it never gets stranded off-screen.
    const grip = el('button', { type: 'button', class: 'ab-grip', title: 'Drag to move' });
    grip.innerHTML = ico('grip');
    grip.addEventListener('mousedown', startBarDrag);
    pill.appendChild(grip);

    const stack = el('div', { class: 'ab-stack' });
    // Self avatar — only animate on its very first render. Re-renders happen
    // on any roster change (incl. brief WS reconnects) and animating self
    // every time looked like our own avatar was bouncing in repeatedly.
    stack.appendChild(makeMeMenu({ noAnimate: avatarBarSeenSelf }));
    avatarBarSeenSelf = true;
    // Dedupe roster by clientId — a brief WS reconnect can leave the server
    // with two participant entries for the same clientId until the stale
    // sweep drops the old one. We render each clientId once.
    const seenIds = new Set([state.clientId]);
    const others = [];
    for (const u of roster) {
      if (seenIds.has(u.clientId)) continue;
      seenIds.add(u.clientId);
      others.push(u);
    }
    others.forEach((u, i) => {
      const isFirstSeen = !avatarBarSeenIds.has(u.clientId);
      avatarBarSeenIds.add(u.clientId);
      stack.appendChild(makeAv(u, {
        editing: !!u.editing,
        onClick: () => startFollow(u),
        title: `Follow ${u.name || 'anon'}`,
        delay: isFirstSeen ? i * 60 : 0,
        noAnimate: !isFirstSeen,
      }));
    });
    // Forget anyone who's not currently in the bar so they animate again
    // on their next genuine join (vs a re-render while still present).
    for (const cid of [...avatarBarSeenIds]) {
      if (!seenIds.has(cid)) avatarBarSeenIds.delete(cid);
    }
    pill.appendChild(stack);

    pill.appendChild(el('span', { class: 'ab-pill-divider' }));

    const openCount = comments.filter((c) => !c.event && c.status !== 'resolved').length;
    const editCount = edits.filter((e) => !e.event).length;

    const cBtn = el('button', { type: 'button', class: 'ab-pill-btn', title: 'Comments' });
    cBtn.innerHTML = ico('comment') + `<span>${openCount}</span>`;
    cBtn.addEventListener('click', () => openPanel('comments'));
    pill.appendChild(cBtn);

    const eBtn = el('button', { type: 'button', class: 'ab-pill-btn', title: 'Edits' });
    eBtn.innerHTML = ico('diff') + `<span>${editCount}</span>`;
    eBtn.addEventListener('click', () => openPanel('edits'));
    pill.appendChild(eBtn);
    // Share has moved into the avatar dropdown ("Copy invite link") — no
    // need for a redundant CTA on the bar.

    // OUTDATED chip — only when an update has been pending long enough that
    // we couldn't sneak in an idle reload. Click to force-reload now.
    if (typeof shouldShowOutdated === 'function' && shouldShowOutdated()) {
      const upBtn = el('button', { type: 'button', class: 'ab-update', title: 'New version available — click to reload' });
      upBtn.innerHTML = ico('refresh') + '<span>OUTDATED · UPDATE NOW</span>';
      upBtn.addEventListener('click', () => performReload());
      pill.appendChild(upBtn);
    }

    avatarBar.appendChild(pill);
    applyBarPosition();
  }
  // Re-clamp on resize so the pill never gets stranded.
  window.addEventListener('resize', () => { if (barPos) applyBarPosition(); });

  function makeAv(user, opts = {}) {
    const size = opts.size || 26;
    const a = el('button', {
      type: 'button',
      class: 'av' + (opts.noAnimate ? ' av-no-animate' : ''),
      style: {
        width: size + 'px', height: size + 'px',
        background: user.color || colorOf(user.clientId),
        animationDelay: (opts.delay || 0) + 'ms',
      },
      title: opts.title || user.name || 'anon',
    });
    if (opts.onClick) a.addEventListener('click', opts.onClick);
    a.appendChild(el('span', { style: { fontSize: Math.round(size * 0.42) + 'px' } }, initialsOf(user.name)));
    if (opts.editing) a.appendChild(el('span', { class: 'av-edit-dot' }));
    if (opts.you) a.appendChild(el('span', { class: 'av-you-tag' }, 'YOU'));
    return a;
  }

  // Self-avatar with caret + dropdown menu (account · sign out).
  function makeMeMenu(opts = {}) {
    const wrap = el('div', { class: 'ab-me-wrap' });
    const trigger = el('button', { type: 'button', class: 'ab-me-trigger', title: 'Account · sign out' });
    trigger.appendChild(makeAv({ clientId: state.clientId, name: state.name, color: state.color }, { size: 26, noAnimate: !!opts.noAnimate }));
    const caret = el('span', { class: 'ab-me-caret', 'aria-hidden': 'true' });
    caret.innerHTML = ico('caret');
    trigger.appendChild(caret);
    wrap.appendChild(trigger);

    let menu = null;
    let outsideHandler = null;
    function close() {
      if (!menu) return;
      menu.remove(); menu = null;
      trigger.classList.remove('open');
      if (outsideHandler) {
        document.removeEventListener('mousedown', outsideHandler, true);
        outsideHandler = null;
      }
    }
    function open() {
      trigger.classList.add('open');
      menu = el('div', { class: 'ab-me-menu' });
      const head = el('div', { class: 'ab-me-head' },
        makeAv({ clientId: state.clientId, name: state.name, color: state.color }, { size: 28 }),
        el('div', { class: 'ab-me-meta' },
          el('div', { class: 'ab-me-name' }, state.name || 'You'),
          el('div', { class: 'ab-me-email' }, state.email || '')
        )
      );
      menu.appendChild(head);
      menu.appendChild(el('div', { class: 'ab-me-divider' }));

      const inviteBtn = el('button', { type: 'button', class: 'ab-me-item' });
      inviteBtn.innerHTML = ico('plus') + '<span>Copy invite link</span>';
      inviteBtn.addEventListener('click', () => { close(); shareLink(); });
      menu.appendChild(inviteBtn);

      const signOutBtn = el('button', { type: 'button', class: 'ab-me-item ab-me-item-danger' });
      signOutBtn.innerHTML = ico('arrowL') + '<span>Sign out · switch user</span>';
      signOutBtn.addEventListener('click', () => { close(); signOut(); });
      menu.appendChild(signOutBtn);

      wrap.appendChild(menu);

      // Close on outside click. composedPath() from a document-level listener
      // can NOT see into a closed shadow root (it stops at the host), so we
      // can't distinguish "click on the menu" from "click elsewhere in our
      // shadow" — they all retarget to `host`. Treat any event whose target
      // is the shadow host as "inside our overlay" and don't close. The
      // menu's own click handlers run close() when an item is picked.
      outsideHandler = (e) => {
        if (e.target === host) return;
        close();
      };
      setTimeout(() => document.addEventListener('mousedown', outsideHandler, true), 0);
    }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu) close(); else open();
    });
    return wrap;
  }

  function signOut() {
    state.name = null;
    state.email = null;
    persist();
    sendWs({ t: 'identify', name: null, email: null });
    renderAvatarBar();   // pulls bar (state.name is null now)
    renderTools();       // tools dock requires identify
    closePanel();
    openIdentifyModal().then(() => {
      renderAvatarBar();
      renderTools();
    });
  }

  async function shareLink() {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast(url);
    }
  }

  /* ──────────── target selection (host-DOM) ──────────── */

  // Walk path to find the deepest commentable element.
  function targetFromEvent(ev) {
    const path = ev.composedPath?.() || [ev.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (node === host) return null;        // our overlay host
      if (node === document.body || node === document.documentElement) continue;
      if (node.closest?.('[data-c-no]')) continue;
      return node;
    }
    return null;
  }

  /* ──────────── hover affordance ──────────── */

  let hoverOutline = null;
  function showHover(targetEl) {
    if (!targetEl) return clearHover();
    const r = targetEl.getBoundingClientRect();
    if (!r.width || !r.height) return clearHover();
    if (!hoverOutline) {
      hoverOutline = el('div', { class: 'ho-outline' });
      layer.appendChild(hoverOutline);
    }
    hoverCtx = { el: targetEl, rect: r };
    // Outline expands the element's rect by 3px on each side.
    Object.assign(hoverOutline.style, {
      left:   (r.left   - 3) + 'px',
      top:    (r.top    - 3) + 'px',
      width:  (r.width  + 6) + 'px',
      height: (r.height + 6) + 'px',
    });
  }
  function clearHover() {
    hoverCtx = null;
    hoverOutline?.remove(); hoverOutline = null;
    // Reset the dedup so a subsequent mousemove over the SAME element
    // re-runs showHover (we early-return on `t === lastHoverEl`).
    lastHoverEl = null;
  }

  let lastHoverEl = null;
  let mouseX = 0, mouseY = 0, mouseSeen = false;
  function onMouseMove(ev) {
    mouseX = ev.clientX;
    mouseY = ev.clientY;
    mouseSeen = true;
    schedulePresence(); // keep peers' cursors snappy
    if (!state.name) return;
    if (mode !== 'edit') return; // hover affordance is edit-mode only
    if (composerCtx || editingCtx || followCtx) return;

    // If the pointer is currently inside our overlay UI (e.g. the hover
    // toolbar, avatar bar, side panel, badge popover), KEEP the existing
    // hover target. Without this, the mouse traveling from the element
    // up to the toolbar would land on a sibling element and re-target
    // the hover, making the toolbar unclickable.
    const path = ev.composedPath?.() || [];
    if (path.indexOf(host) !== -1) return;


    const t = targetFromEvent(ev);
    if (!t) { lastHoverEl = null; return clearHover(); }
    if (t === lastHoverEl) return;
    const r = t.getBoundingClientRect();
    // Reject only truly tiny elements (line breaks, decorative dots).
    // Don't `clearHover` here — if the user moved from a parent into a
    // too-small inner element, we want the parent's hover to STAY rather
    // than vanishing. Just skip the update.
    if (r.width < 8 || r.height < 8) return;
    // Edit mode: only highlight elements whose text we can actually edit
    // (text-only or only-text-children). Skip wrappers/containers.
    if (!isEditable(t)) return;
    // Skip if there's already an editing-by-other on this element
    const anchor = buildAnchor(t);
    const aJson = JSON.stringify(anchor);
    if (roster.some((u) => u.clientId !== state.clientId && u.editing?.anchor && JSON.stringify(u.editing.anchor) === aJson)) {
      return; // also keep current hover (whatever it was)
    }
    lastHoverEl = t;
    showHover(t);
  }
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseleave', clearHover);

  // Comment mode: any click on the host page drops a pin at the click point.
  // Edit mode: clicking an editable element starts inline edit (no toolbar).
  // Capture-phase so the host page doesn't navigate / submit on the way out.
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const inOverlay = t && (t.id === '__commenter' || t.closest?.('#__commenter'));
    // While a tool is active and the panel is open, any host-page click
    // closes the panel — the user is interacting with the page itself.
    if (!inOverlay && (mode === 'comment' || mode === 'edit') && panelOpen) {
      closePanel();
    }
    if (inOverlay) return;
    if (composerCtx || editingCtx) return;
    if (mode === 'comment') {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      const stack = (document.elementsFromPoint(ev.clientX, ev.clientY) || [])
        .filter((e) => e && e.id !== '__commenter' && !e.closest?.('#__commenter'));
      const target = stack[0] || document.body;
      startComment(target, { x: ev.clientX, y: ev.clientY });
      return;
    }
    if (mode === 'edit') {
      // Prefer the currently-hovered editable element (matches the outline).
      // Fall back to the click target's path; walk up ancestors so a click
      // on a nested <strong>/<span> still resolves to the editable paragraph.
      let target = hoverCtx?.el && isEditable(hoverCtx.el) ? hoverCtx.el : null;
      if (!target) {
        let node = targetFromEvent(ev);
        while (node && node !== document.body && node !== document.documentElement && !isEditable(node)) {
          node = node.parentElement;
        }
        if (node && isEditable(node)) target = node;
      }
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      startEdit(target);
    }
  }, true);

  /* ──────────── editing-by-other ──────────── */

  // Minimum hold + soft fade-out so very fast edits don't flicker.
  // Why: a bot (or a real user typing a single character then blurring) can
  // commit in <100ms. Without this, observers see the green "is editing"
  // outline appear and vanish faster than they can register it. Hold for
  // ≥ EBO_MIN_HOLD_MS from first show, then fade out for EBO_FADE_OUT_MS.
  const EBO_MIN_HOLD_MS = 1500;
  const EBO_FADE_OUT_MS = 220;
  const editingShownAt   = new Map(); // clientId → ts of first show in this session
  const editingClearTimer = new Map(); // clientId → { holdTimer, fadeTimer }
  const editingLeaving   = new Set(); // clientIds whose UI is currently fading

  function clearEditingTimers(cid) {
    const t = editingClearTimer.get(cid);
    if (t) {
      if (t.holdTimer) clearTimeout(t.holdTimer);
      if (t.fadeTimer) clearTimeout(t.fadeTimer);
      editingClearTimer.delete(cid);
    }
  }

  function setEditingState(idx, next) {
    const cid = roster[idx].clientId;
    // A new "editing" arrival cancels any pending clear/fade and re-asserts.
    clearEditingTimers(cid);
    if (next) {
      if (editingLeaving.has(cid)) editingLeaving.delete(cid);
      if (!roster[idx].editing) editingShownAt.set(cid, Date.now());
      roster[idx].editing = next;
      renderEditingByOther();
      return;
    }
    // Clearing path: keep showing until min-hold elapsed, then fade for a beat.
    if (!roster[idx].editing) { renderEditingByOther(); return; }
    const shownAt = editingShownAt.get(cid) ?? 0;
    const remaining = Math.max(0, EBO_MIN_HOLD_MS - (Date.now() - shownAt));
    const beginFade = () => {
      editingLeaving.add(cid);
      renderEditingByOther();
      const fadeTimer = setTimeout(() => {
        editingLeaving.delete(cid);
        editingShownAt.delete(cid);
        editingClearTimer.delete(cid);
        const j = roster.findIndex((r) => r.clientId === cid);
        if (j >= 0) roster[j].editing = null;
        renderEditingByOther();
      }, EBO_FADE_OUT_MS);
      const entry = editingClearTimer.get(cid) || {};
      entry.fadeTimer = fadeTimer;
      editingClearTimer.set(cid, entry);
    };
    if (remaining === 0) {
      beginFade();
    } else {
      editingClearTimer.set(cid, { holdTimer: setTimeout(beginFade, remaining) });
    }
  }

  function renderEditingByOther() {
    layer.querySelectorAll('.ebo-wrap').forEach((n) => n.remove());
    for (const u of roster) {
      if (u.clientId === state.clientId) continue;
      if (!u.editing?.anchor) continue;
      // Anchors aren't page-scoped — the same selector can resolve on multiple
      // pages, so without this filter a peer editing a header on /a would
      // light up the same header on /b for everyone else.
      if (u.page && u.page !== PAGE_PATH) continue;
      const target = resolveAnchor(u.editing.anchor);
      if (!target) continue;
      const r = target.getBoundingClientRect();
      const leaving = editingLeaving.has(u.clientId);
      const w = el('div', { class: 'ebo-wrap' + (leaving ? ' ebo-leaving' : ''), style: {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
        '--c': u.color,
      }});
      // can't set --c via Object.assign because it's a CSS var — use setProperty
      w.style.setProperty('--c', u.color);
      const out = el('div', { class: 'ebo-outline' });
      out.style.setProperty('--c', u.color);
      const tag = el('div', { class: 'ebo-tag' });
      tag.style.setProperty('--c', u.color);
      tag.style.background = u.color;
      tag.appendChild(makeAv(u, { size: 18 }));
      tag.appendChild(el('span', {}, `${(u.name || 'anon').split(' ')[0]} is editing`));
      tag.appendChild(el('span', { class: 'ebo-tag-dots' },
        el('span'), el('span'), el('span')
      ));
      w.appendChild(out);
      w.appendChild(tag);
      layer.appendChild(w);
    }
  }

  /* ──────────── pins ──────────── */

  // True user comments only — excludes the system "resolved/reopened"
  // event rows we use to log status changes in the thread.
  // Pin rendering uses ONLY comments on the current page. Cross-page comments
  // are surfaced in the side panel with navigation links (see renderCommentList).
  function commentsByAnchor() {
    const map = new Map();
    for (const c of comments) {
      if (c.event) continue;
      if (c.page_path && c.page_path !== PAGE_PATH) continue;
      const k = c.anchor_json;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    }
    return map;
  }
  // Full thread (real comments + system events), interleaved by created_at.
  // Used by the right-panel thread view to render an in-line audit trail.
  function threadByAnchor() {
    const map = new Map();
    for (const c of comments) {
      if (c.page_path && c.page_path !== PAGE_PATH) continue;
      const k = c.anchor_json;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.created_at - b.created_at);
    return map;
  }
  // Apply a server-supplied snapshot of comments at one anchor: replace the
  // current entries for that anchor (matching by id) and append/insert any
  // new ones (e.g. status changes, system events).
  function mergeAnchorComments(anchorJson, list) {
    const seenIds = new Set(list.map((c) => c.id));
    comments = comments.filter((c) => c.anchor_json !== anchorJson || !seenIds.has(c.id));
    for (const c of list) comments.push(c);
  }
  // Idempotent local push: never duplicate by id. Used by both the optimistic
  // submit() path and the WS comment_added handler so a fast WS broadcast
  // arriving before the HTTP response can't cause double-renders.
  function addCommentLocal(c) {
    if (!c) return false;
    if (comments.some((existing) => existing.id === c.id)) return false;
    comments.push(c);
    return true;
  }

  // Reuse pin DOM nodes across re-positions (same reasoning as badges):
  // wiping caused the drop animation to re-fire every scroll frame and
  // any sub-pixel layout shift looked like a flicker. Map keyed by the
  // group's anchor_json.
  const pinEntries = new Map(); // anchor_json → { pin, inner, count, target, lastIdx }

  function pinPosition(target, anchor) {
    // Comments are always dropped at a click point (Comment mode), so the
    // anchor must carry a fractional offset within the target element.
    // The pin reproduces the click position via that offset so it survives
    // layout reflow at other viewport widths.
    const r = target.getBoundingClientRect();
    const fx = anchor?.offset?.fx ?? 0.5;
    const fy = anchor?.offset?.fy ?? 0.5;
    return { x: r.left + fx * r.width, y: r.top + fy * r.height };
  }

  /* ──────────── ask the agent ──────────── */
  // A comment thread or an edited element can be handed to the agent. The
  // state lives in event rows (like resolved/reopened): asked → working → done.
  const ASK_EVENTS = ['asked', 'working', 'done'];
  const ASK_LABEL = { asked: 'Asked agent', working: 'Agent working', done: 'Agent done' };
  function askOf(rows) {
    let last = null;
    for (const r of rows || []) if (ASK_EVENTS.includes(r.event) && (!last || r.created_at >= last.created_at)) last = r;
    return last?.event || null;
  }
  // System event rows (resolve/reopen + ask states) → "Ana resolved this thread".
  const EVENT_VERBS = { resolved: 'resolved', reopened: 'reopened', asked: 'asked the agent to act on', working: 'is working on', done: 'finished' };
  const EVENT_ICONS = { resolved: 'check', reopened: 'undo' };
  function eventRow(row, noun) {
    const evt = el('div', { class: 'sp-event' });
    evt.innerHTML = ico(EVENT_ICONS[row.event] || 'agent');
    evt.appendChild(el('span', { class: 'sp-event-text' },
      el('strong', {}, (row.author_name || 'anon').split(' ')[0]),
      ` ${EVENT_VERBS[row.event] || row.event} this ${noun}`,
    ));
    evt.appendChild(el('span', { class: 'sp-event-time' }, timeAgo(row.created_at)));
    return evt;
  }
  function askChip(ask) {
    const chip = el('span', { class: 'ask-chip ask-' + ask });
    chip.innerHTML = ico('agent');
    chip.appendChild(document.createTextNode(ASK_LABEL[ask]));
    return chip;
  }
  // Chip for the current state, plus an "Ask agent" button unless it's pending.
  function askControl(ask, onAsk) {
    const ctl = el('span', { class: 'ask-ctl' });
    if (ask) ctl.appendChild(askChip(ask));
    if (ask !== 'asked' && ask !== 'working') {
      const b = el('button', { type: 'button', class: 'ask-btn', title: 'Hand this to the agent to act on' });
      b.innerHTML = ico('agent') + (ask === 'done' ? ' Ask again' : ' Ask agent');
      b.addEventListener('click', (e) => { e.stopPropagation(); b.disabled = true; onAsk(); });
      ctl.appendChild(b);
    }
    return ctl;
  }
  function applyAskEvent(kind, event) {
    if (!event) return;
    if (kind === 'edit') applyEditThreadStatus({ anchor_json: event.anchor_json, edits: [], event });
    else if (addCommentLocal(event)) { renderPins(); if (panelOpen) renderPanel(); }
  }
  async function askAgent(kind, anchor, pagePath) {
    try {
      const r = await api(`/__c/api/${kind === 'edit' ? 'edits' : 'comments'}/ask`, {
        method: 'POST',
        body: JSON.stringify({ page: pagePath || PAGE_PATH, anchor, clientId: state.clientId, name: state.name, email: state.email }),
      });
      const j = await r.json();
      applyAskEvent(kind, j.event);
      toast('Sent to the agent');
    } catch (e) { toast('could not reach the agent'); }
  }

  function buildPin(group, anchor, color, idx, allResolved, active, ask) {
    const pin = el('button', { type: 'button',
      class: 'pin pin-dot' + (active ? ' act' : '') + (allResolved ? ' resolved' : '') + (ask ? ' ask-' + ask : ''),
    });
    pin.style.setProperty('--c', color);
    // Resolved → check glyph; otherwise the pin number.
    const inner = el('span', { class: 'pin-dot-inner' });
    if (allResolved) inner.innerHTML = ico('check');
    else inner.textContent = String(idx + 1);
    pin.appendChild(inner);
    let count = null;
    if (group.length > 1) {
      count = el('span', { class: 'pin-dot-count' }, String(group.length));
      pin.appendChild(count);
    }
    pin.addEventListener('click', (e) => { e.stopPropagation(); openThread(group[0].id); });
    return { pin, inner, count };
  }

  function renderPins() {
    const groups = commentsByAnchor();
    const groupKeys = [...groups.keys()].sort((a, b) => groups.get(a)[0].created_at - groups.get(b)[0].created_at);
    const fullGroups = threadByAnchor();
    const seen = new Set();
    let idx = 0;
    for (const k of groupKeys) {
      const group = groups.get(k);
      const anchor = JSON.parse(k);
      const target = resolveAnchor(anchor);
      if (!target) { idx++; continue; }
      const author = group[0];
      const color = colorOf(author.author_client_id);
      const allResolved = group.every((c) => c.status === 'resolved');
      const active = activePinId === group[0].id;
      const { x, y } = pinPosition(target, anchor);

      let entry = pinEntries.get(k);
      // Rebuild only if the group composition / target / state changed.
      const ask = askOf(fullGroups.get(k));
      const stateSig = idx + '|' + group.length + '|' + (active ? 1 : 0) + '|' + (allResolved ? 1 : 0) + '|' + ask;
      if (!entry || entry.target !== target || entry.stateSig !== stateSig) {
        if (entry) entry.pin.remove();
        const built = buildPin(group, anchor, color, idx, allResolved, active, ask);
        layer.appendChild(built.pin);
        entry = { ...built, target, stateSig };
        pinEntries.set(k, entry);
      }
      // Pure position update (cheap; no animation re-fire).
      entry.pin.style.left = Math.round(x) + 'px';
      entry.pin.style.top  = Math.round(y) + 'px';
      seen.add(k);
      idx++;
    }
    // Drop pins whose comment group is gone.
    for (const [k, entry] of pinEntries) {
      if (!seen.has(k)) {
        entry.pin.remove();
        pinEntries.delete(k);
      }
    }
  }

  function pinIndexFor(commentId) {
    const groups = commentsByAnchor();
    const keys = [...groups.keys()].sort((a, b) => groups.get(a)[0].created_at - groups.get(b)[0].created_at);
    for (let i = 0; i < keys.length; i++) {
      if (groups.get(keys[i]).some((c) => c.id === commentId)) return i;
    }
    return -1;
  }

  /* ──────────── comment composer ──────────── */

  let composerNode = null;
  async function startComment(targetEl, opts = {}) {
    if (!state.name) {
      await openIdentifyModal();
    }
    clearHover();
    closeComposer();
    const r = targetEl.getBoundingClientRect();
    // If a click point is provided (comment-mode click), the pin sits at
    // exactly that point and we record a fractional offset within the
    // element so the same point survives reflow at other viewports.
    const hasPoint = typeof opts.x === 'number' && typeof opts.y === 'number';
    const px = hasPoint ? opts.x : Math.round(r.right);
    const py = hasPoint ? opts.y : Math.round(r.top);
    const anchor = buildAnchor(targetEl);
    if (hasPoint && r.width > 0 && r.height > 0) {
      anchor.offset = { fx: (px - r.left) / r.width, fy: (py - r.top) / r.height };
    }
    composerCtx = { anchor, rect: r, target: targetEl };

    // ghost pin at click position (or element top-right for legacy path)
    const ghostPin = el('button', { type: 'button', class: 'pin pin-dot act',
      style: { left: px + 'px', top: py + 'px' }
    });
    ghostPin.style.setProperty('--c', state.color);
    ghostPin.appendChild(el('span', { class: 'pin-dot-inner' }, '+'));
    layer.appendChild(ghostPin);

    // Provisional position; we clamp horizontally + vertically once the
    // popover renders and we know its real height.
    const POP_W = 332;
    const SAFE = 8;
    let popLeft = Math.max(SAFE, Math.min(px + 18, window.innerWidth  - POP_W - SAFE));
    let popTop  = Math.max(SAFE, py - 8);
    const pop = el('div', { class: 'cmp-pop', style: { left: popLeft + 'px', top: popTop + 'px' } });
    pop.appendChild(el('div', { class: 'cmp-pop-arrow' }));

    const head = el('div', { class: 'cmp-pop-head' },
      makeAv({ clientId: state.clientId, name: state.name, color: state.color }, { size: 20 }),
      el('span', { class: 'cmp-pop-name' }, state.name),
      el('span', { class: 'cmp-pop-meta' }, 'just now')
    );
    pop.appendChild(head);

    const ta = el('textarea', { class: 'cmp-pop-ta', rows: 3, placeholder: 'Leave a note for the team…' });
    pop.appendChild(ta);

    const cancelBtn = el('button', { type: 'button', class: 'cmp-pop-btn ghost' }, 'Cancel');
    cancelBtn.addEventListener('click', () => closeComposer());
    const sendBtn = el('button', { type: 'button', class: 'cmp-pop-btn primary', disabled: true });
    sendBtn.innerHTML = 'Send ' + ico('arrowR');
    sendBtn.addEventListener('click', () => submit(false));
    const askBtn = el('button', { type: 'button', class: 'cmp-pop-btn ask', disabled: true, title: 'Comment and hand it to the agent to act on (⇧⌘↵)' });
    askBtn.innerHTML = ico('agent') + ' Ask agent';
    askBtn.addEventListener('click', () => submit(true));
    ta.addEventListener('input', () => { sendBtn.disabled = askBtn.disabled = !ta.value.trim(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeComposer();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e.shiftKey);
    });

    pop.appendChild(el('div', { class: 'cmp-pop-foot' },
      el('span', { class: 'cmp-pop-hint' }, '⌘↵ send · ⇧⌘↵ ask agent'),
      el('div', { class: 'cmp-pop-btns' }, cancelBtn, askBtn, sendBtn)
    ));
    layer.appendChild(pop);
    composerNode = { pop, ghostPin };
    // Clamp vertical overflow now that we know the real popover height.
    requestAnimationFrame(() => {
      if (!pop.isConnected) return;
      const r = pop.getBoundingClientRect();
      if (r.bottom > window.innerHeight - SAFE) {
        // Try placing it ABOVE the click point first; if even that overflows
        // the top, just pin to the safe top.
        const above = py - 8 - r.height;
        const clamped = Math.max(SAFE, Math.min(window.innerHeight - r.height - SAFE, above));
        pop.style.top = clamped + 'px';
      }
    });
    setTimeout(() => ta.focus(), 30);

    async function submit(ask) {
      const body = ta.value.trim();
      if (!body) return;
      sendBtn.disabled = askBtn.disabled = true;
      try {
        const r = await api('/__c/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: SLUG, token: TOKEN, page: PAGE_PATH,
            anchor: composerCtx.anchor, comment: body, ask,
            clientId: state.clientId, name: state.name, email: state.email,
          }),
        });
        const j = await r.json();
        if (j.event) addCommentLocal(j.event);
        if (j.comment) {
          // Dedupe: the WS comment_added broadcast can arrive before this
          // HTTP response. addCommentLocal is a no-op if already pushed.
          addCommentLocal(j.comment);
          activePinId = j.comment.id;
          renderPins();
          renderAvatarBar();
          openPanel('comments');
          openThread(j.comment.id);
          celebrateFirstCommit();
        }
      } catch (e) { toast('comment failed: ' + e.message); }
      closeComposer();
    }
  }
  function closeComposer() {
    composerCtx = null;
    if (composerNode) {
      composerNode.pop.remove();
      composerNode.ghostPin.remove();
      composerNode = null;
    }
  }

  /* ──────────── inline edit ──────────── */

  function startEdit(targetEl) {
    if (!state.name) { openIdentifyModal().then(() => startEdit(targetEl)); return; }
    clearHover();
    if (editingCtx) commitEdit();
    if (targetEl.children.length > 0 && !hasOnlyInlineChildren(targetEl)) {
      toast('That element has nested content — pick a smaller one.');
      return;
    }
    const anchor = buildAnchor(targetEl);
    // Canonical text (with \n where <br> lived). On commit we re-extract via
    // elementToText, so we round-trip through the same representation.
    const original = elementToText(targetEl);
    const savedHTML = targetEl.innerHTML;
    editingCtx = { el: targetEl, anchor, original, savedContentEditable: targetEl.contentEditable, savedHTML };
    targetEl.contentEditable = 'true';
    targetEl.style.outline = `2px solid ${state.color}`;
    targetEl.style.outlineOffset = '2px';
    targetEl.focus();
    const sel = window.getSelection();
    if (sel) {
      try {
        const range = document.createRange();
        range.selectNodeContents(targetEl);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    }

    // Throttle edit_inflight to ~10 Hz. Previously fired per-keystroke; that
    // hammered the WS and made the editing-by-other indicator flicker on
    // remote clients. Trailing-edge ensures peers see the final keystroke.
    const INFLIGHT_THROTTLE_MS = 100;
    let inflightLast = 0;
    let inflightTimer = null;
    const flushInflight = () => {
      inflightLast = Date.now();
      if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
      sendWs({ t: 'edit_inflight', anchor, currentText: elementToText(targetEl).slice(0, 10000) });
    };
    // Broadcast immediately so peers see the "is editing" outline the
    // moment we click in — not only after the first keystroke.
    flushInflight();
    const onInput = () => {
      const since = Date.now() - inflightLast;
      if (since >= INFLIGHT_THROTTLE_MS) flushInflight();
      else if (!inflightTimer) inflightTimer = setTimeout(flushInflight, INFLIGHT_THROTTLE_MS - since);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Restore the saved DOM (preserves any inline children like <br>).
        targetEl.innerHTML = editingCtx?.savedHTML ?? original;
        targetEl.blur();
      }
      if (e.key === 'Enter' && !e.shiftKey && targetEl.tagName !== 'TEXTAREA') {
        e.preventDefault();
        if (editingCtx) editingCtx.ask = e.metaKey || e.ctrlKey;
        targetEl.blur();
      }
    };
    const onBlur = () => {
      if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
      targetEl.removeEventListener('input', onInput);
      targetEl.removeEventListener('keydown', onKey);
      targetEl.removeEventListener('blur', onBlur);
      targetEl.removeEventListener('paste', onPaste);
      commitEdit();
    };
    // Force plain-text paste. Without this, browsers paste the source
    // formatting (background colors, fonts, custom spans) which polluted
    // the host page's typography. We grab the clipboard's text/plain and
    // insert it as a text node, preserving newlines as \n.
    const onPaste = (ev) => {
      ev.preventDefault();
      const text = (ev.clipboardData || window.clipboardData)?.getData('text/plain') || '';
      if (!text) return;
      // execCommand integrates with the contenteditable's native undo stack;
      // a manual range.insertNode() would break Cmd+Z for the rest of the edit.
      // Build HTML so newlines round-trip as <br> (matches elementToText).
      const html = text.split('\n').map((p, i) => (i > 0 ? '<br>' : '') + escapeHtml(p)).join('');
      try { document.execCommand('insertHTML', false, html); } catch {}
      onInput();
    };
    targetEl.addEventListener('input', onInput);
    targetEl.addEventListener('keydown', onKey);
    targetEl.addEventListener('blur', onBlur);
    targetEl.addEventListener('paste', onPaste);
  }
  function hasOnlyTextChildren(node) {
    return [...node.childNodes].every((n) => n.nodeType === 3 || n.nodeType === 8);
  }
  // Tags treated as inline-only formatting we can safely flatten into a
  // \n-separated string for editing. Anything else is a block child and the
  // user should pick a smaller target.
  const INLINE_EDIT_TAGS = new Set([
    'span','em','strong','a','br','i','b','u','code','small','sub','sup',
    'time','mark','abbr','q','cite','dfn','wbr','s','del','ins',
  ]);
  function hasOnlyInlineChildren(node) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3 || n.nodeType === 8) continue;
      if (n.nodeType !== 1) return false;
      if (!INLINE_EDIT_TAGS.has(n.tagName.toLowerCase())) return false;
    }
    return true;
  }
  // Convert an element with text + <br>/<span>/etc. inline children into a
  // plain string. <br> becomes \n; other inline elements contribute their
  // textContent. Used to seed the contenteditable buffer.
  function elementToText(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'br') out += '\n';
        else out += elementToText(n);
      }
    }
    return out;
  }
  // Apply a text value (with possible \n) back to an element. Splits on \n
  // and creates text nodes interleaved with <br> — preserves layout without
  // using innerHTML (no XSS risk).
  function applyText(target, text) {
    if (text == null) text = '';
    while (target.firstChild) target.removeChild(target.firstChild);
    const parts = String(text).split('\n');
    parts.forEach((p, i) => {
      if (i > 0) target.appendChild(document.createElement('br'));
      if (p.length > 0) target.appendChild(document.createTextNode(p));
    });
  }
  // Used by edit mode's hover filter. An element is "editable" if its visible
  // text content is non-empty AND its children are limited to text + inline
  // tags (br, span, em, etc.) — those round-trip cleanly via the \n-with-br
  // representation.
  function isEditable(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node === document.body || node === document.documentElement) return false;
    if (node.id === '__commenter' || node.closest?.('#__commenter')) return false;
    const text = (node.textContent || '').trim();
    if (text.length === 0) return false;
    return node.children.length === 0 || hasOnlyInlineChildren(node);
  }
  async function commitEdit() {
    const ctx = editingCtx;
    if (!ctx) return;
    editingCtx = null;
    const { el: target, anchor, original } = ctx;
    target.contentEditable = ctx.savedContentEditable || 'inherit';
    target.style.outline = '';
    target.style.outlineOffset = '';
    sendWs({ t: 'cursor_blur' });
    // Extract via elementToText so any <br> children round-trip as \n.
    const newText = elementToText(target);
    if (newText === original) {
      // No real change but the contenteditable may have lightly mutated the
      // DOM (e.g., browser inserted <div> wrappers on focus). Restore the
      // saved HTML so the element looks exactly as it did before.
      if (ctx.savedHTML !== undefined) target.innerHTML = ctx.savedHTML;
      return;
    }
    // Reflect the new text canonically (text + <br>) in the live DOM. The
    // server-broadcast edit_committed will apply the same on every peer.
    applyText(target, newText);
    try {
      const r = await api('/__c/api/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: SLUG, token: TOKEN, page: PAGE_PATH,
          anchor, originalText: original, newText, ask: !!ctx.ask,
          clientId: state.clientId, name: state.name, email: state.email,
        }),
      });
      const j = await r.json();
      if (j.edit) {
        target.dataset.cEdited = '1';
        edits = edits.filter((e) => e.anchor_json !== j.edit.anchor_json);
        edits.push(j.edit);
        editsByAnchor.set(j.edit.anchor_json, j.edit);
        renderChangedBadges();
        renderAvatarBar();
        applyAskEvent('edit', j.event);
        toast(j.event ? 'Edit saved · sent to the agent' : 'Edit saved');
        celebrateFirstCommit();
      }
    } catch (e) { toast('edit failed: ' + e.message); }
  }

  /* ──────────── changed badges ──────────── */

  // Reuse wrap elements across re-positions instead of wiping & rebuilding.
  // Wiping caused two issues: (a) the cm-badge-in keyframe re-fired every
  // frame, making the badge bounce-animate while scrolling, and (b) any
  // sub-pixel layout shift caused a visible jump between renders.
  const badgeWraps = new Map(); // anchor_json → { wrap, target, edit }

  // Use the actual rendered text rect (Range API) instead of the element's
  // outer bounding box, so badges sit next to the *text*, not at the right
  // edge of a wide block container that has text on the opposite side.
  function textRectOf(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return r;
    } catch {}
    return el.getBoundingClientRect();
  }

  // Pick a horizontal anchor near the visible text based on text-align.
  function badgePosition(el) {
    const r = textRectOf(el);
    let align = 'start';
    try { align = (getComputedStyle(el).textAlign || 'start').toLowerCase(); } catch {}
    let x;
    if (align === 'right' || align === 'end')          x = r.right;
    else if (align === 'center')                       x = r.left + r.width / 2;
    else                                               x = r.right; // left/start/justify: end of text
    return { x, y: r.top - 6 };
  }

  function buildBadgeWrap(e, target) {
    const anchorJson = e.anchor_json;
    const color = colorOf(e.author_client_id);
    const wrap = el('div', { class: 'cb-wrap' });
    wrap.style.setProperty('--c', color);
    const pill = el('div', { class: 'cb-pill' });
    pill.style.setProperty('--c', color);
    pill.appendChild(el('span', { class: 'cb-pill-dot', style: { background: color } }));
    pill.appendChild(el('span', { class: 'cb-pill-text' }, 'changed'));
    wrap.appendChild(pill);

    function renderEntry(ed) {
      // System event row (resolved / reopened) — compact line, no diff
      if (ed.event) return eventRow(ed, 'edit');
      const entry = el('div', { class: 'cb-pop-entry' });
      const entryColor = colorOf(ed.author_client_id);
      entry.appendChild(el('div', { class: 'cb-pop-head' },
        makeAv({ clientId: ed.author_client_id, name: ed.author_name, color: entryColor }, { size: 18 }),
        el('span', { class: 'cb-pop-name' }, ed.author_name || 'anon'),
        el('span', { class: 'cb-pop-time' }, timeAgo(ed.created_at))
      ));
      const ops = diffOps(ed.original_text, ed.new_text);
      const diff = el('div', { class: 'cb-pop-diff' });
      const oldRow = el('div', { class: 'cb-pop-row cb-pop-old' },
        el('span', { class: 'cb-pop-mark' }, '−')
      );
      const oldText = el('span', { class: 'cb-pop-text' });
      appendDiff(oldText, ops, 'old', 'cb-tok-');
      oldRow.appendChild(oldText);
      diff.appendChild(oldRow);
      const newRow = el('div', { class: 'cb-pop-row cb-pop-new' },
        el('span', { class: 'cb-pop-mark' }, '+')
      );
      const newText = el('span', { class: 'cb-pop-text' });
      appendDiff(newText, ops, 'new', 'cb-tok-');
      newRow.appendChild(newText);
      diff.appendChild(newRow);
      entry.appendChild(diff);
      return entry;
    }

    let pop = null;
    const showPop = () => {
      if (pop) return;
      pop = el('div', { class: 'cb-pop' });
      const title = el('div', { class: 'cb-pop-title' },
        el('span', {}, 'History'),
        el('span', { class: 'cb-pop-count' }, '…'),
      );
      const list = el('div', { class: 'cb-pop-list' },
        el('span', { class: 'cb-pop-loading' }, 'Loading history…'),
      );
      // Resolve / Reopen — same pattern as comment threads. The button label
      // depends on the current state of REAL edit rows at this anchor (event
      // rows excluded). The action flips status for all real rows and adds a
      // system event row.
      const realAtAnchor = edits.filter((x) => !x.event && x.anchor_json === anchorJson);
      let allResolved = realAtAnchor.length > 0 && realAtAnchor.every((x) => x.status === 'resolved');
      const resolveBtn = el('button', { type: 'button', class: 'cb-pop-btn primary' });
      const setResolveBtnLabel = () => {
        resolveBtn.innerHTML = ico(allResolved ? 'undo' : 'check') + ` ${allResolved ? 'Reopen' : 'Resolve'}`;
      };
      setResolveBtnLabel();
      resolveBtn.addEventListener('click', async () => {
        // Optimistic UI: flip the label/state right away so the user sees
        // immediate feedback. applyEditThreadStatus on response confirms it
        // and refreshes the popover list (via the hide+show below).
        const wasResolved = allResolved;
        allResolved = !wasResolved;
        setResolveBtnLabel();
        await toggleResolveEdit(JSON.parse(anchorJson), e.page_path, !wasResolved);
        // Rebuild the popover so the new system event row shows up in the
        // history list and the count updates. The mouse is still on the
        // wrap, so the gracefully-deferred hide is harmless.
        if (pop) {
          pop.remove(); pop = null;
          showPopCancelHide();
        }
      });
      // Edit — re-enter inline edit mode on this element directly from the
      // popover (no need to hover-and-click the toolbar).
      const editBtn = el('button', { type: 'button', class: 'cb-pop-btn' });
      editBtn.innerHTML = ico('edit') + ' Edit';
      editBtn.addEventListener('click', () => {
        const t = resolveAnchor(JSON.parse(anchorJson));
        if (!t) { toast('Element no longer on the page'); return; }
        if (pop) { pop.remove(); pop = null; }
        startEdit(t);
      });
      const askCtl = askControl(askOf(edits.filter((x) => x.anchor_json === anchorJson)),
        () => askAgent('edit', JSON.parse(anchorJson), e.page_path));
      const foot = el('div', { class: 'cb-pop-foot' }, editBtn, askCtl, resolveBtn);
      pop.appendChild(title);
      pop.appendChild(list);
      pop.appendChild(foot);
      wrap.appendChild(pop);

      // After the pop has a real bounding rect, flip it above the pill if
      // its bottom would overflow the viewport, and shift it horizontally
      // so neither edge clips. Re-runs after the history fetch grows it.
      const flipIfOverflow = () => {
        if (!pop) return;
        pop.classList.remove('cb-pop-up');
        // Reset any prior horizontal shift before measuring.
        pop.style.transform = '';
        let r = pop.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8 && r.height < window.innerHeight - 16) {
          pop.classList.add('cb-pop-up');
          r = pop.getBoundingClientRect();
        }
        // Horizontal clamp: shift via translateX delta on top of the existing
        // -50% center transform. The flipped class uses translate(-50%, -8px),
        // the default uses translate(-50%, 8px) — both keep -50% on X, so we
        // compose with a calc() add.
        let dx = 0;
        const SAFE = 8;
        if (r.left < SAFE) dx = SAFE - r.left;
        else if (r.right > window.innerWidth - SAFE) dx = (window.innerWidth - SAFE) - r.right;
        if (dx !== 0) {
          const ty = pop.classList.contains('cb-pop-up') ? '-8px' : '8px';
          pop.style.transform = `translate(calc(-50% + ${dx}px), ${ty})`;
        }
      };
      requestAnimationFrame(flipIfOverflow);

      // Track this fetch — discard if the pop closed before it returned.
      const myPop = pop;
      api(`/__c/api/edits/history?slug=${SLUG}&token=${TOKEN}&page=${encodeURIComponent(PAGE_PATH)}&anchor=${encodeURIComponent(anchorJson)}`)
        .then((r) => r.json())
        .then((j) => {
          if (myPop !== pop) return;
          const history = (j.edits || []).slice().reverse(); // newest first
          list.innerHTML = '';
          if (history.length === 0) {
            // Fall back to the current edit row (race with snapshot mid-fetch).
            list.appendChild(renderEntry(e));
            title.querySelector('.cb-pop-count').textContent = '1 edit';
            return;
          }
          for (const ed of history) list.appendChild(renderEntry(ed));
          // Count REAL edits only — exclude resolve/reopen event rows.
          const realCount = history.filter((x) => !x.event).length;
          title.querySelector('.cb-pop-count').textContent =
            realCount === 1 ? '1 edit' : `${realCount} edits`;
          // History now has its real height; recheck overflow.
          requestAnimationFrame(flipIfOverflow);
        })
        .catch(() => {
          if (myPop !== pop) return;
          list.innerHTML = '';
          list.appendChild(el('span', { class: 'cb-pop-loading' }, 'Could not load history.'));
        });
    };
    // The popover sits 8px below the pill (translate-Y), so the mouse
    // crossing the visible gap fires mouseleave on the wrap before
    // mouseenter on the popover. Without a grace window the popover
    // vanished before the user could click it. We defer the hide and
    // cancel it if the cursor enters the popover (or returns to the wrap).
    let hideTimer = null;
    const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
    const hidePop = () => { cancelHide(); if (pop) { pop.remove(); pop = null; } };
    const scheduleHide = () => { cancelHide(); hideTimer = setTimeout(() => { hideTimer = null; hidePop(); }, 250); };
    const _showPop = showPop;
    const showPopCancelHide = () => { cancelHide(); _showPop(); if (pop) {
      pop.addEventListener('mouseenter', cancelHide);
      pop.addEventListener('mouseleave', scheduleHide);
    } };
    wrap.addEventListener('mouseenter', showPopCancelHide);
    wrap.addEventListener('mouseleave', (ev) => {
      if (wrap.contains(ev.relatedTarget)) return; // moved into a child of wrap
      scheduleHide();
    });
    // Programmatic open used by the sidebar's "Reveal" button: shows the
    // popover without a hover, then auto-closes after `autoMs` UNLESS the
    // user moves their mouse over the wrap or pop in the meantime — at
    // which point normal hover handling takes over.
    wrap.__pinShow = (autoMs = 5000) => {
      showPopCancelHide();
      let autoTimer = setTimeout(() => {
        autoTimer = null;
        // Don't close if the user is currently engaging with it.
        if (wrap.matches?.(':hover') || pop?.matches?.(':hover')) return;
        hidePop();
      }, autoMs);
      const cancelAuto = () => { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } };
      wrap.addEventListener('mouseenter', cancelAuto, { once: true });
      pop?.addEventListener('mouseenter', cancelAuto, { once: true });
    };
    return wrap;
  }

  function renderChangedBadges() {
    // Don't suppress on hover — DOM removal would re-fire the entry
    // animation when un-hovering, so the badge looked like it was jumping.
    // The toolbar lives at z-index 50 and the badge at 45, so the toolbar
    // simply overlays the badge during hover (no click conflict).
    const seen = new Set();

    // Cross-page filter: only badge anchors for the current page. Find the
    // LATEST real edit per anchor (skip event rows). The "resolved" state
    // is per-anchor — we compute it by checking ALL real rows at that anchor.
    const latestByAnchor = new Map();
    const allByAnchor = new Map();
    for (const e of edits) {
      if (e.event) continue;
      if (e.page_path && e.page_path !== PAGE_PATH) continue;
      const prev = latestByAnchor.get(e.anchor_json);
      if (!prev || e.created_at > prev.created_at) latestByAnchor.set(e.anchor_json, e);
      if (!allByAnchor.has(e.anchor_json)) allByAnchor.set(e.anchor_json, []);
      allByAnchor.get(e.anchor_json).push(e);
    }
    const resolvedAnchors = new Set();
    for (const [k, list] of allByAnchor) {
      if (list.every((x) => x.status === 'resolved')) resolvedAnchors.add(k);
    }

    for (const e of latestByAnchor.values()) {
      const anchor = JSON.parse(e.anchor_json);
      const target = resolveAnchor(anchor);
      if (!target) continue;
      const { x, y } = badgePosition(target);
      // If a comment pin shares this anchor, lift the badge so it stacks
      // above the pin rather than overlapping the upper half of it.
      const yOffset = pinEntries.has(e.anchor_json) ? -18 : 0;

      let entry = badgeWraps.get(e.anchor_json);
      if (!entry || entry.target !== target) {
        // Create new wrap (or replace if target element changed)
        if (entry) entry.wrap.remove();
        const wrap = buildBadgeWrap(e, target);
        layer.appendChild(wrap);
        entry = { wrap, target, edit: e };
        badgeWraps.set(e.anchor_json, entry);
      }
      // Round to whole pixels — sub-pixel re-positions caused visible jitter
      // when the host site had a font/layout shift mid-scroll.
      entry.wrap.style.left = Math.round(x) + 'px';
      entry.wrap.style.top  = Math.round(y + yOffset) + 'px';
      entry.wrap.classList.toggle('cb-resolved', resolvedAnchors.has(e.anchor_json));
      seen.add(e.anchor_json);
    }
    // Remove badges whose edit is no longer present
    for (const [k, entry] of badgeWraps) {
      if (!seen.has(k)) {
        entry.wrap.remove();
        badgeWraps.delete(k);
      }
    }
  }

  // Resolve / Reopen at anchor scope. Mirrors toggleResolve for comments.
  // The page text isn't touched — this is a status flag plus a system event
  // row recording who flipped it.
  async function toggleResolveEdit(anchor, pagePath, resolve) {
    if (!state.name) { openIdentifyModal().then(() => toggleResolveEdit(anchor, pagePath, resolve)); return; }
    const path = resolve ? 'resolve' : 'reopen';
    try {
      const r = await api(`/__c/api/edits/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: SLUG, token: TOKEN, page: pagePath || PAGE_PATH, anchor,
          clientId: state.clientId, name: state.name, email: state.email,
        }),
      });
      const j = await r.json();
      if (j.affected) {
        applyEditThreadStatus({
          anchor_json: JSON.stringify(anchor),
          page: pagePath || PAGE_PATH,
          edits: j.affected,
          event: j.event,
        });
      }
    } catch (e) { toast(`${path} failed`); }
  }
  function applyEditThreadStatus({ anchor_json, edits: serverEdits, event }) {
    // Replace our entries for this anchor with the server's authoritative
    // list (statuses now flipped), then add the new event row.
    const seen = new Set((serverEdits || []).map((x) => x.id));
    edits = edits.filter((e) => e.anchor_json !== anchor_json || !seen.has(e.id));
    for (const e of serverEdits || []) edits.push(e);
    if (event && !edits.some((e) => e.id === event.id)) edits.push(event);
    // Refresh editsByAnchor for current page (latest real edit per anchor).
    editsByAnchor = new Map();
    for (const e of edits) {
      if (e.event) continue;
      if (e.page_path && e.page_path !== PAGE_PATH) continue;
      const prev = editsByAnchor.get(e.anchor_json);
      if (!prev || e.created_at > prev.created_at) editsByAnchor.set(e.anchor_json, e);
    }
    renderChangedBadges();
    renderAvatarBar();
    if (panelOpen) renderPanel();
  }

  /* ──────────── side panel ──────────── */

  let panelNode = null;
  function ensurePanel() {
    if (panelNode) return panelNode;
    const aside = el('aside', { class: 'sp', 'data-c-no': '' });
    layer.appendChild(aside);
    panelNode = aside;
    return aside;
  }

  function openPanel(tabOrMode) {
    if (tabOrMode === 'comments' || tabOrMode === 'edits') {
      panelTab = tabOrMode;
      panelMode = 'list';
      activePinId = null;
    }
    panelOpen = true;
    renderPanel();
    requestAnimationFrame(() => panelNode.classList.add('in'));
  }
  function closePanel() {
    panelOpen = false;
    panelNode?.classList.remove('in');
  }
  function openThread(commentId) {
    // If the target comment lives on another page, navigate there with a
    // sessionStorage marker so the boot of that page reopens this thread.
    const target = comments.find((c) => c.id === commentId);
    if (target && target.page_path && target.page_path !== PAGE_PATH) {
      try { sessionStorage.setItem('__commenter_open_thread', JSON.stringify({ commentId, ts: Date.now() })); } catch {}
      location.href = PROXY_BASE + target.page_path;
      return;
    }
    activePinId = commentId;
    panelMode = 'thread';
    panelTab = 'comments';
    panelOpen = true;
    renderPanel();
    requestAnimationFrame(() => panelNode.classList.add('in'));
    renderPins();
  }

  function renderPanel() {
    const aside = ensurePanel();
    aside.innerHTML = '';

    // header
    const head = el('header', { class: 'sp-head' });
    if (panelMode === 'thread' && activePinId) {
      const back = el('button', { type: 'button', class: 'sp-back' });
      back.innerHTML = ico('arrowL') + '<span>All</span>';
      back.addEventListener('click', () => { panelMode = 'list'; activePinId = null; renderPanel(); renderPins(); });
      head.appendChild(back);
    } else {
      const tabs = el('div', { class: 'sp-tabs' });
      // Tab counts:
      //   - Comments: distinct threads (group by page+anchor; skip events).
      //   - Edits:    distinct elements edited (group by page+anchor; skip events).
      const commentThreads = new Set();
      for (const c of comments) {
        if (c.event) continue;
        commentThreads.add((c.page_path || '/') + ' ' + c.anchor_json);
      }
      const editAnchors = new Set();
      for (const e of edits) {
        if (e.event) continue;
        editAnchors.add((e.page_path || '/') + ' ' + e.anchor_json);
      }
      const cTab = el('button', { type: 'button', class: 'sp-tab' + (panelTab === 'comments' ? ' act' : '') });
      cTab.innerHTML = `Comments <span class="sp-tab-num">${commentThreads.size}</span>`;
      cTab.addEventListener('click', () => { panelTab = 'comments'; renderPanel(); });
      const eTab = el('button', { type: 'button', class: 'sp-tab' + (panelTab === 'edits' ? ' act' : '') });
      eTab.innerHTML = `Edits <span class="sp-tab-num">${editAnchors.size}</span>`;
      eTab.addEventListener('click', () => { panelTab = 'edits'; renderPanel(); });
      tabs.appendChild(cTab);
      tabs.appendChild(eTab);
      head.appendChild(tabs);
    }
    const right = el('div', { class: 'sp-head-right' });
    const closeBtn = el('button', { type: 'button', class: 'sp-icon-btn', title: 'Close' });
    closeBtn.innerHTML = ico('x');
    closeBtn.addEventListener('click', () => closePanel());
    right.appendChild(closeBtn);
    head.appendChild(right);
    aside.appendChild(head);

    // body
    if (panelMode === 'thread' && activePinId) {
      aside.appendChild(renderThreadView(activePinId));
    } else if (panelTab === 'comments') {
      if (comments.filter((c) => !c.event).length === 0) aside.appendChild(renderEmpty('comments'));
      else aside.appendChild(renderCommentList());
    } else {
      if (edits.filter((e) => !e.event).length === 0) aside.appendChild(renderEmpty('edits'));
      else aside.appendChild(renderEditList());
    }

    // footer
    const liveCount = roster.filter((r) => r.clientId !== state.clientId).length + 1;
    aside.appendChild(el('footer', { class: 'sp-foot' },
      el('div', { class: 'sp-foot-l' },
        el('span', { class: 'sp-foot-dot' }),
        el('span', {}, `Live · ${liveCount} reviewer${liveCount === 1 ? '' : 's'}`)
      ),
      el('span', { class: 'sp-foot-meta' }, location.host)
    ));
  }

  function renderCommentList() {
    const body = el('div', { class: 'sp-body' });
    // Cross-page list: group by (page_path + anchor_json) so the same selector
    // on different pages stays distinct.
    const groups = new Map();
    for (const c of comments) {
      if (c.event) continue;
      const k = (c.page_path || '/') + ' ' + c.anchor_json;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => groups.get(a)[0].created_at - groups.get(b)[0].created_at);
    keys.forEach((k, i) => {
      const group = groups.get(k);
      const head = group[0];
      const anchor = JSON.parse(head.anchor_json);
      const allResolved = group.every((c) => c.status === 'resolved');
      const onOtherPage = head.page_path && head.page_path !== PAGE_PATH;
      const item = el('button', { type: 'button',
        class: 'sp-item' + (allResolved ? ' resolved' : '') + (onOtherPage ? ' other-page' : ''),
      });
      // Resolved pins show a check; open pins show their number.
      const pin = el('div', { class: 'sp-item-pin' });
      if (allResolved) {
        const checkSpan = el('span', { class: 'sp-item-pin-check' });
        checkSpan.innerHTML = ico('check');
        pin.appendChild(checkSpan);
      } else {
        pin.appendChild(el('span', { class: 'sp-item-pin-num' }, String(i + 1)));
      }
      const bodyDiv = el('div', { class: 'sp-item-body' });
      bodyDiv.appendChild(el('div', { class: 'sp-item-head' },
        makeAv({ clientId: head.author_client_id, name: head.author_name, color: colorOf(head.author_client_id) }, { size: 18 }),
        el('span', { class: 'sp-item-name' }, head.author_name || 'anon'),
        el('span', { class: 'sp-item-time' }, timeAgo(head.created_at))
      ));
      bodyDiv.appendChild(el('div', { class: 'sp-item-text' }, head.body));
      const meta = el('div', { class: 'sp-item-meta' });
      // Show the page (humans recognize "/about", not "h1.text-color-white").
      const pageLabel = el('span', { class: 'sp-item-page' });
      pageLabel.innerHTML = `on <code>${escapeHtml(head.page_path || '/')}</code>`;
      meta.appendChild(pageLabel);
      if (group.length > 1) meta.appendChild(el('span', { class: 'sp-item-replies' }, `${group.length - 1} repl${group.length - 1 === 1 ? 'y' : 'ies'}`));
      if (allResolved) meta.appendChild(el('span', { class: 'sp-item-resolved' }, 'Resolved'));
      const ask = askOf(comments.filter((c) => c.page_path === head.page_path && c.anchor_json === head.anchor_json));
      if (ask) meta.appendChild(askChip(ask));
      bodyDiv.appendChild(meta);
      item.appendChild(pin);
      item.appendChild(bodyDiv);
      item.addEventListener('click', () => openThread(head.id));
      body.appendChild(item);
    });
    return body;
  }

  function renderEditList() {
    const body = el('div', { class: 'sp-body' });
    // Filter out system event rows (resolved/reopened) — they're rendered
    // inline in the popover history, not as standalone list items.
    // Group multiple edits at the same (page, anchor) into ONE entry. The
    // entry shows the first→latest diff (so the reader sees the net effect)
    // plus a count of how many edits happened along the way.
    const realEdits = edits.filter((e) => !e.event);
    const groupsByAnchor = new Map();
    for (const e of realEdits) {
      const k = (e.page_path || '/') + ' ' + e.anchor_json;
      if (!groupsByAnchor.has(k)) groupsByAnchor.set(k, []);
      groupsByAnchor.get(k).push(e);
    }
    // Sort each group oldest→newest, then sort groups by their LATEST edit's
    // time (newest groups first overall).
    const entries = [...groupsByAnchor.values()]
      .map((g) => g.slice().sort((a, b) => a.created_at - b.created_at))
      .sort((a, b) => b[b.length - 1].created_at - a[a.length - 1].created_at);
    entries.forEach((group) => {
      const first = group[0];
      const latest = group[group.length - 1];
      const anchor = JSON.parse(latest.anchor_json);
      const onOtherPage = latest.page_path && latest.page_path !== PAGE_PATH;
      const allResolved = group.every((x) => x.status === 'resolved');
      const wrap = el('div', { class: 'sp-edit' + (onOtherPage ? ' other-page' : '') + (allResolved ? ' resolved' : '') });
      const head = el('div', { class: 'sp-edit-head' },
        makeAv({ clientId: latest.author_client_id, name: latest.author_name, color: colorOf(latest.author_client_id) }, { size: 18 }),
        el('span', { class: 'sp-item-name' }, latest.author_name || 'anon'),
        el('span', { class: 'sp-item-time' }, timeAgo(latest.created_at)),
      );
      const pageLabel = el('span', { class: 'sp-edit-page' });
      pageLabel.innerHTML = `on <code>${escapeHtml(latest.page_path || '/')}</code>`;
      head.appendChild(pageLabel);
      if (group.length > 1) head.appendChild(el('span', { class: 'sp-edit-count' }, `${group.length} edits`));
      if (allResolved) head.appendChild(el('span', { class: 'sp-item-resolved' }, 'Resolved'));
      wrap.appendChild(head);

      // Diff = first.original_text → latest.new_text (the net change).
      const diff = el('div', { class: 'sp-edit-diff' });
      const ops = diffOps(first.original_text, latest.new_text);
      const oldRow = el('div', { class: 'sp-diff-row sp-diff-old' },
        el('span', { class: 'sp-diff-mark' }, '−')
      );
      const oldT = el('span', { class: 'sp-diff-text' });
      appendDiff(oldT, ops, 'old', 'sp-tok-');
      oldRow.appendChild(oldT);
      diff.appendChild(oldRow);
      const newRow = el('div', { class: 'sp-diff-row sp-diff-new' },
        el('span', { class: 'sp-diff-mark' }, '+')
      );
      const newT = el('span', { class: 'sp-diff-text' });
      appendDiff(newT, ops, 'new', 'sp-tok-');
      newRow.appendChild(newT);
      diff.appendChild(newRow);
      wrap.appendChild(diff);

      const actions = el('div', { class: 'sp-edit-actions' });
      const reveal = el('button', { type: 'button', class: 'sp-edit-act' });
      reveal.innerHTML = ico('arrowR') + ' Reveal';
      reveal.addEventListener('click', () => {
        if (onOtherPage) {
          // Hand off across navigation: store a marker so the destination
          // page's snapshot-load resumes the reveal (scroll + popover).
          try {
            sessionStorage.setItem('__commenter_reveal_edit', JSON.stringify({
              anchor_json: latest.anchor_json, ts: Date.now(),
            }));
          } catch {}
          location.href = PROXY_BASE + latest.page_path;
          return;
        }
        const t = resolveAnchor(anchor);
        if (!t) return;
        // The sidebar would otherwise cover the popover after we open it;
        // close it so the user actually sees what they revealed.
        closePanel();
        t.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => {
          const entry = badgeWraps.get(latest.anchor_json);
          entry?.wrap?.__pinShow?.(5000);
        }, 600);
      });
      const resolveAct = el('button', { type: 'button', class: 'sp-edit-act' });
      resolveAct.innerHTML = ico(allResolved ? 'undo' : 'check') + (allResolved ? ' Reopen' : ' Resolve');
      resolveAct.addEventListener('click', () => toggleResolveEdit(anchor, latest.page_path, !allResolved));
      actions.appendChild(reveal);
      actions.appendChild(askControl(askOf(edits.filter((x) => x.anchor_json === latest.anchor_json && x.page_path === latest.page_path)),
        () => askAgent('edit', anchor, latest.page_path)));
      actions.appendChild(resolveAct);
      wrap.appendChild(actions);
      body.appendChild(wrap);
    });
    return body;
  }

  function renderThreadView(commentId) {
    const groups = commentsByAnchor();           // for pin index (real comments only)
    const fullGroups = threadByAnchor();         // for thread render (incl. events)
    const keys = [...groups.keys()].sort((a, b) => groups.get(a)[0].created_at - groups.get(b)[0].created_at);
    let groupKey = null, idx = -1;
    for (let i = 0; i < keys.length; i++) {
      const arr = fullGroups.get(keys[i]) || [];
      if (arr.some((c) => c.id === commentId)) { groupKey = keys[i]; idx = i; break; }
    }
    if (!groupKey) return renderEmpty('comments');
    const realGroup = groups.get(groupKey);
    const fullGroup = fullGroups.get(groupKey);
    const anchor = JSON.parse(groupKey);

    const body = el('div', { class: 'sp-body sp-thread' });
    const head = el('div', { class: 'sp-thread-head' });
    head.appendChild(el('span', { class: 'sp-thread-num' }, '#' + (idx + 1)));
    const tgt = el('span', { class: 'sp-thread-target' });
    const pagePath = (realGroup[0] || fullGroup[0])?.page_path || PAGE_PATH;
    tgt.innerHTML = `on <code>${escapeHtml(pagePath)}</code>`;
    head.appendChild(tgt);
    const allResolved = realGroup.length > 0 && realGroup.every((c) => c.status === 'resolved');
    const resolveBtn = el('button', { type: 'button', class: 'sp-thread-resolve' });
    resolveBtn.innerHTML = ico('check') + ` ${allResolved ? 'Reopen' : 'Resolve'}`;
    resolveBtn.addEventListener('click', () => toggleResolve(realGroup, !allResolved));
    head.appendChild(askControl(askOf(fullGroup), () => askAgent('comment', anchor, pagePath)));
    head.appendChild(resolveBtn);
    body.appendChild(head);

    for (const m of fullGroup) {
      if (m.event) {
        // System event row — compact, italic, no body bubble.
        body.appendChild(eventRow(m, 'thread'));
        continue;
      }
      const msg = el('div', { class: 'sp-msg' });
      const head = el('div', { class: 'sp-msg-head' },
        makeAv({ clientId: m.author_client_id, name: m.author_name, color: colorOf(m.author_client_id) }, { size: 20 }),
        el('span', { class: 'sp-item-name' }, m.author_name || 'anon'),
        el('span', { class: 'sp-item-time' }, timeAgo(m.created_at))
      );
      // Anyone in the room can delete any comment.
      const delBtn = el('button', { type: 'button', class: 'sp-msg-del', title: 'Delete' });
      delBtn.innerHTML = ico('x');
      delBtn.addEventListener('click', () => deleteComment(m));
      head.appendChild(delBtn);
      msg.appendChild(head);
      msg.appendChild(el('div', { class: 'sp-msg-body' }, m.body));
      body.appendChild(msg);
    }

    const reply = el('div', { class: 'sp-reply' });
    reply.appendChild(makeAv({ clientId: state.clientId, name: state.name, color: state.color }, { size: 20 }));
    const ta = el('textarea', { class: 'sp-reply-ta', rows: 2, placeholder: `Reply to ${(realGroup[0]?.author_name || 'them').split(' ')[0]}…` });
    reply.appendChild(ta);
    const send = el('button', { type: 'button', class: 'sp-reply-send', disabled: true });
    send.innerHTML = ico('arrowR');
    const sendAsk = el('button', { type: 'button', class: 'sp-reply-ask', disabled: true, title: 'Reply and ask the agent to act (⇧⌘↵)' });
    sendAsk.innerHTML = ico('agent');
    ta.addEventListener('input', () => { send.disabled = sendAsk.disabled = !ta.value.trim(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitReply(e.shiftKey); });
    send.addEventListener('click', () => submitReply(false));
    sendAsk.addEventListener('click', () => submitReply(true));
    reply.appendChild(el('div', { class: 'sp-reply-btns' }, send, sendAsk));
    body.appendChild(reply);
    body.appendChild(el('div', { class: 'sp-reply-hint' }, '⌘↵ send · ⇧⌘↵ reply + ask agent'));

    async function submitReply(ask) {
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = sendAsk.disabled = true;
      try {
        const r = await api('/__c/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: SLUG, token: TOKEN, page: PAGE_PATH,
            anchor, comment: text, ask,
            clientId: state.clientId, name: state.name, email: state.email,
          }),
        });
        const j = await r.json();
        if (j.event) addCommentLocal(j.event);
        if (j.comment) {
          // Celebrate REGARDLESS of whether the WS broadcast already added
          // it (addCommentLocal dedupes); otherwise the celebration could
          // be skipped on the very first reply if WS arrives first.
          if (addCommentLocal(j.comment)) {
            renderPanel();
            renderPins();
            renderAvatarBar();
          }
          celebrateFirstCommit();
        }
      } catch (e) { toast('reply failed'); }
    }

    return body;
  }

  // Delete one comment. Open collaboration model — anyone can delete.
  async function deleteComment(comment) {
    if (!comment) return;
    try {
      const r = await api('/__c/api/comments/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: SLUG, token: TOKEN, commentId: comment.id }),
      });
      const j = await r.json();
      if (j.commentId) applyCommentDeleted({ commentId: j.commentId, anchor_json: comment.anchor_json });
    } catch { toast('delete failed'); }
  }
  function applyCommentDeleted({ commentId, anchor_json }) {
    comments = comments.filter((c) => c.id !== commentId);
    // If the active thread just lost its last real comment, fall back to list.
    const stillReal = comments.some((c) => c.anchor_json === anchor_json && !c.event && c.id);
    if (panelMode === 'thread' && activePinId === commentId) {
      if (stillReal) {
        const next = comments.find((c) => c.anchor_json === anchor_json && !c.event);
        activePinId = next ? next.id : null;
      } else {
        panelMode = 'list';
        activePinId = null;
      }
    }
    renderPins();
    renderChangedBadges();
    renderAvatarBar();
    if (panelOpen) renderPanel();
  }

  async function toggleResolve(group, resolve) {
    if (!state.name) { openIdentifyModal().then(() => toggleResolve(group, resolve)); return; }
    if (group.length === 0) return;
    const anchor = JSON.parse(group[0].anchor_json);
    const path = resolve ? 'resolve' : 'reopen';
    try {
      const r = await api(`/__c/api/comments/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: SLUG, token: TOKEN, page: PAGE_PATH, anchor,
          clientId: state.clientId, name: state.name, email: state.email,
        }),
      });
      const j = await r.json();
      if (j.affected) {
        const anchorJson = group[0].anchor_json;
        mergeAnchorComments(anchorJson, j.affected);
        if (j.event) addCommentLocal(j.event);
        renderPanel();
        renderPins();
        renderAvatarBar();
      }
    } catch (e) { toast(`${path} failed`); }
  }

  function renderEmpty(what) {
    const wrap = el('div', { class: 'sp-empty' });
    const art = el('div', { class: 'sp-empty-art' });
    [0, 1, 2].forEach((d) => {
      const dot = el('span', { class: 'sp-empty-dot' });
      dot.style.setProperty('--d', String(d));
      art.appendChild(dot);
    });
    wrap.appendChild(art);
    wrap.appendChild(el('div', { class: 'sp-empty-title' }, `No ${what} yet`));
    wrap.appendChild(el('div', { class: 'sp-empty-body' },
      what === 'comments'
        ? 'Hover any element on the page and click + to drop the first pin.'
        : 'Edits show up here the moment a teammate commits a change.'));
    const hint = el('div', { class: 'sp-empty-hint' });
    hint.innerHTML = '<kbd>C</kbd> to start a comment · <kbd>E</kbd> to enter edit mode';
    wrap.appendChild(hint);
    return wrap;
  }

  /* ──────────── follow mode + live cursors ──────────── */

  function startFollow(user) {
    if (!user) return;
    cancelFollow(); // clear any prior
    followCtx = { user, phase: 'arriving' };
    resetFollowTracking();
    renderFollow();
    // Navigate if needed, then scroll to their viewport position
    if (user.page && user.page !== PAGE_PATH) {
      // store intent before nav (we lose state)
      try { sessionStorage.setItem('__commenter_follow', JSON.stringify({ clientId: user.clientId, ts: Date.now() })); } catch {}
      location.href = PROXY_BASE + user.page;
      return;
    }
    // Glide to their viewport via computeFollowTarget so the same logic
    // (anchor → extrapolate → absolute) is applied for the initial jump.
    const initial = computeFollowTarget({ scrollAnchor: user.scrollAnchor, scroll: user.scroll });
    if (initial) smoothScrollTo(initial.x, initial.y);
    setTimeout(() => {
      if (followCtx?.user.clientId === user.clientId) {
        followCtx.phase = 'watching';
        renderFollow();
      }
    }, 520);
  }
  function cancelFollow() {
    followCtx = null;
    resetFollowTracking();
    layer.querySelectorAll('.fm-scrim, .fm-banner, .fm-cursor').forEach((n) => n.remove());
  }
  function renderFollow() {
    layer.querySelectorAll('.fm-scrim, .fm-banner, .fm-cursor').forEach((n) => n.remove());
    if (!followCtx) return;
    const { user, phase } = followCtx;
    const scrim = el('div', { class: 'fm-scrim fm-' + phase });
    ['t', 'r', 'b', 'l'].forEach((d) => {
      const e = el('div', { class: 'fm-edge fm-edge-' + d });
      e.style.setProperty('--c', user.color);
      scrim.appendChild(e);
    });
    layer.appendChild(scrim);

    const banner = el('div', { class: 'fm-banner fm-' + phase });
    const inner = el('div', { class: 'fm-banner-inner' });
    inner.style.setProperty('--c', user.color);
    inner.appendChild(makeAv(user, { size: 28 }));
    inner.appendChild(el('div', { class: 'fm-banner-text' },
      phase === 'arriving'
        ? el('div', { class: 'fm-banner-title', html: `Following <b>${escapeHtml(user.name || 'anon')}</b>…` })
        : el('div', { class: 'fm-banner-title', html: `Following <b>${escapeHtml(user.name || 'anon')}</b>` }),
      el('div', { class: 'fm-banner-sub' },
        phase === 'arriving' ? 'Jumping to their viewport' : 'Your view follows theirs · Esc to stop')
    ));
    const stop = el('button', { type: 'button', class: 'fm-banner-stop', title: 'Stop following' });
    stop.innerHTML = ico('x');
    stop.addEventListener('click', cancelFollow);
    inner.appendChild(stop);
    banner.appendChild(inner);
    layer.appendChild(banner);

    if (phase === 'arriving') {
      const cur = el('div', { class: 'fm-cursor', style: { left: '60%', top: '30%' }});
      cur.style.setProperty('--c', user.color);
      cur.appendChild(el('div', { class: 'fm-cursor-ring' }));
      cur.appendChild(el('div', { class: 'fm-cursor-dot', style: { background: user.color } }));
      cur.appendChild(el('div', { class: 'fm-cursor-label', style: { background: user.color } }, user.name || 'anon'));
      layer.appendChild(cur);
    }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Priority cascade — close exactly one thing per Escape press:
      //   composer > follow > popover > panel > tool deselect.
      if (composerCtx || composerNode) { closeComposer(); return; }
      if (followCtx) { cancelFollow(); return; }
      // Any open changed-pill popover (.cb-pop) inside our shadow.
      const openPop = layer.querySelector?.('.cb-pop');
      if (openPop) { openPop.remove(); return; }
      if (panelOpen) { closePanel(); return; }
      if (mode !== 'off') setMode(mode); // toggling current mode → off
      return;
    }
    // Letter shortcuts. Skip when typing in any input/textarea/contenteditable.
    // For the closed shadow root, composedPath() from a document-level
    // listener stops at the host, so we can't see our own textareas via
    // path inspection. Use the focusin/focusout flag for the in-overlay
    // case, plus check the host page's path for outside inputs.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (editingCtx) return;                // inline text edit in progress
    if (composerCtx || composerNode) return; // comment composer open
    if (typingInOverlay) return;             // sidebar reply / identify modal / etc.
    const path = e.composedPath?.() || [];
    for (const n of path) {
      if (!n || n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || n.isContentEditable) return;
    }
    if (!state.name) return;

    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      setMode('edit');
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      setMode('comment');
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      toggleDiffMode();
    }
  });

  /* ──────────── anchor-based cursor + scroll ──────────── */

  // Validation showed: broadcasting (pageX, pageY) directly is only ~7%
  // accurate when the viewer's viewport width differs from the sender's
  // (text reflows, so y=5000 maps to different content). Anchoring the
  // cursor to a DOM element + fractional offset within it raises that to
  // ~50% — and ~100% when an element is actually under the cursor. We
  // always carry pageX/pageY as a fallback for when the selector can't
  // resolve in the receiver's DOM.

  // Stable-ish CSS path. Doesn't have to be globally unique — just resolve
  // back to the same element via querySelector now. Capped at 600 chars
  // server-side. We skip our own overlay host when picking selectors.
  function quickSelector(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target === document.body) return 'body';
    if (target.id) return '#' + (window.CSS?.escape ? CSS.escape(target.id) : target.id.replace(/[^\w-]/g, ''));
    const parts = [];
    let cur = target;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((s) => s.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      if (parts.length > 10) break; // depth cap — selector stability degrades past this anyway
    }
    return parts.length ? parts.join(' > ') : null;
  }

  // Pick the smallest "anchor-worthy" element under (mx, my) viewport coords:
  // not too tiny to land on, not so big that fractional offset is meaningless.
  // Walk top-to-bottom of elementsFromPoint (smallest first), skip our host.
  function captureCursorAnchor(mx, my) {
    let stack = [];
    try {
      stack = (document.elementsFromPoint(mx, my) || [])
        .filter((e) => e && e.id !== '__commenter' && !e.closest?.('#__commenter'));
    } catch {}
    const VW = window.innerWidth, VH = window.innerHeight;
    // Cap anchor box size: small element → small reflow-amplification of
    // (fx, fy) on receivers whose layout differs. A 3000-tall section with
    // fy=0.4 puts the cursor wildly far on a viewer whose section reflows.
    // elementsFromPoint already gives deepest first, so we naturally try
    // leaf-most candidates before bubbling up.
    const MAX_H = Math.min(VH * 0.5, 240);
    const MAX_W = Math.min(VW * 0.85, 720);
    for (const el of stack) {
      if (el === document.documentElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 12) continue;
      if (r.width  > MAX_W) continue;
      if (r.height > MAX_H) continue;
      const sel = quickSelector(el);
      if (!sel) continue;
      return {
        sel,
        fx: (mx - r.left) / r.width,
        fy: (my - r.top)  / r.height,
        pageX: mx + window.scrollX,
        pageY: my + window.scrollY,
      };
    }
    // Fallback: fractional within body. r.top for body is already the
    // viewport-relative top (== -scrollY at the page level), so don't add
    // scrollY again — that double-counted and pushed the receiver's cursor
    // to the bottom of the viewport on long pages.
    const body = document.body;
    if (body) {
      const r = body.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return {
          sel: 'body',
          fx: (mx - r.left) / r.width,
          fy: (my - r.top)  / r.height,
          pageX: mx + window.scrollX,
          pageY: my + window.scrollY,
        };
      }
    }
    return { sel: null, fx: 0, fy: 0, pageX: mx + window.scrollX, pageY: my + window.scrollY };
  }

  // For follow-mode: identify the element currently at the top of the
  // sender's viewport and the gap (oy) between viewport top and element top.
  // Receiver scrolls so that the same element sits the same gap below their
  // viewport top, regardless of viewport width / reflow.
  function captureScrollAnchor() {
    const VW = window.innerWidth, VH = window.innerHeight;
    let stack = [];
    try {
      stack = (document.elementsFromPoint(VW / 2, 80) || [])
        .filter((e) => e && e.id !== '__commenter' && !e.closest?.('#__commenter'));
    } catch {}
    for (const el of stack) {
      if (el === document.documentElement || el === document.body) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 12 || r.width < 30) continue;
      if (r.height > VH * 1.5) continue; // ignore page-height containers
      const sel = quickSelector(el);
      if (!sel) continue;
      return { sel, oy: r.top };
    }
    return null;
  }

  // Resolve a cursor anchor to viewport coords on the receiver. Returns
  // null if anchor can't be resolved AND no fallback is usable.
  function projectCursor(c) {
    if (!c) return null;
    if (c.sel) {
      let el = null;
      try { el = document.querySelector(c.sel); } catch {}
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            pageX: r.left + window.scrollX + (c.fx || 0) * r.width,
            pageY: r.top  + window.scrollY + (c.fy || 0) * r.height,
          };
        }
      }
    }
    return { pageX: c.pageX || 0, pageY: c.pageY || 0 };
  }

  // Resolve a scroll anchor to a target page-Y. Returns null if can't.
  function projectScrollAnchor(s) {
    if (!s || !s.sel) return null;
    let el = null;
    try { el = document.querySelector(s.sel); } catch {}
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: 0, y: r.top + window.scrollY - (s.oy || 0) };
  }

  /* ──────────── follow-mode dead reckoning ────────────
     When the followee's anchor briefly fails to resolve in our DOM (their
     reference element scrolled off, or the selector doesn't match for a
     frame), naïvely falling back to absolute pixel scroll causes a visible
     reverse: their +30 in their viewport coords ≠ our +30 (different
     widths, different reflow), so the receiver jumps backwards while the
     sender is moving forwards.
     GPS analogy: when signal drops, don't jump to the last bad fix —
     extrapolate from your last good position along your last known
     velocity. When a new anchor arrives, smoothScrollTo gracefully merges. */
  const FOLLOW_HISTORY_MAX = 6;
  const FOLLOW_EXTRAPOLATE_CAP_MS = 1000;
  let followHistory = [];        // [{ y, t }] from successful anchor resolves
  let followLastTarget = null;
  function resetFollowTracking() { followHistory = []; followLastTarget = null; }
  function followVelocity() {
    if (followHistory.length < 2) return 0;
    const a = followHistory[0];
    const b = followHistory[followHistory.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return (b.y - a.y) / dt; // px / ms
  }
  function computeFollowTarget(f) {
    const now = Date.now();
    const anchorPos = projectScrollAnchor(f.scrollAnchor);
    // Fraction-based target: sender's scrollY / their max-scroll, mapped onto
    // our max-scroll. Pinned sections (GSAP ScrollTrigger and similar) hold a
    // single DOM element at viewport-top for a long scroll range, so the
    // anchor target sits still while the sender keeps advancing — the
    // follower stays "stuck before" then "jumps to after". The fraction
    // advances smoothly across the pin spacer because document.scrollHeight
    // includes the spacer's extra height; mapping that fraction to our own
    // scrollHeight pulls the follower through the animation.
    const maxScroll = Math.max(1, (document.documentElement.scrollHeight || 0) - window.innerHeight);
    const fracY = (typeof f.scrollFrac === 'number') ? f.scrollFrac * maxScroll : null;
    if (anchorPos && fracY !== null) {
      // When the fraction says the sender is much further along than the
      // anchor projects, trust the fraction — anchor is stalled by a pin.
      // Threshold a bit larger than typical reflow drift across viewports.
      const useFrac = Math.abs(fracY - anchorPos.y) > 240;
      const y = useFrac ? fracY : anchorPos.y;
      followHistory.push({ y, t: now });
      if (followHistory.length > FOLLOW_HISTORY_MAX) followHistory.shift();
      followLastTarget = { x: anchorPos.x, y };
      return followLastTarget;
    }
    if (anchorPos) {
      followHistory.push({ y: anchorPos.y, t: now });
      if (followHistory.length > FOLLOW_HISTORY_MAX) followHistory.shift();
      followLastTarget = { x: anchorPos.x, y: anchorPos.y };
      return followLastTarget;
    }
    if (fracY !== null) {
      followHistory.push({ y: fracY, t: now });
      if (followHistory.length > FOLLOW_HISTORY_MAX) followHistory.shift();
      followLastTarget = { x: 0, y: fracY };
      return followLastTarget;
    }
    // Anchor not resolvable this frame — extrapolate from last good fix.
    if (followHistory.length > 0) {
      const last = followHistory[followHistory.length - 1];
      const elapsed = Math.min(FOLLOW_EXTRAPOLATE_CAP_MS, now - last.t);
      const v = followVelocity();
      followLastTarget = { x: 0, y: last.y + v * elapsed };
      return followLastTarget;
    }
    // True cold start (no fix yet) — accept absolute scroll as best effort.
    if (f.scroll) {
      followLastTarget = { x: f.scroll.x || 0, y: f.scroll.y || 0 };
      return followLastTarget;
    }
    return null;
  }

  // Smooth-lerp scroll. RAF tick converges current → target with a fixed
  // step ratio. New target while in flight redirects the animation toward
  // the new target without jitter (caller just calls again with new value).
  let scrollLerpTarget = null;
  let scrollLerpRaf = null;
  function smoothScrollTo(tx, ty) {
    scrollLerpTarget = { x: tx, y: ty };
    if (scrollLerpRaf) return;
    const step = () => {
      if (!scrollLerpTarget) { scrollLerpRaf = null; return; }
      const cx = window.scrollX, cy = window.scrollY;
      const dx = scrollLerpTarget.x - cx;
      const dy = scrollLerpTarget.y - cy;
      // Snap when within sub-pixel range, otherwise ease toward target. The
      // 0.18 factor is a critical-damped feel at 60fps (~80% closure in 250ms).
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        window.scrollTo(scrollLerpTarget.x, scrollLerpTarget.y);
        scrollLerpTarget = null;
        scrollLerpRaf = null;
        return;
      }
      window.scrollTo(cx + dx * 0.18, cy + dy * 0.18);
      scrollLerpRaf = requestAnimationFrame(step);
    };
    scrollLerpRaf = requestAnimationFrame(step);
  }
  function cancelSmoothScroll() {
    scrollLerpTarget = null;
    if (scrollLerpRaf) { cancelAnimationFrame(scrollLerpRaf); scrollLerpRaf = null; }
  }
  // If the user manually scrolls (mouse wheel, keyboard), cancel any
  // in-flight smooth scroll so we don't fight them.
  ['wheel', 'touchstart', 'keydown'].forEach((ev) => {
    window.addEventListener(ev, () => {
      if (scrollLerpRaf && !followCtx) cancelSmoothScroll();
    }, { passive: true });
  });

  /* ──────────── live cursor render (reuse + transition) ──────────── */

  // Two-layer trick to make cursor moves smoothly transition while scroll
  // updates (which happen at every scroll event) snap instantly:
  //
  //   .cm-cursor-layer  — fixed full-screen, transform-translates by
  //                       -scrollX/-scrollY. NO transition. Lets us track
  //                       page-coord cursors as the local user scrolls
  //                       without restarting cursor transitions per frame.
  //
  //   .lc-wrap          — positioned absolutely INSIDE the cursor layer
  //                       at the cursor's PAGE coords. Has a CSS transition
  //                       on left/top, so a peer's cursor frame updates
  //                       (every 50ms) lerp smoothly between positions.
  let cursorLayer = null;
  const cursorWraps = new Map(); // clientId → wrap node
  function ensureCursorLayer() {
    if (cursorLayer) return;
    cursorLayer = el('div', { class: 'cm-cursor-layer' });
    layer.appendChild(cursorLayer);
    updateCursorLayerScroll();
  }
  function updateCursorLayerScroll() {
    if (!cursorLayer) return;
    cursorLayer.style.transform = `translate3d(${-window.scrollX}px, ${-window.scrollY}px, 0)`;
  }
  window.addEventListener('scroll', updateCursorLayerScroll, { passive: true });

  function renderLiveCursors() {
    ensureCursorLayer();
    updateCursorLayerScroll();
    const seen = new Set();
    for (const u of roster) {
      if (u.clientId === state.clientId) continue;
      if (!u.cursor) continue;
      if (u.page && u.page !== PAGE_PATH) continue;
      const projected = projectCursor(u.cursor);
      if (!projected) continue;
      let wrap = cursorWraps.get(u.clientId);
      if (!wrap) {
        wrap = el('div', { class: 'lc-wrap' });
        const svg = document.createElement('div');
        svg.innerHTML = `<svg width="18" height="22" viewBox="0 0 18 22" fill="none"><path class="lc-arrow" d="M2 2L2 18L7 14L10 20L13 18L10 12L16 12L2 2Z" fill="${u.color}" stroke="white" stroke-width="1.2"/></svg>`;
        wrap.appendChild(svg.firstElementChild);
        wrap.appendChild(el('div', { class: 'lc-label' }));
        cursorLayer.appendChild(wrap);
        cursorWraps.set(u.clientId, wrap);
      }
      // Refresh name + color every render — peers can rename or recolor.
      wrap.style.setProperty('--c', u.color);
      const arrow = wrap.querySelector('.lc-arrow');
      if (arrow) arrow.setAttribute('fill', u.color);
      const label = wrap.querySelector('.lc-label');
      if (label) {
        label.style.background = u.color;
        const next = (u.name || 'anon').split(' ')[0];
        if (label.textContent !== next) label.textContent = next;
      }
      // Set page coords directly — the cursor layer's transform handles
      // the conversion to viewport space for every viewer.
      wrap.style.left = projected.pageX + 'px';
      wrap.style.top  = projected.pageY + 'px';
      seen.add(u.clientId);
    }
    // Drop wraps for users no longer present / cursor gone
    for (const [cid, wrap] of cursorWraps) {
      if (!seen.has(cid)) {
        wrap.remove();
        cursorWraps.delete(cid);
      }
    }
  }

  /* ──────────── tools dock ──────────── */

  let toolsNode = null;
  function renderTools() {
    if (!state.name) {
      toolsNode?.remove();
      toolsNode = null;
      return;
    }
    if (!toolsNode) {
      toolsNode = el('div', { class: 'cm-tools' });
      layer.appendChild(toolsNode);
    }
    toolsNode.innerHTML = '';

    const eBtn = el('button', { type: 'button',
      class: 'cm-tool' + (mode === 'edit' ? ' act' : ''),
      title: 'Edit text — click any text to edit · ↵ save · ⌘↵ save and ask the agent',
    });
    eBtn.innerHTML = ico('edit') + `<span>Edit <kbd>E</kbd></span>`;
    eBtn.addEventListener('click', () => setMode('edit'));
    toolsNode.appendChild(eBtn);

    const cBtn = el('button', { type: 'button',
      class: 'cm-tool' + (mode === 'comment' ? ' act' : ''),
      title: 'Comment — click anywhere to drop a pin',
    });
    cBtn.innerHTML = ico('comment') + `<span>Comment <kbd>C</kbd></span>`;
    cBtn.addEventListener('click', () => setMode('comment'));
    toolsNode.appendChild(cBtn);

    toolsNode.appendChild(el('span', { class: 'cm-tool-sep' }));

    const dBtn = el('button', { type: 'button',
      class: 'cm-tool' + (diffMode ? ' act' : ''),
      title: 'Toggle between edited and original copy',
    });
    dBtn.innerHTML = ico('diff') + `<span>Show ${diffMode ? 'edited' : 'original'} <kbd>D</kbd></span>`;
    dBtn.addEventListener('click', () => toggleDiffMode());
    toolsNode.appendChild(dBtn);

    toolsNode.appendChild(el('span', { class: 'cm-tool-sep' }));

    const sBtn = el('button', { type: 'button', class: 'cm-tool',
      title: 'Copy a link that lets others join this review (while the agent is online)',
    });
    sBtn.innerHTML = ico('share') + `<span>Share</span>`;
    sBtn.addEventListener('click', shareLink);
    toolsNode.appendChild(sBtn);
  }

  async function shareLink() {
    const url = location.origin + location.pathname + location.search + '#cmt=' + ROOM;
    try { await navigator.clipboard.writeText(url); toast('Link copied — anyone with it can join while the agent is online'); }
    catch { window.prompt('Copy this link:', url); }
  }

  function toggleDiffMode() {
    diffMode = !diffMode;
    for (const e of edits) {
      const a = JSON.parse(e.anchor_json);
      const target = resolveAnchor(a);
      if (!target) continue;
      const desired = diffMode ? e.original_text : e.new_text;
      if (target.children.length === 0) target.textContent = desired;
      else for (const n of target.childNodes) if (n.nodeType === 3) { n.nodeValue = desired; break; }
      if (diffMode) target.removeAttribute('data-c-edited');
      else target.dataset.cEdited = '1';
    }
    let overlay = layer.querySelector('.cm-diff-overlay');
    if (diffMode && !overlay) layer.insertBefore(el('div', { class: 'cm-diff-overlay' }), layer.firstChild);
    if (!diffMode && overlay) overlay.remove();
    renderChangedBadges();
    renderTools();
  }


  /* ──────────── connection indicator + toast ──────────── */

  let connNode = null;
  let connState = 'connecting';
  const CONN_LABELS = {
    connecting: 'connecting',
    open: 'live',
    closed: 'reconnecting',
    error: 'connection error',
    offline: 'agent offline',
    gone: 'room closed',
  };
  function renderConn() {
    if (!connNode) {
      connNode = el('div', { class: 'cm-conn' });
      layer.appendChild(connNode);
    }
    connNode.innerHTML = '';
    const dot = el('span', { class: 'cm-conn-dot ' + (connState === 'open' ? 'ok' : (connState === 'error' || connState === 'gone') ? 'err' : '') });
    connNode.appendChild(dot);
    connNode.appendChild(document.createTextNode(CONN_LABELS[connState] || connState));
  }

  function toast(msg) {
    const t = el('div', {
      style: {
        position: 'fixed', bottom: '38px', left: '50%', transform: 'translateX(-50%)',
        background: '#0F1115', color: '#fff',
        padding: '8px 14px', borderRadius: '999px',
        font: '12px var(--cm-font-mono)',
        boxShadow: 'var(--cm-shadow-pop)', zIndex: '99',
        animation: 'cm-fade .2s ease-out',
      },
    }, msg);
    layer.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; }, 1800);
    setTimeout(() => t.remove(), 2200);
  }

  // Celebration overlay: triggered on the user's first successful contribution
  // (comment OR edit). Persisted in state.firstCommitDone so it never fires
  // again for the same browser/user.
  function celebrateFirstCommit() {
    if (state.firstCommitDone) return;
    if (window.__cmSkipCelebrate) { state.firstCommitDone = true; persist(); return; }
    state.firstCommitDone = true;
    persist();

    const scrim = el('div', { class: 'fc-scrim' });
    const card = el('div', { class: 'fc-card' });
    card.appendChild(el('div', { class: 'fc-spark' }, '✦'));
    card.appendChild(el('h2', { class: 'fc-title' }, 'You’re on the team.'));
    card.appendChild(el('p', { class: 'fc-body' },
      'Your first contribution is in. Drop more notes, edit copy, your team sees it the moment you save.'
    ));
    const cta = el('button', { type: 'button', class: 'fc-cta' }, 'Keep reviewing');
    cta.addEventListener('click', dismiss);
    card.appendChild(cta);
    scrim.appendChild(card);

    // Confetti — pure DOM, randomized per piece via CSS custom properties.
    const conf = el('div', { class: 'fc-confetti' });
    const palette = [
      'oklch(0.62 0.16 250)', 'oklch(0.65 0.16 145)', 'oklch(0.72 0.17 80)',
      'oklch(0.62 0.18 30)',  'oklch(0.6 0.18 305)',  'oklch(0.7 0.14 200)',
    ];
    for (let i = 0; i < 320; i++) {
      const piece = document.createElement('div');
      piece.className = 'fc-piece';
      // Mix shapes: thin streamer rectangles + small circles + bigger flakes.
      const kind = Math.random();
      let w, h, br;
      if (kind < 0.55) { w = 5 + Math.random() * 6;  h = 9 + Math.random() * 11; br = 1; }
      else if (kind < 0.85) { w = 7 + Math.random() * 6; h = w; br = 999; }
      else { w = 10 + Math.random() * 8; h = 4 + Math.random() * 4; br = 2; }
      piece.style.left = (Math.random() * 100) + '%';
      piece.style.background = palette[Math.floor(Math.random() * palette.length)];
      piece.style.width  = w + 'px';
      piece.style.height = h + 'px';
      piece.style.borderRadius = br + 'px';
      piece.style.animationDelay    = (Math.random() * 1.2) + 's';
      piece.style.animationDuration = (2.6 + Math.random() * 2.6) + 's';
      piece.style.setProperty('--rot',   (Math.random() * 1080 - 540) + 'deg');
      piece.style.setProperty('--drift', (Math.random() * 360 - 180) + 'px');
      conf.appendChild(piece);
    }
    scrim.appendChild(conf);

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      scrim.classList.add('fc-leaving');
      setTimeout(() => scrim.remove(), 420);
    }
    scrim.addEventListener('click', (e) => { if (e.target === scrim) dismiss(); });
    // Auto-dismiss so the user isn't stuck with it if they walk away.
    setTimeout(dismiss, 6000);

    layer.appendChild(scrim);
  }

  /* ──────────── re-position on scroll/resize ──────────── */

  let rafPending = false;
  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (hoverCtx) showHover(hoverCtx.el);
      renderPins();
      renderEditingByOther();
      renderChangedBadges();
      renderLiveCursors();
    });
  }
  window.addEventListener('scroll', scheduleReposition, { passive: true });
  window.addEventListener('resize', scheduleReposition);
  // Continuous tracker — pins follow elements that ANIMATE inside a stable
  // layout. CSS transforms don't fire scroll, resize, or ResizeObserver, so
  // discrete events miss them. We poll bounding rects per frame and write
  // left/top only when the rounded position changed (browser elides same-
  // value style writes anyway, but this avoids scheduling work each frame).
  // Pins only — renderEditingByOther wipes+rebuilds DOM per call and would
  // flicker. If we ever need badges/outlines to track too, refactor those
  // to be position-only updates first.
  const pinTrackPositions = new Map(); // anchor_json → "x,y"
  let composerPinSig = null;
  function pinTrackTick() {
    for (const [k, entry] of pinEntries) {
      if (!entry || !entry.target || !entry.target.isConnected) continue;
      let anchor;
      try { anchor = JSON.parse(k); } catch { continue; }
      const { x, y } = pinPosition(entry.target, anchor);
      const sig = Math.round(x) + ',' + Math.round(y);
      if (pinTrackPositions.get(k) === sig) continue;
      pinTrackPositions.set(k, sig);
      entry.pin.style.left = Math.round(x) + 'px';
      entry.pin.style.top  = Math.round(y) + 'px';
    }
    // Also track the composer's ghost pin while a comment is being written —
    // the popover stays where the user is typing, but the anchor pin should
    // visibly track the underlying element so the user sees what it's tied
    // to (especially on pages with continuously animating elements).
    if (composerCtx?.target?.isConnected && composerNode?.ghostPin) {
      const { x, y } = pinPosition(composerCtx.target, composerCtx.anchor);
      const sig = Math.round(x) + ',' + Math.round(y);
      if (sig !== composerPinSig) {
        composerPinSig = sig;
        composerNode.ghostPin.style.left = Math.round(x) + 'px';
        composerNode.ghostPin.style.top  = Math.round(y) + 'px';
      }
    } else {
      composerPinSig = null;
    }
    requestAnimationFrame(pinTrackTick);
  }
  requestAnimationFrame(pinTrackTick);
  // Catch the late-settle layout shifts that happen after first paint:
  //   • images/iframes finish loading and contribute height
  //   • web fonts swap in and reflow text
  //   • the host site mutates the DOM after our snapshot loaded
  window.addEventListener('load', scheduleReposition);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleReposition);
  try {
    const ro = new ResizeObserver(scheduleReposition);
    ro.observe(document.documentElement);
  } catch {}

  // Open the prepaint gate once layout has settled. We require:
  //   • document.fonts.ready (web-font swap reflow finished)
  //   • window load event   (images contributed their final height)
  //   • snapshot loaded     (badges/pins exist in the DOM, still hidden by
  //                          the .cm-prepaint class — without this, on a
  //                          soft reload everything else resolves before
  //                          the snapshot fetch returns, prepaint gets
  //                          removed, then the snapshot arrives and badges
  //                          play their entry animation outside of the
  //                          prepaint protection — which the user sees as
  //                          a small position settle)
  // ...then one more RAF so the resulting layout commit is observable.
  // 4s failsafe in case any of the conditions never resolve.
  let paintGateOpen = false;
  function openPaintGate() {
    if (paintGateOpen) return;
    paintGateOpen = true;
    requestAnimationFrame(() => {
      if (hoverCtx) showHover(hoverCtx.el);
      renderPins();
      renderEditingByOther();
      renderChangedBadges();
      renderLiveCursors();
      layer.classList.remove('cm-prepaint');
    });
  }
  let snapshotReadyResolve;
  const snapshotReady = new Promise((res) => { snapshotReadyResolve = res; });
  Promise.all([
    document.fonts?.ready || Promise.resolve(),
    document.readyState === 'complete'
      ? Promise.resolve()
      : new Promise((res) => window.addEventListener('load', res, { once: true })),
    snapshotReady,
  ]).then(openPaintGate);
  setTimeout(openPaintGate, 4000);
  /* ──────────── WS + presence ──────────── */
  let ws, wsRetry = 0;
  // Connection lifecycle log — exposed on window so it can be inspected by
  // dev tools or a probe. Capped at 200 entries so it doesn't grow forever.
  window.__cmConnLog = window.__cmConnLog || [];
  function logConn(entry) {
    window.__cmConnLog.push({ t: Date.now(), ...entry });
    if (window.__cmConnLog.length > 200) window.__cmConnLog.splice(0, window.__cmConnLog.length - 200);
  }
  // Signalling socket: introduces us to the agent and relays SDP. Everything
  // else (frames, API calls) goes over the data channel, which becomes `ws`.
  let sig = null, pc = null, iceServers = null, agentOnline = false;
  const rpcWaiters = new Map();
  let rpcSeq = 0;
  let channelReadyResolve;
  let channelReady = new Promise((r) => { channelReadyResolve = r; });

  function connectWs() {
    logConn({ kind: 'connect-attempt', retry: wsRetry });
    const s = sig = new WebSocket(`${SIGNAL_WS}/rooms/${ROOM}?role=peer&name=${encodeURIComponent(state.name || '')}`);
    s.onmessage = async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome') {
        wsRetry = 0;
        iceServers = m.iceServers;
        agentOnline = m.agentOnline;
        if (agentOnline) startPeer(); else setOffline();
      } else if (m.type === 'agent-online') {
        agentOnline = true;
        startPeer();
      } else if (m.type === 'agent-offline') {
        agentOnline = false;
        closePeer();
        setOffline();
      } else if (m.type === 'ice') {
        iceServers = m.iceServers;
      } else if (m.type === 'signal' && m.data?.sdp && pc) {
        try {
          await pc.setRemoteDescription(m.data.sdp);
          for (const c of pc.pendingCandidates.splice(0)) pc.addIceCandidate(c).catch(() => {});
        } catch (e) { logConn({ kind: 'sdp-error', msg: String(e).slice(0, 80) }); }
      } else if (m.type === 'signal' && m.data?.candidate && pc) {
        if (pc.remoteDescription) pc.addIceCandidate(m.data.candidate).catch(() => {});
        else pc.pendingCandidates.push(m.data.candidate);
      }
    };
    s.onclose = (ev) => {
      if (sig !== s) return;
      logConn({ kind: 'close', code: ev.code, reason: String(ev.reason || '').slice(0, 60) });
      closePeer();
      if (ev.code === 4404 || ev.code === 4410) {
        connState = 'gone';
        renderConn();
        snapshotReadyResolve();
        return;
      }
      connState = 'closed';
      renderConn();
      const delay = Math.min(8000, 500 * Math.pow(2, wsRetry++));
      setTimeout(connectWs, delay);
    };
    s.onerror = () => { logConn({ kind: 'error' }); };
  }

  function setOffline() {
    connState = 'offline';
    renderConn();
    // Nobody is reachable without the hub — drop stale avatars and cursors.
    roster = [];
    renderAvatarBar();
    renderLiveCursors();
    snapshotReadyResolve();
  }

  function closePeer() {
    const old = pc;
    pc = null;
    if (ws) { ws = null; stopPresence(); }
    channelReady = new Promise((r) => { channelReadyResolve = r; });
    for (const w of rpcWaiters.values()) w.reject(new Error('channel closed'));
    rpcWaiters.clear();
    try { old?.close(); } catch {}
  }

  async function startPeer() {
    closePeer();
    connState = 'connecting';
    renderConn();
    const myPc = pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    const dc = myPc.createDataChannel('commenter');
    dc.onopen = () => {
      if (pc !== myPc) return;
      logConn({ kind: 'open' });
      ws = dc;
      connState = 'open';
      renderConn();
      sendWs({ t: 'hello', clientId: state.clientId });
      sendIdentify();
      startPresence();
      channelReadyResolve();
      loadSnapshot();
    };
    dc.onclose = () => {
      if (pc !== myPc) return;
      closePeer();
      if (agentOnline) { connState = 'closed'; renderConn(); setTimeout(() => agentOnline && !pc && startPeer(), 1000); }
    };
    dc.onmessage = (ev) => {
      const f = unchunk(ev.data);
      if (!f) return;
      if (f.t === 'rpc_result') {
        const w = rpcWaiters.get(f.id);
        if (w) { rpcWaiters.delete(f.id); w.resolve(f); }
        return;
      }
      handleFrame(f);
    };
    myPc.onconnectionstatechange = () => {
      if (pc !== myPc || myPc.connectionState !== 'failed') return;
      logConn({ kind: 'ice-failed' });
      closePeer();
      connState = 'error';
      renderConn();
      // Credentials may have expired — ask for fresh ones, then retry.
      try { sig?.send(JSON.stringify({ type: 'ice' })); } catch {}
      setTimeout(() => agentOnline && !pc && startPeer(), 3000);
    };
    // Trickle ICE: the offer goes out at once, candidates follow as found.
    myPc.pendingCandidates = [];
    const outbox = [];
    let offerSent = false;
    const signal = (data) => sig?.send(JSON.stringify({ type: 'signal', to: 'agent', data }));
    myPc.onicecandidate = (e) => {
      if (pc !== myPc || !e.candidate) return;
      if (offerSent) signal({ candidate: e.candidate }); else outbox.push(e.candidate);
    };
    await myPc.setLocalDescription(await myPc.createOffer());
    if (pc !== myPc) return;
    signal({ sdp: myPc.localDescription });
    offerSent = true;
    for (const c of outbox) signal({ candidate: c });
  }

  // Data channel messages can be large (a snapshot); split anything over
  // CHUNK chars so every SCTP stack we talk to accepts it.
  const CHUNK = 16000;
  const chunkBuf = new Map();
  function sendRaw(obj) {
    const s = JSON.stringify(obj);
    if (s.length <= CHUNK) return ws.send(s);
    const id = Math.random().toString(36).slice(2);
    const n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: 'chunk', id, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
  }
  function unchunk(raw) {
    let f; try { f = JSON.parse(raw); } catch { return null; }
    if (f.t !== 'chunk') return f;
    const parts = chunkBuf.get(f.id) || [];
    parts[f.i] = f.d;
    chunkBuf.set(f.id, parts);
    if (parts.filter((p) => p != null).length < f.n) return null;
    chunkBuf.delete(f.id);
    try { return JSON.parse(parts.join('')); } catch { return null; }
  }

  // fetch()-shaped call into the agent, over the data channel. Waits for the
  // channel if it isn't open yet.
  async function api(path, opts = {}) {
    await channelReady;
    const id = ++rpcSeq;
    const res = await new Promise((resolve, reject) => {
      rpcWaiters.set(id, { resolve, reject });
      setTimeout(() => { if (rpcWaiters.delete(id)) reject(new Error('agent did not answer')); }, 15000);
      sendRaw({ t: 'rpc', id, method: opts.method || 'GET', path, body: opts.body ? JSON.parse(opts.body) : null });
    });
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  }

  function sendWs(obj) {
    if (ws?.readyState === 'open') sendRaw(obj);
  }
  function sendIdentify() {
    if (state.name) sendWs({ t: 'identify', name: state.name, email: state.email, color: state.color });
  }
  function handleFrame(f) {
    if (f.t === 'welcome') {
      roster = f.roster || [];
      if (typeof f.overlayVersion === 'number') noteServerVersion(f.overlayVersion);
      // Continue resuming follow if we navigated for it
      try {
        const stored = JSON.parse(sessionStorage.getItem('__commenter_follow') || 'null');
        if (stored && (Date.now() - stored.ts) < 10_000) {
          const u = roster.find((r) => r.clientId === stored.clientId);
          sessionStorage.removeItem('__commenter_follow');
          if (u && u.page === PAGE_PATH) startFollow(u);
        }
      } catch {}
      renderAvatarBar();
      renderEditingByOther();
      renderLiveCursors();
    } else if (f.t === 'overlay-version') {
      if (typeof f.version === 'number') noteServerVersion(f.version);
    } else if (f.t === 'roster') {
      const next = f.roster || [];
      const goneIds = roster
        .filter((r) => !next.some((n) => n.clientId === r.clientId))
        .map((r) => r.clientId);
      for (const cid of goneIds) {
        clearEditingTimers(cid);
        editingShownAt.delete(cid);
        editingLeaving.delete(cid);
      }
      roster = next;
      // Seed shownAt for users we're seeing edit for the first time, so the
      // min-hold applies even when the indicator's first appearance came in
      // via a roster snapshot rather than an edit_inflight frame.
      for (const u of roster) {
        if (u.editing?.anchor && !editingShownAt.has(u.clientId)) {
          editingShownAt.set(u.clientId, Date.now());
        }
      }
      // If we were following someone and they're no longer in the room,
      // drop follow-mode immediately so the banner doesn't linger.
      if (followCtx && !roster.some((r) => r.clientId === followCtx.user.clientId)) {
        const name = followCtx.user.name || 'they';
        cancelFollow();
        toast(name + ' left');
      }
      renderAvatarBar();
      renderEditingByOther();
      renderLiveCursors();
    } else if (f.t === 'presence') {
      const idx = roster.findIndex((r) => r.clientId === f.clientId);
      if (idx >= 0) {
        roster[idx] = { ...roster[idx],
          page: f.page, scroll: f.scroll, scrollAnchor: f.scrollAnchor,
          viewport: f.viewport, cursor: f.cursor,
        };
        renderLiveCursors();
        // While following, glide our viewport to theirs. Resolve the
        // followee's scroll anchor in our DOM (works across viewport
        // widths), fall back to absolute scroll Y if the anchor doesn't
        // resolve. smoothScrollTo lerps each frame to avoid step-jumps.
        if (followCtx && followCtx.user.clientId === f.clientId) {
          if (f.page && f.page !== PAGE_PATH) {
            location.href = PROXY_BASE + f.page;
            return;
          }
          // Anchor-first, velocity-extrapolation second, absolute-scroll
          // last. Keeps direction stable when the anchor briefly fails.
          const target = computeFollowTarget(f);
          if (target) smoothScrollTo(target.x, target.y);
        }
      }
    } else if (f.t === 'edit_inflight') {
      const idx = roster.findIndex((r) => r.clientId === f.clientId);
      if (idx >= 0) {
        setEditingState(idx, f.anchor ? { anchor: f.anchor, currentText: f.currentText || '' } : null);
      }
    } else if (f.t === 'edit_committed') {
      applyEditLocally(f.edit);
      // Don't toast our own edits — commitEdit already shows "Edit saved"
      // for the local user. Only surface remote authors.
      if (f.edit.author_client_id !== state.clientId) {
        const who = roster.find((r) => r.clientId === f.edit.author_client_id)?.name || 'someone';
        toast(`${who} edited text`);
      }
      renderAvatarBar();
    } else if (f.t === 'edit_thread_status') {
      applyEditThreadStatus({ anchor_json: f.anchor_json, edits: f.edits, event: f.event });
    } else if (f.t === 'comment_added') {
      if (addCommentLocal(f.comment)) {
        renderPins();
        // Pin presence affects badge offset on the same anchor — re-render
        // so an existing badge lifts above the new pin.
        renderChangedBadges();
        renderAvatarBar();
        if (panelOpen && panelMode === 'thread') renderPanel();
        else if (panelOpen) renderPanel();
      }
    } else if (f.t === 'comment_deleted') {
      applyCommentDeleted({ commentId: f.commentId, anchor_json: f.anchor_json });
    } else if (f.t === 'thread_status') {
      mergeAnchorComments(f.anchor_json, f.comments || []);
      if (f.event) addCommentLocal(f.event);
      renderPins();
      renderAvatarBar();
      if (panelOpen) renderPanel();
    }
  }
  // Presence is sent on user activity (mousemove, scroll) throttled to ~20 Hz
  // for snappy cursor tracking, plus a slow heartbeat so idle users still
  // refresh their lastSeen on the server (keeps the stale-sweeper happy).
  const PRESENCE_THROTTLE_MS = 50;     // 20 Hz max
  const PRESENCE_HEARTBEAT_MS = 3000;  // idle floor
  let presenceLastSent = 0;
  let presenceTimer = null;
  let presenceHeartbeat = null;
  function sendPresenceNow() {
    presenceLastSent = Date.now();
    // Total scrollable space sender has — used by followers to interpret
    // scrollFrac. Pinned sections (GSAP ScrollTrigger and similar) make a
    // single scrollAnchor element occupy viewport-top for hundreds of
    // scroll-pixels, so the anchor stalls but scrollFrac keeps advancing
    // and pulls the follower along smoothly through the animation.
    const docH = document.documentElement.scrollHeight || 0;
    const maxScroll = Math.max(1, docH - window.innerHeight);
    sendWs({
      t: 'presence',
      page: PAGE_PATH,
      scroll: { x: window.scrollX, y: window.scrollY },
      scrollFrac: window.scrollY / maxScroll,
      // Anchor for the element at viewport top — used by receivers in
      // follow mode to scroll to the same content (not the same Y pixel).
      scrollAnchor: captureScrollAnchor(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      // Anchor cursor: { sel, fx, fy, pageX, pageY }. Receivers resolve
      // the selector and place the cursor at the same fractional position
      // within that element. Falls back to (pageX, pageY) when the
      // selector can't be resolved.
      cursor: mouseSeen ? captureCursorAnchor(mouseX, mouseY) : null,
    });
  }
  function schedulePresence() {
    const since = Date.now() - presenceLastSent;
    if (since >= PRESENCE_THROTTLE_MS) {
      if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null; }
      sendPresenceNow();
    } else if (!presenceTimer) {
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        sendPresenceNow();
      }, PRESENCE_THROTTLE_MS - since);
    }
  }
  function startPresence() {
    stopPresence();
    sendPresenceNow();
    presenceHeartbeat = setInterval(() => {
      if (Date.now() - presenceLastSent >= PRESENCE_HEARTBEAT_MS) sendPresenceNow();
    }, PRESENCE_HEARTBEAT_MS);
  }
  function stopPresence() {
    if (presenceTimer)     { clearTimeout(presenceTimer); presenceTimer = null; }
    if (presenceHeartbeat) { clearInterval(presenceHeartbeat); presenceHeartbeat = null; }
  }
  // Hook activity sources — these all already exist; we just attach.
  window.addEventListener('scroll', schedulePresence, { passive: true });
  // Visibility-change: when the tab regains focus, immediately re-assert
  // presence (heartbeats may have been throttled while backgrounded). If
  // the WS dropped during the throttle, the open path will trigger a
  // reconnect via setTimeout(connectWs, ...); when that lands, this same
  // handler fires presence again on the next visibility flip.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      sendPresenceNow();
      // Catch up on anything we might have missed while throttled —
      // including a peer's identify that re-named them. The server replies
      // with a fresh roster only to us.
      sendWs({ t: 'sync_roster' });
      // And re-assert our own identity so any peer whose connection
      // missed our previous identify (rare) sees the latest.
      sendIdentify();
    }
  });

  /* ──────────── overlay self-update ──────────── */
  // The edge stamps `globalThis.__cmOverlayVersion = <mtime>` at the head of
  // every overlay.js response and broadcasts the same number on the WS
  // (welcome + an overlay-version push when the file changes). When the
  // server's number > ours, we have an outdated overlay loaded — auto-reload
  // the next time the user is genuinely idle. If they stay busy too long
  // (1.5min), surface an OUTDATED · UPDATE NOW chip in the avatar bar.
  const LOADED_OVERLAY_VERSION = (typeof globalThis.__cmOverlayVersion === 'number')
    ? globalThis.__cmOverlayVersion : 0;
  let pendingUpdateSince = 0;     // ms timestamp when we first saw a newer version
  let lastActivityAt = Date.now();
  const ACTIVITY_IDLE_MS  = 4_000;
  const ACTIVITY_OUTDATED_MS = 90_000;
  const RESTORE_MAX_AGE_MS = 5 * 60_000;
  function markActivity() { lastActivityAt = Date.now(); }
  ['mousemove','mousedown','keydown','wheel','touchstart','touchmove'].forEach((ev) => {
    window.addEventListener(ev, markActivity, { passive: true, capture: true });
  });
  function noteServerVersion(srv) {
    if (!srv) return;
    if (LOADED_OVERLAY_VERSION && srv > LOADED_OVERLAY_VERSION && !pendingUpdateSince) {
      pendingUpdateSince = Date.now();
      renderAvatarBar(); // chip will check pendingUpdateSince and render the right state
    }
  }
  function isUserBusy() {
    if (composerCtx || composerNode) return true;
    if (editingCtx) return true;
    if (followCtx) return true;
    if (Date.now() - lastActivityAt < ACTIVITY_IDLE_MS) return true;
    return false;
  }
  function snapshotForReload() {
    const out = {
      v: LOADED_OVERLAY_VERSION,
      page: PAGE_PATH,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      ts: Date.now(),
    };
    return out;
  }
  function performReload() {
    try {
      sessionStorage.setItem('__commenter_reload', JSON.stringify(snapshotForReload()));
    } catch {}
    location.reload();
  }
  // Outdated chip in the avatar bar — wired into renderAvatarBar via a
  // post-render callback. Polls once a second so it appears on schedule
  // without piggy-backing on roster changes.
  function shouldShowOutdated() {
    return pendingUpdateSince && (Date.now() - pendingUpdateSince) >= ACTIVITY_OUTDATED_MS;
  }
  setInterval(() => {
    if (!pendingUpdateSince) return;
    if (!isUserBusy()) {
      performReload();
      return;
    }
    // Re-render avatar bar near the OUTDATED threshold so the chip flips on.
    if (shouldShowOutdated()) renderAvatarBar();
  }, 1000);

  // Restore scroll on page load if we just reloaded ourselves.
  try {
    const raw = sessionStorage.getItem('__commenter_reload');
    if (raw) {
      const r = JSON.parse(raw);
      sessionStorage.removeItem('__commenter_reload');
      if (r && r.page === PAGE_PATH && (Date.now() - r.ts) < RESTORE_MAX_AGE_MS) {
        // Defer until after layout has settled, otherwise a 0,0 reflow
        // wins. requestAnimationFrame after a short timeout works well.
        setTimeout(() => {
          window.scrollTo(r.scrollX || 0, r.scrollY || 0);
        }, 50);
      }
    }
  } catch {}

  /* ──────────── snapshot replay ──────────── */
  async function loadSnapshot() {
    try {
      const r = await api(`/__c/api/snapshot?slug=${SLUG}&token=${TOKEN}`);
      const j = await r.json();
      comments = j.comments || [];
      edits    = j.edits    || [];
      // editsByAnchor only tracks current-page edits (latest per anchor)
      // since it's used for in-page badge rendering.
      editsByAnchor = new Map();
      for (const e of edits) {
        if (e.page_path && e.page_path !== PAGE_PATH) continue;
        const prev = editsByAnchor.get(e.anchor_json);
        if (!prev || e.created_at > prev.created_at) editsByAnchor.set(e.anchor_json, e);
      }
      replayEdits();
      renderPins();
      renderChangedBadges();
      renderAvatarBar();
      // Resume opening a thread we navigated for. The marker is set by
      // openThread() when the target lives on a different page.
      try {
        const stored = JSON.parse(sessionStorage.getItem('__commenter_open_thread') || 'null');
        if (stored && (Date.now() - stored.ts) < 10_000) {
          sessionStorage.removeItem('__commenter_open_thread');
          const c = comments.find((x) => x.id === stored.commentId);
          if (c && c.page_path === PAGE_PATH) openThread(c.id);
        }
      } catch {}
      // Same idea for cross-page edit Reveal — set by the edit-list reveal
      // button when the edit lives on another page. Wait briefly so the
      // snapshot-driven badge has rendered into pinEntries / badgeWraps.
      try {
        const stored = JSON.parse(sessionStorage.getItem('__commenter_reveal_edit') || 'null');
        if (stored && (Date.now() - stored.ts) < 10_000) {
          sessionStorage.removeItem('__commenter_reveal_edit');
          setTimeout(() => {
            const anchor = JSON.parse(stored.anchor_json);
            const t = resolveAnchor(anchor);
            if (!t) return;
            t.scrollIntoView({ block: 'center', behavior: 'smooth' });
            setTimeout(() => {
              const entry = badgeWraps.get(stored.anchor_json);
              entry?.wrap?.__pinShow?.(5000);
            }, 600);
          }, 200);
        }
      } catch {}
    } catch {}
    finally { snapshotReadyResolve(); }
  }
  function replayEdits() {
    // Apply only the LATEST edit per anchor, so multi-edit history doesn't
    // step through intermediate states (and so any inline children like
    // <br> get reconstructed cleanly via applyText for the final state only).
    const latestByAnchor = new Map();
    for (const e of edits) {
      if (e.event) continue;
      if (e.page_path && e.page_path !== PAGE_PATH) continue;
      const prev = latestByAnchor.get(e.anchor_json);
      if (!prev || e.created_at > prev.created_at) latestByAnchor.set(e.anchor_json, e);
    }
    for (const e of latestByAnchor.values()) {
      const anchor = JSON.parse(e.anchor_json);
      const target = resolveAnchor(anchor);
      if (!target) continue;
      applyText(target, e.new_text);
      target.dataset.cEdited = '1';
    }
  }
  function applyEditLocally(edit) {
    const anchor = JSON.parse(edit.anchor_json);
    // Only apply DOM changes on the page where the edit lives. Cross-page
    // edits still get pushed into our edits[] array so the side panel can
    // surface them.
    if (!edit.page_path || edit.page_path === PAGE_PATH) {
      const target = resolveAnchor(anchor);
      if (target) {
        applyText(target, edit.new_text);
        target.dataset.cEdited = '1';
      }
    }
    // Keep prior edits at the same anchor as history. Dedupe by id in case
    // the WS broadcast arrives while we already have it locally.
    if (!edits.some((e) => e.id === edit.id)) edits.push(edit);
    editsByAnchor.set(edit.anchor_json, edit); // latest wins for badge color/author
    renderChangedBadges();
  }
  /* ──────────── boot ──────────── */
  renderConn();
  connectWs();
  // Small viewport warning gates everything visual: shown once per session
  // before the identify modal so reviewers know to switch to a desktop.
  // Identify modal still opens on first visit; lazy-prompts on any
  // comment/edit attempt otherwise.
  (async () => {
    if (isSmallViewport() && !mobileWarningDismissed()) {
      await openMobileWarningModal();
    }
    if (!state.name) {
      await openIdentifyModal(true);
    }
    renderAvatarBar();
    renderTools();
  })();
})();
