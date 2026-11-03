/**
 * HackerX content script.
 *
 * Injects a dock on x.com / twitter.com listing what Hacker News is talking
 * about right now. Every row deep-links into X's own live search for that
 * topic, which X renders newest-first (`f=live`) — so the feed the user lands
 * on is native x.com, ordered like it.
 *
 * The same file also runs against dev/harness.html, where `chrome.*` is absent
 * and Hacker News is fetched directly (Algolia sends CORS `*`). That keeps the
 * dock testable without a logged-in session.
 */
(function () {
  'use strict';

  if (window.top !== window.self) return; // never inside x.com's many iframes
  if (window.__hackerxLoaded) return;
  window.__hackerxLoaded = true;

  const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || location.href;
  const EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  const onX = /(^|\.)(x|twitter)\.com$/.test(location.hostname);
  const HARNESS = !EXT && !onX;
  const resUrl = (path) => {
    if (EXT) return chrome.runtime.getURL(path);
    // Harness mode: resolve workspace-root-relative paths against this file's URL.
    return new URL(path, new URL('../../', SCRIPT_SRC)).href;
  };

  const KEYS = { settings: 'hackerx:settings', collapsed: 'hackerx:collapsed', position: 'hackerx:position' };
  const DEFAULT_SETTINGS = {
    minPoints: 150,
    maxTopics: 12,
    sort: 'new',
    side: 'right',
    highlight: true,
  };
  const REFRESH_MS = 5 * 60 * 1000;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    topics: [],
    updatedAt: 0,
    loading: true,
    error: '',
    filter: '',
    collapsed: false,
    position: null,
    badgeHosts: new Map(),
    seenTweets: new WeakSet(),
    keywords: [],
  };

  // ---------------------------------------------------------------- storage
  const store = {
    async get(key) {
      if (EXT && chrome.storage) {
        const out = await chrome.storage.local.get(key);
        return out[key];
      }
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
      } catch (_) {
        return undefined;
      }
    },
    async set(key, value) {
      if (EXT && chrome.storage) {
        await chrome.storage.local.set({ [key]: value });
        return;
      }
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {
        /* ignore quota errors */
      }
    },
  };

  // ------------------------------------------------------------------ utils
  const el = (tag, attrs = {}, text) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const ago = (ms) => {
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  const compact = (n) =>
    n >= 1000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k` : String(n);

  /** Stroke icon on a 24x24 grid, coloured by the button's currentColor. */
  function icon(paths, size = 18) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  const ICON_REFRESH = ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'];
  const ICON_CLOSE = ['M6 6l12 12', 'M18 6 6 18'];
  const ICON_CHEVRON = ['M9 6l6 6-6 6'];
  const ICON_TREND = ['M3 17l6-6 4 4 8-8', 'M21 7h-5V2'];

  function detectTheme() {
    const probe = document.body || document.documentElement;
    const bg = probe ? getComputedStyle(probe).backgroundColor : '';
    const parts = (bg || '').match(/[\d.]+/g);
    if (!parts || parts.length < 3) return 'dark';
    const [r, g, b] = parts.map(Number);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? 'light' : 'dark';
  }

  /** Keep the user on whatever X host they are already using. */
  function localize(url) {
    if (!onX) return url;
    try {
      const u = new URL(url);
      u.protocol = location.protocol;
      u.host = location.host;
      return u.href;
    } catch (_) {
      return url;
    }
  }

  // ------------------------------------------------------------------- data
  let libPromise = null;
  async function loadLibs() {
    if (!libPromise) {
      libPromise = Promise.all([
        import(resUrl('src/lib/hn.js')),
        import(resUrl('src/lib/topics.js')),
      ]).then(([hn, topics]) => ({ ...hn, ...topics }));
    }
    return libPromise;
  }

  async function fetchTopics({ force = false } = {}) {
    state.loading = true;
    state.error = '';
    render();

    try {
      let payload;
      if (EXT) {
        payload = await chrome.runtime.sendMessage({
          type: 'hackerx:topics',
          force,
          settings: state.settings,
        });
      } else {
        const lib = await loadLibs();
        const stories = await lib.fetchStories({
          hitsPerPage: 80,
          minPoints: state.settings.minPoints,
        });
        payload = {
          ok: true,
          at: Date.now(),
          topics: lib.buildTopics(stories, {
            maxTopics: state.settings.maxTopics,
            sort: state.settings.sort,
          }),
        };
      }

      if (!payload || !payload.ok) throw new Error((payload && payload.error) || 'No response');

      state.topics = payload.topics || [];
      state.updatedAt = payload.at || Date.now();
      state.error = '';
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
      state.topics = [];
    } finally {
      state.loading = false;
      buildKeywordIndex();
      render();
      if (state.settings.highlight) scheduleBadgePass();
    }
  }

  // --------------------------------------------------------------- dock DOM
  let host = null;
  let root = null;
  let nodes = null;

  function mount() {
    if (host && host.isConnected) return;

    host = el('div', { id: 'hackerx-host', 'data-theme': detectTheme() });
    root = host.attachShadow({ mode: 'open' });

    const link = el('link', { rel: 'stylesheet', href: resUrl('src/content/dock.css') });
    root.appendChild(link);

    const dock = el('section', { class: 'dock', role: 'complementary', 'aria-label': 'Hacker News topics' });
    dock.dataset.side = state.settings.side;

    const head = el('header', { class: 'head' });
    const brand = el('div', { class: 'brand' });
    brand.append(
      el('div', { class: 'logo' }, 'Y'),
      (() => {
        const wrap = el('div', { class: 'brand-text' });
        wrap.append(
          el('div', { class: 'brand-name' }, 'HackerX'),
          el('div', { class: 'brand-sub' }, 'What Hacker News is on about'),
        );
        return wrap;
      })(),
    );

    const refreshBtn = el('button', { class: 'icon-btn', type: 'button', title: 'Refresh', 'aria-label': 'Refresh topics' });
    refreshBtn.appendChild(icon(ICON_REFRESH));
    refreshBtn.addEventListener('click', () => fetchTopics({ force: true }));

    const collapseBtn = el('button', { class: 'icon-btn', type: 'button', title: 'Hide', 'aria-label': 'Hide HackerX' });
    collapseBtn.appendChild(icon(ICON_CLOSE));
    collapseBtn.addEventListener('click', () => setCollapsed(true));

    head.append(brand, refreshBtn, collapseBtn);

    const toolbar = el('div', { class: 'toolbar' });
    const filter = el('input', {
      class: 'filter',
      type: 'search',
      placeholder: 'Filter topics…',
      'aria-label': 'Filter topics',
    });
    filter.addEventListener('input', () => {
      state.filter = filter.value.trim().toLowerCase();
      renderList();
    });

    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Sort topics' });
    const sortNew = el('button', { type: 'button', 'data-sort': 'new', title: 'Newest first' }, 'New');
    const sortTop = el('button', { type: 'button', 'data-sort': 'top', title: 'Most points' }, 'Top');
    seg.append(sortNew, sortTop);
    seg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-sort]');
      if (!btn) return;
      const sort = btn.dataset.sort;
      if (sort === state.settings.sort) return;
      state.settings.sort = sort;
      store.set(KEYS.settings, state.settings);
      fetchTopics();
    });

    toolbar.append(filter, seg);

    const list = el('div', { class: 'list', role: 'list' });
    const foot = el('footer', { class: 'foot' });

    dock.append(head, toolbar, list, foot);
    root.appendChild(dock);

    const pill = el('button', { class: 'pill', type: 'button', title: 'Show HackerX' });
    pill.dataset.side = state.settings.side;
    pill.append(el('span', { class: 'logo' }, 'Y'), icon(ICON_TREND, 14), el('span', {}, 'HackerX'));
    pill.addEventListener('click', () => setCollapsed(false));
    root.appendChild(pill);

    nodes = { dock, list, foot, pill, refreshBtn, filter, sortNew, sortTop };

    makeDraggable(dock);
    (document.body || document.documentElement).appendChild(host);
    applyCollapsed();
    render();
  }

  function setCollapsed(value) {
    state.collapsed = !!value;
    store.set(KEYS.collapsed, state.collapsed);
    applyCollapsed();
  }

  /** Remember where the user parked the dock so it never covers the trends column. */
  function applyPosition(node) {
    if (!state.position) return;
    const left = Math.min(Math.max(8, state.position.left), Math.max(8, window.innerWidth - 120));
    const top = Math.min(Math.max(8, state.position.top), Math.max(8, window.innerHeight - 60));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.right = 'auto';
  }

  function makeDraggable(dock) {
    const head = dock.querySelector('.head');
    let drag = null;

    const onMove = (event) => {
      if (!drag) return;
      const left = Math.min(Math.max(8, event.clientX - drag.dx), window.innerWidth - drag.w - 8);
      const top = Math.min(Math.max(8, event.clientY - drag.dy), window.innerHeight - 60);
      dock.style.left = `${left}px`;
      dock.style.top = `${top}px`;
      dock.style.right = 'auto';
    };

    const onUp = () => {
      if (!drag) return;
      drag = null;
      head.style.cursor = '';
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      const rect = dock.getBoundingClientRect();
      state.position = { left: Math.round(rect.left), top: Math.round(rect.top) };
      store.set(KEYS.position, state.position);
    };

    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = dock.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width };
      head.style.cursor = 'grabbing';
      // Window-level listeners: x.com owns the pointer, so capture is unreliable.
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      event.preventDefault();
    });

    // Double-click the header to snap back to the default corner.
    head.addEventListener('dblclick', () => {
      state.position = null;
      store.set(KEYS.position, null);
      dock.style.left = '';
      dock.style.top = '';
      dock.style.right = '';
    });
  }

  function applyCollapsed() {
    if (!nodes) return;
    nodes.dock.style.display = state.collapsed ? 'none' : 'flex';
    nodes.pill.style.display = state.collapsed ? 'flex' : 'none';
  }

  function visibleTopics() {
    if (!state.filter) return state.topics;
    return state.topics.filter(
      (t) =>
        t.title.toLowerCase().includes(state.filter) ||
        t.query.toLowerCase().includes(state.filter),
    );
  }

  function renderList() {
    if (!nodes) return;
    const { list } = nodes;
    list.textContent = '';

    if (state.loading && !state.topics.length) {
      for (let i = 0; i < 6; i += 1) list.appendChild(el('div', { class: 'skeleton' }));
      return;
    }

    if (state.error) {
      list.appendChild(el('div', { class: 'state error' }, `Hacker News unreachable — ${state.error}`));
      return;
    }

    const topics = visibleTopics();
    if (!topics.length) {
      list.appendChild(
        el('div', { class: 'state' }, state.filter ? 'No topics match that filter.' : 'Nothing above the points threshold right now.'),
      );
      return;
    }

    topics.forEach((topic, index) => {
      const row = el('a', {
        class: 'row',
        role: 'listitem',
        href: localize(topic.searchUrl),
        title: `X search: ${topic.query}`,
        rel: 'noopener',
      });

      const meta = el('div', { class: 'meta' });
      meta.append(
        el('span', { class: 'pts' }, `${compact(topic.points)} pts`),
        el('span', { class: 'dot' }, '·'),
        el('span', {}, `${compact(topic.comments)} comments`),
        el('span', { class: 'dot' }, '·'),
        el('span', {}, topic.age),
      );

      const body = el('div', { class: 'body' });
      body.append(el('div', { class: 'title' }, topic.title), meta);

      row.append(el('div', { class: 'rank' }, String(index + 1)), body, (() => {
        const chev = el('div', { class: 'chev' });
        chev.appendChild(icon(ICON_CHEVRON, 14));
        return chev;
      })());

      if (HARNESS) {
        row.addEventListener('click', (event) => {
          event.preventDefault();
          setStatus(`→ ${row.getAttribute('href')}`);
          console.info('[HackerX] would open', row.getAttribute('href'));
        });
      }

      list.appendChild(row);
    });
  }

  function setStatus(text) {
    if (!nodes) return;
    const note = nodes.foot.querySelector('.status');
    if (note) note.textContent = text;
  }

  function render() {
    if (!nodes) return;
    nodes.sortNew.setAttribute('aria-pressed', String(state.settings.sort === 'new'));
    nodes.sortTop.setAttribute('aria-pressed', String(state.settings.sort === 'top'));
    nodes.refreshBtn.disabled = state.loading;
    nodes.dock.dataset.side = state.settings.side;
    nodes.pill.dataset.side = state.settings.side;
    applyPosition(nodes.dock);
    applyPosition(nodes.pill);

    nodes.foot.textContent = '';
    const left = el('span', { class: 'status' });
    left.textContent = state.loading
      ? 'Refreshing…'
      : state.updatedAt
        ? `Updated ${ago(state.updatedAt)}`
        : 'Not loaded';
    const right = el('a', {
      href: 'https://news.ycombinator.com/',
      target: '_blank',
      rel: 'noopener noreferrer',
    }, `Hacker News (${state.topics.length})`);
    nodes.foot.append(left, right);

    renderList();
  }

  // ------------------------------------------------------- timeline badges
  function buildKeywordIndex() {
    state.keywords = state.topics
      .map((topic) => ({
        topic,
        words: topic.keywords.filter((w) => w.length > 2),
      }))
      .filter((entry) => entry.words.length >= 2);
  }

  function matchTopic(text) {
    const lower = text.toLowerCase();
    for (const entry of state.keywords) {
      let hits = 0;
      for (const word of entry.words) {
        if (lower.includes(word)) hits += 1;
        if (hits >= 2) return entry.topic;
      }
    }
    return null;
  }

  function decorate(tweet) {
    if (state.seenTweets.has(tweet)) {
      const existing = state.badgeHosts.get(tweet);
      if (!existing || existing.isConnected) return;
      state.badgeHosts.delete(tweet);
      state.seenTweets.delete(tweet);
    }

    const textNode = tweet.querySelector('[data-testid="tweetText"]');
    if (!textNode || !textNode.parentNode) return;

    const topic = matchTopic(textNode.textContent || '');
    state.seenTweets.add(tweet);
    if (!topic) return;

    const badgeHost = el('span', { class: 'hx-badge-host' });
    badgeHost.style.display = 'inline-block';
    const badgeRoot = badgeHost.attachShadow({ mode: 'open' });
    const link = el('link', { rel: 'stylesheet', href: resUrl('src/content/dock.css') });
    const badge = el('a', {
      class: 'badge',
      href: localize(topic.searchUrl),
      title: `${topic.title} — ${compact(topic.points)} pts on Hacker News`,
      rel: 'noopener',
    }, `HN · ${compact(topic.points)} pts`);
    badgeRoot.append(link, badge);

    if (HARNESS) {
      badge.addEventListener('click', (event) => {
        event.preventDefault();
        console.info('[HackerX] badge would open', badge.getAttribute('href'));
      });
    }

    textNode.parentNode.insertBefore(badgeHost, textNode.nextSibling);
    state.badgeHosts.set(tweet, badgeHost);
  }

  let badgeTimer = 0;
  function scheduleBadgePass() {
    if (badgeTimer) return;
    badgeTimer = window.setTimeout(() => {
      badgeTimer = 0;
      badgePass();
    }, 400);
  }

  function badgePass() {
    if (!state.settings.highlight || !document.body) return;
    try {
      const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-hx-tweet]');
      let budget = 60;
      for (const tweet of tweets) {
        if (budget-- <= 0) break;
        if (!tweet.isConnected) continue;
        decorate(tweet);
      }
      // Drop references to tweets that left the DOM.
      for (const [tweet, node] of state.badgeHosts) {
        if (!node.isConnected) state.badgeHosts.delete(tweet);
      }
    } catch (_) {
      /* never let badge decoration break the timeline */
    }
  }

  function startBadgeObserver() {
    if (!state.settings.highlight) return;
    const observer = new MutationObserver(() => scheduleBadgePass());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ------------------------------------------------------------- lifecycle
  function keepMounted() {
    // x.com re-renders <body> children on some navigations.
    setInterval(() => {
      if (host && !host.isConnected && document.body) {
        document.body.appendChild(host);
      }
    }, 3000);
  }

  async function init() {
    state.settings = { ...DEFAULT_SETTINGS, ...((await store.get(KEYS.settings)) || {}) };
    state.collapsed = (await store.get(KEYS.collapsed)) === true;
    state.position = (await store.get(KEYS.position)) || null;

    mount();
    startBadgeObserver();
    keepMounted();
    await fetchTopics();

    window.setInterval(() => fetchTopics(), REFRESH_MS);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !state.collapsed) setCollapsed(true);
    });

    if (EXT && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEYS.settings]) return;
        const next = { ...DEFAULT_SETTINGS, ...(changes[KEYS.settings].newValue || {}) };
        const sortChanged = next.sort !== state.settings.sort;
        if (next.side !== state.settings.side) {
          state.position = null;
          store.set(KEYS.position, null);
          if (nodes) {
            nodes.dock.style.left = '';
            nodes.dock.style.top = '';
            nodes.dock.style.right = '';
          }
        }
        state.settings = next;
        render();
        if (sortChanged) fetchTopics();
        else if (next.highlight) scheduleBadgePass();
      });
    }

    // Follow x.com's theme toggle.
    new MutationObserver(() => {
      if (host) host.dataset.theme = detectTheme();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
