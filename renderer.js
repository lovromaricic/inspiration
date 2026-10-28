// Inspiration — renderer (runs sandboxed; talks to the app only through window.api)
// window.api comes from preload.js (a top-level `const api` would clash with it)
const bridge = window.api;
const invoke = (channel, ...args) => bridge.invoke(channel, ...args);

const PAGE_SIZE = 60;
const COLLECTION_COLORS = ['#C4542F', '#2F4B3E', '#3A4FB8', '#D9A23A', '#8C7FA8', '#161514'];
// Lighter versions of the collection colors so they stay visible on the dark theme
const DARK_COLORS = {
  '#C4542F': '#E2774B', '#2F4B3E': '#6E9A84', '#3A4FB8': '#7C8CE6',
  '#D9A23A': '#E0B04C', '#8C7FA8': '#A898C8', '#161514': '#EDE8DF', '#0071E3': '#4C9BEF'
};
const ACCENTS = [
  { id: 'clay', light: '#C4542F', dark: '#E2774B' },
  { id: 'pine', light: '#2F4B3E', dark: '#6E9A84' },
  { id: 'indigo', light: '#3A4FB8', dark: '#7C8CE6' },
  { id: 'ochre', light: '#D9A23A', dark: '#E0B04C' },
  { id: 'ink', light: '#161514', dark: '#EDE8DF' }
];
const VIEW_NAMES = { all: 'Everything', recent: 'Recent', favorites: 'Favorites' };

const state = {
  settings: {},
  collections: [],
  counts: { recent: 0, favorites: 0, collections: {} },
  view: 'all',
  type: '',
  query: '',
  items: [],
  page: 0,
  totalPages: 0,
  totalItems: 0,
  loading: false,
  detailIndex: -1,
  allTags: [],
  tagSort: 'count',
  tagFilter: ''
};

const $ = (id) => document.getElementById(id);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// ---------- Helpers ----------

// Escape text before inserting it into HTML (titles come from scraped web pages)
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// file:// URL for a local path (handles spaces, #, ? and other characters)
function fileUrl(filePath) {
  if (!filePath) return '';
  let p = String(filePath).replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function looksLikeUrl(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return false;
  return /^https?:\/\//i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(t);
}

function colorFor(hex) {
  const key = String(hex || '').toUpperCase();
  return darkQuery.matches ? (DARK_COLORS[key] || hex) : hex;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function titleFromFile(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() || '';
  if (/^(clipboard_|temp_|inspiration-)/.test(base)) return '';
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
}

function parseTags(text) {
  return String(text || '').split(',').map(t => t.trim()).filter(Boolean);
}

function isTyping(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function collectionById(id) {
  return state.collections.find(c => c.id === Number(id));
}

function defaultCollectionId() {
  if (typeof state.view === 'number') return state.view;
  let last = null;
  try { last = Number(localStorage.getItem('lastCollection')); } catch (e) {}
  return collectionById(last) ? last : 1;
}

function rememberCollection(id) {
  try { localStorage.setItem('lastCollection', String(id)); } catch (e) {}
}

// ---------- Settings ----------

function applySettings() {
  const root = document.documentElement;
  root.dataset.accent = state.settings.accent || 'clay';
  root.dataset.density = state.settings.density || 'comfortable';
  root.dataset.captions = String(state.settings.captions !== false);
}

async function setSetting(key, value) {
  const ok = await invoke('set-setting', key, value);
  if (ok) {
    state.settings[key] = value;
    applySettings();
    if (key === 'density' || key === 'captions') renderGrid();
  }
  return ok;
}

// ---------- Sidebar ----------

async function loadCollections() {
  state.collections = await invoke('get-collections');
  renderSidebar();
}

async function refreshCounts() {
  state.counts = await invoke('get-counts');
  const all = Object.values(state.counts.collections).reduce((a, b) => a + b, 0);
  state.counts.all = all;
  $('count-all').textContent = all.toLocaleString();
  $('count-recent').textContent = state.counts.recent.toLocaleString();
  $('count-favorites').textContent = state.counts.favorites.toLocaleString();
  state.collections.forEach(c => {
    const el = document.querySelector(`[data-count-for="${c.id}"]`);
    if (el) el.textContent = (state.counts.collections[c.id] || 0).toLocaleString();
  });
  $('storageMeta').textContent = `${all.toLocaleString()} ITEMS · LOCAL`;
  renderTagsNav();
  if (state.view === 'tags') renderTagsPage();
}

// Views: 'all' | 'recent' | 'favorites' | collection id | 'tag:<name>' | 'tags'
const tagOf = (view) => typeof view === 'string' && view.startsWith('tag:') ? view.slice(4) : null;

let tagsCollapsed = false;
try { tagsCollapsed = localStorage.getItem('tagsCollapsed') === '1'; } catch (e) {}

// Five most-used tags, the open tag if it isn't one of them, then All tags
function renderTagsNav() {
  const tags = state.counts.tags || [];
  $('tagsGroup').hidden = tags.length === 0;
  $('tagsGroup').classList.toggle('collapsed', tagsCollapsed);
  $('tagsToggle').setAttribute('aria-expanded', String(!tagsCollapsed));
  const current = tagOf(state.view);
  const shown = tags.slice(0, 5);
  const open = tags.find(t => t.tag === current);
  if (open && !shown.includes(open)) shown.push(open);
  const row = (view, label, count) => `
    <button class="nav-item${!state.query && state.view === view ? ' active' : ''}${label ? ' nav-tag' : ''}" data-view="${esc(view)}">
      <span class="nav-label"><span class="nav-name">${label || 'All tags'}</span></span>
      <span class="nav-count">${count.toLocaleString()}</span>
    </button>`;
  $('tagsList').innerHTML = shown.map(t => row(`tag:${t.tag}`, `<span class="tag-hash">#</span>${esc(t.tag)}`, t.count)).join('')
    + row('tags', '', tags.length);
}

function renderTagsPage() {
  const grid = $('grid');
  const q = state.tagFilter.trim().toLowerCase().replace(/^#/, '');
  let tags = (state.counts.tags || []).filter(t => t.tag.includes(q));
  if (state.tagSort === 'alpha') tags = [...tags].sort((a, b) => a.tag.localeCompare(b.tag));
  grid.classList.remove('is-empty');
  grid.classList.add('is-tags');
  masonry.columns = [];
  if (!state.counts.tags?.length) {
    grid.innerHTML = '<p class="tag-list-empty">No tags yet. Add some from an item’s details and they’ll show up here.</p>';
  } else if (!tags.length) {
    grid.innerHTML = `<p class="tag-list-empty">No tags match “${esc(state.tagFilter.trim())}”.</p>`;
  } else {
    grid.innerHTML = tags.map(t => `
      <button class="tag-row" data-view="tag:${esc(t.tag)}">
        <span><span class="tag-hash">#</span>${esc(t.tag)}</span>
        <span class="tag-row-count">${t.count.toLocaleString()}</span>
      </button>`).join('');
  }
  document.querySelectorAll('#tagSort button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.sort === state.tagSort)));
}

function renderSidebar() {
  $('collectionsList').innerHTML = state.collections.map(c => `
    <button class="nav-item${state.view === c.id ? ' active' : ''}" data-view="${c.id}" data-collection-drop="${c.id}">
      <span class="nav-label"><span class="swatch-dot" style="background:${esc(colorFor(c.color))}"></span><span class="nav-name">${esc(c.name)}</span></span>
      <span class="nav-count has-more" data-count-for="${c.id}">${(state.counts.collections[c.id] || 0).toLocaleString()}</span>
      <span class="nav-more" data-collection-menu="${c.id}" role="button" aria-label="Collection options" title="Options">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
      </span>
    </button>
  `).join('');

  document.querySelectorAll('.sidebar .nav-group:first-of-type .nav-item').forEach(el => {
    el.classList.toggle('active', !state.query && el.dataset.view === String(state.view));
  });
  renderTagsNav();
}

// ---------- Header ----------

function renderHeader() {
  const title = $('collectionTitle');
  const eyebrow = $('eyebrow');
  const n = state.totalItems.toLocaleString();
  const label = state.totalItems === 1 ? 'ITEM' : 'ITEMS';

  if (state.query) {
    title.innerHTML = `<em>“</em>${esc(state.query)}<em>”</em>`;
    eyebrow.textContent = `SEARCH — ${n} ${state.totalItems === 1 ? 'RESULT' : 'RESULTS'}`;
  } else if (typeof state.view === 'number') {
    const c = collectionById(state.view);
    title.textContent = c ? c.name : 'Collection';
    eyebrow.textContent = `COLLECTION — ${n} ${label}`;
  } else if (state.view === 'tags') {
    const used = (state.counts.tags || []).length;
    title.textContent = 'All tags';
    eyebrow.textContent = `TAGS — ${used.toLocaleString()} IN USE`;
  } else if (tagOf(state.view) !== null) {
    const tag = tagOf(state.view);
    const spread = (state.counts.tags || []).find(t => t.tag === tag)?.collections || 0;
    title.innerHTML = `<em>#</em>${esc(tag)}`;
    eyebrow.textContent = `TAG — ${n} ${label}` + (spread > 1 ? ` IN ${spread} COLLECTIONS` : '');
  } else {
    title.textContent = VIEW_NAMES[state.view];
    const extra = state.view === 'recent' ? ' — LAST 30 DAYS' : '';
    eyebrow.textContent = `LIBRARY — ${n} ${label}${extra}`;
  }

  $('mainContent').classList.toggle('is-tags-page', state.view === 'tags' && !state.query);
  $('miniTitle').innerHTML = title.innerHTML;
  $('miniCount').textContent = state.view === 'tags' ? '' : n;
  $('miniSearchText').textContent = state.query || 'Search';
  $('miniSearchText').classList.toggle('has-query', !!state.query);

  document.querySelectorAll('#typeFilter button, #miniTypeFilter button').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.type === state.type));
  });
  $('dropTarget').textContent = `TO ${(collectionById(defaultCollectionId())?.name || 'MY COLLECTION').toUpperCase()}`;
}

// The mono font draws ⌘ and ↵ tiny; show them in the system font instead
function kbdKeys(keys) {
  return keys.replace(/([⌘↵]) ?/g, '<span class="kbd-sym">$1</span>');
}

// Search lives in the big header; from further down, glide back up to it
function focusSearch() {
  const main = $('mainContent');
  if (main.scrollTop > 0) main.scrollTo({ top: 0, behavior: 'smooth' });
  const field = main.classList.contains('is-tags-page') ? $('tagFilter') : $('search');
  field.focus({ preventScroll: true });
  field.select();
}

// ---------- Grid ----------

function cardHtml(item, index, isNew) {
  const domain = item.type === 'url' ? domainOf(item.source_url) : (domainOf(item.source_url) || 'image');
  const ratio = item.width && item.height ? ` style="aspect-ratio:${item.width}/${item.height}"` : '';
  return `
    <article class="card${isNew ? ' is-new' : ''}" data-index="${index}" tabindex="0" draggable="true" aria-label="${esc(item.title || 'Untitled')}">
      <div class="card-art">
        <img src="${fileUrl(item.thumbnail_path)}" alt=""${ratio} loading="lazy" decoding="async" draggable="false">
        <button class="card-fav${item.is_favorite ? ' on' : ''}" data-fav="${item.id}" aria-label="${item.is_favorite ? 'Remove from favorites' : 'Add to favorites'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${item.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>
        </button>
        ${item.type === 'url' ? '<span class="card-type">LINK</span>' : ''}
      </div>
      <div class="card-cap"><b>${esc(item.title || 'Untitled')}</b><span>${esc(domain)}</span></div>
    </article>
  `;
}

function renderEmpty() {
  const grid = $('grid');
  let heading = 'Start this collection';
  let body = 'Drop images anywhere, paste with ⌘V, or type a link in the bar below.';
  let action = '<button class="btn btn-ink" data-empty="pick">Add images</button>';

  if (state.query) {
    heading = 'Nothing matches';
    body = `No titles, tags, notes or links contain “${esc(state.query)}”.`;
    action = '';
  } else if (state.view === 'favorites') {
    heading = 'No favorites yet';
    body = 'Tap the star on anything you want to keep close.';
    action = '';
  } else if (state.view === 'recent') {
    heading = 'Nothing new lately';
    body = 'Items you add in the next 30 days show up here.';
  } else if (state.type) {
    heading = state.type === 'url' ? 'No links here' : 'No images here';
    body = 'Try “All” to see everything in this view.';
    action = '';
  }

  grid.innerHTML = `
    <div class="empty">
      <div class="empty-art" aria-hidden="true">
        <span style="height:84px;background:${colorFor('#C4542F')}"></span>
        <span style="height:120px;background:${colorFor('#2F4B3E')}"></span>
        <span style="height:64px;background:#E9E4F5"></span>
      </div>
      <h2>${heading}</h2>
      <p>${body}</p>
      ${action}
    </div>
  `;
}

// Masonry: each card goes into the currently shortest column, so the newest items
// run across the top row and loading more only adds to the bottom (nothing jumps).
const masonry = { columns: [], heights: [], colWidth: 0 };

function columnCount() {
  const styles = getComputedStyle(document.documentElement);
  const target = parseFloat(styles.getPropertyValue('--col-width')) || 230;
  const gap = parseFloat(styles.getPropertyValue('--col-gap')) || 28;
  const width = $('grid').clientWidth;
  return Math.max(1, Math.floor((width + gap) / (target + gap)));
}

function placeCards(from) {
  const captionHeight = state.settings.captions === false ? 0 : 34;
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--col-gap')) || 28;
  const buckets = masonry.columns.map(() => []);
  for (let i = from; i < state.items.length; i++) {
    const item = state.items[i];
    const ratio = item.width && item.height ? item.height / item.width : 1.25;
    const col = masonry.heights.indexOf(Math.min(...masonry.heights));
    buckets[col].push(cardHtml(item, i, false));
    masonry.heights[col] += masonry.colWidth * ratio + captionHeight + gap;
  }
  buckets.forEach((html, c) => {
    if (html.length) masonry.columns[c].insertAdjacentHTML('beforeend', html.join(''));
  });
}

function renderGrid() {
  const grid = $('grid');
  if (state.items.length === 0) {
    grid.classList.add('is-empty');
    masonry.columns = [];
    renderEmpty();
    return;
  }
  grid.classList.remove('is-empty');
  const count = columnCount();
  grid.innerHTML = Array.from({ length: count }, () => '<div class="grid-col"></div>').join('');
  masonry.columns = Array.from(grid.children);
  masonry.heights = masonry.columns.map(() => 0);
  masonry.colWidth = masonry.columns[0].clientWidth || 230;
  placeCards(0);
}

function appendCards(from) {
  if (masonry.columns.length === 0) {
    renderGrid();
    return;
  }
  placeCards(from);
}

// Re-flow only when the number of columns changes (window resize, density setting)
function relayoutIfNeeded() {
  if (state.items.length && masonry.columns.length !== columnCount()) {
    renderGrid();
  }
}

async function loadItems(reset = true) {
  if (state.loading) return;
  state.loading = true;
  try {
    $('grid').classList.remove('is-tags');
    if (state.view === 'tags' && !state.query) {
      state.items = [];
      state.page = state.totalPages = state.totalItems = 0;
      renderTagsPage();
    } else if (state.query) {
      let results = await invoke('search-items', state.query);
      if (state.type) results = results.filter(i => i.type === state.type);
      state.items = results;
      state.page = 1;
      state.totalPages = 1;
      state.totalItems = results.length;
      renderGrid();
    } else {
      const page = reset ? 1 : state.page + 1;
      const result = await invoke('get-items-paginated', state.view, page, PAGE_SIZE, state.type || null);
      const from = reset ? 0 : state.items.length;
      state.items = reset ? result.items : state.items.concat(result.items);
      state.page = page;
      state.totalPages = result.pagination.totalPages;
      state.totalItems = result.pagination.totalItems;
      if (reset) renderGrid();
      else appendCards(from);
    }
    renderHeader();
    renderListEnd();
  } finally {
    state.loading = false;
  }
}

// Quiet line under the grid: "loading more" while paging, an end marker once everything is shown
function renderListEnd() {
  const el = $('loadMore');
  if (state.items.length <= PAGE_SIZE / 2) {
    el.textContent = '';
  } else if (state.page < state.totalPages) {
    el.textContent = 'LOADING MORE…';
  } else {
    el.textContent = `THAT'S EVERYTHING — ${state.totalItems.toLocaleString()} ITEMS`;
  }
}

async function loadMoreIfNeeded() {
  if (!state.query && state.page < state.totalPages) {
    await loadItems(false);
  }
}

async function setView(view) {
  state.view = view;
  state.query = '';
  $('search').value = '';
  state.tagFilter = '';
  $('tagFilter').value = '';
  renderSidebar();
  $('mainContent').scrollTop = 0;
  await loadItems(true);
}

async function refresh() {
  await Promise.all([loadItems(true), refreshCounts()]);
}

// ---------- Favorites ----------

async function toggleFavorite(id) {
  await invoke('toggle-favorite', id);
  const item = state.items.find(i => i.id === id);
  if (item) item.is_favorite = item.is_favorite ? 0 : 1;

  if (state.view === 'favorites' && item && !item.is_favorite && state.detailIndex === -1) {
    await refresh();
  } else {
    const card = document.querySelector(`[data-fav="${id}"]`);
    if (card && item) {
      card.classList.toggle('on', !!item.is_favorite);
      card.querySelector('svg').setAttribute('fill', item.is_favorite ? 'currentColor' : 'none');
    }
    refreshCounts();
  }
  return item;
}

// ---------- Menus and dialogs ----------

let openMenu = null;
function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

// items: [{label, action, danger}] or 'sep'
function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  items.forEach(entry => {
    if (entry === 'sep') {
      menu.appendChild(document.createElement('hr'));
      return;
    }
    const btn = document.createElement('button');
    btn.setAttribute('role', 'menuitem');
    btn.textContent = entry.label;
    if (entry.danger) btn.className = 'danger';
    btn.addEventListener('click', () => {
      closeMenu();
      entry.action();
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

const modalStack = [];

function openModal(html, { center = false, onClose } = {}) {
  const modal = document.createElement('div');
  modal.className = 'modal' + (center ? ' center' : '');
  modal.innerHTML = html;
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeModal(modal);
  });
  modal._onClose = onClose;
  $('modalRoot').appendChild(modal);
  modalStack.push(modal);
  document.body.classList.add('overlay-open');
  return modal;
}

function closeModal(modal = modalStack[modalStack.length - 1]) {
  if (!modal) return;
  const i = modalStack.indexOf(modal);
  if (i >= 0) modalStack.splice(i, 1);
  if (modal._onClose) modal._onClose();
  modal.remove();
  syncOverlayClass();
}

// Window drag areas swallow clicks even under overlays, so turn them off while one is open
function syncOverlayClass() {
  document.body.classList.toggle('overlay-open', modalStack.length > 0 || !$('detail').hidden);
}

function confirmDialog({ title, message, confirmLabel = 'Delete' }) {
  return new Promise(resolve => {
    let answered = false;
    const modal = openModal(`
      <div class="dialog small" role="alertdialog" aria-label="${esc(title)}">
        <div class="dialog-pad">
          <h2>${esc(title)}</h2>
          <p class="sub">${esc(message)}</p>
        </div>
        <div class="dialog-footer">
          <span class="spacer"></span>
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-danger" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>
    `, { center: true, onClose: () => { if (!answered) resolve(false); } });
    modal.querySelector('[data-act="ok"]').focus();
    modal.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      answered = true;
      resolve(act === 'ok');
      closeModal(modal);
    });
  });
}

function nameDialog({ title, value = '', confirmLabel, withColor = false, color = COLLECTION_COLORS[0] }) {
  return new Promise(resolve => {
    let done = false;
    let picked = color;
    const modal = openModal(`
      <div class="dialog small" role="dialog" aria-label="${esc(title)}">
        <form class="dialog-pad" data-form>
          <h2>${esc(title)}</h2>
          <input class="field" data-name value="${esc(value)}" placeholder="Brand — Nord Coffee" style="margin-top:14px" spellcheck="false">
          ${withColor ? `<div class="color-pick" role="radiogroup" aria-label="Color">${COLLECTION_COLORS.map(c => `
            <button type="button" role="radio" aria-checked="${c === picked}" aria-label="Color ${c}" data-color="${c}" style="background:${colorFor(c)}"></button>`).join('')}</div>` : ''}
          <div class="error" data-error hidden>Give it a name first.</div>
        </form>
        <div class="dialog-footer">
          <span class="spacer"></span>
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-ink" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>
    `, { center: true, onClose: () => { if (!done) resolve(null); } });
    const input = modal.querySelector('[data-name]');
    setTimeout(() => { input.focus(); input.select(); }, 30);

    const submit = () => {
      const name = input.value.trim();
      if (!name) {
        modal.querySelector('[data-error]').hidden = false;
        input.focus();
        return;
      }
      done = true;
      resolve({ name, color: picked });
      closeModal(modal);
    };
    input.addEventListener('input', () => { modal.querySelector('[data-error]').hidden = true; });
    modal.querySelector('[data-form]').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    modal.addEventListener('click', (e) => {
      const colorBtn = e.target.closest('[data-color]');
      if (colorBtn) {
        picked = colorBtn.dataset.color;
        modal.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-checked', String(b === colorBtn)));
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') submit();
      if (act === 'cancel') closeModal(modal);
    });
  });
}

// ---------- Collections ----------

async function newCollection() {
  const used = state.collections.length;
  const result = await nameDialog({ title: 'New collection', confirmLabel: 'Create', withColor: true, color: COLLECTION_COLORS[used % COLLECTION_COLORS.length] });
  if (!result) return;
  const id = await invoke('create-collection', result.name, result.color);
  await loadCollections();
  await refreshCounts();
  await setView(Number(id));
}

async function renameCollection(id) {
  const c = collectionById(id);
  const result = await nameDialog({ title: 'Rename collection', value: c.name, confirmLabel: 'Rename' });
  if (!result || result.name === c.name) return;
  await invoke('rename-collection', id, result.name);
  await loadCollections();
  renderHeader();
}

async function deleteCollection(id) {
  const c = collectionById(id);
  const count = await invoke('get-collection-item-count', id);
  const ok = await confirmDialog({
    title: `Delete “${c.name}”?`,
    message: count
      ? `This permanently deletes the collection and its ${count} ${count === 1 ? 'item' : 'items'}, including the image files.`
      : 'This collection is empty.',
    confirmLabel: 'Delete collection'
  });
  if (!ok) return;
  await invoke('delete-collection', id);
  await loadCollections();
  await refreshCounts();
  if (state.view === id) await setView('all');
  toast(`Deleted “${c.name}”`);
}

function collectionMenu(id, x, y) {
  const entries = [{ label: 'Rename…', action: () => renameCollection(id) }];
  if (id !== 1) {
    entries.push('sep', { label: 'Delete collection…', danger: true, action: () => deleteCollection(id) });
  }
  showMenu(x, y, entries);
}

// ---------- Detail view ----------

const detailEls = {};
let detailItem = null;

function autosizeTitle() {
  const el = $('detailTitle');
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

const saveDetailField = debounce(async (field, value) => {
  if (!detailItem) return;
  const id = detailItem.id;
  await invoke('update-item', id, { [field]: value });
  const item = state.items.find(i => i.id === id);
  if (item) item[field] = value;
  if (field === 'title') {
    const card = document.querySelector(`.card[data-index="${state.items.indexOf(item)}"] .card-cap b`);
    if (card) card.textContent = value || 'Untitled';
  }
}, 350);

function renderDetailTags() {
  const tags = parseTags(detailItem.tags);
  $('detailTags').innerHTML = tags.map((t, i) => `
    <span class="tag"><button class="tag-link" data-open-tag="${esc(t.toLowerCase())}" title="Show everything tagged ${esc(t)}">${esc(t)}</button><button data-remove-tag="${i}" aria-label="Remove tag ${esc(t)}">×</button></span>
  `).join('') + '<input class="tag-input" id="detailTagInput" placeholder="+ Add tag" aria-label="Add tag" spellcheck="false">';
}

function setDetailTags(tags) {
  const value = tags.join(', ');
  detailItem.tags = value;
  const item = state.items.find(i => i.id === detailItem.id);
  if (item) item.tags = value;
  invoke('update-item', detailItem.id, { tags: value }).then(refreshCounts);
  renderDetailTags();
  $('detailTagInput').focus();
}

function renderDetailFavorite() {
  const btn = $('detailFavorite');
  const on = !!detailItem.is_favorite;
  btn.classList.toggle('on', on);
  btn.querySelector('span').textContent = on ? 'Favorited' : 'Favorite';
  btn.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
  btn.querySelector('svg').setAttribute('stroke', 'currentColor');
}

async function openDetail(index) {
  if (index < 0 || index >= state.items.length) return;
  state.detailIndex = index;
  const base = state.items[index];
  detailItem = { ...base };

  $('detail').hidden = false;
  syncOverlayClass();
  $('detailCanvas').classList.remove('actual');
  $('detailImage').src = fileUrl(base.file_path);
  $('detailImage').alt = base.title || '';
  $('detailCrumb').textContent = state.query ? 'Search'
    : typeof state.view === 'number' ? collectionById(state.view)?.name
    : tagOf(state.view) !== null ? `#${tagOf(state.view)}`
    : VIEW_NAMES[state.view];
  $('detailPos').textContent = `${index + 1} / ${state.totalItems.toLocaleString()}`;
  $('detailKind').textContent = `${base.type === 'url' ? 'LINK' : 'IMAGE'} · ADDED ${formatDate(base.date_added).toUpperCase()}`;
  $('detailTitle').value = base.title || '';
  $('detailNotes').value = base.notes || '';
  autosizeTitle();

  const hasUrl = !!(base.source_url && base.source_url.trim());
  $('detailSource').hidden = !hasUrl;
  $('detailUrlEditLabel').hidden = hasUrl;
  $('detailUrlInput').value = '';
  if (hasUrl) {
    const d = domainOf(base.source_url) || base.source_url;
    $('detailDomain').textContent = d;
    $('detailUrl').textContent = base.source_url.replace(/^https?:\/\/(www\.)?/, '');
    $('detailSourceIcon').textContent = d.charAt(0);
  }

  renderDetailTags();
  renderDetailFavorite();
  $('detailPalette').innerHTML = '<span class="palette-empty">Reading colors…</span>';
  $('detailMeta').innerHTML = '';

  const details = await invoke('get-item-details', base.id);
  if (!details || state.detailIndex !== index) return;
  const palette = details.palette || [];
  $('detailPalette').innerHTML = palette.length
    ? palette.map(hex => `<button data-hex="${esc(hex)}" aria-label="Copy ${esc(hex)}"><i style="background:${esc(hex)}"></i><span>${esc(hex)}</span></button>`).join('')
    : '<span class="palette-empty">No colors found.</span>';
  const fmt = (String(details.file_path).split('.').pop() || '').toUpperCase();
  $('detailMeta').innerHTML = `
    <div><span>Dimensions</span><span>${details.width ? `${details.width} × ${details.height}` : '—'}</span></div>
    <div><span>File</span><span>${esc(fmt)} · ${formatBytes(details.file_size)}</span></div>
    <div><span>Collection</span><span>${esc(collectionById(details.collection_id)?.name || '—')}</span></div>
  `;
}

function closeDetail() {
  $('detail').hidden = true;
  syncOverlayClass();
  state.detailIndex = -1;
  detailItem = null;
  if (state.view === 'favorites') refresh();
}

async function stepDetail(delta) {
  let next = state.detailIndex + delta;
  if (next >= state.items.length && state.page < state.totalPages) {
    await loadMoreIfNeeded();
  }
  if (next < 0 || next >= state.items.length) return;
  openDetail(next);
}

async function removeCurrentFromList() {
  const i = state.detailIndex;
  state.items.splice(i, 1);
  state.totalItems = Math.max(0, state.totalItems - 1);
  renderGrid();
  renderHeader();
  refreshCounts();
  if (state.items.length === 0) {
    closeDetail();
  } else {
    openDetail(Math.min(i, state.items.length - 1));
  }
}

async function detailAction(action, anchor) {
  if (!detailItem) return;
  const item = detailItem;
  switch (action) {
    case 'close': closeDetail(); break;
    case 'prev': stepDetail(-1); break;
    case 'next': stepDetail(1); break;
    case 'zoom': $('detailCanvas').classList.toggle('actual'); break;
    case 'download': {
      const r = await invoke('save-image', item.file_path);
      if (r.success) toast('Saved a copy');
      break;
    }
    case 'copy':
      if (await invoke('copy-image', item.file_path)) toast('Image copied');
      break;
    case 'move': {
      const rect = anchor.getBoundingClientRect();
      const targets = state.collections.filter(c => c.id !== item.collection_id);
      if (targets.length === 0) {
        toast('Create another collection first');
        break;
      }
      showMenu(rect.left, rect.top - 8 - targets.length * 32, targets.map(c => ({
        label: c.name,
        action: () => moveItem(item.id, c.id)
      })));
      break;
    }
    case 'delete': {
      const ok = await confirmDialog({ title: 'Delete this item?', message: `“${item.title || 'Untitled'}” and its image file will be removed. This can't be undone.` });
      if (!ok) break;
      await invoke('delete-item', item.id);
      toast('Deleted');
      await removeCurrentFromList();
      break;
    }
  }
}

async function moveItem(id, collectionId) {
  const r = await invoke('move-item', id, collectionId);
  if (!r.success) {
    toast("Couldn't move it");
    return;
  }
  const name = collectionById(collectionId)?.name;
  toast(`Moved to ${name}`);
  const fresh = await invoke('get-item', id);
  const idx = state.items.findIndex(i => i.id === id);
  if (typeof state.view === 'number' && state.view !== collectionId && idx >= 0) {
    if (state.detailIndex === idx) {
      await removeCurrentFromList();
    } else {
      state.items.splice(idx, 1);
      state.totalItems--;
      renderGrid();
      renderHeader();
      refreshCounts();
    }
  } else if (idx >= 0) {
    state.items[idx] = fresh;
    if (state.detailIndex === idx) openDetail(idx);
    refreshCounts();
  }
}

function setupDetail() {
  $('detail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-detail]');
    if (btn) detailAction(btn.dataset.detail, btn);

    const hex = e.target.closest('[data-hex]');
    if (hex) {
      invoke('copy-text', hex.dataset.hex);
      toast(`Copied ${hex.dataset.hex}`);
    }

    const openTag = e.target.closest('[data-open-tag]');
    if (openTag) {
      closeDetail();
      setView(`tag:${openTag.dataset.openTag}`);
      return;
    }

    const rm = e.target.closest('[data-remove-tag]');
    if (rm) {
      const tags = parseTags(detailItem.tags);
      tags.splice(Number(rm.dataset.removeTag), 1);
      setDetailTags(tags);
    }
  });

  $('detailFavorite').addEventListener('click', async () => {
    if (!detailItem) return;
    const item = await toggleFavorite(detailItem.id);
    detailItem.is_favorite = item ? item.is_favorite : (detailItem.is_favorite ? 0 : 1);
    renderDetailFavorite();
  });

  $('detailSource').addEventListener('click', (e) => {
    e.preventDefault();
    if (detailItem?.source_url) invoke('open-url', detailItem.source_url);
  });

  $('detailTitle').addEventListener('input', (e) => {
    autosizeTitle();
    detailItem.title = e.target.value;
    saveDetailField('title', e.target.value.trim());
  });
  $('detailTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });
  $('detailNotes').addEventListener('input', (e) => saveDetailField('notes', e.target.value));
  $('detailUrlInput').addEventListener('change', async (e) => {
    let url = e.target.value.trim();
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    await invoke('update-item', detailItem.id, { source_url: url });
    const item = state.items.find(i => i.id === detailItem.id);
    if (item) item.source_url = url;
    openDetail(state.detailIndex);
  });

  $('detailTags').addEventListener('keydown', (e) => {
    if (e.target.id !== 'detailTagInput') return;
    const input = e.target;
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const tags = parseTags(detailItem.tags);
      parseTags(input.value).forEach(t => { if (!tags.includes(t)) tags.push(t); });
      setDetailTags(tags);
    } else if (e.key === 'Backspace' && !input.value) {
      const tags = parseTags(detailItem.tags);
      if (tags.length) {
        tags.pop();
        setDetailTags(tags);
      }
    }
  });

  $('detailImage').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Copy image', action: () => detailAction('copy') },
      { label: 'Save a copy…', action: () => detailAction('download') }
    ]);
  });
}

// ---------- Adding: links ----------

function tagBoxHtml() {
  return `
    <div class="tag-box" data-tagbox><input class="tag-input" data-tag-input placeholder="Add tag" aria-label="Add tag" spellcheck="false"></div>
    <div class="suggest" data-suggest></div>
  `;
}

// Wires a tag box inside `root`; returns a getter for the chosen tags
function setupTagBox(root) {
  const box = root.querySelector('[data-tagbox]');
  const input = root.querySelector('[data-tag-input]');
  const suggest = root.querySelector('[data-suggest]');
  const tags = [];

  const render = () => {
    box.querySelectorAll('.tag').forEach(el => el.remove());
    tags.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.innerHTML = `${esc(t)}<button type="button" data-rm="${i}" aria-label="Remove tag ${esc(t)}">×</button>`;
      box.insertBefore(chip, input);
    });
    const ideas = state.allTags.filter(t => !tags.includes(t)).slice(0, 5);
    suggest.innerHTML = ideas.length ? 'Suggested: ' + ideas.map(t => `<button type="button" data-add="${esc(t)}">${esc(t)}</button>`).join('') : '';
  };
  const add = (text) => {
    parseTags(text).forEach(t => { if (!tags.includes(t)) tags.push(t); });
    input.value = '';
    render();
  };

  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      e.stopPropagation();
      add(input.value);
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      render();
    }
  });
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      tags.splice(Number(rm.dataset.rm), 1);
      render();
    } else {
      input.focus();
    }
  });
  suggest.addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) add(b.dataset.add);
  });
  render();

  return () => {
    if (input.value.trim()) add(input.value);
    return tags.join(', ');
  };
}

function collectionSelectHtml(selected) {
  return `<select class="select" data-collection aria-label="Save to">${state.collections.map(c =>
    `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
}

async function openAddLink(prefill = '') {
  state.allTags = await invoke('get-all-tags');
  let preview = null;
  let saved = false;

  const modal = openModal(`
    <div class="dialog" role="dialog" aria-label="Add a link">
      <label class="link-input-row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>
        <input data-url placeholder="Paste or type a link" aria-label="Link" spellcheck="false" value="${esc(prefill)}">
        <span class="status" data-status hidden></span>
      </label>
      <div data-body hidden>
        <div class="add-body">
          <div class="add-cover" data-cover></div>
          <div class="add-fields">
            <label class="field-label">
              <span class="eyebrow">Title</span>
              <input class="title-input" data-title spellcheck="false">
              <span class="desc" data-desc></span>
            </label>
            <label class="field-label"><span class="eyebrow">Save to</span>${collectionSelectHtml(defaultCollectionId())}</label>
            <div class="field-label"><span class="eyebrow">Tags</span>${tagBoxHtml()}</div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <span class="hint"><span class="kbd">↵</span>Save</span>
        <span class="hint"><span class="kbd">${kbdKeys('⌘ ↵')}</span>Save and open</span>
        <span class="hint"><span class="kbd">esc</span>Cancel</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-act="cancel">Cancel</button>
        <button class="btn btn-ink" data-act="save">Fetch preview</button>
      </div>
    </div>
  `, {
    onClose: () => {
      if (!saved && preview?.imagePath) invoke('discard-temp', preview.imagePath);
    }
  });

  const urlInput = modal.querySelector('[data-url]');
  const status = modal.querySelector('[data-status]');
  const body = modal.querySelector('[data-body]');
  const saveBtn = modal.querySelector('[data-act="save"]');
  const getTags = setupTagBox(modal);
  let fetching = false;

  const setStatus = (text, kind) => {
    status.hidden = !text;
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  };

  const fetchPreview = async () => {
    const url = urlInput.value.trim();
    if (!url || fetching) return;
    if (!looksLikeUrl(url)) {
      setStatus("That doesn't look like a link", '');
      return;
    }
    fetching = true;
    if (preview?.imagePath) invoke('discard-temp', preview.imagePath);
    preview = null;
    setStatus('Fetching preview', 'busy');
    body.hidden = false;
    const cover = modal.querySelector('[data-cover]');
    cover.className = 'add-cover loading';
    cover.innerHTML = '';
    saveBtn.textContent = 'Save link';

    const result = await invoke('preview-url', url);
    fetching = false;
    if (!modal.isConnected) {
      if (result.imagePath) invoke('discard-temp', result.imagePath);
      return;
    }
    if (!result.success) {
      setStatus(result.error, '');
      body.hidden = true;
      saveBtn.textContent = 'Fetch preview';
      return;
    }
    preview = result;
    setStatus(result.isImage ? 'Image found' : 'Preview ready', 'ok');
    cover.className = 'add-cover';
    cover.innerHTML = result.imagePath
      ? `<img src="${fileUrl(result.imagePath)}" alt="">`
      : `<div style="height:100%;padding:22px 22px 54px;display:flex;flex-direction:column;justify-content:space-between;background:${colorFor('#2F4B3E')}">
           <span class="mono" style="font-size:10px;color:#A9BBAE">${esc(result.domain.toUpperCase())}</span>
           <span style="font-family:var(--serif);font-size:30px;line-height:1;color:#F2EDE4">${esc(result.title)}</span>
         </div><span class="cover-note">NO COVER — A TITLE CARD WILL BE MADE</span>`;
    const titleInput = modal.querySelector('[data-title]');
    titleInput.value = result.title || '';
    modal.querySelector('[data-desc]').innerHTML = `<span class="fav">${esc(result.domain.charAt(0))}</span><span class="txt">${esc(result.domain)}${result.description ? ' · ' + esc(result.description) : ''}</span>`;
    titleInput.focus();
    titleInput.select();
  };

  const save = async (openAfter) => {
    if (!preview) {
      fetchPreview();
      return;
    }
    const collectionId = Number(modal.querySelector('[data-collection]').value);
    saveBtn.disabled = true;
    const r = await invoke('save-url', {
      url: preview.url,
      domain: preview.domain,
      title: modal.querySelector('[data-title]').value.trim() || preview.domain,
      tags: getTags(),
      collectionId,
      imagePath: preview.imagePath,
      isImage: preview.isImage
    });
    saveBtn.disabled = false;
    if (!r.success) {
      setStatus(r.error || "Couldn't save", '');
      return;
    }
    saved = true;
    rememberCollection(collectionId);
    closeModal(modal);
    toast(`Saved to ${collectionById(collectionId)?.name}`);
    await afterAdd(collectionId, openAfter ? r.id : null);
  };

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      preview ? save(e.metaKey) : fetchPreview();
    }
  });
  urlInput.addEventListener('paste', () => setTimeout(fetchPreview, 0));
  urlInput.addEventListener('input', () => {
    if (preview && urlInput.value.trim() !== preview.url) {
      saveBtn.textContent = 'Fetch preview';
    }
  });
  modal.querySelector('[data-title]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save(e.metaKey);
    }
  });
  modal.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') closeModal(modal);
    if (act === 'save') {
      if (preview && urlInput.value.trim() !== preview.url && urlInput.value.trim() !== preview.url.replace(/^https:\/\//, '')) fetchPreview();
      else save(false);
    }
  });

  if (prefill) fetchPreview();
  else setTimeout(() => urlInput.focus(), 30);
}

// After saving: show the collection it went into and optionally open the item
async function afterAdd(collectionId, openId) {
  const visible = state.view === 'all' || state.view === 'recent' || state.view === collectionId;
  if (!visible || state.query) {
    await setView(collectionId);
  } else {
    await refresh();
  }
  await refreshCounts();
  if (openId) {
    const idx = state.items.findIndex(i => i.id === openId);
    if (idx >= 0) openDetail(idx);
  } else {
    const first = document.querySelector('.card[data-index="0"]');
    if (first) first.classList.add('is-new');
  }
}

// ---------- Adding: images ----------

async function openAddImages(paths) {
  paths = paths.filter(Boolean);
  if (paths.length === 0) return;
  state.allTags = await invoke('get-all-tags');
  let index = 0;
  let collectionId = defaultCollectionId();
  let lastSavedId = null;
  let savedCount = 0;

  const discardRest = () => {
    paths.slice(index).forEach(p => invoke('discard-temp', p));
  };

  const modal = openModal(`
    <div class="dialog" role="dialog" aria-label="Add images">
      <div class="link-input-row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>
        <span style="flex:1;font-size:15px;color:var(--text)" data-heading></span>
        <span class="queue" data-queue></span>
      </div>
      <div class="add-body">
        <div class="add-cover" data-cover></div>
        <div class="add-fields">
          <label class="field-label">
            <span class="eyebrow">Title</span>
            <input class="title-input" data-title placeholder="Untitled" spellcheck="false">
          </label>
          <label class="field-label">
            <span class="eyebrow">Source link — optional</span>
            <input class="field" data-source placeholder="https://" spellcheck="false">
          </label>
          <label class="field-label"><span class="eyebrow">Save to</span>${collectionSelectHtml(collectionId)}</label>
          <div class="field-label"><span class="eyebrow">Tags</span>${tagBoxHtml()}</div>
        </div>
      </div>
      <div class="dialog-footer">
        <span class="hint"><span class="kbd">↵</span>Save</span>
        <span class="hint"><span class="kbd">esc</span>Cancel</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-act="skip">Skip</button>
        <button class="btn btn-outline" data-act="all" hidden></button>
        <button class="btn btn-ink" data-act="save">Save</button>
      </div>
    </div>
  `, { onClose: () => discardRest() });

  const titleInput = modal.querySelector('[data-title]');
  const sourceInput = modal.querySelector('[data-source]');
  const select = modal.querySelector('[data-collection]');
  const getTags = setupTagBox(modal);
  const allBtn = modal.querySelector('[data-act="all"]');
  const skipBtn = modal.querySelector('[data-act="skip"]');

  const show = () => {
    const p = paths[index];
    const remaining = paths.length - index;
    modal.querySelector('[data-heading]').textContent = paths.length > 1 ? 'Add images' : 'Add image';
    modal.querySelector('[data-queue]').textContent = paths.length > 1 ? `${index + 1} OF ${paths.length}` : '';
    modal.querySelector('[data-cover]').innerHTML = `<img src="${fileUrl(p)}" alt="">`;
    titleInput.value = titleFromFile(p);
    sourceInput.value = '';
    allBtn.hidden = remaining < 2;
    allBtn.textContent = `Save all ${remaining}`;
    skipBtn.hidden = paths.length < 2;
    setTimeout(() => { titleInput.focus(); titleInput.select(); }, 30);
  };

  const finish = async () => {
    closeModal(modal);
    if (savedCount > 0) {
      rememberCollection(collectionId);
      toast(`Saved ${savedCount} ${savedCount === 1 ? 'image' : 'images'} to ${collectionById(collectionId)?.name}`);
      await afterAdd(collectionId, null);
    }
  };

  const saveOne = async (p, title, source, tags) => {
    const r = await invoke('add-image', p, { collectionId, title, sourceUrl: source, tags });
    if (r.success) {
      savedCount++;
      lastSavedId = r.id;
    } else {
      toast(`Couldn't add an image: ${r.error}`);
    }
  };

  const saveCurrent = async () => {
    collectionId = Number(select.value);
    let source = sourceInput.value.trim();
    if (source && !/^[a-z][a-z0-9+.-]*:/i.test(source)) source = `https://${source}`;
    await saveOne(paths[index], titleInput.value.trim(), source, getTags());
    index++;
    if (index >= paths.length) await finish();
    else show();
  };

  const saveAll = async () => {
    collectionId = Number(select.value);
    const tags = getTags();
    const firstTitle = titleInput.value.trim();
    const firstIndex = index;
    allBtn.disabled = true;
    while (index < paths.length) {
      const title = index === firstIndex ? firstTitle : titleFromFile(paths[index]);
      await saveOne(paths[index], title, '', tags);
      index++;
    }
    await finish();
  };

  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCurrent();
    }
  });
  modal.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') saveCurrent();
    if (act === 'all') saveAll();
    if (act === 'skip') {
      invoke('discard-temp', paths[index]);
      index++;
      if (index >= paths.length) finish();
      else show();
    }
  });

  show();
}

async function pickImages() {
  const paths = await invoke('pick-images');
  if (paths.length) openAddImages(paths);
}

// Clipboard: an image, or a link
async function addFromClipboard() {
  const image = await invoke('read-clipboard-image');
  if (image.success) {
    openAddImages([image.path]);
    return true;
  }
  const text = await invoke('read-clipboard-text');
  if (text.success && looksLikeUrl(text.text)) {
    openAddLink(text.text);
    return true;
  }
  return false;
}

// ---------- Settings ----------

async function openSettings(section = 'appearance') {
  const info = await invoke('get-storage-info');
  const s = state.settings;

  const sections = {
    appearance: () => `
      <h2>Appearance</h2>
      <p class="sub">Choose how Inspiration looks on this Mac.</p>
      <div class="eyebrow">Theme</div>
      <div class="theme-cards" role="radiogroup" aria-label="Theme">
        ${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([id, label]) => `
          <button class="theme-card" role="radio" aria-checked="${s.theme === id}" data-theme="${id}">
            <span class="theme-preview">
              ${id !== 'dark' ? '<span class="tp-light"><b>Aa</b><i style="width:70%"></i><i style="width:45%"></i></span>' : ''}
              ${id !== 'light' ? '<span class="tp-dark"><b>Aa</b><i style="width:70%"></i><i style="width:45%"></i></span>' : ''}
            </span>
            <span class="theme-label"><span class="radio"></span>${label}</span>
          </button>`).join('')}
      </div>
      <div class="set-row">
        <span><b>Accent color</b><small>Used for selection, focus and the brand mark.</small></span>
        <span class="accents" role="radiogroup" aria-label="Accent color">
          ${ACCENTS.map(a => `<button role="radio" aria-checked="${s.accent === a.id}" aria-label="${a.id}" data-accent="${a.id}" style="background:${darkQuery.matches ? a.dark : a.light}"></button>`).join('')}
        </span>
      </div>
      <div class="set-row">
        <span><b>Grid density</b><small>How many images fit in a row.</small></span>
        <span class="segmented" role="radiogroup" aria-label="Grid density">
          ${['compact', 'comfortable', 'spacious'].map(d => `<button role="radio" aria-checked="${s.density === d}" data-density="${d}">${d.charAt(0).toUpperCase() + d.slice(1)}</button>`).join('')}
        </span>
      </div>
      <div class="set-row">
        <span><b>Show captions</b><small>Title and source under each image.</small></span>
        <button class="switch" role="switch" aria-checked="${s.captions !== false}" aria-label="Show captions" data-captions></button>
      </div>
    `,
    storage: () => `
      <h2>Storage</h2>
      <p class="sub">Everything lives in one folder on this Mac: a small database plus your images, organized by collection.</p>
      <div class="eyebrow">Location</div>
      <div class="path-box">${esc(info.storagePath)}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" data-storage="open">Show in Finder</button>
        <button class="btn btn-ink" data-storage="change">Change location…</button>
      </div>
    `,
    shortcuts: () => `
      <h2>Shortcuts</h2>
      <p class="sub">Keep your hands on the keyboard.</p>
      <div class="shortcut-list">
        ${[['Add a link', '⌘ K'], ['Paste image or link', '⌘ V'], ['Search', '⌘ F'], ['New collection', '⌘ N'], ['Settings', '⌘ ,'], ['Previous / next item', '← →'], ['Close', 'esc']]
          .map(([k, v]) => `<div><span>${k}</span><span class="kbd">${kbdKeys(v)}</span></div>`).join('')}
      </div>
    `,
    about: () => `
      <h2>About</h2>
      <p class="sub">Inspiration ${esc(s.version || '')} — a quiet place to keep the things that move you. Everything stays on your Mac.</p>
    `
  };

  const navItem = (id, label) => `<button class="nav-item${id === section ? ' active' : ''}" data-section="${id}"><span>${label}</span></button>`;
  const modal = openModal(`
    <div class="dialog settings" role="dialog" aria-label="Settings">
      <nav class="settings-nav">
        <div class="serif">Settings</div>
        ${navItem('appearance', 'Appearance')}
        ${navItem('storage', 'Storage')}
        ${navItem('shortcuts', 'Shortcuts')}
        ${navItem('about', 'About')}
        <div class="mono version">VERSION ${esc(s.version || '')}</div>
      </nav>
      <div class="settings-content">
        <button class="icon-btn settings-close" data-close aria-label="Close settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
        <div data-content>${sections[section]()}</div>
      </div>
    </div>
  `, { center: true });

  const render = () => {
    modal.querySelector('[data-content]').innerHTML = sections[section]();
    modal.querySelectorAll('[data-section]').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  };

  modal.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return closeModal(modal);
    const sec = t.closest('[data-section]');
    if (sec) { section = sec.dataset.section; render(); return; }
    const theme = t.closest('[data-theme]');
    if (theme) { await setSetting('theme', theme.dataset.theme); render(); return; }
    const accent = t.closest('[data-accent]');
    if (accent && accent.closest('.accents')) { await setSetting('accent', accent.dataset.accent); render(); return; }
    const density = t.closest('[data-density]');
    if (density && density.closest('.segmented')) { await setSetting('density', density.dataset.density); render(); return; }
    if (t.closest('[data-captions]')) { await setSetting('captions', state.settings.captions === false); render(); return; }
    const storage = t.closest('[data-storage]');
    if (storage?.dataset.storage === 'open') invoke('open-storage-folder');
    if (storage?.dataset.storage === 'change') {
      const r = await invoke('choose-storage-location');
      if (r.success) {
        await refreshStorage();
        await loadCollections();
        await refresh();
        render();
      }
    }
  });
}

async function refreshStorage() {
  const info = await invoke('get-storage-info');
  const parts = String(info.storagePath || '').split('/').filter(Boolean);
  $('storagePath').textContent = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : info.storagePath;
  $('storageBtn').title = `${info.storagePath} — show in Finder`;
}

// ---------- Drag and drop ----------

function setupDragAndDrop() {
  let depth = 0;
  const overlay = $('dropOverlay');
  const isExternal = (e) => {
    const types = Array.from(e.dataTransfer?.types || []);
    if (types.includes('application/x-inspiration-item')) return false;
    return types.includes('Files') || types.includes('text/uri-list');
  };

  document.addEventListener('dragenter', (e) => {
    if (!isExternal(e) || modalStack.length) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  document.addEventListener('dragleave', (e) => {
    if (!isExternal(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (!isExternal(e) || modalStack.length) return;

    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|avif|tiff?)$/i.test(f.name));
    if (files.length) {
      const paths = [];
      for (const file of files) {
        const p = bridge.getFilePath(file);
        if (p) {
          paths.push(p);
        } else {
          const buffer = new Uint8Array(await file.arrayBuffer());
          const r = await invoke('read-dropped-file', { name: file.name, buffer });
          if (r.success) paths.push(r.path);
        }
      }
      openAddImages(paths);
      return;
    }
    const uri = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
    if (looksLikeUrl(uri)) openAddLink(uri);
  });

  // Drag a card onto a collection in the sidebar to move it
  $('grid').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const item = state.items[Number(card.dataset.index)];
    e.dataTransfer.setData('application/x-inspiration-item', String(item.id));
    e.dataTransfer.effectAllowed = 'move';
  });
  $('collectionsList').addEventListener('dragover', (e) => {
    const target = e.target.closest('[data-collection-drop]');
    if (!target || !Array.from(e.dataTransfer.types).includes('application/x-inspiration-item')) return;
    e.preventDefault();
    document.querySelectorAll('.drop-target').forEach(el => el !== target && el.classList.remove('drop-target'));
    target.classList.add('drop-target');
  });
  $('collectionsList').addEventListener('dragleave', (e) => {
    const target = e.target.closest('[data-collection-drop]');
    if (target && !target.contains(e.relatedTarget)) target.classList.remove('drop-target');
  });
  $('collectionsList').addEventListener('drop', (e) => {
    const target = e.target.closest('[data-collection-drop]');
    const id = Number(e.dataTransfer.getData('application/x-inspiration-item'));
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (target && id) {
      e.preventDefault();
      e.stopPropagation();
      moveItem(id, Number(target.dataset.collectionDrop));
    }
  });
}

// ---------- Event wiring ----------

function cardMenu(index, x, y) {
  const item = state.items[index];
  const entries = [
    { label: 'Open', action: () => openDetail(index) },
    { label: item.is_favorite ? 'Remove from favorites' : 'Add to favorites', action: () => toggleFavorite(item.id) }
  ];
  if (item.source_url) entries.push({ label: 'Open source link', action: () => invoke('open-url', item.source_url) });
  entries.push(
    { label: 'Copy image', action: async () => { if (await invoke('copy-image', item.file_path)) toast('Image copied'); } },
    'sep',
    {
      label: 'Delete…', danger: true, action: async () => {
        const ok = await confirmDialog({ title: 'Delete this item?', message: `“${item.title || 'Untitled'}” and its image file will be removed. This can't be undone.` });
        if (!ok) return;
        await invoke('delete-item', item.id);
        toast('Deleted');
        await refresh();
      }
    }
  );
  showMenu(x, y, entries);
}

function setupEvents() {
  // Sidebar navigation
  document.querySelector('.sidebar').addEventListener('click', (e) => {
    const more = e.target.closest('[data-collection-menu]');
    if (more) {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      collectionMenu(Number(more.dataset.collectionMenu), r.left, r.bottom + 4);
      return;
    }
    const nav = e.target.closest('[data-view]');
    if (nav) {
      const v = nav.dataset.view;
      setView(/^\d+$/.test(v) ? Number(v) : v);
    }
  });
  $('collectionsList').addEventListener('contextmenu', (e) => {
    const nav = e.target.closest('[data-view]');
    if (!nav) return;
    e.preventDefault();
    collectionMenu(Number(nav.dataset.view), e.clientX, e.clientY);
  });
  $('newCollectionBtn').addEventListener('click', newCollection);
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('storageBtn').addEventListener('click', () => invoke('open-storage-folder'));

  // Filter and search
  const onTypeClick = (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    state.type = b.dataset.type;
    $('mainContent').scrollTop = 0;
    loadItems(true);
  };
  $('typeFilter').addEventListener('click', onTypeClick);
  $('miniTypeFilter').addEventListener('click', onTypeClick);
  $('miniSearch').addEventListener('click', focusSearch);

  // Tags: collapse the sidebar section, sort and filter the All tags page
  $('tagsToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    tagsCollapsed = !tagsCollapsed;
    try { localStorage.setItem('tagsCollapsed', tagsCollapsed ? '1' : '0'); } catch (err) {}
    renderTagsNav();
  });
  $('tagSort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.tagSort = b.dataset.sort;
    renderTagsPage();
  });
  $('tagFilter').addEventListener('input', () => {
    state.tagFilter = $('tagFilter').value;
    renderTagsPage();
  });

  // Compact header once the big title is out of view (under the 52px strip)
  new IntersectionObserver(([entry]) => {
    const scrolled = !entry.isIntersecting;
    $('mainContent').classList.toggle('is-scrolled', scrolled);
    $('miniBar').inert = !scrolled;
  }, { root: $('mainContent'), rootMargin: '-52px 0px 0px 0px' }).observe($('collectionTitle'));
  const runSearch = debounce(() => {
    state.query = $('search').value.trim();
    renderSidebar();
    loadItems(true);
  }, 220);
  $('search').addEventListener('input', runSearch);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('search').value) {
      e.stopPropagation();
      $('search').value = '';
      runSearch();
    }
  });

  // Grid
  $('grid').addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      toggleFavorite(Number(fav.dataset.fav));
      return;
    }
    if (e.target.closest('[data-empty="pick"]')) {
      pickImages();
      return;
    }
    const tagRow = e.target.closest('.tag-row');
    if (tagRow) {
      setView(tagRow.dataset.view);
      return;
    }
    const card = e.target.closest('.card');
    if (card) openDetail(Number(card.dataset.index));
  });
  $('grid').addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (card && e.key === 'Enter') openDetail(Number(card.dataset.index));
  });
  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    cardMenu(Number(card.dataset.index), e.clientX, e.clientY);
  });

  // Infinite scroll
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreIfNeeded();
  }, { root: $('mainContent'), rootMargin: '800px' }).observe($('loadMore'));

  // Command bar
  $('commandBar').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('quickInput').value.trim();
    $('quickInput').value = '';
    $('quickInput').blur();
    if (text) openAddLink(text);
    else pickImages();
  });
  $('pickImagesBtn').addEventListener('click', pickImages);

  // Paste anywhere (outside text fields)
  document.addEventListener('paste', async (e) => {
    if (isTyping(e.target) || modalStack.length || !$('detail').hidden) return;
    e.preventDefault();
    const added = await addFromClipboard();
    if (!added) toast('Copy an image or a link first');
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape') {
      if (openMenu) return closeMenu();
      if (modalStack.length) return closeModal();
      if (!$('detail').hidden) return closeDetail();
      if (document.activeElement === $('quickInput')) return $('quickInput').blur();
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!modalStack.length) openAddLink();
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!$('detail').hidden) closeDetail();
      focusSearch();
      return;
    }
    if (mod && e.key === ',') {
      e.preventDefault();
      if (!modalStack.length) openSettings();
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (!modalStack.length) newCollection();
      return;
    }
    if (!$('detail').hidden && !modalStack.length && !isTyping(e.target)) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); stepDetail(-1); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); stepDetail(1); }
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  });
  window.addEventListener('blur', closeMenu);

  // Keep the masonry column count in step with the window width
  new ResizeObserver(debounce(relayoutIfNeeded, 120)).observe($('grid'));

  // Re-tint collection colors when the theme switches
  darkQuery.addEventListener('change', () => {
    renderSidebar();
    if (state.items.length === 0) renderEmpty();
  });
}

// ---------- Setup screen (first run, or library folder missing) ----------

function tildePath(p) {
  return String(p || '').replace(/^\/Users\/[^/]+/, '~');
}

function runSetup(startup) {
  return new Promise(resolve => {
    let view = startup.status === 'missing' ? 'missing' : 'welcome';
    let choice = 'documents';
    let busy = false;

    const el = document.createElement('section');
    el.className = 'setup';
    el.setAttribute('aria-label', 'Set up your library');
    document.body.appendChild(el);
    document.body.classList.add('overlay-open');

    const art = `
      <div class="setup-art" aria-hidden="true">
        <div class="setup-brand">Inspiration<span class="brand-dot">.</span></div>
        <div class="setup-prints">
          <span class="print p1"><b>84</b></span>
          <span class="print p2"><i>Ag</i></span>
          <span class="print p3"></span>
          <span class="print p4"></span>
          <span class="print p5"></span>
        </div>
        <div class="mono setup-caption">A QUIET PLACE FOR THE THINGS THAT MOVE YOU</div>
      </div>`;

    const option = (id, title, desc, extra = '') => `
      <button class="setup-option" role="radio" aria-checked="${choice === id}" data-choice="${id}">
        <span class="radio"></span>
        <span class="setup-option-text">
          <span class="setup-option-title">${title}${extra}</span>
          <span class="setup-option-desc">${desc}</span>
        </span>
      </button>`;

    const views = {
      welcome: () => `
        <div class="eyebrow">Welcome</div>
        <h1 class="setup-title">Where should your <em>inspiration</em> live?</h1>
        <p class="setup-sub">Images, links and notes are kept together in one folder on this Mac. You can move it any time in Settings.</p>
        <div class="setup-options" role="radiogroup" aria-label="Library location">
          ${option('documents', 'In Documents', `<span class="mono">${esc(tildePath(startup.documentsPath))}</span> — easy to find in Finder and backed up by Time Machine.`, '<span class="badge">Recommended</span>')}
          ${option('choose', 'Choose a folder…', 'Any folder you like: an external drive, Dropbox, or a library you already have.')}
          ${option('default', 'Inside the app', 'Tucked away in ~/Library. Simplest, but harder to find and back up.')}
        </div>
        <div class="setup-error" data-error hidden></div>
        <div class="setup-actions">
          <button class="btn btn-ink btn-lg" data-act="continue">Continue</button>
        </div>`,
      missing: () => `
        <div class="eyebrow">Library not found</div>
        <h1 class="setup-title">Your library <em>isn't where we left it.</em></h1>
        <p class="setup-sub">It may be on a drive that isn't connected, or the folder was moved or renamed. Nothing has been deleted.</p>
        <div class="path-box">${esc(tildePath(startup.savedPath))}</div>
        <div class="setup-error" data-error hidden></div>
        <div class="setup-actions">
          <button class="btn btn-ink btn-lg" data-act="retry">Try again</button>
          <button class="btn btn-outline btn-lg" data-act="locate">Locate folder…</button>
          <span class="spacer"></span>
          <button class="btn btn-ghost" data-act="fresh">Start a new library</button>
        </div>`
    };

    const render = () => {
      el.innerHTML = `${art}<div class="setup-panel"><div class="drag-strip"></div><div class="setup-content">${views[view]()}</div></div>`;
      el.querySelector('.setup-content button')?.focus();
    };

    const showError = (message) => {
      const err = el.querySelector('[data-error]');
      err.textContent = message;
      err.hidden = false;
    };

    const finish = async (mode) => {
      if (busy) return;
      busy = true;
      el.querySelectorAll('.setup-actions .btn').forEach(b => { b.disabled = true; });
      const r = await invoke('setup-storage', mode);
      busy = false;
      el.querySelectorAll('.setup-actions .btn').forEach(b => { b.disabled = false; });
      if (!r.success) {
        if (!r.canceled) showError(r.error);
        return;
      }
      el.classList.add('leaving');
      setTimeout(() => {
        el.remove();
        syncOverlayClass();
      }, 260);
      const count = `${r.items.toLocaleString()} ${r.items === 1 ? 'item' : 'items'}`;
      if (mode === 'retry') toast(`Found your library — ${count}`);
      else if (r.existing && r.items) toast(`Opened your library — ${count}`);
      else toast(`Your library is ready in ${tildePath(r.path)}`);
      resolve();
    };

    el.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-choice]');
      if (opt) {
        choice = opt.dataset.choice;
        el.querySelectorAll('[data-choice]').forEach(b => b.setAttribute('aria-checked', String(b === opt)));
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'continue') finish(choice);
      if (act === 'retry') finish('retry');
      if (act === 'locate') finish('choose');
      if (act === 'fresh') {
        view = 'welcome';
        render();
      }
    });
    el.addEventListener('dblclick', (e) => {
      const opt = e.target.closest('[data-choice]');
      if (opt) finish(opt.dataset.choice);
    });

    render();
  });
}

// ---------- Start ----------

async function init() {
  state.settings = await invoke('get-settings');
  applySettings();
  const startup = await invoke('get-startup-state');
  if (startup.status !== 'ok') {
    await runSetup(startup);
  }
  setupEvents();
  setupDetail();
  setupDragAndDrop();
  await Promise.all([loadCollections(), refreshStorage()]);
  await refreshCounts();
  renderSidebar();
  await loadItems(true);
}

init();
