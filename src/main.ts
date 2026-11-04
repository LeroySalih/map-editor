import { ApiError, createMap, deleteMap, listMaps, openMap, saveMap } from './api';
import { dist } from './geometry';
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

type Tool = 'select' | 'objective' | Terrain;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let doc: MapDoc = newDoc();
let tool: Tool = 'select';
let draft: Pt[] = [];
/** The saved copy on the server this page is linked to, if any. */
let remote: { id: string; version: number } | null = null;
let accessToken: string | null = null;
let selected: string | null = null;
const history: string[] = [];

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
  if (selected) {
    svg.querySelector(`[data-id="${CSS.escape(selected)}"]`)
      ?.setAttribute('filter', 'drop-shadow(0 0 1.5px #b8452e)');
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
  if (tool === 'select' || tool === 'objective') return;
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
    const hit = (e.target as Element).closest('[data-id]');
    selected = hit?.getAttribute('data-id') ?? null;
    draw();
  } else if (tool === 'objective') {
    snapshot();
    doc.objectives.push({ id: uid(), x: p[0], y: p[1], label: String(doc.objectives.length + 1) });
    draw();
  } else {
    if (draft.length && dist(draft[draft.length - 1], p) < 0.5) return;
    draft.push(p);
    if (isStraight(tool) && draft.length === 2) { finishDraft(); return; }
    draw();
  }
});
$('sheet').addEventListener('dblclick', finishDraft);

function setTool(t: Tool) {
  tool = t; draft = []; selected = null;
  $('hint').textContent = isStraight(t)
    ? 'Straight piece: click the start, then click the end. Esc cancels.'
    : t === 'objective' ? 'Click to place a numbered objective marker.'
    : t === 'select' ? 'Click a piece to select it, then Delete removes it.'
    : 'Click to add points, double-click to finish. Esc cancels.';
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.classList.toggle('on', b.dataset.tool === t));
  draw();
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));

function deleteSelected() {
  if (!selected) return;
  snapshot();
  doc.features = doc.features.filter((f) => f.id !== selected);
  selected = null;
  draw();
}
function undo() {
  const prev = history.pop();
  if (prev) { doc = JSON.parse(prev); selected = null; draft = []; syncPanel(); draw(); }
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input,textarea')) return;
  if (e.key === 'Escape') { draft = []; draw(); }
  else if (e.key === 'Enter') finishDraft();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});

$('generate').addEventListener('click', () => {
  snapshot();
  const seed = Number($<HTMLInputElement>('seed').value) || 0;
  doc.seed = seed;
  doc.features = genMap(seed);
  selected = null;
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

// Clear all: removes every terrain piece and objective (the title, rules, background and grid stay). Two clicks, and Undo brings it back.
let clearTimer: ReturnType<typeof setTimeout> | null = null;
function disarmClear() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  $('clear').classList.remove('armed'); $('clear').textContent = 'Clear all';
}
$('clear').addEventListener('click', () => {
  if (!doc.features.length && !doc.objectives.length) return;
  if (!clearTimer) {
    $('clear').classList.add('armed'); $('clear').textContent = 'Really clear all?';
    clearTimer = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  snapshot();
  doc.features = []; doc.objectives = [];
  selected = null; draft = [];
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
    snapshot(); doc = next; selected = null; draft = []; remote = null; syncPanel(); draw();
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
    ? e.status === 401 ? 'Your sign-in has expired. Sign in again.' : e.message
    : 'Something went wrong. Try again.';

/** Save this page to the person's account: a new map the first time, then the same map. */
async function saveRemote() {
  if (!accessToken) return renderAuth('Sign in to save to your account.');
  renderAuth('Saving…');
  try {
    const r = remote ? await saveMap(accessToken, remote.id, doc, remote.version) : await createMap(accessToken, doc);
    remote = { id: r.id, version: r.version };
    renderAuth(`Saved "${doc.title}" to your account.`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'conflict') {
      remote = null; // the next save makes a new copy instead of overwriting the newer one
      renderAuth('This map was changed somewhere else. Press Save again to keep this as a new copy, or open the newer one from My maps.');
    } else renderAuth(failText(e));
  }
}
$('save-remote').addEventListener('click', () => void saveRemote());

const dlg = $<HTMLDialogElement>('mymaps');
async function showMyMaps() {
  if (!accessToken) return;
  const msg = $('mymaps-msg'), list = $('mymaps-list');
  list.textContent = ''; msg.textContent = 'Loading…';
  if (!dlg.open) dlg.showModal();
  try {
    const maps = await listMaps(accessToken);
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
          const rec = await openMap(accessToken!, m.id);
          const next = validate(rec.doc);
          snapshot(); doc = next; remote = { id: rec.id, version: rec.version };
          selected = null; draft = []; syncPanel(); draw(); dlg.close();
          renderAuth(`Opened "${doc.title}".`);
        } catch (e) { msg.textContent = failText(e); }
      });
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Really delete?'; return; }
        try {
          await deleteMap(accessToken!, m.id);
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
