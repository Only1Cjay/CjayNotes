// ============================================================
// CONFIG
// ============================================================
const STORAGE_KEY = 'cjaynotes_data';
const CLIENT_ID_KEY = 'cjaynotes_google_client_id';
const TOKEN_KEY = 'cjaynotes_google_token';
const SYNC_TIME_KEY = 'cjaynotes_last_sync';
const SYNC_TOKEN_KEY = 'cjaynotes_sync_token';
const PUSH_FLAG_KEY = 'cjaynotes_push_enabled';
const PALETTE_KEY = 'cjaynotes_palette';
const MODE_KEY = 'cjaynotes_mode';

const WORKER_URL = 'https://cjay-cloud.monaplayzsbackup.workers.dev';
const APP_ID = 'cjaynotes';
const DEFAULT_SYNC_TOKEN = 'cjn_m5x9q3w7r2t6y8u4v1b5n9p4k8j3d7f2';

// Palette definitions — accent color per palette (used for favicon generation)
const PALETTES = {
    teal:      { accent: '#14b8a6', accentOn: '#041a18' },
    mint:      { accent: '#4ade80', accentOn: '#0a1a14' },
    forest:    { accent: '#22c55e', accentOn: '#061a0f' },
    deepgreen: { accent: '#34d399', accentOn: '#0a0f0d' }
};

const ICON_SVG_MOON = '<svg class="icon-svg" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SVG_SUN = '<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/></svg>';

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
        settings: {
            palette: getStoredPalette(),
            mode: getStoredMode()
        }
    };
}

function fromWireFormat(wire) {
    const notesMap = {};
    (wire.collections && wire.collections.notes ? wire.collections.notes : []).forEach(n => {
        notesMap[n.id] = n;
    });
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

    if (currentFilter === 'favorites') {
        notes = notes.filter(n => n.favorite);
    } else if (currentFilter === 'archived') {
        notes = notes.filter(n => n.archived);
    } else {
        notes = notes.filter(n => !n.archived);
    }

    if (currentFolderFilter) {
        notes = notes.filter(n => n.folder === currentFolderFilter);
    }

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        notes = notes.filter(n => {
            return (n.title || '').toLowerCase().includes(q) ||
                   (n.content || '').toLowerCase().includes(q) ||
                   (n.tags || []).some(t => t.toLowerCase().includes(q)) ||
                   (n.folder || '').toLowerCase().includes(q);
        });
    }

    return notes;
}

function createNote(title = '', content = '') {
    const id = generateId();
    const now = new Date().toISOString();
    data.notes[id] = {
        id: id,
        title: title || 'Untitled',
        content: content,
        tags: [],
        folder: '',
        favorite: false,
        archived: false,
        createdAt: now,
        updatedAt: now
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
        if (!data.deletedIds.includes(id)) {
            data.deletedIds.push(id);
        }
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
    const toast = document.getElementById('undoToast');
    toast.classList.remove('show');

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
    document.getElementById('noteLastEdited').textContent = 'Last edited: ' + new Date(note.updatedAt).toLocaleString();

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
function getStoredPalette() {
    return localStorage.getItem(PALETTE_KEY) || 'teal';
}
function getStoredMode() {
    return localStorage.getItem(MODE_KEY) || 'dark';
}

function applyTheme() {
    const palette = getStoredPalette();
    const mode = getStoredMode();

    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-mode', mode);

    // Top bar theme button icon
    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = mode === 'dark' ? ICON_SVG_MOON : ICON_SVG_SUN;

    // Update the browser tab icon
    updateFavicon(PALETTES[palette] ? PALETTES[palette].accent : PALETTES.teal.accent);

    // Update settings UI if loaded
    updateAppearanceUI();
}

function setPalette(palette) {
    if (!PALETTES[palette]) palette = 'teal';
    localStorage.setItem(PALETTE_KEY, palette);
    applyTheme();
    scheduleSyncToWorker();
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

function updateFavicon(accentColor) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
        <rect width="512" height="512" rx="112" fill="${accentColor}"/>
        <rect x="128" y="128" width="256" height="256" rx="28" fill="none" stroke="#0a1a12" stroke-width="24"/>
        <line x1="176" y1="208" x2="336" y2="208" stroke="#0a1a12" stroke-width="20" stroke-linecap="round"/>
        <line x1="176" y1="256" x2="336" y2="256" stroke="#0a1a12" stroke-width="20" stroke-linecap="round"/>
        <line x1="176" y1="304" x2="288" y2="304" stroke="#0a1a12" stroke-width="20" stroke-linecap="round"/>
    </svg>`;
    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(el => {
        el.href = dataUri;
    });
}

function updateAppearanceUI() {
    const palette = getStoredPalette();
    const mode = getStoredMode();

    document.querySelectorAll('#modeToggle button').forEach(b => {
        b.classList.toggle('active', b.dataset.modeValue === mode);
    });
    document.querySelectorAll('#palettePicker button').forEach(b => {
        b.classList.toggle('active', b.dataset.paletteValue === palette);
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
    toastTimeout = setTimeout(() => el.classList.remove('show'), 2500);
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
    if (screen === 'home') { renderNotes(); updateStats(); }
    if (screen === 'settings') { loadSettings(); }
    if (screen === 'folders') { renderFoldersScreen(); }
}

// ============================================================
// RENDER: NOTES
// ============================================================
function renderNotes() {
    const container = document.getElementById('noteList');
    const notes = getFilteredNotes();

    if (notes.length === 0) {
        const msg = searchQuery ? 'No notes match your search.' : 'No notes yet. Tap "+" to create one.';
        container.innerHTML = `
            <div class="empty-state">
                <svg class="icon-svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="12" y2="12"/></svg>
                <p>${msg}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = notes.map(n => {
        const preview = (n.content || '').slice(0, 100) + ((n.content || '').length > 100 ? '...' : '');
        const tags = (n.tags || []).slice(0, 3);
        const extraTags = (n.tags || []).length > 3 ? '+' + ((n.tags || []).length - 3) : '';
        const date = new Date(n.updatedAt || n.createdAt);
        const timeAgo = getTimeAgo(date);
        const isFavorite = n.favorite;

        return `
            <div class="note-card" data-id="${n.id}">
                <div class="info" data-action="open" data-id="${n.id}">
                    <div class="title">${escapeHtml(n.title) || 'Untitled'}</div>
                    <div class="preview">${escapeHtml(preview) || 'Empty note'}</div>
                    <div class="meta">
                        ${n.folder ? `<span class="folder-tag">${escapeHtml(n.folder)}</span>` : ''}
                        ${tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
                        ${extraTags ? `<span class="tag">${escapeHtml(extraTags)}</span>` : ''}
                        <span class="date">${timeAgo}</span>
                    </div>
                </div>
                <div class="actions">
                    <button class="icon-btn-sm" data-action="favorite" data-id="${n.id}" title="Favorite">
                        <svg class="icon-svg ${isFavorite ? 'star-filled' : 'star-empty'}" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </button>
                    <button class="icon-btn-sm" data-action="archive" data-id="${n.id}" title="Archive">
                        <svg class="icon-svg" viewBox="0 0 24 24"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
                    </button>
                    <button class="icon-btn-sm danger" data-action="delete" data-id="${n.id}" title="Delete">
                        <svg class="icon-svg" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-action="open"]').forEach(el => {
        el.addEventListener('click', function() { openNote(this.dataset.id); });
    });
    container.querySelectorAll('[data-action="favorite"]').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleFavorite(this.dataset.id);
        });
    });
    container.querySelectorAll('[data-action="archive"]').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleArchive(this.dataset.id);
        });
    });
    container.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            deleteNote(this.dataset.id);
        });
    });
}

function getTimeAgo(date) {
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 172800000) return 'Yesterday';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return date.toLocaleDateString();
}

function updateStats() {
    const allNotes = Object.values(data.notes);
    const total = allNotes.length;
    const favorites = allNotes.filter(n => n.favorite).length;
    const archived = allNotes.filter(n => n.archived).length;
    const tags = new Set();
    allNotes.forEach(n => (n.tags || []).forEach(t => tags.add(t)));
    const folders = getDerivedFolders().length;

    document.getElementById('statNotes').textContent = total;
    document.getElementById('statTags').textContent = tags.size;
    document.getElementById('statFolders').textContent = folders;
    document.getElementById('countAll').textContent = total - archived;
    document.getElementById('countFavorites').textContent = favorites;
    document.getElementById('countArchived').textContent = archived;

    const filterEl = document.getElementById('activeFolderFilter');
    const filterText = document.getElementById('activeFolderFilterText');
    if (currentFolderFilter) {
        filterEl.classList.remove('hidden');
        filterText.textContent = 'Folder: ' + currentFolderFilter;
    } else {
        filterEl.classList.add('hidden');
    }
}

// ============================================================
// FOLDERS SCREEN
// ============================================================
function renderFoldersScreen() {
    const container = document.getElementById('foldersScreenList');
    if (!container) return;
    const folders = getDerivedFolders();
    if (folders.length === 0) {
        container.innerHTML = '<p class="text-muted">No folders yet. Folders are created automatically when you assign one to a note.</p>';
        return;
    }
    container.innerHTML = folders.map(f => `
        <div class="folder-item" data-folder="${escapeHtml(f)}">
            <div class="folder-info" data-action="filter" data-folder="${escapeHtml(f)}" style="flex:1;">
                <div class="folder-name">${escapeHtml(f)}</div>
                <div class="folder-count">${getFolderNoteCount(f)} note${getFolderNoteCount(f) > 1 ? 's' : ''}</div>
            </div>
            <button class="folder-delete" data-action="delete" data-folder="${escapeHtml(f)}" title="Remove folder">
                <svg class="icon-svg sm" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('[data-action="filter"]').forEach(el => {
        el.addEventListener('click', function() {
            currentFolderFilter = this.dataset.folder;
            showScreen('home');
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
                `Remove folder "${folderName}"? Notes in it will move to "No folder".`,
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

        // Apply remote palette/mode if provided
        if (result.settings) {
            let changed = false;
            if (result.settings.palette && PALETTES[result.settings.palette] && result.settings.palette !== getStoredPalette()) {
                localStorage.setItem(PALETTE_KEY, result.settings.palette);
                changed = true;
            }
            if (result.settings.mode && result.settings.mode !== getStoredMode()) {
                localStorage.setItem(MODE_KEY, result.settings.mode);
                changed = true;
            }
            if (changed) applyTheme();
        }

        renderNotes();
        updateStats();
        setLastSyncTime();
        syncingFromWorker = false;

        const afterCount = Object.keys(data.notes).length;
        const incoming = Math.max(0, afterCount - beforeCount);
        setSyncStatus('Synced · ' + afterCount + ' notes', 'ok');
        if (incoming > 0) showToast(`${incoming} new note${incoming > 1 ? 's' : ''} synced ✨`);
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
                         type === 'ok' ? 'var(--accent)' :
                         type === 'loading' ? 'var(--text-secondary)' : '';
    }
    const statEl = document.getElementById('syncStatusText');
    if (statEl) {
        const t = getLastSyncTime();
        statEl.textContent = t ? new Date(t).toLocaleDateString() : 'Not synced';
    }
}

function setLastSyncTime() {
    localStorage.setItem(SYNC_TIME_KEY, new Date().toISOString());
    updateSyncInfo();
}

function getLastSyncTime() {
    return localStorage.getItem(SYNC_TIME_KEY) || null;
}

function updateSyncInfo() {
    const el = document.getElementById('syncInfo');
    if (!el) return;
    const time = getLastSyncTime();
    if (time) {
        el.textContent = 'Last synced: ' + new Date(time).toLocaleString();
        document.getElementById('syncStatusText').textContent = new Date(time).toLocaleDateString();
    } else {
        el.textContent = 'Not synced yet. Push or pull data.';
        document.getElementById('syncStatusText').textContent = 'Not synced';
    }
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
        showToast('Push not supported on this device');
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
        showToast('Push notifications enabled');
    } catch (err) {
        console.error('Push enable error:', err);
        showToast('Failed to enable push: ' + err.message);
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
        showToast('Push notifications disabled');
    } catch (err) {
        console.error('Push disable error:', err);
        showToast('Failed to disable push: ' + err.message);
    }
}

// ============================================================
// GOOGLE DRIVE
// ============================================================
function saveGoogleClientId() {
    const clientId = document.getElementById('googleClientId').value.trim();
    if (clientId) {
        localStorage.setItem(CLIENT_ID_KEY, clientId);
        showToast('Client ID saved!');
    }
}
function loadGoogleClientId() { return localStorage.getItem(CLIENT_ID_KEY) || ''; }
function saveGoogleToken(token) { localStorage.setItem(TOKEN_KEY, token); }
function loadGoogleToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function setDriveStatus(msg, type) {
    const el = document.getElementById('driveStatus');
    if (!el) return;
    el.innerHTML = '<div class="drive-status ' + (type || '') + '">' + escapeHtml(msg) + '</div>';
}

function updateDriveButtons(connected) {
    const pushBtn = document.getElementById('pushDriveBtn');
    const pullBtn = document.getElementById('pullDriveBtn');
    const connectBtn = document.getElementById('connectDriveBtn');
    if (pushBtn) pushBtn.disabled = !connected;
    if (pullBtn) pullBtn.disabled = !connected;
    if (connectBtn) {
        connectBtn.textContent = connected ? '✅ Connected' : 'Connect';
        connectBtn.className = connected ? 'btn btn-success btn-sm' : 'btn btn-primary btn-sm';
    }
}

function connectGoogleDrive() {
    const clientId = document.getElementById('googleClientId').value.trim() || loadGoogleClientId();
    if (!clientId) { showToast('Please enter your Google Client ID first.'); return; }
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    if (typeof google === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = function() { initGoogleDrive(); };
        script.onerror = function() { showToast('Failed to load Google library.'); };
        document.head.appendChild(script);
    } else { initGoogleDrive(); }
}

function initGoogleDrive() {
    const clientId = loadGoogleClientId();
    if (!clientId) return;
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: function(tokenResponse) {
                if (tokenResponse.access_token) {
                    saveGoogleToken(tokenResponse.access_token);
                    setDriveStatus('✅ Connected to Google Drive', 'connected');
                    updateDriveButtons(true);
                    showToast('Google Drive connected!');
                } else {
                    setDriveStatus('❌ Connection failed', 'disconnected');
                    updateDriveButtons(false);
                }
            },
        });
        tokenClient.requestAccessToken();
    } catch (err) {
        setDriveStatus('❌ Error: ' + err.message, 'disconnected');
        updateDriveButtons(false);
    }
}

function handleDriveAuthError(response) {
    if (response.status === 401) {
        saveGoogleToken('');
        updateDriveButtons(false);
        setDriveStatus('❌ Token expired. Reconnect.', 'disconnected');
        showToast('Token expired.');
        return true;
    }
    return false;
}

async function getOrCreateDriveFolder(token) {
    const searchRes = await fetch(
        "https://www.googleapis.com/drive/v3/files?q=name='CjayNotes' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!searchRes.ok) {
        if (handleDriveAuthError(searchRes)) throw new Error('__auth_handled__');
        throw new Error('Folder lookup failed (HTTP ' + searchRes.status + ')');
    }
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) return searchData.files[0].id;
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CjayNotes', mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!createRes.ok) {
        if (handleDriveAuthError(createRes)) throw new Error('__auth_handled__');
        throw new Error('Folder creation failed (HTTP ' + createRes.status + ')');
    }
    const createData = await createRes.json();
    return createData.id;
}

async function deleteOldBackups(token, folderId, excludeId) {
    const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='cjaynotes_backup.json' and '${folderId}' in parents and trashed=false`,
        { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!searchRes.ok) return;
    const searchData = await searchRes.json();
    if (searchData.files) {
        for (const file of searchData.files) {
            if (file.id === excludeId) continue;
            await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + token }
            });
        }
    }
}

async function pushToDrive() {
    const token = loadGoogleToken();
    if (!token) { showToast('Please connect to Google Drive first.'); return; }
    const noteCount = Object.keys(data.notes).length;
    if (noteCount === 0) { showToast('No notes to push.'); return; }
    setDriveStatus('📤 Pushing...', 'pending');
    try {
        const folderId = await getOrCreateDriveFolder(token);
        const backupData = {
            data: data,
            palette: getStoredPalette(),
            mode: getStoredMode(),
            exportedAt: new Date().toISOString()
        };
        const jsonString = JSON.stringify(backupData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const metadata = { name: 'cjaynotes_backup.json', parents: [folderId] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', blob);
        const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: form
        });
        if (!response.ok) {
            if (handleDriveAuthError(response)) return;
            throw new Error('Upload failed (HTTP ' + response.status + ')');
        }
        const newFile = await response.json();
        await deleteOldBackups(token, folderId, newFile.id);
        setDriveStatus('✅ Push successful! ' + noteCount + ' notes backed up.', 'connected');
        showToast('Notes pushed to Drive!');
    } catch (err) {
        if (err.message === '__auth_handled__') return;
        setDriveStatus('❌ Push failed: ' + err.message, 'disconnected');
        showToast('Push failed.');
    }
}

async function pullFromDrive() {
    const token = loadGoogleToken();
    if (!token) { showToast('Please connect to Google Drive first.'); return; }
    setDriveStatus('📥 Pulling...', 'pending');
    try {
        const folderId = await getOrCreateDriveFolder(token);
        const searchRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='cjaynotes_backup.json' and '${folderId}' in parents and trashed=false`,
            { headers: { 'Authorization': 'Bearer ' + token } }
        );
        const searchData = await searchRes.json();
        if (!searchData.files || searchData.files.length === 0) {
            setDriveStatus('ℹ️ No backup found. Push data first.', '');
            showToast('No backup found.');
            return;
        }
        const fileId = searchData.files[0].id;
        const fileModified = searchData.files[0].modifiedTime;
        const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!downloadRes.ok) {
            if (handleDriveAuthError(downloadRes)) return;
            throw new Error('Download failed (HTTP ' + downloadRes.status + ')');
        }
        const jsonString = await downloadRes.text();
        const backupData = JSON.parse(jsonString);
        if (!backupData.data || !backupData.data.notes) throw new Error('Invalid backup format.');
        const noteCount = Object.keys(backupData.data.notes).length;
        setDriveStatus('Awaiting confirmation...', 'pending');
        openConfirm(
            'Replace all notes?',
            `Drive backup contains ${noteCount} notes, last modified ${new Date(fileModified).toLocaleString()}. This will replace everything currently in the app.`,
            'Restore',
            function() {
                data = backupData.data;
                if (!data.deletedIds) data.deletedIds = [];
                if (backupData.palette && PALETTES[backupData.palette]) localStorage.setItem(PALETTE_KEY, backupData.palette);
                if (backupData.mode) localStorage.setItem(MODE_KEY, backupData.mode);
                applyTheme();
                saveData();
                renderNotes();
                updateStats();
                setDriveStatus('✅ Pull successful! Imported ' + noteCount + ' notes.', 'connected');
                showToast('✅ Imported ' + noteCount + ' notes from Drive!');
            },
            true
        );
    } catch (err) {
        if (err.message === '__auth_handled__') return;
        setDriveStatus('❌ Pull failed: ' + err.message, 'disconnected');
        showToast('Pull failed.');
    }
}

// ============================================================
// JSON BACKUP
// ============================================================
function exportBackup() {
    const backupData = {
        data: data,
        palette: getStoredPalette(),
        mode: getStoredMode(),
        exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cjaynotes_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exported!');
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
        'Delete ALL notes and folders? This cannot be undone.',
        'Delete everything',
        function() {
            data = getDefaultData();
            saveData();
            renderNotes();
            updateStats();
            showToast('All data cleared.');
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
    if (token) {
        updateDriveButtons(true);
        setDriveStatus('✅ Connected to Google Drive', 'connected');
    } else {
        updateDriveButtons(false);
        setDriveStatus('ℹ️ Not connected. Click "Connect".', '');
    }
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
    // Undo
    document.getElementById('undoBtn').addEventListener('click', undoDelete);

    // Brand → home
    document.getElementById('brandBtn').addEventListener('click', function() {
        currentNoteId = null;
        currentFolderFilter = null;
        showScreen('home');
    });

    // Top bar theme quick toggle
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

    // Clear folder filter
    document.getElementById('clearFolderFilterBtn').addEventListener('click', function() {
        currentFolderFilter = null;
        renderNotes();
        updateStats();
    });

    // Filter buttons
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
        showToast('Note saved!');
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

    // Appearance — mode toggle
    document.querySelectorAll('#modeToggle button').forEach(btn => {
        btn.addEventListener('click', function() {
            setMode(this.dataset.modeValue);
        });
    });

    // Appearance — palette picker
    document.querySelectorAll('#palettePicker button').forEach(btn => {
        btn.addEventListener('click', function() {
            setPalette(this.dataset.paletteValue);
        });
    });

    // Sync
    const syncTokenInput = document.getElementById('syncToken');
    if (syncTokenInput) {
        syncTokenInput.addEventListener('change', function() {
            const val = this.value.trim();
            if (val) {
                localStorage.setItem(SYNC_TOKEN_KEY, val);
                showToast('Sync token saved');
            }
        });
    }
    document.getElementById('syncNowBtn').addEventListener('click', function() { syncToWorker(); });
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
                const backupData = JSON.parse(event.target.result);
                if (!backupData.data || !backupData.data.notes) { showToast('Invalid backup file!'); return; }
                const noteCount = Object.keys(backupData.data.notes).length;
                openConfirm(
                    'Replace all notes?',
                    `Backup contains ${noteCount} notes. This will replace everything currently in the app.`,
                    'Restore',
                    function() {
                        data = backupData.data;
                        if (!data.deletedIds) data.deletedIds = [];
                        if (backupData.palette && PALETTES[backupData.palette]) localStorage.setItem(PALETTE_KEY, backupData.palette);
                        if (backupData.mode) localStorage.setItem(MODE_KEY, backupData.mode);
                        applyTheme();
                        saveData();
                        renderNotes();
                        updateStats();
                        showToast(`✅ Restored ${noteCount} notes from backup!`);
                    },
                    true
                );
            } catch (err) {
                showToast('❌ Error: Invalid backup file');
            }
        };
        reader.readAsText(file);
        this.value = '';
    });

    // Modal overlay click
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

    // Update toast button
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
    if (document.visibilityState === 'visible') {
        syncToWorker();
    }
});

// ============================================================
// BOOT
// ============================================================
applyTheme();
renderNotes();
updateStats();
bindEvents();
updateOnlineStatus();

setTimeout(() => { syncToWorker(); }, 500);
