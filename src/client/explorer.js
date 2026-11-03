// HtmlBoard explorer: every design of the project side by side on one canvas.
// Each design is an HTML file shown in an iframe at its real size, and the canvas pans and zooms
// with one CSS transform. Names, outlines and section titles are drawn over it in screen pixels,
// so they stay sharp and readable at any zoom. The server lists the designs at /api/designs and
// pushes saved files at /api/events.

import { checkDesigns } from './check.js';

const FRAME_GAP = 120;    // canvas px between the designs of a section
const SECTION_GAP = 560;   // canvas px between sections
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const MAX_FIT_ZOOM = 2;    // fitting one small design stops at 200%
const ZOOM_STEP = 1.5;     // + and −, keys and buttons
const MARGIN = 40;         // screen px around what a fit shows
const NAME_SPACE = 24;     // screen px above a design for its name
const MIN_NAMED = 56;      // screen px a design needs to be wide to show its name
const TITLE_SPACE = 56;    // screen px above a section for its title and the names
const TOOLBAR_SPACE = 64;  // screen px kept clear at the bottom for the toolbar
const DRAG_SLOP = 4;       // screen px a press can move and still be a click
const DOUBLE_MS = 350;
const CHANGE_MS = 60;      // saved files arriving this close together are applied at once
const SETTLE_MS = 200;     // the canvas has stopped moving after this long still
const DEFAULT_SIZE = [1200, 800]; // a design whose entry gives no size; without a height it grows with its page
const FIT_HEIGHT = 100;    // a frame that fits its page however short (a component's) starts this tall

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), title: $('title'), list: $('list'), count: $('count'), search: $('search'),
  noMatch: $('no-match'), filters: $('filters'), viewport: $('viewport'), world: $('world'), overlay: $('overlay'),
  hover: $('hover'), selection: $('selection'), size: $('size'), zoom: $('zoom-reset'), open: $('open'),
  live: $('live'), help: $('help'), helpToggle: $('help-toggle'), toggleList: $('toggle-list'),
  toast: $('toast'), notice: $('notice'), noticeTitle: $('notice-title'), noticeText: $('notice-text'),
  version: $('version'), sectionsBar: $('sections-bar'), expandAll: $('expand-all'), collapseAll: $('collapse-all'),
  showAll: $('show-all'), hideAll: $('hide-all'), empty: $('empty'), emptyText: $('empty-text'),
};

const state = {
  manifest: '',         // /api/designs as last read, to tell a real change
  autoDiscovered: false, // no designs.json: every HTML file is a design
  // { id, name, designs, el, group, head, x, y, w, h, hidden, collapsed, searchCollapsed }
  sections: [],
  grouped: false,       // more than one section: each can be folded in the list and hidden from the canvas
  designs: [],          // { id, file, path, title, search, section, w, h, autoHeight, x, y, frame, iframe, label, item, … }
  view: { x: 0, y: 0, z: 1 },
  selected: null,
  hover: null,
  query: [],            // the search's words, folded
  category: '',         // the filter: a category, or '' for all
  // What the first view fitted ('all' or a design). Until the user moves the canvas, it is fitted
  // again when the designs' real sizes come in.
  autoFit: null,
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Case and accents don't matter to the search: "inicio" finds "Início".
const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Stored per project (the server says which folder it serves), so two projects don't share a view.
let storePrefix = 'htmlboard:';

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(storePrefix + key));
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(storePrefix + key, JSON.stringify(value));
  } catch {
    // Storage off (private mode): the explorer just forgets.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const urlOf = (file) => encodeURI(`/${file}`);

const ICONS = {
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/></svg>',
};

// ---------------------------------------------------------------- loading

async function fetchManifest() {
  const res = await fetch('/api/designs', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function build(manifest) {
  els.world.replaceChildren();
  els.list.replaceChildren();
  for (const node of els.overlay.querySelectorAll('.label, .section-title')) node.remove();
  state.manifest = JSON.stringify(manifest);
  state.autoDiscovered = Boolean(manifest.autoDiscovered);
  state.sections = [];
  state.designs = [];
  state.selected = null;
  state.hover = null;
  const title = manifest.title || 'Designs';
  els.title.textContent = title;
  document.title = `${title} · htmlboard`;
  const entries = manifest.sections || [];
  // With one section there is nothing to choose between: it shows as before, and can't be hidden.
  state.grouped = entries.length > 1;
  const hidden = new Set(state.grouped ? readStore('hidden') || [] : []);
  const collapsed = new Set(state.grouped ? readStore('collapsed') || [] : []);
  const ids = new Set();
  entries.forEach((entry, i) => {
    const name = entry.name || '';
    let id = String(entry.id || name || `section-${i + 1}`);
    for (let n = 2; ids.has(id); n++) id = `${entry.id || name || `section-${i + 1}`}-${n}`;
    ids.add(id);
    const section = {
      id, name, designs: [], el: el('div', 'section-title', name), group: el('section', 'group'),
      hidden: hidden.has(id), collapsed: collapsed.has(id), searchCollapsed: false,
    };
    els.overlay.insertBefore(section.el, els.hover);
    const items = el('ul');
    if (state.grouped) section.group.append(sectionHead(section));
    else if (name) section.group.append(el('h2', null, name)); // the files at the top of the folder have no title
    if (entry.description) section.group.append(el('p', 'section-desc', entry.description));
    section.group.append(items);
    for (const board of entry.artboards || []) {
      const design = makeDesign(board, section);
      section.designs.push(design);
      state.designs.push(design);
      items.append(design.li);
    }
    els.list.append(section.group);
    state.sections.push(section);
  });
  els.sectionsBar.hidden = !state.grouped;
  placeFrames();
  if (!state.designs.length) {
    showNotice(
      'No designs yet',
      state.autoDiscovered
        ? 'Save an .html file in this folder and it shows up here by itself.'
        : 'designs.json doesn’t list any designs. Add one and it shows up here by itself.',
    );
  } else {
    els.notice.hidden = true;
  }
  buildFilters();
  applySearch();
  layout();
}

function makeDesign(board, section) {
  const file = String(board.file);
  const design = {
    id: String(board.id || file),
    category: board.category || '',
    section,
    file,
    path: `/${file.split('?')[0]}`,
    title: board.title || file,
    w: Number(board.width) || DEFAULT_SIZE[0],
    // A page is never shorter than its frame, so a frame grows to its page but can't shrink to it
    h: Number(board.height) || (board.fit ? FIT_HEIGHT : DEFAULT_SIZE[1]),
    autoHeight: !Number(board.height),
    x: 0,
    y: 0,
  };
  design.search = fold([design.title, file, board.description, board.category, ...(board.tags || []), section.name]
    .filter(Boolean).join(' '));
  design.frame = el('div', 'frame');
  design.iframe = el('iframe');
  design.iframe.title = design.title;
  design.iframe.tabIndex = -1;
  design.iframe.setAttribute('scrolling', 'no');
  design.iframe.addEventListener('load', () => onLoad(design));
  design.iframe.src = urlOf(file); // loads once placeFrames puts it on the canvas
  design.frame.append(design.iframe);

  design.label = el('div', 'label', design.title);
  els.overlay.insertBefore(design.label, els.hover);

  design.item = el('button', 'item');
  design.item.type = 'button';
  if (board.description) design.item.title = board.description;
  design.itemDims = el('span', 'dims');
  design.item.append(el('span', 'name', design.title), design.itemDims);
  design.item.addEventListener('click', () => {
    state.autoFit = null;
    // A design of a hidden section shows its section
    if (section.hidden) setHidden((s) => s.hidden && s !== section, { reveal: false });
    select(design, { fit: true });
  });
  design.li = el('li');
  design.li.append(design.item);
  showDims(design);
  return design;
}

function showDims(design) {
  design.itemDims.textContent = `${design.w} × ${design.h}`;
}

function onLoad(design) {
  const doc = design.iframe.contentDocument;
  if (!doc || !design.autoHeight) return;
  growToPage(design);
  doc.fonts?.ready.then(() => growToPage(design));
  // Pages go on building themselves after they load (components, scripts): measured again when
  // they change. Not when the frame grows: a page always a bit taller than its frame would grow forever.
  let timer = 0;
  new design.iframe.contentWindow.MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (design.autoHeight && design.iframe.contentDocument === doc) growToPage(design);
    }, 50);
  }).observe(doc.documentElement, { childList: true, subtree: true });
}

// A design without a height takes its page's.
function growToPage(design) {
  const doc = design.iframe.contentDocument;
  if (!doc?.documentElement) return;
  const h = Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0));
  if (!h || h === design.h) return;
  design.h = h;
  showDims(design);
  layout();
}

// ---------------------------------------------------------------- filtering and searching

// The device filters come together, so a project without tablets shows that it has none; then any
// other category the designs carry (components, or whatever a designs.json names).
const DEVICES = ['mobile', 'tablet', 'desktop'];
const LABELS = { '': 'All', mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop', components: 'Components' };

// The filter lays out only its designs; the search fades the others where they are.
function inFilter(design) {
  return !state.category || design.category === state.category;
}

// On the canvas: in a shown section, and kept by the filter.
function placed(design) {
  return !design.section.hidden && inFilter(design);
}

function matches(design) {
  return state.query.every((word) => design.search.includes(word));
}

// The designs on the canvas the search keeps.
function shown() {
  return state.designs.filter((d) => placed(d) && matches(d));
}

function buildFilters() {
  const counts = new Map();
  for (const d of state.designs) if (d.category) counts.set(d.category, (counts.get(d.category) || 0) + 1);
  const others = [...counts.keys()].filter((c) => !DEVICES.includes(c))
    .sort((a, b) => (a === 'components' ? -1 : b === 'components' ? 1 : a.localeCompare(b)));
  const categories = ['', ...(DEVICES.some((c) => counts.has(c)) ? DEVICES : []), ...others];
  if (state.category && !counts.has(state.category)) state.category = '';
  els.filters.replaceChildren(...categories.map((category, i) => {
    const count = category ? counts.get(category) || 0 : state.designs.length;
    const label = LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
    const button = el('button', 'filter', label);
    button.type = 'button';
    button.dataset.category = category;
    button.disabled = !count;
    button.title = `${count} design${count === 1 ? '' : 's'}${i < 9 ? ` (${i + 1})` : ''}`;
    button.setAttribute('aria-pressed', String(category === state.category));
    button.addEventListener('click', () => setCategory(category));
    return button;
  }));
  // Nothing to tell apart: no categories, or one that every design shares
  els.filters.hidden = !counts.size || (counts.size === 1 && counts.values().next().value === state.designs.length);
}

function setCategory(category, { fitAll = true } = {}) {
  if (category === state.category) return;
  state.category = category;
  for (const button of els.filters.children) button.setAttribute('aria-pressed', String(button.dataset.category === category));
  if (state.selected && !inFilter(state.selected)) select(null);
  if (state.hover && !inFilter(state.hover)) state.hover = null;
  state.autoFit = null;
  applySearch();
  layout();
  if (fitAll) fit('all');
}

// The list shows what the filter and the search keep, hidden sections' designs too (faded), so they
// can be found and shown again. The count is of the designs on the canvas.
function applySearch() {
  let count = 0;
  for (const section of state.sections) {
    let listed = 0;
    for (const design of section.designs) {
      const kept = inFilter(design);
      const on = kept && matches(design);
      design.li.hidden = !on;
      design.frame.classList.toggle('is-dimmed', kept && !on);
      design.label.classList.toggle('is-dimmed', kept && !on);
      if (on) {
        listed++;
        if (!section.hidden) count++;
      }
    }
    section.group.hidden = !listed;
    if (section.tally) section.tally.textContent = String(listed);
  }
  const total = state.designs.length;
  const searched = state.query.length || state.category;
  const narrowed = searched || state.sections.some((s) => s.hidden);
  els.count.textContent = narrowed ? `${count} of ${total}` : String(total);
  els.noMatch.hidden = !searched || state.designs.some((d) => !d.li.hidden);
  paintSections();
}

function search(text) {
  const searching = state.query.length > 0;
  state.query = fold(text).split(/\s+/).filter(Boolean);
  // A new search opens the folded sections, to show what it finds
  if (!searching && state.query.length) for (const section of state.sections) section.searchCollapsed = false;
  applySearch();
}

// ---------------------------------------------------------------- sections: folded in the list, hidden from the canvas

// A section's row in the list: the arrow (or the title) folds it, the eye hides it from the canvas.
function sectionHead(section) {
  const head = el('div', 'group-head');
  const toggle = el('button', 'group-toggle');
  toggle.type = 'button';
  toggle.innerHTML = ICONS.chevron;
  section.tally = el('span', 'group-count');
  toggle.append(el('span', 'group-name', section.name || 'Top level'), section.tally);
  toggle.addEventListener('click', () => setCollapsed((s) => (s === section ? !isCollapsed(s) : isCollapsed(s))));
  const eye = el('button', 'mini group-eye');
  eye.type = 'button';
  eye.addEventListener('click', (event) => {
    if (event.altKey) {
      // Only this section on the canvas; again, all of them
      const alone = !section.hidden && state.sections.every((s) => s === section || s.hidden);
      setHidden((s) => !alone && s !== section);
    } else {
      setHidden((s) => (s === section ? !s.hidden : s.hidden));
    }
  });
  head.append(toggle, eye);
  Object.assign(section, { head, toggle, eye });
  return head;
}

// While searching, sections open to show what the search finds, and folding one lasts until the
// search is cleared; otherwise it is remembered.
function isCollapsed(section) {
  return state.query.length ? section.searchCollapsed : section.collapsed;
}

// Folds and unfolds sections in the list: fn(section) says which are folded.
function setCollapsed(fn) {
  const searching = state.query.length > 0;
  for (const section of state.sections) {
    if (searching) section.searchCollapsed = Boolean(fn(section));
    else section.collapsed = Boolean(fn(section));
  }
  saveSections();
  paintSections();
}

// Hides and shows sections on the canvas: fn(section) says which are hidden. A hidden section's
// designs leave the canvas and their pages unload, so a canvas of many designs stays light; the
// rows below move up. `reveal`: bring the canvas into view when what's left is out of it.
function setHidden(fn, { reveal = true } = {}) {
  let changed = false;
  for (const section of state.sections) {
    const hidden = Boolean(fn(section));
    if (section.hidden !== hidden) {
      section.hidden = hidden;
      changed = true;
    }
  }
  if (!changed) return;
  placeFrames();
  if (state.selected && !placed(state.selected)) select(null);
  if (state.hover && !placed(state.hover)) state.hover = null;
  state.autoFit = null;
  saveSections();
  applySearch();
  layout();
  if (reveal && state.designs.some(placed) && !inSight()) fit('all');
}

// The frames of the shown sections are on the canvas. Taken off it, a frame's page unloads; put
// back, it loads again.
function placeFrames() {
  for (const design of state.designs) {
    if (design.section.hidden) design.frame.remove();
    else if (!design.frame.isConnected) els.world.append(design.frame);
  }
}

function saveSections() {
  if (!state.grouped) return;
  writeStore('hidden', state.sections.filter((s) => s.hidden).map((s) => s.id));
  writeStore('collapsed', state.sections.filter((s) => s.collapsed).map((s) => s.id));
}

// Whether any design on the canvas is on screen.
function inSight() {
  const { x, y, z } = state.view;
  const screen = size();
  return state.designs.some((d) => placed(d)
    && x + (d.x + d.w) * z > 0 && x + d.x * z < screen.w && y + (d.y + d.h) * z > 0 && y + d.y * z < screen.h);
}

// The sections in the list as they are (folded, hidden, holding the selection), the buttons for all
// of them, and the canvas's word when it has nothing left to show.
function paintSections() {
  for (const section of state.sections) {
    const folded = state.grouped && isCollapsed(section);
    section.group.classList.toggle('is-folded', folded);
    section.group.classList.toggle('is-hidden', section.hidden);
    section.group.classList.toggle('has-selection', folded && state.selected?.section === section);
    if (!section.head) continue;
    section.toggle.setAttribute('aria-expanded', String(!folded));
    if (section.eyeShows !== section.hidden) {
      section.eyeShows = section.hidden;
      section.eye.innerHTML = section.hidden ? ICONS.eyeOff : ICONS.eye;
      section.eye.title = `${section.hidden ? 'Show on the canvas' : 'Hide from the canvas'} (Alt + click: only this section)`;
      section.eye.setAttribute('aria-label', `${section.hidden ? 'Show' : 'Hide'} ${section.name || 'Top level'}`);
    }
  }
  const listed = state.sections.filter((s) => !s.group.hidden);
  els.expandAll.disabled = !listed.some(isCollapsed);
  els.collapseAll.disabled = listed.every(isCollapsed);
  els.showAll.disabled = !state.sections.some((s) => s.hidden);
  els.hideAll.disabled = state.sections.every((s) => s.hidden);
  els.empty.hidden = !state.designs.length || state.designs.some(placed);
  els.emptyText.textContent = state.sections.every((s) => s.hidden)
    ? 'All sections are hidden.'
    : 'This filter’s designs are all in hidden sections.';
}

// ---------------------------------------------------------------- layout and drawing

// Sections are rows, top to bottom; designs sit left to right in each row, tops aligned.
function layout() {
  let y = 0;
  for (const section of state.sections) {
    let x = 0;
    let height = 0;
    for (const design of section.designs) {
      design.frame.hidden = !inFilter(design);
      if (!placed(design)) continue;
      design.x = x;
      design.y = y;
      Object.assign(design.frame.style, { left: `${x}px`, top: `${y}px`, width: `${design.w}px`, height: `${design.h}px` });
      x += design.w + FRAME_GAP;
      height = Math.max(height, design.h);
    }
    // A section the filter empties, or a hidden one, takes no room
    Object.assign(section, { x: 0, y, w: Math.max(0, x - FRAME_GAP), h: height, shown: x > 0 });
    if (section.shown) y += height + SECTION_GAP;
  }
  if (state.autoFit) fit(state.autoFit, { animate: false });
  else paint();
}

function paint() {
  const { x, y, z } = state.view;
  els.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  // Dots every 32 canvas px, doubled or halved to stay 16 to 64 screen px apart.
  let grid = 32 * z;
  while (grid < 16) grid *= 2;
  while (grid >= 64) grid /= 2;
  els.viewport.style.setProperty('--grid', `${grid}px`);
  els.viewport.style.backgroundPosition = `${x}px ${y}px`;
  // Above each row: the section's title, then the designs' names. Zoomed far out the gap between
  // rows gets thin: the names give way first, then the title.
  let first = true;
  for (const section of state.sections) {
    if (!section.shown) {
      section.el.hidden = true;
      for (const design of section.designs) design.label.hidden = true;
      continue;
    }
    const room = first ? Infinity : SECTION_GAP * z;
    first = false;
    const named = room >= TITLE_SPACE + 2;
    const top = Math.round(y + section.y * z);
    section.el.hidden = room < 30 || !section.name;
    section.el.style.transform = `translate(${Math.round(x + section.x * z)}px, ${top - (named ? 54 : 30)}px)`;
    for (const design of section.designs) {
      if (!placed(design)) {
        design.label.hidden = true;
        continue;
      }
      const width = design.w * z;
      design.label.hidden = !named || width < MIN_NAMED;
      design.label.style.width = `${Math.round(width)}px`;
      design.label.style.transform = `translate(${Math.round(x + design.x * z)}px, ${top - 22}px)`;
    }
  }
  els.zoom.textContent = `${Math.round(z * 100)}%`;
  paintMarks();
  saveView();
}

// Selection and hover: the outlines and the names' colours.
function paintMarks() {
  place(els.selection, state.selected);
  place(els.hover, state.hover === state.selected ? null : state.hover);
  const { selected } = state;
  els.size.hidden = !selected;
  if (selected) {
    const { x, y, z } = state.view;
    els.size.textContent = `${selected.w} × ${selected.h}`;
    els.size.style.transform = `translate(${x + (selected.x + selected.w / 2) * z}px, ${y + (selected.y + selected.h) * z + 8}px) translateX(-50%)`;
  }
  for (const design of state.designs) {
    design.label.classList.toggle('is-selected', design === state.selected);
    design.label.classList.toggle('is-hover', design === state.hover);
  }
}

function place(node, design) {
  node.hidden = !design;
  if (!design) return;
  const { x, y, z } = state.view;
  node.style.transform = `translate(${x + design.x * z}px, ${y + design.y * z}px)`;
  node.style.width = `${design.w * z}px`;
  node.style.height = `${design.h * z}px`;
}

let saveTimer = 0;
function saveView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeStore('view', state.view), 300);
}

// ---------------------------------------------------------------- moving the canvas

// While the canvas moves, it is one layer the browser slides and scales without drawing every design
// again on each frame; once it stops, they are drawn again, sharp, at the new zoom. (Kept as a layer
// for good, it would hold more memory, and some browsers would leave it blurry after a zoom.)
let settleTimer = 0;
function setView(view) {
  state.view = view;
  els.world.classList.add('is-moving');
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => els.world.classList.remove('is-moving'), SETTLE_MS);
  paint();
}

function size() {
  return { w: els.viewport.clientWidth, h: els.viewport.clientHeight };
}

function boundsOf(designs) {
  if (!designs.length) return { x: 0, y: 0, w: 1, h: 1 };
  const left = Math.min(...designs.map((d) => d.x));
  const top = Math.min(...designs.map((d) => d.y));
  const right = Math.max(...designs.map((d) => d.x + d.w));
  const bottom = Math.max(...designs.map((d) => d.y + d.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// The view that shows `rect` whole, centred, with `top` screen px free above it for its names.
function viewFor(rect, top) {
  const screen = size();
  const w = Math.max(1, screen.w - 2 * MARGIN);
  const h = Math.max(1, screen.h - 2 * MARGIN - top - TOOLBAR_SPACE);
  const z = clamp(Math.min(w / rect.w, h / rect.h), MIN_ZOOM, MAX_FIT_ZOOM);
  return {
    z,
    x: MARGIN + (w - rect.w * z) / 2 - rect.x * z,
    y: MARGIN + top + (h - rect.h * z) / 2 - rect.y * z,
  };
}

// target: 'all' (what the search keeps) or a design.
function fit(target, { animate = true } = {}) {
  if (target === 'all') {
    const found = shown();
    const designs = found.length ? found : state.designs.filter(placed);
    if (!designs.length) {
      paint(); // every section hidden: nothing to fit
      return;
    }
    moveTo(viewFor(boundsOf(designs), TITLE_SPACE), animate);
  } else {
    moveTo(viewFor(target, NAME_SPACE), animate);
  }
}

let animation = 0;
function moveTo(target, animate = true) {
  cancelAnimationFrame(animation);
  if (!animate || reducedMotion.matches) {
    setView(target);
    return;
  }
  const from = { ...state.view };
  const screen = size();
  const cx = screen.w / 2;
  const cy = screen.h / 2;
  // Glide the canvas point under the centre of the screen, and the zoom in proportion.
  const a = { x: (cx - from.x) / from.z, y: (cy - from.y) / from.z };
  const b = { x: (cx - target.x) / target.z, y: (cy - target.y) / target.z };
  const start = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - start) / 260);
    const e = 1 - (1 - t) ** 3;
    const z = from.z * (target.z / from.z) ** e;
    setView({ x: cx - (a.x + (b.x - a.x) * e) * z, y: cy - (a.y + (b.y - a.y) * e) * z, z });
    if (t < 1) animation = requestAnimationFrame(frame);
  };
  animation = requestAnimationFrame(frame);
}

// Zoom keeping the canvas point at (px, py) of the screen in place.
function zoomedAt(px, py, z) {
  const { x, y, z: from } = state.view;
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  return { x: px - ((px - x) * z) / from, y: py - ((py - y) * z) / from, z };
}

function zoomBy(factor) {
  const screen = size();
  moveTo(zoomedAt(screen.w / 2, screen.h / 2, state.view.z * factor));
}

// 100%: the selected design, centred (top first when it is taller than the screen), or the
// middle of the screen.
function actualSize() {
  const design = state.selected;
  if (!design) {
    zoomBy(1 / state.view.z);
    return;
  }
  const screen = size();
  const room = screen.h - TOOLBAR_SPACE - NAME_SPACE - 2 * MARGIN;
  const y = design.h <= room
    ? MARGIN + NAME_SPACE + (room - design.h) / 2 - design.y
    : MARGIN + NAME_SPACE - design.y;
  moveTo({ z: 1, x: (screen.w - design.w) / 2 - design.x, y });
}

// ---------------------------------------------------------------- selection

function select(design, { fit: fitIt = false, animate = true } = {}) {
  state.selected = design || null;
  for (const each of state.designs) {
    if (each === state.selected) each.item.setAttribute('aria-current', 'true');
    else each.item.removeAttribute('aria-current');
  }
  els.open.href = state.selected ? urlOf(state.selected.file) : '#';
  els.open.setAttribute('aria-disabled', String(!state.selected));
  const hash = state.selected ? `#${encodeURIComponent(state.selected.id)}` : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
  paintSections(); // a folded section marks the selection it holds
  if (state.selected && !state.selected.li.hidden) {
    const { section } = state.selected;
    (state.grouped && isCollapsed(section) ? section.head : state.selected.item).scrollIntoView({ block: 'nearest' });
  }
  if (state.selected && fitIt) fit(state.selected, { animate });
  else paintMarks();
}

// #<id>, or the design's file (relative to the designs folder, with or without .html).
function designFromHash() {
  const name = decodeURIComponent(location.hash.slice(1));
  if (!name) return null;
  const bare = (file) => file.replace(/\.html?(?=$|\?)/i, '');
  return state.designs.find((d) => d.id === name)
    || state.designs.find((d) => [d.file, bare(d.file)].some((file) => file === name || file.endsWith(`/${name}`)))
    || null;
}

function step(delta) {
  const designs = shown();
  const count = designs.length;
  if (!count) return;
  const at = designs.indexOf(state.selected);
  const next = at < 0 ? (delta > 0 ? 0 : count - 1) : (at + delta + count) % count;
  select(designs[next], { fit: true });
}

function setHover(design) {
  if (state.hover === design) return;
  state.hover = design;
  paintMarks();
}

// The design under a point of the screen: its frame, or its name just above it.
function hit(point) {
  const { x, y, z } = state.view;
  const cx = (point.x - x) / z;
  const cy = (point.y - y) / z;
  for (let i = state.designs.length - 1; i >= 0; i--) {
    const d = state.designs[i];
    if (!placed(d)) continue;
    const top = d.y - (d.label.hidden ? 0 : NAME_SPACE / z);
    if (cx >= d.x && cx <= d.x + d.w && cy >= top && cy <= d.y + d.h) return d;
  }
  return null;
}

function openSelected() {
  if (state.selected) window.open(urlOf(state.selected.file), '_blank', 'noopener');
}

// ---------------------------------------------------------------- panels and messages

function toggleList(show = els.app.classList.contains('is-collapsed')) {
  // The canvas keeps its place on screen while the list comes and goes.
  const before = els.viewport.getBoundingClientRect().left;
  els.app.classList.toggle('is-collapsed', !show);
  const after = els.viewport.getBoundingClientRect().left;
  els.toggleList.setAttribute('aria-pressed', String(show));
  writeStore('list', show);
  setView({ ...state.view, x: state.view.x + before - after });
}

function toggleHelp(show = els.help.hidden) {
  els.help.hidden = !show;
  els.helpToggle.setAttribute('aria-expanded', String(show));
}

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 1800);
}

function showNotice(title, text) {
  els.noticeTitle.textContent = title;
  els.noticeText.textContent = text;
  els.notice.hidden = false;
}

// "A", "A and B", "A, B and 3 more".
function names(designs) {
  const titles = designs.map((d) => d.title);
  if (titles.length <= 2) return titles.join(' and ');
  return `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`;
}

// ---------------------------------------------------------------- reloading

function reloadFrame(design) {
  try {
    design.iframe.contentWindow.location.reload();
  } catch {
    design.iframe.src = urlOf(design.file);
  }
}

// Whether a design's page loaded the file: its stylesheets, scripts, images, fonts, fetches.
function uses(design, path) {
  let entries;
  try {
    entries = design.iframe.contentWindow.performance.getEntriesByType('resource');
  } catch {
    return true; // can't tell: reload it
  }
  if (entries.length >= 250) return true; // the browser stops listing at 250: can't tell
  return entries.some((entry) => {
    try {
      const url = new URL(entry.name);
      return url.origin === location.origin && decodeURIComponent(url.pathname) === path;
    } catch {
      return false;
    }
  });
}

function rebuild(manifest) {
  const selected = state.selected?.id;
  build(manifest);
  const design = state.designs.find((d) => d.id === selected);
  select(design && placed(design) ? design : null);
}

// What a new canvas changed, from the designs before and after it.
function changesBetween(before, after) {
  const added = after.filter((d) => !before.some((b) => b.id === d.id));
  const removed = before.filter((b) => !after.some((d) => d.id === b.id));
  if (added.length && !removed.length) return `New: ${names(added)}`;
  if (removed.length && !added.length) return `Removed: ${names(removed)}`;
  if (added.length) return `${added.length} new, ${removed.length} removed`;
  return 'Canvas updated';
}

// The same designs in the same sections and order: what changed is names, sizes or categories.
function sameShape(manifest) {
  const sections = manifest.sections || [];
  if (sections.length !== state.sections.length) return false;
  let i = 0;
  return sections.every((entry, s) => (entry.name || '') === state.sections[s].name
    && (entry.artboards || []).length === state.sections[s].designs.length
    && entry.artboards.every((board) => {
      const design = state.designs[i++];
      return design && design.id === String(board.id || board.file) && design.file === String(board.file);
    }));
}

// Names, sizes, categories and descriptions changed in place: no frame reloads.
function patch(manifest) {
  const boards = manifest.sections.flatMap((section) => section.artboards.map((board) => [board, section]));
  boards.forEach(([board, section], i) => {
    const design = state.designs[i];
    design.title = board.title || design.file;
    design.label.textContent = design.title;
    design.iframe.title = design.title;
    design.item.querySelector('.name').textContent = design.title;
    if (board.description) design.item.title = board.description;
    else design.item.removeAttribute('title');
    design.category = board.category || '';
    design.search = fold([design.title, design.file, board.description, board.category, ...(board.tags || []), section.name]
      .filter(Boolean).join(' '));
    const autoHeight = !Number(board.height);
    if (Number(board.width)) design.w = Number(board.width);
    if (!autoHeight) design.h = Number(board.height);
    else if (!design.autoHeight) growToPage(design);
    design.autoHeight = autoHeight;
    showDims(design);
  });
  state.manifest = JSON.stringify(manifest);
  buildFilters();
  applySearch();
  layout();
}

// Reads the designs again: 'rebuilt' (a new canvas), 'patched' (names or sizes) or false (no change).
// message: a text, or nothing to describe the change.
async function rebuildIfChanged(message) {
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch {
    return false;
  }
  if (JSON.stringify(manifest) === state.manifest) return false;
  if (sameShape(manifest)) {
    patch(manifest);
    return 'patched';
  }
  const before = state.designs.map(({ id, title }) => ({ id, title }));
  rebuild(manifest);
  toast(message || changesBetween(before, state.designs));
  return 'rebuilt';
}

async function reloadAll() {
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    toast(`Could not read the designs (${err.message})`);
    return;
  }
  if (JSON.stringify(manifest) !== state.manifest) rebuild(manifest);
  else state.designs.filter((d) => d.frame.isConnected).forEach(reloadFrame);
  toast('Designs reloaded');
}

const pending = { files: new Set(), manifest: false, folders: false };
let changeTimer = 0;

function onChange(change) {
  if (change.type === 'manifest') pending.manifest = true;
  else if (change.type === 'folder') pending.folders = true;
  else if (change.file) pending.files.add(change.file);
  clearTimeout(changeTimer);
  changeTimer = setTimeout(applyChanges, CHANGE_MS);
}

async function applyChanges() {
  const files = [...pending.files];
  const { manifest: manifestChanged, folders: foldersChanged } = pending;
  pending.files.clear();
  pending.manifest = false;
  pending.folders = false;

  // A new canvas loads every design afresh, so nothing else is left to do.
  if (manifestChanged) {
    const result = await rebuildIfChanged('designs.json changed: canvas rebuilt');
    if (result === 'rebuilt') return;
    if (result === 'patched' && !files.length) toast('designs.json changed: names and sizes updated');
  }
  // Every HTML file is a design, and it says its own name, size and variants in its <head>: a saved
  // page may be a new design, a renamed or resized one. A folder added or removed may bring or
  // take a whole group of them.
  const pages = files.filter((file) => /\.html?$/i.test(file));
  if (foldersChanged || pages.length) {
    if (await rebuildIfChanged() === 'rebuilt') return;
  }

  // A hidden section's designs aren't loaded: they load as they are now when it is shown.
  const paths = files.map((file) => `/${file}`);
  const frames = state.designs.filter((d) => d.frame.isConnected && (paths.includes(d.path) || paths.some((path) => uses(d, path))));
  if (!frames.length) return;
  // Name the shared files the designs use (a stylesheet, a script), not whatever else was saved.
  // Asked before reloading: a reloading page forgets what it loaded.
  const shared = paths
    .filter((path) => !state.designs.some((d) => d.path === path) && frames.some((d) => uses(d, path)))
    .map((path) => path.slice(1));
  frames.forEach(reloadFrame);
  toast(shared.length
    ? `${shared.join(', ')} changed: ${frames.length === 1 ? frames[0].title : `${frames.length} designs`} reloaded`
    : `Updated: ${names(frames)}`);
}

function connect() {
  const source = new EventSource('/api/events');
  let lost = false;
  source.addEventListener('connected', () => {
    setLive(true);
    // Back after the server stopped: files may have changed meanwhile.
    if (lost) reloadAll();
    lost = false;
  });
  source.addEventListener('change', (event) => {
    try {
      onChange(JSON.parse(event.data));
    } catch {
      // Not ours.
    }
  });
  source.addEventListener('check', (event) => {
    try {
      takeCheck(JSON.parse(event.data));
    } catch {
      // Not ours.
    }
  });
  // EventSource keeps trying to reconnect by itself.
  source.addEventListener('error', () => {
    lost = true;
    setLive(false);
  });
}

// ---------------------------------------------------------------- checking (htmlboard check)

let checking = Promise.resolve();

// The server asks every open canvas: the first to claim a check does it, after the ones it's doing.
async function takeCheck(request) {
  let claimed = false;
  try {
    claimed = (await fetch(`/api/check/${request.id}/claim`, { method: 'POST' })).ok;
  } catch {
    // The server is gone
  }
  if (claimed) checking = checking.then(() => runCheck(request));
}

async function runCheck({ id, designs: boards }) {
  const designs = boards.map((board) => {
    const shown = state.designs.find((d) => d.id === board.id); // a size variant has its file's URL
    const height = Number(board.height) || 0;
    return {
      file: board.file,
      title: board.title || board.file,
      width: Number(board.width) || DEFAULT_SIZE[0],
      height,
      // Without a height, the frame is as tall as the canvas has it (as tall as its page)
      frameHeight: height || (shown?.autoHeight ? shown.h : board.fit ? FIT_HEIGHT : DEFAULT_SIZE[1]),
    };
  });
  const what = designs.length === 1 ? designs[0].title : `${designs.length} designs`;
  toast(`Checking ${what}…`);
  let report;
  try {
    report = { designs: await checkDesigns(designs) };
  } catch (err) {
    report = { error: String(err?.message || err) };
  }
  try {
    await fetch(`/api/check/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  } catch {
    return;
  }
  const failing = (report.designs || []).filter((d) => d.problems.some((p) => p.level !== 'note')).length;
  const verdict = !failing ? 'no problems' : designs.length === 1 ? 'problems found' : `${failing} with problems`;
  toast(report.error ? `Couldn't check ${what}: ${report.error}` : `Checked ${what}: ${verdict}`);
}

function setLive(on) {
  els.live.hidden = false;
  els.live.classList.toggle('is-off', !on);
  els.live.textContent = on ? 'Live' : 'Offline';
  els.live.title = on
    ? 'Watching the files: saved changes show up by themselves'
    : 'Lost the server: start htmlboard again and the canvas reconnects';
}

// ---------------------------------------------------------------- input

const pointers = new Map();
let press = null;   // one pointer down: a click, or a drag that pans
let pinch = null;   // two pointers down
let lastClick = { time: 0, design: null };
let spaceDown = false;

function local(event) {
  const box = els.viewport.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
}

function onCanvas(event) {
  return !event.target.closest('.toolbar, .help, .notice, .empty');
}

function wire() {
  const { viewport } = els;

  viewport.addEventListener('wheel', (event) => {
    if (!onCanvas(event)) return;
    event.preventDefault();
    state.autoFit = null;
    cancelAnimationFrame(animation);
    let dx = event.deltaX;
    let dy = event.deltaY;
    if (event.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (event.deltaMode === 2) {
      dx *= viewport.clientWidth;
      dy *= viewport.clientHeight;
    }
    if (event.ctrlKey || event.metaKey) {
      // Pinches arrive as Ctrl + small deltas; a mouse wheel notch is capped to one gentle step.
      const point = local(event);
      setView(zoomedAt(point.x, point.y, state.view.z * Math.exp(-clamp(dy, -50, 50) / 100)));
    } else {
      if (event.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      setView({ ...state.view, x: state.view.x - dx, y: state.view.y - dy });
    }
  }, { passive: false });

  // Ctrl + scroll and pinches anywhere else (the list, the toolbar) would zoom the whole page.
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false });

  // Safari reports trackpad pinches as gestures instead of Ctrl + wheel.
  let gestureZoom = 1;
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  viewport.addEventListener('gesturestart', (event) => {
    event.preventDefault();
    gestureZoom = state.view.z;
  });
  viewport.addEventListener('gesturechange', (event) => {
    event.preventDefault();
    state.autoFit = null;
    const point = local(event);
    setView(zoomedAt(point.x, point.y, gestureZoom * event.scale));
  });

  viewport.addEventListener('pointerdown', (event) => {
    if (!onCanvas(event) || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); // no text selection, no middle-click autoscroll
    if (document.activeElement === els.search) els.search.blur();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    state.autoFit = null;
    const point = local(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      cancelAnimationFrame(animation);
      const [a, b] = [...pointers.values()];
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: { ...state.view },
      };
      press = null;
      viewport.classList.remove('is-panning');
      return;
    }
    if (pointers.size > 2) return;
    press = { id: event.pointerId, ...point, moved: false, pan: event.button === 1 || spaceDown, touch: event.pointerType !== 'mouse' };
  });

  viewport.addEventListener('pointermove', (event) => {
    const point = local(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);
    if (pinch) {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const z = clamp((pinch.view.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance, MIN_ZOOM, MAX_ZOOM);
      // The canvas point under the fingers' starting middle follows their middle now.
      const cx = (pinch.middle.x - pinch.view.x) / pinch.view.z;
      const cy = (pinch.middle.y - pinch.view.y) / pinch.view.z;
      setView({ x: (a.x + b.x) / 2 - cx * z, y: (a.y + b.y) / 2 - cy * z, z });
      return;
    }
    if (press && event.pointerId === press.id) {
      if (!press.moved && Math.hypot(point.x - press.x, point.y - press.y) > DRAG_SLOP) {
        // The drag starts here, from wherever a glide has got to.
        cancelAnimationFrame(animation);
        Object.assign(press, { moved: true, view: { ...state.view }, x: point.x, y: point.y });
        viewport.classList.add('is-panning');
        setHover(null);
      }
      if (press.moved) setView({ ...state.view, x: press.view.x + point.x - press.x, y: press.view.y + point.y - press.y });
      return;
    }
    if (event.pointerType === 'mouse' && !pointers.size && onCanvas(event)) setHover(hit(point));
  });

  const release = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch) {
      if (!pointers.size) pinch = null;
      return;
    }
    if (!press || event.pointerId !== press.id) return;
    const done = press;
    press = null;
    viewport.classList.remove('is-panning');
    if (done.moved || done.pan || event.type === 'pointercancel') return;
    const design = hit(local(event));
    const now = performance.now();
    if (done.touch && design && design === lastClick.design && now - lastClick.time < DOUBLE_MS) {
      lastClick = { time: 0, design: null };
      select(design, { fit: true });
      return;
    }
    lastClick = { time: now, design };
    select(design);
  };
  viewport.addEventListener('dblclick', (event) => {
    if (!onCanvas(event)) return;
    const design = hit(local(event));
    if (design) select(design, { fit: true });
  });
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);
  viewport.addEventListener('pointerleave', () => {
    if (!pointers.size) setHover(null);
  });

  els.search.addEventListener('input', () => search(els.search.value));
  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (els.search.value) {
        els.search.value = '';
        search('');
      } else {
        els.search.blur();
      }
    } else if (event.key === 'Enter') {
      // The first design found on the canvas, fitted; else the first in the list, its section shown.
      event.preventDefault();
      const [first = state.designs.find((d) => !d.li.hidden)] = shown();
      if (first) {
        state.autoFit = null;
        if (first.section.hidden) setHidden((s) => s.hidden && s !== first.section, { reveal: false });
        select(first, { fit: true });
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    // Typing in the search (it has its own keys above) is not a shortcut.
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const onControl = event.target.closest?.('button, a');
    const key = event.key;
    if (key === ' ' || event.code === 'Space') {
      if (onControl) return;
      event.preventDefault();
      spaceDown = true;
      viewport.classList.add('is-space');
      return;
    }
    let handled = true;
    if ((event.shiftKey && event.code === 'Digit1') || key === 'f' || key === 'F') fit('all');
    else if (event.shiftKey && event.code === 'Digit2') {
      if (state.selected) fit(state.selected);
    } else if ((event.shiftKey && event.code === 'Digit0') || key === '0') actualSize();
    else if (key === '+' || key === '=' || event.code === 'NumpadAdd') zoomBy(ZOOM_STEP);
    else if (key === '-' || key === '_' || event.code === 'NumpadSubtract') zoomBy(1 / ZOOM_STEP);
    else if (key === 'ArrowRight' || key === 'ArrowDown') step(1);
    else if (key === 'ArrowLeft' || key === 'ArrowUp') step(-1);
    else if (key === 'Escape') {
      // One thing at a time: the shortcuts, the selection, the search, the filter
      if (!els.help.hidden) toggleHelp(false);
      else if (state.selected) select(null);
      else if (els.search.value) {
        els.search.value = '';
        search('');
      } else if (state.category) setCategory('');
    } else if (key === 'Enter' && !onControl) openSelected();
    else if (key === 'r' || key === 'R') reloadAll();
    else if (key === '/') {
      if (els.app.classList.contains('is-collapsed')) toggleList(true);
      els.search.focus();
      els.search.select();
    } else if (key === '?') toggleHelp();
    else if (/^[1-9]$/.test(key) && !event.shiftKey && !els.filters.hidden) {
      // 1 shows all, 2 to 4 mobile, tablet, desktop, then the other categories
      const button = els.filters.children[Number(key) - 1];
      if (button && !button.disabled) setCategory(button.dataset.category);
      else handled = false;
    }
    else if (key === '\\' || key === '[' || key === ']') toggleList();
    else handled = false;
    if (handled) {
      event.preventDefault();
      state.autoFit = null;
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.code === 'Space') {
      spaceDown = false;
      viewport.classList.remove('is-space');
    }
  });

  window.addEventListener('blur', () => {
    spaceDown = false;
    viewport.classList.remove('is-space');
  });

  window.addEventListener('resize', () => {
    if (state.autoFit) fit(state.autoFit, { animate: false });
    else paint();
  });

  window.addEventListener('hashchange', () => {
    const design = designFromHash();
    if (design && design !== state.selected) {
      state.autoFit = null;
      if (design.section.hidden) setHidden((s) => s.hidden && s !== design.section, { reveal: false });
      if (!inFilter(design)) setCategory('', { fitAll: false });
      select(design, { fit: true });
    }
  });

  $('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
  els.zoom.addEventListener('click', actualSize);
  $('fit-all').addEventListener('click', () => fit('all'));
  $('reload').addEventListener('click', reloadAll);
  els.toggleList.addEventListener('click', () => toggleList());
  els.helpToggle.addEventListener('click', () => toggleHelp());
  els.expandAll.addEventListener('click', () => setCollapsed(() => false));
  els.collapseAll.addEventListener('click', () => setCollapsed(() => true));
  els.showAll.addEventListener('click', () => setHidden(() => false));
  els.hideAll.addEventListener('click', () => setHidden(() => true));
  $('empty-show').addEventListener('click', () => setHidden(() => false));
  for (const id of ['zoom-in', 'zoom-out', 'zoom-reset', 'fit-all']) {
    $(id).addEventListener('click', () => {
      state.autoFit = null;
    });
  }
}

// ---------------------------------------------------------------- start

async function start() {
  let manifest;
  try {
    const [designs, health] = await Promise.all([
      fetchManifest(),
      fetch('/api/health', { cache: 'no-store' }).then((res) => res.json()).catch(() => ({})),
    ]);
    manifest = designs;
    if (health.dir) storePrefix = `htmlboard:${health.dir}:`;
    if (health.version) els.version.textContent = health.version;
  } catch (err) {
    showNotice('Could not load the designs', `${err.message}. Is htmlboard still running?`);
    return;
  }

  const list = readStore('list');
  if (list === false || (list === null && innerWidth < 720)) {
    els.app.classList.add('is-collapsed');
    els.toggleList.setAttribute('aria-pressed', 'false');
  }
  els.viewport.tabIndex = -1;
  build(manifest);
  wire();

  const design = designFromHash();
  const saved = readStore('view');
  if (design) {
    if (design.section.hidden) setHidden((s) => s.hidden && s !== design.section, { reveal: false });
    state.autoFit = design;
    select(design, { fit: true, animate: false });
  } else if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite) && saved.z > 0) {
    setView({ x: saved.x, y: saved.y, z: clamp(saved.z, MIN_ZOOM, MAX_ZOOM) });
  } else {
    state.autoFit = 'all';
    fit('all', { animate: false });
  }

  connect();
}

start();
