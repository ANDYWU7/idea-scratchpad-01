'use strict';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const W = canvas.width, H = canvas.height;
const textInput = $('#text-input');
let db, notes = [], folders = [], currentId, tool = 'type', ink = '#343c36', size = 'medium';
let viewMode = 'all', selectedFolderId = null, pendingDelete = null, editingFolderId = null, draggedNoteId = null;
let penDown = false, lastPoint, undoStack = [], redoStack = [], typing = null;
let saveTimer, toastTimer, saveRevision = 0, initialized = false;
let switchGeneration = 0, loadingNote = false;
let connectionStartId = null, stickyZ = 0;
const histories = new Map();
const current = () => notes.find(note => note.id === currentId);
const fontSize = () => ({ small: 24, medium: 32, large: 46 })[size];
const brushSize = () => ({ small: 3, medium: 6, large: 11 })[size];
const eraserSize = () => ({ small: 22, medium: 48, large: 88 })[size];
const stickyTones = ['sun', 'rose', 'blue', 'mint'];
const stickyColors = { sun: '#fff0a8', rose: '#ffd8cf', blue: '#d8edff', mint: '#dcefcf' };
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

function normalizeBoard(note) {
  const stickies = Array.isArray(note.stickies) ? note.stickies.filter(item => item && typeof item.id === 'string').map(item => ({
    id: item.id,
    text: typeof item.text === 'string' ? item.text.slice(0, 500) : '',
    x: Number.isFinite(item.x) ? Math.max(0, Math.min(.95, item.x)) : .08,
    y: Number.isFinite(item.y) ? Math.max(0, Math.min(.95, item.y)) : .1,
    tone: stickyTones.includes(item.tone) ? item.tone : 'sun',
    z: Number.isFinite(item.z) ? item.z : 1,
  })) : [];
  const ids = new Set(stickies.map(item => item.id));
  const connections = Array.isArray(note.connections) ? note.connections.filter(edge => edge && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to).map(edge => ({ from: edge.from, to: edge.to })) : [];
  return { ...note, stickies, connections };
}

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}
function status(message, error = false) {
  const label = $('#save-status');
  label.replaceChildren(document.createElement('span'), document.createTextNode(message));
  label.classList.toggle('error', error);
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('scratchpad-paper-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('notes', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function databaseAction(mode, operation) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('Storage unavailable')); return; }
    const tx = db.transaction('notes', mode);
    const request = operation(tx.objectStore('notes'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function recordChange() {
  if (!current()) return;
  current().updated = Date.now();
  status('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistCurrent, 300);
}
async function persistCurrent() {
  clearTimeout(saveTimer);
  const note = current();
  if (!note || loadingNote) return;
  // Capture synchronously, before another note can replace the canvas.
  note.image = canvas.toDataURL('image/png');
  const record = { ...note };
  const revision = ++saveRevision;
  try {
    await databaseAction('readwrite', store => store.put(record));
    if (revision === saveRevision) status('All changes saved');
  } catch {
    status('Not saved', true);
    notify('Storage is unavailable. Download your note to keep a copy.');
  }
  renderNotes();
}
function dateLabel(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function renderNotes() {
  const list = $('#note-list');
  list.replaceChildren();
  const visible = notes.filter(note => viewMode === 'scrapped'
    ? note.scrapped
    : !note.scrapped && (viewMode !== 'folder' || note.folderId === selectedFolderId));
  const sorted = [...visible].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created - a.created);
  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = viewMode === 'scrapped' ? 'No scrapped notes' : viewMode === 'folder' ? 'This folder is empty' : 'No notes yet';
    list.append(empty);
  }
  sorted.forEach(note => {
    const button = document.createElement('button');
    button.className = 'note-card' + (note.id === currentId ? ' selected' : '');
    button.draggable = true;
    button.title = 'Drag to move to All notes, a folder, or Scrapped';
    button.setAttribute('aria-current', String(note.id === currentId));
    button.innerHTML = icon('paper');
    const text = document.createElement('span');
    text.className = 'note-card-text';
    const title = document.createElement('strong');
    title.textContent = note.title || 'Untitled note';
    const meta = document.createElement('small');
    const folderName = folders.find(folder => folder.id === note.folderId)?.name;
    meta.textContent = note.scrapped ? `Scrapped · ${dateLabel(note.updated)}` : `${note.pinned ? 'Pinned · ' : ''}${folderName ? `${folderName} · ` : ''}${dateLabel(note.updated)}`;
    text.append(title, meta);
    button.append(text);
    if (note.pinned) {
      const pin = document.createElement('span');
      pin.innerHTML = icon('pin');
      pin.firstChild.classList.add('pin-indicator');
      button.append(pin);
    }
    button.addEventListener('click', () => selectNote(note.id));
    button.addEventListener('dragstart', event => {
      draggedNoteId = note.id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', note.id);
      requestAnimationFrame(() => button.classList.add('dragging'));
    });
    button.addEventListener('dragend', () => {
      draggedNoteId = null;
      document.querySelectorAll('.drop-target-active,.dragging').forEach(element => element.classList.remove('drop-target-active','dragging'));
    });
    list.append(button);
  });
  $('#note-count').textContent = String(visible.length).padStart(2, '0');
  $('#paper-number').textContent = String(Math.max(1, sorted.findIndex(n => n.id === currentId) + 1)).padStart(2, '0');
  $('#active-count').textContent = String(notes.filter(note => !note.scrapped).length);
  $('#scrapped-count').textContent = String(notes.filter(note => note.scrapped).length);
  $('#all-notes').classList.toggle('active', viewMode === 'all');
  $('#all-notes').setAttribute('aria-current', viewMode === 'all' ? 'page' : 'false');
  $('#scrapped-notes').classList.toggle('active', viewMode === 'scrapped');
  $('#scrapped-notes').setAttribute('aria-current', viewMode === 'scrapped' ? 'page' : 'false');
  const heading = viewMode === 'scrapped' ? 'SCRAPPED' : viewMode === 'folder'
    ? (folders.find(folder => folder.id === selectedFolderId)?.name || 'FOLDER').toUpperCase() : 'ALL NOTES';
  $('#note-list-label').textContent = heading;
  $('#workspace-label').textContent = heading;
  renderFolders();
  renderNoteActions(current());
}
function renderNoteActions(note) {
  const scrapped = Boolean(note?.scrapped);
  $('#note-state').hidden = !note;
  $('#note-state').textContent = scrapped ? 'SCRAPPED' : 'ACTIVE';
  $('#note-state').classList.toggle('scrapped-state', scrapped);
  $('#note-state').classList.toggle('active-state', Boolean(note) && !scrapped);
  $('#pin-note').hidden = !note || scrapped;
  $('#pin-note').classList.toggle('active', Boolean(note?.pinned));
  $('#pin-note').setAttribute('aria-pressed', String(Boolean(note?.pinned)));
  $('#pin-note').setAttribute('aria-label', note?.pinned ? 'Unpin note' : 'Pin note');
  $('#pin-note').title = note?.pinned ? 'Unpin note' : 'Pin note';
  $('#scrap-note').hidden = !note || scrapped;
  $('#restore-note').hidden = !scrapped;
  $('#delete-note').hidden = !scrapped;
  $('#folder-select-label').hidden = !note || scrapped;
  $('#add-sticky').disabled = !note || scrapped;
}
function drawConnections(note = current()) {
  const svg = $('#connection-layer');
  svg.replaceChildren();
  if (!note) return;
  const paperRect = $('#paper').getBoundingClientRect();
  if (!paperRect.width || !paperRect.height) return;
  for (const connection of note.connections || []) {
    const from = $(`#sticky-${CSS.escape(connection.from)}`);
    const to = $(`#sticky-${CSS.escape(connection.to)}`);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const ax = (a.left + a.width / 2 - paperRect.left) * W / paperRect.width;
    const ay = (a.top + a.height / 2 - paperRect.top) * H / paperRect.height;
    const bx = (b.left + b.width / 2 - paperRect.left) * W / paperRect.width;
    const by = (b.top + b.height / 2 - paperRect.top) * H / paperRect.height;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const bend = Math.max(28, Math.abs(bx - ax) * .28);
    const direction = bx >= ax ? 1 : -1;
    path.setAttribute('d', `M ${ax} ${ay} C ${ax + bend * direction} ${ay}, ${bx - bend * direction} ${by}, ${bx} ${by}`);
    path.classList.add('connection-line');
    path.setAttribute('role', 'button');
    path.setAttribute('tabindex', '0');
    path.setAttribute('aria-label', 'Remove connection');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.title = 'Click to remove this line';
    const remove = () => {
      note.connections = note.connections.filter(edge => edge !== connection);
      drawConnections(note); recordChange(); notify('Connection removed');
    };
    path.addEventListener('click', remove);
    path.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); remove(); } });
    svg.append(path);
  }
}
function renderStickyBoard(note = current()) {
  const layer = $('#sticky-layer');
  layer.replaceChildren();
  $('#connection-layer').replaceChildren();
  if (!note) return;
  for (const [index, sticky] of note.stickies.entries()) {
    stickyZ = Math.max(stickyZ, sticky.z || index + 1);
    const card = document.createElement('article');
    card.className = `sticky-note tone-${sticky.tone}`;
    card.id = `sticky-${sticky.id}`;
    card.style.left = `${sticky.x * 100}%`;
    card.style.top = `${sticky.y * 100}%`;
    card.style.zIndex = String(sticky.z || index + 1);
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `Sticky note ${index + 1}. Focus and use arrow keys to move; hold Shift for larger steps.`);
    const header = document.createElement('div');
    header.className = 'sticky-head';
    header.title = 'Drag to move this sticky note';
    const grip = document.createElement('span'); grip.className = 'sticky-grip'; grip.setAttribute('aria-hidden', 'true'); grip.textContent = '⠿';
    const label = document.createElement('span'); label.className = 'sticky-label'; label.textContent = 'STICKY';
    const connect = document.createElement('button'); connect.className = 'sticky-connect'; connect.type = 'button'; connect.innerHTML = icon('link');
    connect.setAttribute('aria-label', `Choose sticky note ${index + 1} to connect`);
    connect.title = 'Choose this sticky to connect it to another';
    connect.setAttribute('aria-pressed', String(connectionStartId === sticky.id));
    connect.classList.toggle('active', connectionStartId === sticky.id);
    const remove = document.createElement('button'); remove.className = 'sticky-delete'; remove.type = 'button'; remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove sticky note'); remove.title = 'Remove sticky note';
    header.append(grip, label, connect, remove);
    connect.addEventListener('click', event => { event.stopPropagation(); chooseConnectionEnd(sticky.id); });
    const editor = document.createElement('textarea');
    editor.className = 'sticky-text'; editor.maxLength = 500; editor.value = sticky.text; editor.placeholder = 'Write a thought…';
    editor.setAttribute('aria-label', 'Sticky note text'); editor.spellcheck = true;
    card.append(header, editor);
    editor.addEventListener('input', () => { sticky.text = editor.value; recordChange(); });
    editor.addEventListener('pointerdown', event => event.stopPropagation());
    card.addEventListener('click', event => {
      if (!connectionStartId || event.target.closest('.sticky-connect, .sticky-delete')) return;
      chooseConnectionEnd(sticky.id);
    });
    card.addEventListener('keydown', event => {
      if (event.target !== card) return;
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const paper = $('#paper'), step = event.shiftKey ? .05 : .02;
        const maxX = Math.max(0, 1 - card.offsetWidth / paper.clientWidth), maxY = Math.max(0, 1 - card.offsetHeight / paper.clientHeight);
        if (event.key === 'ArrowLeft') sticky.x = Math.max(0, sticky.x - step);
        if (event.key === 'ArrowRight') sticky.x = Math.min(maxX, sticky.x + step);
        if (event.key === 'ArrowUp') sticky.y = Math.max(0, sticky.y - step);
        if (event.key === 'ArrowDown') sticky.y = Math.min(maxY, sticky.y + step);
        card.style.left = `${sticky.x * 100}%`; card.style.top = `${sticky.y * 100}%`;
        drawConnections(note); recordChange();
      }
    });
    const startStickyDrag = (event, pointerId = null) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault(); event.stopPropagation();
      if (pointerId !== null) header.setPointerCapture(pointerId);
      commitTyping();
      const board = $('#paper').getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const offsetX = event.clientX - cardBox.left, offsetY = event.clientY - cardBox.top;
      sticky.z = ++stickyZ; card.style.zIndex = String(sticky.z);
      card.classList.add('moving');
      const move = moveEvent => {
        if (pointerId !== null && moveEvent.pointerId !== pointerId) return;
        const maxX = Math.max(0, board.width - card.offsetWidth), maxY = Math.max(0, board.height - card.offsetHeight);
        const left = Math.max(0, Math.min(maxX, moveEvent.clientX - board.left - offsetX));
        const top = Math.max(0, Math.min(maxY, moveEvent.clientY - board.top - offsetY));
        sticky.x = left / board.width; sticky.y = top / board.height;
        card.style.left = `${sticky.x * 100}%`; card.style.top = `${sticky.y * 100}%`;
        drawConnections(note);
      };
      const finish = finishEvent => {
        if (pointerId !== null && finishEvent.pointerId !== pointerId) return;
        card.classList.remove('moving');
        window.removeEventListener(pointerId === null ? 'mousemove' : 'pointermove', move);
        window.removeEventListener(pointerId === null ? 'mouseup' : 'pointerup', finish);
        if (pointerId !== null) window.removeEventListener('pointercancel', finish);
        drawConnections(note); recordChange();
      };
      window.addEventListener(pointerId === null ? 'mousemove' : 'pointermove', move);
      window.addEventListener(pointerId === null ? 'mouseup' : 'pointerup', finish);
      if (pointerId !== null) window.addEventListener('pointercancel', finish);
    };
    header.addEventListener('pointerdown', event => startStickyDrag(event, event.pointerId));
    remove.addEventListener('click', event => {
      event.stopPropagation();
      note.stickies = note.stickies.filter(item => item.id !== sticky.id);
      note.connections = note.connections.filter(edge => edge.from !== sticky.id && edge.to !== sticky.id);
      if (connectionStartId === sticky.id) connectionStartId = null;
      renderStickyBoard(note); recordChange(); notify('Sticky note removed');
    });
    layer.append(card);
    const maxX = Math.max(0, $('#paper').clientWidth - card.offsetWidth);
    const maxY = Math.max(0, $('#paper').clientHeight - card.offsetHeight);
    sticky.x = Math.min(sticky.x, maxX / Math.max(1, $('#paper').clientWidth));
    sticky.y = Math.min(sticky.y, maxY / Math.max(1, $('#paper').clientHeight));
    card.style.left = `${sticky.x * 100}%`; card.style.top = `${sticky.y * 100}%`;
  }
  drawConnections(note);
}
function chooseConnectionEnd(id) {
  const note = current();
  if (!note || note.scrapped) return;
  if (!connectionStartId) {
    connectionStartId = id;
    updateConnectionSelection();
    $('#tool-hint').replaceChildren(Object.assign(document.createElement('span'), { className: 'hint-dot' }), document.createTextNode('Click anywhere on another sticky to connect'));
    return;
  }
  if (connectionStartId === id) {
    connectionStartId = null;
    updateConnectionSelection();
    $('#tool-hint').replaceChildren(Object.assign(document.createElement('span'), { className: 'hint-dot' }), document.createTextNode('Choose a sticky link to start a connection'));
    return;
  }
  const existing = note.connections.find(edge => (edge.from === connectionStartId && edge.to === id) || (edge.from === id && edge.to === connectionStartId));
  if (existing) { notify('Those notes are already connected'); }
  else { note.connections.push({ from: connectionStartId, to: id }); recordChange(); notify('Notes connected'); }
  connectionStartId = null;
  updateConnectionSelection();
  drawConnections(note);
  $('#tool-hint').replaceChildren(Object.assign(document.createElement('span'), { className: 'hint-dot' }), document.createTextNode('Choose a sticky link to start another connection'));
}
function updateConnectionSelection() {
  document.querySelectorAll('.sticky-connect').forEach(button => {
    const selected = button.closest('.sticky-note')?.id === `sticky-${connectionStartId}`;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
function addSticky() {
  const note = current();
  if (!note || note.scrapped) return;
  commitTyping();
  const slots = [[.08,.1],[.55,.12],[.24,.52],[.66,.48],[.53,.08],[.07,.66],[.38,.72]];
  const slot = slots[note.stickies.length % slots.length];
  const sticky = { id: crypto.randomUUID(), text: '', x: slot[0], y: slot[1], tone: stickyTones[note.stickies.length % stickyTones.length], z: ++stickyZ };
  note.stickies.push(sticky); renderStickyBoard(note); recordChange();
  $(`#sticky-${CSS.escape(sticky.id)} .sticky-text`)?.focus();
}
function enableDrop(target, resolveDestination) {
  target.addEventListener('dragover', event => {
    if (!draggedNoteId || !notes.some(note => note.id === draggedNoteId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.classList.add('drop-target-active');
  });
  target.addEventListener('dragleave', event => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('drop-target-active');
  });
  target.addEventListener('drop', event => {
    if (!draggedNoteId) return;
    event.preventDefault();
    target.classList.remove('drop-target-active');
    const noteId = draggedNoteId;
    draggedNoteId = null;
    moveNote(noteId, resolveDestination());
  });
}
async function moveNote(noteId, destination) {
  const note = notes.find(item => item.id === noteId);
  if (!note || !destination) return;
  if (noteId === currentId) commitTyping();
  const nextScrapped = destination.type === 'scrapped';
  const nextFolderId = destination.type === 'folder' ? destination.id : null;
  if (note.scrapped === nextScrapped && note.folderId === nextFolderId) return;
  note.scrapped = nextScrapped;
  note.folderId = nextFolderId;
  note.updated = Date.now();
  // Moving notes never changes the current menu. The active/scrapped badge
  // keeps the open page's status visible if it moved out of the current list.
  renderNotes();
  status('Saving…');
  try {
    await databaseAction('readwrite', store => store.put({ ...note }));
    status('All changes saved');
  } catch {
    status('Not saved', true);
    notify('Could not save the note’s new location.');
  }
}
function renderFolders() {
  const list = $('#folder-list');
  list.replaceChildren();
  for (const folder of folders) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    const select = document.createElement('button');
    select.className = 'folder-link' + (viewMode === 'folder' && selectedFolderId === folder.id ? ' active' : '');
    select.setAttribute('aria-current', viewMode === 'folder' && selectedFolderId === folder.id ? 'page' : 'false');
    select.innerHTML = icon('folder');
    const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = folder.name;
    const count = document.createElement('span'); count.className = 'folder-count';
    count.textContent = String(notes.filter(note => !note.scrapped && note.folderId === folder.id).length);
    select.append(name, count);
    select.addEventListener('click', () => switchView('folder', folder.id));
    row.title = `Drop a note here to move it into ${folder.name} or restore it from Scrapped`;
    enableDrop(row, () => folders.some(item => item.id === folder.id) ? { type: 'folder', id: folder.id } : null);
    const edit = document.createElement('button');
    edit.className = 'folder-edit'; edit.type = 'button'; edit.textContent = '···';
    edit.setAttribute('aria-label', `Manage ${folder.name} folder`); edit.title = `Manage ${folder.name}`;
    edit.addEventListener('click', () => openFolderDialog(folder));
    row.append(select, edit); list.append(row);
  }
  $('#note-folder').replaceChildren(new Option('All notes', ''));
  folders.forEach(folder => $('#note-folder').add(new Option(folder.name, folder.id)));
  const note = current();
  $('#note-folder').value = note?.scrapped ? '' : note?.folderId || '';
  $('#folder-select-label').hidden = !note || note.scrapped;
  $('#note-folder').disabled = !note || note.scrapped;
}
function switchView(mode, folderId = null) {
  viewMode = mode;
  selectedFolderId = mode === 'folder' ? folderId : null;
  renderNotes();
  const visible = notes.filter(note => viewMode === 'scrapped'
    ? note.scrapped
    : !note.scrapped && (viewMode !== 'folder' || note.folderId === selectedFolderId));
  if (visible.length && !visible.some(note => note.id === currentId)) selectNote(visible[0].id);
}
function saveFolders() {
  try { localStorage.setItem('scratchpad-folders', JSON.stringify(folders)); return true; }
  catch { notify('Folders could not be saved in this browser.'); return false; }
}
function updateHistoryButtons() {
  $('#undo').disabled = undoStack.length === 0;
  $('#redo').disabled = redoStack.length === 0;
}
function snapshot() { return ctx.getImageData(0, 0, W, H); }
function pushUndo(image = snapshot()) {
  undoStack.push(image);
  if (undoStack.length > 20) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}
function historyStep(direction) {
  commitTyping();
  const from = direction === 'undo' ? undoStack : redoStack;
  const to = direction === 'undo' ? redoStack : undoStack;
  if (!from.length) return;
  to.push(snapshot());
  ctx.putImageData(from.pop(), 0, 0);
  updateHistoryButtons();
  recordChange();
  persistCurrent();
}
async function selectNote(id) {
  if (id === currentId || loadingNote) return;
  connectionStartId = null;
  commitTyping();
  penDown = false;
  if (current()) {
    persistCurrent();
    histories.set(currentId, { undo: undoStack, redo: redoStack });
    // Keep bounded history for the five most recently used notes.
    if (histories.size > 5) histories.delete(histories.keys().next().value);
  }
  currentId = id;
  renderStickyBoard(null);
  const note = current();
  const generation = ++switchGeneration;
  const history = histories.get(id);
  undoStack = history?.undo || [];
  redoStack = history?.redo || [];
  ctx.clearRect(0, 0, W, H);
  canvas.style.pointerEvents = 'none';
  loadingNote = true;
  if (note.image) {
    try {
      const image = new Image();
      image.src = note.image;
      await image.decode();
      if (generation !== switchGeneration) return;
      ctx.drawImage(image, 0, 0);
    } catch { notify('This note’s image could not be opened.'); }
  }
  if (generation !== switchGeneration) return;
  canvas.style.pointerEvents = '';
  loadingNote = false;
  renderStickyBoard(note);
  $('#note-title').value = note.title;
  $('#note-date').textContent = `Created ${dateLabel(note.created)}`;
  $('#paper').classList.toggle('grid-off', note.grid === false);
  $('#toggle-grid').classList.toggle('active', note.grid !== false);
  $('#toggle-grid').setAttribute('aria-pressed', String(note.grid !== false));
  $('#toggle-grid').setAttribute('aria-label', note.grid !== false ? 'Hide dot grid' : 'Show dot grid');
  $('#toggle-grid').title = note.grid !== false ? 'Hide dot grid' : 'Show dot grid';
  $('#pin-note').setAttribute('aria-pressed', String(note.pinned));
  renderNoteActions(note);
  renderNotes();
  updateHistoryButtons();
  try { localStorage.setItem('scratchpad-active-note', id); } catch { /* Preference is optional. */ }
}
async function addNote(title = 'Untitled note') {
  if (loadingNote) return current();
  if (viewMode === 'scrapped') switchView('all');
  const folderId = viewMode === 'folder' ? selectedFolderId : null;
  const note = { id: crypto.randomUUID(), title, created: Date.now(), updated: Date.now(), pinned: false, grid: true, image: '', folderId, scrapped: false, stickies: [], connections: [] };
  notes.unshift(note);
  await selectNote(note.id);
  await persistCurrent();
  $('#note-title').focus();
  $('#note-title').select();
  return note;
}
function setTool(next) {
  if (connectionStartId) document.querySelectorAll('.sticky-connect.active').forEach(button => {
    button.classList.remove('active'); button.setAttribute('aria-pressed', 'false');
  });
  connectionStartId = null;
  commitTyping();
  tool = next;
  document.querySelectorAll('[data-tool]').forEach(button => {
    const selected = button.dataset.tool === tool;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const hints = { type: 'Click a spot to type · Enter for a new line · Esc to finish', draw: 'Drag the pen anywhere on the page', erase: 'Rub over a mark to erase just that part' };
  $('#tool-hint').replaceChildren(Object.assign(document.createElement('span'), { className: 'hint-dot' }), document.createTextNode(hints[tool]));
  $('#tool-size').setAttribute('aria-label', {type:'Text size', draw:'Pen size', erase:'Eraser size'}[tool]);
  $('#size-label').textContent = {type:'Text size', draw:'Pen size', erase:'Eraser size'}[tool];
  canvas.style.cursor = tool === 'type' ? 'text' : tool === 'draw' ? 'crosshair' : 'none';
  $('#eraser-cursor').style.display = 'none';
}
function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * W / rect.width, y: (event.clientY - rect.top) * H / rect.height };
}
function positionCaret(x, y, height) {
  const rect = canvas.getBoundingClientRect();
  const left = x / W * rect.width;
  const top = y / H * rect.height;
  Object.assign($('#caret').style, { left: `${left}px`, top: `${top}px`, height: `${height / H * rect.height}px`, display: 'block', background: ink });
  Object.assign(textInput.style, { left: `${left}px`, top: `${top}px` });
}
function beginTyping(p) {
  commitTyping();
  typing = { x: Math.min(p.x, W - fontSize()), y: Math.min(p.y, H - fontSize() * 1.5), font: fontSize(), color: ink, base: snapshot(), value: '' };
  textInput.value = '';
  positionCaret(typing.x, typing.y, typing.font * 1.2);
  textInput.focus({ preventScroll: true });
}
function layoutText(value) {
  let x = typing.x, y = typing.y;
  const lineHeight = typing.font * 1.5;
  ctx.font = `${typing.font}px Georgia, serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = typing.color;
  ctx.globalCompositeOperation = 'source-over';
  for (const char of value) {
    if (char === '\n') { x = typing.x; y += lineHeight; continue; }
    const width = ctx.measureText(char).width;
    if (x + width > W - 32) { x = typing.x; y += lineHeight; }
    ctx.fillText(char, x, y);
    x += width;
  }
  return { x, y, lineHeight };
}
function renderTyping() {
  if (!typing) return;
  ctx.putImageData(typing.base, 0, 0);
  const value = textInput.value;
  const end = layoutText(value);
  if (end.y + end.lineHeight > H - 20 && value.length > typing.value.length) {
    textInput.value = typing.value;
    ctx.putImageData(typing.base, 0, 0);
    const oldEnd = layoutText(typing.value);
    positionCaret(oldEnd.x, oldEnd.y, typing.font * 1.2);
    notify('This part of the page is full. Start elsewhere or add a note.');
    return;
  }
  typing.value = value;
  // The visible caret follows native text selection, including arrow keys.
  const before = snapshot();
  ctx.putImageData(typing.base, 0, 0);
  const caret = layoutText(value.slice(0, textInput.selectionStart));
  ctx.putImageData(before, 0, 0);
  positionCaret(caret.x, caret.y, typing.font * 1.2);
  recordChange();
}
function commitTyping() {
  if (!typing) return;
  if (typing.value) pushUndo(typing.base);
  typing = null;
  textInput.value = '';
  $('#caret').style.display = 'none';
  textInput.blur();
  persistCurrent();
}
function stroke(from, to) {
  ctx.save();
  ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = tool === 'erase' ? eraserSize() : brushSize();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  // A tap is a mark too.
  ctx.beginPath(); ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function eraserCursor(p) {
  if (tool !== 'erase') return;
  const rect = canvas.getBoundingClientRect();
  Object.assign($('#eraser-cursor').style, { display: 'block', left: `${p.x / W * rect.width}px`, top: `${p.y / H * rect.height}px`, width: `${eraserSize() / W * rect.width}px`, height: `${eraserSize() / H * rect.height}px` });
}
canvas.addEventListener('pointerdown', event => {
  if (!initialized || event.button !== 0) return;
  event.preventDefault();
  const p = point(event);
  if (tool === 'type') { beginTyping(p); return; }
  commitTyping();
  pushUndo();
  penDown = true;
  lastPoint = p;
  canvas.setPointerCapture(event.pointerId);
  stroke(p, p);
  recordChange();
});
canvas.addEventListener('pointermove', event => {
  const p = point(event);
  eraserCursor(p);
  if (!penDown) return;
  const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
  for (const sample of events.length ? events : [event]) {
    const next = point(sample);
    stroke(lastPoint, next);
    lastPoint = next;
  }
  recordChange();
});
function finishStroke() { if (penDown) { penDown = false; recordChange(); persistCurrent(); } }
canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);
canvas.addEventListener('lostpointercapture', finishStroke);
canvas.addEventListener('pointerleave', () => $('#eraser-cursor').style.display = 'none');
canvas.addEventListener('keydown', event => {
  if (tool === 'type' && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); beginTyping({ x: 105, y: 105 });
  }
});
textInput.addEventListener('input', renderTyping);
textInput.addEventListener('keyup', event => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') renderTyping(); });
textInput.addEventListener('keydown', event => {
  if (event.key === 'Tab' || event.key === 'Escape') { event.preventDefault(); commitTyping(); canvas.focus(); }
});
textInput.addEventListener('blur', commitTyping);
document.querySelectorAll('[data-tool]').forEach(button => {
  button.setAttribute('aria-label', {type:'Type',draw:'Draw',erase:'Erase'}[button.dataset.tool]);
  button.title = {type:'Type on paper (T)',draw:'Draw anywhere on the page (D)',erase:'Rub out part of a mark (E)'}[button.dataset.tool];
  button.addEventListener('click', () => setTool(button.dataset.tool));
});
document.querySelectorAll('[data-color]').forEach(button => { button.title = button.getAttribute('aria-label'); });
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => {
  commitTyping(); ink = button.dataset.color;
  document.querySelectorAll('[data-color]').forEach(swatch => {
    const selected = swatch === button;
    swatch.classList.toggle('selected', selected);
    swatch.setAttribute('aria-pressed', String(selected));
  });
}));
$('#tool-size').addEventListener('change', event => { commitTyping(); size = event.target.value; });
$('#new-note').title = 'New note (N)';
$('#new-note').addEventListener('click', () => { if (initialized) addNote(); });
$('#add-sticky').addEventListener('click', addSticky);
$('#add-sticky').title = 'Add a sticky note to the board (S)';
$('#all-notes').addEventListener('click', () => switchView('all'));
$('#scrapped-notes').addEventListener('click', () => switchView('scrapped'));
enableDrop($('#all-notes'), () => ({ type: 'all' }));
enableDrop($('#scrapped-notes'), () => ({ type: 'scrapped' }));
$('#add-folder').addEventListener('click', () => openFolderDialog());
$('#note-folder').addEventListener('change', event => {
  const note = current(); if (!note || note.scrapped) return;
  note.folderId = folders.some(folder => folder.id === event.target.value) ? event.target.value : null;
  note.updated = Date.now();
  if (note.folderId) switchView('folder', note.folderId); else switchView('all');
  persistCurrent();
});
function openFolderDialog(folder = null) {
  editingFolderId = folder?.id || null;
  $('#folder-dialog-title').textContent = folder ? 'Rename folder' : 'Create folder';
  $('#folder-name').value = folder?.name || '';
  $('#folder-save').textContent = folder ? 'Save name' : 'Create folder';
  $('#folder-delete').hidden = !folder;
  $('#folder-dialog').showModal();
  $('#folder-name').focus();
}
$('#folder-cancel').addEventListener('click', () => $('#folder-dialog').close());
$('#folder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#folder-name').value.trim();
  if (!name) { $('#folder-name').focus(); return; }
  const duplicate = folders.some(folder => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase() && folder.id !== editingFolderId);
  if (duplicate) { notify('A folder with that name already exists.'); $('#folder-name').focus(); return; }
  let addedFolder = null;
  let oldName = null;
  if (editingFolderId) {
    const folder = folders.find(item => item.id === editingFolderId);
    if (folder) { oldName = folder.name; folder.name = name; }
  } else {
    addedFolder = { id: crypto.randomUUID(), name, created: Date.now() };
    folders.push(addedFolder);
  }
  if (saveFolders()) {
    if (addedFolder) switchView('folder', addedFolder.id);
    renderNotes();
    $('#folder-dialog').close('saved');
  } else if (addedFolder) {
    folders = folders.filter(folder => folder.id !== addedFolder.id);
  } else if (editingFolderId && oldName !== null) {
    const folder = folders.find(item => item.id === editingFolderId);
    if (folder) folder.name = oldName;
  }
});
$('#folder-delete').addEventListener('click', () => {
  const folder = folders.find(item => item.id === editingFolderId);
  if (!folder) return;
  $('#folder-dialog').close();
  pendingDelete = { type: 'folder', id: folder.id };
  $('#delete-heading').textContent = 'Delete folder?';
  $('#delete-description').textContent = `Notes in “${folder.name}” will move to All notes.`;
  $('#confirm-delete').textContent = 'Delete folder';
  $('#delete-dialog').showModal();
});
$('#note-title').addEventListener('input', event => { if (current()) { current().title = event.target.value; renderNotes(); recordChange(); } });
$('#note-title').addEventListener('blur', () => { if (current() && !current().title.trim()) { current().title = 'Untitled note'; $('#note-title').value = current().title; recordChange(); } });
$('#undo').addEventListener('click', () => historyStep('undo'));
$('#redo').addEventListener('click', () => historyStep('redo'));
$('#pin-note').addEventListener('click', () => {
  if (!current()) return;
  const note = current(); note.pinned = !note.pinned;
  $('#pin-note').classList.toggle('active', note.pinned);
  $('#pin-note').setAttribute('aria-pressed', String(note.pinned));
  $('#pin-note').setAttribute('aria-label', note.pinned ? 'Unpin note' : 'Pin note');
  $('#pin-note').title = note.pinned ? 'Unpin note' : 'Pin note';
  renderNotes(); recordChange();
});
$('#toggle-grid').addEventListener('click', () => {
  if (!current()) return;
  current().grid = current().grid === false;
  $('#paper').classList.toggle('grid-off', !current().grid);
  $('#toggle-grid').classList.toggle('active', current().grid);
  $('#toggle-grid').setAttribute('aria-pressed', String(current().grid));
  $('#toggle-grid').setAttribute('aria-label', current().grid ? 'Hide dot grid' : 'Show dot grid');
  $('#toggle-grid').title = current().grid ? 'Hide dot grid' : 'Show dot grid';
  recordChange();
});
$('#scrap-note').addEventListener('click', () => {
  const note = current(); if (!note || note.scrapped) return;
  commitTyping();
  note.scrapped = true; note.updated = Date.now();
  renderNotes();
  persistCurrent();
});
$('#restore-note').addEventListener('click', () => {
  const note = current(); if (!note || !note.scrapped) return;
  note.scrapped = false; note.updated = Date.now();
  renderNotes();
  persistCurrent();
});
$('#delete-note').addEventListener('click', () => {
  if (!current()?.scrapped) return;
  commitTyping();
  pendingDelete = { type: 'note', id: currentId };
  $('#delete-heading').textContent = 'Delete permanently?';
  $('#delete-description').textContent = `“${current().title || 'Untitled note'}” will be permanently deleted.`;
  $('#confirm-delete').textContent = 'Delete permanently';
  $('#delete-dialog').showModal();
});
$('#delete-dialog').addEventListener('close', async () => {
  const target = pendingDelete; pendingDelete = null;
  if ($('#delete-dialog').returnValue !== 'delete' || !target) return;
  clearTimeout(saveTimer);
  if (target.type === 'folder') {
    const folder = folders.find(item => item.id === target.id);
    if (!folder) return;
    const moved = notes.filter(note => note.folderId === folder.id);
    moved.forEach(note => { note.folderId = null; note.updated = Date.now(); });
    folders = folders.filter(item => item.id !== folder.id);
    if (!saveFolders()) { folders.push(folder); moved.forEach(note => { note.folderId = folder.id; }); renderNotes(); return; }
    try { for (const note of moved) await databaseAction('readwrite', store => store.put(note)); }
    catch { notify('Folder deleted, but notes could not be updated.'); }
    if (viewMode === 'folder' && selectedFolderId === folder.id) switchView('all'); else renderNotes();
    notify('Folder deleted. Its notes are in All notes.');
    return;
  }
  const note = notes.find(item => item.id === target.id);
  if (!note?.scrapped) return;
  try { await databaseAction('readwrite', store => store.delete(note.id)); }
  catch { notify('Could not delete the saved note. Please try again.'); return; }
  notes = notes.filter(item => item.id !== note.id);
  histories.delete(note.id);
  if (currentId === note.id) {
    currentId = null;
    const remaining = notes.filter(item => viewMode === 'scrapped' ? item.scrapped : !item.scrapped && (viewMode !== 'folder' || item.folderId === selectedFolderId));
    if (remaining.length) await selectNote(remaining[0].id);
    else if (viewMode === 'scrapped') { switchView('all'); const first = notes.find(item => !item.scrapped); if (first) await selectNote(first.id); else await addNote(); }
    else { const first = notes.find(item => !item.scrapped); if (first) await selectNote(first.id); else await addNote(); }
  }
  renderNotes();
  notify('Note permanently deleted');
});
$('#download-note').addEventListener('click', () => {
  if (!current()) return;
  commitTyping();
  const output = document.createElement('canvas'); output.width = W; output.height = H;
  const context = output.getContext('2d');
  context.fillStyle = '#fffdf7'; context.fillRect(0, 0, W, H);
  if (current().grid !== false) {
    context.fillStyle = '#dce6ec';
    for (let x = 16; x < W; x += 28) for (let y = 16; y < H; y += 28) { context.beginPath(); context.arc(x, y, .7, 0, 7); context.fill(); }
  }
  context.drawImage(canvas, 0, 0);
  const paperRect = $('#paper').getBoundingClientRect();
  const boardScale = W / paperRect.width;
  const exportRect = element => {
    const rect = element.getBoundingClientRect();
    return { x: (rect.left - paperRect.left) * W / paperRect.width, y: (rect.top - paperRect.top) * H / paperRect.height, w: rect.width * W / paperRect.width, h: rect.height * H / paperRect.height };
  };
  context.save();
  context.strokeStyle = '#516a78'; context.lineWidth = 3 * boardScale; context.lineCap = 'round';
  for (const edge of current().connections || []) {
    const from = $(`#sticky-${CSS.escape(edge.from)}`), to = $(`#sticky-${CSS.escape(edge.to)}`);
    if (!from || !to) continue;
    const a = exportRect(from), b = exportRect(to), direction = b.x >= a.x ? 1 : -1, bend = Math.max(28, Math.abs(b.x - a.x) * .28);
    context.beginPath(); context.moveTo(a.x + a.w/2, a.y + a.h/2);
    context.bezierCurveTo(a.x + a.w/2 + bend*direction, a.y + a.h/2, b.x + b.w/2 - bend*direction, b.y + b.h/2, b.x + b.w/2, b.y + b.h/2); context.stroke();
  }
  for (const sticky of current().stickies || []) {
    const element = $(`#sticky-${CSS.escape(sticky.id)}`); if (!element) continue;
    const rect = exportRect(element), tone = stickyColors[sticky.tone] || stickyColors.sun, pad = 8 * boardScale;
    context.fillStyle = tone; context.shadowColor = '#352e1828'; context.shadowBlur = 12 * boardScale; context.shadowOffsetY = 5 * boardScale;
    context.beginPath(); context.roundRect(rect.x, rect.y, rect.w, rect.h, 4 * boardScale); context.fill();
    context.shadowColor = 'transparent'; context.shadowBlur = 0; context.shadowOffsetY = 0;
    context.fillStyle = '#625a42'; context.font = `bold ${7 * boardScale}px Segoe UI, Arial`; context.fillText('STICKY', rect.x + pad, rect.y + 13 * boardScale);
    context.strokeStyle = '#5a50372c'; context.lineWidth = boardScale; context.setLineDash([4*boardScale,4*boardScale]); context.beginPath(); context.moveTo(rect.x + 6*boardScale, rect.y + 18*boardScale); context.lineTo(rect.x + rect.w - 6*boardScale, rect.y + 18*boardScale); context.stroke(); context.setLineDash([]);
    const words = (sticky.text || '').split(/\s+/).filter(Boolean), maxWidth = rect.w - pad*2, font = 12*boardScale, lineHeight = font*1.35;
    context.fillStyle = '#343833'; context.font = `500 ${font}px Segoe UI, Arial`;
    let line = '', y = rect.y + 28*boardScale;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && context.measureText(test).width > maxWidth) { context.fillText(line, rect.x + pad, y); y += lineHeight; line = word; }
      else line = test;
      if (y > rect.y + rect.h - 12) break;
    }
    if (line && y <= rect.y + rect.h - 12) context.fillText(line, rect.x + pad, y);
  }
  context.restore();
  const link = document.createElement('a');
  link.download = (current().title || 'Untitled note').replace(/[<>:"/\\|?*]/g, '-') + '.png';
  link.href = output.toDataURL('image/png'); link.click();
  notify('Your note is ready to keep');
});
document.addEventListener('keydown', event => {
  const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
  if ($('#delete-dialog').open) return;
  if (event.key === 'Escape' && connectionStartId) { event.preventDefault(); connectionStartId = null; updateConnectionSelection(); $('#tool-hint').replaceChildren(Object.assign(document.createElement('span'), { className: 'hint-dot' }), document.createTextNode('Choose a sticky link to start a connection')); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.target !== $('#note-title')) {
    event.preventDefault(); historyStep(event.shiftKey ? 'redo' : 'undo'); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y' && !editing) {
    event.preventDefault(); historyStep('redo'); return;
  }
  if (editing || event.target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey || !initialized) return;
  const key = event.key.toLowerCase();
  if (key === 'n') { event.preventDefault(); addNote(); }
  else if (key === 't') { event.preventDefault(); setTool('type'); }
  else if (key === 'd') { event.preventDefault(); setTool('draw'); }
  else if (key === 'e') { event.preventDefault(); setTool('erase'); }
  else if (key === 's') { event.preventDefault(); addSticky(); }
});
window.addEventListener('pagehide', persistCurrent);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistCurrent(); });
window.addEventListener('resize', () => { if (typing) renderTyping(); drawConnections(); });

function seedPaper(kind, legacySample = false) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#343c36'; ctx.textBaseline = 'top';
  const write = (text, x, y, font = '30px Georgia', color = '#343c36') => { ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, x, y); };
  const line = (points, color = '#c26345', width = 3) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.beginPath();
    points.forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke();
  };
  if (kind === 'welcome' && legacySample) {
    write('Good ideas start here.', 115, 120, '58px Georgia');
    line([[117,194],[263,191],[390,197],[568,193],[650,195]], '#c26345', 4);
    write('A place for all the things on your mind.', 117, 229, 'italic 28px Georgia', '#828873');
    ['The next big idea', 'A meeting worth remembering', 'Something you don’t want to forget'].forEach((label, index) => {
      const y = 345 + index * 70;
      ctx.strokeStyle = '#8c987f'; ctx.lineWidth = 2; ctx.strokeRect(123, y + 3, 22, 22);
      write(label, 164, y, '29px Georgia', '#616c58');
    });
    write('Click anywhere. Make it yours.', 118, 641, 'italic 25px Georgia', '#8d927e');
    ctx.save(); ctx.translate(1064,414); ctx.rotate(-.09);
    ctx.beginPath(); ctx.ellipse(0,0,149,109,0,0,Math.PI*2); ctx.strokeStyle='#c2634599'; ctx.lineWidth=2.3; ctx.stroke();
    write('make a',-70,-39,'italic 35px Georgia','#b76146');
    write('little mess.',-92,5,'italic 35px Georgia','#b76146'); ctx.restore();
    line([[916,533],[877,568],[815,578]],'#b7614699',2);
    line([[834,563],[815,578],[839,584]],'#b7614699',2);
    line([[1224,168],[1224,210]],'#a0a98b',2); line([[1205,177],[1243,201]],'#a0a98b',2); line([[1206,200],[1241,177]],'#a0a98b',2);
  } else if (kind === 'welcome') {
    write('Ideas', 115, 120, '58px Georgia');
    line([[117,194],[263,191],[390,197]], '#c26345', 3);
    write('Notes, ideas, and reminders.', 117, 229, '27px Georgia', '#828873');
    const labels = ['Idea 1', 'Meeting notes', 'Reminder'];
    labels.forEach((label, index) => {
      const y = 345 + index * 70;
      ctx.strokeStyle = '#8c987f'; ctx.lineWidth = 2; ctx.strokeRect(123, y + 3, 22, 22);
      write(label, 164, y, '29px Georgia', '#616c58');
    });
    line([[164,642],[270,642],[388,642],[506,642],[624,642]],'#c5cbb9',1.5);
  } else if (kind === 'meeting') {
    write('Meeting notes',115,115,'54px Georgia');
    write('Date / people',117,215,'italic 27px Georgia','#89937d');
    write('Things to talk about',117,320,'32px Georgia');
    line([[118,368],[730,368]],'#c5cbb9',1.3);
    write('Next steps',117,560,'32px Georgia');
    line([[118,610],[730,610]],'#c5cbb9',1.3);
  } else if (kind === 'reminders' && legacySample) {
    write('A few things to remember…',115,125,'51px Georgia');
    write('Get it out of your head, onto the page.',117,221,'italic 28px Georgia','#89937d');
    [350,440,530].forEach(y=>{ctx.strokeStyle='#97a087';ctx.lineWidth=2;ctx.strokeRect(123,y,23,23);});
  } else {
    write('Reminders',115,125,'51px Georgia');
    write('Notes',117,221,'28px Georgia','#89937d');
    [350,440,530].forEach(y=>{ctx.strokeStyle='#97a087';ctx.lineWidth=2;ctx.strokeRect(123,y,23,23);});
  }
  return canvas.toDataURL('image/png');
}
async function start() {
  try {
    db = await openDatabase();
    notes = await databaseAction('readonly', store => store.getAll());
    try { folders = JSON.parse(localStorage.getItem('scratchpad-folders') || '[]'); } catch { folders = []; }
    if (!Array.isArray(folders)) folders = [];
    folders = folders.filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string');
    notes = notes.map(note => ({ ...note, scrapped: Boolean(note.scrapped), folderId: folders.some(folder => folder.id === note.folderId) ? note.folderId : null }));
  }
  catch { status('Not saved', true); notify('Browser storage is unavailable. Download notes to keep them.'); }
  if (!notes.length) {
    const titles = ['Ideas', 'Meeting notes', 'Reminders'];
    const kinds = ['welcome', 'meeting', 'reminders'];
    const now = Date.now();
    notes = titles.map((title, index) => ({ id: crypto.randomUUID(), title, created: now-index, updated: now, pinned: index===0, grid:true, image:seedPaper(kinds[index]) }));
    if (db) for (const note of notes) await databaseAction('readwrite', store => store.put(note));
  }
  const starter = notes.find(note => note.title === 'A little room to think' && note.pinned && note.image);
  // Replace only the untouched original welcome page. A single changed canvas
  // pixel or title means it belongs to the user and stays as they left it.
  if (starter && starter.image === seedPaper('welcome', true)) {
    starter.title = 'Ideas';
    starter.image = seedPaper('welcome');
    starter.updated = Date.now();
    if (db) await databaseAction('readwrite', store => store.put(starter));
  }
  const reminderStarter = notes.find(note => note.title === 'Little reminders' && note.image);
  if (reminderStarter && reminderStarter.image === seedPaper('reminders', true)) {
    reminderStarter.title = 'Reminders';
    reminderStarter.image = seedPaper('reminders');
    reminderStarter.updated = Date.now();
    if (db) await databaseAction('readwrite', store => store.put(reminderStarter));
  }
  notes = notes.map(normalizeBoard);
  renderNotes();
  let active;
  try { active = localStorage.getItem('scratchpad-active-note'); } catch { /* Optional preference. */ }
  const initial = notes.find(note => note.id === active) || notes.find(note => !note.scrapped && note.pinned) || notes.find(note => !note.scrapped) || notes[0];
  if (initial?.scrapped) viewMode = 'scrapped';
  else if (initial?.folderId) { viewMode = 'folder'; selectedFolderId = initial.folderId; }
  renderNotes();
  await selectNote(initial.id);
  initialized = true;
  if (db) status('All changes saved');
  registerAgentTools();
}
function registerAgentTools() {
  if (!document.modelContext?.registerTool) return;
  const lifecycle = new AbortController();
  const specs = [
    { name:'list_scratchpad_notes',description:'List notes and their folder and active or scrapped status in this browser.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({notes:notes.map(note=>({id:note.id,title:note.title,pinned:note.pinned,scrapped:note.scrapped,folder:folders.find(folder=>folder.id===note.folderId)?.name||null})),folders:folders.map(({id,name})=>({id,name}))}) },
    { name:'create_scratchpad_note',description:'Create and open a blank scratchpad note in this browser.',inputSchema:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:80}},required:['title'],additionalProperties:false},annotations:{readOnlyHint:false},execute:async input=>{if(!input || typeof input.title!=='string' || !input.title.trim() || input.title.length>80)throw new Error('A title of 1–80 characters is required.');const note=await addNote(input.title.trim());return{id:note.id,title:note.title,folder:folders.find(folder=>folder.id===note.folderId)?.name||null};} }
  ];
  for (const spec of specs) { try { Promise.resolve(document.modelContext.registerTool(spec,{signal:lifecycle.signal})).catch(()=>{}); } catch { /* Browser support is optional. */ } }
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
start().catch(() => { status('Could not open notes', true); notify('Could not open your notes. Reload the page to try again.'); });
