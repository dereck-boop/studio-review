(() => {
  'use strict';

  const BOOT = JSON.parse(document.getElementById('boot').textContent);
  const SHARE = BOOT.mode === 'share';
  const API = SHARE ? `/api/s/${encodeURIComponent(BOOT.token)}` : '/api';
  const root = document.getElementById('app');
  const state = { admin: false, cleanup: [] };

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'style') el.style.cssText = v; // CSSOM, allowed under the CSP (style attributes are not)
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  }
  const svg = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  };
  const ICON_PLAY = 'M7 4.5v15l13-7.5z';
  const ICON_PAUSE = 'M6 4h4v16H6zM14 4h4v16h-4z';

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---------- formatting ----------
  function fmt(t, tenths = false) {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
    return `${m}:${ss}`;
  }
  function ago(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }
  const db1 = (v, unit) => (v == null ? '—' : `${v.toFixed(1)} ${unit}`);
  function fmtRate(v) {
    const parts = [];
    if (v.bitDepth) parts.push(`${v.bitDepth}-bit`);
    if (v.sampleRate) parts.push(`${(v.sampleRate / 1000).toString().replace(/\.0$/, '')} kHz`);
    if (v.channels) parts.push(v.channels === 1 ? 'mono' : v.channels === 2 ? 'stereo' : `${v.channels}ch`);
    return parts.join(' · ');
  }

  // ---------- network ----------
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const r = await fetch(API + path, init);
    let data = null;
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || r.statusText);
      err.status = r.status;
      err.data = data;
      if (r.status === 401 && !SHARE && path !== '/login') { state.admin = false; route(); }
      throw err;
    }
    return data;
  }
  const mediaUrl = (vid, kind) => `/media/${vid}/${kind}${SHARE ? `?s=${encodeURIComponent(BOOT.token)}` : ''}`;

  const artUrl = (u) => (u ? u + (SHARE ? `?s=${encodeURIComponent(BOOT.token)}` : '') : null);
  const IMAGE_RE = /\.(jpe?g|png|webp|gif|tiff?|bmp)$/i;
  const isImage = (f) => /^image\//.test(f.type) || IMAGE_RE.test(f.name);

  // Square cover: the image if there is one, otherwise the project's initials on a tinted tile.
  function cover(project, size, cls = '') {
    const box = h('div', { class: `cover ${cls}` });
    box.style.setProperty('--size', size);
    const url = artUrl(project.art && (parseInt(size, 10) > 200 ? project.art.full : project.art.thumb));
    if (url) box.append(h('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' }));
    else {
      const initials = ((project.name || '?').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
      let hue = 0;
      for (const ch of project.id || project.name || '') hue = (hue * 31 + ch.charCodeAt(0)) % 360;
      box.style.setProperty('--hue', hue);
      box.classList.add('blank');
      box.append(h('span', null, initials));
    }
    return box;
  }

  function uploadArt(projectId, file) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('art', file, file.name);
      const x = new XMLHttpRequest();
      x.open('POST', `/api/projects/${projectId}/art`);
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* */ }
        if (x.status >= 200 && x.status < 300) resolve(d);
        else reject(new Error(d.error || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('Upload failed — connection dropped'));
      x.send(fd);
    });
  }

  // Asks for a client name and creates it (or returns the existing one with that name).
  async function newClientPrompt() {
    const name = prompt('Client name (band, label, company…)');
    if (!name || !name.trim()) return null;
    return api('/clients', { method: 'POST', body: { name: name.trim() } });
  }

  function clientSelect(clients, selected, onPick) {
    const sel = h('select', {
      onchange: async () => {
        if (sel.value === '__new') {
          try {
            const c = await newClientPrompt();
            if (!c) { sel.value = selected || ''; return; }
            if (![...sel.options].some((o) => o.value === c.id)) sel.insertBefore(h('option', { value: c.id }, c.name), sel.lastChild);
            sel.value = c.id;
            selected = c.id;
            onPick(c.id, c);
          } catch (e) { oops(e); sel.value = selected || ''; }
          return;
        }
        selected = sel.value || null;
        onPick(selected);
      },
    },
    h('option', { value: '' }, 'No client'),
    clients.map((c) => h('option', { value: c.id, selected: c.id === selected }, c.name)),
    h('option', { value: '__new' }, '+ New client…'));
    return sel;
  }

  function uploadFiles(projectId, files, trackId, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      if (trackId) fd.append('trackId', trackId);
      for (const f of files) fd.append('files', f, f.name);
      const x = new XMLHttpRequest();
      x.open('POST', `/api/projects/${projectId}/upload`);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* */ }
        if (x.status >= 200 && x.status < 300) resolve(d);
        else reject(new Error(d.error || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('Upload failed — connection dropped'));
      x.send(fd);
    });
  }

  // ---------- UI bits ----------
  let toastTimer;
  function toast(msg, isErr = false) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3200);
  }
  const oops = (e) => toast(e.message || String(e), true);

  function modal(title, body, actions) {
    const bg = h('div', { class: 'modal-bg' });
    const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', esc);
    bg.addEventListener('mousedown', (e) => e.target === bg && close());
    bg.append(h('div', { class: 'modal' }, h('h3', null, title), body, actions ? h('div', { class: 'row', style: null }, actions(close)) : null));
    document.body.append(bg);
    const first = bg.querySelector('input, textarea');
    if (first) first.focus();
    return close;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // Display titles step down in size as they get longer, so long file-derived names stay readable.
  const lenClass = (t) => { const n = String(t || '').length; return n <= 16 ? 'len-s' : n <= 30 ? 'len-m' : n <= 55 ? 'len-l' : 'len-xl'; };
  const bigTitle = (text, extra = 'display') => h('h1', { class: `${extra} ${lenClass(text)}`, title: text }, text);
  // Wordmark: "Studio Review" -> STUDIO●REVIEW
  function wordmark() {
    const parts = String(BOOT.brand || 'Studio Review').trim().toUpperCase().split(/\s+/);
    const out = [parts[0]];
    for (const w of parts.slice(1)) out.push(h('span', { class: 'brand-dot', 'aria-hidden': 'true' }, '●'), w);
    return out;
  }
  function header() {
    return h('header', { class: 'top' },
      h('a', { class: 'brand', href: '#/', 'aria-label': BOOT.brand }, wordmark()),
      h('div', { class: 'top-right' },
        themeSwitch(),
        !SHARE && state.admin ? h('button', {
          class: 'btn ghost sm',
          onclick: async () => { await api('/logout', { method: 'POST' }); state.admin = false; route(); },
        }, 'Sign out') : null));
  }

  // ---------- theme ----------
  // 'auto' follows the OS; the choice lives in a cookie so the server can set it before first paint.
  const THEMES = [
    ['auto', 'Match system', 'M12 3a9 9 0 1 0 0 18V3z M12 3a9 9 0 0 1 0 18'],
    ['light', 'Light mode', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4'],
    ['dark', 'Dark mode', 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  ];
  function currentTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  }
  function setTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    document.cookie = `qh_theme=${t}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    document.querySelectorAll('.theme-switch button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
    window.dispatchEvent(new Event('qh-theme'));
  }
  function themeSwitch() {
    const cur = currentTheme();
    return h('div', { class: 'theme-switch', role: 'group', 'aria-label': 'Theme' }, THEMES.map(([key, label, d]) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      for (const seg of d.split(' M').map((x, i) => (i ? 'M' + x : x))) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', seg);
        s.append(p);
      }
      return h('button', { type: 'button', class: key === cur ? 'on' : '', 'data-theme': key, title: label, 'aria-label': label, onclick: () => setTheme(key) }, s);
    }));
  }
  // When following the system, redraw canvases if the OS flips.
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => window.dispatchEvent(new Event('qh-theme'))); } catch { /* old browser */ }

  function render(...nodes) {
    fill(root, header(), h('main', { class: 'wrap' }, nodes));
  }

  function onCleanup(fn) { state.cleanup.push(fn); }
  function every(ms, fn) { const id = setInterval(fn, ms); onCleanup(() => clearInterval(id)); }
  function listen(target, ev, fn, opts) { target.addEventListener(ev, fn, opts); onCleanup(() => target.removeEventListener(ev, fn, opts)); }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { toast('Copy failed — select and copy manually', true); }
  }

  // ---------- routing ----------
  async function route() {
    state.cleanup.splice(0).forEach((fn) => { try { fn(); } catch { /* */ } });
    const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
    try {
      if (BOOT.mode === 'missing') return viewMessage('Link not found', 'This link does not exist or has been revoked.');
      if (SHARE) {
        if (parts[0] === 't' && parts[1]) return await viewTrack(parts[1]);
        return await viewShareHome();
      }
      if (!state.admin) return viewLogin();
      if (parts[0] === 'album' && parts[1]) return await viewAlbum(parts[1]);
      if (parts[0] === 'c' && parts[1]) return await viewHome(parts[1]);
      if (parts[0] === 'p' && parts[1]) return await viewProject(parts[1]);
      if (parts[0] === 't' && parts[1]) return await viewTrack(parts[1]);
      return await viewHome();
    } catch (e) {
      if (SHARE && e.status === 401 && e.data && e.data.needsPasscode) return viewUnlock();
      if (SHARE && (e.status === 404 || e.status === 410)) return viewMessage('Link unavailable', e.message);
      if (e.status === 401) return;
      viewMessage('Something went wrong', e.message);
    }
  }

  function viewMessage(title, msg) {
    fill(root, header(), h('main', { class: 'wrap center' }, h('div', { class: 'panel login' }, h('h1', null, title), h('p', { class: 'sub' }, msg))));
  }

  function viewLogin() {
    const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/login', { method: 'POST', body: { password: pw.value } });
          state.admin = true;
          route();
        } catch (err) { oops(err); pw.select(); }
      },
    }, pw, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
    fill(root, header(), h('main', { class: 'wrap center' }, h('div', { class: 'panel login' }, h('h1', null, 'Sign in'), form)));
    pw.focus();
  }

  function viewUnlock() {
    const pc = h('input', { type: 'password', placeholder: 'Passcode', required: true });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/unlock', { method: 'POST', body: { passcode: pc.value } });
          route();
        } catch (err) { oops(err); pc.select(); }
      },
    }, pc, h('button', { class: 'btn primary', type: 'submit' }, 'Listen'));
    fill(root, header(), h('main', { class: 'wrap center' }, h('div', { class: 'panel login' }, h('h1', null, 'This link is protected'), h('p', { class: 'sub' }, 'Enter the passcode you were given.'), form)));
    pc.focus();
  }

  // ---------- projects home (admin) ----------
  async function viewHome(clientId = null) {
    const [{ projects }, { clients }] = await Promise.all([api('/projects'), api('/clients')]);
    const only = clientId ? clients.find((c) => c.id === clientId) : null;
    if (clientId && !only) { location.hash = '#/'; return; }

    let pickedClient = clientId;
    const name = h('input', { type: 'text', placeholder: 'Project or record name', required: true });
    const artist = h('input', { type: 'text', placeholder: 'Artist' });
    const csel = clientSelect(clients, pickedClient, (id) => { pickedClient = id; });
    const form = h('form', {
      class: 'newproj',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const p = await api('/projects', { method: 'POST', body: { name: name.value, artist: artist.value, clientId: pickedClient } });
          location.hash = '#/p/' + p.id;
        } catch (err) { oops(err); }
      },
    }, name, artist, csel, h('button', { class: 'btn primary', type: 'submit' }, 'New project'));

    const card = (p, i) => h('a', { class: 'card', href: '#/p/' + p.id },
      h('div', { class: 'card-top' }, h('span', null, pad2(i + 1)), h('span', { class: p.openComments ? 'flag' : 'flag none' }, p.openComments ? `${p.openComments} open` : '—')),
      cover(p, '100%', 'card-cover'),
      h('div', { class: 't' }, p.name),
      p.artist ? h('div', { class: 'card-sub' }, p.artist) : null,
      h('div', { class: 'card-foot' },
        h('span', null, `${p.trackCount} track${p.trackCount === 1 ? '' : 's'}`),
        h('span', null, ago(p.updatedAt))));

    function clientActions(c) {
      return h('div', { class: 'row' },
        h('button', {
          class: 'btn sm ghost',
          onclick: async () => {
            const n = prompt('Client name', c.name);
            if (!n || !n.trim()) return;
            await api('/clients/' + c.id, { method: 'PATCH', body: { name: n.trim() } });
            route();
          },
        }, 'Rename'),
        h('button', {
          class: 'btn sm ghost danger',
          onclick: async () => {
            if (!confirm(`Delete the client "${c.name}"? Its projects are kept and become unassigned.`)) return;
            await api('/clients/' + c.id, { method: 'DELETE' });
            if (only) location.hash = '#/'; else route();
          },
        }, 'Delete'));
    }

    const section = (title, list, c) => h('section', { class: 'client-group' },
      h('div', { class: 'group-head' },
        only ? null : c ? h('a', { class: 'group-title', href: '#/c/' + c.id }, title) : h('h2', { class: 'group-title' }, title),
        h('span', { class: 'sub small' }, `${list.length} project${list.length === 1 ? '' : 's'}`),
        h('span', { class: 'grow' }),
        c ? clientActions(c) : null),
      list.length ? h('div', { class: 'grid' }, list.map(card))
        : h('div', { class: 'empty small' }, 'No projects yet — create one above with this client selected, or assign one from its project page.'));

    // One card per client. Cover = art from the client's newest project that has art.
    function clientCard(c, i) {
      const mine = projects.filter((p) => p.clientId === c.id).sort((a, b) => b.createdAt - a.createdAt);
      const withArt = mine.find((p) => p.art);
      const open = mine.reduce((n, p) => n + (p.openComments || 0), 0);
      const last = mine.reduce((t, p) => Math.max(t, p.updatedAt || 0), 0);
      return h('a', { class: 'card', href: '#/c/' + c.id },
        h('div', { class: 'card-top' }, h('span', null, pad2(i + 1)), h('span', { class: open ? 'flag' : 'flag none' }, open ? `${open} open` : '—')),
        cover({ id: c.id, name: c.name, art: withArt ? withArt.art : null }, '100%', 'card-cover'),
        h('div', { class: 't' }, c.name),
        h('div', { class: 'card-foot' },
          h('span', null, `${mine.length} project${mine.length === 1 ? '' : 's'}`),
          h('span', null, last ? ago(last) : '—')));
    }

    let body;
    if (only) {
      body = section(only.name, projects.filter((p) => p.clientId === only.id).sort((a, b) => b.createdAt - a.createdAt), only);
    } else if (!projects.length && !clients.length) {
      body = h('div', { class: 'empty' }, 'No projects yet. Create one, then drop your bounces and album art into it.');
    } else {
      const loose = projects.filter((p) => !p.clientId || !clients.some((c) => c.id === p.clientId));
      // Clients with the most recent activity first.
      const lastOf = (c) => projects.filter((p) => p.clientId === c.id).reduce((t, p) => Math.max(t, p.updatedAt || 0), c.createdAt || 0);
      const ordered = [...clients].sort((a, b) => lastOf(b) - lastOf(a));
      body = h('div', { class: 'stack' },
        clients.length ? h('section', { class: 'client-group' },
          h('div', { class: 'grid' }, ordered.map(clientCard))) : null,
        loose.length ? section(clients.length ? 'No client' : 'Projects', loose, null) : null);
    }

    const scope = only ? projects.filter((p) => p.clientId === only.id) : projects;
    const openTotal = scope.reduce((n, p) => n + (p.openComments || 0), 0);
    const stat = (label, value, accent) => h('div', { class: 'stat-cell' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' + (accent ? ' accent' : '') }, value));
    render(h('div', { class: 'stack' },
      only ? h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'All clients')) : null,
      h('div', { class: 'hero' },
        bigTitle(only ? only.name : clients.length ? 'Clients' : 'Projects'),
        h('div', { class: 'stats' },
          !only ? stat('Clients', pad2(clients.length)) : null,
          stat('Projects', pad2(scope.length)),
          stat('Open notes', pad2(openTotal), openTotal > 0))),
      h('div', { class: 'toolbar' }, form, !only ? h('button', {
        class: 'btn', type: 'button',
        onclick: async () => { try { if (await newClientPrompt()) route(); } catch (e) { oops(e); } },
      }, '+ Client') : null),
      body));
  }

  // ---------- project view ----------
  function trackRows(tracks, { admin, onChange }) {
    if (!tracks.length) return h('div', { class: 'empty' }, admin ? 'No tracks yet. Drop bounces here — "Song_v3.wav" becomes version 3 of "Song".' : 'Nothing here yet.');
    return h('div', { class: 'tracks' }, tracks.map((t, i) => {
      const v = t.latest;
      const status = !v ? null
        : v.status === 'error' ? h('span', { class: 'pill err' }, 'error')
          : v.status !== 'ready' ? h('span', { class: 'pill warn' }, 'processing') : null;
      const shown = t.latestReady || v;
      return h('div', { class: 'trow', onclick: () => { location.hash = '#/t/' + t.id; } },
        h('div', { class: 'n' }, i + 1),
        h('div', { class: 'name' }, t.name),
        h('div', { class: 'facts' },
          status,
          t.comments.open ? h('span', { class: 'pill count', title: 'Open notes' }, `${t.comments.open} open`) : null,
          shown ? h('span', { class: 'mono' }, `v${shown.number}`) : null,
          shown && shown.duration ? h('span', { class: 'mono' }, fmt(shown.duration)) : null,
          shown && shown.lufs != null ? h('span', { class: 'mono' }, `${shown.lufs.toFixed(1)} LUFS`) : null,
          admin ? h('span', { class: 'acts', onclick: (e) => e.stopPropagation() },
            h('button', { class: 'btn sm ghost', title: 'Move up', disabled: i === 0, onclick: async () => { await api(`/tracks/${t.id}/move`, { method: 'POST', body: { dir: -1 } }); onChange(); } }, '↑'),
            h('button', { class: 'btn sm ghost', title: 'Move down', disabled: i === tracks.length - 1, onclick: async () => { await api(`/tracks/${t.id}/move`, { method: 'POST', body: { dir: 1 } }); onChange(); } }, '↓'),
            h('button', {
              class: 'btn sm ghost danger', title: 'Delete track',
              onclick: async () => {
                if (!confirm(`Delete "${t.name}" and all ${t.versionCount} version(s) and notes?`)) return;
                await api(`/tracks/${t.id}`, { method: 'DELETE' });
                onChange();
              },
            }, '✕')) : null));
    }));
  }

  function openShareDialog({ projectId, trackId, name, onDone }) {
    const label = h('input', { type: 'text', placeholder: 'e.g. Band — mix round 2' });
    const pass = h('input', { type: 'text', placeholder: 'Optional', autocomplete: 'off' });
    const days = h('select', null, [['0', 'Never'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']].map(([v, t]) => h('option', { value: v }, t)));
    const dl = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'stack' },
      h('div', { class: 'sub small' }, trackId ? `Only "${name}" will be visible.` : 'Every track in this project will be visible, including ones you add later.'),
      h('label', { class: 'field' }, 'Label (for you)', label),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, 'Passcode', pass),
        h('label', { class: 'field' }, 'Expires', days)),
      h('label', { class: 'check' }, dl, 'Allow downloading the original files'));
    modal(trackId ? 'Share track' : 'Share project', body, (close) => [
      h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            const s = await api('/shares', { method: 'POST', body: { projectId, trackId, label: label.value, passcode: pass.value, expiresDays: Number(days.value), allowDownload: dl.checked } });
            close();
            showLink(s);
            if (onDone) onDone();
          } catch (e) { oops(e); }
        },
      }, 'Create link'),
    ]);
  }

  const shareUrl = (s) => (BOOT.publicUrl || location.origin) + '/s/' + s.token;

  function showLink(s) {
    const url = shareUrl(s);
    const input = h('input', { type: 'text', value: url, readonly: true, onfocus: (e) => e.target.select() });
    modal('Link ready', h('div', { class: 'stack' },
      h('div', { class: 'linkbox' }, input, h('button', { class: 'btn primary', onclick: () => copy(url) }, 'Copy')),
      h('div', { class: 'sub small' }, s.hasPasscode ? 'Send the passcode separately.' : 'Anyone with this link can listen and leave notes.')),
    (close) => [h('button', { class: 'btn', onclick: close }, 'Done')]);
  }

  function activityLine(a) {
    if (!a || !a.opens) return h('div', { class: 'act none' }, 'Not opened yet');
    const who = a.names.length
      ? a.names.join(', ') + (a.visitors > a.names.length ? ` +${a.visitors - a.names.length}` : '')
      : `${a.visitors} ${a.visitors === 1 ? 'person' : 'people'}`;
    return h('div', { class: 'act' },
      h('span', { class: 'dot' }),
      `Opened ${a.opens}× by ${who}`,
      a.plays ? ` · ${a.plays} play${a.plays === 1 ? '' : 's'}` : ' · not played yet',
      a.downloads ? ` · ${a.downloads} download${a.downloads === 1 ? '' : 's'}` : '',
      ` · last ${ago(a.lastSeen)}`);
  }

  const ACT_TEXT = {
    open: () => 'opened the link',
    track: (e) => `viewed ${e.track || 'a deleted track'}`,
    play: (e) => `played ${e.track || 'a deleted track'}${e.version != null ? ` v${e.version}` : ''}`,
    download: (e) => `downloaded ${e.track || 'a deleted track'}${e.version != null ? ` v${e.version}` : ''}`,
    comment: (e) => `left a note on ${e.track || 'a deleted track'}${e.version != null ? ` v${e.version}` : ''}`,
  };

  async function openActivity(s) {
    const d = await api(`/shares/${s.id}/activity`);
    const title = s.label || (s.scope === 'track' ? s.trackName : 'Whole project');
    const body = d.events.length
      ? h('div', { class: 'actlist' }, d.events.map((e) => h('div', { class: 'actrow' + (e.kind === 'play' || e.kind === 'download' || e.kind === 'comment' ? ' strong' : '') },
        h('div', null, h('b', null, e.who), ' ', (ACT_TEXT[e.kind] || (() => e.kind))(e)),
        h('div', { class: 'small sub', title: new Date(e.at).toLocaleString() }, `${ago(e.at)} · ${e.device}`))))
      : h('div', { class: 'sub' }, 'Nobody has opened this link yet.');
    modal(`Activity — ${title}`, h('div', { class: 'stack' },
      activityLine(d.share.activity),
      body,
      h('div', { class: 'small sub' }, 'Visitors show by name once they’ve typed one to leave a note. Your own visits aren’t counted. Link previews in iMessage/Slack/email don’t count as opens.')),
    (close) => [h('button', { class: 'btn', onclick: close }, 'Close')]);
  }

  function sharesPanel(projectId) {
    const box = h('div', { class: 'panel shares' }, h('div', { class: 'sub small' }, 'Loading…'));
    const load = async () => {
      const { shares } = await api('/shares?projectId=' + encodeURIComponent(projectId));
      fill(box, 
        h('div', { class: 'row between' }, h('h2', null, 'Share links'),
          h('button', { class: 'btn sm', onclick: () => openShareDialog({ projectId, onDone: load }) }, '+ Project link')),
        shares.length ? null : h('div', { class: 'sub small' }, 'No links yet. Clients listen and comment without an account.'),
        shares.map((s) => {
          const expired = s.expiresAt && s.expiresAt < Date.now();
          return h('div', { class: 'srow' },
            h('div', { class: 'grow' },
              h('div', null, s.label || (s.scope === 'track' ? s.trackName : 'Whole project'),
                ' ', h('span', { class: 'pill' }, s.scope === 'track' ? 'track' : 'project'),
                s.hasPasscode ? h('span', { class: 'pill' }, ' passcode') : null,
                s.allowDownload ? h('span', { class: 'pill' }, 'downloads') : null,
                expired ? h('span', { class: 'pill err' }, 'expired') : s.expiresAt ? h('span', { class: 'pill' }, 'until ' + new Date(s.expiresAt).toLocaleDateString()) : null),
              h('div', { class: 'url' }, shareUrl(s)),
              activityLine(s.activity)),
            h('button', { class: 'btn sm', onclick: () => openActivity(s).catch(oops) }, 'Activity'),
            h('button', { class: 'btn sm', onclick: () => copy(shareUrl(s)) }, 'Copy'),
            h('a', { class: 'btn sm ghost', href: shareUrl(s), target: '_blank', rel: 'noopener' }, 'Open'),
            h('button', {
              class: 'btn sm ghost danger',
              onclick: async () => {
                if (!confirm('Revoke this link? Anyone using it loses access immediately.')) return;
                await api('/shares/' + s.id, { method: 'DELETE' });
                load();
              },
            }, 'Revoke'));
        }));
    };
    load().catch(oops);
    every(30000, () => load().catch(() => {}));
    return { el: box, reload: load };
  }

  async function viewProject(id) {
    let data = await api('/projects/' + id);
    let clients = (await api('/clients')).clients;
    const artInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    async function setArt(file) {
      if (!file) return;
      toast('Uploading album art…');
      try {
        const r = await uploadArt(id, file);
        data.project.art = r.art;
        drawTitle();
        toast('Album art updated');
      } catch (e) { oops(e); } finally { artInput.value = ''; }
    }
    artInput.addEventListener('change', () => setArt(artInput.files[0]));
    const listBox = h('div');
    const titleBox = h('div');
    const progress = h('div', { class: 'progress hidden' }, h('i'));
    const fileInput = h('input', { type: 'file', multiple: true, accept: 'audio/*,.wav,.aif,.aiff,.flac', class: 'hidden' });
    const drop = h('div', { class: 'drop', onclick: () => fileInput.click() },
      h('b', null, 'Drop bounces here'), ' or click to choose. ',
      h('span', { class: 'small' }, '“Song_v3.wav” becomes version 3 of “Song”. Drop an image to set the album art.'), progress);
    const shares = sharesPanel(id);

    const drawTitle = () => {
      const p = data.project;
      const client = data.client;
      const artBox = h('div', { class: 'art-edit', title: p.art ? 'Click or drop an image to replace the album art' : 'Click or drop an image to add album art', onclick: () => artInput.click() },
        cover(p, '148px'),
        h('div', { class: 'art-hint' }, p.art ? 'Replace art' : 'Add album art'));
      fill(titleBox,
        h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projects'), client ? [' / ', h('a', { href: '#/c/' + client.id }, client.name)] : null),
        h('div', { class: 'project-head' },
          artBox,
          h('div', { class: 'grow stack-sm' },
            bigTitle(p.name, 'proj-title'),
            p.artist ? h('div', { class: 'sub' }, p.artist) : null,
            h('label', { class: 'field inline' }, 'Client',
              clientSelect(clients, p.clientId, async (cid, created) => {
                try {
                  if (created) clients = (await api('/clients')).clients;
                  await api('/projects/' + id, { method: 'PATCH', body: { clientId: cid } });
                  await refresh();
                  toast(cid ? 'Assigned to ' + (clients.find((c) => c.id === cid) || {}).name : 'Removed from client');
                } catch (e) { oops(e); }
              })),
            p.art ? h('button', {
              class: 'linkish small',
              onclick: async () => {
                if (!confirm('Remove the album art?')) return;
                await api(`/projects/${id}/art`, { method: 'DELETE' });
                data.project.art = null;
                drawTitle();
              },
            }, 'Remove art') : null),
          h('div', { class: 'row self-start' },
            h('button', {
              class: 'btn sm primary',
              title: 'Open the whole project as an album, with gapless playback and mastering QC, in its own window',
              onclick: () => window.open(`/#/album/${id}`, `qh-album-${id}`, 'popup,width=1500,height=940'),
            }, 'Album view'),
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                const n = prompt('Project name', p.name);
                if (n == null) return;
                const a = prompt('Artist', p.artist);
                await api('/projects/' + id, { method: 'PATCH', body: { name: n, artist: a ?? p.artist } });
                refresh();
              },
            }, 'Rename'),
            h('button', {
              class: 'btn sm ghost danger',
              onclick: async () => {
                if (prompt(`Type the project name to delete it and every file in it:\n${p.name}`) !== p.name) return;
                await api('/projects/' + id, { method: 'DELETE' });
                location.hash = '#/';
              },
            }, 'Delete'))));
    };
    const drawList = () => fill(listBox, trackRows(data.tracks, { admin: true, onChange: refresh }));
    const refresh = async () => {
      data = await api('/projects/' + id);
      drawTitle();
      drawList();
    };

    async function doUpload(files) {
      files = [...files];
      const img = files.find(isImage);
      if (img) setArt(img);
      files = files.filter((f) => !isImage(f));
      if (!files.length) return;
      progress.classList.remove('hidden');
      const bar = progress.firstChild;
      try {
        const r = await uploadFiles(id, files, null, (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; });
        toast(`${r.created.length} file${r.created.length === 1 ? '' : 's'} uploaded — processing`);
        await refresh();
      } catch (e) { oops(e); } finally {
        progress.classList.add('hidden');
        bar.style.width = '0';
        fileInput.value = '';
      }
    }
    fileInput.addEventListener('change', () => doUpload(fileInput.files));
    installDrop(doUpload);

    every(3000, () => {
      if (data.tracks.some((t) => t.latest && ['queued', 'processing'].includes(t.latest.status))) refresh().catch(() => {});
    });

    drawTitle();
    drawList();
    render(h('div', { class: 'stack' }, titleBox, artInput, drop, fileInput, listBox, shares.el));
  }

  function installDrop(onFiles) {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    listen(window, 'dragenter', (e) => { if (!hasFiles(e)) return; depth++; document.body.classList.add('dragging'); });
    listen(window, 'dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    listen(window, 'dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    listen(window, 'drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      onFiles(e.dataTransfer.files);
    });
    onCleanup(() => document.body.classList.remove('dragging'));
  }

  // ---------- share home ----------
  async function viewShareHome() {
    const d = await api('');
    if (d.share.scope === 'track' && d.tracks[0]) {
      history.replaceState(null, '', '#/t/' + d.tracks[0].id);
      return viewTrack(d.tracks[0].id);
    }
    const listBox = h('div', null, trackRows(d.tracks, { admin: false }));
    every(20000, async () => {
      const n = await api('').catch(() => null);
      if (n) fill(listBox, trackRows(n.tracks, { admin: false }));
    });
    render(h('div', { class: 'stack' },
      h('div', { class: 'project-head' },
        d.project.art ? cover(d.project, '148px') : null,
        h('div', { class: 'grow' }, h('h1', null, d.project.name), d.project.artist ? h('div', { class: 'sub' }, d.project.artist) : null)),
      listBox));
  }

  // ---------- track / player ----------
  async function viewTrack(trackId) {
    let d = await api('/tracks/' + trackId);
    const audio = new Audio();
    audio.preload = 'auto';
    const peaksCache = new Map();
    const st = {
      vid: null, prevVid: null, peaks: null, sel: null, hoverX: null, drag: null,
      frozen: null, showAll: false, hideResolved: false, focusId: null, replyTo: null,
      match: ls.get('qh_match') === '1', autoNext: ls.get('qh_autonext') === '1',
    };
    const ver = (id) => d.versions.find((v) => v.id === id);
    const cur = () => ver(st.vid);

    onCleanup(() => { audio.pause(); audio.removeAttribute('src'); audio.load(); });

    // --- initial version: newest ready one ---
    const readyDesc = [...d.versions].reverse();
    st.vid = (readyDesc.find((v) => v.status === 'ready') || readyDesc[0] || {}).id || null;

    // --- elements ---
    const titleBox = h('div');
    const versionsBox = h('div', { class: 'versions' });
    const metaBox = h('div', { class: 'stack' });
    const canvas = h('canvas', { class: 'wave' });
    const waveStatus = h('div', { class: 'wave-status' });
    const tip = h('div', { class: 'tip hidden' });
    const playBtn = h('button', { class: 'play', title: 'Play / pause (space)', onclick: () => toggle() }, svg(ICON_PLAY));
    const clock = h('div', { class: 'clock' }, h('span', null, '0:00.0'), h('span', { class: 'd' }, ' / 0:00'));
    const commentsBox = h('div', { class: 'clist' });
    const composerBox = h('div');

    // --- title ---
    function drawTitle() {
      const crumbs = SHARE
        ? h('div', { class: 'crumbs' }, d.prev || d.next ? h('a', { href: '#/' }, d.project.name) : d.project.name)
        : h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projects'), ' / ', h('a', { href: '#/p/' + d.project.id }, d.project.name));
      fill(titleBox, crumbs, h('div', { class: 'titlebar' },
        h('div', { class: 'track-head' },
          h('div', { class: 'track-no' }, pad2((d.track.position ?? 0) + 1)),
          h('div', { style: 'min-width:0' }, bigTitle(d.track.name), h('div', { class: 'sub' }, [d.project.artist, d.project.name].filter(Boolean).join(' · ')))),
        h('div', { class: 'row' },
          d.prev ? h('a', { class: 'btn sm ghost', href: '#/t/' + d.prev.id, title: d.prev.name }, '← Prev') : null,
          d.next ? h('a', { class: 'btn sm ghost', href: '#/t/' + d.next.id, title: d.next.name }, 'Next →') : null,
          !SHARE ? h('button', {
            class: 'btn sm',
            onclick: async () => {
              const n = prompt('Track name', d.track.name);
              if (!n) return;
              await api('/tracks/' + d.track.id, { method: 'PATCH', body: { name: n } });
              await refresh();
            },
          }, 'Rename') : null,
          !SHARE ? h('button', { class: 'btn sm', onclick: () => openShareDialog({ projectId: d.project.id, trackId: d.track.id, name: d.track.name }) }, 'Share track') : null)));
    }

    // --- versions ---
    function drawVersions() {
      const chips = d.versions.map((v, i) => h('button', {
        class: 'vchip' + (v.id === st.vid ? ' on' : '') + (['queued', 'processing'].includes(v.status) ? ' busy' : '') + (v.status === 'error' ? ' bad' : ''),
        title: `${v.note || v.originalName}${i < 9 ? ` (key ${i + 1})` : ''}`,
        onclick: () => loadVersion(v.id),
      }, `v${v.number}`));
      let upload = null;
      if (!SHARE) {
        const fi = h('input', { type: 'file', class: 'hidden', accept: 'audio/*,.wav,.aif,.aiff,.flac' });
        fi.addEventListener('change', async () => {
          if (!fi.files.length) return;
          toast('Uploading…');
          try {
            await uploadFiles(d.project.id, fi.files, d.track.id, null);
            toast('New version uploaded — processing');
            await refresh(true);
          } catch (e) { oops(e); }
        });
        upload = [fi, h('button', { class: 'btn sm', onclick: () => fi.click() }, '+ New version')];
      }
      fill(versionsBox, ...chips, upload,
        d.versions.length > 1 ? h('label', { class: 'check', title: 'Turns louder versions down to the quietest one so A/B is fair' },
          h('input', { type: 'checkbox', checked: st.match, onchange: (e) => { st.match = e.target.checked; ls.set('qh_match', st.match ? '1' : '0'); applyVolume(); } }),
          'Match loudness') : null);
    }

    // --- meta ---
    function drawMeta() {
      const v = cur();
      if (!v) { fill(metaBox, ); return; }
      const line = h('div', { class: 'meta-line' },
        h('span', null, h('b', null, `v${v.number}`), ' · ', ago(v.createdAt)),
        v.status === 'ready' ? [
          h('span', { class: 'mono' }, fmtRate(v)),
          h('span', { class: 'mono', title: 'Integrated loudness' }, h('b', null, db1(v.lufs, 'LUFS'))),
          h('span', { class: 'mono', title: 'True peak' }, db1(v.truePeak, 'dBTP')),
          h('span', { class: 'mono', title: 'Loudness range' }, 'LRA ' + db1(v.lra, 'LU')),
        ] : v.status === 'error' ? h('span', { class: 'pill err' }, v.error || 'processing failed')
          : h('span', { class: 'pill warn' }, 'processing…'));
      const note = v.note ? h('div', { class: 'note' }, v.note) : null;
      const actions = h('div', { class: 'row' },
        d.allowDownload ? h('a', { class: 'btn sm', href: mediaUrl(v.id, 'original'), download: '' }, `Download ${v.originalName.split('.').pop().toUpperCase()}`) : null,
        !SHARE ? [
          h('button', {
            class: 'btn sm',
            onclick: async () => {
              const n = prompt('Version note (what changed)', v.note);
              if (n == null) return;
              await api('/versions/' + v.id, { method: 'PATCH', body: { note: n } });
              await refresh();
            },
          }, v.note ? 'Edit note' : 'Add note'),
          exportMenu(v),
          v.status === 'error' ? h('button', { class: 'btn sm', onclick: async () => { await api(`/versions/${v.id}/reprocess`, { method: 'POST' }); await refresh(); } }, 'Retry') : null,
          h('button', {
            class: 'btn sm ghost danger',
            onclick: async () => {
              if (!confirm(`Delete v${v.number} and its notes?`)) return;
              await api('/versions/' + v.id, { method: 'DELETE' });
              st.vid = null;
              await refresh(true);
            },
          }, 'Delete version'),
        ] : null);
      fill(metaBox, line, note, actions);
    }

    function exportMenu(v) {
      const sel = h('select', {
        class: 'btn sm',
        title: 'Export notes as markers',
        onchange: () => {
          if (!sel.value) return;
          const a = h('a', { href: `/api/versions/${v.id}/markers?format=${sel.value}`, download: '' });
          document.body.append(a);
          a.click();
          a.remove();
          sel.value = '';
        },
      },
      h('option', { value: '' }, 'Export notes…'),
      h('option', { value: 'text' }, 'Revision list (.txt)'),
      h('option', { value: 'reaper' }, 'Reaper markers/regions (.csv)'),
      h('option', { value: 'audacity' }, 'Label track (.txt)'),
      h('option', { value: 'csv' }, 'Spreadsheet (.csv)'));
      return sel;
    }

    // --- audio ---
    function applyVolume() {
      const v = cur();
      if (!st.match || !v || v.lufs == null) { audio.volume = 1; return; }
      const levels = d.versions.filter((x) => x.status === 'ready' && x.lufs != null).map((x) => x.lufs);
      const target = Math.min(...levels);
      audio.volume = Math.max(0, Math.min(1, Math.pow(10, (target - v.lufs) / 20)));
    }

    function loadVersion(vid, { autoplay = false } = {}) {
      const v = ver(vid);
      if (!v) return;
      const t = audio.currentTime || 0;
      const playing = !audio.paused || autoplay;
      if (st.vid !== vid) st.prevVid = st.vid;
      st.vid = vid;
      st.sel = null;
      st.peaks = peaksCache.get(vid) || null;
      drawVersions();
      drawMeta();
      drawComments();
      drawComposer();
      if (v.status !== 'ready') {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        waveStatus.textContent = v.status === 'error' ? 'This version failed to process.' : 'Processing…';
        draw();
        return;
      }
      waveStatus.textContent = st.peaks ? '' : 'Loading waveform…';
      audio.src = mediaUrl(vid, 'stream');
      audio.addEventListener('loadedmetadata', () => {
        try { audio.currentTime = Math.min(t, Math.max(0, audio.duration - 0.05)); } catch { /* */ }
        if (playing) audio.play().catch(() => {});
      }, { once: true });
      applyVolume();
      if (!st.peaks) {
        fetch(mediaUrl(vid, 'peaks'), { credentials: 'same-origin' }).then((r) => r.json()).then((p) => {
          peaksCache.set(vid, p.peaks);
          if (st.vid === vid) { st.peaks = p.peaks; waveStatus.textContent = ''; draw(); }
        }).catch(() => { waveStatus.textContent = ''; });
      }
      draw();
    }

    function toggle() {
      if (!audio.src) return;
      if (audio.paused) audio.play().catch(oops); else audio.pause();
    }
    const seek = (t) => {
      const dur = duration();
      if (!audio.src || !dur) return;
      audio.currentTime = Math.max(0, Math.min(dur - 0.01, t));
      draw();
    };
    const duration = () => (cur() && cur().duration) || audio.duration || 0;

    const reportedPlays = new Set();
    listen(audio, 'play', () => {
      fill(playBtn, svg(ICON_PAUSE));
      loop();
      if (SHARE && st.vid && !reportedPlays.has(st.vid)) {
        reportedPlays.add(st.vid);
        api('/events', { method: 'POST', body: { kind: 'play', versionId: st.vid, name: ls.get('qh_name') || '' } }).catch(() => {});
      }
    });
    listen(audio, 'pause', () => fill(playBtn, svg(ICON_PLAY)));
    listen(audio, 'timeupdate', () => { if (audio.paused) draw(); });
    listen(audio, 'ended', () => {
      if (st.autoNext && d.next) {
        try { sessionStorage.setItem('qh_autoplay', '1'); } catch { /* */ }
        location.hash = '#/t/' + d.next.id;
      }
    });
    let raf = 0;
    function loop() {
      cancelAnimationFrame(raf);
      const tick = () => { draw(); if (!audio.paused) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    }
    onCleanup(() => cancelAnimationFrame(raf));

    // --- waveform ---
    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const MARK_H = 20;
    const noteNumbers = () => new Map(visibleComments().sort((a, b) => a.start - b.start || a.createdAt - b.createdAt).map((c, k) => [c.id, k + 1]));

    function visibleComments() {
      return d.comments.filter((c) => !c.parentId && (st.showAll || c.versionId === st.vid) && !(st.hideResolved && c.resolved));
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const hgt = canvas.clientHeight;
      if (!w) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(hgt * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      const dur = duration();
      const pos = dur ? audio.currentTime / dur : 0;
      const top = MARK_H + 4;
      const mid = top + (hgt - top) / 2;
      const amp = (hgt - top) / 2 - 1;

      // selection
      const sel = st.drag || st.sel;
      if (sel && dur) {
        const a = (Math.min(sel.start, sel.end) / dur) * w;
        const b = (Math.max(sel.start, sel.end) / dur) * w;
        ctx.fillStyle = css('--sel');
        ctx.fillRect(a, top, Math.max(1, b - a), hgt - top);
      }

      // bars
      const peaks = st.peaks;
      const bw = 2;
      const gap = 1;
      const n = Math.floor(w / (bw + gap));
      const cWave = css('--wave');
      const cPlayed = css('--wave-played');
      for (let i = 0; i < n; i++) {
        let p = 0.02;
        if (peaks && peaks.length) {
          const a = Math.floor((i / n) * peaks.length);
          const b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
          for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > p) p = peaks[k];
        }
        const x = i * (bw + gap);
        const bh = Math.max(1, p * amp);
        ctx.fillStyle = x / w < pos ? cPlayed : cWave;
        ctx.fillRect(x, mid - bh, bw, bh * 2);
      }

      // comment markers
      if (dur) {
        const cm = css('--marker');
        const nums = noteNumbers();
        const box = 16;
        ctx.font = '600 10px ' + css('--mono');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const c of visibleComments()) {
          const x = (c.start / dur) * w;
          ctx.globalAlpha = c.resolved ? 0.35 : c.versionId === st.vid ? 1 : 0.55;
          ctx.fillStyle = cm;
          if (c.end != null) {
            const x2 = (c.end / dur) * w;
            ctx.fillRect(x, MARK_H - 3, Math.max(2, x2 - x), 3);
          }
          const bx = Math.max(0, Math.min(w - box, x - box / 2));
          ctx.fillRect(bx, 0, box, box);
          if (c.id === st.focusId) { ctx.strokeStyle = css('--text'); ctx.lineWidth = 1.5; ctx.strokeRect(bx - 1.5, -0.5, box + 3, box + 2); }
          ctx.fillStyle = css('--accent-ink');
          ctx.fillText(String(nums.get(c.id) || ''), bx + box / 2, box / 2 + 0.5);
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = cm;
          ctx.fillRect(x, top, 1, hgt - top);
        }
        ctx.globalAlpha = 1;
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }

      // playhead + hover
      if (dur) {
        ctx.fillStyle = css('--text');
        ctx.fillRect(Math.round(pos * w), top - 2, 1.5, hgt - top + 2);
      }
      if (st.hoverX != null) {
        ctx.fillStyle = css('--muted');
        ctx.globalAlpha = 0.6;
        ctx.fillRect(Math.round(st.hoverX), top, 1, hgt - top);
        ctx.globalAlpha = 1;
      }

      clock.firstChild.textContent = fmt(audio.currentTime, true);
      clock.lastChild.textContent = ' / ' + fmt(dur);
    }

    const xToTime = (x) => (x / canvas.clientWidth) * duration();
    function markerAt(x, y) {
      if (y > MARK_H + 4) return null;
      const dur = duration();
      if (!dur) return null;
      let best = null;
      let bestD = 8;
      for (const c of visibleComments()) {
        const dd = Math.abs((c.start / dur) * canvas.clientWidth - x);
        if (dd < bestD) { best = c; bestD = dd; }
      }
      return best;
    }
    const localXY = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    canvas.addEventListener('pointerdown', (e) => {
      if (!duration()) return;
      const [x, y] = localXY(e);
      const m = markerAt(x, y);
      if (m) { focusComment(m.id, true); return; }
      canvas.setPointerCapture(e.pointerId);
      st.drag = { x0: x, start: xToTime(x), end: xToTime(x), moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = localXY(e);
      st.hoverX = x;
      const m = markerAt(x, y);
      if (m) {
        tip.textContent = `${m.author}: ${m.body}`;
        tip.style.left = Math.max(60, Math.min(canvas.clientWidth - 60, x)) + 14 + 'px';
        tip.classList.remove('hidden');
      } else if (duration()) {
        tip.textContent = fmt(xToTime(x), true);
        tip.style.left = x + 14 + 'px';
        tip.classList.remove('hidden');
      }
      if (st.drag) {
        if (Math.abs(x - st.drag.x0) > 4) st.drag.moved = true;
        st.drag.end = Math.max(0, Math.min(duration(), xToTime(x)));
      }
      draw();
    });
    canvas.addEventListener('pointerleave', () => { st.hoverX = null; tip.classList.add('hidden'); draw(); });
    canvas.addEventListener('pointerup', () => {
      const dr = st.drag;
      st.drag = null;
      if (!dr) return;
      if (dr.moved) {
        st.sel = { start: Math.min(dr.start, dr.end), end: Math.max(dr.start, dr.end) };
        st.frozen = null;
        seek(st.sel.start);
        drawComposer();
        composerInput()?.focus();
      } else {
        st.sel = null;
        seek(dr.start);
        drawComposer();
      }
      draw();
    });
    listen(window, 'qh-theme', () => draw());
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    onCleanup(() => ro.disconnect());

    // --- composer ---
    let draft = '';
    const composerInput = () => composerBox.querySelector('textarea');
    function composerTime() {
      if (st.sel) return { start: st.sel.start, end: st.sel.end };
      return { start: st.frozen ?? audio.currentTime, end: null };
    }
    function drawComposer() {
      const v = cur();
      if (!v || v.status !== 'ready') { fill(composerBox, ); return; }
      const t = composerTime();
      const at = h('span', { class: 'at' },
        '@ ' + fmt(t.start, true) + (t.end != null ? ' → ' + fmt(t.end, true) : ''),
        st.sel || st.frozen != null ? h('button', { title: 'Use the playhead instead', onclick: () => { st.sel = null; st.frozen = null; drawComposer(); draw(); } }, '✕') : null);
      const ta = h('textarea', {
        rows: 2,
        placeholder: `Note at ${fmt(t.start)} for v${v.number} — drag across the waveform to mark a range`,
        oninput: (e) => { draft = e.target.value; },
        onfocus: () => {
          if (!st.sel && st.frozen == null) { st.frozen = audio.currentTime; at.firstChild.textContent = '@ ' + fmt(st.frozen, true); }
        },
        onkeydown: (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.target.blur(); }
        },
      });
      ta.value = draft;
      const nameIn = SHARE ? h('input', { type: 'text', placeholder: 'Your name', value: ls.get('qh_name') || '', maxlength: 60 }) : null;
      async function submit() {
        const body = ta.value.trim();
        if (!body) return;
        const tt = composerTime();
        const payload = { body, start: tt.start, end: tt.end };
        if (SHARE) {
          const nm = nameIn.value.trim();
          if (!nm) { nameIn.focus(); toast('Add your name so we know who said it', true); return; }
          ls.set('qh_name', nm);
          payload.author = nm;
        }
        try {
          const c = await api(`/versions/${v.id}/comments`, { method: 'POST', body: payload });
          d.comments.push(c);
          draft = '';
          st.sel = null;
          st.frozen = null;
          drawComposer();
          drawComments();
          draw();
          composerInput()?.blur();
        } catch (e) { oops(e); }
      }
      fill(composerBox, h('div', { class: 'composer' },
        h('div', { class: 'row between' }, at, h('span', { class: 'small sub' }, h('span', { class: 'kbd' }, 'Enter'), ' to post · ', h('span', { class: 'kbd' }, 'C'), ' to focus')),
        ta,
        h('div', { class: 'row' }, nameIn, h('span', { class: 'grow' }), h('button', { class: 'btn primary sm', onclick: submit }, 'Post note'))));
    }

    // --- comments ---
    function focusComment(id, doSeek) {
      const c = d.comments.find((x) => x.id === id);
      if (!c) return;
      st.focusId = id;
      if (doSeek) seek(c.start);
      drawComments();
      draw();
      const el = commentsBox.querySelector(`[data-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function commentEl(c, isReply) {
      const v = ver(c.versionId);
      const who = h('div', { class: 'who' },
        c.author,
        c.isOwner ? h('span', { class: 'owner' }, 'engineer') : null,
        v && c.versionId !== st.vid ? h('span', { class: 'vtag' }, `v${v.number}`) : null,
        h('span', { class: 'when' }, ago(c.createdAt)));
      const acts = h('div', { class: 'cacts' },
        !isReply ? h('button', { onclick: () => { st.replyTo = st.replyTo === c.id ? null : c.id; drawComments(); commentsBox.querySelector('.reply-box textarea')?.focus(); } }, 'Reply') : null,
        !SHARE && !isReply ? h('button', {
          onclick: async () => {
            await api('/comments/' + c.id, { method: 'PATCH', body: { resolved: !c.resolved } });
            c.resolved = !c.resolved;
            drawComments();
            draw();
          },
        }, c.resolved ? 'Reopen' : 'Resolve') : null,
        !SHARE ? h('button', {
          onclick: async () => {
            if (!confirm('Delete this note?')) return;
            await api('/comments/' + c.id, { method: 'DELETE' });
            d.comments = d.comments.filter((x) => x.id !== c.id && x.parentId !== c.id);
            drawComments();
            draw();
          },
        }, 'Delete') : null);
      if (isReply) return h('div', null, who, h('div', { class: 'body' }, c.body), !SHARE ? acts : null);

      const replies = d.comments.filter((r) => r.parentId === c.id).sort((a, b) => a.createdAt - b.createdAt);
      let replyBox = null;
      if (st.replyTo === c.id) {
        const ta = h('textarea', { rows: 2, placeholder: 'Reply…' });
        const nameIn = SHARE ? h('input', { type: 'text', placeholder: 'Your name', value: ls.get('qh_name') || '', maxlength: 60 }) : null;
        const send = async () => {
          const body = ta.value.trim();
          if (!body) return;
          const payload = { body, parentId: c.id };
          if (SHARE) {
            const nm = nameIn.value.trim();
            if (!nm) { nameIn.focus(); return; }
            ls.set('qh_name', nm);
            payload.author = nm;
          }
          try {
            const r = await api(`/versions/${c.versionId}/comments`, { method: 'POST', body: payload });
            d.comments.push(r);
            st.replyTo = null;
            drawComments();
          } catch (e) { oops(e); }
        };
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
        replyBox = h('div', { class: 'reply-box stack' }, ta, h('div', { class: 'row' }, nameIn, h('button', { class: 'btn sm primary', onclick: send }, 'Reply'), h('button', { class: 'btn sm ghost', onclick: () => { st.replyTo = null; drawComments(); } }, 'Cancel')));
      }
      return h('div', { class: 'comment' + (c.resolved ? ' resolved' : '') + (st.focusId === c.id ? ' focus' : ''), 'data-id': c.id },
        h('div', { class: 'cnum-col' },
          h('span', { class: 'cnum' }, String(noteNumbers().get(c.id) || '')),
          h('button', { class: 'tc', onclick: () => focusComment(c.id, true), title: 'Jump here' }, fmt(c.start, true) + (c.end != null ? `\n→${fmt(c.end, true)}` : ''))),
        h('div', null, who, h('div', { class: 'body' }, c.body), acts,
          replies.length || replyBox ? h('div', { class: 'replies' }, replies.map((r) => commentEl(r, true)), replyBox) : null));
    }

    function drawComments() {
      const list = visibleComments().sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
      const other = d.comments.filter((c) => !c.parentId && c.versionId !== st.vid).length;
      const open = list.filter((c) => !c.resolved).length;
      fill(commentsBox, 
        h('div', { class: 'row between' },
          h('h2', null, `Notes${list.length ? ` · ${open} open` : ''}`),
          h('div', { class: 'row' },
            other ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.showAll, onchange: (e) => { st.showAll = e.target.checked; drawComments(); draw(); } }), `Show notes from other versions (${other})`) : null,
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.hideResolved, onchange: (e) => { st.hideResolved = e.target.checked; drawComments(); draw(); } }), 'Hide resolved'))),
        list.length ? h('div', { class: 'clist' }, list.map((c) => commentEl(c, false)))
          : h('div', { class: 'sub small' }, 'No notes on this version yet. Click the waveform to pick a spot, or drag to mark a range.'));
    }

    // --- refresh / polling ---
    async function refresh(reselect = false) {
      const prevVersions = d.versions;
      d = await api('/tracks/' + trackId);
      const wasReady = new Set(prevVersions.filter((v) => v.status === 'ready').map((v) => v.id));
      if (reselect || !ver(st.vid)) {
        const latest = d.versions[d.versions.length - 1];
        if (latest) loadVersion(latest.id); else st.vid = null;
      } else if (cur() && cur().status === 'ready' && !wasReady.has(st.vid)) {
        loadVersion(st.vid); // just finished processing
      }
      drawTitle();
      drawVersions();
      drawMeta();
      if (!st.replyTo && document.activeElement?.tagName !== 'TEXTAREA') drawComments();
      draw();
    }
    every(3000, () => {
      if (d.versions.some((v) => ['queued', 'processing'].includes(v.status))) refresh().catch(() => {});
    });
    every(15000, () => refresh().catch(() => {}));

    // --- keyboard ---
    listen(document, 'keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.modal-bg')) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(audio.currentTime - (e.shiftKey ? 1 : 5)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(audio.currentTime + (e.shiftKey ? 1 : 5)); }
      else if (e.key === 'Home' || e.key === '0') { e.preventDefault(); seek(0); }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); composerInput()?.focus(); }
      else if (e.key === 'a' || e.key === 'A') { if (st.prevVid && ver(st.prevVid)) loadVersion(st.prevVid); }
      else if (/^[1-9]$/.test(e.key)) { const v = d.versions[Number(e.key) - 1]; if (v) loadVersion(v.id); }
      else if (e.key === 'Escape') { st.sel = null; st.frozen = null; drawComposer(); draw(); }
    });

    // --- mount ---
    drawTitle();
    const autoNext = d.next || d.prev ? h('label', { class: 'check', title: 'When this track ends, go to the next one' },
      h('input', { type: 'checkbox', checked: st.autoNext, onchange: (e) => { st.autoNext = e.target.checked; ls.set('qh_autonext', st.autoNext ? '1' : '0'); } }),
      'Continue to next track') : null;
    render(h('div', { class: 'stack' },
      titleBox,
      d.versions.length ? h('div', { class: 'stack' },
        versionsBox,
        metaBox,
        h('div', { class: 'wavebox' }, canvas, waveStatus, tip,
          h('div', { class: 'transport' }, playBtn, clock, h('span', { class: 'grow' }), autoNext,
            h('span', { class: 'small sub' }, h('span', { class: 'kbd' }, 'space'), ' play · ', h('span', { class: 'kbd' }, '←→'), ' 5s · ', h('span', { class: 'kbd' }, '1–9'), ' version · ', h('span', { class: 'kbd' }, 'A'), ' A/B'))),
        h('div', { class: 'panel stack' }, composerBox, commentsBox))
        : h('div', { class: 'empty' }, 'No versions yet.'),
      !SHARE && !d.versions.length ? versionsBox : null));

    let auto = false;
    try { auto = sessionStorage.getItem('qh_autoplay') === '1'; sessionStorage.removeItem('qh_autoplay'); } catch { /* */ }
    if (st.vid) loadVersion(st.vid, { autoplay: auto });
    else { drawVersions(); drawComments(); }
  }

  // ---------- album / mastering QC view (admin, opens in its own window) ----------
  const fmtClock = (t) => {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
  };
  const fmtDb = (v, unit = 'dB') => (v == null ? '—' : v === -Infinity || v < -200 ? `-∞ ${unit}` : `${v > 0 ? '+' : ''}${v.toFixed(2)} ${unit}`);
  const fmtKhz = (r) => (r ? `${(r / 1000).toString().replace(/\.0+$/, '')}kHz` : '—');
  const extOf = (name) => (name.split('.').pop() || '').toUpperCase().replace('AIF', 'AIFF').replace('AIFFF', 'AIFF');
  const baseName = (name) => name.replace(/\.[^.]+$/, '');

  // Warning levels for the QC panel. 'bad' = red, 'warn' = amber.
  const QC_RULES = {
    truePeak: (v) => (v == null ? null : v >= 0 ? 'bad' : v > -1 ? 'warn' : null),
    samplePeak: (v) => (v == null ? null : v >= 0 ? 'bad' : v > -0.1 ? 'warn' : null),
    clipped: (v) => (v > 0 ? 'bad' : null),
    dc: (v) => (v != null && Math.abs(v) > 0.1 ? 'warn' : null),
    leading: (v) => (v != null && v > 2000 ? 'warn' : null),
    trailing: (v) => (v != null && v > 4000 ? 'warn' : null),
  };
  const QC_HELP = 'Amber: true peak above −1.0 dBTP, sample peak above −0.1 dBFS, DC offset above 0.1 %, more than 2 s leading or 4 s trailing silence. Red: true or sample peak at/over 0 dBFS, or possibly clipped samples (2+ consecutive full-scale samples).';

  async function viewAlbum(pid) {
    document.body.classList.add('album-mode');
    onCleanup(() => document.body.classList.remove('album-mode'));
    let d = await api(`/projects/${pid}/album`);
    const oldTitle = document.title;
    document.title = `${d.project.name} — Album view`;
    onCleanup(() => { document.title = oldTitle; });

    const st = { gap: Number(ls.get('qh_gap') || 0), sel: 0, zoom: 1, pos: 0, playing: false, loading: false };
    const peaks = new Map();
    let L = [];
    const relayout = () => {
      let t = 0;
      L = d.tracks.map((tr, i) => {
        const dur = tr.version.duration || 0;
        const o = { start: t, end: t + dur, dur };
        t += dur + (i < d.tracks.length - 1 ? st.gap : 0);
        return o;
      });
    };
    relayout();
    const total = () => (L.length ? L[L.length - 1].end : 0);
    const trackAt = (t) => { for (let i = 0; i < L.length; i++) if (t < L[i].end) return i; return Math.max(0, L.length - 1); };

    // ---- audio engine: decoded lossless buffers scheduled sample-accurately back to back ----
    const eng = { ctx: null, buffers: new Map(), loading: new Map(), sources: [], scheduled: new Set(), startCtx: 0, startPos: 0, gen: 0 };
    const vidOf = (i) => d.tracks[i].version.id;
    function ensureCtx() {
      if (eng.ctx) return eng.ctx;
      const sr = d.tracks[0] && d.tracks[0].version.sampleRate;
      try { eng.ctx = new AudioContext(sr ? { sampleRate: sr, latencyHint: 'playback' } : { latencyHint: 'playback' }); } catch { eng.ctx = new AudioContext(); }
      return eng.ctx;
    }
    async function fetchDecode(url) {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return ensureCtx().decodeAudioData(await r.arrayBuffer());
    }
    function loadBuffer(i) {
      const id = vidOf(i);
      if (eng.buffers.has(id)) return Promise.resolve(eng.buffers.get(id));
      if (eng.loading.has(id)) return eng.loading.get(id);
      const p = (async () => {
        let buf;
        try { buf = await fetchDecode(`/media/${id}/lossless`); } catch { buf = await fetchDecode(`/media/${id}/original`); }
        eng.buffers.set(id, buf);
        return buf;
      })().finally(() => eng.loading.delete(id));
      eng.loading.set(id, p);
      return p;
    }
    function evict(cur) {
      const keep = new Set([cur - 1, cur, cur + 1, cur + 2].filter((i) => i >= 0 && i < d.tracks.length).map(vidOf));
      for (const id of [...eng.buffers.keys()]) if (!keep.has(id)) eng.buffers.delete(id);
    }
    function stopSources() {
      for (const s of eng.sources) { try { s.src.onended = null; s.src.stop(); } catch { /* */ } }
      eng.sources = [];
      eng.scheduled.clear();
    }
    const position = () => {
      if (!st.playing || !eng.ctx) return st.pos;
      return Math.min(total(), eng.startPos + Math.max(0, eng.ctx.currentTime - eng.startCtx));
    };
    function schedule(i) {
      const buf = eng.buffers.get(vidOf(i));
      if (!buf || eng.scheduled.has(i)) return;
      const ctx = eng.ctx;
      let when = eng.startCtx + (L[i].start - eng.startPos);
      let offset = Math.max(0, eng.startPos - L[i].start);
      if (when < ctx.currentTime) { offset += ctx.currentTime - when; when = ctx.currentTime; } // buffer arrived late
      if (offset >= buf.duration) { eng.scheduled.add(i); return; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(when, offset);
      eng.sources.push({ i, src });
      eng.scheduled.add(i);
    }
    async function play(from = st.pos) {
      const ctx = ensureCtx();
      await ctx.resume();
      stopSources();
      const gen = ++eng.gen;
      if (from >= total() - 0.01) from = 0;
      const i = trackAt(from);
      st.loading = true;
      drawTransport();
      try { await loadBuffer(i); } catch (e) { st.loading = false; drawTransport(); oops(new Error('Could not load audio: ' + e.message)); return; }
      if (gen !== eng.gen) return;
      st.loading = false;
      eng.startPos = from;
      eng.startCtx = ctx.currentTime + 0.06;
      st.playing = true;
      schedule(i);
      loadBuffer(i + 1 < d.tracks.length ? i + 1 : i).catch(() => {});
      drawTransport();
      loop();
    }
    function pause() {
      if (st.playing) st.pos = position();
      st.playing = false;
      eng.gen++;
      stopSources();
      drawTransport();
      drawAll();
    }
    function stop() { pause(); st.pos = 0; drawAll(); }
    function seek(t) {
      t = Math.max(0, Math.min(total(), t));
      if (st.playing) play(t); else { st.pos = t; drawAll(); }
    }
    function toggle() { if (st.playing) pause(); else play(); }
    function jump(dir) {
      const p = position();
      const cur = trackAt(p);
      if (dir < 0 && p - L[cur].start > 2) return seek(L[cur].start);
      const n = Math.max(0, Math.min(d.tracks.length - 1, cur + dir));
      select(n);
      seek(L[n].start);
    }

    let raf = 0;
    let lastCur = -1;
    function loop() {
      cancelAnimationFrame(raf);
      const tick = () => {
        if (!st.playing) return;
        const p = position();
        const cur = trackAt(p);
        // Keep the next track decoded and scheduled ahead of time.
        const next = cur + 1;
        if (next < d.tracks.length && !eng.scheduled.has(next)) {
          if (eng.buffers.has(vidOf(next))) schedule(next);
          else loadBuffer(next).then(() => { if (st.playing) schedule(next); }).catch(() => {});
        }
        if (cur !== lastCur) { lastCur = cur; evict(cur); if (st.follow !== false) select(cur, true); }
        if (p >= total() - 0.005) { st.playing = false; st.pos = total(); stopSources(); drawTransport(); drawAll(); return; }
        drawAll();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    onCleanup(() => { cancelAnimationFrame(raf); stopSources(); if (eng.ctx) eng.ctx.close().catch(() => {}); });

    // ---- elements ----
    const scroller = h('div', { class: 'al-scroll' });
    const wave = h('canvas', { class: 'al-wave' });
    const ruler = h('canvas', { class: 'al-ruler' });
    scroller.append(wave, ruler);
    const zoomBtns = h('div', { class: 'al-zoom' },
      h('button', { class: 'btn sm', title: 'Zoom out', onclick: () => setZoom(st.zoom / 1.6) }, '−'),
      h('button', { class: 'btn sm', title: 'Zoom in', onclick: () => setZoom(st.zoom * 1.6) }, '+'),
      h('button', { class: 'btn sm ghost', title: 'Fit', onclick: () => setZoom(1) }, 'Fit'));
    const transport = h('div', { class: 'al-transport' });
    const table = h('div', { class: 'al-table' });
    const panel = h('aside', { class: 'al-panel' });

    // ---- waveform timeline ----
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    let cacheKey = '';
    let baseLayer = null;
    let playedLayer = null;
    function setZoom(z) {
      const p = position();
      st.zoom = Math.max(1, Math.min(64, z));
      cacheKey = '';
      drawAll();
      const w = wave.clientWidth;
      scroller.scrollLeft = Math.max(0, (p / (total() || 1)) * w - scroller.clientWidth / 2);
    }
    function buildLayers(w, hgt, dpr) {
      const key = [w, hgt, dpr, st.gap, st.sel, document.documentElement.getAttribute('data-theme'), d.tracks.map((t) => t.version.id + (peaks.has(t.version.id) ? 1 : 0)).join()].join('|');
      if (key === cacheKey) return;
      cacheKey = key;
      const mk = () => { const c = document.createElement('canvas'); c.width = w * dpr; c.height = hgt * dpr; const x = c.getContext('2d'); x.scale(dpr, dpr); return [c, x]; };
      const [b, bx] = mk();
      const [p, px] = mk();
      const tot = total() || 1;
      const mid = hgt / 2;
      const amp = hgt / 2 - 22;
      d.tracks.forEach((tr, i) => {
        const x0 = (L[i].start / tot) * w;
        const x1 = (L[i].end / tot) * w;
        if (i === st.sel) { bx.fillStyle = css('--sel'); bx.fillRect(x0, 0, x1 - x0, hgt); }
        const pk = peaks.get(tr.version.id);
        const cols = Math.max(1, Math.floor(x1 - x0));
        for (let c = 0; c < cols; c++) {
          let v = 0.01;
          if (pk && pk.length) {
            const a = Math.floor((c / cols) * pk.length);
            const z = Math.max(a + 1, Math.floor(((c + 1) / cols) * pk.length));
            for (let k = a; k < z && k < pk.length; k++) if (pk[k] > v) v = pk[k];
          }
          const hh = Math.max(0.5, v * amp);
          bx.fillStyle = css('--wave'); bx.fillRect(x0 + c, mid - hh, 1, hh * 2);
          px.fillStyle = css('--wave-played'); px.fillRect(x0 + c, mid - hh, 1, hh * 2);
        }
        bx.fillStyle = css('--line'); bx.fillRect(Math.round(x1), 0, 1, hgt);
      });
      baseLayer = b;
      playedLayer = p;
    }
    function label(ctx, text, x, y, alignRight) {
      ctx.font = '600 11px ' + css('--sans');
      const tw = ctx.measureText(text).width;
      const bx = alignRight ? x - tw - 10 : x;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(bx, y, tw + 10, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, bx + 5, y + 13);
    }
    function drawWave() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(scroller.clientWidth, Math.round(scroller.clientWidth * st.zoom));
      const hgt = wave.clientHeight || 260;
      wave.style.width = ruler.style.width = w + 'px';
      if (wave.width !== Math.round(w * dpr) || wave.height !== Math.round(hgt * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(hgt * dpr); }
      buildLayers(w, hgt, dpr);
      const ctx = wave.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, wave.width, wave.height);
      if (baseLayer) ctx.drawImage(baseLayer, 0, 0);
      const tot = total() || 1;
      const px = (position() / tot) * w;
      if (playedLayer && px > 0) ctx.drawImage(playedLayer, 0, 0, px * dpr, wave.height, 0, 0, px * dpr, wave.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      d.tracks.forEach((tr, i) => {
        const x0 = (L[i].start / tot) * w;
        const x1 = (L[i].end / tot) * w;
        if (x1 - x0 > 60) {
          ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, hgt); ctx.clip();
          label(ctx, `${String(i + 1).padStart(2, '0')}. ${baseName(tr.version.originalName)}`, x0 + 6, 6);
          label(ctx, fmtClock(L[i].dur), x1 - 6, hgt - 24, true);
          ctx.restore();
        }
      });
      ctx.fillStyle = css('--text');
      ctx.fillRect(Math.round(px), 0, 1.5, hgt);
      // keep the playhead in view while zoomed
      if (st.playing && st.zoom > 1 && (px < scroller.scrollLeft || px > scroller.scrollLeft + scroller.clientWidth - 40)) scroller.scrollLeft = px - 40;
    }
    function drawRuler() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(scroller.clientWidth, Math.round(scroller.clientWidth * st.zoom));
      const hgt = 26;
      if (ruler.width !== Math.round(w * dpr) || ruler.height !== hgt * dpr) { ruler.width = Math.round(w * dpr); ruler.height = hgt * dpr; }
      const ctx = ruler.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      const tot = total() || 1;
      const pxPerSec = w / tot;
      const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      const step = steps.find((s) => s * pxPerSec >= 70) || 600;
      const minor = step / 5;
      ctx.fillStyle = css('--muted');
      ctx.font = '11px ' + css('--mono');
      for (let t = 0; t <= tot; t += minor) {
        const x = Math.round(t * pxPerSec) + 0.5;
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        ctx.fillRect(x, 0, 1, major ? 9 : 4);
        if (major) {
          const m = Math.floor(t / 60);
          const s = Math.round(t % 60);
          ctx.fillText(step >= 60 ? `${m}:00` : `${m}:${String(s).padStart(2, '0')}`, x + 3, 21);
        }
      }
    }
    function drawAll() { drawWave(); drawRuler(); drawClocks(); }

    wave.addEventListener('click', (e) => {
      const r = wave.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * total();
      select(trackAt(t));
      seek(t);
    });
    const ro = new ResizeObserver(() => { cacheKey = ''; drawAll(); });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    listen(window, 'qh-theme', () => { cacheKey = ''; drawAll(); });

    // ---- transport ----
    const clockEls = {};
    function drawTransport() {
      const gapSel = h('select', {
        title: 'Silence between tracks',
        onchange: (e) => {
          const p = position();
          const i = trackAt(p);
          const within = p - L[i].start;
          st.gap = Number(e.target.value);
          ls.set('qh_gap', String(st.gap));
          relayout();
          cacheKey = '';
          seek(Math.min(L[i].end, L[i].start + Math.max(0, within)));
        },
      }, [0, 0.5, 1, 1.5, 2, 3, 4].map((g) => h('option', { value: g, selected: g === st.gap }, g ? `${g}s gap` : 'No gap')));
      clockEls.num = h('div', { class: 'al-num' }, '00');
      clockEls.tEl = h('span'); clockEls.tRem = h('span');
      clockEls.pEl = h('span'); clockEls.pRem = h('span');
      fill(transport,
        h('div', { class: 'al-clocks' },
          clockEls.num,
          h('div', { class: 'al-clockgrp' }, h('div', { class: 'al-lbl' }, 'TRACK'),
            h('div', { class: 'al-rows' }, h('div', null, h('i', null, 'REMAINING'), clockEls.tRem), h('div', null, h('i', null, 'ELAPSED'), clockEls.tEl))),
          h('div', { class: 'al-clockgrp' }, h('div', { class: 'al-lbl' }, 'PROGRAM'),
            h('div', { class: 'al-rows' }, h('div', null, h('i', null, 'REMAINING'), clockEls.pRem), h('div', null, h('i', null, 'ELAPSED'), clockEls.pEl)))),
        h('div', { class: 'al-buttons' },
          h('button', { class: 'al-btn', title: 'Previous track', onclick: () => jump(-1) }, svg('M6 5h2v14H6zM20 5v14L9 12z')),
          h('button', { class: 'al-btn primary', title: st.playing ? 'Pause (space)' : 'Play (space)', onclick: toggle }, st.loading ? h('span', { class: 'al-spin' }) : svg(st.playing ? ICON_PAUSE : ICON_PLAY)),
          h('button', { class: 'al-btn', title: 'Stop', onclick: stop }, svg('M6 6h12v12H6z')),
          h('button', { class: 'al-btn', title: 'Next track', onclick: () => jump(1) }, svg('M16 5h2v14h-2zM4 5v14l11-7z'))),
        h('div', { class: 'al-tools' }, gapSel, zoomBtns));
      drawClocks();
    }
    function drawClocks() {
      if (!clockEls.num) return;
      const p = position();
      const i = trackAt(p);
      const inTrack = L[i] ? Math.max(0, Math.min(L[i].dur, p - L[i].start)) : 0;
      clockEls.num.textContent = d.tracks.length ? String(i + 1).padStart(2, '0') : '00';
      clockEls.tEl.textContent = fmtClock(inTrack);
      clockEls.tRem.textContent = fmtClock(L[i] ? L[i].dur - inTrack : 0);
      clockEls.pEl.textContent = fmtClock(p);
      clockEls.pRem.textContent = fmtClock(total() - p);
      table.querySelectorAll('.al-row:not(.al-head)').forEach((r, k) => r.classList.toggle('playing', st.playing && k === i));
    }

    // ---- track table ----
    function drawTable() {
      fill(table,
        h('div', { class: 'al-row al-head' },
          ['#', 'File Name', 'Sample Rate', 'Bit Depth', 'File Type', 'LUFS-I', 'TP max', 'Start', 'End', 'Length'].map((c) => h('div', null, c))),
        d.tracks.map((tr, i) => {
          const v = tr.version;
          const a = v.analysis;
          const tp = a && a.truePeak && a.truePeak.length ? Math.max(...a.truePeak.filter((x) => x != null)) : v.truePeak;
          const lvl = QC_RULES.truePeak(tp) || (a && a.clippedSamples && a.clippedSamples.some((x) => x > 0) ? 'bad' : null);
          return h('div', {
            class: 'al-row' + (i === st.sel ? ' sel' : ''),
            onclick: () => select(i),
            ondblclick: () => { select(i); play(L[i].start); },
            title: 'Double-click to play from here',
          },
          h('div', { class: 'mono' }, String(i + 1).padStart(2, '0')),
          h('div', { class: 'al-name' }, baseName(v.originalName), h('span', { class: 'vtag' }, `v${v.number}`)),
          h('div', { class: 'mono' }, fmtKhz(v.sampleRate)),
          h('div', { class: 'mono' }, v.bitDepth ? `${v.bitDepth}-bit` : (v.codec || '—')),
          h('div', { class: 'mono' }, extOf(v.originalName)),
          h('div', { class: 'mono' }, a && a.integrated != null ? a.integrated.toFixed(1) : v.lufs != null ? v.lufs.toFixed(1) : '—'),
          h('div', { class: 'mono' }, tp == null ? '—' : tp.toFixed(1), lvl ? h('span', { class: 'al-dot ' + lvl }) : null),
          h('div', { class: 'mono' }, fmtClock(L[i].start)),
          h('div', { class: 'mono' }, fmtClock(L[i].end)),
          h('div', { class: 'mono' }, fmtClock(L[i].dur)));
        }),
        d.skipped ? h('div', { class: 'al-note' }, `${d.skipped} track${d.skipped === 1 ? '' : 's'} still processing and not in the sequence yet.`) : null,
        h('div', { class: 'al-note' }, `${d.tracks.length} track${d.tracks.length === 1 ? '' : 's'} · program ${fmtClock(total())} · latest version of each track · double-click a row to play from it`));
      drawClocks();
    }

    // ---- QC panel ----
    function select(i, fromPlayback) {
      if (i === st.sel && fromPlayback) return;
      st.sel = Math.max(0, Math.min(d.tracks.length - 1, i));
      cacheKey = '';
      drawTable();
      drawPanel();
      drawVinyl();
      if (!fromPlayback) drawAll();
    }
    function bitsMeter(eff, rep) {
      const n = rep || 24;
      return h('div', { class: 'al-bits' }, Array.from({ length: n }, (_, k) => h('i', { class: k < eff ? 'on' : '' })));
    }
    function statRow(labelText, vals, rule, fmt) {
      const cells = vals.map((v) => {
        const lvl = rule ? rule(v) : null;
        return h('div', { class: 'al-cell' }, h('span', { class: 'al-val' + (lvl ? ' ' + lvl : '') }, fmt(v)), h('span', { class: 'al-dot ' + (lvl || 'none') }));
      });
      return h('div', { class: 'al-stat' }, h('div', { class: 'al-statlbl' }, labelText), ...cells);
    }
    function wideRow(labelText, v, rule, fmt) {
      const lvl = rule ? rule(v) : null;
      return h('div', { class: 'al-stat wide' }, h('div', { class: 'al-statlbl' }, labelText),
        h('div', { class: 'al-cell' }, h('span', { class: 'al-val' + (lvl ? ' ' + lvl : '') }, fmt(v)), h('span', { class: 'al-dot ' + (lvl || 'none') })));
    }
    function drawPanel() {
      const tr = d.tracks[st.sel];
      if (!tr) { fill(panel, h('div', { class: 'sub' }, 'No processed tracks in this project yet.')); return; }
      const v = tr.version;
      const a = v.analysis;
      const chs = v.channels || 2;
      const chLabels = chs === 1 ? ['M'] : chs === 2 ? ['L', 'R'] : Array.from({ length: chs }, (_, k) => `${k + 1}`);
      const type = `${chs === 1 ? 'Mono' : chs === 2 ? 'Stereo' : chs + 'ch'} ${extOf(v.originalName)}`;
      const head = h('div', { class: 'al-card' },
        h('div', { class: 'al-title' }, baseName(v.originalName)),
        h('div', { class: 'al-facts' },
          h('div', null, h('i', null, 'Sample Rate'), h('b', null, fmtKhz(v.sampleRate))),
          h('div', null, h('i', null, 'Reported Bit Depth'), h('b', null, v.bitDepth ? `${v.bitDepth}-bit ${/pcm/.test(v.codec || '') ? 'PCM' : (v.codec || '').toUpperCase()}` : (v.codec || '—').toUpperCase())),
          h('div', null, h('i', null, 'Type'), h('b', null, type))),
        a && !a.error ? (() => {
          const eff = a.effectiveBits || [];
          const rep = v.bitDepth || Math.max(...eff.filter(Boolean), 16);
          const minEff = Math.min(...eff.filter((x) => x != null));
          const full = Number.isFinite(minEff) && minEff >= rep;
          return [
            h('div', { class: 'al-res ' + (full ? 'ok' : 'warn') }, full ? `Full ${rep}-bit resolution` : `Effective ${minEff}-bit resolution in a ${rep}-bit file`),
            h('div', { class: 'al-meters' }, chLabels.map((c, k) => h('div', { class: 'al-meter' }, h('span', null, c), bitsMeter(eff[k] || 0, rep), h('span', { class: 'mono' }, `${eff[k] ?? '—'}/${rep}`)))),
            h('div', { class: 'al-note' }, 'Effective resolution: lowest bit carrying signal (MSB → LSB)'),
          ];
        })() : null);

      let body;
      if (!a) body = h('div', { class: 'al-wait' }, h('span', { class: 'al-spin' }), 'Analyzing… (a few seconds per track)');
      else if (a.error) body = h('div', { class: 'al-wait' }, 'Analysis failed: ' + a.error, h('button', { class: 'btn sm', onclick: async () => { await api(`/versions/${v.id}/analyze`, { method: 'POST' }); v.analysis = null; drawPanel(); poll(); } }, 'Retry'));
      else {
        const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}%`);
        body = h('div', { class: 'al-stats' },
          h('div', { class: 'al-stat al-chhead' }, h('div'), chLabels.map((c) => h('div', { class: 'al-cell' }, c))),
          statRow('True peak level', a.truePeak, QC_RULES.truePeak, (x) => fmtDb(x, 'dBTP')),
          statRow('Sample peak level', a.samplePeak, QC_RULES.samplePeak, (x) => fmtDb(x)),
          statRow('Max RMS level', a.rmsMax, null, (x) => fmtDb(x)),
          statRow('Min RMS level', a.rmsMin, null, (x) => fmtDb(x)),
          statRow('Total RMS level', a.rms, null, (x) => fmtDb(x)),
          statRow('Possibly clipped samples', a.clippedSamples, QC_RULES.clipped, (x) => (x == null ? '—' : x.toLocaleString())),
          statRow('DC offset', a.dcOffsetPct, QC_RULES.dc, pct),
          h('div', { class: 'al-gap' }),
          wideRow('Max momentary loudness (LUFS-M)', a.maxMomentary, null, (x) => (x == null ? '—' : `${x.toFixed(1)} LUFS`)),
          wideRow('Max short-term loudness (LUFS-S)', a.maxShortTerm, null, (x) => (x == null ? '—' : `${x.toFixed(1)} LUFS`)),
          wideRow('Integrated loudness (LUFS-I, BS.1770)', a.integrated, null, (x) => (x == null ? '—' : `${x.toFixed(1)} LUFS`)),
          wideRow('Loudness range (LRA)', a.lra, null, (x) => (x == null ? '—' : `${x.toFixed(1)} LU`)),
          wideRow('Leading silence', a.leadingSilenceMs, QC_RULES.leading, (x) => (x == null ? '—' : `${x.toLocaleString()} ms`)),
          wideRow('Trailing silence', a.trailingSilenceMs, QC_RULES.trailing, (x) => (x == null ? '—' : `${x.toLocaleString()} ms`)),
          h('div', { class: 'al-gap' }),
          wideRow('Total duration', v.duration, null, fmtClock),
          h('div', { class: 'al-note', title: QC_HELP }, 'ⓘ Warning thresholds — hover for details. Silence = below −60 dBFS.'));
      }
      fill(panel, head, body);
    }

    // ---- data refresh while analysis runs ----
    let pollTimer = null;
    async function poll() {
      clearTimeout(pollTimer);
      if (!d.tracks.some((t) => !t.version.analysis)) return;
      pollTimer = setTimeout(async () => {
        try {
          const n = await api(`/projects/${pid}/album`);
          const byId = new Map(n.tracks.map((t) => [t.version.id, t]));
          let changed = false;
          for (const t of d.tracks) {
            const m = byId.get(t.version.id);
            if (m && m.version.analysis && !t.version.analysis) { t.version.analysis = m.version.analysis; changed = true; }
          }
          if (changed) { drawTable(); drawPanel(); drawVinyl(); }
        } catch { /* keep trying */ }
        poll();
      }, 2500);
    }
    onCleanup(() => clearTimeout(pollTimer));

    // waveform peaks for every track
    for (const tr of d.tracks) {
      fetch(mediaUrl(tr.version.id, 'peaks'), { credentials: 'same-origin' }).then((r) => r.json()).then((p) => {
        peaks.set(tr.version.id, p.peaks);
        cacheKey = '';
        drawAll();
      }).catch(() => {});
    }

    // ---- vinyl side planner ----
    // [ideal, maximum] seconds per side. Typical cutting/pressing guidance; editable per project.
    const VINYL = { '12-33': [18 * 60, 22 * 60], '12-45': [12 * 60, 15 * 60], '10-33': [12 * 60, 14 * 60], '10-45': [9 * 60, 10 * 60], '7-45': [210, 300], '7-33': [300, 420] };
    const FORMATS = [['12-33', '12″ LP · 33⅓'], ['12-45', '12″ · 45'], ['10-33', '10″ · 33⅓'], ['10-45', '10″ · 45'], ['7-45', '7″ · 45'], ['7-33', '7″ · 33⅓']];
    const FORMAT_NAME = Object.fromEntries(FORMATS);
    const SIDES = 'ABCDEF';
    const byTrack = new Map(d.tracks.map((t, i) => [t.trackId, i]));
    const mmss = (t) => { t = Math.round(t || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const parseMmss = (s) => {
      s = String(s || '').trim();
      if (!s) return null;
      const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
      return m ? Number(m[1]) * 60 + Number(m[2] || 0) : undefined;
    };
    function normalize(p) {
      p = p ? JSON.parse(JSON.stringify(p)) : { format: '12', rpm: 33, sideCount: 2, gap: 2, ideal: null, max: null, sides: {} };
      p.sides = p.sides || {};
      const names = SIDES.slice(0, p.sideCount).split('');
      for (const n of Object.keys(p.sides)) if (!names.includes(n)) delete p.sides[n];
      const seen = new Set();
      for (const n of names) p.sides[n] = (p.sides[n] || []).filter((id) => byTrack.has(id) && !seen.has(id) && seen.add(id));
      return p;
    }
    let plan = normalize(d.vinyl);
    const sideNames = () => SIDES.slice(0, plan.sideCount).split('');
    const limits = () => {
      const def = VINYL[`${plan.format}-${plan.rpm}`] || VINYL['12-33'];
      return { ideal: plan.ideal || def[0], max: plan.max || def[1], def };
    };
    const durOf = (id) => d.tracks[byTrack.get(id)].version.duration || 0;
    const lufsOf = (id) => { const v = d.tracks[byTrack.get(id)].version; return v.analysis && v.analysis.integrated != null ? v.analysis.integrated : v.lufs; };
    const nameOf = (id) => d.tracks[byTrack.get(id)].name;
    const sideTime = (ids) => ids.reduce((s, id) => s + durOf(id), 0) + Math.max(0, ids.length - 1) * plan.gap;
    const statusOf = (t) => { const { ideal, max } = limits(); return t <= ideal ? 'ok' : t <= max ? 'warn' : 'bad'; };

    let saveTimer = null;
    function save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api(`/projects/${pid}/vinyl`, { method: 'PUT', body: plan }).catch(oops), 350);
    }
    function commit() { save(); drawVinyl(); }

    // Split the album order into N contiguous sides with the shortest possible longest side.
    function autoSplit() {
      const ids = d.tracks.map((t) => t.trackId);
      const n = ids.length;
      const k = plan.sideCount;
      const INF = Infinity;
      const best = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(INF));
      const cut = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
      best[0][0] = 0;
      for (let m = 1; m <= k; m++) {
        for (let j = 0; j <= n; j++) {
          for (let i = 0; i <= j; i++) {
            if (best[m - 1][i] === INF) continue;
            const v = Math.max(best[m - 1][i], sideTime(ids.slice(i, j)));
            if (v < best[m][j]) { best[m][j] = v; cut[m][j] = i; }
          }
        }
      }
      const parts = [];
      let j = n;
      for (let m = k; m >= 1; m--) { const i = cut[m][j]; parts.unshift(ids.slice(i, j)); j = i; }
      sideNames().forEach((nm, x) => { plan.sides[nm] = parts[x] || []; });
      commit();
      toast('Split in album order');
    }

    function moveTrack(id, toSide, beforeId) {
      for (const n of sideNames()) plan.sides[n] = plan.sides[n].filter((x) => x !== id);
      if (toSide) {
        const list = plan.sides[toSide];
        const at = beforeId ? list.indexOf(beforeId) : -1;
        if (at >= 0) list.splice(at, 0, id); else list.push(id);
      }
      commit();
    }

    function sideText() {
      const { ideal, max } = limits();
      const out = [`${d.project.name}${d.project.artist ? ' — ' + d.project.artist : ''}`, `${FORMAT_NAME[`${plan.format}-${plan.rpm}`]} RPM · ${plan.gap}s between songs · ideal ≤ ${mmss(ideal)}, max ${mmss(max)} per side`, ''];
      for (const n of sideNames()) {
        const ids = plan.sides[n];
        out.push(`SIDE ${n} — ${mmss(sideTime(ids))}`);
        ids.forEach((id, k) => out.push(`  ${n}${k + 1}. ${nameOf(id)}  ${mmss(durOf(id))}`));
        out.push('');
      }
      return out.join('\n');
    }

    function sideCard(nm, ids) {
      const { ideal, max } = limits();
      const t = sideTime(ids);
      const s = nm ? statusOf(t) : null;
      const scale = Math.max(max * 1.15, t * 1.02, 1);
      const pct = (x) => `${Math.min(100, (x / scale) * 100)}%`;
      const bar = nm ? h('div', { class: 'vy-bar' },
        h('div', { class: 'vy-zone ok', style: `width:${pct(ideal)}` }),
        h('div', { class: 'vy-zone warn', style: `left:${pct(ideal)};width:calc(${pct(max)} - ${pct(ideal)})` }),
        h('div', { class: 'vy-zone bad', style: `left:${pct(max)};right:0` }),
        h('div', { class: 'vy-fill ' + s, style: `width:${pct(t)}` })) : null;

      let msg = null;
      if (nm && ids.length) {
        const fmt = FORMAT_NAME[`${plan.format}-${plan.rpm}`];
        msg = s === 'ok' ? `Within the ${mmss(ideal)} ideal for ${fmt}.`
          : s === 'warn' ? `${mmss(t - ideal)} past the ${mmss(ideal)} ideal. Cuttable, but expect a lower cut level and less low end.`
            : `${mmss(t - max)} over the ${mmss(max)} maximum for ${fmt}. Move a song, add sides, or change format.`;
      }
      const tips = [];
      if (nm && ids.length >= 2) {
        const louds = ids.map(lufsOf).filter((x) => x != null);
        const lastL = lufsOf(ids[ids.length - 1]);
        if (lastL != null && louds.length >= 2 && lastL >= Math.max(...louds) - 0.05 && t > ideal * 0.7) {
          tips.push(`“${nameOf(ids[ids.length - 1])}” is the loudest song on this side and sits on the inner grooves, where distortion is worst. Consider moving it earlier.`);
        }
        if (s !== 'ok' && louds.length && Math.max(...louds) > -10) {
          tips.push(`Loud masters (up to ${Math.max(...louds).toFixed(1)} LUFS) on a long side: the cut will likely need to come down in level.`);
        }
      }

      const list = h('div', {
        class: 'vy-list',
        ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
        ondragleave: (e) => e.currentTarget.classList.remove('over'),
        ondrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('over');
          const id = e.dataTransfer.getData('text/qh-track');
          if (!id) return;
          const item = e.target.closest('.vy-item');
          moveTrack(id, nm, item && item.dataset.id !== id ? item.dataset.id : null);
        },
      },
      ids.length ? ids.map((id, k) => {
        const i = byTrack.get(id);
        const move = h('select', {
          class: 'vy-move',
          title: 'Move to side',
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => moveTrack(id, e.target.value || null),
        }, h('option', { value: nm || '' }, nm ? `Side ${nm}` : 'Move to…'), sideNames().filter((x) => x !== nm).map((x) => h('option', { value: x }, `Side ${x}`)), nm ? h('option', { value: '' }, 'Remove from side') : null);
        return h('div', {
          class: 'vy-item' + (i === st.sel ? ' sel' : ''),
          draggable: 'true',
          'data-id': id,
          title: 'Drag to reorder or move between sides · double-click to play',
          ondragstart: (e) => { e.dataTransfer.setData('text/qh-track', id); e.dataTransfer.effectAllowed = 'move'; },
          onclick: () => select(i),
          ondblclick: () => { select(i); play(L[i].start); },
        },
        h('span', { class: 'vy-pos mono' }, nm ? `${nm}${k + 1}` : `${String(i + 1).padStart(2, '0')}`),
        h('span', { class: 'vy-name' }, nameOf(id)),
        h('span', { class: 'mono sub' }, mmss(durOf(id))),
        move);
      }) : h('div', { class: 'vy-empty' }, nm ? 'Drag songs here' : 'All songs are on a side'));

      return h('div', { class: 'vy-side' + (nm ? ' ' + s : ' loose') },
        h('div', { class: 'vy-head' },
          h('div', { class: 'vy-label' }, nm ? `Side ${nm}` : 'Not on a side'),
          h('div', { class: 'vy-time mono' }, mmss(t)),
          nm ? h('span', { class: 'vy-pill ' + s }, s === 'ok' ? 'Fits' : s === 'warn' ? 'Tight' : 'Too long') : null),
        bar,
        msg ? h('div', { class: 'vy-msg ' + s }, msg) : null,
        list,
        tips.map((x) => h('div', { class: 'vy-tip' }, x)));
    }

    const vinylBox = h('div', { class: 'vy hidden' });
    function drawVinyl() {
      if (vinylBox.classList.contains('hidden')) return;
      const { ideal, max, def } = limits();
      const assigned = new Set(sideNames().flatMap((n) => plan.sides[n]));
      const loose = d.tracks.map((t) => t.trackId).filter((id) => !assigned.has(id));
      const sel = (opts, value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
      const limitInput = (key, fallback) => h('input', {
        type: 'text', class: 'vy-lim', value: plan[key] ? mmss(plan[key]) : '', placeholder: mmss(fallback), title: 'mm:ss — leave empty for the default',
        onchange: (e) => {
          const v = parseMmss(e.target.value);
          if (v === undefined) { toast('Use mm:ss, e.g. 19:30', true); e.target.value = plan[key] ? mmss(plan[key]) : ''; return; }
          plan[key] = v;
          commit();
        },
      });
      const times = sideNames().map((n) => sideTime(plan.sides[n]));
      const used = times.filter((x, k) => plan.sides[sideNames()[k]].length);
      fill(vinylBox,
        h('div', { class: 'vy-controls' },
          h('label', { class: 'field' }, 'Format', sel(FORMATS, `${plan.format}-${plan.rpm}`, (v) => { const [f, r] = v.split('-'); plan.format = f; plan.rpm = Number(r) === 45 ? 45 : 33; plan.ideal = null; plan.max = null; commit(); })),
          h('label', { class: 'field' }, 'Sides', sel([[2, 'A–B · 1 disc'], [4, 'A–D · 2 discs'], [6, 'A–F · 3 discs']], plan.sideCount, (v) => { plan.sideCount = Number(v); plan = normalize(plan); commit(); })),
          h('label', { class: 'field' }, 'Gap between songs', sel([0, 1, 1.5, 2, 2.5, 3, 4, 5].map((g) => [g, `${g}s`]), plan.gap, (v) => { plan.gap = Number(v); commit(); })),
          h('label', { class: 'field' }, 'Ideal per side', limitInput('ideal', def[0])),
          h('label', { class: 'field' }, 'Max per side', limitInput('max', def[1])),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn sm primary', onclick: autoSplit, title: 'Keep the album order and balance the sides' }, 'Auto-split'),
          h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(sideText()); toast('Side list copied'); } catch { oops(new Error('Copy failed')); } } }, 'Copy side list'),
          h('button', { class: 'btn sm ghost', onclick: () => { if (!confirm('Take every song off its side?')) return; sideNames().forEach((n) => { plan.sides[n] = []; }); commit(); } }, 'Clear')),
        h('div', { class: 'vy-sides' }, sideNames().map((n) => sideCard(n, plan.sides[n])), loose.length ? sideCard(null, loose) : null),
        h('div', { class: 'al-note' },
          `Program ${mmss(total())} · `,
          used.length > 1 ? `longest side ${mmss(Math.max(...used))}, shortest ${mmss(Math.min(...used))} · ` : '',
          `Limits: ideal ≤ ${mmss(ideal)}, max ${mmss(max)} for ${FORMAT_NAME[`${plan.format}-${plan.rpm}`]}. Plants and cutting engineers vary; edit the limits to match yours. Side times include the gaps between songs.`));
    }

    // tabs: track table vs vinyl planner
    st.view = ls.get('qh_alview') === 'vinyl' ? 'vinyl' : 'tracks';
    const tabs = h('div', { class: 'al-tabs' });
    function drawTabs() {
      fill(tabs, [['tracks', 'Tracks'], ['vinyl', 'Vinyl sides']].map(([k, l]) => h('button', {
        class: 'al-tab' + (st.view === k ? ' on' : ''),
        onclick: () => { st.view = k; ls.set('qh_alview', k); drawTabs(); },
      }, l)));
      table.classList.toggle('hidden', st.view !== 'tracks');
      vinylBox.classList.toggle('hidden', st.view !== 'vinyl');
      drawVinyl();
    }

    // ---- keyboard ----
    listen(document, 'keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(position() - (e.shiftKey ? 1 : 5)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(position() + (e.shiftKey ? 1 : 5)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(st.sel - 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); select(st.sel + 1); }
      else if (e.key === 'Enter') { e.preventDefault(); play(L[st.sel].start); }
      else if (e.key === 'Home' || e.key === '0') { e.preventDefault(); seek(0); }
      else if (e.key === '[') jump(-1);
      else if (e.key === ']') jump(1);
      else if (e.key === '=' || e.key === '+') setZoom(st.zoom * 1.6);
      else if (e.key === '-') setZoom(st.zoom / 1.6);
    });

    // ---- mount (no site header: this is a tool window) ----
    fill(root, h('div', { class: 'album' },
      h('div', { class: 'al-main' },
        h('div', { class: 'al-top' },
          h('div', { class: 'al-titlebar' },
            d.project.art ? cover(d.project, '34px') : null,
            h('b', null, d.project.name), d.project.artist ? h('span', { class: 'sub' }, d.project.artist) : null,
            h('span', { class: 'grow' }),
            themeSwitch()),
          scroller),
        transport,
        tabs,
        table,
        vinylBox),
      panel));
    drawTransport();
    drawTable();
    drawTabs();
    drawPanel();
    drawAll();
    poll();
    if (!d.tracks.length) fill(table, h('div', { class: 'empty' }, 'No processed tracks yet. Upload masters to this project first.'));
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', route);
  (async () => {
    if (!SHARE && BOOT.mode === 'admin') {
      try {
        const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
        state.admin = !!me.admin;
      } catch { state.admin = false; }
    }
    route();
  })();
})();
