'use strict';
const api = window.notes;
const $ = id => document.getElementById(id);

// ---------- small helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const d = new Date(+m[1], m[2] - 1, +m[3]);
  const now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - d) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
const plain = md => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~|]|\[|\]\([^)]*\)|^-\s/gm, '').replace(/\s+/g, ' ').trim();
function highlight(text, q) {
  if (!q) return esc(text);
  return String(text).split(new RegExp(`(${reEsc(q)})`, 'ig')).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
function renderMd(md) {
  return DOMPurify.sanitize(marked.parse(md || '', { gfm: true, breaks: true }));
}

// ---------- state ----------
let classes = [];
let cls = load('class', null);
let path = [];                        // the folders opened inside the current class, e.g. ['Accounts', 'Depreciation']
let view = { mode: 'browse' };        // browse | note {path} | edit {dir, note}
let query = '';
let seen = new Set(load('seen', []));
let syncState = { state: 'off' };
let dirty = false;

const PDF_DIR = 'Chapter PDFs';
// The folder a note or file is in, as path segments, e.g. ['Class 11', 'Accounts', 'Depreciation'].
const folderOf = p => String(p).split('/').slice(0, -1);
// A short label for a folder: "Accounts › Depreciation", or just the class name for the class itself.
const placeLabel = segs => (segs.length === 1 ? segs[0] : segs.slice(1).join(' › '));

// Find a folder by its path segments [class, ...folders]; null if it doesn't exist.
function folderAt(segs) {
  let node = classes.find(c => c.name === segs[0]);
  for (const name of segs.slice(1)) node = node?.folders.find(f => f.name === name);
  return node || null;
}
const curClass = () => folderAt([cls]);
const curFolder = () => folderAt([cls, ...path]);
const findNote = p => folderAt(folderOf(p))?.notes.find(n => n.path === p);
const findFile = p => folderAt(folderOf(p))?.files.find(x => x.path === p);

// Visit a folder and every folder inside it.
function walk(node, segs, fn) {
  fn(node, segs);
  for (const f of node.folders) walk(f, [...segs, f.name], fn);
}
// Every note or file in a class, each labelled with where it is.
function everything(c, key) {
  const out = [];
  walk(c, [c.name], (node, segs) => node[key].forEach(x => out.push({ ...x, cls: c.name, where: placeLabel(segs) })));
  return out;
}
const allNotes = c => everything(c, 'notes');
const allFiles = c => everything(c, 'files');
const fullPlace = x => (x.where === x.cls ? x.cls : `${x.cls} › ${x.where}`);
// How much is inside a folder, counting everything below it.
function folderStats(node) {
  const st = { folders: -1, files: 0, notes: 0, hasNew: false };
  walk(node, [], f => {
    st.folders++;
    st.files += f.files.length;
    st.notes += f.notes.length;
    if (f.notes.some(isNew)) st.hasNew = true;
  });
  return st;
}

// The folder the screen shows (where ＋ adds things), and the way to a folder.
function currentFolder() {
  if (view.mode === 'edit') return view.dir;
  if (view.mode === 'note') return folderOf(view.path);
  return [cls, ...path];
}
function goToFolder(segs) {
  cls = segs[0];
  path = segs.slice(1);
}

const isNew = n => n.author === 'claude' && !seen.has(n.path);
const markSeen = n => { if (!seen.has(n.path)) { seen.add(n.path); save('seen', [...seen]); } };

async function reload() {
  try { classes = await api.tree(); } catch (e) { toast(e.message, 'error'); }
  if (!curClass()) { cls = classes[0]?.name ?? null; path = []; }
  while (path.length && !curFolder()) path.pop(); // the folder was renamed or deleted
  if (view.mode === 'note' && !findNote(view.path)) view = { mode: 'browse' };
  render();
}

// ---------- rendering ----------
function render() {
  save('class', cls);
  renderTop();
  if (view.mode === 'edit') return; // the editor owns the page while it is open
  const main = $('main');
  if (!classes.length) main.innerHTML = welcomeView();
  else if (query) main.innerHTML = searchView();
  else if (view.mode === 'note') main.innerHTML = noteView(findNote(view.path));
  else main.innerHTML = folderView();
}

function renderTop() {
  $('classBtn').innerHTML = cls
    ? `🎓 <span class="name">${esc(cls)}</span> <span class="caret">▾</span>`
    : `🎓 <span class="name">Choose class</span> <span class="caret">▾</span>`;
  const parts = [];
  if (cls) {
    [cls, ...path].forEach((p, i) => {
      const last = i === path.length && view.mode === 'browse';
      parts.push(last ? `<span>${esc(p)}</span>` : `<a data-action="crumb" data-i="${i}">${esc(p)}</a>`);
    });
  }
  $('crumbs').innerHTML = parts.join('<span class="sep">›</span>');

  const tip = fabLabel();
  $('fab').classList.toggle('hidden', !tip);
  $('fabTip').textContent = tip || '';
  renderSync();
}

function fabLabel() {
  if (view.mode === 'edit') return null;
  if (!cls) return 'New class';
  return 'Add a folder, file or note';
}

function renderSync() {
  const st = syncState, pill = $('syncPill');
  const text = {
    off: 'Not connected',
    syncing: 'Syncing…',
    ok: `Synced · ${st.at ? ago(st.at) : ''}`,
    offline: 'Offline',
    error: 'Sync problem',
  }[st.state];
  pill.className = `sync-pill ${st.state}`;
  pill.innerHTML = `<span class="dot"></span><span class="pill-text">${text}</span>`;
  pill.title = st.message || (st.state === 'off' ? 'Connect to GitHub so Claude can add notes' : 'Click to sync now');
}

function welcomeView() {
  return `<div class="empty"><div class="big">📚</div><h2>Welcome to My Notes</h2>
    <p>Start by creating your first class, for example “Class 10”.<br>Then add folders, files and notes with the ＋ button.</p>
    <p><button class="btn" data-action="new-class">＋ Create a class</button>
    ${syncState.state === 'off' ? '<button class="btn ghost" data-action="settings">Connect to GitHub</button>' : ''}</p></div>`;
}

function folderCard(name, icon, count, hasNew) {
  return `<div class="folder" data-action="open-folder" data-name="${esc(name)}">
    <button class="icon-btn more" data-action="folder-menu" data-name="${esc(name)}" title="More">⋯</button>
    <div class="icon">${icon}</div>
    <div class="name">${esc(name)}${hasNew ? '<span class="new-dot" title="New notes from Claude"></span>' : ''}</div>
    <div class="count">${count}</div></div>`;
}

function noteCard(n, where) {
  return `<div class="note" data-action="open-note" data-path="${esc(n.path)}">
    <div class="title">📝 ${esc(n.title)}${isNew(n) ? '<span class="new-dot" title="New from Claude"></span>' : ''}</div>
    <div class="snippet">${esc(plain(n.body).slice(0, 160))}</div>
    <div class="meta">${badge(n)}<span>${fmtDate(n.updated)}</span>${where ? `<span>· ${esc(where)}</span>` : ''}</div></div>`;
}
const badge = n => (n.author === 'claude' ? '<span class="badge">✨ by Claude</span>' : '<span class="badge me">by you</span>');

// The files and notes kept directly in a folder.
function itemsSection(folder) {
  return (folder.files.length ? `<div class="section"><p class="label">${plural(folder.files.length, 'file')}</p><div class="list">${folder.files.map(x => fileCard(x)).join('')}</div></div>` : '')
    + (folder.notes.length ? `<div class="section"><p class="label">${plural(folder.notes.length, 'note')}</p><div class="list">${folder.notes.map(n => noteCard(n)).join('')}</div></div>` : '');
}

// Any folder: its subfolders, then the files and notes kept directly in it.
function folderView() {
  const node = curFolder();
  const depth = path.length;
  const icon = depth === 0 ? '🎓' : depth === 1 ? '📁' : '📂';
  const folders = [...node.folders];
  if (depth === 1) folders.sort((a, b) => (b.name === PDF_DIR) - (a.name === PDF_DIR)); // Chapter PDFs first
  const cards = folders.map(f => {
    const st = folderStats(f);
    const count = [st.folders && plural(st.folders, 'folder'), st.files && plural(st.files, 'file'), st.notes && plural(st.notes, 'note')]
      .filter(Boolean).join(' · ') || 'Empty';
    return folderCard(f.name, f.name === PDF_DIR ? '📄' : depth === 0 ? '📁' : '📂', count, st.hasNew);
  });
  // Every subject offers a Chapter PDFs folder, even before anything is in it.
  if (depth === 1 && !node.folders.some(f => f.name === PDF_DIR)) {
    cards.unshift(`<div class="folder" data-action="make-pdf-folder"><div class="icon">📄</div><div class="name">${PDF_DIR}</div><div class="count">Empty</div></div>`);
  }
  const buttons = `<button class="btn ghost" data-action="write-note">✎ Write a note</button>
    <label for="pdfInput" class="btn ghost" data-action="prepare-upload">📎 Upload file</label>`;
  const empty = !cards.length && !node.files.length && !node.notes.length;
  const head = `<div class="page-row"><h1 class="page">${icon} ${esc(node.name)}</h1>${empty ? '' : buttons}</div>`;
  if (empty) {
    return head + `<div class="empty"><div class="big">${icon}</div><h2>Nothing in ${esc(node.name)} yet</h2>
      <p>Add a folder, upload files (PDFs, photos, documents, anything), write a note, or ask Claude to make notes here.</p>
      <p class="empty-actions"><button class="btn" data-action="new-folder">📁 New folder</button>
      <label for="pdfInput" class="btn" data-action="prepare-upload">📎 Upload file</label>
      <button class="btn" data-action="write-note">✎ Write a note</button></p></div>`;
  }
  let recent = '';
  if (depth === 0) {
    // Recent notes from inside the subjects (notes kept directly in the class are listed on their own).
    const list = allNotes(node).filter(n => n.where !== node.name)
      .sort((a, b) => b.updated.localeCompare(a.updated) || b.mtime - a.mtime).slice(0, 6);
    if (list.length) recent = `<div class="section"><p class="label">Recent notes</p><div class="list">${list.map(n => noteCard(n, n.where)).join('')}</div></div>`;
  }
  return head
    + (cards.length ? `<div class="section"><p class="label">${depth === 0 ? 'Subjects' : 'Folders'}</p><div class="grid">${cards.join('')}</div></div>` : '')
    + itemsSection(node)
    + recent;
}

// Coloured document icons, one per kind of file.
const KIND = {
  pdf: { label: 'PDF', color: '#e5484d', name: 'PDF' },
  word: { label: 'DOC', color: '#3b82f6', name: 'Word document' },
  slides: { label: 'PPT', color: '#f97316', name: 'PowerPoint' },
  sheet: { label: 'XLS', color: '#22a55b', name: 'Spreadsheet' },
  image: { label: 'IMG', color: '#a855f7', name: 'Image' },
  text: { label: 'TXT', color: '#8b93a7', name: 'Text file' },
  video: { label: 'VID', color: '#14b8a6', name: 'Video' },
  audio: { label: 'AUD', color: '#ec4899', name: 'Audio' },
  archive: { label: 'ZIP', color: '#eab308', name: 'Archive' },
  other: { label: 'FILE', color: '#64748b', name: 'File' },
};
const kindOf = x => KIND[x.kind] || KIND.other;
function fileIcon(x, size = 40) {
  const k = kindOf(x);
  const label = x.ext && x.ext.length <= 4 ? x.ext.toUpperCase() : k.label;
  return `<svg class="file-icon" width="${size}" height="${Math.round(size * 1.2)}" viewBox="0 0 40 48" aria-hidden="true">
    <path d="M4 2h22l10 10v32a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#eef0f5"/>
    <path d="M26 2v8a2 2 0 0 0 2 2h8z" fill="#c9cedb"/>
    <rect x="0" y="26" width="34" height="14" rx="3" fill="${k.color}"/>
    <text x="17" y="36.2" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="${label.length > 3 ? 7.4 : 8.6}" font-weight="700" fill="#fff">${esc(label)}</text>
  </svg>`;
}

function fileCard(x, where) {
  return `<div class="note file-item" data-action="open-file" data-path="${esc(x.path)}">
    ${fileIcon(x)}
    <div class="file-text"><div class="title">${where ? highlight(x.name, query) : esc(x.name)}</div>
    <div class="meta"><span>${kindOf(x).name}</span>${where ? `<span>· ${esc(where)}</span>` : ''}</div></div>
    <button class="icon-btn more" data-action="file-menu" data-path="${esc(x.path)}" title="More">⋯</button></div>`;
}

function noteView(n) {
  if (!n) return '';
  return `<div class="doc">
    <div class="doc-head"><h1>${esc(n.title)}</h1>
      <button class="btn ghost" data-action="back">← Back</button>
      <button class="btn ghost" data-action="share-note">↗ Share</button>
      <button class="btn ghost" data-action="move-note">↪ Move</button>
      <button class="btn" data-action="edit-note">✎ Edit</button>
      <button class="btn ghost danger" data-action="delete-note" title="Delete note">🗑</button></div>
    <div class="meta">${badge(n)}<span>Created ${fmtDate(n.created)}</span>${n.updated !== n.created ? `<span>· Edited ${fmtDate(n.updated)}</span>` : ''}</div>
    <div class="doc-body md">${renderMd(n.body) || '<p style="color:var(--muted)">This note is empty.</p>'}</div></div>`;
}

function searchView() {
  const q = query.toLowerCase();
  const hits = classes.flatMap(allNotes).filter(n => `${n.title} ${n.body} ${n.where}`.toLowerCase().includes(q));
  const fileHits = classes.flatMap(allFiles).filter(x => x.name.toLowerCase().includes(q));
  const rows = hits.map(n => {
    const text = plain(n.body);
    const at = text.toLowerCase().indexOf(q);
    const snip = at < 0 ? text.slice(0, 140) : (at > 50 ? '…' : '') + text.slice(Math.max(0, at - 50), at + 110);
    return `<div class="note" data-action="open-note" data-path="${esc(n.path)}">
      <div class="title">📝 ${highlight(n.title, query)}</div><div class="snippet">${highlight(snip, query)}</div>
      <div class="meta">${badge(n)}<span>${esc(fullPlace(n))}</span></div></div>`;
  });
  rows.push(...fileHits.map(x => fileCard(x, fullPlace(x))));
  return `<p class="label">${plural(rows.length, 'result')} for “${esc(query)}”</p>
    ${rows.length ? `<div class="list">${rows.join('')}</div>` : '<div class="empty"><div class="big">🔍</div><p>No notes or files match your search.</p></div>'}`;
}

// ---------- editor ----------
const narrow = () => matchMedia('(max-width: 760px)').matches;
// On a phone the preview replaces the text box; on wider screens it sits beside it.
const previewLabel = split => (narrow() ? (split ? 'Write' : 'Preview') : (split ? 'Hide preview' : 'Show preview'));
function openEditor(dir, note) {
  view = { mode: 'edit', dir, note: note?.path };
  dirty = false;
  renderTop();
  const split = load('split', !narrow());
  $('main').innerHTML = `<div class="editor">
    <div class="bar"><div class="where">${esc(dir.join(' › '))}</div>
      <button class="btn ghost" data-action="toggle-preview">${previewLabel(split)}</button>
      <button class="btn ghost" data-action="cancel-edit">Cancel</button>
      <button class="btn" data-action="save-note">Save</button></div>
    <input class="title" id="edTitle" placeholder="Note title" value="${esc(note?.title || '')}">
    <div class="panes ${split ? 'split' : ''}" id="edPanes">
      <textarea id="edBody" placeholder="Write your note here…&#10;&#10;Tips: # Heading,  **bold**,  - bullet list,  1. numbered list"></textarea>
      <div class="live md ${split ? '' : 'hidden'}" id="edLive"></div></div>
    <div class="hint">Ctrl+S to save · Esc to cancel · Formatting uses Markdown</div></div>`;
  $('edBody').value = note?.body || '';
  const update = () => { $('edLive').innerHTML = renderMd($('edBody').value); };
  $('edBody').addEventListener('input', () => { dirty = true; update(); });
  $('edTitle').addEventListener('input', () => { dirty = true; });
  $('edTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('edBody').focus(); } });
  update();
  (note ? $('edBody') : $('edTitle')).focus();
}

async function saveEditor() {
  const title = $('edTitle').value.trim();
  if (!title) { toast('Please give the note a title.', 'error'); $('edTitle').focus(); return; }
  const file = view.note ? view.note.split('/').pop() : undefined;
  try {
    const p = await api.saveNote({ dir: view.dir, file, title, body: $('edBody').value });
    dirty = false;
    goToFolder(view.dir);
    view = { mode: 'note', path: p };
    await reload();
    toast('Note saved');
  } catch (e) { toast(e.message, 'error'); }
}

// Ask before throwing away unsaved edits. Returns true when it is fine to navigate.
async function leaveEditor() {
  if (view.mode !== 'edit') return true;
  if (dirty && !(await confirmBox({ title: 'Discard changes?', text: 'Your unsaved changes to this note will be lost.', ok: 'Discard', danger: true }))) return false;
  dirty = false;
  view = view.note ? { mode: 'note', path: view.note } : { mode: 'browse' };
  return true;
}

// ---------- modals, menus, toasts ----------
let modalDone = null;
function openModal(html) {
  $('modal').innerHTML = html;
  $('modalBg').classList.add('show');
  setTimeout(() => $('modal').querySelector('input')?.focus(), 0);
}
function closeModal(result = null) {
  $('modalBg').classList.remove('show');
  const done = modalDone; modalDone = null;
  done?.(result);
}
const modalOpen = () => $('modalBg').classList.contains('show');

// Prompt for a name; onSubmit may throw to show the error inline.
function ask({ title, text, placeholder, value = '', ok = 'Add', onSubmit }) {
  openModal(`<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
    <input id="askInput" placeholder="${esc(placeholder || '')}" value="${esc(value)}" maxlength="80">
    <div class="err" id="askErr"></div>
    <div class="row"><button class="btn ghost" data-action="modal-cancel">Cancel</button><button class="btn" id="askOk">${esc(ok)}</button></div>`);
  const input = $('askInput');
  input.select();
  return new Promise(resolve => {
    modalDone = resolve;
    const submit = async () => {
      try { const r = await onSubmit(input.value); modalDone = null; closeModal(); resolve(r); } catch (e) { $('askErr').textContent = e.message; }
    };
    $('askOk').onclick = submit;
    input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  });
}

function confirmBox({ title, text, ok = 'OK', danger = false }) {
  openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div class="row"><button class="btn ghost" data-action="modal-cancel">Cancel</button>
    <button class="btn ${danger ? 'danger' : ''}" id="confirmOk">${esc(ok)}</button></div>`);
  return new Promise(resolve => {
    modalDone = v => resolve(!!v);
    $('confirmOk').onclick = () => closeModal(true);
    $('confirmOk').focus();
  });
}

function showPopup(e, items) {
  const pop = $('popup');
  pop.innerHTML = items.map((it, i) => (it === '-' ? '<div class="menu-sep"></div>'
    : `<div class="menu-item ${it.cls || ''}" data-action="popup-item" data-i="${i}">${it.label}</div>`)).join('');
  pop._items = items;
  pop.classList.add('show');
  const r = e.target.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 10)}px`;
  pop.style.top = `${Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 10)}px`;
}
function closeMenus() {
  $('popup').classList.remove('show');
  $('classMenu').classList.remove('show');
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

// ---------- folder operations ----------
// Add a folder inside any folder (a subject when added straight into a class).
async function newFolder(parent = currentFolder()) {
  const subject = parent.length === 1;
  const name = await ask({
    title: subject ? 'New subject folder' : 'New folder',
    placeholder: subject ? 'e.g. Biology' : 'e.g. Ch 6 Life Processes',
    onSubmit: v => api.createFolder(parent, v),
  });
  if (!name) return;
  goToFolder([...parent, name]);
  view = { mode: 'browse' };
  await reload();
  toast(`Folder “${name}” created`);
}
async function newClass() {
  const name = await ask({ title: 'New class', placeholder: 'e.g. Class 10', onSubmit: v => api.createFolder([], v) });
  if (!name) return;
  cls = name; path = []; view = { mode: 'browse' };
  await reload();
  toast(`Class “${name}” created`);
}

async function renameFolder(segs) {
  const old = segs[segs.length - 1];
  const name = await ask({ title: `Rename “${old}”`, value: old, ok: 'Rename', onSubmit: v => api.renameFolder(segs, v) });
  if (!name || name === old) return;
  const from = `${segs.join('/')}/`, to = `${[...segs.slice(0, -1), name].join('/')}/`;
  seen = new Set([...seen].map(p => (p.startsWith(from) ? to + p.slice(from.length) : p)));
  save('seen', [...seen]);
  // If the renamed folder is the one on screen (or contains it), follow the new name.
  const open = [cls, ...path];
  if (segs.every((s, i) => open[i] === s)) {
    open[segs.length - 1] = name;
    goToFolder(open);
  }
  await reload();
}

async function deleteFolder(segs) {
  const st = folderStats(folderAt(segs));
  const inside = [st.folders && plural(st.folders, 'folder'), plural(st.files, 'file'), plural(st.notes, 'note')].filter(Boolean).join(', ');
  const ok = await confirmBox({
    title: `Delete “${segs[segs.length - 1]}”?`,
    text: `This deletes everything inside it (${inside}), on this device and on GitHub. This cannot be undone.`,
    ok: 'Delete', danger: true,
  });
  if (!ok) return;
  try { await api.deleteFolder(segs); } catch (e) { return toast(e.message, 'error'); }
  // If the deleted folder was on screen (or contained it), step back out of it.
  const open = [cls, ...path];
  if (segs.every((s, i) => open[i] === s)) {
    if (segs.length === 1) { cls = null; path = []; } else goToFolder(segs.slice(0, -1));
  }
  view = { mode: 'browse' };
  await reload();
  toast('Deleted');
}

// ---------- files (any type) ----------
// Uploaded files go into the folder on screen (or the one chosen from the ＋ menu).
let uploadTo = null, folderUploadTo = null;
function pickFiles(target = currentFolder()) {
  prepareUpload(target);
  $('pdfInput').click();
}
// Tapping an Upload file label: remember where the files go; the label itself opens the picker.
function prepareUpload(target = currentFolder()) {
  uploadTo = target;
  $('pdfInput').value = '';
}
// Folder picking only works in computer browsers and the Windows app.
const canPickFolder = 'webkitdirectory' in document.createElement('input') && matchMedia('(pointer: fine)').matches;
function pickFolder(target = currentFolder()) {
  folderUploadTo = target;
  $('folderInput').value = '';
  $('folderInput').click();
}
$('pdfInput').addEventListener('change', e => uploadFiles([...(e.target.files || [])]));
async function uploadFiles(files) {
  const target = uploadTo || (cls ? currentFolder() : null);
  if (!files.length) return;
  if (!target) return toast('Create a class first, then upload files into it.', 'error');
  toast(files.length === 1 ? `Adding “${files[0].name}”…` : `Adding ${files.length} files…`);
  let added = 0;
  for (const f of files) {
    try {
      await api.addFile(target, f.name, new Uint8Array(await f.arrayBuffer()));
      added++;
    } catch (err) { toast(err.message, 'error'); }
  }
  if (!added) return;
  goToFolder(target);
  view = { mode: 'browse' };
  await reload();
  toast(added === 1 ? 'File added' : `${added} files added`);
}

// Upload a whole folder: its files go into a folder of the same name, and its subfolders become
// folders inside it, however deep.
$('folderInput').addEventListener('change', async e => {
  const all = [...(e.target.files || [])];
  const base = folderUploadTo || currentFolder();
  if (!all.length) return;
  // Everything except system clutter and Markdown files (which would turn into notes).
  const pdfs = all.filter(f => !/^(\.ds_store|thumbs\.db|desktop\.ini)$/i.test(f.name) && !f.name.startsWith('.') && !/\.md$/i.test(f.name));
  const top = (all[0].webkitRelativePath || '').split('/')[0] || 'folder';
  if (!pdfs.length) return toast(`“${top}” has no files in it.`, 'error');
  toast(`Adding ${plural(pdfs.length, 'file')} from “${top}”…`);
  const made = new Map();
  let added = 0, landing = base;
  for (const f of pdfs) {
    try {
      let dest = base;
      for (const name of (f.webkitRelativePath || f.name).split('/').slice(0, -1)) {
        const key = [...dest, name].join('/');
        if (!made.has(key)) made.set(key, [...dest, await api.ensureFolder(dest, name)]);
        dest = made.get(key);
        if (dest.length === base.length + 1) landing = dest;
      }
      await api.addFile(dest, f.name, new Uint8Array(await f.arrayBuffer()));
      added++;
    } catch (err) { toast(err.message, 'error'); }
  }
  goToFolder(landing);
  view = { mode: 'browse' };
  await reload();
  const skipped = all.length - pdfs.length;
  toast(`${plural(added, 'file')} added${skipped ? ` (${plural(skipped, 'hidden or system file')} skipped)` : ''}`);
});

// Drag files from the computer onto the window to upload them into the folder on screen.
let dragDepth = 0;
const draggingFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => {
  if (!draggingFiles(e) || !cls || view.mode === 'edit') return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    $('dropHint').textContent = `Drop to upload into “${placeLabel(currentFolder())}”`;
    document.body.classList.add('dragging');
  }
});
document.addEventListener('dragover', e => { if (draggingFiles(e) && cls) e.preventDefault(); });
document.addEventListener('dragleave', e => {
  if (!draggingFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('drop', async e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!cls || view.mode === 'edit') return;
  const items = [...(e.dataTransfer.items || [])].map(i => { try { return i.webkitGetAsEntry?.(); } catch { return null; } }).filter(Boolean);
  if (items.some(x => x.isDirectory)) return toast('To upload a whole folder, use ＋ → Upload a folder.', 'error');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  uploadTo = currentFolder();
  await uploadFiles(files);
});

// What the ＋ button offers in the folder on screen.
function addOptions() {
  const here = currentFolder();
  const opts = [{ label: here.length === 1 ? '📁 New subject folder' : '📁 New folder', run: () => newFolder(here) }];
  opts.push({ label: '📎 Upload files', run: () => pickFiles(here) });
  if (canPickFolder) opts.push({ label: '🗂 Upload a folder', run: () => pickFolder(here) });
  opts.push({ label: '✎ Write a note', run: () => openEditor(here) });
  return opts;
}

async function renameFileItem(x) {
  const segs = x.path.split('/');
  const p = await ask({ title: `Rename “${x.name}”`, value: x.name, ok: 'Rename', onSubmit: v => api.renameFile(segs, v) });
  if (!p || p === x.path) return;
  await reload();
}

async function deleteFileItem(x) {
  const ok = await confirmBox({ title: `Delete “${x.name}”?`, text: 'The file will be removed from this device and from GitHub.', ok: 'Delete', danger: true });
  if (!ok) return;
  try { await api.deleteFile(x.path.split('/')); } catch (e) { return toast(e.message, 'error'); }
  if (view.path === x.path) view = { mode: 'browse' };
  await reload();
  toast('File deleted');
}

// ---------- sharing ----------
// Note text for messages: Markdown turned into plain text that reads well in WhatsApp, email and so on.
function noteText(n) {
  const body = n.body.trim()
    .replace(/^#{1,6}\s+(.*)$/gm, (_m, h) => `*${h.trim()}*`)    // headings → bold line
    .replace(/\*\*(.+?)\*\*/g, '*$1*')                         // **bold** → *bold*
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/^\s*[-+]\s+/gm, '• ')                              // bullets
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '$1')                  // images → their link
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')             // links → text (link)
    .replace(/`([^`]+)`/g, '$1');
  return `*${n.title}*\n\n${body}\n`;
}
const isWindows = () => api.platform === 'windows';

async function shareNote(n, e) {
  if (isWindows()) {
    return showPopup(e, [
      { label: '📋 Copy note text', run: async () => { await api.copyText(noteText(n)); toast('Note copied. Paste it into WhatsApp, email or anywhere else.'); } },
      { label: '💾 Save as text file', run: async () => { if (await api.saveTextFile(n.title, noteText(n))) toast('Note saved'); } },
    ]);
  }
  try {
    const r = await api.shareText(n.title, noteText(n));
    if (r === 'copied') toast('Note copied. Paste it into WhatsApp, email or anywhere else.');
  } catch (err) { toast(`Couldn't share: ${err.message}`, 'error'); }
}

async function shareFileItem(x, e) {
  if (isWindows()) {
    return showPopup(e, [
      { label: '📂 Show in folder (to attach it)', run: () => api.showFileInFolder(x.path) },
      { label: '💾 Save a copy…', run: async () => { if (await api.saveFileCopy(x.path)) toast('Copy saved'); } },
      { label: '↗ Open in app', run: () => api.openFileExternally(x.path).catch(err => toast(err.message, 'error')) },
    ]);
  }
  try {
    const r = await api.shareFile(x.path);
    if (r === 'downloaded') toast('File downloaded. You can send it from your Downloads.');
    if (r && r.needsTap) {
      // The browser needs a fresh tap before it opens the share menu.
      openModal(`<h3>Share “${esc(x.name)}”</h3><p>Your file is ready.</p>
        <div class="row"><button class="btn ghost" data-action="modal-cancel">Cancel</button><button class="btn" id="shareNow">Share</button></div>`);
      $('shareNow').onclick = () => { closeModal(); r.needsTap().catch(err => toast(`Couldn't share: ${err.message}`, 'error')); };
    }
  } catch (err) { toast(`Couldn't share: ${err.message}`, 'error'); }
}

// ---------- opening files ----------
// Files are only stored here; opening one hands it to the device's own app for it (PDF reader, Word, video player...).
async function openFileItem(x, e) {
  if (!x) return;
  try {
    if (isWindows()) return await api.openFileExternally(x.path);
    toast(`Opening “${x.name}”…`);
    const r = await api.openFile(x.path);
    if (r === 'downloaded') toast('Saved to your Downloads. Open it from there.');
    if (r && r.needsTap) {
      // The browser needs a fresh tap before it shows the "Open in" menu.
      openModal(`<h3>Open “${esc(x.name)}”</h3><p>Choose the app to open it with in the next menu.</p>
        <div class="row"><button class="btn ghost" data-action="modal-cancel">Cancel</button><button class="btn" id="openNow">Open</button></div>`);
      $('openNow').onclick = () => { closeModal(); r.needsTap().catch(err => toast(`Couldn't open: ${err.message}`, 'error')); };
    }
  } catch (err) {
    toast(/no app|activity|not found/i.test(err.message) ? 'No app on this device can open this type of file. Install one that can (for PDFs, Adobe Acrobat or Google Drive).' : `Couldn't open: ${err.message}`, 'error');
  }
}

// ---------- moving things ----------
// Ask where to move a file, note or folder (`segs` is its full path), then move it.
async function moveTo(segs, label) {
  const isFolder = !!folderAt(segs);
  const from = segs.slice(0, -1).join('/');
  const rows = [];
  for (const c of classes) {
    walk(c, [c.name], (node, folderSegs) => {
      const key = folderSegs.join('/');
      // A folder can't go inside itself; its current place is shown but can't be picked.
      if (isFolder && (key === segs.join('/') || key.startsWith(segs.join('/') + '/'))) return;
      const here = key === from;
      rows.push(`<div class="move-row${here ? ' current' : ''}" ${here ? '' : `data-action="move-here" data-to="${esc(key)}"`}
        style="padding-left:${12 + (folderSegs.length - 1) * 18}px">${folderSegs.length === 1 ? '🎓' : '📁'} ${esc(node.name)}${here ? ' <span class="sub">(here now)</span>' : ''}</div>`);
    });
  }
  openModal(`<h3>Move “${esc(label)}”</h3><p>Choose the folder to move it into.</p>
    <div class="move-list">${rows.join('')}</div>
    <div class="row"><button class="btn ghost" data-action="modal-cancel">Cancel</button></div>`);
  const to = await new Promise(resolve => { modalDone = resolve; });
  if (!to) return;
  try {
    const moved = await api.moveItem(segs, to.split('/'));
    // Seen-markers follow moved notes so they don't show up as new again.
    const oldKey = segs.join('/'), newKey = moved;
    seen = new Set([...seen].map(p => (p === oldKey ? newKey : p.startsWith(oldKey + '/') ? newKey + p.slice(oldKey.length) : p)));
    save('seen', [...seen]);
    if (view.mode === 'note' && view.path === oldKey) { view = { mode: 'note', path: newKey }; goToFolder(folderOf(newKey)); }
    const open = [cls, ...path];
    if (isFolder && segs.every((x, i) => open[i] === x)) goToFolder([...moved.split('/'), ...open.slice(segs.length)]);
    await reload();
    toast(`Moved to ${placeLabel(to.split('/'))}`);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- settings ----------
async function openSettings() {
  const s = await api.getSettings();
  const err = syncState.state === 'error' ? syncState.message : '';
  openModal(`<h3>Sync with GitHub</h3>
    <p>Your notes are saved on this computer and copied to the <b>notes/</b> folder of your GitHub repository.
    That's how Claude adds notes for you, and how your notes stay backed up.</p>
    <label>Repository (owner/name)</label><input id="setRepo" value="${esc(s.repo)}">
    <label>Branch</label><input id="setBranch" value="${esc(s.branch)}">
    <label>Access token</label><input id="setToken" type="password" placeholder="${s.hasToken ? 'Saved. Leave empty to keep it' : 'github_pat_…'}">
    <ol><li>Open <a data-action="token-page">GitHub → new fine-grained token</a>.</li>
      <li>Name it “My Notes”. Set <b>Expiration</b> to <b>No expiration</b> (or 1 year) so it keeps working.</li>
      <li>Under <b>Repository access</b> choose <b>Only select repositories</b> → your notes repo.</li>
      <li>Under <b>Permissions → Repository permissions</b> set <b>Contents</b> to <b>Read and write</b>.</li>
      <li>Click <b>Generate token</b>, copy it and paste it above.</li></ol>
    <div class="err" id="setErr">${esc(err)}</div>
    ${s.notesFolder ? '' : '<p style="margin-top:10px">The token is kept only on this device. Set up each device once.</p>'}
    <div class="row">${s.notesFolder ? `<button class="btn ghost left" data-action="open-folder-os" title="${esc(s.notesFolder)}">📂 Notes folder</button>` : ''}
      ${s.hasToken ? '<button class="btn ghost danger" data-action="disconnect">Disconnect</button>' : ''}
      <button class="btn ghost" data-action="modal-cancel">Close</button>
      <button class="btn" data-action="save-settings">Save &amp; sync</button></div>`);
}
async function saveSettings() {
  const token = $('setToken').value.trim();
  $('setErr').textContent = 'Connecting…';
  const st = await api.saveSettings({ repo: $('setRepo').value, branch: $('setBranch').value, ...(token && { token }) });
  if (st.state === 'error' || st.state === 'offline') { $('setErr').textContent = st.message; return; }
  if (st.state === 'off') { $('setErr').textContent = 'Please paste an access token.'; return; }
  closeModal();
  toast('Connected to GitHub ✓');
}

// ---------- actions ----------
const actions = {
  'class-menu': () => {
    const m = $('classMenu');
    if (m.classList.contains('show')) return closeMenus();
    closeMenus();
    m.innerHTML = classes.map(c => `<div class="menu-item ${c.name === cls ? 'active' : ''}" data-action="pick-class" data-name="${esc(c.name)}">
        <span>🎓 ${esc(c.name)}${allNotes(c).some(isNew) ? '<span class="new-dot"></span>' : ''}</span><span class="sub">${plural(c.folders.length, 'subject')}</span></div>`).join('')
      + (classes.length ? '<div class="menu-sep"></div>' : '')
      + '<div class="menu-item accent" data-action="new-class">＋ New class</div>'
      + (cls ? `<div class="menu-item" data-action="rename-class">✎ Rename “${esc(cls)}”</div>
                <div class="menu-item danger" data-action="delete-class">🗑 Delete “${esc(cls)}”</div>` : '');
    m.classList.add('show');
  },
  'pick-class': async d => {
    closeMenus();
    if (!(await leaveEditor())) return;
    cls = d.name; path = []; view = { mode: 'browse' }; clearSearch(); render();
  },
  'new-class': async () => { closeMenus(); if (await leaveEditor()) { render(); newClass(); } },
  'rename-class': () => { closeMenus(); renameFolder([cls]); },
  'delete-class': () => { closeMenus(); deleteFolder([cls]); },
  crumb: async d => {
    if (!(await leaveEditor())) return;
    path = path.slice(0, +d.i); view = { mode: 'browse' }; clearSearch(); render();
  },
  'open-folder': d => { path = [...path, d.name]; render(); $('main').scrollTop = 0; },
  'make-pdf-folder': async () => {
    try { await api.ensureFolder([cls, ...path], PDF_DIR); } catch (e) { return toast(e.message, 'error'); }
    path = [...path, PDF_DIR];
    await reload();
  },
  'new-folder': () => newFolder(),
  'folder-menu': (d, e) => {
    const segs = [cls, ...path, d.name];
    showPopup(e, [
      { label: '✎ Rename', run: () => renameFolder(segs) },
      { label: '↪ Move to…', run: () => moveTo(segs, d.name) },
      '-',
      { label: '🗑 Delete', cls: 'danger', run: () => deleteFolder(segs) },
    ]);
  },
  'popup-item': d => { const item = $('popup')._items[+d.i]; closeMenus(); item.run(); },
  'open-note': d => {
    const n = findNote(d.path);
    if (!n) return;
    goToFolder(folderOf(d.path));
    view = { mode: 'note', path: n.path };
    markSeen(n);
    clearSearch();
    render();
    $('main').scrollTop = 0;
  },
  back: () => { view = { mode: 'browse' }; render(); },
  'move-note': () => { const n = findNote(view.path); moveTo(n.path.split('/'), n.title); },
  'edit-note': () => { const n = findNote(view.path); openEditor(folderOf(n.path), n); },
  'delete-note': async () => {
    const n = findNote(view.path);
    if (!(await confirmBox({ title: `Delete “${n.title}”?`, text: 'The note will be removed from this computer and from GitHub.', ok: 'Delete', danger: true }))) return;
    try { await api.deleteNote(n.path.split('/')); } catch (e) { return toast(e.message, 'error'); }
    view = { mode: 'browse' };
    await reload();
    toast('Note deleted');
  },
  fab: (_d, e) => {
    if (!cls) return newClass();
    const opts = addOptions();
    if (!e) return opts[0].run(); // Ctrl+N: the first option
    showPopup(e, opts);
  },
  'open-file': (d, e) => openFileItem(findFile(d.path), e),
  'file-menu': (d, e) => {
    const x = findFile(d.path);
    const share = isWindows()
      ? [{ label: '📂 Show in folder', run: () => api.showFileInFolder(x.path) },
        { label: '💾 Save a copy…', run: async () => { if (await api.saveFileCopy(x.path)) toast('Copy saved'); } },
      ]
      : [{ label: '↗ Share', run: () => shareFileItem(x) }];
    showPopup(e, [
      { label: '📖 Open', run: () => openFileItem(x) },
      ...share,
      { label: '✎ Rename', run: () => renameFileItem(x) },
      { label: '↪ Move to…', run: () => moveTo(x.path.split('/'), x.name) },
      '-',
      { label: '🗑 Delete', cls: 'danger', run: () => deleteFileItem(x) },
    ]);
  },
  'share-file': (d, e) => shareFileItem(findFile(d.path), e),
  'share-note': (_d, e) => shareNote(findNote(view.path), e),
  'prepare-upload': () => prepareUpload(),
  'write-note': () => openEditor(currentFolder()),
  'save-note': () => saveEditor(),
  'cancel-edit': async () => { if (await leaveEditor()) render(); },
  'toggle-preview': (_d, _e, el) => {
    const split = !$('edPanes').classList.contains('split');
    $('edPanes').classList.toggle('split', split);
    $('edLive').classList.toggle('hidden', !split);
    el.textContent = previewLabel(split);
    save('split', split);
  },
  sync: () => {
    if (syncState.state === 'off' || syncState.state === 'error') return openSettings();
    api.sync();
  },
  settings: () => openSettings(),
  'save-settings': () => saveSettings(),
  disconnect: async () => { await api.saveSettings({ token: '' }); closeModal(); toast('Disconnected from GitHub'); },
  'token-page': () => api.openExternal('https://github.com/settings/personal-access-tokens/new'),
  'open-folder-os': () => api.openNotesFolder(),
  'modal-cancel': () => closeModal(null),
  'move-here': d => closeModal(d.to),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!e.target.closest('.menu, .popup') && el?.dataset.action !== 'class-menu' && el?.dataset.action !== 'folder-menu') closeMenus();
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset, e, el);
});
$('modalBg').addEventListener('mousedown', e => { if (e.target === $('modalBg')) closeModal(null); });

function clearSearch() { query = ''; $('search').value = ''; }
$('search').addEventListener('input', async e => {
  if (view.mode === 'edit' && !(await leaveEditor())) { e.target.value = ''; return; }
  query = e.target.value.trim();
  render();
});

document.addEventListener('keydown', async e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's' && view.mode === 'edit') { e.preventDefault(); return saveEditor(); }
  if (modalOpen()) { if (e.key === 'Escape') closeModal(null); return; }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); if (fabLabel()) actions.fab(); return; }
  if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (e.key !== 'Escape') return;
  // Esc in an empty search box shouldn't also leave the folder you're in.
  if (view.mode === 'browse' && !query && document.activeElement?.tagName === 'INPUT') return;
  goBack();
});

// One step back (Esc, or the Android back button). Returns false when already at the top.
async function goBack() {
  if (modalOpen()) { closeModal(null); return true; }
  if ($('popup').classList.contains('show') || $('classMenu').classList.contains('show')) { closeMenus(); return true; }
  if (view.mode === 'edit') { if (await leaveEditor()) render(); return true; }
  if (query) { clearSearch(); render(); return true; }
  if (view.mode === 'note') { view = { mode: 'browse' }; render(); return true; }
  if (path.length) { path.pop(); render(); return true; }
  return false;
}
window.handleBack = goBack;

// ---------- sync events ----------
// Files over GitHub's 100 MB limit stay on this device; say so once for each new set of them.
let tooBigShown = '';
api.onSyncStatus(st => {
  syncState = st;
  renderSync();
  const big = st.result?.tooBig || [];
  const key = big.join('|');
  if (big.length && key !== tooBigShown) {
    const names = big.slice(0, 2).map(p => `“${p.split('/').pop()}”`).join(', ') + (big.length > 2 ? ` and ${big.length - 2} more` : '');
    toast(`${names} ${big.length === 1 ? 'is' : 'are'} over 100 MB, which GitHub can't store. ${big.length === 1 ? 'It stays' : 'They stay'} on this device only and won't appear on your other devices.`, 'error');
  }
  tooBigShown = key;
});
api.onTreeChanged(async result => {
  await reload();
  const added = result.downloaded.map(findNote).filter(n => n && isNew(n));
  added.slice(0, 3).forEach(n => {
    toast(`✨ Claude added “${n.title}” to ${placeLabel(folderOf(n.path))}`, 'claude');
  });
  if (added.length > 3) toast(`✨ …and ${added.length - 3} more notes from Claude`, 'claude');
});
setInterval(renderSync, 30000);

(async () => {
  syncState = await api.syncStatus();
  await reload();
})();
