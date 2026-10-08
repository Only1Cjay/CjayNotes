// ============================================================
// CONFIG
// ============================================================
const STORAGE_KEY = 'cjaynotes_data';
const CLIENT_ID_KEY = 'cjaynotes_google_client_id';
const TOKEN_KEY = 'cjaynotes_google_token';
const SYNC_TIME_KEY = 'cjaynotes_last_sync';
const SYNC_TOKEN_KEY = 'cjaynotes_sync_token';
const PUSH_FLAG_KEY = 'cjaynotes_push_enabled';
const MODE_KEY = 'cjaynotes_mode';

const WORKER_URL = 'https://cjay-cloud.monaplayzsbackup.workers.dev';
const APP_ID = 'cjaynotes';
const DEFAULT_SYNC_TOKEN = 'cjn_m5x9q3w7r2t6y8u4v1b5n9p4k8j3d7f2';

const FOLDER_COLORS = ['#e07a3f', '#3b82f6', '#a855f7', '#10b981', '#ec4899', '#06b6d4', '#f59e0b', '#8b5cf6'];

const ICON_MOON = '<svg class="icon-svg" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SUN = '<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/></svg>';

// ============================================================
// STATE
// ============================================================
function getDefaultData() {
    return { notes: {}, deletedIds: [] };
}

let data = loadData();
let currentNoteId = null;
let currentFilter = 'all';
let currentFolderFilter = null;
let searchQuery = '';
let tokenClient = null;
let saveTimeout = null;
let syncDebounce = null;
let pendingDelete = null;
let syncingFromWorker = false;

// ============================================================
// DATA LAYER
// ============================================================
function loadData() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (!parsed.notes) parsed.notes = {};
            if (!parsed.deletedIds) parsed.deletedIds = [];
            if (parsed.folders) delete parsed.folders;
            return parsed;
        }
    } catch (e) {}
    return getDefaultData();
}

function saveData() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        renderNotes();
        updateStats();
        scheduleSyncToWorker();
    }, 100);
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// WIRE FORMAT
// ============================================================
function toWireFormat() {
    return {
        collections: { notes: Object.values(data.notes) },
        deletedIds: { notes: data.deletedIds || [] },
        settings: { mode: getStoredMode() }
    };
}

function fromWireFormat(wire) {
    const notesMap = {};
    const notesArr = wire.collections && wire.collections.notes ? wire.collections.notes : [];
    notesArr.forEach(n => { notesMap[n.id] = n; });
    return {
        notes: notesMap,
        deletedIds: (wire.deletedIds && wire.deletedIds.notes) ? wire.deletedIds.notes : []
    };
}

// ============================================================
// FOLDERS (DERIVED)
// ============================================================
function getDerivedFolders() {
    const set = new Set();
    Object.values(data.notes).forEach(n => {
        if (n.folder && n.folder.trim()) set.add(n.folder.trim());
    });
    return Array.from(set).sort();
}

function getFolderNoteCount(folderName) {
    return Object.values(data.notes).filter(n => n.folder === folderName).length;
}

function getFolderColor(folderName) {
    if (!folderName) return null;
    let hash = 0;
    for (let i = 0; i < folderName.length; i++) {
        hash = (hash * 31 + folderName.charCodeAt(i)) >>> 0;
    }
    return FOLDER_COLORS[hash % FOLDER_COLORS.length];
}

// ============================================================
// NOTES
// ============================================================
function getNotesArray() {
    return Object.values(data.notes).sort((a, b) => {
        const da = new Date(a.updatedAt || a.createdAt);
        const db = new Date(b.updatedAt || b.createdAt);
        return db - da;
    });
}

function getFilteredNotes() {
    let notes = getNotesArray();
    if (currentFilter === 'favorites') notes = notes.filter(n => n.favorite);
    else if (currentFilter === 'archived') notes = notes.filter(n => n.archived);
    else notes = notes.filter(n => !n.archived);

    if (currentFolderFilter) notes = notes.filter(n => n.folder === currentFolderFilter);

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        notes = notes.filter(n =>
            (n.title || '').toLowerCase().includes(q) ||
            (n.content || '').toLowerCase().includes(q) ||
            (n.tags || []).some(t => t.toLowerCase().includes(q)) ||
            (n.folder || '').toLowerCase().includes(q)
        );
    }
    return notes;
}

function createNote(title = '', content = '') {
    const id = generateId();
    const now = new Date().toISOString();
    data.notes[id] = {
        id, title: title || 'Untitled', content,
        tags: [], folder: '', favorite: false, archived: false,
        createdAt: now, updatedAt: now
    };
    saveData();
    return id;
}

function deleteNote(id) {
    const note = data.notes[id];
    if (!note) return;

    pendingDelete = { note, id, timer: null };
    delete data.notes[id];
    saveData();

    const toast = document.getElementById('undoToast');
    document.getElementById('undoText').textContent = 'Note deleted';
    toast.classList.add('show');

    if (pendingDelete.timer) clearTimeout(pendingDelete.timer);
    pendingDelete.timer = setTimeout(() => {
        toast.classList.remove('show');
        if (!data.deletedIds.includes(id)) data.deletedIds.push(id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        scheduleSyncToWorker();
        pendingDelete = null;
    }, 5000);

    if (currentNoteId === id) {
        currentNoteId = null;
        showScreen('home');
    }
}

function undoDelete() {
    if (!pendingDelete) return;
    document.getElementById('undoToast').classList.remove('show');
    const { note, id } = pendingDelete;
    data.notes[id] = note;
    data.deletedIds = (data.deletedIds || []).filter(x => x !== id);
    saveData();
    clearTimeout(pendingDelete.timer);
    pendingDelete = null;
    showToast('Note restored');
}

function toggleFavorite(id) {
    const note = data.notes[id];
    if (note) {
        note.favorite = !note.favorite;
        note.updatedAt = new Date().toISOString();
        saveData();
    }
}

function toggleArchive(id) {
    const note = data.notes[id];
    if (note) {
        note.archived = !note.archived;
        note.updatedAt = new Date().toISOString();
        saveData();
        if (currentNoteId === id) {
            currentNoteId = null;
            showScreen('home');
        }
        showToast(note.archived ? 'Note archived' : 'Note unarchived');
    }
}

function openNote(id) {
    currentNoteId = id;
    const note = data.notes[id];
    if (!note) return;

    document.getElementById('noteTitle').value = note.title || '';
    document.getElementById('noteContent').value = note.content || '';
    document.getElementById('noteTags').value = (note.tags || []).join(', ');
    document.getElementById('noteFolder').value = note.folder || '';
    document.getElementById('noteLastEdited').textContent = new Date(note.updatedAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    refreshFolderOptions();
    showScreen('editor');
}

function saveCurrentNote() {
    if (!currentNoteId) return;
    const note = data.notes[currentNoteId];
    if (!note) return;

    const title = document.getElementById('noteTitle').value.trim();
    const content = document.getElementById('noteContent').value;
    const tagsRaw = document.getElementById('noteTags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t) : [];
    const folder = document.getElementById('noteFolder').value.trim();

    note.title = title || 'Untitled';
    note.content = content;
    note.tags = tags;
    note.folder = folder;
    note.updatedAt = new Date().toISOString();

    saveData();
}

function refreshFolderOptions() {
    const list = document.getElementById('folderOptions');
    if (!list) return;
    const folders = getDerivedFolders();
    list.innerHTML = folders.map(f => `<option value="${escapeHtml(f)}">`).join('');
}

// ============================================================
// THEME
// ============================================================
function getStoredMode() {
    return localStorage.getItem(MODE_KEY) || 'dark';
}

function applyTheme() {
    const mode = getStoredMode();
    document.documentElement.setAttribute('data-mode', mode);

    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = mode === 'dark' ? ICON_MOON : ICON_SUN;

    // Update theme-color meta
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#16181d' : '#faf6f2');

    updateFavicon(mode);
    updateAppearanceUI();
}

function setMode(mode) {
    if (mode !== 'dark' && mode !== 'light') mode = 'dark';
    localStorage.setItem(MODE_KEY, mode);
    applyTheme();
    scheduleSyncToWorker();
}

function toggleMode() {
    setMode(getStoredMode() === 'dark' ? 'light' : 'dark');
}

function updateFavicon(mode) {
    const accent = mode === 'dark' ? '#e07a3f' : '#9a3412';
    const on = mode === 'dark' ? '#16181d' : '#ffffff';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
        <rect width="512" height="512" rx="112" fill="${accent}"/>
        <rect x="128" y="128" width="256" height="256" rx="28" fill="none" stroke="${on}" stroke-width="24"/>
        <line x1="176" y1="208" x2="336" y2="208" stroke="${on}" stroke-width="20" stroke-linecap="round"/>
        <line x1="176" y1="256" x2="336" y2="256" stroke="${on}" stroke-width="20" stroke-linecap="round"/>
        <line x1="176" y1="304" x2="288" y2="304" stroke="${on}" stroke-width="20" stroke-linecap="round"/>
    </svg>`;
    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(el => {
        el.href = dataUri;
    });
}

function updateAppearanceUI() {
    const mode = getStoredMode();
    document.querySelectorAll('#modeToggle button').forEach(b => {
        b.classList.toggle('active', b.dataset.modeValue === mode);
    });
}

// ============================================================
// TOASTS + MODALS
// ============================================================
let toastTimeout;

function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('show'), 2200);
}

function openModal(title, sub, inputPlaceholder, confirmText, callback) {
    const overlay = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');

    content.innerHTML = `
        <h2>${escapeHtml(title)}</h2>
        <p class="sub">${escapeHtml(sub)}</p>
        <label>Name</label>
        <input id="modalInput" placeholder="${escapeHtml(inputPlaceholder)}" autofocus>
        <div class="btn-row">
            <button class="btn btn-neutral" id="modalCancelBtn">Cancel</button>
            <button class="btn btn-primary" id="modalConfirmBtn">${escapeHtml(confirmText)}</button>
        </div>
    `;

    overlay.classList.add('active');
    setTimeout(() => {
        const input = document.getElementById('modalInput');
        if (input) input.focus();
    }, 100);

    document.getElementById('modalCancelBtn').addEventListener('click', () => {
        overlay.classList.remove('active');
    });
    document.getElementById('modalConfirmBtn').addEventListener('click', () => {
        const value = document.getElementById('modalInput').value.trim();
        overlay.classList.remove('active');
        if (value && callback) callback(value);
    });
    document.getElementById('modalInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('modalConfirmBtn').click();
    });
}

function openConfirm(title, sub, confirmText, callback, danger) {
    const overlay = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');

    content.innerHTML = `
        <h2>${escapeHtml(title)}</h2>
        <p class="sub">${escapeHtml(sub)}</p>
        <div class="btn-row">
            <button class="btn btn-neutral" id="modalCancelBtn">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modalConfirmBtn">${escapeHtml(confirmText)}</button>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('modalCancelBtn').addEventListener('click', () => {
        overlay.classList.remove('active');
    });
    document.getElementById('modalConfirmBtn').addEventListener('click', () => {
        overlay.classList.remove('active');
        if (callback) callback();
    });
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// ============================================================
// NAVIGATION
// ============================================================
function showScreen(screen) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const target = document.getElementById('screen-' + screen);
    if (target) target.classList.add('active');
    if (screen === 'home') { renderNotes(); renderFolderPills(); updateStats(); }
    if (screen === 'settings') loadSettings();
    if (screen === 'folders') renderFoldersScreen();
}

// ============================================================
// RENDER: NOTES
// ============================================================
function renderNotes() {
    const container = document.getElementById('noteList');
    const notes = getFilteredNotes();

    if (notes.length === 0) {
        const msg = searchQuery ? 'No notes match your search.' : 'No notes yet.';
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>
                <p>${msg}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = notes.map((n, idx) => {
        const preview = (n.content || '').replace(/\n/g, ' ').slice(0, 90);
        const folderColor = n.folder ? getFolderColor(n.folder) : null;
        const stripe = folderColor || 'var(--accent)';
        const timeAgo = getTimeAgo(new Date(n.updatedAt || n.createdAt));
        const tags = (n.tags || []).slice(0, 2);

        return `
            <div class="note-row" data-id="${n.id}" style="--row-stripe: ${stripe}; animation-delay: ${Math.min(idx, 8) * 15}ms;">
                <div class="note-row-body" data-action="open" data-id="${n.id}">
                    <div class="note-row-title">${escapeHtml(n.title) || 'Untitled'}</div>
                    ${preview ? `<div class="note-row-excerpt">${escapeHtml(preview)}</div>` : ''}
                    <div class="note-row-meta">
                        ${n.folder ? `<span class="folder-name">${escapeHtml(n.folder)}</span><span class="sep">·</span>` : ''}
                        <span>${timeAgo}</span>
                        ${tags.length ? `<span class="sep">·</span>${tags.map(t => `<span class="tag-inline">#${escapeHtml(t)}</span>`).join('')}` : ''}
                    </div>
                </div>
                <div class="note-row-actions">
                    <button class="note-action ${n.favorite ? 'is-starred' : ''}" data-action="favorite" data-id="${n.id}" aria-label="Star">
                        <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </button>
                    <button class="note-action" data-action="archive" data-id="${n.id}" aria-label="Archive">
                        <svg viewBox="0 0 24 24"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
                    </button>
                    <button class="note-action danger" data-action="delete" data-id="${n.id}" aria-label="Delete">
                        <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-action="open"]').forEach(el => {
        el.addEventListener('click', function() { openNote(this.dataset.id); });
    });
    container.querySelectorAll('[data-action="favorite"]').forEach(btn => {
        btn.addEventListener('click', function(e) { e.stopPropagation(); toggleFavorite(this.dataset.id); });
    });
    container.querySelectorAll('[data-action="archive"]').forEach(btn => {
        btn.addEventListener('click', function(e) { e.stopPropagation(); toggleArchive(this.dataset.id); });
    });
    container.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', function(e) { e.stopPropagation(); deleteNote(this.dataset.id); });
    });
}

function renderFolderPills() {
    const row = document.getElementById('folderPillsRow');
    const folders = getDerivedFolders();

    if (folders.length === 0) {
        row.classList.add('hidden');
        row.innerHTML = '';
        return;
    }

    row.classList.remove('hidden');
    row.innerHTML = folders.map(f => {
        const active = currentFolderFilter === f;
        const color = getFolderColor(f);
        return `
            <button class="folder-pill ${active ? 'active' : ''}" data-folder="${escapeHtml(f)}">
                <span class="dot" style="background: ${active ? 'var(--accent-on)' : color}"></span>
                ${escapeHtml(f)}
            </button>
        `;
    }).join('');

    row.querySelectorAll('.folder-pill').forEach(btn => {
        btn.addEventListener('click', function() {
            const f = this.dataset.folder;
            if (currentFolderFilter === f) currentFolderFilter = null;
            else currentFolderFilter = f;
            renderFolderPills();
            renderNotes();
            updateStats();
        });
    });
}

function getTimeAgo(date) {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    if (diff < 172800000) return 'yesterday';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function updateStats() {
    const allNotes = Object.values(data.notes);
    const total = allNotes.length;
    const favorites = allNotes.filter(n => n.favorite).length;
    const archived = allNotes.filter(n => n.archived).length;
    const folders = getDerivedFolders().length;
    const lastSync = getLastSyncTime();

    document.getElementById('countAll').textContent = total - archived;
    document.getElementById('countFavorites').textContent = favorites;
    document.getElementById('countArchived').textContent = archived;

    // Brand meta
    const metaParts = [];
    metaParts.push(total + (total === 1 ? ' note' : ' notes'));
    if (folders > 0) metaParts.push(folders + (folders === 1 ? ' folder' : ' folders'));
    if (lastSync) {
        const t = new Date(lastSync);
        const diff = Date.now() - t.getTime();
        if (diff < 60000) metaParts.push('synced');
        else if (diff < 3600000) metaParts.push('synced ' + Math.floor(diff/60000) + 'm');
        else if (diff < 86400000) metaParts.push('synced ' + Math.floor(diff/3600000) + 'h');
        else metaParts.push('synced ' + Math.floor(diff/86400000) + 'd');
    } else {
        metaParts.push('not synced');
    }
    document.getElementById('brandMeta').textContent = metaParts.join(' · ');
}

// ============================================================
// FOLDERS SCREEN
// ============================================================
function renderFoldersScreen() {
    const container = document.getElementById('foldersScreenList');
    if (!container) return;
    const folders = getDerivedFolders();

    if (folders.length === 0) {
        container.innerHTML = '<p class="text-muted" style="margin-top:12px;">No folders yet. Folders are created automatically when you assign a name to a note.</p>';
        return;
    }

    container.innerHTML = folders.map(f => {
        const count = getFolderNoteCount(f);
        const color = getFolderColor(f);
        return `
            <div class="folder-list-item" style="--folder-color: ${color};">
                <div class="folder-item-body" data-action="filter" data-folder="${escapeHtml(f)}">
                    <div class="folder-item-name">${escapeHtml(f)}</div>
                    <div class="folder-item-count">${count} note${count === 1 ? '' : 's'}</div>
                </div>
                <button class="folder-item-delete" data-action="delete" data-folder="${escapeHtml(f)}" aria-label="Remove folder">
                    <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                </button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-action="filter"]').forEach(el => {
        el.addEventListener('click', function() {
            currentFolderFilter = this.dataset.folder;
            showScreen('home');
            renderFolderPills();
            renderNotes();
            updateStats();
        });
    });

    container.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const folderName = this.dataset.folder;
            openConfirm(
                'Remove folder?',
                `Notes in "${folderName}" will move to No folder.`,
                'Remove',
                function() {
                    const now = new Date().toISOString();
                    Object.values(data.notes).forEach(n => {
                        if (n.folder === folderName) {
                            n.folder = '';
                            n.updatedAt = now;
                        }
                    });
                    if (currentFolderFilter === folderName) currentFolderFilter = null;
                    saveData();
                    renderFoldersScreen();
                    renderFolderPills();
                    showToast('Folder removed');
                },
                true
            );
        });
    });
}

// ============================================================
// SYNC
// ============================================================
function scheduleSyncToWorker() {
    if (syncingFromWorker) return;
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => { syncToWorker(); }, 2000);
}

async function syncToWorker() {
    if (syncingFromWorker) return;
    const token = localStorage.getItem(SYNC_TOKEN_KEY) || DEFAULT_SYNC_TOKEN;
    if (!token) return;

    setSyncStatus('Syncing...', 'loading');

    try {
        const payload = toWireFormat();
        const res = await fetch(`${WORKER_URL}/v1/sync/${APP_ID}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Token': token
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('HTTP ' + res.status);
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'Sync failed');

        const beforeCount = Object.keys(data.notes).length;

        syncingFromWorker = true;
        const merged = fromWireFormat(result);
        data.notes = merged.notes;
        data.deletedIds = merged.deletedIds;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

        if (result.settings && result.settings.mode && result.settings.mode !== getStoredMode()) {
            localStorage.setItem(MODE_KEY, result.settings.mode);
            applyTheme();
        }

        renderNotes();
        renderFolderPills();
        updateStats();
        setLastSyncTime();
        syncingFromWorker = false;

        const afterCount = Object.keys(data.notes).length;
        const incoming = Math.max(0, afterCount - beforeCount);
        setSyncStatus('Synced · ' + afterCount + ' notes', 'ok');
        if (incoming > 0) showToast(`${incoming} new note${incoming === 1 ? '' : 's'} synced`);
    } catch (err) {
        console.error('[sync] Error:', err);
        syncingFromWorker = false;
        setSyncStatus('Sync failed: ' + err.message, 'error');
    }
}

function setSyncStatus(msg, type) {
    const el = document.getElementById('syncStatusBox');
    if (el) {
        el.textContent = msg;
        el.style.color = type === 'error' ? 'var(--danger)' :
                         type === 'ok' ? 'var(--success)' :
                         type === 'loading' ? 'var(--text-secondary)' : '';
    }
}

function setLastSyncTime() {
    localStorage.setItem(SYNC_TIME_KEY, new Date().toISOString());
    updateSyncInfo();
    updateStats();
}

function getLastSyncTime() {
    return localStorage.getItem(SYNC_TIME_KEY) || null;
}

function updateSyncInfo() {
    const el = document.getElementById('syncInfo');
    if (!el) return;
    const time = getLastSyncTime();
    el.textContent = time ? 'Last synced: ' + new Date(time).toLocaleString() : 'Not synced yet.';
}

// ============================================================
// PUSH
// ============================================================
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

function updatePushUI() {
    const enabled = localStorage.getItem(PUSH_FLAG_KEY) === '1';
    const btn = document.getElementById('enablePushBtn');
    const box = document.getElementById('pushStatusBox');
    if (btn) btn.textContent = enabled ? 'Disable Notifications' : 'Enable Notifications';
    if (box) box.textContent = 'Push: ' + (enabled ? 'enabled' : 'disabled');
}

async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        showToast('Push not supported');
        return;
    }
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') { showToast('Permission denied'); return; }
        const reg = await navigator.serviceWorker.ready;
        const vapidRes = await fetch(`${WORKER_URL}/v1/push/${APP_ID}/vapid-key`);
        const { key } = await vapidRes.json();
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(key)
            });
        }
        await fetch(`${WORKER_URL}/v1/push/${APP_ID}/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub })
        });
        localStorage.setItem(PUSH_FLAG_KEY, '1');
        updatePushUI();
        showToast('Notifications enabled');
    } catch (err) {
        console.error('Push enable error:', err);
        showToast('Failed: ' + err.message);
    }
}

async function disablePush() {
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await fetch(`${WORKER_URL}/v1/push/${APP_ID}/unsubscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint })
            });
            await sub.unsubscribe();
        }
        localStorage.removeItem(PUSH_FLAG_KEY);
        updatePushUI();
        showToast('Notifications disabled');
    } catch (err) {
        console.error('Push disable error:', err);
        showToast('Failed: ' + err.message);
    }
}

// ============================================================
// GOOGLE DRIVE
// ============================================================
function saveGoogleClientId() {
    const v = document.getElementById('googleClientId').value.trim();
    if (v) { localStorage.setItem(CLIENT_ID_KEY, v); showToast('Client ID saved'); }
}
function loadGoogleClientId() { return localStorage.getItem(CLIENT_ID_KEY) || ''; }
function saveGoogleToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function loadGoogleToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function setDriveStatus(msg, type) {
    const el = document.getElementById('driveStatus');
    if (!el) return;
    el.innerHTML = '<div class="drive-status ' + (type || '') + '">' + escapeHtml(msg) + '</div>';
}

function updateDriveButtons(connected) {
    const p = document.getElementById('pushDriveBtn');
    const l = document.getElementById('pullDriveBtn');
    const c = document.getElementById('connectDriveBtn');
    if (p) p.disabled = !connected;
    if (l) l.disabled = !connected;
    if (c) {
        c.textContent = connected ? 'Connected' : 'Connect';
        c.className = connected ? 'btn btn-neutral btn-sm' : 'btn btn-primary btn-sm';
    }
}

function connectGoogleDrive() {
    const clientId = document.getElementById('googleClientId').value.trim() || loadGoogleClientId();
    if (!clientId) { showToast('Enter client ID first'); return; }
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    if (typeof google === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => initGoogleDrive();
        script.onerror = () => showToast('Failed to load Google');
        document.head.appendChild(script);
    } else initGoogleDrive();
}

function initGoogleDrive() {
    const clientId = loadGoogleClientId();
    if (!clientId) return;
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: (tokenResponse) => {
                if (tokenResponse.access_token) {
                    saveGoogleToken(tokenResponse.access_token);
                    setDriveStatus('Connected to Google Drive', 'connected');
                    updateDriveButtons(true);
                    showToast('Drive connected');
                } else {
                    setDriveStatus('Connection failed', 'disconnected');
                    updateDriveButtons(false);
                }
            },
        });
        tokenClient.requestAccessToken();
    } catch (err) {
        setDriveStatus('Error: ' + err.message, 'disconnected');
        updateDriveButtons(false);
    }
}

function handleDriveAuthError(res) {
    if (res.status === 401) {
        saveGoogleToken('');
        updateDriveButtons(false);
        setDriveStatus('Token expired. Reconnect.', 'disconnected');
        return true;
    }
    return false;
}

async function getOrCreateDriveFolder(token) {
    const s = await fetch(
        "https://www.googleapis.com/drive/v3/files?q=name='CjayNotes' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!s.ok) { if (handleDriveAuthError(s)) throw new Error('__auth__'); throw new Error('Folder lookup failed'); }
    const sd = await s.json();
    if (sd.files && sd.files.length > 0) return sd.files[0].id;
    const c = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CjayNotes', mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!c.ok) { if (handleDriveAuthError(c)) throw new Error('__auth__'); throw new Error('Folder creation failed'); }
    const cd = await c.json();
    return cd.id;
}

async function deleteOldBackups(token, folderId, excludeId) {
    const s = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='cjaynotes_backup.json' and '${folderId}' in parents and trashed=false`,
        { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!s.ok) return;
    const sd = await s.json();
    if (sd.files) {
        for (const f of sd.files) {
            if (f.id === excludeId) continue;
            await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + token }
            });
        }
    }
}

async function pushToDrive() {
    const token = loadGoogleToken();
    if (!token) { showToast('Connect Drive first'); return; }
    const noteCount = Object.keys(data.notes).length;
    if (noteCount === 0) { showToast('No notes to push'); return; }
    setDriveStatus('Pushing...', 'pending');
    try {
        const folderId = await getOrCreateDriveFolder(token);
        const backup = {
            data: data,
            mode: getStoredMode(),
            exportedAt: new Date().toISOString()
        };
        const jsonString = JSON.stringify(backup, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify({ name: 'cjaynotes_backup.json', parents: [folderId] })], { type: 'application/json' }));
        form.append('file', blob);
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: form
        });
        if (!r.ok) { if (handleDriveAuthError(r)) return; throw new Error('Upload failed'); }
        const newFile = await r.json();
        await deleteOldBackups(token, folderId, newFile.id);
        setDriveStatus('Pushed ' + noteCount + ' notes', 'connected');
        showToast('Pushed to Drive');
    } catch (err) {
        if (err.message === '__auth__') return;
        setDriveStatus('Push failed: ' + err.message, 'disconnected');
        showToast('Push failed');
    }
}

async function pullFromDrive() {
    const token = loadGoogleToken();
    if (!token) { showToast('Connect Drive first'); return; }
    setDriveStatus('Pulling...', 'pending');
    try {
        const folderId = await getOrCreateDriveFolder(token);
        const s = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='cjaynotes_backup.json' and '${folderId}' in parents and trashed=false`,
            { headers: { 'Authorization': 'Bearer ' + token } }
        );
        const sd = await s.json();
        if (!sd.files || sd.files.length === 0) {
            setDriveStatus('No backup found', '');
            showToast('No backup found');
            return;
        }
        const fileId = sd.files[0].id;
        const fileModified = sd.files[0].modifiedTime;
        const d = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!d.ok) { if (handleDriveAuthError(d)) return; throw new Error('Download failed'); }
        const jsonString = await d.text();
        const backup = JSON.parse(jsonString);
        if (!backup.data || !backup.data.notes) throw new Error('Invalid backup');
        const noteCount = Object.keys(backup.data.notes).length;
        setDriveStatus('Awaiting confirmation...', 'pending');
        openConfirm(
            'Replace all notes?',
            `Backup has ${noteCount} notes from ${new Date(fileModified).toLocaleString()}. This replaces everything currently in the app.`,
            'Restore',
            function() {
                data = backup.data;
                if (!data.deletedIds) data.deletedIds = [];
                if (backup.mode) localStorage.setItem(MODE_KEY, backup.mode);
                applyTheme();
                saveData();
                renderNotes();
                renderFolderPills();
                updateStats();
                setDriveStatus('Imported ' + noteCount + ' notes', 'connected');
                showToast('Imported from Drive');
            },
            true
        );
    } catch (err) {
        if (err.message === '__auth__') return;
        setDriveStatus('Pull failed: ' + err.message, 'disconnected');
        showToast('Pull failed');
    }
}

// ============================================================
// JSON BACKUP
// ============================================================
function exportBackup() {
    const backup = { data: data, mode: getStoredMode(), exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cjaynotes_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported');
}

function importBackup() {
    document.getElementById('backupInput').click();
}

// ============================================================
// RESET
// ============================================================
function resetAllData() {
    openConfirm(
        'Reset all data?',
        'Delete all notes and folders? This cannot be undone.',
        'Delete everything',
        function() {
            data = getDefaultData();
            saveData();
            renderNotes();
            renderFolderPills();
            updateStats();
            showToast('All data cleared');
        },
        true
    );
}

// ============================================================
// SETTINGS LOADER
// ============================================================
function loadSettings() {
    const clientId = loadGoogleClientId();
    if (clientId) document.getElementById('googleClientId').value = clientId;
    const token = loadGoogleToken();
    if (token) { updateDriveButtons(true); setDriveStatus('Connected to Google Drive', 'connected'); }
    else { updateDriveButtons(false); setDriveStatus('Not connected', ''); }
    updateSyncInfo();

    const syncTokenInput = document.getElementById('syncToken');
    if (syncTokenInput && !syncTokenInput.value) {
        syncTokenInput.value = localStorage.getItem(SYNC_TOKEN_KEY) || DEFAULT_SYNC_TOKEN;
    }

    updatePushUI();
    updateAppearanceUI();
    loadAppVersion();
}

async function loadAppVersion() {
    try {
        const res = await fetch('sw.js', { cache: 'no-store' });
        const text = await res.text();
        const match = text.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
        if (match) {
            const el = document.getElementById('appVersion');
            if (el) el.textContent = match[1];
        }
    } catch (e) {}
}

// ============================================================
// EVENT BINDING
// ============================================================
function bindEvents() {
    document.getElementById('undoBtn').addEventListener('click', undoDelete);

    document.getElementById('brandBtn').addEventListener('click', function() {
        currentNoteId = null;
        currentFolderFilter = null;
        showScreen('home');
    });

    document.getElementById('themeBtn').addEventListener('click', toggleMode);

    // Hamburger
    const menuBtn = document.getElementById('menuBtn');
    const menu = document.getElementById('hamburgerMenu');
    menuBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        menu.classList.toggle('open');
    });
    document.addEventListener('click', function(e) {
        if (!menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) {
            menu.classList.remove('open');
        }
    });
    menu.querySelectorAll('.hamburger-item').forEach(item => {
        item.addEventListener('click', function() {
            const action = this.dataset.menu;
            menu.classList.remove('open');
            if (action === 'home') {
                currentNoteId = null;
                currentFolderFilter = null;
                showScreen('home');
            } else if (action === 'search') {
                showScreen('home');
                document.getElementById('searchBar').classList.remove('hidden');
                document.getElementById('searchInput').focus();
            } else if (action === 'folders') {
                showScreen('folders');
            } else if (action === 'settings') {
                showScreen('settings');
            }
        });
    });

    // Search
    document.getElementById('searchInput').addEventListener('input', function() {
        searchQuery = this.value.trim();
        renderNotes();
        updateStats();
    });
    document.getElementById('clearSearchBtn').addEventListener('click', function() {
        document.getElementById('searchInput').value = '';
        searchQuery = '';
        renderNotes();
        updateStats();
    });

    // Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            currentFilter = this.dataset.filter;
            renderNotes();
            updateStats();
        });
    });

    // Editor
    document.getElementById('backFromEditorBtn').addEventListener('click', function() {
        saveCurrentNote();
        currentNoteId = null;
        showScreen('home');
    });
    document.getElementById('saveNoteBtn').addEventListener('click', function() {
        saveCurrentNote();
        showToast('Saved');
    });
    document.getElementById('noteTitle').addEventListener('input', saveCurrentNote);
    document.getElementById('noteContent').addEventListener('input', saveCurrentNote);
    document.getElementById('noteTags').addEventListener('input', saveCurrentNote);
    document.getElementById('noteFolder').addEventListener('input', saveCurrentNote);

    // FAB
    document.getElementById('fabButton').addEventListener('click', function() {
        const id = createNote();
        openNote(id);
    });

    // Mode
    document.querySelectorAll('#modeToggle button').forEach(btn => {
        btn.addEventListener('click', function() { setMode(this.dataset.modeValue); });
    });

    // Sync
    const syncTokenInput = document.getElementById('syncToken');
    if (syncTokenInput) {
        syncTokenInput.addEventListener('change', function() {
            const v = this.value.trim();
            if (v) { localStorage.setItem(SYNC_TOKEN_KEY, v); showToast('Sync token saved'); }
        });
    }
    document.getElementById('syncNowBtn').addEventListener('click', () => syncToWorker());
    document.getElementById('enablePushBtn').addEventListener('click', function() {
        if (localStorage.getItem(PUSH_FLAG_KEY) === '1') disablePush();
        else enablePush();
    });

    // Drive
    document.getElementById('googleClientId').addEventListener('change', saveGoogleClientId);
    document.getElementById('connectDriveBtn').addEventListener('click', connectGoogleDrive);
    document.getElementById('pushDriveBtn').addEventListener('click', pushToDrive);
    document.getElementById('pullDriveBtn').addEventListener('click', pullFromDrive);

    // Backup
    document.getElementById('exportBackupBtn').addEventListener('click', exportBackup);
    document.getElementById('importBackupBtn').addEventListener('click', importBackup);
    document.getElementById('resetAllBtn').addEventListener('click', resetAllData);

    document.getElementById('backupInput').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const backup = JSON.parse(event.target.result);
                if (!backup.data || !backup.data.notes) { showToast('Invalid backup'); return; }
                const noteCount = Object.keys(backup.data.notes).length;
                openConfirm(
                    'Replace all notes?',
                    `Backup has ${noteCount} notes. This replaces everything currently in the app.`,
                    'Restore',
                    function() {
                        data = backup.data;
                        if (!data.deletedIds) data.deletedIds = [];
                        if (backup.mode) localStorage.setItem(MODE_KEY, backup.mode);
                        applyTheme();
                        saveData();
                        renderNotes();
                        renderFolderPills();
                        updateStats();
                        showToast('Restored ' + noteCount + ' notes');
                    },
                    true
                );
            } catch (err) {
                showToast('Invalid backup file');
            }
        };
        reader.readAsText(file);
        this.value = '';
    });

    // Modal overlay
    document.getElementById('modalOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeModal();
    });

    // Collapsible groups
    document.querySelectorAll('.group-header').forEach(header => {
        header.addEventListener('click', function() {
            const content = this.nextElementSibling;
            const icon = this.querySelector('.toggle-icon');
            if (content.classList.contains('open')) {
                content.classList.remove('open');
                icon.classList.remove('open');
            } else {
                content.classList.add('open');
                icon.classList.add('open');
            }
        });
    });

    // Save on click outside editor
    document.addEventListener('click', function(e) {
        if (!document.getElementById('screen-editor').classList.contains('active')) return;
        const editor = document.querySelector('.editor-container');
        const backBtn = document.getElementById('backFromEditorBtn');
        const saveBtn = document.getElementById('saveNoteBtn');
        if (editor && !editor.contains(e.target) &&
            e.target !== backBtn && !backBtn.contains(e.target) &&
            e.target !== saveBtn && !saveBtn.contains(e.target)) {
            saveCurrentNote();
        }
    });

    // Update refresh
    const refreshBtn = document.getElementById('updateRefreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
            if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            } else {
                window.location.reload();
            }
        });
    }
}

// ============================================================
// ONLINE / OFFLINE
// ============================================================
function updateOnlineStatus() {
    const banner = document.getElementById('offlineBanner');
    if (navigator.onLine) banner.classList.remove('show');
    else banner.classList.add('show');
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ============================================================
// SERVICE WORKER
// ============================================================
let refreshing = false;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(reg => {
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    const toast = document.getElementById('updateToast');
                    toast.classList.add('show');
                    setTimeout(() => toast.classList.remove('show'), 5000);
                }
            });
        });
    }).catch(err => console.warn('[sw] Registration failed:', err));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
    });
}

// ============================================================
// VISIBILITY SYNC
// ============================================================
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') syncToWorker();
});

// ============================================================
// BOOT
// ============================================================
applyTheme();
renderNotes();
renderFolderPills();
updateStats();
bindEvents();
updateOnlineStatus();

setTimeout(() => syncToWorker(), 500);
