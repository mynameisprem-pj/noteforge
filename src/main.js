import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  auth,
  signInGuest,
  signInGoogle,
  logOutUser,
  onIdTokenChanged,
  verifyAppCheckStatus,
  checkOnDeviceModelStatus,
  warmUpOnDeviceModel
} from './firebase.js';
import {
  GUEST_WORKSPACE_ID,
  setActiveWorkspace,
  setCloudSyncAllowed,
  syncCloudWorkspace,
  syncGuestToAuthenticatedWorkspace,
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
  summarizeNote,
  generateTagsForNote,
  rewriteNote,
  askNoteQuestion,
  synthesizeMultipleNotes
} from './ai-service.js';

marked.setOptions({ breaks: true, gfm: true });

const ICONS = {
  append: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  saveNote: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
};

let toastTimer = null;
function showToast(message) {
  const el = document.querySelector('#app-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, 2600);
}

function flashButtonDone(btn, doneLabel) {
  if (!btn || btn.dataset.flashing === '1') return;
  const originalHtml = btn.innerHTML;
  btn.dataset.flashing = '1';
  btn.classList.add('btn-done');
  btn.innerHTML = `${ICONS.check}<span>${doneLabel}</span>`;

  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.classList.remove('btn-done');
    btn.innerHTML = originalHtml;
    delete btn.dataset.flashing;
  }, 1800);
}

function renderSafeMarkdown(mdText = '') {
  return DOMPurify.sanitize(marked.parse(mdText));
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
  authBusy: false,
  mobileTab: 'editor',
  openPopover: null
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

function autoResizeTitle(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

const appEl = document.querySelector('#app');

function mountShell() {
  appEl.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand-logo" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <span class="brand-title">NoteForge</span>
        <span class="brand-tag">Offline-First Hybrid AI</span>
      </div>

      <div class="topbar-right">
        <div class="mode-switch" role="group" aria-label="AI Inference Mode">
          <button id="mode-prefer-local" class="mode-btn" title="PREFER_ON_DEVICE: Try Gemini Nano locally first, fall back to Cloud">
            Hybrid
          </button>
          <button id="mode-only-local" class="mode-btn" title="ONLY_ON_DEVICE: Strict Privacy Lock — never send notes to Cloud">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            Local Only
          </button>
        </div>

        <div class="popover-wrap">
          <button id="btn-telemetry" class="icon-pill-btn" aria-label="System & AI Status">
            <span id="top-status-dot" class="status-dot"></span>
            <span id="top-status-label" class="status-label-text">Ready</span>
          </button>
          <div id="popover-telemetry" class="popover-card"></div>
        </div>

        <div class="popover-wrap">
          <button id="btn-account" class="account-pill-btn guest-mode" aria-label="Account Menu">Sign in</button>
          <div id="popover-account" class="popover-card" style="width:255px;"></div>
        </div>
      </div>
    </header>

    <main class="workspace">
      <!-- PANE 1: NOTES -->
      <aside id="pane-notes" class="pane">
        <div class="pane-header">
          <div class="pane-title-row">
            <span class="pane-title">Notes (<span id="notes-count">0</span>)</span>
            <button id="btn-new-note" class="btn btn-primary" style="padding:0.3rem 0.62rem; font-size:0.75rem;">+ New</button>
          </div>
          <input id="input-search" class="search-input" type="search" placeholder="Search notes or #tags..." />
        </div>
        <div id="notes-list" class="notes-list"></div>
      </aside>

      <!-- PANE 2: EDITOR -->
      <section id="pane-editor" class="pane editor-pane mobile-active">
        <div class="editor-toolbar">
          <span id="save-indicator" class="save-indicator">Saved offline</span>
          <div style="display:flex; gap:0.38rem; align-items:center;">
            <button id="btn-pin-note" class="btn" style="font-size:0.73rem; padding:0.28rem 0.58rem;">Pin</button>
            <button id="btn-export-md" class="btn" style="font-size:0.73rem; padding:0.28rem 0.58rem;">.md</button>
            <button id="btn-delete-note" class="btn btn-ghost-danger" style="font-size:0.73rem; padding:0.28rem 0.58rem;">Delete</button>
          </div>
        </div>

        <div class="editor-body">
          <textarea id="editor-title" class="title-textarea" rows="1" placeholder="Untitled note..."></textarea>
          <div class="tags-editor-row">
            <div id="editor-tags" class="tag-row"></div>
            <input id="input-add-tag" class="tag-input" type="text" placeholder="+ add tag" />
          </div>
          <textarea id="editor-content" class="content-textarea" placeholder="Capture research notes, field interviews, or drafts... Saved automatically to IndexedDB for instant offline access."></textarea>
          <div class="editor-footer">
            <span id="editor-stats">0 words · 0 chars</span>
            <span id="workspace-scope-label">Local Guest Workspace</span>
          </div>
        </div>
      </section>

      <!-- PANE 3: HYBRID AI COMPANION -->
      <aside id="pane-ai" class="pane ai-pane">
        <div class="pane-header">
          <div class="pane-title-row">
            <span class="pane-title">Hybrid AI Companion</span>
            <button id="btn-clear-runs" class="btn" style="font-size:0.69rem; padding:0.2rem 0.48rem;">Clear</button>
          </div>
          <div id="mode-explainer" style="font-size:0.73rem; color:var(--text-muted); line-height:1.38;"></div>
        </div>

        <div class="ai-scroll">
          <div class="action-card">
            <div class="action-card-label">
              <span>Note Actions</span>
              <span style="font-weight:500; text-transform:none;">On-device first</span>
            </div>
            <div class="action-grid">
              <button id="btn-ai-summarize" class="btn">Summarize</button>
              <button id="btn-ai-autotag" class="btn">Auto-Tag</button>
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
              <input id="input-qa" class="text-input" type="text" placeholder="Ask about this note..." />
              <button id="btn-ai-qa" type="submit" class="btn btn-primary">Ask</button>
            </form>
          </div>

          <div class="action-card">
            <div class="action-card-label">
              <span>Multi-Note Synthesis (<span id="synth-count">0</span>)</span>
              <span style="font-weight:500; text-transform:none; color:var(--sky-text);">Cloud</span>
            </div>
            <div style="display:flex; gap:0.38rem;">
              <button id="btn-select-all-synth" type="button" class="btn" style="flex:1; font-size:0.72rem; padding:0.26rem 0.5rem;">Select All</button>
              <button id="btn-clear-synth" type="button" class="btn" style="flex:1; font-size:0.72rem; padding:0.26rem 0.5rem;">Clear</button>
            </div>
            <form id="form-synthesis" class="qa-row">
              <input id="input-synth-goal" class="text-input" type="text" placeholder="Focus (optional)..." />
              <button id="btn-ai-synthesize" type="submit" class="btn btn-primary">Synthesize</button>
            </form>
          </div>

          <div id="ai-live-banner"></div>
          <div id="ai-runs-feed" style="display:flex; flex-direction:column; gap:0.65rem;"></div>
        </div>
      </aside>
    </main>

    <nav class="mobile-tabs" aria-label="Workspace navigation">
      <button class="mobile-tab-btn" data-tab="notes">
        <span id="mobile-notes-badge" class="tab-badge">0</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <span>Notes</span>
      </button>
      <button class="mobile-tab-btn active" data-tab="editor">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        <span>Editor</span>
      </button>
      <button class="mobile-tab-btn" data-tab="ai">
        <span id="mobile-ai-badge" class="tab-badge">0</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>
        <span>Hybrid AI</span>
      </button>
    </nav>

    <div id="app-toast" class="toast-banner" role="status" aria-live="polite"></div>
  `;
}

async function applyWorkspaceForUser(user) {
  state.user = user;
  const isGoogleUser = Boolean(user && !user.isAnonymous);

  // 1. Update navbar account pill IMMEDIATELY (zero wait on network sync)
  renderTopStatus();

  if (isGoogleUser) {
    setActiveWorkspace(user.uid);
    await syncGuestToAuthenticatedWorkspace(user.uid);
    state.notes = await ensureStarterNotes(user.uid);
    state.aiRuns = await getRecentAIRuns(25, user.uid);
  } else {
    setActiveWorkspace(GUEST_WORKSPACE_ID);
    state.notes = await ensureStarterNotes(GUEST_WORKSPACE_ID);
    state.aiRuns = await getRecentAIRuns(25, GUEST_WORKSPACE_ID);
  }

  state.selectedForSynthesis.clear();
  state.activeNoteId = state.notes[0]?.id || null;

  renderTopStatus();
  renderNotesList();
  populateEditorFromActiveNote();
  renderAIPane();
}

function renderTopStatus() {
  const dotEl = document.querySelector('#top-status-dot');
  const labelEl = document.querySelector('#top-status-label');
  dotEl.className = `status-dot ${state.online ? '' : 'offline'}`;
  labelEl.textContent = state.online ? 'Ready' : 'Offline';

  const isStrict = state.privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL;
  document.querySelector('#mode-prefer-local').className = `mode-btn ${!isStrict ? 'active-hybrid' : ''}`;
  document.querySelector('#mode-only-local').className = `mode-btn ${isStrict ? 'active-private' : ''}`;

  document.querySelector('#mode-explainer').innerHTML = isStrict
    ? `<strong style="color:var(--emerald-text);">ONLY_ON_DEVICE:</strong> Strict privacy lock. Cloud AI &amp; sync are paused.`
    : `<strong style="color:var(--sky-text);">PREFER_ON_DEVICE:</strong> Tries local Gemini Nano first; falls back to Cloud seamlessly.`;

  const isGoogleUser = Boolean(state.user && !state.user.isAnonymous);
  const scopeEl = document.querySelector('#workspace-scope-label');
  if (scopeEl) {
    scopeEl.textContent = isGoogleUser
      ? `Synced Workspace (${state.user.email || state.user.displayName || 'Google'})`
      : 'Guest Workspace (Local Only)';
  }

  // Telemetry Popover
  const isNanoReady = state.nanoState === 'available' || state.nanoState === 'readily';
  const canDownloadNano = state.nanoState === 'downloadable' || state.nanoState === 'after-download';
  const onDeviceCount = state.aiRuns.filter((r) => r.sourceLabel === 'On device').length;
  const cloudCount = state.aiRuns.filter((r) => r.sourceLabel === 'Cloud').length;

  let nanoText = 'Cloud Fallback Active';
  if (state.nanoDownloadPct !== null) nanoText = `Downloading (${state.nanoDownloadPct}%)`;
  else if (isNanoReady) nanoText = 'Ready On-Device';
  else if (canDownloadNano) nanoText = 'Downloadable';

  const telemetryPop = document.querySelector('#popover-telemetry');
  telemetryPop.classList.toggle('open', state.openPopover === 'telemetry');
  telemetryPop.innerHTML = `
    <div class="popover-title">Hybrid Runtime Diagnostics</div>
    <div class="telemetry-row">
      <span>Network</span>
      <span class="telemetry-val ${state.online ? 'ok' : 'warn'}">${state.online ? 'Online' : 'Offline (IndexedDB)'}</span>
    </div>
    <div class="telemetry-row">
      <span>Inference Policy</span>
      <span class="telemetry-val info">${escapeHtml(state.privacyMode)}</span>
    </div>
    <div class="telemetry-row">
      <span>Gemini Nano</span>
      <span class="telemetry-val ${isNanoReady ? 'ok' : 'info'}">${escapeHtml(nanoText)}</span>
    </div>
    <div class="telemetry-row">
      <span>Firebase App Check</span>
      <span class="telemetry-val ${state.appCheckOk ? 'ok' : 'warn'}">${state.appCheckOk ? 'Verified' : 'Pending'}</span>
    </div>
    <div class="telemetry-row">
      <span>Provenance Ledger</span>
      <span class="telemetry-val">${onDeviceCount} Local · ${cloudCount} Cloud</span>
    </div>
    ${
      canDownloadNano
        ? `<button id="btn-warmup-nano" class="btn btn-primary" style="width:100%; margin-top:0.25rem;">Download Local Gemini Nano</button>`
        : ''
    }
  `;

  document.querySelector('#btn-warmup-nano')?.addEventListener('click', async () => {
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

  // Account Pill & Popover — Clear Signed-In vs Guest Distinction
  const accBtn = document.querySelector('#btn-account');
  const accPop = document.querySelector('#popover-account');
  accPop.classList.toggle('open', state.openPopover === 'account');

  if (state.authBusy) {
    accBtn.className = 'account-pill-btn guest-mode';
    accBtn.innerHTML = `<span>Syncing...</span>`;
  } else if (isGoogleUser) {
    const firstName = (state.user.displayName || state.user.email || 'Account').split(' ')[0];
    const initial = firstName[0].toUpperCase();
    const avatarInner = state.user.photoURL
      ? `<img src="${escapeHtml(state.user.photoURL)}" alt="" referrerpolicy="no-referrer" />`
      : escapeHtml(initial);

    accBtn.className = 'account-pill-btn';
    accBtn.innerHTML = `
      <span class="account-avatar-mini">${avatarInner}</span>
      <span class="account-name-text">${escapeHtml(firstName)}</span>
    `;
  } else {
    accBtn.className = 'account-pill-btn guest-mode';
    accBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      <span>Sign in</span>
    `;
  }

  if (isGoogleUser) {
    accPop.innerHTML = `
      <div class="popover-title">Signed In with Google</div>
      <div style="font-size:0.84rem; font-weight:600;">${escapeHtml(state.user.displayName || 'Google Account')}</div>
      <div style="font-size:0.72rem; color:var(--text-muted); margin-top:-0.35rem; word-break:break-all;">${escapeHtml(state.user.email || '')}</div>
      <div style="font-size:0.71rem; color:var(--emerald-text);">✓ Cross-browser cloud sync active</div>
      <button id="btn-logout" class="btn btn-ghost-danger" style="width:100%; margin-top:0.2rem;">Sign Out</button>
    `;

    document.querySelector('#btn-logout')?.addEventListener('click', async () => {
      state.openPopover = null;
      state.authBusy = true;
      renderTopStatus();
      await logOutUser();
      state.authBusy = false;
      await applyWorkspaceForUser(null);
      showToast('Signed out · Switched to local Guest mode');
      if (navigator.onLine) {
        signInGuest().catch(() => {});
      }
    });
  } else {
    accPop.innerHTML = `
      <div class="popover-title">Guest Mode (Local Only)</div>
      <div style="font-size:0.75rem; color:var(--text-muted); line-height:1.45;">
        Notes are currently saved only in this browser. Sign in with Google to sync notes across devices.
      </div>
      <button id="btn-google-login" class="btn btn-primary" style="width:100%; margin-top:0.2rem;">Continue with Google</button>
    `;

    document.querySelector('#btn-google-login')?.addEventListener('click', async () => {
      state.openPopover = null;
      state.authBusy = true;
      renderTopStatus();
      try {
        const cred = await signInGoogle();
        state.authBusy = false;
        await applyWorkspaceForUser(cred.user);
        const name = cred.user.displayName || cred.user.email || 'Google Account';
        showToast(`Signed in as ${name}`);
      } catch (err) {
        state.authBusy = false;
        renderTopStatus();
        if (err?.code !== 'auth/popup-closed-by-user') {
          state.aiErrorMsg = `Sign-In failed: ${err.message}`;
          renderAIPane();
        }
      }
    });
  }
}

function renderNotesList() {
  const countStr = String(state.notes.length);
  document.querySelector('#notes-count').textContent = countStr;
  document.querySelector('#mobile-notes-badge').textContent = countStr;
  document.querySelector('#synth-count').textContent = String(state.selectedForSynthesis.size);

  const listEl = document.querySelector('#notes-list');
  const filtered = getFilteredNotes();

  if (filtered.length === 0) {
    listEl.innerHTML = `<p style="padding:1rem; font-size:0.78rem; color:var(--text-muted); text-align:center;">No matching notes.</p>`;
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
            <label class="synth-check-label" title="Select for Multi-Note Synthesis">
              <input type="checkbox" class="synth-checkbox" data-synth-id="${note.id}" ${isChecked ? 'checked' : ''} />
              Synth
            </label>
          </div>
          <div class="note-card-preview">${escapeHtml(note.content || 'Empty note...')}</div>
          ${
            note.tags.length
              ? `<div class="tag-row">${note.tags.slice(0, 3).map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join('')}</div>`
              : ''
          }
          <div class="note-card-meta">
            <span>${note.wordCount || 0}w</span>
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
      renderNotesList();
      populateEditorFromActiveNote();
      if (window.innerWidth <= 880) switchMobileTab('editor');
    });
  });

  listEl.querySelectorAll('.synth-checkbox').forEach((box) => {
    box.addEventListener('change', (e) => {
      const id = e.target.dataset.synthId;
      if (e.target.checked) state.selectedForSynthesis.add(id);
      else state.selectedForSynthesis.delete(id);
      document.querySelector('#synth-count').textContent = String(state.selectedForSynthesis.size);
    });
  });
}

function populateEditorFromActiveNote() {
  const note = getActiveNote();
  const titleEl = document.querySelector('#editor-title');
  const contentEl = document.querySelector('#editor-content');
  const pinBtn = document.querySelector('#btn-pin-note');
  const saveEl = document.querySelector('#save-indicator');

  const isCloudSynced =
    Boolean(state.user && !state.user.isAnonymous) &&
    state.privacyMode !== USER_PRIVACY_MODES.STRICT_LOCAL &&
    state.online;
  saveEl.textContent = isCloudSynced ? 'Saved · Cloud synced' : 'Saved offline';

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
  autoResizeTitle(titleEl);
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
}

function renderAIPane() {
  document.querySelector('#mobile-ai-badge').textContent = String(state.aiRuns.length);

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
        <span>${escapeHtml(state.aiStatusMsg || 'Running Hybrid AI...')}</span>
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
      <p style="font-size:0.76rem; color:var(--text-dim); text-align:center; padding:0.85rem 0.5rem; line-height:1.5;">
        Every AI response displays a verified <strong>On device</strong> or <strong>Cloud</strong> provenance badge.
      </p>
    `;
    return;
  }

  feedEl.innerHTML = state.aiRuns
    .map((run) => {
      const isOnDevice = run.sourceLabel === 'On device';
      return `
        <article class="ai-result-card">
          <div class="ai-result-header">
            <span class="ai-action-name">${escapeHtml(run.action)}</span>
            <span class="provenance-badge ${isOnDevice ? 'on-device' : 'cloud'}">
              ${isOnDevice ? '⚡ On device' : '☁️ Cloud'}
            </span>
          </div>
          <div class="markdown-body">${renderSafeMarkdown(run.output)}</div>
          <div class="ai-meta-line">
            <span>${escapeHtml(run.modeUsed)}</span>
            <span>${run.latencyMs} ms · ${formatTimeAgo(run.createdAt)}</span>
          </div>
          <div class="result-actions">
            <button class="btn" data-insert-output="${run.id}" style="font-size:0.7rem; padding:0.24rem 0.55rem;">
              ${ICONS.append}<span>Append to Note</span>
            </button>
            <button class="btn" data-save-new-note="${run.id}" style="font-size:0.7rem; padding:0.24rem 0.55rem;">
              ${ICONS.saveNote}<span>Save as Note</span>
            </button>
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
      flashButtonDone(btn, 'Appended');
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
      flashButtonDone(btn, 'Saved');
    });
  });
}

function switchMobileTab(tabName) {
  state.mobileTab = tabName;
  document.querySelector('#pane-notes').classList.toggle('mobile-active', tabName === 'notes');
  document.querySelector('#pane-editor').classList.toggle('mobile-active', tabName === 'editor');
  document.querySelector('#pane-ai').classList.toggle('mobile-active', tabName === 'ai');

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  if (tabName === 'editor') {
    autoResizeTitle(document.querySelector('#editor-title'));
  }
}

async function refreshNotes(preferredActiveId = null) {
  state.notes = await getAllNotes();
  if (preferredActiveId) {
    state.activeNoteId = preferredActiveId;
  } else if (!state.notes.some((n) => n.id === state.activeNoteId)) {
    state.activeNoteId = state.notes[0]?.id || null;
  }
  renderNotesList();
}

async function runAIAction(statusMessage, fn) {
  state.aiBusy = true;
  state.aiErrorMsg = '';
  state.aiStatusMsg = statusMessage;
  renderAIPane();
  if (window.innerWidth <= 880) switchMobileTab('ai');

  try {
    await fn();
    state.aiRuns = await getRecentAIRuns(25);
  } catch (err) {
    state.aiErrorMsg = err.message || 'AI request failed.';
  } finally {
    state.aiBusy = false;
    state.aiStatusMsg = '';
    renderTopStatus();
    renderAIPane();
  }
}

function bindEvents() {
  window.addEventListener('online', async () => {
    state.online = true;
    renderTopStatus();
    if (state.user && !state.user.isAnonymous && state.privacyMode !== USER_PRIVACY_MODES.STRICT_LOCAL) {
      await syncCloudWorkspace(state.user.uid);
      await refreshNotes(state.activeNoteId);
      populateEditorFromActiveNote();
    }
  });

  window.addEventListener('offline', () => {
    state.online = false;
    renderTopStatus();
  });

  document.querySelector('#btn-telemetry').addEventListener('click', (e) => {
    e.stopPropagation();
    state.openPopover = state.openPopover === 'telemetry' ? null : 'telemetry';
    renderTopStatus();
  });

  document.querySelector('#btn-account').addEventListener('click', (e) => {
    e.stopPropagation();
    state.openPopover = state.openPopover === 'account' ? null : 'account';
    renderTopStatus();
  });

  document.addEventListener('click', (e) => {
    if (state.openPopover && !e.target.closest('.popover-wrap')) {
      state.openPopover = null;
      renderTopStatus();
    }
  });

  document.querySelector('#mode-prefer-local').addEventListener('click', async () => {
    state.privacyMode = USER_PRIVACY_MODES.HYBRID_DEFAULT;
    setCloudSyncAllowed(true);
    await setSetting('privacyMode', state.privacyMode);
    state.aiErrorMsg = '';
    renderTopStatus();
    populateEditorFromActiveNote();
    renderAIPane();
    if (state.user && !state.user.isAnonymous) {
      syncCloudWorkspace(state.user.uid);
    }
  });

  document.querySelector('#mode-only-local').addEventListener('click', async () => {
    state.privacyMode = USER_PRIVACY_MODES.STRICT_LOCAL;
    setCloudSyncAllowed(false);
    await setSetting('privacyMode', state.privacyMode);
    state.aiErrorMsg = '';
    renderTopStatus();
    populateEditorFromActiveNote();
    renderAIPane();
  });

  document.querySelector('#btn-new-note').addEventListener('click', async () => {
    const created = await saveNote({
      title: 'Untitled Research Note',
      content: '',
      tags: []
    });
    await refreshNotes(created.id);
    populateEditorFromActiveNote();
    const titleEl = document.querySelector('#editor-title');
    if (window.innerWidth <= 880) switchMobileTab('editor');
    titleEl.focus();
    titleEl.select();
  });

  document.querySelector('#input-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderNotesList();
  });

  const scheduleAutoSave = () => {
    const note = getActiveNote();
    if (!note) return;
    const titleEl = document.querySelector('#editor-title');
    autoResizeTitle(titleEl);
    const title = titleEl.value.replace(/\n/g, ' ');
    const content = document.querySelector('#editor-content').value;
    updateEditorStats(content);

    const saveEl = document.querySelector('#save-indicator');
    saveEl.textContent = 'Saving...';

    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
      await saveNote({ ...note, title, content });
      await refreshNotes(note.id);
      saveEl.textContent =
        state.user && !state.user.isAnonymous && state.privacyMode !== USER_PRIVACY_MODES.STRICT_LOCAL && state.online
          ? 'Saved · Cloud synced'
          : 'Saved offline';
    }, 280);
  };

  document.querySelector('#editor-title').addEventListener('input', scheduleAutoSave);
  document.querySelector('#editor-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.querySelector('#editor-content').focus();
    }
  });
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
    if (!confirm(`Delete "${note.title}"?`)) return;
    state.selectedForSynthesis.delete(note.id);
    await deleteNote(note.id);
    await refreshNotes();
    populateEditorFromActiveNote();
    showToast('Note deleted');
  });

  document.querySelector('#btn-ai-summarize').addEventListener('click', () => {
    const note = getActiveNote();
    if (!note?.content.trim()) {
      state.aiErrorMsg = 'Select or write a note before summarizing.';
      renderAIPane();
      return;
    }
    runAIAction('Summarizing note...', () => summarizeNote(note, state.privacyMode));
  });

  document.querySelector('#btn-ai-autotag').addEventListener('click', () => {
    const note = getActiveNote();
    if (!note?.content.trim()) {
      state.aiErrorMsg = 'Select or write a note before auto-tagging.';
      renderAIPane();
      return;
    }
    runAIAction('Extracting tags...', async () => {
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
      state.aiErrorMsg = 'Select or write a note before rewriting.';
      renderAIPane();
      return;
    }
    const style = document.querySelector('#select-rewrite-style').value;
    runAIAction(`Rewriting (${style})...`, () => rewriteNote(note, style, state.privacyMode));
  });

  document.querySelector('#form-note-qa').addEventListener('submit', (e) => {
    e.preventDefault();
    const note = getActiveNote();
    const inputEl = document.querySelector('#input-qa');
    const question = inputEl.value.trim();
    if (!note?.content.trim() || !question) return;
    inputEl.value = '';
    runAIAction('Answering question...', () => askNoteQuestion(note, question, state.privacyMode));
  });

  document.querySelector('#btn-select-all-synth').addEventListener('click', () => {
    state.notes.forEach((n) => state.selectedForSynthesis.add(n.id));
    renderNotesList();
  });

  document.querySelector('#btn-clear-synth').addEventListener('click', () => {
    state.selectedForSynthesis.clear();
    renderNotesList();
  });

  document.querySelector('#form-synthesis').addEventListener('submit', (e) => {
    e.preventDefault();
    const selectedNotes = state.notes.filter((n) => state.selectedForSynthesis.has(n.id));
    if (selectedNotes.length < 2) {
      state.aiErrorMsg = 'Select at least 2 notes in the Notes list first.';
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
    renderTopStatus();
    renderAIPane();
  });

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchMobileTab(btn.dataset.tab));
  });

  window.addEventListener('resize', () => {
    autoResizeTitle(document.querySelector('#editor-title'));
  });
}

async function init() {
  mountShell();
  bindEvents();

  state.privacyMode = await getSetting('privacyMode', USER_PRIVACY_MODES.HYBRID_DEFAULT);
  setCloudSyncAllowed(state.privacyMode !== USER_PRIVACY_MODES.STRICT_LOCAL);

  state.notes = await ensureStarterNotes();
  state.activeNoteId = state.notes[0]?.id || null;
  state.aiRuns = await getRecentAIRuns(25);

  renderTopStatus();
  renderNotesList();
  populateEditorFromActiveNote();
  renderAIPane();

  checkOnDeviceModelStatus().then((res) => {
    state.nanoState = res.state;
    renderTopStatus();
  });

  verifyAppCheckStatus().then((res) => {
    state.appCheckOk = res.ok;
    renderTopStatus();
  });

  onIdTokenChanged(auth, async (user) => {
    if (state.authBusy) return; // Handled directly by Sign-In / Sign-Out click handlers
    if (user) {
      await applyWorkspaceForUser(user);
    } else if (navigator.onLine) {
      try {
        await signInGuest();
      } catch {
        await applyWorkspaceForUser(null);
      }
    } else {
      await applyWorkspaceForUser(null);
    }
  });
}

init();
