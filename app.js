// ===== State & persistence =====

const state = JSON.parse(localStorage.getItem('seating') || 'null') || { guests: [], groups: [], rels: [], tables: [] };

// old format had a single nullable `group` id; now a guest can belong to several groups
function migrateGuestGroups(guests) {
  guests.forEach(g => { if (!Array.isArray(g.groups)) g.groups = g.group ? [g.group] : []; delete g.group; });
  return guests;
}
// default cascading positions for tables loaded (or migrated) without a saved x/y
function migrateTablePositions(tables) {
  tables.forEach((t, i) => { if (t.x == null) t.x = 30 + (i % 4) * 260; if (t.y == null) t.y = 30 + Math.floor(i / 4) * 240; });
  return tables;
}
migrateTablePositions(state.tables);
migrateGuestGroups(state.guests);

// one level of undo: every save() call happens right after some function has already mutated
// `state` in place, so localStorage still holds the *previous* value the instant we read it here —
// stash that as the single undo step before overwriting it.
let undoSnapshot = null;
function save() {
  const prev = localStorage.getItem('seating');
  if (prev) undoSnapshot = prev;
  localStorage.setItem('seating', JSON.stringify(state));
}
function undo() {
  if (!undoSnapshot) return;
  const restored = JSON.parse(undoSnapshot);
  state.guests = migrateGuestGroups(restored.guests || []);
  state.groups = restored.groups || [];
  state.rels = restored.rels || [];
  state.tables = migrateTablePositions(restored.tables || []);
  localStorage.setItem('seating', undoSnapshot);
  undoSnapshot = null; // single level — no undoing the undo
  closeGroupPicker();
  selectedGuestId = null;
  renderAll();
}

function guestById(id) { return state.guests.find(g => g.id === id); }
function groupById(id) { return state.groups.find(g => g.id === id); }
function seatedTableOf(guestId) { return state.tables.find(t => t.seats.includes(guestId)); }

// ===== Toast notifications =====
let toastTimer = null;
function showToast(msg, undoFn) {
  dismissToast();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span>`;
  if (undoFn) {
    const btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.onclick = () => { dismissToast(); undoFn(); };
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(dismissToast, 5000);
}
function dismissToast() {
  clearTimeout(toastTimer);
  const el = document.querySelector('.toast');
  if (el) el.remove();
}

// zoom is a view setting, not plan data — not persisted, resets each session
let roomZoom = 1;
const ZOOM_MIN = 0.4, ZOOM_MAX = 3;
// below this pixel width a seat shows an initials avatar (name on hover) instead of the full name —
// zooming in grows seats past this and the full name just appears
const SEAT_LEGIBLE_PX = 56;

// contextual relationship picker state (used by toggleSelectGuest, defined fully in Relationships section)
let pairSelectId = null;
let relPickerEl = null;
function closeRelPicker() {
  if (relPickerEl) { relPickerEl.remove(); relPickerEl = null; }
  if (pairSelectId) { pairSelectId = null; renderAll(); }
}

// click-to-place: an alternative to drag-and-drop — click a guest, then click a seat (or the
// empty pool background to unseat). Transient UI state, not persisted.
let selectedGuestId = null;
function toggleSelectGuest(id, ev) {
  if (ev && ev.shiftKey) {
    ev.stopPropagation();
    if (!pairSelectId) {
      pairSelectId = id;
      renderAll();
    } else if (pairSelectId === id) {
      pairSelectId = null;
      renderAll();
    } else {
      showRelPicker(pairSelectId, id, ev.clientX, ev.clientY);
      pairSelectId = null;
    }
    return;
  }
  if (pairSelectId) { closeRelPicker(); return; }
  selectedGuestId = (selectedGuestId === id) ? null : id;
  renderAll();
}
function trySeatSelected(tableId, seatIndex) {
  if (!selectedGuestId) return;
  placeGuest(selectedGuestId, tableId, seatIndex);
  selectedGuestId = null;
}
function unseatSelected() {
  if (!selectedGuestId) return;
  removeGuestFromAllSeats(selectedGuestId);
  selectedGuestId = null;
  save(); renderAll();
}

// safety net: a guest chip dropped anywhere other than a seat/pool must not leak its id into a text field
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) { e.preventDefault(); undo(); }
  else if (e.key === 'Escape' && document.getElementById('kbdOverlay')) { toggleKbdHelp(); }
  else if (e.key === 'Escape' && pairSelectId) { closeRelPicker(); }
  else if (e.key === 'Escape' && selectedGuestId) { selectedGuestId = null; renderAll(); }
  else if (e.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) && !e.target.isContentEditable) { toggleKbdHelp(); }
});

// ===== Guests =====

function addGuests() {
  const names = document.getElementById('guestPaste').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) return;

  // warn on duplicates (against existing guests and within the pasted batch itself) —
  // doesn't block adding them, since two genuine namesakes are a real possibility
  const existing = new Set(state.guests.map(g => g.name.toLowerCase()));
  const seenInBatch = new Set();
  const dupes = new Set();
  names.forEach(name => {
    const key = name.toLowerCase();
    if (existing.has(key) || seenInBatch.has(key)) dupes.add(name);
    seenInBatch.add(key);
  });

  names.forEach(name => state.guests.push({ id: crypto.randomUUID(), name, groups: [] }));
  document.getElementById('guestPaste').value = '';
  save(); renderAll();

  if (dupes.size) alert(`Heads up — these names already appear more than once:\n${[...dupes].join(', ')}\n\nThey were still added. Rename or remove one if that wasn't intentional.`);
}

function renameGuest(id) {
  const guest = guestById(id);
  const chipEl = document.querySelector(`[data-guest-id="${id}"].chip`);
  if (!chipEl) { const name = prompt('Rename guest', guest.name); if (!name || !name.trim()) return; guest.name = name.trim(); save(); renderAll(); return; }
  const nameSpan = chipEl.querySelector('span.name');
  if (!nameSpan || nameSpan.contentEditable === 'true') return;
  nameSpan.contentEditable = 'true';
  nameSpan.focus();
  const range = document.createRange(); range.selectNodeContents(nameSpan); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  nameSpan.style.cursor = 'text';
  chipEl.draggable = false;
  const commit = () => {
    nameSpan.contentEditable = 'false';
    nameSpan.style.cursor = '';
    chipEl.draggable = true;
    const val = nameSpan.textContent.trim();
    if (val && val !== guest.name) { guest.name = val; save(); renderAll(); }
    else { nameSpan.textContent = guest.name; }
  };
  nameSpan.onblur = commit;
  nameSpan.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur(); } else if (e.key === 'Escape') { nameSpan.textContent = guest.name; nameSpan.blur(); } };
}

function deleteGuest(id) {
  const guest = guestById(id);
  const snapshot = JSON.stringify(state);
  if (openGroupPickerState && openGroupPickerState.guestId === id) closeGroupPicker();
  removeGuestFromAllSeats(id);
  state.rels = state.rels.filter(r => r.a !== id && r.b !== id);
  state.guests = state.guests.filter(g => g.id !== id);
  if (selectedGuestId === id) selectedGuestId = null;
  save(); renderAll();
  showToast(`Removed ${guest.name}`, () => {
    const restored = JSON.parse(snapshot);
    state.guests = migrateGuestGroups(restored.guests || []);
    state.groups = restored.groups || [];
    state.rels = restored.rels || [];
    state.tables = migrateTablePositions(restored.tables || []);
    save(); renderAll();
  });
}

// ===== Groups =====

function addGroup() {
  const name = document.getElementById('groupName').value.trim();
  if (!name) return;
  state.groups.push({ id: crypto.randomUUID(), name, color: document.getElementById('groupColor').value });
  document.getElementById('groupName').value = '';
  save(); renderAll();
}
function deleteGroup(id) {
  state.groups = state.groups.filter(g => g.id !== id);
  state.guests.forEach(g => { g.groups = g.groups.filter(gid => gid !== id); });
  save(); renderAll();
}

// small popover for toggling a guest's group membership (checkboxes, not a single-select) —
// works the same whether the guest is unseated in the pool or already seated at a table
let openGroupPickerState = null;
function closeGroupPicker() {
  if (!openGroupPickerState) return;
  openGroupPickerState.panel.remove();
  document.removeEventListener('mousedown', openGroupPickerState.onOutside, true);
  openGroupPickerState = null;
  renderAll();
}
function openGroupPicker(guestId, anchorEl) {
  if (openGroupPickerState && openGroupPickerState.guestId === guestId) { closeGroupPicker(); return; }
  closeGroupPicker();
  const guest = guestById(guestId);
  const panel = document.createElement('div');
  panel.className = 'group-picker';
  panel.innerHTML = state.groups.length
    ? state.groups.map(g => `<label><input type="checkbox" value="${g.id}" ${guest.groups.includes(g.id) ? 'checked' : ''}><span class="dot" style="background:${g.color}"></span>${g.name}</label>`).join('')
    : `<div class="empty">No groups yet — add one in the sidebar first.</div>`;
  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const set = new Set(guest.groups);
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      guest.groups = [...set];
      save();
    };
  });
  document.body.appendChild(panel);
  const rect = anchorEl.getBoundingClientRect();
  const panelWidth = panel.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
  panel.style.left = left + 'px';
  panel.style.top = (rect.bottom + 4) + 'px';
  const onOutside = e => { if (!panel.contains(e.target) && !anchorEl.contains(e.target)) closeGroupPicker(); };
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  openGroupPickerState = { panel, onOutside, guestId };
}

// ===== Relationships =====

// -- searchable combobox for guest picking --
const comboState = { A: { selectedId: null }, B: { selectedId: null } };

function initCombobox(wrapperId, key) {
  const wrap = document.getElementById(wrapperId);
  const input = wrap.querySelector('input');
  const list = wrap.querySelector('.combobox-list');
  let activeIndex = -1;

  function open() { wrap.classList.add('open'); refreshList(); }
  function close() { wrap.classList.remove('open'); activeIndex = -1; }

  function refreshList() {
    const q = input.value.trim().toLowerCase();
    const otherId = key === 'A' ? comboState.B.selectedId : comboState.A.selectedId;
    let matches = state.guests;
    if (q && !comboState[key].selectedId) matches = matches.filter(g => g.name.toLowerCase().includes(q));
    list.innerHTML = '';
    if (!matches.length) { list.innerHTML = '<div class="combobox-empty">No matches</div>'; return; }

    const grouped = new Map();
    matches.forEach(g => {
      const groupNames = g.groups.map(id => groupById(id)).filter(Boolean).map(gr => gr.name);
      const label = groupNames.length ? groupNames.join(', ') : '';
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(g);
    });

    let idx = 0;
    for (const [groupLabel, guests] of grouped) {
      guests.forEach(g => {
        const item = document.createElement('div');
        item.className = 'combobox-item' + (idx === activeIndex ? ' active' : '');
        if (g.id === otherId) { item.style.opacity = '0.4'; item.title = 'Already selected as the other person'; }
        const dots = g.groups.map(id => groupById(id)).filter(Boolean)
          .slice(0, 3).map(gr => `<span class="dot" style="background:${gr.color}"></span>`).join('');
        item.innerHTML = (dots ? `<span class="cb-dots">${dots}</span>` : '') + g.name;
        const gId = g.id;
        item.onmousedown = e => { e.preventDefault(); select(gId, g.name); };
        list.appendChild(item);
        idx++;
      });
    }
  }

  function select(id, name) {
    comboState[key].selectedId = id;
    input.value = name;
    input.classList.add('has-value');
    close();
  }

  function clearSelection() {
    comboState[key].selectedId = null;
    input.classList.remove('has-value');
  }

  input.addEventListener('focus', () => { if (!comboState[key].selectedId) open(); });
  input.addEventListener('input', () => { clearSelection(); open(); });
  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.combobox-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); refreshList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); refreshList(); }
    else if (e.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
      e.preventDefault();
      items[activeIndex].onmousedown(e);
    }
    else if (e.key === 'Escape') { close(); input.blur(); }
    else if (e.key === 'Backspace' && comboState[key].selectedId) { clearSelection(); input.value = ''; open(); }
  });

  // click on the input when a value is already selected: re-open to allow changing
  input.addEventListener('mousedown', () => {
    if (comboState[key].selectedId) { clearSelection(); input.value = ''; setTimeout(open, 0); }
  });

  document.addEventListener('mousedown', e => { if (!wrap.contains(e.target)) close(); }, true);
}
initCombobox('comboA', 'A');
initCombobox('comboB', 'B');

function addRel() {
  const a = comboState.A.selectedId, b = comboState.B.selectedId;
  const type = document.getElementById('relType').value;
  if (!a || !b || a === b) return;
  if (isDuplicateRel(a, b, type)) return;
  state.rels.push({ id: crypto.randomUUID(), a, b, type });
  comboState.A.selectedId = null; comboState.B.selectedId = null;
  document.querySelector('#comboA input').value = '';
  document.querySelector('#comboB input').value = '';
  document.querySelector('#comboA input').classList.remove('has-value');
  document.querySelector('#comboB input').classList.remove('has-value');
  save(); renderAll();
}

function isDuplicateRel(a, b, type) {
  return state.rels.some(r => r.type === type && ((r.a === a && r.b === b) || (r.a === b && r.b === a)));
}

function bulkAddRels() {
  const text = document.getElementById('relPasteArea').value;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const nameIndex = new Map();
  state.guests.forEach(g => nameIndex.set(g.name.toLowerCase(), g.id));
  const typeAliases = { must: 'must', conflict: 'conflict', knows: 'knows', 'must not': 'conflict', mustnot: 'conflict' };
  let added = 0, skipped = [];
  lines.forEach((line, i) => {
    const parts = line.split(/[,;\t]+/).map(s => s.trim());
    if (parts.length < 2) { skipped.push(`Line ${i+1}: need at least two names`); return; }
    const nameA = parts[0], nameB = parts[1];
    const typeStr = (parts[2] || 'knows').toLowerCase();
    const type = typeAliases[typeStr];
    if (!type) { skipped.push(`Line ${i+1}: unknown type "${parts[2]}"`); return; }
    const idA = nameIndex.get(nameA.toLowerCase()), idB = nameIndex.get(nameB.toLowerCase());
    if (!idA) { skipped.push(`Line ${i+1}: "${nameA}" not found`); return; }
    if (!idB) { skipped.push(`Line ${i+1}: "${nameB}" not found`); return; }
    if (idA === idB) { skipped.push(`Line ${i+1}: same person`); return; }
    if (isDuplicateRel(idA, idB, type)) { skipped.push(`Line ${i+1}: duplicate`); return; }
    state.rels.push({ id: crypto.randomUUID(), a: idA, b: idB, type });
    added++;
  });
  document.getElementById('relPasteArea').value = '';
  save(); renderAll();
  const msg = `Added ${added} relationship${added !== 1 ? 's' : ''}` + (skipped.length ? ` · ${skipped.length} skipped` : '');
  showToast(msg);
  if (skipped.length) console.warn('Bulk relationship import skipped lines:', skipped);
}

function deleteRel(id) {
  const rel = state.rels.find(r => r.id === id);
  const a = guestById(rel?.a), b = guestById(rel?.b);
  state.rels = state.rels.filter(r => r.id !== id);
  save(); renderAll();
  if (a && b) showToast(`Removed ${a.name} — ${b.name} relationship`, () => { state.rels.push(rel); save(); renderAll(); });
}

let activeRelTab = 'all';
function setRelTab(type) {
  activeRelTab = type;
  document.querySelectorAll('.rel-tab').forEach(b => b.classList.toggle('active', b.dataset.filter === type));
  renderAll();
}

function showRelPicker(guestA, guestB, anchorX, anchorY) {
  closeRelPicker();
  const panel = document.createElement('div');
  panel.className = 'rel-picker';
  const nameA = guestById(guestA).name, nameB = guestById(guestB).name;
  panel.innerHTML = `<div class="rp-header">${nameA} & ${nameB}</div>`;
  [
    { type: 'must', label: '↔ Must sit together' },
    { type: 'conflict', label: '⚡ Must NOT sit together' },
    { type: 'knows', label: '~ Know each other' }
  ].forEach(opt => {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    if (isDuplicateRel(guestA, guestB, opt.type)) {
      btn.style.opacity = '0.4';
      btn.title = 'Already added';
      btn.onclick = () => {};
    } else {
      btn.onclick = () => {
        state.rels.push({ id: crypto.randomUUID(), a: guestA, b: guestB, type: opt.type });
        save();
        closeRelPicker();
        renderAll();
      };
    }
    panel.appendChild(btn);
  });
  document.body.appendChild(panel);

  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const left = Math.max(8, Math.min(anchorX, window.innerWidth - pw - 8));
  const top = Math.max(8, Math.min(anchorY, window.innerHeight - ph - 8));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  relPickerEl = panel;

  setTimeout(() => {
    const onOutside = e => { if (!panel.contains(e.target)) { closeRelPicker(); document.removeEventListener('mousedown', onOutside, true); } };
    document.addEventListener('mousedown', onOutside, true);
  }, 0);
}

// -- relationship hover highlighting --
function highlightRelated(guestId) {
  const guest = guestById(guestId);
  const related = new Map();
  state.rels.forEach(r => {
    if (r.a === guestId) related.set(r.b, r.type);
    else if (r.b === guestId) related.set(r.a, r.type);
  });
  const sameGroup = new Set();
  if (guest && guest.groups.length) {
    state.guests.forEach(g => {
      if (g.id !== guestId && g.groups.some(grp => guest.groups.includes(grp))) sameGroup.add(g.id);
    });
  }
  if (!related.size && !sameGroup.size) return;
  document.querySelectorAll('[data-guest-id]').forEach(el => {
    const id = el.dataset.guestId;
    if (id === guestId) return;
    const type = related.get(id);
    if (type) el.classList.add('rel-highlight', 'rel-' + type);
    else if (sameGroup.has(id)) el.classList.add('rel-highlight', 'rel-group');
    else el.classList.add('rel-dimmed');
  });
}
function clearHighlights() {
  document.querySelectorAll('.rel-highlight,.rel-dimmed').forEach(el => {
    el.classList.remove('rel-highlight', 'rel-must', 'rel-conflict', 'rel-knows', 'rel-group', 'rel-dimmed');
  });
}

function unmetMustPairs() {
  return state.rels.filter(r => r.type === 'must').filter(r => {
    const ta = seatedTableOf(r.a), tb = seatedTableOf(r.b);
    return !ta || !tb || ta.id !== tb.id;
  });
}
// "must NOT sit together" pairs that are currently violated (both seated at the same table)
function brokenConflictPairs() {
  return state.rels.filter(r => r.type === 'conflict').filter(r => {
    const ta = seatedTableOf(r.a), tb = seatedTableOf(r.b);
    return ta && tb && ta.id === tb.id;
  });
}

// ===== Plan scoring =====
// "know each other" = share a group, OR have an explicit knows/must relationship.
// (conflict relationships never count as a connection — they're a pure penalty, handled separately.)

function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
function buildKnowsIndex() {
  const pairs = new Set();
  state.rels.forEach(r => { if (r.type === 'knows' || r.type === 'must') pairs.add(pairKey(r.a, r.b)); });
  return pairs;
}
function knowEachOther(aId, bId, knowsPairs) {
  const a = guestById(aId), b = guestById(bId);
  if (a.groups.some(g => b.groups.includes(g))) return true;
  return knowsPairs.has(pairKey(aId, bId));
}

// per-table: blend "nobody sits knowing zero people here" (weighted higher) with overall
// pairwise density — see the write-up for why isolation matters more than raw density.
function tableScoreDetail(table, knowsPairs) {
  const seated = table.seats.filter(Boolean);
  const k = seated.length;
  if (k === 0) return null;
  const connections = new Map(seated.map(id => [id, 0]));
  let connectedPairs = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      if (knowEachOther(seated[i], seated[j], knowsPairs)) {
        connectedPairs++;
        connections.set(seated[i], connections.get(seated[i]) + 1);
        connections.set(seated[j], connections.get(seated[j]) + 1);
      }
    }
  }
  const totalPairs = k * (k - 1) / 2;
  const density = totalPairs ? connectedPairs / totalPairs : 0;
  const isolatedIds = seated.filter(id => connections.get(id) === 0);
  const isolationFree = (k - isolatedIds.length) / k;
  const socialScore = 0.6 * isolationFree + 0.4 * density;
  return { k, isolatedIds, score: socialScore };
}

// returns null finalScore when nobody's seated yet — there's nothing meaningful to grade.
function planScore() {
  const knowsPairs = buildKnowsIndex();
  const details = state.tables
    .map(t => ({ table: t, detail: tableScoreDetail(t, knowsPairs) }))
    .filter(d => d.detail);

  const seatedCount = details.reduce((sum, d) => sum + d.detail.k, 0);
  const tableCount = state.tables.length;
  const emptySeats = state.tables.reduce((sum, t) => sum + tableCapacity(t), 0) - seatedCount;

  if (!seatedCount) {
    return { finalScore: null, mustViolations: unmetMustPairs().length, conflictViolations: brokenConflictPairs().length, worstTable: null, isolatedGuestIds: [], seatedCount: 0, totalGuests: state.guests.length, tableCount, emptySeats };
  }

  const guestWeightedMean = details.reduce((sum, d) => sum + d.detail.score * d.detail.k, 0) / seatedCount;
  const worst = details.reduce((min, d) => (!min || d.detail.score < min.score) ? { id: d.table.id, name: d.table.name, score: d.detail.score } : min, null);
  const softScore = 0.75 * guestWeightedMean + 0.25 * worst.score;

  const mustViolations = unmetMustPairs().length;
  const conflictViolations = brokenConflictPairs().length;
  const finalScore = Math.max(0, Math.min(100, Math.round(softScore * 100 - 30 * (mustViolations + conflictViolations))));

  return {
    finalScore, mustViolations, conflictViolations, worstTable: worst,
    isolatedGuestIds: details.flatMap(d => d.detail.isolatedIds),
    seatedCount, totalGuests: state.guests.length, tableCount, emptySeats,
  };
}

// Table efficiency (few empty seats, no pointless extra tables) is deliberately NOT part of the
// displayed finalScore — it's a logistics concern, not a social one, and a user who leaves
// deliberate breathing room shouldn't see their score drop for it. But the OPTIMIZER needs this
// pressure, or it happily scatters guests across a dozen sparse tables since nothing in finalScore
// tells it not to (a set of near-empty tables can score just as "perfect" as two tidy ones).
function searchScore(s) {
  let tableSizePressure = 0;
  const mustClusterMin = mustClusterMinSize();
  state.tables.forEach(t => {
    const k = t.seats.filter(Boolean).length;
    if (k === 0) return;
    if (k <= 6) tableSizePressure += 4;
    else if (k <= 8) tableSizePressure += 1;
    else if (k <= mustClusterMin) tableSizePressure -= 2;
    else tableSizePressure -= (k - 6) * (k - 6);
  });
  return (s.finalScore ?? -1) + 3 * s.seatedCount - 0.5 * s.emptySeats - 0.5 * s.tableCount + tableSizePressure;
}

function mustClusterMinSize() {
  const mustPairs = state.rels.filter(r => r.type === 'must');
  if (!mustPairs.length) return 0;
  const ids = new Set();
  mustPairs.forEach(r => { ids.add(r.a); ids.add(r.b); });
  const parent = new Map([...ids].map(id => [id, id]));
  function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
  mustPairs.forEach(r => { const ra = find(r.a), rb = find(r.b); if (ra !== rb) parent.set(ra, rb); });
  const sizes = new Map();
  ids.forEach(id => { const r = find(id); sizes.set(r, (sizes.get(r) || 0) + 1); });
  return Math.max(...sizes.values());
}

// Violation count is compared FIRST, strictly — not just folded into the point score. A flat point
// penalty alone can't guarantee "hard constraints dominate" (a small/tightly-packed table can make
// resolving one violation cost more density points than the penalty saves), so the optimizer must
// never be talked into leaving a fixable "must"/"conflict" violation in place for a density gain.
// searchScore (finalScore + parsimony) is the tiebreaker, so equally-constraint-clean plans prefer
// the denser, tidier one — not just the one with the highest raw social-quality number.
function isBetterPlan(a, b) {
  const aViol = a.mustViolations + a.conflictViolations, bViol = b.mustViolations + b.conflictViolations;
  if (aViol !== bViol) return aViol < bViol;
  const aScore = searchScore(a), bScore = searchScore(b);
  if (aScore !== bScore) return aScore > bScore;
  return a.seatedCount > b.seatedCount;
}

let scorePanelEl = null;
function closeScorePanel() {
  if (!scorePanelEl) return;
  scorePanelEl.remove();
  document.removeEventListener('mousedown', onScorePanelOutside, true);
  scorePanelEl = null;
}
function onScorePanelOutside(e) {
  const btn = document.getElementById('scoreBadge');
  if (scorePanelEl && !scorePanelEl.contains(e.target) && e.target !== btn) closeScorePanel();
}
function toggleScorePanel() {
  if (scorePanelEl) { closeScorePanel(); return; }
  const btn = document.getElementById('scoreBadge');
  const s = planScore();
  const panel = document.createElement('div');
  panel.className = 'score-panel';
  if (s.finalScore === null) {
    panel.innerHTML = `<div class="empty">Seat a few guests to see a plan score.</div>`;
  } else {
    const isolatedNames = s.isolatedGuestIds.map(id => guestById(id)?.name).filter(Boolean);
    panel.innerHTML = `
      <div class="score-row"><b>${s.finalScore}/100</b></div>
      <div class="score-row">${s.seatedCount}/${s.totalGuests} guests seated</div>
      ${s.mustViolations ? `<div class="score-row warnrow">⚠ ${s.mustViolations} "must sit together" pair(s) not together</div>` : ''}
      ${s.conflictViolations ? `<div class="score-row warnrow">⛔ ${s.conflictViolations} "must NOT sit together" pair(s) seated together</div>` : ''}
      ${isolatedNames.length ? `<div class="score-row">Sitting with nobody they know: ${isolatedNames.join(', ')}</div>` : ''}
      ${s.worstTable ? `<div class="score-row">Lowest-scoring table: ${s.worstTable.name} (${Math.round(s.worstTable.score * 100)}/100)</div>` : ''}
    `;
  }
  document.body.appendChild(panel);
  const rect = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8));
  panel.style.left = left + 'px';
  panel.style.top = (rect.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onScorePanelOutside, true), 0);
  scorePanelEl = panel;
}

// ===== Plan optimizer =====
// Randomized hill-climbing over BOTH who-sits-where and the table structure itself: swap two seated
// guests, drop an unseated guest into an empty seat, grow/shrink a table's "linked" count, delete an
// empty table, or add a new one. That last set matters because the best structure might not be the
// one you started with — three tables of 4 can score worse than two tables of 6 even with the exact
// same guests, since fewer/bigger tables mean fewer isolated "odd one out" seats.
// Never ejects an already-seated guest to unseated — a "better plan" shouldn't undo the user's
// explicit placements, only rearrange around them, resize around them, and fill gaps.

function cloneAllTables() { return state.tables.map(t => ({ ...t, seats: t.seats.slice() })); }
function restoreAllTables(snapshot) {
  state.tables.length = 0;
  snapshot.forEach(t => state.tables.push({ ...t, seats: t.seats.slice() }));
}

const MAX_LINKED = 12; // generous cap (26 seats) just to keep random growth from running away

function moveSwap() {
  const slots = [];
  state.tables.forEach((t, ti) => t.seats.forEach((_, si) => slots.push([ti, si])));
  if (!slots.length) return null;
  const [ti1, si1] = slots[Math.floor(Math.random() * slots.length)];
  const [ti2, si2] = slots[Math.floor(Math.random() * slots.length)];
  const a = state.tables[ti1].seats[si1], b = state.tables[ti2].seats[si2];
  state.tables[ti1].seats[si1] = b;
  state.tables[ti2].seats[si2] = a;
  return () => { state.tables[ti1].seats[si1] = a; state.tables[ti2].seats[si2] = b; };
}

function movePlaceUnseated() {
  const seatedIds = new Set(state.tables.flatMap(t => t.seats.filter(Boolean)));
  const unseated = state.guests.map(g => g.id).filter(id => !seatedIds.has(id));
  const emptySlots = [];
  state.tables.forEach((t, ti) => t.seats.forEach((v, si) => { if (!v) emptySlots.push([ti, si]); }));
  if (!unseated.length || !emptySlots.length) return null;
  const guestId = unseated[Math.floor(Math.random() * unseated.length)];
  const [ti, si] = emptySlots[Math.floor(Math.random() * emptySlots.length)];
  state.tables[ti].seats[si] = guestId;
  return () => { state.tables[ti].seats[si] = null; };
}

function moveGrowTable() {
  if (!state.tables.length) return null;
  const t = state.tables[Math.floor(Math.random() * state.tables.length)];
  if (t.linked >= MAX_LINKED || tableCapacity(t) >= 8) return null;
  const oldLinked = t.linked, oldSeats = t.seats.slice();
  t.linked += 1;
  t.seats = oldSeats.concat([null, null]); // +1 linked table = +2 seats (one more on each long side)
  return () => { t.linked = oldLinked; t.seats = oldSeats; };
}

function moveShrinkTable() {
  const candidates = state.tables.filter(t => t.linked > 1);
  if (!candidates.length) return null;
  const weights = candidates.map(t => t.linked);
  const totalW = weights.reduce((a, b) => a + b, 0);
  let pick = Math.random() * totalW;
  let t = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) { pick -= weights[i]; if (pick <= 0) { t = candidates[i]; break; } }
  const newCap = 2 * (t.linked - 1) + 2;
  const seated = t.seats.filter(Boolean);
  if (seated.length > newCap) return null; // would evict a seated guest — not allowed
  const oldLinked = t.linked, oldSeats = t.seats.slice();
  t.linked -= 1;
  t.seats = seated.concat(Array(newCap - seated.length).fill(null));
  return () => { t.linked = oldLinked; t.seats = oldSeats; };
}

function moveDeleteEmptyTable() {
  const candidates = state.tables.filter(t => t.seats.every(s => !s));
  if (!candidates.length) return null;
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const idx = state.tables.indexOf(target);
  const [removed] = state.tables.splice(idx, 1);
  return () => { state.tables.splice(idx, 0, removed); };
}

function moveAddTable() {
  if (state.tables.length >= state.guests.length + 2) return null; // sanity cap, not a real limit
  pushNewTable();
  const addedIdx = state.tables.length - 1;
  return () => { state.tables.splice(addedIdx, 1); };
}

// physically pushing two tables into one row loses 2 seats (the two inner "ends" disappear into
// the join) — same math as growing, just for two existing tables at once. This is what lets the
// search find "3 tables of 4 -> 2 tables of 6" directly, instead of hoping grow+swap+swap+delete
// happen to land in the right combination by chance.
function moveMergeTables() {
  if (state.tables.length < 2) return null;
  const idx1 = Math.floor(Math.random() * state.tables.length);
  let idx2 = Math.floor(Math.random() * state.tables.length);
  if (idx1 === idx2) return null;
  const tableA = state.tables[idx1], tableB = state.tables[idx2];
  const newLinked = tableA.linked + tableB.linked;
  if (newLinked > MAX_LINKED) return null;
  const newCap = 2 * newLinked + 2;
  if (newCap > 8) return null;
  const combinedSeated = tableA.seats.filter(Boolean).concat(tableB.seats.filter(Boolean));
  if (combinedSeated.length > newCap) return null; // would lose more seats than are spare — not allowed

  const oldLinked = tableA.linked, oldSeats = tableA.seats.slice();
  const removedIdx = state.tables.indexOf(tableB);
  state.tables.splice(removedIdx, 1);
  tableA.linked = newLinked;
  tableA.seats = combinedSeated.concat(Array(newCap - combinedSeated.length).fill(null));

  return () => {
    tableA.linked = oldLinked;
    tableA.seats = oldSeats;
    state.tables.splice(removedIdx, 0, tableB);
  };
}

// inverse of merge: pull a table apart into two smaller ones, distributing seated guests
// between them. Splitting a linked=1 table (4 seats) would produce two linked=1 tables (4+4),
// so the minimum candidate is linked>=2. Guests are split roughly in half; the halves are
// assigned randomly so the search can discover better social groupings via subsequent swaps.
function moveSplitTable() {
  const candidates = state.tables.filter(t => t.linked >= 2);
  if (!candidates.length) return null;
  const weights = candidates.map(t => t.linked * t.linked);
  const totalW = weights.reduce((a, b) => a + b, 0);
  let pick = Math.random() * totalW;
  let t = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) { pick -= weights[i]; if (pick <= 0) { t = candidates[i]; break; } }
  const seated = t.seats.filter(Boolean);
  // shuffle seated guests so the split is random each time
  for (let i = seated.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seated[i], seated[j]] = [seated[j], seated[i]];
  }
  const linkedA = Math.floor(t.linked / 2);
  const linkedB = t.linked - linkedA;
  const capA = 2 * linkedA + 2, capB = 2 * linkedB + 2;
  const halfA = seated.slice(0, Math.min(seated.length, capA));
  const halfB = seated.slice(halfA.length, halfA.length + Math.min(seated.length - halfA.length, capB));
  if (halfA.length > capA || halfB.length > capB) return null; // shouldn't happen, but guard

  const oldLinked = t.linked, oldSeats = t.seats.slice();
  const insertIdx = state.tables.indexOf(t) + 1;
  t.linked = linkedA;
  t.seats = halfA.concat(Array(capA - halfA.length).fill(null));
  const newTable = { id: crypto.randomUUID(), name: t.name + 'b', linked: linkedB, seats: halfB.concat(Array(capB - halfB.length).fill(null)), x: t.x + 20, y: t.y + 20 };
  state.tables.splice(insertIdx, 0, newTable);

  return () => {
    t.linked = oldLinked;
    t.seats = oldSeats;
    state.tables.splice(insertIdx, 1);
  };
}

function moveEjectFromOversized() {
  const big = state.tables.filter(t => tableCapacity(t) > 8 && t.seats.filter(Boolean).length > 6);
  if (!big.length) return null;
  const t = big.reduce((a, b) => tableCapacity(a) > tableCapacity(b) ? a : b);
  const mustPartners = new Set();
  state.rels.filter(r => r.type === 'must').forEach(r => {
    if (t.seats.includes(r.a)) mustPartners.add(r.b);
    if (t.seats.includes(r.b)) mustPartners.add(r.a);
  });
  const ejectCandidates = t.seats
    .map((id, si) => [id, si])
    .filter(([id]) => id && !mustPartners.has(id));
  if (!ejectCandidates.length) return null;
  const [guestId, srcSi] = ejectCandidates[Math.floor(Math.random() * ejectCandidates.length)];
  const otherSlots = [];
  state.tables.forEach((ot, ti) => {
    if (ot === t) return;
    ot.seats.forEach((v, si) => { if (!v) otherSlots.push([ti, si]); });
  });
  if (!otherSlots.length) return null;
  const [dstTi, dstSi] = otherSlots[Math.floor(Math.random() * otherSlots.length)];
  t.seats[srcSi] = null;
  state.tables[dstTi].seats[dstSi] = guestId;
  return () => { state.tables[dstTi].seats[dstSi] = null; t.seats[srcSi] = guestId; };
}

function moveFixIsolated() {
  const knowsPairs = buildKnowsIndex();
  const isolated = [];
  state.tables.forEach((t, ti) => {
    const seated = t.seats.filter(Boolean);
    seated.forEach(id => {
      const knows = seated.some(other => other !== id && knowEachOther(id, other, knowsPairs));
      if (!knows) isolated.push({ id, ti });
    });
  });
  if (!isolated.length) return null;
  const pick = isolated[Math.floor(Math.random() * isolated.length)];
  const guest = guestById(pick.id);
  if (!guest) return null;
  const guestGroups = new Set(guest.groups);
  const candidates = [];
  state.tables.forEach((t, ti) => {
    if (ti === pick.ti) return;
    const seated = t.seats.filter(Boolean);
    const hasGroupmate = seated.some(otherId => {
      const other = guestById(otherId);
      return other && other.groups.some(g => guestGroups.has(g));
    });
    if (!hasGroupmate) return;
    seated.forEach((otherId, si) => {
      if (!otherId) return;
      const otherGuest = guestById(otherId);
      const otherHasLocalFriends = seated.some(x => x && x !== otherId && knowEachOther(otherId, x, knowsPairs));
      if (otherHasLocalFriends) candidates.push({ ti, si, otherId });
    });
  });
  if (!candidates.length) return null;
  const dst = candidates[Math.floor(Math.random() * candidates.length)];
  const srcSi = state.tables[pick.ti].seats.indexOf(pick.id);
  state.tables[pick.ti].seats[srcSi] = dst.otherId;
  state.tables[dst.ti].seats[dst.si] = pick.id;
  return () => {
    state.tables[pick.ti].seats[srcSi] = pick.id;
    state.tables[dst.ti].seats[dst.si] = dst.otherId;
  };
}

function moveRelocateIsolated() {
  const knowsPairs = buildKnowsIndex();
  const isolated = [];
  state.tables.forEach((t, ti) => {
    const seated = t.seats.filter(Boolean);
    seated.forEach(id => {
      if (!seated.some(other => other !== id && knowEachOther(id, other, knowsPairs))) {
        isolated.push({ id, ti });
      }
    });
  });
  if (!isolated.length) return null;
  const pick = isolated[Math.floor(Math.random() * isolated.length)];
  const guest = guestById(pick.id);
  if (!guest) return null;
  const guestGroups = new Set(guest.groups);
  const emptySlots = [];
  state.tables.forEach((t, ti) => {
    if (ti === pick.ti) return;
    const seated = t.seats.filter(Boolean);
    const hasGroupmate = seated.some(otherId => {
      const other = guestById(otherId);
      return other && other.groups.some(g => guestGroups.has(g));
    });
    if (!hasGroupmate) return;
    t.seats.forEach((v, si) => { if (!v) emptySlots.push({ ti, si }); });
  });
  if (!emptySlots.length) return null;
  const dst = emptySlots[Math.floor(Math.random() * emptySlots.length)];
  const srcSi = state.tables[pick.ti].seats.indexOf(pick.id);
  state.tables[pick.ti].seats[srcSi] = null;
  state.tables[dst.ti].seats[dst.si] = pick.id;
  return () => {
    state.tables[dst.ti].seats[dst.si] = null;
    state.tables[pick.ti].seats[srcSi] = pick.id;
  };
}

function moveCycleSwap() {
  const occupied = [];
  state.tables.forEach((t, ti) => {
    t.seats.forEach((id, si) => { if (id) occupied.push({ ti, si, id }); });
  });
  if (occupied.length < 3) return null;
  const i0 = Math.floor(Math.random() * occupied.length);
  let i1 = Math.floor(Math.random() * occupied.length);
  if (i1 === i0) return null;
  let i2 = Math.floor(Math.random() * occupied.length);
  if (i2 === i0 || i2 === i1) return null;
  const a = occupied[i0], b = occupied[i1], c = occupied[i2];
  state.tables[a.ti].seats[a.si] = c.id;
  state.tables[b.ti].seats[b.si] = a.id;
  state.tables[c.ti].seats[c.si] = b.id;
  return () => {
    state.tables[a.ti].seats[a.si] = a.id;
    state.tables[b.ti].seats[b.si] = b.id;
    state.tables[c.ti].seats[c.si] = c.id;
  };
}

function randomMoveInPlace() {
  const r = Math.random();
  if (r < 0.15) return moveSwap();
  if (r < 0.27) return moveFixIsolated();
  if (r < 0.39) return moveRelocateIsolated();
  if (r < 0.49) return moveCycleSwap();
  if (r < 0.56) return movePlaceUnseated();
  if (r < 0.59) return moveGrowTable();
  if (r < 0.66) return moveShrinkTable();
  if (r < 0.69) return moveDeleteEmptyTable();
  if (r < 0.72) return moveMergeTables();
  if (r < 0.82) return moveSplitTable();
  if (r < 0.94) return moveEjectFromOversized();
  return moveAddTable();
}

// Guarantees every unseated guest gets a seat, deterministically — never left to chance, and never
// splits a "must sit together" cluster (that's a hard constraint, not a preference — shared-group
// membership is deliberately NOT clustered here, since that's a soft signal the stochastic search
// already optimizes for via scoring; forcing it into the seed step here previously caused clusters
// of a dozen+ people — e.g. a big family group — to be sliced into arbitrary 4-seat chunks by array
// order, scattering "must" pairs across different tables before the search even began).
function greedySeatEveryone() {
  const unseated = state.guests.map(g => g.id).filter(id => !seatedTableOf(id));
  if (!unseated.length) return;

  const parent = new Map(unseated.map(id => [id, id]));
  function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }

  state.rels.filter(r => r.type === 'must').forEach(r => {
    if (parent.has(r.a) && parent.has(r.b)) union(r.a, r.b);
  });

  const byCluster = new Map();
  unseated.forEach(id => {
    const key = find(id);
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(id);
  });

  // Pack clusters into as few tables as possible (first-fit-decreasing bin packing) instead of one
  // table per cluster — most guests have no "must" partner at all and would otherwise each get a
  // whole table to themselves. A cluster is never split across bins, so "must" pairs stay intact;
  // the stochastic search then only has to polish this for social fit (and split it back up if a
  // packed-together bin scores badly), not discover the consolidation from scratch.
  const greedyCap = 6;
  const hardMaxCap = 2 * MAX_LINKED + 2;
  const clusterGroups = cluster => {
    const gs = new Set();
    cluster.forEach(id => { const g = guestById(id); if (g) g.groups.forEach(gid => gs.add(gid)); });
    return gs;
  };
  const bins = [];
  const binGroups = [];
  [...byCluster.values()].sort((a, b) => b.length - a.length).forEach(cluster => {
    if (cluster.length > hardMaxCap) {
      for (let i = 0; i < cluster.length; i += hardMaxCap) {
        const chunk = cluster.slice(i, i + hardMaxCap);
        bins.push(chunk);
        binGroups.push(clusterGroups(chunk));
      }
      return;
    }
    const cGroups = clusterGroups(cluster);
    const binCap = Math.max(greedyCap, cluster.length);
    let target = null, targetIdx = -1, bestScore = -Infinity;
    bins.forEach((bin, bi) => {
      const remaining = binCap - bin.length;
      if (cluster.length > remaining) return;
      let overlap = 0;
      cGroups.forEach(g => { if (binGroups[bi].has(g)) overlap++; });
      const score = overlap * 100 - remaining;
      if (score > bestScore) { target = bin; targetIdx = bi; bestScore = score; }
    });
    if (target) {
      target.push(...cluster);
      cGroups.forEach(g => binGroups[targetIdx].add(g));
    } else {
      bins.push(cluster.slice());
      binGroups.push(cGroups);
    }
  });

  bins.forEach(ids => {
    pushNewTable();
    const table = state.tables[state.tables.length - 1];
    table.linked = Math.max(1, Math.ceil((ids.length - 2) / 2));
    table.seats = Array(tableCapacity(table)).fill(null);
    ids.forEach((id, k) => { table.seats[k] = id; });
  });
}

// simulated annealing, not strict hill-climbing: reaching a better arrangement (e.g. "these two
// groups got shuffled together, un-shuffle them") often requires one swap that looks *worse*
// before a second swap pays off. Never accepting a worse move gets stuck in exactly that trap —
// so early on (temperature high) we sometimes accept a worse move to escape it, cooling toward
// pure-greedy by the end. The best state seen at any point is tracked separately and restored
// at the end, since the annealed "current" state can wander below it.
function hillClimb(iterations) {
  let currentScore = searchScore(planScore());
  let bestPlan = planScore(); // full object, so "best" is judged by isBetterPlan (violations dominate), not the raw scalar used for SA acceptance
  let bestSnapshot = cloneAllTables();
  for (let i = 0; i < iterations; i++) {
    const undo = randomMoveInPlace();
    if (!undo) continue;
    const newPlan = planScore();
    const newScore = searchScore(newPlan);
    const delta = newScore - currentScore;
    const temperature = 60 * (1 - i / iterations) + 0.5;
    if (delta >= 0 || Math.random() < Math.exp(delta / temperature)) {
      currentScore = newScore;
      if (isBetterPlan(newPlan, bestPlan)) { bestPlan = newPlan; bestSnapshot = cloneAllTables(); }
    } else {
      undo();
    }
  }
  restoreAllTables(bestSnapshot);
}

function runSeatingOptimizer(milpSnapshot) {
  const trueOriginalSnapshot = cloneAllTables();
  const trueOriginalScore = planScore();
  if (!state.guests.length) { alert('Add some guests first — there\'s nothing to seat yet.'); return; }

  greedySeatEveryone();
  const workingBaseline = cloneAllTables();

  function makeSmallTableSeed() {
    restoreAllTables(workingBaseline);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of state.tables) {
        if (t.linked >= 2 && t.seats.filter(Boolean).length > 4) {
          const seated = t.seats.filter(Boolean);
          for (let i = seated.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [seated[i], seated[j]] = [seated[j], seated[i]];
          }
          const linkedA = Math.floor(t.linked / 2);
          const linkedB = t.linked - linkedA;
          const capA = 2 * linkedA + 2, capB = 2 * linkedB + 2;
          const halfA = seated.slice(0, Math.min(seated.length, capA));
          const halfB = seated.slice(halfA.length, halfA.length + Math.min(seated.length - halfA.length, capB));
          if (halfA.length <= capA && halfB.length <= capB) {
            const idx = state.tables.indexOf(t);
            t.linked = linkedA;
            t.seats = halfA.concat(Array(capA - halfA.length).fill(null));
            state.tables.splice(idx + 1, 0, {
              id: crypto.randomUUID(), name: t.name + 's', linked: linkedB,
              seats: halfB.concat(Array(capB - halfB.length).fill(null)),
              x: t.x + 20, y: t.y + 20,
            });
            changed = true;
            break;
          }
        }
      }
    }
    return cloneAllTables();
  }
  const smallSeed = makeSmallTableSeed();

  function makeRoundRobinSeed() {
    const mustPairs = state.rels.filter(r => r.type === 'must');
    const allIds = state.guests.map(g => g.id);
    const parent = new Map(allIds.map(id => [id, id]));
    function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
    mustPairs.forEach(r => { const ra = find(r.a), rb = find(r.b); if (ra !== rb) parent.set(ra, rb); });
    const byCluster = new Map();
    allIds.forEach(id => { const k = find(id); if (!byCluster.has(k)) byCluster.set(k, []); byCluster.get(k).push(id); });
    const clusters = [...byCluster.values()].sort((a, b) => b.length - a.length);

    const tableCap = 6;
    const numTables = Math.max(1, Math.ceil(allIds.length / tableCap));
    const bins = Array.from({ length: numTables }, () => []);

    const bigClusters = clusters.filter(c => c.length > 1);
    const singletons = clusters.filter(c => c.length === 1).map(c => c[0]);

    bigClusters.forEach(cluster => {
      let best = 0, bestCount = Infinity;
      bins.forEach((b, i) => { if (b.length < bestCount) { bestCount = b.length; best = i; } });
      if (bins[best].length + cluster.length <= tableCap) {
        bins[best].push(...cluster);
      } else {
        cluster.forEach((id, ci) => {
          const ti = (best + ci) % numTables;
          bins[ti].push(id);
        });
      }
    });

    const groupMembers = new Map();
    singletons.forEach(id => {
      const g = guestById(id);
      if (g) g.groups.forEach(gid => {
        if (!groupMembers.has(gid)) groupMembers.set(gid, []);
        groupMembers.get(gid).push(id);
      });
    });
    const groups = [...groupMembers.entries()].sort((a, b) => b[1].length - a[1].length);
    const placed = new Set(bigClusters.flat());

    groups.forEach(([, members]) => {
      const unplaced = members.filter(id => !placed.has(id));
      for (let i = unplaced.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unplaced[i], unplaced[j]] = [unplaced[j], unplaced[i]];
      }
      let ti = Math.floor(Math.random() * numTables);
      unplaced.forEach(id => {
        let attempts = numTables;
        while (bins[ti].length >= tableCap && attempts-- > 0) ti = (ti + 1) % numTables;
        bins[ti].push(id);
        placed.add(id);
        ti = (ti + 1) % numTables;
      });
    });

    singletons.filter(id => !placed.has(id)).forEach(id => {
      let best = 0, bestCount = Infinity;
      bins.forEach((b, i) => { if (b.length < bestCount) { bestCount = b.length; best = i; } });
      bins[best].push(id);
    });

    const tables = bins.filter(b => b.length > 0).map(b => {
      const linked = Math.max(1, Math.ceil((b.length - 2) / 2));
      const cap = 2 * linked + 2;
      return {
        id: crypto.randomUUID(), name: 'T', linked,
        seats: b.slice(0, cap).concat(Array(Math.max(0, cap - b.length)).fill(null)),
        x: 60, y: 60,
      };
    });
    state.tables.length = 0;
    tables.forEach(t => state.tables.push(t));
    return cloneAllTables();
  }
  const roundRobinSeed = makeRoundRobinSeed();

  let milpSeed = null;
  if (milpSnapshot) {
    restoreAllTables(milpSnapshot.map(t => ({ ...t, seats: [...t.seats] })));
    milpSeed = cloneAllTables();
  }

  const RESTARTS = 16, ITERATIONS = 8000;
  let bestSnapshot = workingBaseline, bestScore = planScore();

  if (milpSeed) {
    restoreAllTables(milpSeed);
    const milpScore = planScore();
    if (isBetterPlan(milpScore, bestScore)) { bestScore = milpScore; bestSnapshot = cloneAllTables(); }
  }

  for (let r = 0; r < RESTARTS; r++) {
    if (milpSeed && r < 2) restoreAllTables(milpSeed);
    else if (r < 4) restoreAllTables(workingBaseline);
    else if (r < 10) restoreAllTables(roundRobinSeed);
    else restoreAllTables(smallSeed);
    hillClimb(ITERATIONS);
    const candidateScore = planScore();
    if (isBetterPlan(candidateScore, bestScore)) { bestScore = candidateScore; bestSnapshot = cloneAllTables(); }
  }
  restoreAllTables(trueOriginalSnapshot); // don't leave state mutated while asking for confirmation

  if (!isBetterPlan(bestScore, trueOriginalScore)) {
    const scoreNote = trueOriginalScore.finalScore === null ? '' : ` (current score: ${trueOriginalScore.finalScore}/100)`;
    alert(`No better arrangement found this run${scoreNote}. Your seating may already be solid — feel free to try again for a different random search.`);
    return;
  }

  const seatedDelta = bestScore.seatedCount - trueOriginalScore.seatedCount;
  const violDelta = (trueOriginalScore.mustViolations + trueOriginalScore.conflictViolations) - (bestScore.mustViolations + bestScore.conflictViolations);
  const extras = [];
  if (violDelta > 0) extras.push(`resolves ${violDelta} constraint violation${violDelta === 1 ? '' : 's'}`);
  if (seatedDelta > 0) extras.push(`seats ${seatedDelta} more guest${seatedDelta === 1 ? '' : 's'}`);
  if (bestSnapshot.length !== trueOriginalSnapshot.length) extras.push(`${bestSnapshot.length} table${bestSnapshot.length === 1 ? '' : 's'} instead of ${trueOriginalSnapshot.length}`);
  const fromScore = trueOriginalScore.finalScore === null ? 'no plan yet' : trueOriginalScore.finalScore;
  const msg = `Found a better arrangement: ${fromScore} → ${bestScore.finalScore}/100` +
    (extras.length ? ` (${extras.join(', ')})` : '') +
    `.\n\nApply this arrangement? (You can still Undo afterward.)`;
  if (!confirm(msg)) return;

  restoreAllTables(bestSnapshot);
  save(); renderAll();
}

// ===== MILP Optimizer (client-side, HiGHS WASM) =====
// Formulates guest-to-table assignment as a mixed-integer linear program and solves it
// optimally. Generates candidate tables biased toward smaller sizes (better for conversation)
// and lets the solver pick which to activate and who sits where.

let _highsSolver = null;
const _highsReady = (async () => {
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/highs/+esm');
    _highsSolver = await m.default();
  } catch (e) { console.warn('HiGHS WASM unavailable:', e); }
})();

function milpConversationBonus(cap) { return cap <= 6 ? 3 : cap <= 8 ? 1 : 0; }

function buildMILPModel() {
  const N = state.guests.length;
  if (!N) return null;
  const guestIds = state.guests.map(g => g.id);
  const gIdx = new Map(guestIds.map((id, i) => [id, i]));

  const knowsIdx = buildKnowsIndex();
  const knowsPairs = [];
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      if (knowEachOther(guestIds[i], guestIds[j], knowsIdx))
        knowsPairs.push([i, j]);

  const mustPairs = state.rels.filter(r => r.type === 'must')
    .map(r => [gIdx.get(r.a), gIdx.get(r.b)])
    .filter(([a, b]) => a != null && b != null);

  const conflictPairs = state.rels.filter(r => r.type === 'conflict')
    .map(r => [gIdx.get(r.a), gIdx.get(r.b)])
    .filter(([a, b]) => a != null && b != null);

  // union-find for must-clusters to determine minimum table size
  const par = Array.from({ length: N }, (_, i) => i);
  function find(x) { return par[x] === x ? x : (par[x] = find(par[x])); }
  mustPairs.forEach(([a, b]) => { par[find(a)] = find(b); });
  let maxCluster = 1;
  const csz = new Map();
  for (let i = 0; i < N; i++) { const r = find(i); csz.set(r, (csz.get(r) || 0) + 1); }
  csz.forEach(v => { if (v > maxCluster) maxCluster = v; });

  const sizes = [{ linked: 1, cap: 4 }];
  if (N > 4 || maxCluster > 4) sizes.push({ linked: 2, cap: 6 });
  if (N > 12 || maxCluster > 6) sizes.push({ linked: 3, cap: 8 });
  if (N > 20 || maxCluster > 8) sizes.push({ linked: 4, cap: 10 });
  if (N > 30 || maxCluster > 10) sizes.push({ linked: 5, cap: 12 });
  if (maxCluster > 12) { const lk = Math.ceil((maxCluster - 2) / 2); sizes.push({ linked: lk, cap: 2 * lk + 2 }); }

  const candidates = [];
  sizes.forEach(s => {
    const count = Math.ceil(N / s.cap) + 1;
    for (let k = 0; k < count; k++) candidates.push({ ...s });
  });
  const T = candidates.length;

  // --- build LP string ---
  const obj = [];

  knowsPairs.forEach((_, k) => { for (let t = 0; t < T; t++) obj.push(`p${k}t${t}`); });
  for (let i = 0; i < N; i++) obj.push(`5 w${i}`);
  for (let i = 0; i < N; i++)
    for (let t = 0; t < T; t++) {
      const b = milpConversationBonus(candidates[t].cap);
      if (b > 0) obj.push(`${b} g${i}t${t}`);
    }
  candidates.forEach((c, t) => obj.push(`- ${1 + 0.15 * c.cap * c.cap / 8} u${t}`));

  let lp = 'Maximize\n obj: ' + (obj.length ? obj.join(' + ').replace(/\+ - /g, '- ') : '0') + '\n';
  lp += 'Subject To\n';

  for (let i = 0; i < N; i++) {
    const ts = []; for (let t = 0; t < T; t++) ts.push(`g${i}t${t}`);
    lp += ` a${i}: ${ts.join(' + ')} = 1\n`;
  }
  candidates.forEach((c, t) => {
    const ts = []; for (let i = 0; i < N; i++) ts.push(`g${i}t${t}`);
    lp += ` cp${t}: ${ts.join(' + ')} - ${c.cap} u${t} <= 0\n`;
  });
  mustPairs.forEach(([a, b], m) => {
    for (let t = 0; t < T; t++) lp += ` m${m}t${t}: g${a}t${t} - g${b}t${t} = 0\n`;
  });
  conflictPairs.forEach(([a, b], ci) => {
    for (let t = 0; t < T; t++) lp += ` cf${ci}t${t}: g${a}t${t} + g${b}t${t} <= 1\n`;
  });
  knowsPairs.forEach(([i, j], k) => {
    for (let t = 0; t < T; t++) {
      lp += ` ya${k}t${t}: p${k}t${t} - g${i}t${t} <= 0\n`;
      lp += ` yb${k}t${t}: p${k}t${t} - g${j}t${t} <= 0\n`;
    }
  });
  for (let i = 0; i < N; i++) {
    const yts = [];
    knowsPairs.forEach(([a, b], k) => {
      if (a === i || b === i) for (let t = 0; t < T; t++) yts.push(`p${k}t${t}`);
    });
    lp += yts.length ? ` wb${i}: w${i} - ${yts.join(' - ')} <= 0\n` : ` wb${i}: w${i} <= 0\n`;
  }

  lp += 'Bounds\n';
  knowsPairs.forEach((_, k) => { for (let t = 0; t < T; t++) lp += ` 0 <= p${k}t${t} <= 1\n`; });
  for (let i = 0; i < N; i++) lp += ` 0 <= w${i} <= 1\n`;

  lp += 'Binary\n';
  const bins = [];
  for (let i = 0; i < N; i++) for (let t = 0; t < T; t++) bins.push(`g${i}t${t}`);
  candidates.forEach((_, t) => bins.push(`u${t}`));
  lp += ' ' + bins.join(' ') + '\n';
  lp += 'End\n';

  return { lp, candidates, guestIds };
}

function applyMILPSolution(result, candidates, guestIds) {
  const newTables = [];
  candidates.forEach((c, t) => {
    if ((result.Columns[`u${t}`]?.Primal ?? 0) < 0.5) return;
    const seated = [];
    guestIds.forEach((gid, i) => {
      if ((result.Columns[`g${i}t${t}`]?.Primal ?? 0) > 0.5) seated.push(gid);
    });
    if (!seated.length) return;
    const linked = Math.max(1, Math.ceil((seated.length - 2) / 2));
    const cap = 2 * linked + 2;
    newTables.push({
      id: crypto.randomUUID(), name: `Table ${newTables.length + 1}`,
      linked, seats: seated.concat(Array(Math.max(0, cap - seated.length)).fill(null)),
      x: 40, y: 40,
    });
  });
  newTables.forEach((t, i) => {
    const fp = tableFootprint(t.linked);
    t.x = 40 + (i % 4) * (fp.width + 40);
    t.y = 40 + Math.floor(i / 4) * (fp.height + 50);
  });
  return newTables;
}

async function runMILP() {
  const solver = _highsSolver || (await _highsReady, _highsSolver);
  if (!solver) throw new Error('MILP solver unavailable (no network?)');
  const model = buildMILPModel();
  if (!model) throw new Error('No guests');
  const result = solver.solve(model.lp);
  if (result.Status !== 'Optimal') throw new Error('Solver: ' + result.Status);
  return applyMILPSolution(result, model.candidates, model.guestIds);
}

async function suggestBetterPlan() {
  if (!state.guests.length) { alert('Add some guests first — there\'s nothing to seat yet.'); return; }
  const btn = document.getElementById('optimizeBtn');
  btn.disabled = true;
  try {
    let milpSnapshot = null;
    try {
      btn.textContent = 'Loading solver…';
      const milpTables = await runMILP();
      btn.textContent = 'Evaluating…';
      const snap = cloneAllTables();
      state.tables.length = 0;
      milpTables.forEach(t => state.tables.push(t));
      const milpScore = planScore();
      restoreAllTables(snap);
      if (milpScore.finalScore !== null) {
        milpSnapshot = milpTables;
      }
    } catch (e) { console.warn('MILP:', e.message); }

    btn.textContent = 'Optimizing…';
    await new Promise(r => setTimeout(r, 20));
    runSeatingOptimizer(milpSnapshot);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Suggest better plan';
  }
}

// ===== Whole-plan reset / share =====

// ===== Keyboard shortcut help =====

function toggleKbdHelp() {
  let overlay = document.getElementById('kbdOverlay');
  if (overlay) { overlay.remove(); return; }
  overlay = document.createElement('div');
  overlay.id = 'kbdOverlay';
  overlay.className = 'kbd-overlay';
  overlay.innerHTML = `
    <div class="kbd-panel">
      <div class="kbd-header"><b>Keyboard shortcuts & interactions</b><button class="icon" onclick="toggleKbdHelp()">✕</button></div>
      <div class="kbd-grid">
        <div class="kbd-section">
          <div class="kbd-title">Keyboard</div>
          <div class="kbd-row"><kbd>Ctrl/⌘ Z</kbd><span>Undo last action</span></div>
          <div class="kbd-row"><kbd>Escape</kbd><span>Cancel selection / close popover</span></div>
          <div class="kbd-row"><kbd>Ctrl/⌘ Scroll</kbd><span>Zoom in/out on the room</span></div>
        </div>
        <div class="kbd-section">
          <div class="kbd-title">Guest interactions</div>
          <div class="kbd-row"><kbd>Click</kbd><span>Select guest, then click a seat to place</span></div>
          <div class="kbd-row"><kbd>Double-click</kbd><span>Rename guest in place</span></div>
          <div class="kbd-row"><kbd>Shift-click</kbd><span>Select two guests to add a relationship</span></div>
          <div class="kbd-row"><kbd>Drag</kbd><span>Move guest to a seat or back to pool</span></div>
        </div>
      </div>
    </div>`;
  overlay.onclick = e => { if (e.target === overlay) toggleKbdHelp(); };
  document.body.appendChild(overlay);
}

function resetAll() {
  if (!confirm('Clear all guests, groups, relationships and tables? This cannot be undone.')) return;
  state.guests = []; state.groups = []; state.rels = []; state.tables = [];
  save(); renderAll();
}

// share the whole plan as a file: guests, groups, relationships, tables (with positions) — send it,
// the other person loads it, and they get the identical layout.
function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'seating-plan.json';
  a.click();
}

function importJson(ev) {
  const file = ev.target.files[0];
  ev.target.value = ''; // so picking the same file again still fires 'change'
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let loaded;
    try { loaded = JSON.parse(reader.result); }
    catch (e) { alert('That file is not valid JSON.'); return; }
    if (!loaded || !Array.isArray(loaded.guests) || !Array.isArray(loaded.tables)) {
      alert('That file doesn\'t look like a seating plan export.');
      return;
    }
    if (state.guests.length && !confirm('Load this file? It will replace everything currently in the planner.')) return;
    state.guests = migrateGuestGroups(loaded.guests || []);
    state.groups = loaded.groups || [];
    state.rels = loaded.rels || [];
    state.tables = migrateTablePositions(loaded.tables || []);
    save(); renderAll();
  };
  reader.readAsText(file);
}

// ===== Tables & seating =====

function tableCapacity(t) { return t.headTable ? 2 * t.linked : 2 * t.linked + 2; }
// stack new tables below whatever's already there so a wide "linked" table never overlaps the next one
function pushNewTable() {
  const n = state.tables.length;
  const y = state.tables.length ? Math.max(...state.tables.map(t => t.y + tableFootprint(t.linked).height)) + 60 : 60;
  state.tables.push({ id: crypto.randomUUID(), name: 'Table ' + (n + 1), linked: 1, seats: [null, null, null, null], x: 60, y });
}
function addTable() { pushNewTable(); save(); renderAll(); }

// lays out every table left-to-right, wrapping to a new row, using each table's ACTUAL current
// footprint — fixes overlap regardless of how tables got into a messy position (heavy manual
// dragging, or repeated optimizer runs that grow/merge/delete tables without ever repositioning
// the survivors relative to each other).
function arrangeTables() {
  if (!state.tables.length) return;
  const margin = 60, gapX = 60, gapY = 90;
  const room = document.getElementById('room');
  const rowWidth = Math.max(700, room.clientWidth - margin * 2);
  let x = margin, y = margin, rowHeight = 0;
  state.tables.forEach(t => {
    const fp = tableFootprint(t.linked);
    if (x > margin && x + fp.width > margin + rowWidth) {
      x = margin;
      y += rowHeight + gapY;
      rowHeight = 0;
    }
    t.x = x;
    t.y = y;
    x += fp.width + gapX;
    rowHeight = Math.max(rowHeight, fp.height);
  });
  save(); renderAll();
}
function deleteTable(id) {
  const t = state.tables.find(t => t.id === id);
  const seatedCount = t.seats.filter(Boolean).length;
  const snapshot = JSON.stringify(state);
  state.tables = state.tables.filter(t => t.id !== id);
  save(); renderAll();
  const msg = seatedCount ? `Removed ${t.name} — ${seatedCount} guest(s) unseated` : `Removed ${t.name}`;
  showToast(msg, () => {
    const restored = JSON.parse(snapshot);
    state.guests = migrateGuestGroups(restored.guests || []);
    state.groups = restored.groups || [];
    state.rels = restored.rels || [];
    state.tables = migrateTablePositions(restored.tables || []);
    save(); renderAll();
  });
}
function setTableLinked(id, linked) {
  const t = state.tables.find(t => t.id === id);
  linked = Math.max(1, parseInt(linked) || 1);
  const newCap = t.headTable ? 2 * linked : 2 * linked + 2;
  const seatedGuests = t.seats.filter(Boolean);
  const overflow = seatedGuests.length - newCap;
  // shrinking below the seated count used to leave the extra guests in the array at seat
  // indices seatRect() has no real geometry for — they'd render stacked invisibly on top of
  // the last valid seat instead of bouncing back to Unseated. Truncate for real, and warn first.
  if (overflow > 0 && !confirm(`Shrinking ${t.name} to ${newCap} seats will move ${overflow} guest(s) back to Unseated. Continue?`)) {
    renderAll(); // reset the linked-input's displayed value back to the unchanged t.linked
    return;
  }
  t.linked = linked;
  const seated = seatedGuests.slice(0, newCap);
  t.seats = seated.concat(Array(newCap - seated.length).fill(null));
  save(); renderAll();
}
function setTableName(id, name) {
  state.tables.find(t => t.id === id).name = name;
  save();
}
function toggleHeadTable(id) {
  const t = state.tables.find(t => t.id === id);
  const wasHead = !!t.headTable;
  t.headTable = !wasHead;
  const newCap = tableCapacity(t);
  const seated = t.seats.filter(Boolean);
  if (wasHead) {
    t.seats = seated.slice(0, newCap).concat(Array(Math.max(0, newCap - seated.length)).fill(null));
  } else {
    const keep = seated.slice(0, newCap);
    t.seats = keep.concat(Array(Math.max(0, newCap - keep.length)).fill(null));
  }
  save(); renderAll();
}

function removeGuestFromAllSeats(guestId) {
  state.tables.forEach(t => { t.seats = t.seats.map(s => s === guestId ? null : s); });
}
function placeGuest(guestId, tableId, seatIndex) {
  const fromTable = seatedTableOf(guestId);
  const toTable = state.tables.find(t => t.id === tableId);
  const displaced = toTable.seats[seatIndex];
  removeGuestFromAllSeats(guestId);
  toTable.seats[seatIndex] = guestId;
  if (displaced && displaced !== guestId && fromTable) {
    fromTable.seats[fromTable.seats.indexOf(null) === -1 ? 0 : fromTable.seats.indexOf(null)] = displaced;
  }
  save(); renderAll();
}
function dropOnPool(ev) {
  ev.preventDefault(); ev.currentTarget.classList.remove('dragover');
  const guestId = ev.dataTransfer.getData('text/plain');
  removeGuestFromAllSeats(guestId);
  save(); renderAll();
}

// physical layout: n linked square tables in a row -> 2n+2 seats around the perimeter.
// `scale` is reused for both the PNG export (fixed, always bigger) and the live room zoom
// (interactive, via roomZoom) — same geometry math either way.
const SQ = 82, PAD = 46, SEAT_W = 68, SEAT_H = 34, SEAT_W2 = 34, SEAT_H2 = 60;
function tableFootprint(n, scale = 1) { return { width: n * SQ * scale + PAD * scale * 2, height: SQ * scale + PAD * scale * 2 }; }
function seatRect(n, idx, scale = 1, headTable = false) {
  const sq = SQ * scale, pad = PAD * scale, sw = SEAT_W * scale, sh = SEAT_H * scale, sw2 = SEAT_W2 * scale, sh2 = SEAT_H2 * scale, gap = 6 * scale;
  if (headTable) {
    if (idx < n) return { left: pad + idx * sq + (sq - sw) / 2, top: pad - sh - gap, width: sw, height: sh };
    const i = idx - n;
    return { left: pad + i * sq + (sq - sw) / 2, top: pad + sq + gap, width: sw, height: sh };
  }
  if (idx < n) return { left: pad + idx * sq + (sq - sw) / 2, top: pad - sh - gap, width: sw, height: sh };
  if (idx < 2 * n) { const i = idx - n; return { left: pad + i * sq + (sq - sw) / 2, top: pad + sq + gap, width: sw, height: sh }; }
  if (idx === 2 * n) return { left: pad - sw2 - gap, top: pad + (sq - sh2) / 2, width: sw2, height: sh2 };
  return { left: pad + n * sq + gap, top: pad + (sq - sh2) / 2, width: sw2, height: sh2 };
}

// ===== Guest chip / avatar rendering =====

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

function makeGroupsBtn(guest, extraClass, maxDots = 3) {
  const groupsBtn = document.createElement('span');
  groupsBtn.className = 'group-dots' + (extraClass ? ' ' + extraClass : '');
  groupsBtn.title = 'Edit groups';
  const gs = guest.groups.map(id => groupById(id)).filter(Boolean);
  groupsBtn.innerHTML = gs.length
    ? gs.slice(0, maxDots).map(g => `<span class="dot" style="background:${g.color}"></span>`).join('') + (gs.length > maxDots ? `<span class="more">+${gs.length - maxDots}</span>` : '')
    : `<span class="dot-empty">+</span>`;
  groupsBtn.onclick = e => { e.stopPropagation(); openGroupPicker(guest.id, groupsBtn); };
  return groupsBtn;
}

function makeDeleteBtn(guest, extraClass) {
  const delBtn = document.createElement('span');
  delBtn.className = extraClass;
  delBtn.textContent = '✕';
  delBtn.title = 'Remove guest';
  delBtn.onclick = e => { e.stopPropagation(); deleteGuest(guest.id); };
  return delBtn;
}

// avatarMode: seat is too narrow for a full name (physically-narrow end seats, or zoomed way out) —
// show initials in a circle instead, full name revealed on hover via pure-CSS tooltip
function chip(guest, avatarMode, inSeat) {
  if (avatarMode) {
    const el = document.createElement('div');
    el.className = 'avatar-wrap' + (guest.id === selectedGuestId ? ' selected' : '') + (guest.id === pairSelectId ? ' selected-pair' : '');
    el.dataset.guestId = guest.id;
    el.draggable = true;
    el.title = guest.name + ' (click to pick up, double-click to rename, shift-click to link)';
    el.ondragstart = e => e.dataTransfer.setData('text/plain', guest.id);
    el.ondblclick = () => renameGuest(guest.id);
    el.addEventListener('click', e => { if (e.shiftKey) { e.stopPropagation(); e.stopImmediatePropagation(); toggleSelectGuest(guest.id, e); } }, true);
    el.onclick = e => { e.stopPropagation(); toggleSelectGuest(guest.id, e); };
    el.onmouseenter = () => highlightRelated(guest.id);
    el.onmouseleave = clearHighlights;

    const circle = document.createElement('div');
    circle.className = 'avatar-circle';
    circle.textContent = initials(guest.name);
    el.appendChild(circle);

    const tip = document.createElement('div');
    tip.className = 'name-tip';
    tip.textContent = guest.name;
    el.appendChild(tip);

    el.appendChild(makeGroupsBtn(guest, 'avatar-badge', 2));
    el.appendChild(makeDeleteBtn(guest, 'avatar-del'));
    return el;
  }

  const dotMax = inSeat ? 2 : 3;
  const el = document.createElement('div');
  el.className = 'chip' + (guest.id === selectedGuestId ? ' selected' : '') + (guest.id === pairSelectId ? ' selected-pair' : '');
  el.dataset.guestId = guest.id;
  el.draggable = true;
  el.title = guest.name + ' (click to pick up, double-click to rename, shift-click to link)';
  el.ondragstart = e => e.dataTransfer.setData('text/plain', guest.id);
  el.ondblclick = e => { e.stopPropagation(); renameGuest(guest.id); };
  el.addEventListener('click', e => { if (e.shiftKey) { e.stopPropagation(); e.stopImmediatePropagation(); toggleSelectGuest(guest.id, e); } }, true);
  el.onclick = e => { e.stopPropagation(); toggleSelectGuest(guest.id, e); };
  el.onmouseenter = () => highlightRelated(guest.id);
  el.onmouseleave = clearHighlights;

  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = guest.name;
  el.appendChild(label);
  el.appendChild(makeGroupsBtn(guest, '', dotMax));
  el.appendChild(makeDeleteBtn(guest, 'chip-del'));

  return el;
}

// ===== Room canvas: drag, pan, zoom =====

function startTableDrag(ev, tableId, wrapper) {
  if (ev.target.closest('input, button')) return;
  ev.preventDefault();
  ev.stopPropagation(); // don't let this also start a canvas pan
  const t = state.tables.find(t => t.id === tableId);
  const startX = ev.clientX, startY = ev.clientY, origX = t.x, origY = t.y;
  function onMove(e) {
    // t.x/t.y are stored unscaled ("world" space) — divide the screen delta by zoom to match
    t.x = Math.max(0, origX + (e.clientX - startX) / roomZoom);
    t.y = Math.max(0, origY + (e.clientY - startY) / roomZoom);
    wrapper.style.left = (t.x * roomZoom) + 'px';
    wrapper.style.top = (t.y * roomZoom) + 'px';
  }
  function onUp() { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); save(); }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function startCanvasPan(ev, room) {
  if (ev.target !== room) return; // only pan when grabbing empty canvas, not a table
  ev.preventDefault();
  const startX = ev.clientX, startY = ev.clientY;
  const startLeft = room.scrollLeft, startTop = room.scrollTop;
  room.classList.add('panning');
  function onMove(e) {
    room.scrollLeft = startLeft - (e.clientX - startX);
    room.scrollTop = startTop - (e.clientY - startY);
  }
  function onUp() { room.classList.remove('panning'); document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// zoom around a fixed content point (worldX, worldY), keeping that point under the same
// screen position after rezooming — used by both wheel-zoom (point = cursor) and the +/- buttons
// (point = viewport center)
function zoomAround(newZoom, worldX, worldY, screenX, screenY) {
  const room = document.getElementById('room');
  roomZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  renderAll();
  room.scrollLeft = worldX * roomZoom - screenX;
  room.scrollTop = worldY * roomZoom - screenY;
}
function stepZoom(factor) {
  const room = document.getElementById('room');
  const rect = room.getBoundingClientRect();
  const screenX = rect.width / 2, screenY = rect.height / 2;
  const worldX = (room.scrollLeft + screenX) / roomZoom, worldY = (room.scrollTop + screenY) / roomZoom;
  zoomAround(roomZoom * factor, worldX, worldY, screenX, screenY);
}
function onRoomWheel(ev) {
  if (!(ev.ctrlKey || ev.metaKey)) return; // plain scroll still pans/scrolls normally
  ev.preventDefault();
  const room = ev.currentTarget;
  const rect = room.getBoundingClientRect();
  const screenX = ev.clientX - rect.left, screenY = ev.clientY - rect.top;
  const worldX = (room.scrollLeft + screenX) / roomZoom, worldY = (room.scrollTop + screenY) / roomZoom;
  zoomAround(roomZoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), worldX, worldY, screenX, screenY);
}

// ===== Render =====

function renderAll() {
  // groups
  const gl = document.getElementById('groupList');
  gl.innerHTML = '';
  state.groups.forEach(g => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${g.color};margin-right:7px;"></span>${g.name}</span>`;
    const btn = document.createElement('button'); btn.className = 'icon'; btn.textContent = '✕'; btn.onclick = () => deleteGroup(g.id);
    li.appendChild(btn);
    gl.appendChild(li);
  });

  // rel list (filterable by name and type)
  document.getElementById('relCount').textContent = state.rels.length;
  const relLabels = { must: '↔ must sit with', conflict: '⚡ must NOT sit with', knows: '~ knows' };
  const relFilterText = (document.getElementById('relFilter')?.value || '').trim().toLowerCase();
  const rl = document.getElementById('relList');
  rl.innerHTML = '';
  const typeOrder = ['must', 'conflict', 'knows'];
  const sorted = [...state.rels].sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));
  sorted.forEach(r => {
    if (activeRelTab !== 'all' && r.type !== activeRelTab) return;
    const a = guestById(r.a), b = guestById(r.b);
    if (!a || !b) return;
    if (relFilterText && !a.name.toLowerCase().includes(relFilterText) && !b.name.toLowerCase().includes(relFilterText)) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="${r.type === 'knows' ? 'knows' : r.type}">${a.name} ${relLabels[r.type]} ${b.name}</span>`;
    const btn = document.createElement('button'); btn.className = 'icon'; btn.textContent = '✕'; btn.onclick = () => deleteRel(r.id);
    li.appendChild(btn);
    rl.appendChild(li);
  });

  // pool (filterable, since it can get long)
  const filter = document.getElementById('poolFilter').value.trim().toLowerCase();
  const unseated = state.guests.filter(g => !seatedTableOf(g.id));
  document.getElementById('unseatedCount').textContent = unseated.length;
  document.getElementById('guestStats').textContent =
    `${state.guests.length} guest${state.guests.length === 1 ? '' : 's'} · ${state.guests.length - unseated.length} seated · ${unseated.length} unseated`;
  const pool = document.getElementById('pool');
  pool.innerHTML = '';
  unseated.filter(g => !filter || g.name.toLowerCase().includes(filter)).forEach(g => pool.appendChild(chip(g)));

  // warnings
  const w = document.getElementById('warnings');
  const unmet = unmetMustPairs(), broken = brokenConflictPairs();
  w.innerHTML =
    (unmet.length ? `<div class="warn">⚠ Not sitting together yet: ${unmet.map(r => guestById(r.a).name + ' & ' + guestById(r.b).name).join(', ')}</div>` : '') +
    (broken.length ? `<div class="warn">⛔ Seated together but shouldn't be: ${broken.map(r => guestById(r.a).name + ' & ' + guestById(r.b).name).join(', ')}</div>` : '');

  // undo
  document.getElementById('undoBtn').disabled = !undoSnapshot;

  // plan score
  closeScorePanel(); // avoid showing a stale breakdown after the state just changed
  const score = planScore();
  const scoreBadge = document.getElementById('scoreBadge');
  scoreBadge.textContent = score.finalScore === null ? 'Score: —' : `Score: ${score.finalScore}/100`;
  scoreBadge.classList.toggle('bad', score.mustViolations > 0 || score.conflictViolations > 0);

  // room / tables
  document.getElementById('zoomLabel').textContent = Math.round(roomZoom * 100) + '%';
  const room = document.getElementById('room');
  room.innerHTML = '';
  state.tables.forEach(t => {
    const n = t.linked;
    const fp = tableFootprint(n, roomZoom);
    const pad = PAD * roomZoom, sq = SQ * roomZoom;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-plan';
    wrapper.style.left = (t.x * roomZoom) + 'px';
    wrapper.style.top = (t.y * roomZoom) + 'px';
    wrapper.style.width = fp.width + 'px';
    wrapper.style.height = fp.height + 'px';

    const handle = document.createElement('div');
    handle.className = 'table-handle';
    const cap = tableCapacity(t);
    const headActive = t.headTable ? ' active' : '';
    handle.innerHTML = `<span class="grip" title="drag to move">⠿</span>
      <button class="head-toggle${headActive}" onclick="toggleHeadTable('${t.id}')" title="${t.headTable ? 'Switch to standard table (with side seats)' : 'Switch to head table (no side seats)'}">⊟</button>
      <input class="name-input" value="${t.name}" onchange="setTableName('${t.id}',this.value)">
      <span class="cap">🔗<input type="number" class="linked-input" min="1" value="${t.linked}" onchange="setTableLinked('${t.id}',this.value)">= ${cap} seats</span>
      <button class="icon" title="Remove table">✕</button>`;
    handle.onpointerdown = e => startTableDrag(e, t.id, wrapper);
    handle.querySelector('button.icon').onclick = () => deleteTable(t.id);
    wrapper.appendChild(handle);

    const surface = document.createElement('div');
    surface.className = 'table-surface';
    surface.style.left = pad + 'px'; surface.style.top = pad + 'px';
    surface.style.width = (n * sq) + 'px'; surface.style.height = sq + 'px';
    surface.onpointerdown = e => startTableDrag(e, t.id, wrapper);
    wrapper.appendChild(surface);

    t.seats.forEach((guestId, i) => {
      const r = seatRect(n, i, roomZoom, !!t.headTable);
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.style.left = r.left + 'px'; seat.style.top = r.top + 'px';
      seat.style.width = r.width + 'px'; seat.style.height = r.height + 'px';
      seat.ondragover = e => { e.preventDefault(); seat.classList.add('dragover'); };
      seat.ondragleave = () => seat.classList.remove('dragover');
      seat.ondrop = e => { e.preventDefault(); seat.classList.remove('dragover'); placeGuest(e.dataTransfer.getData('text/plain'), t.id, i); };
      seat.onclick = () => trySeatSelected(t.id, i);
      if (guestId) { const g = guestById(guestId); if (g) seat.appendChild(chip(g, r.width < SEAT_LEGIBLE_PX, true)); }
      wrapper.appendChild(seat);
    });

    room.appendChild(wrapper);
  });
}

// ===== Export: .txt and .png =====

function exportTxt() {
  const text = state.tables.map(t => {
    const names = t.seats.filter(Boolean).map(id => guestById(id)?.name).filter(Boolean);
    return `${t.name}:\n` + names.join(',\n');
  }).join('\n\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'seating.txt';
  a.click();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fillEllipsizedText(ctx, str, cx, cy, maxWidth) {
  let s = str;
  if (ctx.measureText(s).width > maxWidth) {
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    s += '…';
  }
  ctx.fillText(s, cx, cy);
}

// draw the whole floor plan straight onto a <canvas> (rects + text), then export as PNG.
// (an earlier version rasterized the live DOM via an SVG foreignObject, but Chrome
// permanently taints any canvas drawn from a foreignObject image, blocking toBlob/toDataURL —
// so we just paint the same layout math ourselves instead.)
function exportPng() {
  if (!state.tables.length) { alert('Add a table first.'); return; }
  const root = getComputedStyle(document.documentElement);
  const col = name => root.getPropertyValue(name).trim();
  const bg = col('--bg'), panel = col('--panel'), accent = col('--accent'), border = col('--border'), text = col('--text');

  // draw everything ~2x bigger than the on-screen compact layout so seat boxes have real
  // room for full names — the interactive UI stays small/click-friendly, only the export grows.
  const LAYOUT_SCALE = 2;
  const margin = 30, labelSpace = 34; // labelSpace: room for a table's name label, which floats above its own box
  const maxX = Math.max(...state.tables.map(t => t.x * LAYOUT_SCALE + tableFootprint(t.linked, LAYOUT_SCALE).width));
  const maxY = Math.max(...state.tables.map(t => t.y * LAYOUT_SCALE + tableFootprint(t.linked, LAYOUT_SCALE).height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = (maxX + margin) * dpr;
  canvas.height = (maxY + margin + labelSpace) * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, maxX + margin, maxY + margin + labelSpace);
  ctx.translate(0, labelSpace); // so a label above the topmost table (y=0) still fits on the canvas

  state.tables.forEach(t => {
    const n = t.linked, fp = tableFootprint(n, LAYOUT_SCALE), ox = t.x * LAYOUT_SCALE, oy = t.y * LAYOUT_SCALE;
    const pad = PAD * LAYOUT_SCALE, sq = SQ * LAYOUT_SCALE;

    roundRectPath(ctx, ox + pad, oy + pad, n * sq, sq, 8);
    ctx.fillStyle = panel; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = accent; ctx.stroke();

    ctx.font = 'bold 16px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = text;
    fillEllipsizedText(ctx, `${t.name} · ${tableCapacity(t)} seats`, ox + fp.width / 2, oy - 10, fp.width);

    t.seats.forEach((guestId, i) => {
      const r = seatRect(n, i, LAYOUT_SCALE, !!t.headTable);
      roundRectPath(ctx, ox + r.left, oy + r.top, r.width, r.height, 8);
      ctx.fillStyle = bg; ctx.fill();
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = border; ctx.stroke(); ctx.setLineDash([]);
      const guest = guestId && guestById(guestId);
      if (guest) {
        ctx.font = '13px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = text;
        fillEllipsizedText(ctx, guest.name, ox + r.left + r.width / 2, oy + r.top + r.height / 2, r.width - 10);
      }
    });
  });

  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'seating-plan.png';
    a.click();
  });
}

// ===== Startup =====

document.getElementById('room').onpointerdown = e => startCanvasPan(e, e.currentTarget);
document.getElementById('room').addEventListener('wheel', onRoomWheel, { passive: false });
renderAll();
