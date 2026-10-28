// The library UI. Plain DOM, one state object, re-rendered on every change. The
// only way out of this file is `window.library`, the preload bridge (or the mock
// in scripts/serve-renderer.js when developing the page in a browser).

const api = window.library;

const KIND_LABELS = { web: 'Online', bundle: 'Offline copy', exe: 'Desktop app', mirror: 'Mirror' };
const PLATFORM_LABELS = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const CATEGORY_LABELS = {
  'ai-3d': 'AI to 3D',
  boxes: 'Boxes',
  cad: 'CAD',
  codes: 'QR & NFC codes',
  'cookie-cutters': 'Cookie cutters',
  customizers: 'Customizers',
  gifts: 'Gifts',
  'image-relief': 'Image to relief',
  keychains: 'Keychains',
  lithophanes: 'Lithophanes',
  'maps-terrain': 'Maps & terrain',
  mechanical: 'Mechanical parts',
  'puzzles-games': 'Puzzles & games',
  'signs-text': 'Signs & text',
  storage: 'Storage',
  'vases-lamps': 'Vases & lamps',
};
const PROCESS_LABELS = { '3d-print': '3D print', laser: 'Laser', cnc: 'CNC', tool: 'Tool' };
const PRICING_LABELS = { free: 'Free', freemium: 'Free, paid extras', paid: 'Paid' };
const SOURCE_LABELS = { 'open-source': 'Open source', makerworld: 'On MakerWorld', skipthecad: 'From SkipTheCAD', yours: 'Added by you' };
const SIGNUP_LABELS = { 'no-account': 'No account needed', account: 'Account needed' };

const state = {
  data: null, // last snapshot from main
  query: '',
  show: 'all',
  filters: {}, // facet key -> Set of chosen values (FACETS below)
  base: [], // ids matching the search and Show, before the filter panel
  results: [],
  openFacets: null, // facet keys whose section is expanded
  moreFacets: new Set(), // facet keys showing every value, not just the first few
  tagQuery: '',
  collection: '', // the collection shown, or '' for all
  editingCollection: null, // 'new', a collection id being renamed, or null
  found: null, // what Add project looked up, waiting to be added
  updates: new Map(), // `${id}/${distKey}` -> result
  jobs: [], // newest first, from main (jobs.js)
  seenJobs: new Set(), // finished job ids the user has looked at in the jobs panel
  busy: new Set(),
  detailId: null,
  versions: new Map(), // `${id}/${distKey}` -> { loading, list, error } while its version list is open
};

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

async function call(name, payload) {
  const res = await api[name](payload);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

function recordKey(id, distKey) {
  return `${id}/${distKey}`;
}

function installedRecords(id) {
  return Object.values(state.data?.installed ?? {}).filter((r) => r.id === id);
}

function hasUpdate(id) {
  return [...state.updates.values()].some((u) => u.id === id && u.hasUpdate);
}

// A mirror is a copy of a site at one moment, and nothing says when the site
// changed, so after Settings' "Remind me to mirror again" days it is flagged.
function mirrorAgeDays(record) {
  const saved = Date.parse(record?.installedAt ?? '');
  return Number.isFinite(saved) ? Math.floor((Date.now() - saved) / 86400000) : null;
}

function resyncDue(record) {
  const days = Number(state.data?.settings?.resyncDays ?? 30);
  const age = record?.source?.type === 'mirror' ? mirrorAgeDays(record) : null;
  return days > 0 && age !== null && age >= days;
}

function needsResync(id) {
  return installedRecords(id).some(resyncDue);
}

// The newest job for one distribution, so its row can show progress or the error.
function jobFor(id, distKey) {
  return state.jobs.find((j) => j.target?.id === id && j.target?.distKey === distKey) ?? null;
}

function progressBar(job) {
  return job.total ? el('div', { class: 'progress' }, el('div', { style: `width:${Math.round((100 * job.received) / job.total)}%` })) : el('div', { class: 'progress is-indeterminate' }, el('div', {}));
}

function generatorById(id) {
  return state.data?.generators.find((g) => g.id === id) ?? null;
}

function setStatus(message, tone = '') {
  const box = $('status');
  if (!message) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = message;
  box.className = `status ${tone ? `is-${tone}` : ''}`;
}

// ───────────────────────────── search & filters ─────────────────────────────

async function runSearch() {
  if (!state.data) return;
  let ids = await call('search', { query: state.query, filters: {} });
  const installedIds = new Set(Object.values(state.data.installed).map((r) => r.id));
  if (state.show === 'installed') ids = ids.filter((id) => installedIds.has(id));
  if (state.show === 'updates') ids = ids.filter((id) => hasUpdate(id) || needsResync(id));
  if (state.show === 'favorites') ids = ids.filter((id) => state.data.favorites.includes(id));
  if (state.show === 'recent') ids = state.data.recent.filter((id) => ids.includes(id));
  const shown = collectionById(state.collection);
  if (state.collection && !shown) state.collection = '';
  if (shown) ids = ids.filter((id) => shown.ids.includes(id));
  const hidden = new Set(state.data.hidden ?? []);
  ids = state.show === 'hidden' ? ids.filter((id) => hidden.has(id)) : ids.filter((id) => !hidden.has(id));
  state.base = ids;
  state.results = ids.filter((id) => matchesFilters(generatorById(id)));
  renderFilters();
  renderGrid();
}

// Online: opens in a browser window. Works offline: has a way to run without
// the internet (offline copy, desktop app or mirror) on this computer. Ready
// offline: one of those is installed.
const AVAILABILITY = [
  ['online', 'Online'],
  ['offline', 'Works offline'],
  ['ready', 'Ready offline'],
];

function matchesAvailability(g, value) {
  if (!g) return false;
  if (value === 'online') return g.distributions.some((d) => d.kind === 'web');
  const offline = g.distributions.filter((d) => d.kind !== 'web' && g.usable.includes(d.key));
  if (value === 'offline') return offline.length > 0;
  return offline.some((d) => state.data.installed[recordKey(g.id, d.key)]);
}

const titleCase = (v) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

// The filter panel. Within a section any ticked value matches; across sections
// all must. `order` fixes the listing order, otherwise the most common come
// first; `limit` values show before "Show more".
const FACETS = [
  { key: 'category', title: 'Category', values: (g) => (g.category ? [g.category] : []), label: (v) => CATEGORY_LABELS[v] ?? titleCase(v), alpha: true },
  { key: 'availability', title: 'Availability', values: (g) => AVAILABILITY.filter(([v]) => matchesAvailability(g, v)).map(([v]) => v), label: (v) => Object.fromEntries(AVAILABILITY)[v], order: AVAILABILITY.map(([v]) => v) },
  { key: 'kind', title: 'Runs as', values: (g) => [...new Set(g.distributions.map((d) => d.kind))], label: (v) => KIND_LABELS[v] ?? v, order: Object.keys(KIND_LABELS) },
  { key: 'pricing', title: 'Price', values: (g) => (g.pricing ? [g.pricing] : []), label: (v) => PRICING_LABELS[v] ?? v, order: Object.keys(PRICING_LABELS) },
  { key: 'signup', title: 'Sign-up', values: (g) => [g.account ? 'account' : 'no-account'], label: (v) => SIGNUP_LABELS[v], order: Object.keys(SIGNUP_LABELS) },
  { key: 'process', title: 'Process', values: (g) => (g.process ? [g.process] : []), label: (v) => PROCESS_LABELS[v] ?? v },
  { key: 'source', title: 'Source', values: (g) => [g.openSource && 'open-source', (g.tags.includes('makerworld') || g.distributions.some((d) => /makerworld\.com/.test(d.url ?? ''))) && 'makerworld', /skipthecad\.com/.test(g.listing ?? '') && 'skipthecad', g.origin === 'yours' && 'yours'].filter(Boolean), label: (v) => SOURCE_LABELS[v], order: Object.keys(SOURCE_LABELS) },
  { key: 'exports', title: 'Exports', values: (g) => g.exports ?? [], label: (v) => v.toUpperCase(), limit: 8 },
  { key: 'tags', title: 'Tags', values: (g) => g.tags, label: (v) => v, limit: 14, searchable: true },
];
const DEFAULT_OPEN = ['category', 'availability', 'kind', 'pricing', 'tags'];

for (const f of FACETS) state.filters[f.key] = new Set();

function matchesFilters(g, skip = '') {
  if (!g) return false;
  for (const f of FACETS) {
    const chosen = state.filters[f.key];
    if (f.key === skip || !chosen.size) continue;
    if (!f.values(g).some((v) => chosen.has(v))) return false;
  }
  return true;
}

function activeFilterCount() {
  return FACETS.reduce((n, f) => n + state.filters[f.key].size, 0);
}

function loadOpenFacets() {
  try {
    const saved = JSON.parse(localStorage.getItem('openFacets') ?? 'null');
    if (Array.isArray(saved)) return new Set(saved);
  } catch {
    /* storage unavailable */
  }
  return new Set(DEFAULT_OPEN);
}

function saveOpenFacets() {
  try {
    localStorage.setItem('openFacets', JSON.stringify([...state.openFacets]));
  } catch {
    /* storage unavailable */
  }
}

function setFilter(key, value, on) {
  if (on) state.filters[key].add(value);
  else state.filters[key].delete(value);
  runSearch();
}

function clearFilters() {
  for (const f of FACETS) state.filters[f.key].clear();
  state.tagQuery = '';
  runSearch();
}

// Counts are for what the search and the other sections leave, so each number
// is how many results ticking that value would give.
function renderFilters() {
  state.openFacets ??= loadOpenFacets();
  const base = state.base.map(generatorById).filter(Boolean);
  const box = $('filters');
  const focused = document.activeElement?.dataset?.facetSearch;
  const sections = FACETS.map((f) => {
    const counts = new Map();
    for (const g of base) if (matchesFilters(g, f.key)) for (const v of new Set(f.values(g))) counts.set(v, (counts.get(v) ?? 0) + 1);
    const chosen = state.filters[f.key];
    for (const v of chosen) if (!counts.has(v)) counts.set(v, 0);
    let values = [...counts.keys()];
    if (f.order) values.sort((a, b) => (f.order.indexOf(a) + 1 || 99) - (f.order.indexOf(b) + 1 || 99));
    else if (f.alpha) values.sort((a, b) => f.label(a).localeCompare(f.label(b)));
    else values.sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
    if (!values.length) return null;
    const query = f.searchable ? state.tagQuery.trim().toLowerCase() : '';
    if (query) values = values.filter((v) => v.includes(query));
    const all = state.moreFacets.has(f.key) || query;
    const shown = all || !f.limit ? values : [...values.filter((v) => chosen.has(v)), ...values.filter((v) => !chosen.has(v))].slice(0, Math.max(f.limit, chosen.size));
    const open = state.openFacets.has(f.key);
    return el(
      'details',
      {
        class: 'filter',
        open,
        ontoggle: (e) => {
          if (e.target.open) state.openFacets.add(f.key);
          else state.openFacets.delete(f.key);
          saveOpenFacets();
        },
      },
      el('summary', {}, el('span', {}, f.title), chosen.size ? el('span', { class: 'filter-count' }, chosen.size) : null),
      f.searchable
        ? el('input', {
            class: 'filter-search',
            type: 'search',
            placeholder: 'Find a tag…',
            value: state.tagQuery,
            dataset: { facetSearch: f.key },
            oninput: (e) => {
              state.tagQuery = e.target.value;
              renderFilters();
            },
          })
        : null,
      el(
        'ul',
        { class: 'filter-list' },
        shown.map((v) =>
          el(
            'li',
            {},
            el(
              'label',
              { class: `filter-option ${counts.get(v) ? '' : 'is-empty'}` },
              el('input', { type: 'checkbox', checked: chosen.has(v), onchange: (e) => setFilter(f.key, v, e.target.checked) }),
              el('span', { class: 'filter-label' }, f.label(v)),
              el('small', {}, counts.get(v)),
            ),
          ),
        ),
      ),
      f.limit && !query && values.length > f.limit
        ? el(
            'button',
            {
              class: 'link muted filter-more',
              type: 'button',
              onclick: () => {
                if (state.moreFacets.has(f.key)) state.moreFacets.delete(f.key);
                else state.moreFacets.add(f.key);
                renderFilters();
              },
            },
            state.moreFacets.has(f.key) ? 'Show fewer' : `Show all ${values.length}`,
          )
        : null,
    );
  });
  box.replaceChildren(...sections.filter(Boolean));
  if (focused) {
    const input = box.querySelector(`[data-facet-search="${focused}"]`);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
  const active = activeFilterCount();
  $('clear-filters').hidden = active === 0;
  $('clear-filters').textContent = `Clear ${active} filter${active === 1 ? '' : 's'}`;
}

// ─────────────────────────────── collections ───────────────────────────────

function collectionById(id) {
  return id ? (state.data?.collections ?? []).find((c) => c.id === id) ?? null : null;
}

async function editCollection(op) {
  try {
    state.data = await call('editCollection', op);
  } catch (error) {
    setStatus(error.message, 'error');
    return false;
  }
  renderFacets();
  await runSearch();
  if ($('detail').open) renderDetail();
  return true;
}

// A name box for a new collection or a rename: Enter saves, Escape cancels.
function nameInput(value, onSave, onCancel) {
  // Saving re-renders, which removes the box and fires blur; act only once.
  let done = false;
  const finish = (fn, ...args) => {
    if (done) return;
    done = true;
    fn(...args);
  };
  const input = el('input', {
    class: 'collection-input',
    type: 'text',
    value,
    maxlength: '60',
    placeholder: 'Collection name',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.target.value.trim()) finish(onSave, e.target.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(onCancel);
      }
    },
    onblur: (e) => (e.target.value.trim() && e.target.value.trim() !== value ? finish(onSave, e.target.value.trim()) : finish(onCancel)),
  });
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function renderCollections() {
  const list = state.data.collections ?? [];
  const known = new Set(state.data.generators.map((g) => g.id));
  const stopEditing = () => {
    state.editingCollection = null;
    renderCollections();
  };
  const rows = list.map((c) => {
    if (state.editingCollection === c.id) {
      return el('li', {}, nameInput(c.name, (name) => {
        state.editingCollection = null;
        editCollection({ type: 'rename', collection: c.id, name });
      }, stopEditing));
    }
    const active = state.collection === c.id;
    return el(
      'li',
      { class: `collection ${active ? 'is-active' : ''}` },
      el(
        'button',
        {
          class: 'collection-name',
          type: 'button',
          'aria-pressed': String(active),
          onclick: () => {
            state.collection = active ? '' : c.id;
            renderCollections();
            runSearch();
          },
        },
        el('span', {}, c.name),
        el('small', {}, c.ids.filter((id) => known.has(id)).length),
      ),
      el('button', { class: 'collection-action', type: 'button', title: 'Rename', 'aria-label': `Rename ${c.name}`, onclick: () => ((state.editingCollection = c.id), renderCollections()) }, '✎'),
      el(
        'button',
        {
          class: 'collection-action',
          type: 'button',
          title: 'Delete',
          'aria-label': `Delete ${c.name}`,
          onclick: () => {
            if (!window.confirm(`Delete the collection "${c.name}"? The generators in it stay in the library.`)) return;
            if (state.collection === c.id) state.collection = '';
            editCollection({ type: 'delete', collection: c.id });
          },
        },
        '×',
      ),
    );
  });
  if (state.editingCollection === 'new') {
    rows.push(el('li', {}, nameInput('', (name) => {
      state.editingCollection = null;
      editCollection({ type: 'create', name });
    }, stopEditing)));
  } else if (!list.length) {
    rows.push(el('li', { class: 'muted hint' }, 'Group generators your own way: make a collection, then add generators from their page.'));
  }
  $('collections').replaceChildren(...rows);
}

function renderFacets() {
  renderCollections();
  for (const button of $('show-chips').querySelectorAll('.chip')) {
    button.classList.toggle('is-active', button.dataset.show === state.show);
    if (button.dataset.show === 'favorites') {
      const n = state.data.favorites.filter((id) => generatorById(id)).length;
      button.replaceChildren('Favorites', n ? el('small', {}, n) : '');
    }
  }
  $('catalog-source').textContent = `${state.data.generators.length} generators · catalog from ${state.data.catalogSource}`;
  const problems = $('show-problems');
  problems.hidden = state.data.problems.length === 0;
  problems.textContent = `${state.data.problems.length} catalog note${state.data.problems.length === 1 ? '' : 's'}`;
}

// ───────────────────────────────── cards ─────────────────────────────────

function iconFor(g) {
  if (g.icon && /^https?:\/\//.test(g.icon)) return el('img', { src: g.icon, alt: '' });
  if (g.icon && g.repo) return el('img', { src: `https://raw.githubusercontent.com/${g.repo}/HEAD/${g.icon.replace(/^\/+/, '')}`, alt: '' });
  return (g.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
}

function renderCard(g) {
  const installed = installedRecords(g.id);
  const update = hasUpdate(g.id);
  const fav = state.data.favorites.includes(g.id);
  const kinds = [...new Set(g.distributions.map((d) => d.kind))];
  const card = el(
    'article',
    { class: 'card', tabindex: '0', role: 'button', onclick: () => openDetail(g.id), onkeydown: (e) => e.key === 'Enter' && openDetail(g.id) },
    el(
      'div',
      { class: 'card-head' },
      el('div', { class: 'card-icon' }, iconFor(g)),
      el('div', {}, el('div', { class: 'card-title' }, g.name), el('div', { class: 'card-sub' }, [g.collection?.name, g.repo].filter(Boolean).join(' · '))),
    ),
    el('p', { class: 'card-summary' }, g.summary || g.description || ''),
    el('div', { class: 'tags' }, g.tags.slice(0, 5).map((t) => el('span', { class: 'tag' }, t))),
    el(
      'div',
      { class: 'card-foot' },
      kinds.map((k) => el('span', { class: 'badge badge-kind' }, KIND_LABELS[k] ?? k)),
      installed.length ? el('span', { class: 'badge badge-installed' }, 'Installed') : null,
      update ? el('span', { class: 'badge badge-update' }, 'Update') : null,
      needsResync(g.id) ? el('span', { class: 'badge badge-resync', title: 'This offline copy is old; the site may have changed since' }, 'Resync') : null,
      g.pricing && g.pricing !== 'free' ? el('span', { class: 'badge badge-price' }, PRICING_LABELS[g.pricing]) : null,
      g.account ? el('span', { class: 'badge badge-kind', title: 'Downloading needs an account on the site' }, 'Sign-up') : null,
    ),
    el(
      'button',
      {
        class: `fav ${fav ? 'is-on' : ''}`,
        type: 'button',
        title: fav ? 'Remove from favorites' : 'Add to favorites',
        'aria-label': fav ? 'Remove from favorites' : 'Add to favorites',
        'aria-pressed': String(fav),
        onclick: (e) => {
          e.stopPropagation();
          setFavorite(g.id, !fav);
        },
      },
      fav ? '★' : '☆',
    ),
  );
  return card;
}

async function setFavorite(id, favorite) {
  try {
    state.data = await call('setFavorite', { id, favorite });
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  renderFacets();
  await runSearch();
  if ($('detail').open) renderDetail();
}

function renderGrid() {
  const grid = $('grid');
  const items = state.results.map(generatorById).filter(Boolean);
  grid.replaceChildren(...items.map(renderCard));
  $('empty').hidden = items.length > 0;
  $('result-count').textContent = items.length ? `${items.length} generator${items.length === 1 ? '' : 's'}` : '';
}

// ───────────────────────────────── detail ─────────────────────────────────

function distKeyOf(d) {
  return d.key;
}

function renderDistribution(g, d) {
  const key = distKeyOf(d);
  const rk = recordKey(g.id, key);
  const record = state.data.installed[rk] ?? null;
  const usable = g.usable.includes(key);
  const job = jobFor(g.id, key);
  const update = state.updates.get(rk);
  const busy = state.busy.has(rk);
  const title = `${KIND_LABELS[d.kind] ?? d.kind}${d.platform ? ` · ${PLATFORM_LABELS[d.platform]}` : ''}`;
  const metaParts = [];
  if (d.url) metaParts.push(d.url);
  if (d.from?.type === 'release') metaParts.push(`GitHub release ${d.from.tag === 'latest' ? '(latest)' : d.from.tag} · ${d.from.asset}${d.from.repo ? ` from ${d.from.repo}` : ''}`);
  if (d.from?.type === 'page') metaParts.push(`Newest ${d.from.asset} linked from ${d.from.url}`);
  if (d.from?.type === 'repo') metaParts.push(`Repository files${d.from.path ? ` under ${d.from.path}/` : ''}${d.from.ref ? ` at ${d.from.ref}` : ''}${d.from.repo ? ` from ${d.from.repo}` : ''}`);
  const kept = state.data.kept?.[rk] ?? [];
  if (record && record.source?.type !== 'mirror') metaParts.push(`Installed ${record.version}${record.pinned ? ' (chosen version)' : ''}${record.sizeBytes ? ` · ${(record.sizeBytes / 1048576).toFixed(1)} MB` : ''}${kept.length ? ` · ${kept.length} other version${kept.length === 1 ? '' : 's'} kept` : ''}`);
  if (record?.source?.type === 'mirror') {
    const age = mirrorAgeDays(record);
    if (age !== null) metaParts.push(`Mirrored ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}${resyncDue(record) ? '; the site may have changed, mirror again to refresh it' : ''}`);
  }
  if (update?.hasUpdate) metaParts.push(`Update available: ${update.latest.version}`);
  else if (update?.newer && update.pinned) metaParts.push(`Newest is ${update.latest.version}`);
  if (update?.error) metaParts.push(`Update check failed: ${update.error}`);
  if (d.notes) metaParts.push(d.notes);
  if (!usable) metaParts.push('Not for this computer');

  const actions = [];
  const act = (label, name, { primary = false, confirm = false } = {}) =>
    el(
      'button',
      {
        class: `btn btn-small ${primary ? 'btn-primary' : ''}`,
        type: 'button',
        disabled: busy || !usable,
        onclick: async () => {
          if (confirm && !window.confirm(`${label} ${g.name}?`)) return;
          await perform(name, g, key);
        },
      },
      label,
    );
  if (d.kind === 'web') actions.push(act(d.label || 'Open online', 'openWeb', { primary: true }));
  if (d.kind === 'mirror') {
    if (record) actions.push(act('Open offline', 'launch', { primary: true }), act('Mirror again', 'mirror', { primary: resyncDue(record) }), act('Remove', 'uninstall', { confirm: true }));
    else actions.push(act(d.label || 'Mirror for offline use', 'mirror', { primary: true }));
  }
  if (d.kind === 'bundle' || d.kind === 'exe') {
    if (record) {
      actions.push(act(d.kind === 'exe' && d.install === 'installer' ? 'Run installer' : 'Launch', 'launch', { primary: true }));
      if (update?.hasUpdate || (update?.newer && update.pinned)) actions.push(act(`Update to ${update.latest.version}`, 'install'));
      actions.push(act('Folder', 'openFolder'), act('Remove', 'uninstall', { confirm: true }));
    } else {
      actions.push(act(d.label || 'Install', 'install', { primary: true }));
    }
  }
  const versioned = (d.kind === 'bundle' || d.kind === 'exe') && d.from?.type === 'release';
  if (versioned) {
    const open = state.versions.has(rk);
    actions.push(el('button', { class: `btn btn-small ${open ? 'is-on' : ''}`, type: 'button', disabled: !usable, 'aria-expanded': String(open), onclick: () => toggleVersions(g, key) }, 'Versions'));
  }

  const node = el(
    'div',
    { class: `dist ${usable ? '' : 'is-unavailable'}` },
    el(
      'div',
      { class: 'dist-info' },
      el('div', { class: 'dist-title' }, title),
      el('div', { class: 'dist-meta' }, metaParts.join(' · ')),
      job?.status === 'running' ? el('div', { class: 'dist-job' }, el('div', { class: 'dist-meta' }, job.message || job.title), progressBar(job)) : null,
      job?.status === 'failed'
        ? el('div', { class: 'dist-error' }, job.error, ' ', el('button', { class: 'link', type: 'button', onclick: () => openJobs(job.id) }, 'Show log'))
        : null,
    ),
    el('div', { class: 'dist-actions' }, actions),
  );
  return versioned && state.versions.has(rk) ? el('div', { class: 'dist-group' }, node, renderVersions(g, key)) : node;
}

// ─────────────────────────────── versions ────────────────────────────────

async function loadVersions(g, key) {
  const rk = recordKey(g.id, key);
  state.versions.set(rk, { loading: true, list: state.versions.get(rk)?.list ?? [] });
  renderDetail();
  try {
    state.versions.set(rk, { list: await call('versions', { id: g.id, distKey: key }) });
  } catch (error) {
    state.versions.set(rk, { list: [], error: error.message });
  }
  if (state.detailId === g.id) renderDetail();
}

function toggleVersions(g, key) {
  const rk = recordKey(g.id, key);
  if (state.versions.has(rk)) {
    state.versions.delete(rk);
    renderDetail();
  } else {
    loadVersions(g, key);
  }
}

function renderVersions(g, key) {
  const rk = recordKey(g.id, key);
  const { loading, list = [], error } = state.versions.get(rk) ?? {};
  const busy = state.busy.has(rk);
  // Which versions are on disk comes from the latest state, so the list stays
  // right after an install or switch without asking GitHub again.
  const active = state.data.installed[rk]?.version;
  const kept = new Set((state.data.kept?.[rk] ?? []).map((r) => r.version));
  const rows = list.map((listed) => {
    const v = { ...listed, active: listed.tag === active, kept: kept.has(listed.tag) };
    const notes = [v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : '', v.size ? `${(v.size / 1048576).toFixed(1)} MB` : '', v.prerelease ? 'pre-release' : '', v.gone ? 'no longer on GitHub' : ''].filter(Boolean);
    const buttons = [];
    if (v.active) {
      buttons.push(el('span', { class: 'badge badge-installed' }, 'Launches'));
    } else if (v.kept) {
      buttons.push(
        el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: busy, onclick: () => perform('useVersion', g, key, { version: v.tag, pin: !v.newest }) }, 'Use this version'),
        el('button', { class: 'btn btn-small', type: 'button', disabled: busy, onclick: () => window.confirm(`Delete ${v.tag} of ${g.name}?`) && perform('removeVersion', g, key, { version: v.tag }) }, 'Delete'),
      );
    } else {
      // The newest goes in unpinned, like an update; an older one is pinned so update checks leave it be.
      buttons.push(el('button', { class: 'btn btn-small', type: 'button', disabled: busy, onclick: () => perform('install', g, key, v.newest ? {} : { tag: v.tag }) }, 'Install and use'));
    }
    return el(
      'li',
      { class: `version ${v.active ? 'is-active' : ''}` },
      el('div', { class: 'version-info' }, el('span', { class: 'version-tag' }, v.tag), v.newest ? el('span', { class: 'badge' }, 'Newest') : null, v.kept ? el('span', { class: 'badge' }, 'On this computer') : null, el('div', { class: 'dist-meta' }, notes.join(' · '))),
      el('div', { class: 'dist-actions' }, buttons),
    );
  });
  const keep = state.data.settings.keepVersions;
  return el(
    'div',
    { class: 'versions' },
    el('div', { class: 'dist-meta' }, `Each version installs into its own folder and keeps the same saved data. After an update the ${keep} newest older version${keep === 1 ? ' stays' : 's stay'} on this computer (Settings).`),
    loading && !list.length ? el('div', { class: 'dist-meta' }, 'Reading releases from GitHub…') : null,
    error ? el('div', { class: 'dist-error' }, error) : null,
    !loading && !error && !list.length ? el('div', { class: 'dist-meta' }, 'No releases found.') : null,
    rows.length ? el('ul', { class: 'version-list' }, rows) : null,
  );
}

async function perform(name, g, key, extra = {}) {
  const rk = recordKey(g.id, key);
  state.busy.add(rk);
  renderDetail();
  try {
    await call(name, { id: g.id, distKey: key, ...extra });
    if (name === 'install' || name === 'useVersion') state.updates.delete(rk);
    setStatus('');
  } catch (error) {
    setStatus(`${g.name}: ${error.message}`, 'error');
  } finally {
    state.busy.delete(rk);
    await reloadState({ keepSearch: true });
  }
}

function openDetail(id) {
  state.detailId = id;
  renderDetail();
  const dialog = $('detail');
  if (!dialog.open) dialog.showModal();
}

function renderDetail() {
  const g = state.detailId ? generatorById(state.detailId) : null;
  if (!g) return;
  $('detail-name').textContent = g.name;
  $('detail-summary').textContent = [g.summary, g.version ? `v${g.version}` : '', g.license].filter(Boolean).join(' · ');
  const media = $('detail-media');
  media.replaceChildren(...g.screenshots.slice(0, 6).map((src) => el('img', { src: /^https?:/.test(src) ? src : `https://raw.githubusercontent.com/${g.repo}/HEAD/${src.replace(/^\/+/, '')}`, alt: '', loading: 'lazy' })));
  media.hidden = g.screenshots.length === 0;
  const fav = state.data.favorites.includes(g.id);
  const favButton = $('detail-fav');
  favButton.classList.toggle('is-on', fav);
  favButton.setAttribute('aria-pressed', String(fav));
  favButton.textContent = fav ? '★ Favorite' : '☆ Add to favorites';
  favButton.onclick = () => setFavorite(g.id, !fav);
  $('detail-facts').replaceChildren(
    ...[
      g.category ? CATEGORY_LABELS[g.category] ?? titleCase(g.category) : '',
      g.process ? PROCESS_LABELS[g.process] ?? g.process : '',
      g.pricing ? PRICING_LABELS[g.pricing] : '',
      g.pricing || g.listing ? (g.account ? 'Account needed to download' : 'No account needed') : '',
      g.exports?.length ? `Exports ${g.exports.map((e) => e.toUpperCase()).join(', ')}` : '',
    ]
      .filter(Boolean)
      .map((text) => el('span', {}, text)),
  );
  renderTagEditor(g);
  renderDetailCollections(g);
  $('detail-description').textContent = g.description || g.summary || '';
  $('detail-dists').replaceChildren(...g.distributions.map((d) => renderDistribution(g, d)));
  const source = $('detail-source');
  // replaceChildren writes a null as the text "null", so the optional parts go through el().
  source.replaceChildren(el('span', {},
    g.repo
      ? el('button', { class: 'link', type: 'button', onclick: () => call('openExternal', { url: `https://github.com/${g.repo}` }) }, `github.com/${g.repo}`)
      : el('span', {}, g.homepage || g.source || ''),
    g.upstream ? el('span', {}, ' · fork of ', el('button', { class: 'link', type: 'button', onclick: () => call('openExternal', { url: `https://github.com/${g.upstream}` }) }, g.upstream)) : null,
    g.homepage ? el('span', {}, ' · ', el('button', { class: 'link', type: 'button', onclick: () => call('openExternal', { url: g.homepage }) }, 'homepage')) : null,
    g.listing ? el('span', {}, ' · ', el('button', { class: 'link', type: 'button', onclick: () => call('openExternal', { url: g.listing }) }, /skipthecad\.com/.test(g.listing) ? 'SkipTheCAD listing' : 'listing')) : null,
    g.manifestPath ? el('span', { class: 'muted' }, ` · ${g.manifestPath}`) : g.listing ? null : el('span', { class: 'muted' }, g.repo ? ' · described by the catalog (no generator.json in the repo yet)' : ' · added by link'),
  ));
  const hidden = (state.data.hidden ?? []).includes(g.id);
  $('detail-hide').textContent = hidden ? 'Show in library' : 'Hide from library';
  $('detail-hide').onclick = async () => {
    state.data = await call('setHidden', { id: g.id, hidden: !hidden });
    renderFacets();
    await runSearch();
    renderDetail();
  };
}

// Tags in the detail view: × removes one, the box adds one (Enter or comma),
// and "Undo my changes" goes back to the catalog's tags. Main keeps the edits.
async function saveTags(g, tags) {
  try {
    state.data = await call('setTags', { id: g.id, tags });
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  renderFacets();
  await runSearch();
  renderDetail();
  $('detail').querySelector('.tag-input')?.focus();
}

function renderTagEditor(g) {
  const allTags = [...new Set(state.data.generators.flatMap((x) => x.tags))].sort();
  const mine = new Set(g.catalogTags ? g.tags.filter((t) => !g.catalogTags.includes(t)) : []);
  const add = (input) => {
    const typed = input.value.split(',').map((t) => t.trim()).filter(Boolean);
    if (!typed.length) return;
    input.value = '';
    saveTags(g, [...g.tags, ...typed]);
  };
  $('detail-tags').replaceChildren(...[
    ...g.tags.map((t) =>
      el(
        'span',
        { class: `tag tag-edit ${mine.has(t) ? 'is-mine' : ''}`, title: mine.has(t) ? 'Your tag' : 'From the catalog' },
        t,
        el('button', { type: 'button', class: 'tag-remove', 'aria-label': `Remove tag ${t}`, onclick: () => saveTags(g, g.tags.filter((x) => x !== t)) }, '×'),
      ),
    ),
    el('input', {
      class: 'tag-input',
      type: 'text',
      list: 'tag-suggestions',
      placeholder: g.tags.length ? 'Add a tag' : 'Add a tag, e.g. gridfinity',
      'aria-label': 'Add a tag',
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          add(e.target);
        }
      },
      onchange: (e) => add(e.target),
    }),
    el('datalist', { id: 'tag-suggestions' }, allTags.filter((t) => !g.tags.includes(t)).map((t) => el('option', { value: t }))),
    // replaceChildren writes a null as the text "null", hence filter(Boolean).
    g.catalogTags ? el('button', { class: 'link muted', type: 'button', onclick: () => saveTags(g, null) }, 'Undo my tag changes') : null,
  ].filter(Boolean));
}

// Which of your collections hold this generator; click one to add or take it out.
function renderDetailCollections(g) {
  const list = state.data.collections ?? [];
  const box = $('detail-collections');
  const adding = state.editingCollection === `new:${g.id}`;
  box.replaceChildren(
    el('span', { class: 'muted hint' }, 'Collections'),
    ...list.map((c) => {
      const member = c.ids.includes(g.id);
      return el(
        'button',
        { class: `chip ${member ? 'is-active' : ''}`, type: 'button', 'aria-pressed': String(member), title: member ? `Take out of ${c.name}` : `Add to ${c.name}`, onclick: () => editCollection({ type: 'set', collection: c.id, id: g.id, member: !member }) },
        member ? '✓ ' : '+ ',
        c.name,
      );
    }),
    adding
      ? nameInput('', (name) => {
          state.editingCollection = null;
          editCollection({ type: 'create', name, ids: [g.id] });
        }, () => {
          state.editingCollection = null;
          renderDetail();
        })
      : el('button', { class: 'link muted', type: 'button', onclick: () => ((state.editingCollection = `new:${g.id}`), renderDetail()) }, list.length ? 'New collection…' : 'Add to a new collection…'),
  );
}

// ──────────────────────────────── settings ────────────────────────────────

function renderSettings() {
  const form = $('settings-form');
  const s = state.data.settings;
  form.githubToken.value = s.githubToken;
  form.githubToken.placeholder = state.data.hasToken ? 'Token saved · enter a new one to replace it' : 'Needed for private repos and higher rate limits';
  form.catalogRepo.value = s.catalogRepo;
  form.pythonPath.value = s.pythonPath;
  form.webmirrorHome.value = s.webmirrorHome;
  form.checkUpdatesOnStart.checked = Boolean(s.checkUpdatesOnStart);
  form.keepVersions.value = String(s.keepVersions ?? 2);
  form.resyncDays.value = String(s.resyncDays ?? 30);
  renderRuntimes();
  renderDataLocation();
  call('webmirrorSnapshots')
    .then((snaps) => {
      const ul = $('snapshots-list');
      ul.replaceChildren(
        ...snaps.map((snap) =>
          el('li', {}, el('span', {}, snap.url, ' ', el('small', { class: 'muted' }, snap.saved_at)), el('button', { class: 'btn btn-small', type: 'button', onclick: () => call('openSnapshot', { key: snap.key }).catch((e) => setStatus(e.message, 'error')) }, 'Open')),
        ),
      );
      if (!snaps.length) ul.replaceChildren(el('li', { class: 'muted' }, 'No WebMirror snapshots found'));
    })
    .catch(() => {});
}

const LOCATION_NOTES = {
  portable: 'Beside the app, so the app and its library move together.',
  custom: 'A folder you chose.',
  legacy: "In this computer's app-data folder, from an earlier version of the library.",
  default: "In this computer's app-data folder.",
};

function renderDataLocation() {
  const loc = state.data.dataLocation;
  if (!loc) return;
  const busy = state.jobs.some((j) => j.status === 'running');
  const move = async (dir) => {
    if (!dir) return;
    if (!window.confirm(`Move the library to ${dir}?\n\nOpen app windows close, everything is copied, and the library restarts there. The old folder is deleted after the restart.`)) return;
    try {
      await call('moveData', { dir });
      setStatus('Moving the library; it restarts when the copy is done…');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  };
  $('data-location').replaceChildren(
    el('p', {}, el('code', {}, loc.dir)),
    el('p', { class: 'muted' }, LOCATION_NOTES[loc.mode] ?? ''),
    el(
      'div',
      { class: 'row row-tight' },
      el('button', { class: 'btn btn-small', type: 'button', disabled: busy, onclick: async () => move(await call('chooseDataFolder')) }, 'Move to another folder…'),
      loc.suggested ? el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: busy, onclick: () => move(loc.suggested) }, 'Move beside the app') : null,
    ),
  );
}

function renderRuntimes() {
  const { python, node } = state.data.runtimes;
  const box = $('runtimes');
  const running = state.jobs.some((j) => j.kind === 'runtime' && j.status === 'running');
  const runtimeAction = (label, name, runtime = 'python') =>
    el('button', { class: 'btn btn-small', type: 'button', disabled: running, onclick: () => call(name, { runtime }).catch((e) => setStatus(e.message, 'error')).finally(() => reloadState()) }, label);
  let line;
  if (python.configured) line = el('span', {}, 'Using your Python: ', el('code', {}, python.configured));
  else if (python.managed) line = el('span', {}, `Python ${python.managed.version}`, python.managed.packages.length ? ` with ${python.managed.packages.map((p) => p.split(/[\s@[]/)[0]).join(', ')}` : '', el('small', { class: 'muted' }, ` · ${python.managed.dir}`));
  else line = el('span', { class: 'muted' }, `Not installed. Python ${python.build} downloads automatically the first time a generator needs it.`);
  // replaceChildren writes a null as the text "null"; filter(Boolean) drops the missing Node row.
  box.replaceChildren(
    ...[el('li', {}, line, el('div', { class: 'row row-tight' }, python.configured ? null : runtimeAction(python.managed ? 'Repair' : 'Install now', 'installRuntime'), python.managed && !python.configured ? runtimeAction('Remove', 'removeRuntime') : null)),
    node
      ? el(
          'li',
          {},
          node.managed
            ? el('span', {}, `Node.js ${node.managed.version}`, el('small', { class: 'muted' }, ` · ${node.managed.dir}`))
            : el('span', { class: 'muted' }, `Node.js ${node.build} is not installed. It downloads automatically the first time an app is built from source.`),
          el('div', { class: 'row row-tight' }, runtimeAction(node.managed ? 'Repair' : 'Install now', 'installRuntime', 'node'), node.managed ? runtimeAction('Remove', 'removeRuntime', 'node') : null),
        )
      : null].filter(Boolean),
  );
}

// ────────────────────────────────── jobs ──────────────────────────────────

function renderJobsButton() {
  const running = state.jobs.filter((j) => j.status === 'running').length;
  const failed = state.jobs.filter((j) => j.status === 'failed' && !state.seenJobs.has(j.id)).length;
  const button = $('open-jobs');
  button.classList.toggle('is-busy', running > 0);
  button.classList.toggle('is-failed', failed > 0 && running === 0);
  $('jobs-count').textContent = running ? String(running) : failed ? '!' : '';
  $('jobs-count').hidden = !running && !failed;
}

const JOB_STATUS = { running: 'Running', done: 'Done', failed: 'Failed' };

function renderJobs(focusId = null) {
  const list = $('jobs-list');
  if (!state.jobs.length) {
    list.replaceChildren(el('li', { class: 'muted' }, 'Nothing has run yet. Installs, mirrors and downloads show up here.'));
    return;
  }
  list.replaceChildren(
    ...state.jobs.map((job) =>
      el(
        'li',
        { class: `job is-${job.status}` },
        el('div', { class: 'job-head' }, el('strong', {}, job.title), el('span', { class: `badge badge-${job.status}` }, JOB_STATUS[job.status])),
        job.status === 'running' ? el('div', {}, el('div', { class: 'dist-meta' }, job.message), progressBar(job)) : null,
        job.status === 'failed' ? el('div', { class: 'dist-error' }, job.error) : null,
        job.log.length
          ? el('details', { open: job.id === focusId || job.status === 'running' }, el('summary', {}, `Log · ${job.log.length} line${job.log.length === 1 ? '' : 's'}`), el('pre', { class: 'job-log' }, job.log.join('\n')))
          : null,
      ),
    ),
  );
  for (const job of state.jobs) if (job.status !== 'running') state.seenJobs.add(job.id);
  renderJobsButton();
}

function openJobs(focusId = null) {
  renderJobs(focusId);
  const dialog = $('jobs');
  if (!dialog.open) dialog.showModal();
}

function setJobs(list) {
  const before = new Map(state.jobs.map((j) => [j.id, j.status]));
  state.jobs = list;
  renderJobsButton();
  if ($('jobs').open) renderJobs();
  if ($('detail').open) renderDetail();
  if ($('settings').open) {
    renderRuntimes();
    renderDataLocation();
  }
  // A job that fails while its row is not on screen still has to be noticed.
  const failed = list.find((j) => j.status === 'failed' && before.get(j.id) === 'running');
  if (failed && !$('detail').open) setStatus(`${failed.title} failed: ${failed.error}`, 'error');
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const patch = {
    githubToken: form.githubToken.value.trim(),
    catalogRepo: form.catalogRepo.value.trim(),
    pythonPath: form.pythonPath.value.trim(),
    webmirrorHome: form.webmirrorHome.value.trim(),
    checkUpdatesOnStart: form.checkUpdatesOnStart.checked,
    keepVersions: Math.max(0, Math.min(20, Math.round(Number(form.keepVersions.value) || 0))),
    resyncDays: Math.max(0, Math.min(365, Math.round(Number(form.resyncDays.value) || 0))),
  };
  if (!patch.githubToken) delete patch.githubToken; // keep the saved one
  try {
    state.data = await call('updateSettings', patch);
    renderSettings();
    setStatus('Settings saved', 'good');
    await refresh();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

// ───────────────────────────────── manage ─────────────────────────────────

const FOUND_LABELS = {
  manifest: "Uses the repository's own generator.json.",
  inferred: "No generator.json in the repository, so it was described from its homepage, Pages site and releases. Adding a generator.json to the repo later takes over.",
  link: 'A website: it opens online and can be mirrored for offline use.',
};

function manageMessage(text, tone = '') {
  const box = $('manage-message');
  box.hidden = !text;
  box.textContent = text;
  box.className = `status ${tone ? `is-${tone}` : ''}`;
}

function renderFound() {
  const box = $('found');
  const f = state.found;
  box.hidden = !f;
  if (!f) return;
  const editable = f.found !== 'manifest';
  const field = (label, name, value, attrs = {}) => el('label', {}, el('span', {}, label), el('input', { name, type: 'text', value: value ?? '', ...attrs }));
  box.replaceChildren(
    el('p', { class: 'muted' }, FOUND_LABELS[f.found]),
    editable
      ? el(
          'div',
          { class: 'found-fields' },
          field('Name', 'name', f.raw.name),
          field('Summary', 'summary', f.raw.summary),
          field('Tags', 'tags', (f.raw.tags ?? []).join(', '), { placeholder: 'comma separated' }),
          el(
            'label',
            {},
            el('span', {}, 'Process'),
            el('select', { name: 'process' }, ...['', '3d-print', 'laser', 'cnc', 'tool'].map((p) => el('option', { value: p, selected: (f.raw.process ?? '') === p }, p || 'Not set'))),
          ),
        )
      : el('ul', { class: 'found-list' }, f.preview.map((p) => el('li', {}, el('strong', {}, p.name), p.summary ? ` · ${p.summary}` : ''))),
    f.kinds.length ? el('p', { class: 'muted' }, 'Ways to run it: ', f.kinds.map((k) => KIND_LABELS[k] ?? k).join(', ')) : null,
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn btn-primary', type: 'button', onclick: addFound }, 'Add to library'),
      el('button', { class: 'btn', type: 'button', onclick: () => ((state.found = null), renderFound()) }, 'Cancel'),
    ),
  );
}

async function addFound() {
  const box = $('found');
  const value = (name) => box.querySelector(`[name="${name}"]`)?.value ?? undefined;
  const edits = { name: value('name'), summary: value('summary'), process: value('process'), tags: value('tags')?.split(',') };
  try {
    state.data = await call('addProject', { found: state.found, edits });
    manageMessage(`Added ${state.found.key}`, 'good');
    state.found = null;
    $('add-project').reset();
    renderFound();
    renderManage();
    renderFacets();
    await runSearch();
  } catch (error) {
    manageMessage(error.message, 'error');
  }
}

$('add-project').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = event.currentTarget.input.value.trim();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  manageMessage('Looking it up…');
  try {
    state.found = await call('describeProject', { input });
    manageMessage('');
  } catch (error) {
    state.found = null;
    manageMessage(error.message, 'error');
  } finally {
    button.disabled = false;
    renderFound();
  }
});

function renderManage() {
  const projects = state.data.projects ?? [];
  const row = (p) =>
    el(
      'li',
      { class: 'project' },
      el(
        'div',
        { class: 'project-head' },
        el('div', {}, el('strong', {}, p.name), el('div', { class: 'muted small' }, p.key, p.kind === 'link' ? ' · website' : '')),
        p.removed
          ? el('button', { class: 'btn btn-small', type: 'button', onclick: () => manageAction('restoreProject', { key: p.key }) }, 'Restore')
          : el(
              'button',
              {
                class: 'btn btn-small btn-danger',
                type: 'button',
                onclick: () => {
                  const installed = p.generators.filter((g) => g.installed).length;
                  const note = installed ? ` Its installed copies (${installed}) are deleted too.` : '';
                  const undo = p.origin === 'yours' ? '' : ' You can restore it later.';
                  if (window.confirm(`Remove ${p.name} from your library?${note}${undo}`)) manageAction('removeProject', { key: p.key });
                },
              },
              'Remove',
            ),
      ),
      p.removed || !p.generators.length
        ? null
        : el(
            'div',
            { class: 'project-generators' },
            p.generators.map((g) =>
              el(
                'button',
                {
                  class: `chip ${g.hidden ? '' : 'is-active'}`,
                  type: 'button',
                  title: g.hidden ? 'Hidden: click to show it in the library' : 'Shown: click to hide it',
                  onclick: () => manageAction('setHidden', { id: g.id, hidden: !g.hidden }),
                },
                g.hidden ? '◌ ' : '● ',
                g.name,
              ),
            ),
          ),
    );
  const group = (title, list) => (list.length ? [el('h3', {}, `${title} · ${list.length}`), el('ul', { class: 'projects' }, list.map(row))] : []);
  $('projects').replaceChildren(
    ...group('Added by you', projects.filter((p) => p.origin === 'yours')),
    ...group('From the catalog', projects.filter((p) => p.origin !== 'yours' && !p.removed)),
    ...group('Removed', projects.filter((p) => p.removed)),
  );
}

async function manageAction(name, payload) {
  try {
    state.data = await call(name, payload);
    renderManage();
    renderFacets();
    await runSearch();
  } catch (error) {
    manageMessage(error.message, 'error');
  }
}

$('open-manage').addEventListener('click', () => {
  manageMessage('');
  renderFound();
  renderManage();
  $('manage').showModal();
});

// ───────────────────────────────── wiring ─────────────────────────────────

async function reloadState({ keepSearch = true } = {}) {
  state.data = await call('getState');
  setJobs(state.data.jobs ?? []);
  renderFacets();
  if (keepSearch) await runSearch();
  if ($('detail').open) renderDetail();
  if ($('settings').open) renderSettings();
  if ($('manage').open) renderManage();
}

async function refresh() {
  setStatus('Reading catalog from GitHub…');
  try {
    state.data = await call('refreshCatalog');
    setStatus('');
  } catch (error) {
    setStatus(`Catalog refresh failed: ${error.message}`, 'error');
  }
  renderFacets();
  await runSearch();
}

async function checkUpdates() {
  const button = $('check-updates');
  button.disabled = true;
  setStatus('Checking GitHub for updates…');
  try {
    const results = await call('checkUpdates', {});
    state.updates = new Map(results.map((r) => [recordKey(r.id, r.distKey), r]));
    const count = results.filter((r) => r.hasUpdate).length;
    const stale = Object.values(state.data.installed).filter(resyncDue).length;
    const parts = [];
    if (count) parts.push(`${count} update${count === 1 ? '' : 's'} available`);
    if (stale) parts.push(`${stale} mirrored site${stale === 1 ? '' : 's'} may need mirroring again`);
    setStatus(parts.length ? parts.join(' · ') : results.length || stale ? 'Everything is up to date' : 'Nothing installed yet', count || stale ? 'good' : '');
  } catch (error) {
    setStatus(`Update check failed: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
  await runSearch();
  if ($('detail').open) renderDetail();
}

$('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  runSearch();
});
$('show-chips').addEventListener('click', (event) => {
  const button = event.target.closest('[data-show]');
  if (!button) return;
  state.show = button.dataset.show;
  renderFacets();
  runSearch();
});
$('refresh').addEventListener('click', refresh);
$('check-updates').addEventListener('click', checkUpdates);
$('open-settings').addEventListener('click', () => {
  renderSettings();
  $('settings').showModal();
});
$('clear-filters').addEventListener('click', clearFilters);
$('new-collection').addEventListener('click', () => {
  state.editingCollection = 'new';
  renderCollections();
});
$('show-problems').addEventListener('click', () => {
  $('problems-list').replaceChildren(
    ...state.data.problems.map((p) => el('li', {}, el('code', {}, p.repo, p.path ? `/${p.path}` : ''), ' — ', p.error)),
  );
  $('problems').showModal();
});

api.on('jobs:changed', setJobs);
$('open-jobs').addEventListener('click', () => openJobs());
$('clear-jobs').addEventListener('click', async () => setJobs(await call('clearJobs')));
api.on('catalog:changed', () => reloadState());

(async function boot() {
  try {
    state.data = await call('getState');
    setJobs(state.data.jobs ?? []);
    renderFacets();
    await runSearch();
    if (state.data.generators.length === 0) setStatus('Reading catalog from GitHub…');
    if (state.data.settings.checkUpdatesOnStart && Object.keys(state.data.installed).length) checkUpdates();
  } catch (error) {
    setStatus(error.message, 'error');
  }
})();
