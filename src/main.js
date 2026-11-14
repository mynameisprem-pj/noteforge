import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  auth,
  signInGuest,
  signInGoogle,
  logOutUser,
  onAuthStateChanged,
  verifyAppCheckStatus,
  checkOnDeviceModelStatus,
  warmUpOnDeviceModel
} from './firebase.js';
import {
  ensureStarterNotes,
  getAllNotes,
  saveNote,
  deleteNote,
  getRecentAIRuns,
  clearAIRuns,
  getSetting,
  setSetting
} from './db.js';
import {
  USER_PRIVACY_MODES,
  ON_DEVICE_CHAR_LIMIT,
  summarizeNote,
  generateTagsForNote,
  rewriteNote,
  askNoteQuestion,
  synthesizeMultipleNotes
} from './ai-service.js';

marked.setOptions({ breaks: true, gfm: true });

function renderSafeMarkdown(mdText = '') {
  const rawHtml = marked.parse(mdText);
  return DOMPurify.sanitize(rawHtml);
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimeAgo(ts) {
  const diffSec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------------- APPLICATION STATE ----------------
const state = {
  notes: [],
  activeNoteId: null,
  selectedForSynthesis: new Set(),
  searchQuery: '',
  privacyMode: USER_PRIVACY_MODES.HYBRID_DEFAULT,
  aiRuns: [],
  aiBusy: false,
  aiStatusMsg: '',
  aiErrorMsg: '',
  online: navigator.onLine,
  nanoState: 'checking...',
  nanoDownloadPct: null,
  appCheckOk: false,
  user: null,
  mobileTab: 'editor', // 'vault' | 'editor' | 'ai'
  saveStateText: 'Saved offline in IndexedDB'
};

let saveDebounceTimer = null;

function getActiveNote() {
  return state.notes.find((n) => n.id === state.activeNoteId) || null;
}

function getFilteredNotes() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.notes;
  return state.notes.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.tags.some((t) => t.includes(q))
  );
}

// ---------------- SHELL RENDER ----------------
const appEl = document.querySelector('#app');

function mountShell() {
  appEl.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand-logo" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div>
          <div class="brand-title">NoteForge</div>
          <div class="brand-sub">Offline-First Hybrid AI Research Companion</div>
        </div>
      </div>

      <div class="topbar-controls">
        <span id="pill-network" class="status-pill"></span>
        <span id="pill-nano" class="status-pill" title="Chrome Built-in Gemini Nano status"></span>
        <button id="btn-warmup-nano" class="btn" style="display:none; font-size:0.73rem; padding:0.28rem 0.6rem;">Enable Local Nano</button>
        <span id="pill-appcheck" class="status-pill" title="Firebase App Check protection"></span>

        <div class="mode-switch" role="group" aria-label="AI Inference Privacy Mode">
          <button id="mode-prefer-local" class="mode-btn" title="Try Gemini Nano on-device first; fall back to Cloud when needed">
            Hybrid (Prefer On-Device)
          </button>
          <button id="mode-only-local" class="mode-btn" title="Strict Privacy Lock: ONLY_ON_DEVICE — refuses cloud">
            Privacy Lock (Only On-Device)
          </button>
        </div>

        <div id="auth-controls" class="auth-bar"></div>
      </div>
    </header>

    <main class="workspace">
      <!-- PANE 1: NOTES VAULT -->
      <aside id="pane-vault" class="pane">
        <div class="pane-header">
          <div class="pane-title-row">
            <span class="pane-title">IndexedDB Vault (<span id="notes-count">0</span>)</span>
            <button id="btn-new-note" class="btn btn-primary" style="padding:0.32rem 0.65rem; font-size:0.76rem;">+ New Note</button>
          </div>
          <input id="input-search" class="search-input" type="search" placeholder="Search notes or #tags offline..." />
        </div>
        <div id="notes-list" class="notes-list"></div>
      </aside>

      <!-- PANE 2: NOTE EDITOR -->
      <section id="pane-editor" class="pane editor-pane mobile-active">
        <div class="editor-toolbar">
          <span id="save-indicator" class="save-indicator">Saved offline in IndexedDB</span>
          <div style="display:flex; gap:0.45rem; align-items:center;">
            <button id="btn-pin-note" class="btn" style="font-size:0.75rem; padding:0.32rem 0.62rem;">Pin</button>
            <button id="btn-export-md" class="btn" style="font-size:0.75rem; padding:0.32rem 0.62rem;">Export .md</button>
            <button id="btn-delete-note" class="btn btn-danger" style="font-size:0.75rem; padding:0.32rem 0.62rem;">Delete</button>
          </div>
        </div>

        <div class="editor-body">
          <input id="editor-title" class="title-input" type="text" placeholder="Note title..." />
          <div class="tags-editor-row">
            <div id="editor-tags" class="tag-row"></div>
            <input id="input-add-tag" class="tag-input" type="text" placeholder="+ add tag & press Enter" />
          </div>
          <textarea id="editor-content" class="content-textarea" placeholder="Write field notes, paste literature excerpts, or draft confidential findings... Everything saves instantly to IndexedDB and works offline."></textarea>
          <div class="editor-footer">
            <span id="editor-stats">0 words · 0 chars</span>
            <span id="editor-routing-hint"></span>
          </div>
        </div>
      </section>

      <!-- PANE 3: HYBRID AI RESEARCH COMPANION -->
      <aside id="pane-ai" class="pane ai-pane">
        <div class="pane-header">
          <div class="pane-title-row">
            <span class="pane-title">Hybrid AI Companion</span>
            <button id="btn-clear-runs" class="btn" style="font-size:0.7rem; padding:0.22rem 0.5rem;">Clear History</button>
          </div>
          <div id="mode-explainer" style="font-size:0.74rem; color:var(--text-muted); line-height:1.4;"></div>
        </div>

        <div class="ai-scroll">
          <!-- Quick Single-Note Capabilities -->
          <div class="action-card">
            <div class="action-card-label">
              <span>Active Note Actions</span>
              <span style="font-weight:500; text-transform:none;">On-device first</span>
            </div>
            <div class="action-grid">
              <button id="btn-ai-summarize" class="btn">Summarize Note</button>
              <button id="btn-ai-autotag" class="btn">Auto-Tag Note</button>
            </div>
            <div class="rewrite-row">
              <select id="select-rewrite-style" class="select-input" aria-label="Rewrite style">
                <option value="clarity">Rewrite: Crisp & Clear</option>
                <option value="executive">Rewrite: Executive Brief</option>
                <option value="academic">Rewrite: Academic Prose</option>
              </select>
              <button id="btn-ai-rewrite" class="btn">Rewrite</button>
            </div>
            <form id="form-note-qa" class="qa-row">
              <input id="input-qa" class="text-input" type="text" placeholder="Ask a question about this note..." required />
              <button id="btn-ai-qa" type="submit" class="btn btn-primary">Ask</button>
            </form>
          </div>

          <!-- Multi-Note Cloud Synthesis -->
          <div class="action-card">
            <div class="action-card-label">
              <span>Multi-Note Synthesis (<span id="synth-count">0</span> selected)</span>
              <span style="font-weight:500; text-transform:none; color:var(--sky-text);">Cloud Reasoning</span>
            </div>
            <p style="font-size:0.74rem; color:var(--text-muted); line-height:1.4;">
              Tick 2+ notes in the Vault (or click Select All) to synthesize cross-note themes and citations.
            </p>
            <div style="display:flex; gap:0.4rem;">
              <button id="btn-select-all-synth" type="button" class="btn" style="font-size:0.73rem; padding:0.28rem 0.55rem;">Select All Notes</button>
              <button id="btn-clear-synth" type="button" class="btn" style="font-size:0.73rem; padding:0.28rem 0.55rem;">Clear Selection</button>
            </div>
            <form id="form-synthesis" class="qa-row">
              <input id="input-synth-goal" class="text-input" type="text" placeholder="Optional focus (e.g. compare trade-offs)..." />
              <button id="btn-ai-synthesize" type="submit" class="btn btn-primary">Synthesize</button>
            </form>
          </div>

          <div id="ai-live-banner"></div>
          <div id="ai-runs-feed" style="display:flex; flex-direction:column; gap:0.75rem;"></div>
        </div>
      </aside>
    </main>

    <!-- MOBILE BOTTOM NAVIGATION -->
    <nav class="mobile-tabs" aria-label="Mobile workspace sections">
      <button class="mobile-tab-btn" data-tab="vault">Vault</button>
      <button class="mobile-tab-btn active" data-tab="editor">Editor</button>
      <button class="mobile-tab-btn" data-tab="ai">Hybrid AI</button>
    </nav>
  `;
}

// ---------------- UI RENDER UPDATES ----------------

function renderTopStatus() {
  const netEl = document.querySelector('#pill-network');
  netEl.className = `status-pill ${state.online ? 'online' : 'offline'}`;
  netEl.innerHTML = `<span class="dot"></span>${state.online ? 'Online' : 'Offline Mode'}`;

  const nanoEl = document.querySelector('#pill-nano');
  const warmBtn = document.querySelector('#btn-warmup-nano');
  const isNanoReady = state.nanoState === 'available' || state.nanoState === 'readily';
  nanoEl.className = `status-pill ${isNanoReady ? 'ready' : ''}`;

  if (state.nanoDownloadPct !== null) {
    nanoEl.textContent = `Gemini Nano: Downloading ${state.nanoDownloadPct}%`;
    warmBtn.style.display = 'none';
  } else if (isNanoReady) {
    nanoEl.textContent = 'Gemini Nano: Ready On-Device';
    warmBtn.style.display = 'none';
  } else if (state.nanoState === 'downloadable' || state.nanoState === 'after-download') {
    nanoEl.textContent = 'Gemini Nano: Downloadable';
    warmBtn.style.display = 'inline-flex';
  } else {
    nanoEl.textContent = 'Gemini Nano: Cloud Fallback Active';
    warmBtn.style.display = 'none';
  }

  const appCheckEl = document.querySelector('#pill-appcheck');
  appCheckEl.className = `status-pill ${state.appCheckOk ? 'ready' : 'warn'}`;
  appCheckEl.textContent = state.appCheckOk ? 'App Check Verified' : 'App Check Pending';

  const btnPrefer = document.querySelector('#mode-prefer-local');
  const btnOnly = document.querySelector('#mode-only-local');
  const isStrict = state.privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL;

  btnPrefer.className = `mode-btn ${!isStrict ? 'active-hybrid' : ''}`;
  btnOnly.className = `mode-btn ${isStrict ? 'active-private' : ''}`;

  const explainer = document.querySelector('#mode-explainer');
  explainer.innerHTML = isStrict
    ? `<strong style="color:var(--emerald-text);">ONLY_ON_DEVICE active:</strong> Strict privacy lock. Cloud requests are blocked—notes never leave your browser.`
    : `<strong style="color:var(--sky-text);">PREFER_ON_DEVICE active:</strong> Tries local Gemini Nano first for short notes; seamlessly falls back to Cloud when needed.`;

  const authEl = document.querySelector('#auth-controls');
  if (state.user) {
    const label = state.user.isAnonymous
      ? `Guest (${state.user.uid.slice(0, 6)})`
      : state.user.displayName || state.user.email || 'Signed In';
    authEl.innerHTML = `
      <span class="status-pill">${escapeHtml(label)}</span>
      ${
        state.user.isAnonymous
          ? `<button id="btn-google-login" class="btn" style="font-size:0.74rem; padding:0.3rem 0.6rem;">Google Sign-In</button>`
          : `<button id="btn-logout" class="btn" style="font-size:0.74rem; padding:0.3rem 0.6rem;">Sign Out</button>`
      }
    `;
    document.querySelector('#btn-google-login')?.addEventListener('click', async () => {
      try {
        await signInGoogle();
      } catch (err) {
        state.aiErrorMsg = `Google Sign-In error: ${err.message}`;
        renderAIPane();
      }
    });
    document.querySelector('#btn-logout')?.addEventListener('click', async () => {
      await logOutUser();
    });
  } else {
    authEl.innerHTML = `<button id="btn-guest-login" class="btn btn-primary" style="font-size:0.74rem;">Sign In</button>`;
    document.querySelector('#btn-guest-login')?.addEventListener('click', () => signInGuest());
  }
}

function renderVaultList() {
  document.querySelector('#notes-count').textContent = String(state.notes.length);
  document.querySelector('#synth-count').textContent = String(state.selectedForSynthesis.size);

  const listEl = document.querySelector('#notes-list');
  const filtered = getFilteredNotes();

  if (filtered.length === 0) {
    listEl.innerHTML = `<p style="padding:1rem; font-size:0.8rem; color:var(--text-muted); text-align:center;">No matching notes in IndexedDB.</p>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((note) => {
      const isActive = note.id === state.activeNoteId;
      const isChecked = state.selectedForSynthesis.has(note.id);
      return `
        <article class="note-card ${isActive ? 'active' : ''}" data-note-id="${note.id}">
          <div class="note-card-top">
            <div class="note-card-title">${note.pinned ? '📌 ' : ''}${escapeHtml(note.title)}</div>
            <label class="synth-check-label" title="Include in Multi-Note Synthesis">
              <input type="checkbox" class="synth-checkbox" data-synth-id="${note.id}" ${isChecked ? 'checked' : ''} />
              Synth
            </label>
          </div>
          <div class="note-card-preview">${escapeHtml(note.content || 'Empty note...')}</div>
          ${
            note.tags.length
              ? `<div class="tag-row">${note.tags.map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join('')}</div>`
              : ''
          }
          <div class="note-card-meta">
            <span>${note.wordCount || 0} words</span>
            <span>${formatTimeAgo(note.updatedAt)}</span>
          </div>
        </article>
      `;
    })
    .join('');

  listEl.querySelectorAll('.note-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.synth-check-label')) return;
      state.activeNoteId = card.dataset.noteId;
      renderVaultList();
      populateEditorFromActiveNote();
      if (window.innerWidth <= 860) switchMobileTab('editor');
    });
  });

  listEl.querySelectorAll('.synth-checkbox').forEach((box) => {
    box.addEventListener('change', (e) => {
      const id = e.target.dataset.synthId;
      if (e.target.checked) {
        state.selectedForSynthesis.add(id);
      } else {
        state.selectedForSynthesis.delete(id);
      }
      document.querySelector('#synth-count').textContent = String(state.selectedForSynthesis.size);
    });
  });
}

function populateEditorFromActiveNote() {
  const note = getActiveNote();
  const titleEl = document.querySelector('#editor-title');
  const contentEl = document.querySelector('#editor-content');
  const pinBtn = document.querySelector('#btn-pin-note');

  if (!note) {
    titleEl.value = '';
    contentEl.value = '';
    titleEl.disabled = true;
    contentEl.disabled = true;
    renderEditorTags([]);
    updateEditorStats('');
    return;
  }

  titleEl.disabled = false;
  contentEl.disabled = false;
  titleEl.value = note.title;
  contentEl.value = note.content;
  pinBtn.textContent = note.pinned ? 'Unpin' : 'Pin';
  renderEditorTags(note.tags);
  updateEditorStats(note.content);
}

function renderEditorTags(tags = []) {
  const container = document.querySelector('#editor-tags');
  container.innerHTML = tags
    .map(
      (tag) => `
      <span class="tag-chip tag-removable">
        #${escapeHtml(tag)}
        <button class="tag-remove-btn" data-remove-tag="${escapeHtml(tag)}" title="Remove tag">&times;</button>
      </span>
    `
    )
    .join('');

  container.querySelectorAll('[data-remove-tag]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const note = getActiveNote();
      if (!note) return;
      const updated = await saveNote({
        ...note,
        tags: note.tags.filter((t) => t !== btn.dataset.removeTag)
      });
      await refreshNotes(updated.id);
      renderEditorTags(updated.tags);
    });
  });
}

function updateEditorStats(content = '') {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const chars = content.length;
  document.querySelector('#editor-stats').textContent = `${words.toLocaleString()} words · ${chars.toLocaleString()} chars`;

  const hintEl = document.querySelector('#editor-routing-hint');
  if (state.privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL) {
    hintEl.textContent = 'Routing: Locked to On device (ONLY_ON_DEVICE)';
  } else if (chars > ON_DEVICE_CHAR_LIMIT) {
    hintEl.textContent = `Long note (> ${ON_DEVICE_CHAR_LIMIT.toLocaleString()} chars) → Auto-routes to Cloud`;
  } else {
    hintEl.textContent = 'Short note → Tries On device first, Cloud fallback';
  }
}

function renderAIPane() {
  const buttons = document.querySelectorAll(
    '#btn-ai-summarize, #btn-ai-autotag, #btn-ai-rewrite, #btn-ai-qa, #btn-ai-synthesize'
  );
  buttons.forEach((b) => {
    b.disabled = state.aiBusy;
  });

  const bannerEl = document.querySelector('#ai-live-banner');
  if (state.aiBusy) {
    bannerEl.innerHTML = `
      <div class="ai-status-banner">
        <span class="spinner"></span>
        <span>${escapeHtml(state.aiStatusMsg || 'Running Hybrid AI inference...')}</span>
      </div>
    `;
  } else if (state.aiErrorMsg) {
    bannerEl.innerHTML = `
      <div class="ai-status-banner error">
        <span>${escapeHtml(state.aiErrorMsg)}</span>
      </div>
    `;
  } else {
    bannerEl.innerHTML = '';
  }

  const feedEl = document.querySelector('#ai-runs-feed');
  if (state.aiRuns.length === 0) {
    feedEl.innerHTML = `
      <p style="font-size:0.78rem; color:var(--text-muted); text-align:center; padding:1rem 0.5rem;">
        Run Summarize, Auto-Tag, Rewrite, Q&amp;A, or Multi-Note Synthesis. Every response clearly displays whether it ran <strong>On device</strong> or in the <strong>Cloud</strong>.
      </p>
    `;
    return;
  }

  feedEl.innerHTML = state.aiRuns
    .map((run) => {
      const isOnDevice = run.sourceLabel === 'On device';
      const badgeClass = isOnDevice ? 'on-device' : 'cloud';
      return `
        <article class="ai-result-card">
          <div class="ai-result-header">
            <span class="ai-action-name">${escapeHtml(run.action)}</span>
            <span class="provenance-badge ${badgeClass}" title="Execution provenance reported by Firebase AI Logic">
              ${isOnDevice ? '⚡ On device' : '☁️ Cloud'}
            </span>
          </div>
          <div class="markdown-body">${renderSafeMarkdown(run.output)}</div>
          <div class="ai-meta-line">
            <span>Mode: ${escapeHtml(run.modeUsed)}</span>
            <span>${run.latencyMs} ms · ${formatTimeAgo(run.createdAt)}</span>
          </div>
          <div class="result-actions">
            <button class="btn" data-insert-output="${run.id}" style="font-size:0.72rem; padding:0.24rem 0.55rem;">Append to Active Note</button>
            <button class="btn" data-save-new-note="${run.id}" style="font-size:0.72rem; padding:0.24rem 0.55rem;">Save as New Note</button>
          </div>
        </article>
      `;
    })
    .join('');

  feedEl.querySelectorAll('[data-insert-output]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const run = state.aiRuns.find((r) => r.id === btn.dataset.insertOutput);
      const note = getActiveNote();
      if (!run || !note) return;
      const appended = `${note.content.trim()}\n\n---\n### AI ${run.action} (${run.sourceLabel})\n${run.output}`;
      const updated = await saveNote({ ...note, content: appended });
      await refreshNotes(updated.id);
      populateEditorFromActiveNote();
    });
  });

  feedEl.querySelectorAll('[data-save-new-note]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const run = state.aiRuns.find((r) => r.id === btn.dataset.saveNewNote);
      if (!run) return;
      const created = await saveNote({
        title: `${run.action} — ${new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        content: run.output,
        tags: ['ai-synthesis', run.sourceLabel === 'On device' ? 'on-device' : 'cloud']
      });
      await refreshNotes(created.id);
      populateEditorFromActiveNote();
    });
  });
}

function switchMobileTab(tabName) {
  state.mobileTab = tabName;
  document.querySelector('#pane-vault').classList.toggle('mobile-active', tabName === 'vault');
  document.querySelector('#pane-editor').classList.toggle('mobile-active', tabName === 'editor');
  document.querySelector('#pane-ai').classList.toggle('mobile-active', tabName === 'ai');

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
}

// ---------------- DATA HELPERS ----------------

async function refreshNotes(preferredActiveId = null) {
  state.notes = await getAllNotes();
  if (preferredActiveId) {
    state.activeNoteId = preferredActiveId;
  } else if (!state.notes.some((n) => n.id === state.activeNoteId)) {
    state.activeNoteId = state.notes[0]?.id || null;
  }
  renderVaultList();
}

async function runAIAction(statusMessage, fn) {
  state.aiBusy = true;
  state.aiErrorMsg = '';
  state.aiStatusMsg = statusMessage;
  renderAIPane();
  if (window.innerWidth <= 860) switchMobileTab('ai');

  try {
    await fn();
    state.aiRuns = await getRecentAIRuns(25);
  } catch (err) {
    state.aiErrorMsg = err.message || 'AI request failed.';
  } finally {
    state.aiBusy = false;
    state.aiStatusMsg = '';
    renderAIPane();
  }
}

// ---------------- EVENT BINDINGS ----------------

function bindEvents() {
  window.addEventListener('online', () => {
    state.online = true;
    renderTopStatus();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    renderTopStatus();
  });

  document.querySelector('#mode-prefer-local').addEventListener('click', async () => {
    state.privacyMode = USER_PRIVACY_MODES.HYBRID_DEFAULT;
    await setSetting('privacyMode', state.privacyMode);
    state.aiErrorMsg = '';
    renderTopStatus();
    updateEditorStats(document.querySelector('#editor-content').value);
    renderAIPane();
  });

  document.querySelector('#mode-only-local').addEventListener('click', async () => {
    state.privacyMode = USER_PRIVACY_MODES.STRICT_LOCAL;
    await setSetting('privacyMode', state.privacyMode);
    state.aiErrorMsg = '';
    renderTopStatus();
    updateEditorStats(document.querySelector('#editor-content').value);
    renderAIPane();
  });

  document.querySelector('#btn-warmup-nano').addEventListener('click', async () => {
    try {
      state.nanoDownloadPct = 0;
      renderTopStatus();
      const res = await warmUpOnDeviceModel((pct) => {
        state.nanoDownloadPct = pct;
        renderTopStatus();
      });
      state.nanoDownloadPct = null;
      state.nanoState = res.state;
      renderTopStatus();
    } catch (err) {
      state.nanoDownloadPct = null;
      state.aiErrorMsg = err.message;
      renderTopStatus();
      renderAIPane();
    }
  });

  document.querySelector('#btn-new-note').addEventListener('click', async () => {
    const created = await saveNote({
      title: 'Untitled Research Note',
      content: '',
      tags: []
    });
    await refreshNotes(created.id);
    populateEditorFromActiveNote();
    document.querySelector('#editor-title').focus();
    document.querySelector('#editor-title').select();
    if (window.innerWidth <= 860) switchMobileTab('editor');
  });

  document.querySelector('#input-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderVaultList();
  });

  const scheduleAutoSave = () => {
    const note = getActiveNote();
    if (!note) return;
    const title = document.querySelector('#editor-title').value;
    const content = document.querySelector('#editor-content').value;
    updateEditorStats(content);

    const saveEl = document.querySelector('#save-indicator');
    saveEl.textContent = 'Saving to IndexedDB...';

    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
      await saveNote({ ...note, title, content });
      await refreshNotes(note.id);
      saveEl.textContent = 'Saved offline in IndexedDB';
    }, 280);
  };

  document.querySelector('#editor-title').addEventListener('input', scheduleAutoSave);
  document.querySelector('#editor-content').addEventListener('input', scheduleAutoSave);

  document.querySelector('#input-add-tag').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = e.target.value.trim().toLowerCase().replace(/[^a-z0-9-\s]/g, '').replace(/\s+/g, '-');
    const note = getActiveNote();
    if (!raw || !note) return;
    e.target.value = '';
    const updated = await saveNote({ ...note, tags: [...note.tags, raw] });
    await refreshNotes(updated.id);
    renderEditorTags(updated.tags);
  });

  document.querySelector('#btn-pin-note').addEventListener('click', async () => {
    const note = getActiveNote();
    if (!note) return;
    const updated = await saveNote({ ...note, pinned: !note.pinned });
    await refreshNotes(updated.id);
    populateEditorFromActiveNote();
  });

  document.querySelector('#btn-export-md').addEventListener('click', () => {
    const note = getActiveNote();
    if (!note) return;
    const md = `# ${note.title}\n\nTags: ${note.tags.map((t) => `#${t}`).join(' ')}\n\n${note.content}\n`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${note.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'note'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.querySelector('#btn-delete-note').addEventListener('click', async () => {
    const note = getActiveNote();
    if (!note) return;
    if (!confirm(`Delete "${note.title}" from offline storage?`)) return;
    state.selectedForSynthesis.delete(note.id);
    await deleteNote(note.id);
    await refreshNotes();
    populateEditorFromActiveNote();
  });

  // AI Actions
  document.querySelector('#btn-ai-summarize').addEventListener('click', () => {
    const note = getActiveNote();
    if (!note?.content.trim()) {
      state.aiErrorMsg = 'Write or select a note with content before summarizing.';
      renderAIPane();
      return;
    }
    runAIAction('Summarizing note via Hybrid AI...', () => summarizeNote(note, state.privacyMode));
  });

  document.querySelector('#btn-ai-autotag').addEventListener('click', () => {
    const note = getActiveNote();
    if (!note?.content.trim()) {
      state.aiErrorMsg = 'Write or select a note with content before auto-tagging.';
      renderAIPane();
      return;
    }
    runAIAction('Extracting tags via Hybrid AI...', async () => {
      const res = await generateTagsForNote(note, state.privacyMode);
      if (res.parsedTags.length > 0) {
        const updated = await saveNote({
          ...note,
          tags: [...note.tags, ...res.parsedTags]
        });
        await refreshNotes(updated.id);
        renderEditorTags(updated.tags);
      }
    });
  });

  document.querySelector('#btn-ai-rewrite').addEventListener('click', () => {
    const note = getActiveNote();
    if (!note?.content.trim()) {
      state.aiErrorMsg = 'Write or select a note with content before rewriting.';
      renderAIPane();
      return;
    }
    const style = document.querySelector('#select-rewrite-style').value;
    runAIAction(`Rewriting note (${style})...`, () => rewriteNote(note, style, state.privacyMode));
  });

  document.querySelector('#form-note-qa').addEventListener('submit', (e) => {
    e.preventDefault();
    const note = getActiveNote();
    const inputEl = document.querySelector('#input-qa');
    const question = inputEl.value.trim();
    if (!note?.content.trim() || !question) return;
    inputEl.value = '';
    runAIAction('Answering question on active note...', () =>
      askNoteQuestion(note, question, state.privacyMode)
    );
  });

  document.querySelector('#btn-select-all-synth').addEventListener('click', () => {
    state.notes.forEach((n) => state.selectedForSynthesis.add(n.id));
    renderVaultList();
  });

  document.querySelector('#btn-clear-synth').addEventListener('click', () => {
    state.selectedForSynthesis.clear();
    renderVaultList();
  });

  document.querySelector('#form-synthesis').addEventListener('submit', (e) => {
    e.preventDefault();
    const selectedNotes = state.notes.filter((n) => state.selectedForSynthesis.has(n.id));
    if (selectedNotes.length < 2) {
      state.aiErrorMsg = 'Tick at least 2 notes in the Vault (or click "Select All Notes") to run Multi-Note Synthesis.';
      renderAIPane();
      return;
    }
    const goalEl = document.querySelector('#input-synth-goal');
    const goal = goalEl.value.trim();
    goalEl.value = '';
    runAIAction(`Synthesizing ${selectedNotes.length} notes...`, () =>
      synthesizeMultipleNotes(selectedNotes, goal, state.privacyMode)
    );
  });

  document.querySelector('#btn-clear-runs').addEventListener('click', async () => {
    await clearAIRuns();
    state.aiRuns = [];
    state.aiErrorMsg = '';
    renderAIPane();
  });

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchMobileTab(btn.dataset.tab));
  });
}

// ---------------- BOOTSTRAP ----------------

async function init() {
  mountShell();
  bindEvents();

  const savedMode = await getSetting('privacyMode', USER_PRIVACY_MODES.HYBRID_DEFAULT);
  state.privacyMode = savedMode;

  state.notes = await ensureStarterNotes();
  state.activeNoteId = state.notes[0]?.id || null;
  state.aiRuns = await getRecentAIRuns(25);

  renderTopStatus();
  renderVaultList();
  populateEditorFromActiveNote();
  renderAIPane();

  // Check Chrome Gemini Nano & App Check asynchronously without blocking offline render
  checkOnDeviceModelStatus().then((res) => {
    state.nanoState = res.state;
    renderTopStatus();
  });

  verifyAppCheckStatus().then((res) => {
    state.appCheckOk = res.ok;
    renderTopStatus();
  });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      state.user = user;
      renderTopStatus();
    } else if (navigator.onLine) {
      try {
        await signInGuest();
      } catch {
        renderTopStatus();
      }
    } else {
      renderTopStatus();
    }
  });
}

init();
