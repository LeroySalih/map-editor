import { ApiError, createMap, deleteMap, listMaps, openMap, saveMap } from './api';
import { dist } from './geometry';
import { idsInRect, rectOf } from './select';
import { genMap } from './generate';
import {
  CLOSED, DEFAULT_BG, SHEET, isStraight, newDoc, uid, validate, type MapDoc, type Pt, type Terrain,
} from './model';
import { renderSvg } from './render';
import {
  beginSignIn, cleanAddress, defaultConfig, endSignIn, finishSignIn, refreshTokens, restoreSignIn,
  SsoError, type Person, type Tokens,
} from './sso';
import './style.css';

type Tool = 'select' | 'objective' | 'spawn' | Terrain;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let doc: MapDoc = newDoc();
let tool: Tool = 'select';
let draft: Pt[] = [];
/** The saved copy on the server this page is linked to, if any. */
let remote: { id: string; version: number } | null = null;
let accessToken: string | null = null;
/** Ids of the selected terrain pieces, objective markers and spawn points. */
const selected = new Set<string>();
const history: string[] = [];
/** The box being dragged in Select mode (mm), or null. */
let marquee: { a: Pt; b: Pt } | null = null;

try {
  const saved = localStorage.getItem('map-editor.doc');
  if (saved) doc = validate(JSON.parse(saved));
} catch { /* no storage or bad data: start fresh */ }

function snapshot() {
  history.push(JSON.stringify(doc));
  if (history.length > 100) history.shift();
}

function draw() {
  const sheet = $('sheet');
  sheet.innerHTML = renderSvg(doc);
  const svg = sheet.querySelector('svg')!;
  for (const id of selected) {
    svg.querySelector(`[data-id="${CSS.escape(id)}"],[data-obj="${CSS.escape(id)}"],[data-spawn="${CSS.escape(id)}"]`)
      ?.setAttribute('filter', 'drop-shadow(0 0 1.5px #b8452e)');
  }
  if (marquee) {
    const r = rectOf(marquee.a, marquee.b);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = `<rect x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" fill="#b8452e" fill-opacity=".12" stroke="#b8452e" stroke-width=".6" stroke-dasharray="3 2" pointer-events="none"/>`;
    svg.appendChild(g);
  }
  if (draft.length) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const d = 'M' + draft.map((p) => p.join(',')).join(' L');
    g.innerHTML = `<path d="${d}" fill="none" stroke="#b8452e" stroke-width="1" stroke-dasharray="3 2"/>` +
      draft.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="1.4" fill="#b8452e"/>`).join('');
    svg.appendChild(g);
  }
  try { localStorage.setItem('map-editor.doc', JSON.stringify(doc)); } catch { /* ignore */ }
}

function toMm(e: MouseEvent): Pt {
  const svg = $('sheet').querySelector('svg')!;
  const m = svg.getScreenCTM()!.inverse();
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
  return [Math.max(0, Math.min(SHEET.w, p.x)), Math.max(0, Math.min(SHEET.h, p.y))];
}

function finishDraft() {
  if (tool === 'select' || tool === 'objective' || tool === 'spawn') return;
  const need = CLOSED[tool] ? 3 : 2;
  if (draft.length >= need) {
    snapshot();
    doc.features.push({
      id: uid(), type: tool, points: draft,
      ...(tool === 'river' ? { width: 6 } : {}),
    });
  }
  draft = [];
  draw();
}

$('sheet').addEventListener('click', (e) => {
  const p = toMm(e);
  if (tool === 'select') {
    // Terrain pieces carry data-id, objective markers data-obj and spawn points data-spawn; all can be selected and deleted.
    if (suppressClick) return;   // this click is the end of a box drag
    const hit = (e.target as Element).closest('[data-id],[data-obj],[data-spawn]');
    const id = hit?.getAttribute('data-id') ?? hit?.getAttribute('data-obj') ?? hit?.getAttribute('data-spawn') ?? null;
    if (e.shiftKey) {                                      // Shift: add to or take away from the selection
      if (id) { if (selected.has(id)) selected.delete(id); else selected.add(id); }
    } else {
      selected.clear();
      if (id) selected.add(id);
    }
    draw();
  } else if (tool === 'objective') {
    snapshot();
    doc.objectives.push({ id: uid(), x: p[0], y: p[1], label: nextObjectiveLabel() });
    draw();
  } else if (tool === 'spawn') {
    snapshot();
    doc.spawns.push({ id: uid(), x: p[0], y: p[1], label: nextSpawnLabel() });
    draw();
  } else {
    if (draft.length && dist(draft[draft.length - 1], p) < 0.5) return;
    draft.push(p);
    if (isStraight(tool) && draft.length === 2) { finishDraft(); return; }
    draw();
  }
});
$('sheet').addEventListener('dblclick', finishDraft);

// Box select (Select mode): drag on the sheet. Everything the box touches is selected, live; Shift keeps what was already selected.
let drag: { a: Pt; cx: number; cy: number; shift: boolean; active: boolean; base: Set<string> } | null = null;
let suppressClick = false;   // set when a box drag ends, cleared by the next press: the click that trails a drag always comes first

function endDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', cancelDrag);
  if (drag?.active) suppressClick = true;
  drag = null; marquee = null;
}
function onDragMove(e: PointerEvent) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 4) return;   // a click with a little wobble is still a click
    drag.active = true;
    drag.base = drag.shift ? new Set(selected) : new Set();
  }
  const b = toMm(e);
  marquee = { a: drag.a, b };
  selected.clear();
  drag.base.forEach((id) => selected.add(id));
  idsInRect(doc.features, [...doc.objectives, ...doc.spawns], rectOf(drag.a, b)).forEach((id) => selected.add(id));
  draw();
}
// Only redraw when a box was really dragged. Redrawing replaces the element that was pressed, and the browser then
// drops the click that would have followed, which would break plain click-to-select.
function onDragEnd() { const wasBox = drag?.active; endDrag(); if (wasBox) draw(); }
function cancelDrag() {   // Esc or a cancelled pointer: put the selection back as it was
  const wasBox = drag?.active;
  if (drag?.active) { selected.clear(); drag.base.forEach((id) => selected.add(id)); }
  endDrag(); if (wasBox) draw();
}
$('sheet').addEventListener('pointerdown', (e) => {
  suppressClick = false;   // a new press: whatever click follows it is a real one
  if (tool !== 'select' || e.button !== 0) return;
  drag = { a: toMm(e), cx: e.clientX, cy: e.clientY, shift: e.shiftKey, active: false, base: new Set() };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', cancelDrag);
});

function setTool(t: Tool) {
  tool = t; draft = []; selected.clear();
  $('hint').textContent = isStraight(t)
    ? 'Straight piece: click the start, then click the end. Esc cancels.'
    : t === 'objective' ? 'Click to place a numbered objective marker.'
    : t === 'spawn' ? 'Click to place a spawn point (lettered A, B, C ...).'
    : t === 'select' ? 'Click a piece, or drag a box around several. Shift adds to the selection. Delete removes it.'
    : 'Click to add points, double-click to finish. Esc cancels.';
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.classList.toggle('on', b.dataset.tool === t));
  draw();
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));

/** The smallest positive number no objective uses yet, so deleting marker 2 and adding one gives 2 again, never a second 3. */
function nextObjectiveLabel(): string {
  const used = new Set(doc.objectives.map((o) => o.label));
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

/** Spawn points are lettered: the first unused of A..Z, then Z1, Z2 ... */
function nextSpawnLabel(): string {
  const used = new Set(doc.spawns.map((s) => s.label));
  for (let i = 0; ; i++) {
    const label = i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`;
    if (!used.has(label)) return label;
  }
}

function deleteSelected() {
  if (!selected.size) return;
  snapshot();
  doc.features = doc.features.filter((f) => !selected.has(f.id));
  doc.objectives = doc.objectives.filter((o) => !selected.has(o.id));
  doc.spawns = doc.spawns.filter((s) => !selected.has(s.id));
  selected.clear();
  draw();
}
function undo() {
  const prev = history.pop();
  if (prev) { doc = JSON.parse(prev); selected.clear(); draft = []; syncPanel(); draw(); }
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input,textarea')) return;
  if (e.key === 'Escape') { if (drag?.active) cancelDrag(); else { draft = []; draw(); } }
  else if (e.key === 'Enter') finishDraft();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});

$('generate').addEventListener('click', () => {
  snapshot();
  const seed = Number($<HTMLInputElement>('seed').value) || 0;
  doc.seed = seed;
  doc.features = genMap(seed);
  selected.clear();
  draw();
});
$('undo').addEventListener('click', undo);
$('delete').addEventListener('click', deleteSelected);

$<HTMLInputElement>('title').addEventListener('input', (e) => {
  doc.title = (e.target as HTMLInputElement).value; draw();
});
$<HTMLTextAreaElement>('rules').addEventListener('input', (e) => {
  doc.rules = (e.target as HTMLTextAreaElement).value; draw();
});
// Background colour: update live while the picker is dragged, but make one undo step per pick.
let bgGesture = false;
$<HTMLInputElement>('bg').addEventListener('input', (e) => {
  if (!bgGesture) { snapshot(); bgGesture = true; }
  doc.background = (e.target as HTMLInputElement).value; draw();
});
$<HTMLInputElement>('bg').addEventListener('change', () => { bgGesture = false; });
$('bg-reset').addEventListener('click', () => {
  if (doc.background === DEFAULT_BG) return;
  snapshot(); doc.background = DEFAULT_BG; syncPanel(); draw();
});

// New map: a blank page that is not linked to any saved map, so the next Save makes a separate map. Two clicks when there is
// something on the page (Undo brings the page back, but not the link, so a saved map is never overwritten by accident).
let newTimer: ReturnType<typeof setTimeout> | null = null;
function disarmNew() {
  if (newTimer) clearTimeout(newTimer);
  newTimer = null;
  $('new-map').classList.remove('armed'); $('new-map').textContent = 'New map';
}
$('new-map').addEventListener('click', () => {
  const hasContent = doc.features.length > 0 || doc.objectives.length > 0 || doc.spawns.length > 0;
  if (hasContent && !newTimer) {
    $('new-map').classList.add('armed'); $('new-map').textContent = 'Really start new?';
    newTimer = setTimeout(disarmNew, 3000);
    return;
  }
  disarmNew();
  snapshot();
  doc = newDoc(); remote = null; selected.clear(); draft = [];
  syncPanel(); draw();
  renderAuth(person ? 'Started a new map. It is not saved yet: press "Save to my account".' : '');
});

// Clear all: removes every terrain piece, objective and spawn point (the title, rules, background and grid stay). Two clicks, and Undo brings it back.
let clearTimer: ReturnType<typeof setTimeout> | null = null;
function disarmClear() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  $('clear').classList.remove('armed'); $('clear').textContent = 'Clear all';
}
$('clear').addEventListener('click', () => {
  if (!doc.features.length && !doc.objectives.length && !doc.spawns.length) return;
  if (!clearTimer) {
    $('clear').classList.add('armed'); $('clear').textContent = 'Really clear all?';
    clearTimer = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  snapshot();
  doc.features = []; doc.objectives = []; doc.spawns = [];
  selected.clear(); draft = [];
  draw();
});

$<HTMLInputElement>('grid').addEventListener('change', (e) => {
  snapshot(); doc.grid = (e.target as HTMLInputElement).checked; draw();
});
function syncPanel() {
  $<HTMLInputElement>('grid').checked = doc.grid;
  $<HTMLInputElement>('bg').value = doc.background;
  $<HTMLInputElement>('title').value = doc.title;
  $<HTMLTextAreaElement>('rules').value = doc.rules;
  $<HTMLInputElement>('seed').value = String(doc.seed);
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = () => doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';

$('save').addEventListener('click', () =>
  download(`${slug()}.json`, new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })));
$('export-svg').addEventListener('click', () =>
  download(`${slug()}.svg`, new Blob([renderSvg(doc, true)], { type: 'image/svg+xml' })));
$('export-png').addEventListener('click', () => {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([renderSvg(doc, true)], { type: 'image/svg+xml' }));
  img.onload = () => {
    const px = 300 / 25.4; // 300 dpi
    const c = document.createElement('canvas');
    c.width = Math.round(SHEET.w * px); c.height = Math.round(SHEET.h * px);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob((b) => b && download(`${slug()}.png`, b), 'image/png');
    URL.revokeObjectURL(url);
  };
  img.src = url;
});
$('load').addEventListener('click', () => $('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  try {
    const next = validate(JSON.parse(await f.text()));
    snapshot(); doc = next; selected.clear(); draft = []; remote = null; syncPanel(); draw(); renderAuth();
  } catch (err) { alert(`Could not load: ${(err as Error).message}`); }
  input.value = '';
});

// --- Sign in with DINO. The name is shown here and kept in memory only. ---
const sso = defaultConfig();
let person: Person | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;

function renderAuth(msg = '') {
  $('signin').hidden = person !== null;
  $('signout').hidden = person === null;
  $('save-remote').hidden = person === null;
  $('save-remote').textContent = remote ? 'Save changes' : 'Save to my account';   // saving again updates the linked map
  $('save-new').hidden = person === null || remote === null;                         // only meaningful once a map is linked
  $('my-maps').hidden = person === null;
  const who = $('who');
  who.hidden = person === null;
  who.textContent = person ? (person.name ?? `Signed in (${person.id.slice(0, 8)})`) : '';
  $('auth-msg').textContent = msg;
}

function keepAlive(t: Tokens) {
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = setTimeout(async () => {
    try {
      const next = await refreshTokens(sso);
      if (next) { accessToken = next.accessToken; keepAlive(next); }
      else { person = null; accessToken = null; remote = null; renderAuth('Your DINO sign-in ended. Sign in again.'); }
    } catch { // DINO unreachable: try again soon
      keepAlive({ ...t, expiresAt: Date.now() + 75_000 });
    }
  }, Math.max(1_000, t.expiresAt - Date.now() - 60_000));
}

$('signin').addEventListener('click', () => {
  beginSignIn(sso, location, (url) => location.assign(url)).catch(() => renderAuth('Could not start the DINO sign-in.'));
});
$('signout').addEventListener('click', async () => {
  if (renewTimer) clearTimeout(renewTimer);
  person = null; accessToken = null; remote = null;
  renderAuth();
  await endSignIn(sso);
});

const failText = (e: unknown): string =>
  e instanceof ApiError
    ? e.status === 401
      // By now a renewal has been tried (see authed), so this is not just an old token: the server really refused it.
      ? 'The map server did not accept your sign-in. Sign out and in again; if it keeps happening, ask whoever runs the site to check the server log.'
      : e.message
    : 'Something went wrong. Try again.';

/** Call the map server with the current token. If the server answers 401 the token may simply have expired (a sleeping computer
 *  can miss the timer), so renew it once and try again; only a second 401 is reported. */
async function authed<T>(call: (token: string) => Promise<T>): Promise<T> {
  if (!accessToken) throw new ApiError('Sign in first.', 401, 'unauthorized');
  try {
    return await call(accessToken);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const renewed = await refreshTokens(sso).catch(() => null);
    if (!renewed) throw e;
    accessToken = renewed.accessToken;
    keepAlive(renewed);
    return await call(accessToken);
  }
}

/** Save this page to the person's account. The first save makes a new map and links the page to it; later saves update that map.
 *  `asNew` always makes a separate copy (and links the page to it). */
async function saveRemote(asNew = false) {
  if (!accessToken) return renderAuth('Sign in to save to your account.');
  renderAuth('Saving…');
  try {
    const link = asNew ? null : remote;
    const r = await authed((t) => (link ? saveMap(t, link.id, doc, link.version) : createMap(t, doc)));
    remote = { id: r.id, version: r.version };
    renderAuth(asNew || !link ? `Saved "${doc.title}" as a new map in your account.` : `Saved changes to "${doc.title}".`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'conflict') {
      remote = null; // the next save makes a new copy instead of overwriting the newer one
      renderAuth('This map was changed somewhere else. Press Save again to keep this as a new copy, or open the newer one from My maps.');
    } else renderAuth(failText(e));
  }
}
$('save-remote').addEventListener('click', () => void saveRemote());
$('save-new').addEventListener('click', () => void saveRemote(true));

const dlg = $<HTMLDialogElement>('mymaps');
async function showMyMaps() {
  if (!accessToken) return;
  const msg = $('mymaps-msg'), list = $('mymaps-list');
  list.textContent = ''; msg.textContent = 'Loading…';
  if (!dlg.open) dlg.showModal();
  try {
    const maps = await authed((t) => listMaps(t));
    msg.textContent = maps.length ? '' : 'You have no saved maps yet. Press "Save to my account" to keep this one.';
    for (const m of maps) {
      const li = document.createElement('li');
      if (remote?.id === m.id) li.className = 'current';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = m.title;
      const when = document.createElement('span'); when.className = 'when'; when.textContent = new Date(m.updatedAt).toLocaleString();
      const open = document.createElement('button'); open.textContent = 'Open';
      const del = document.createElement('button'); del.textContent = 'Delete';
      open.addEventListener('click', async () => {
        try {
          const rec = await authed((t) => openMap(t, m.id));
          const next = validate(rec.doc);
          snapshot(); doc = next; remote = { id: rec.id, version: rec.version };
          selected.clear(); draft = []; syncPanel(); draw(); dlg.close();
          renderAuth(`Opened "${doc.title}".`);
        } catch (e) { msg.textContent = failText(e); }
      });
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Really delete?'; return; }
        try {
          await authed((t) => deleteMap(t, m.id));
          if (remote?.id === m.id) remote = null;
          li.remove();
          if (!list.children.length) msg.textContent = 'You have no saved maps yet.';
        } catch (e) { msg.textContent = failText(e); }
      });
      li.append(name, when, open, del);
      list.append(li);
    }
  } catch (e) { msg.textContent = failText(e); }
}
$('my-maps').addEventListener('click', () => void showMyMaps());
$('mymaps-close').addEventListener('click', () => dlg.close());

(async () => {
  try {
    const r = (await finishSignIn(sso, location.search, location)) ?? (await restoreSignIn(sso));
    if (r) { person = r.person; accessToken = r.tokens.accessToken; keepAlive(r.tokens); }
    renderAuth();
  } catch (e) {
    renderAuth(e instanceof SsoError ? e.message : 'Sign-in failed. Try again.');
  }
  cleanAddress();
})();

syncPanel();
draw();
