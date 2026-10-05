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
let path = [];                        // [subject, 'notes' | 'pdfs', chapter] inside the current class
let view = { mode: 'browse' };        // browse | note {path} | edit {dir, note}
let query = '';
let seen = new Set(load('seen', []));
let syncState = { state: 'off' };
let dirty = false;

const curClass = () => classes.find(c => c.name === cls);
const curSubject = () => (path[0] && curClass()?.subjects.find(s => s.name === path[0])) || null;
const curChapter = () => (path[1] === 'notes' && path[2] && curSubject()?.chapters.find(c => c.name === path[2])) || null;
const SECTION = { notes: 'Chapter Notes', pdfs: 'Chapter PDFs' };
const PDF_DIR = 'Chapter PDFs';
// The folder a note or file is in, as path segments, e.g. ['Class 11', 'Accounts', 'Depreciation'].
const folderOf = p => String(p).split('/').slice(0, -1);
// A short label for a folder: "Accounts › Depreciation", or just the class name for the class itself.
const placeLabel = segs => (segs.length === 1 ? segs[0] : segs.slice(1).join(' › '));

// The notes and files kept directly in a folder (a class, subject, chapter or Chapter PDFs).
function folderContents(segs) {
  const c = classes.find(x => x.name === segs[0]);
  if (!c || segs.length === 1) return c || null;
  const s = c.subjects.find(x => x.name === segs[1]);
  if (!s || segs.length === 2) return s || null;
  if (segs[2] === PDF_DIR) return { notes: [], files: s.pdfFolder };
  return s.chapters.find(x => x.name === segs[2]) || null;
}
const findNote = p => folderContents(folderOf(p))?.notes.find(n => n.path === p);
const findFile = p => folderContents(folderOf(p))?.files.find(x => x.path === p);

// Every note or file in a class, each labelled with where it is.
function everything(c, key) {
  const out = [];
  const add = (list, segs) => list.forEach(x => out.push({ ...x, cls: c.name, where: placeLabel(segs) }));
  add(c[key], [c.name]);
  for (const s of c.subjects) {
    add(s[key], [c.name, s.name]);
    if (key === 'files') add(s.pdfFolder, [c.name, s.name, PDF_DIR]);
    for (const ch of s.chapters) add(ch[key], [c.name, s.name, ch.name]);
  }
  return out;
}
const allNotes = c => everything(c, 'notes');
const allFiles = c => everything(c, 'files');
const fullPlace = x => (x.where === x.cls ? x.cls : `${x.cls} › ${x.where}`);

// The folder the screen shows (where ＋ adds things), and the way back to a folder.
function currentFolder() {
  if (view.mode === 'edit') return view.dir;
  if (view.mode === 'note') return folderOf(view.path);
  if (!path.length) return [cls];
  if (path.length === 1) return [cls, path[0]];
  if (path[1] === 'pdfs') return [cls, path[0], PDF_DIR];
  if (path.length === 2) return [cls, path[0]];   // the Chapter Notes list belongs to its subject
  return [cls, path[0], path[2]];
}
function goToFolder(segs) {
  cls = segs[0];
  if (segs.length === 1) path = [];
  else if (segs.length === 2) path = [segs[1]];
  else path = segs[2] === PDF_DIR ? [segs[1], 'pdfs'] : [segs[1], 'notes', segs[2]];
}

const isNew = n => n.author === 'claude' && !seen.has(n.path);
const markSeen = n => { if (!seen.has(n.path)) { seen.add(n.path); save('seen', [...seen]); } };

async function reload() {
  try { classes = await api.tree(); } catch (e) { toast(e.message, 'error'); }
  if (!curClass()) { cls = classes[0]?.name ?? null; path = []; }
  if (path[0] && !curSubject()) path = [];
  if (path[1] && !SECTION[path[1]]) path = path.slice(0, 1);
  if (path[2] && !curChapter()) path = path.slice(0, 2);
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
  else if (!path.length) main.innerHTML = subjectsView();
  else if (path.length === 1) main.innerHTML = subjectView();
  else if (path[1] === 'pdfs') main.innerHTML = pdfsView();
  else if (path.length === 2) main.innerHTML = chaptersView();
  else main.innerHTML = notesView();
}

function renderTop() {
  $('classBtn').innerHTML = cls
    ? `🎓 <span class="name">${esc(cls)}</span> <span class="caret">▾</span>`
    : `🎓 <span class="name">Choose class</span> <span class="caret">▾</span>`;
  const parts = [];
  if (cls) parts.push(path.length || view.mode !== 'browse' ? `<a data-action="crumb" data-i="0">Subjects</a>` : `<span>Subjects</span>`);
  path.forEach((p, i) => {
    const last = i === path.length - 1 && view.mode === 'browse';
    const label = i === 1 ? SECTION[p] : p;
    parts.push(last ? `<span>${esc(label)}</span>` : `<a data-action="crumb" data-i="${i + 1}">${esc(label)}</a>`);
  });
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
    <p>Start by creating your first class, for example “Class 10”.<br>Then add subjects, chapters, files and notes with the ＋ button.</p>
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
const addHint = '<p>Press the ＋ button to add a folder, upload files or write a note.</p>';

function subjectsView() {
  const c = curClass();
  // Recent notes from inside the subjects (notes kept directly in the class are listed on their own).
  const recent = allNotes(c).filter(n => n.where !== c.name)
    .sort((a, b) => b.updated.localeCompare(a.updated) || b.mtime - a.mtime).slice(0, 6);
  const head = `<h1 class="page">🎓 ${esc(c.name)}</h1>`;
  if (!c.subjects.length && !c.files.length && !c.notes.length) {
    return head + `<div class="empty"><div class="big">📁</div><h2>Nothing in ${esc(c.name)} yet</h2>${addHint}</div>`;
  }
  return head
    + (c.subjects.length ? `<div class="section"><p class="label">Subjects</p><div class="grid">${c.subjects.map(s => {
      const notes = [...s.notes, ...s.chapters.flatMap(ch => ch.notes)];
      const files = s.files.length + s.pdfFolder.length + s.chapters.reduce((n, ch) => n + ch.files.length, 0);
      return folderCard(s.name, '📁', `${plural(files, 'file')} · ${plural(notes.length, 'note')}`, notes.some(isNew));
    }).join('')}</div></div>` : '')
    + itemsSection(c)
    + (recent.length ? `<div class="section"><p class="label">Recent notes</p><div class="list">${recent.map(n => noteCard(n, n.where)).join('')}</div></div>` : '');
}

// Inside a subject: one folder for chapter PDFs, one for chapter notes, then anything kept directly in the subject.
function subjectView() {
  const s = curSubject();
  const notes = s.chapters.flatMap(ch => ch.notes);
  const card = (kind, icon, count, hasNew) => `<div class="folder section-card" data-action="open-section" data-kind="${kind}">
    <div class="icon">${icon}</div>
    <div class="name">${SECTION[kind]}${hasNew ? '<span class="new-dot" title="New notes from Claude"></span>' : ''}</div>
    <div class="count">${count}</div></div>`;
  return `<h1 class="page">📁 ${esc(s.name)}</h1><div class="grid sections">
    ${card('pdfs', '📄', plural(s.pdfFolder.length, 'PDF'), false)}
    ${card('notes', '📝', `${plural(s.chapters.length, 'chapter')} · ${plural(notes.length, 'note')}`, notes.some(isNew))}</div>`
    + itemsSection(s);
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

function pdfsView() {
  const s = curSubject();
  // A <label> opens the device's file picker natively, the most reliable way on phones and iPads.
  const upload = big => `<label for="pdfInput" class="btn${big ? '' : ' ghost'}" data-action="prepare-upload">📎 Upload file</label>`;
  const head = `<div class="page-row"><h1 class="page">📄 ${esc(s.name)} · Chapter PDFs</h1>${s.pdfFolder.length ? upload(false) : ''}</div>`;
  if (!s.pdfFolder.length) {
    return head + `<div class="empty"><div class="big">📄</div><h2>No files yet</h2>
      <p>Upload chapter PDFs or any other files from this device. You can pick several at once. Tapping a file opens it in its app.</p><p>${upload(true)}</p></div>`;
  }
  return head + `<p class="label">${plural(s.pdfFolder.length, 'PDF')}</p><div class="list">${s.pdfFolder.map(x => fileCard(x)).join('')}</div>`;
}

function chaptersView() {
  const s = curSubject();
  const head = `<h1 class="page">📝 ${esc(s.name)} · Chapter Notes</h1>`;
  if (!s.chapters.length) {
    return head + `<div class="empty"><div class="big">📂</div><h2>No chapters yet</h2><p>Press the ＋ button to add a chapter folder.</p></div>`;
  }
  return head + `<p class="label">Chapters</p><div class="grid">${s.chapters.map(ch =>
    folderCard(ch.name, '📂', ch.files.length ? `${plural(ch.notes.length, 'note')} · ${plural(ch.files.length, 'file')}` : plural(ch.notes.length, 'note'),
      ch.notes.some(isNew))).join('')}</div>`;
}

// A chapter: its notes and its files, with buttons to add either.
function notesView() {
  const ch = curChapter();
  const buttons = `<button class="btn ghost" data-action="write-note">✎ Write a note</button>
    <label for="pdfInput" class="btn ghost" data-action="prepare-upload">📎 Upload file</label>`;
  const head = `<div class="page-row"><h1 class="page">📂 ${esc(ch.name)}</h1>${ch.notes.length || ch.files.length ? buttons : ''}</div>`;
  if (!ch.notes.length && !ch.files.length) {
    return head + `<div class="empty"><div class="big">📝</div><h2>Nothing in this chapter yet</h2>
      <p>Write a note, upload files (PDFs, photos, documents…), or ask Claude to make notes for this chapter.</p>
      <p class="empty-actions"><button class="btn" data-action="write-note">✎ Write a note</button>
      <label for="pdfInput" class="btn" data-action="prepare-upload">📎 Upload file</label></p></div>`;
  }
  return head + itemsSection(ch);
}

function noteView(n) {
  if (!n) return '';
  return `<div class="doc">
    <div class="doc-head"><h1>${esc(n.title)}</h1>
      <button class="btn ghost" data-action="back">← Back</button>
      <button class="btn ghost" data-action="share-note">↗ Share</button>
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
function folderStats(segs) {
  const c = classes.find(x => x.name === segs[0]);
  if (segs.length === 1) return { subjects: c.subjects.length, files: allFiles(c).length, notes: allNotes(c).length };
  const s = c.subjects.find(x => x.name === segs[1]);
  if (segs.length === 2) {
    return {
      files: s.files.length + s.pdfFolder.length + s.chapters.reduce((n, ch) => n + ch.files.length, 0),
      chapters: s.chapters.length,
      notes: s.notes.length + s.chapters.reduce((n, ch) => n + ch.notes.length, 0),
    };
  }
  const ch = s.chapters.find(x => x.name === segs[2]);
  return { files: ch.files.length, notes: ch.notes.length };
}

// Add a subject (inside a class) or a chapter (inside a subject).
async function newFolder(parent = currentFolder()) {
  const kind = parent.length === 1 ? 'subject' : 'chapter';
  const name = await ask({
    title: `New ${kind} folder`,
    placeholder: kind === 'subject' ? 'e.g. Biology' : 'e.g. Ch 6 Life Processes',
    onSubmit: v => api.createFolder(parent, v),
  });
  if (!name) return;
  goToFolder([...parent, name]);
  view = { mode: 'browse' };
  await reload();
  toast(`${kind === 'subject' ? 'Subject' : 'Chapter'} “${name}” created`);
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
  if (segs.length === 1 && cls === old) cls = name;
  else if (segs[0] === cls && segs.length === 2 && path[0] === old) path[0] = name;
  else if (segs[0] === cls && segs.length === 3 && path[0] === segs[1] && path[2] === old) path[2] = name;
  await reload();
}

async function deleteFolder(segs) {
  const st = folderStats(segs);
  const inside = [st.subjects != null && plural(st.subjects, 'subject'), st.files != null && plural(st.files, 'file'),
    st.chapters != null && plural(st.chapters, 'chapter'), plural(st.notes, 'note')]
    .filter(Boolean).join(', ');
  const ok = await confirmBox({
    title: `Delete “${segs[segs.length - 1]}”?`,
    text: `This deletes everything inside it (${inside}), on this computer and on GitHub. This cannot be undone.`,
    ok: 'Delete', danger: true,
  });
  if (!ok) return;
  try { await api.deleteFolder(segs); } catch (e) { return toast(e.message, 'error'); }
  if (segs.length === 1 && cls === segs[0]) { cls = null; path = []; }
  else if (segs[0] === cls && segs.length === 2 && path[0] === segs[1]) path = [];
  else if (segs[0] === cls && segs.length === 3 && path[0] === segs[1] && path[2] === segs[2]) path = [path[0], 'notes'];
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
$('pdfInput').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  const target = uploadTo || (cls ? currentFolder() : null);
  if (!files.length) return;
  if (!target) return toast('Create a class first, then upload files into it.', 'error');
  toast(files.length === 1 ? `Adding “${files[0].name}”…` : `Adding ${files.length} files…`);
  let added = 0;
  for (const f of files) {
    try {
      if (f.size > 50 * 1024 * 1024) throw new Error(`“${f.name}” is larger than 50 MB, which GitHub can't sync. Please use a smaller file.`);
      await api.addFile(target, f.name, new Uint8Array(await f.arrayBuffer()));
      added++;
    } catch (err) { toast(err.message, 'error'); }
  }
  if (!added) return;
  goToFolder(target);
  view = { mode: 'browse' };
  await reload();
  toast(added === 1 ? 'File added' : `${added} files added`);
});

// Upload a whole folder: its files go into a folder of the same name, and its subfolders become
// subjects/chapters as far as class › subject › chapter allows. Deeper files go into the deepest folder.
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
      if (f.size > 50 * 1024 * 1024) throw new Error(`“${f.name}” is larger than 50 MB, which GitHub can't sync.`);
      let dest = base;
      for (const name of (f.webkitRelativePath || f.name).split('/').slice(0, -1)) {
        if (dest.length >= 3) break; // no folders below a chapter
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

// What the ＋ button offers in the folder on screen.
function addOptions() {
  const here = currentFolder();
  const inPdfFolder = here[2] === PDF_DIR;
  const opts = [];
  if (here.length < 3) opts.push({ label: here.length === 1 ? '📁 New subject folder' : '📁 New chapter folder', run: () => newFolder(here) });
  opts.push({ label: '📎 Upload files', run: () => pickFiles(here) });
  if (canPickFolder) opts.push({ label: '🗂 Upload a folder', run: () => pickFolder(here) });
  if (!inPdfFolder) opts.push({ label: '✎ Write a note', run: () => openEditor(here) });
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
        <span>🎓 ${esc(c.name)}${allNotes(c).some(isNew) ? '<span class="new-dot"></span>' : ''}</span><span class="sub">${plural(c.subjects.length, 'subject')}</span></div>`).join('')
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
  'open-folder': d => { path = path.length ? [path[0], 'notes', d.name] : [d.name]; render(); $('main').scrollTop = 0; },
  'open-section': d => { path = [path[0], d.kind]; render(); $('main').scrollTop = 0; },
  'folder-menu': (d, e) => {
    const segs = path.length ? [cls, path[0], d.name] : [cls, d.name];
    showPopup(e, [
      { label: '✎ Rename', run: () => renameFolder(segs) },
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
api.onSyncStatus(st => { syncState = st; renderSync(); });
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
