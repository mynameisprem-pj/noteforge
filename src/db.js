import { openDB } from 'idb';

const DB_NAME = 'noteforge-vault-db';
const DB_VERSION = 2;

export const GUEST_WORKSPACE_ID = 'guest';

let activeWorkspaceId = GUEST_WORKSPACE_ID;

export function setActiveWorkspace(workspaceId) {
  activeWorkspaceId = workspaceId || GUEST_WORKSPACE_ID;
}

export function getActiveWorkspace() {
  return activeWorkspaceId;
}

function countWords(text = '') {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export const dbPromise = openDB(DB_NAME, DB_VERSION, {
  async upgrade(db, oldVersion, _newVersion, transaction) {
    if (!db.objectStoreNames.contains('notes')) {
      const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
      notesStore.createIndex('by-updated', 'updatedAt');
      notesStore.createIndex('by-owner', 'ownerId');
    } else if (oldVersion < 2) {
      const notesStore = transaction.objectStore('notes');
      if (!notesStore.indexNames.contains('by-owner')) {
        notesStore.createIndex('by-owner', 'ownerId');
      }
      let cursor = await notesStore.openCursor();
      while (cursor) {
        if (!cursor.value.ownerId) {
          await cursor.update({ ...cursor.value, ownerId: GUEST_WORKSPACE_ID });
        }
        cursor = await cursor.continue();
      }
    }

    if (!db.objectStoreNames.contains('ai_runs')) {
      const runsStore = db.createObjectStore('ai_runs', { keyPath: 'id' });
      runsStore.createIndex('by-created', 'createdAt');
      runsStore.createIndex('by-note', 'noteId');
      runsStore.createIndex('by-owner', 'ownerId');
    } else if (oldVersion < 2) {
      const runsStore = transaction.objectStore('ai_runs');
      if (!runsStore.indexNames.contains('by-owner')) {
        runsStore.createIndex('by-owner', 'ownerId');
      }
      let cursor = await runsStore.openCursor();
      while (cursor) {
        if (!cursor.value.ownerId) {
          await cursor.update({ ...cursor.value, ownerId: GUEST_WORKSPACE_ID });
        }
        cursor = await cursor.continue();
      }
    }

    if (!db.objectStoreNames.contains('settings')) {
      db.createObjectStore('settings', { keyPath: 'key' });
    }
  }
});

// ---------------- NOTES CRUD (SCOPED BY WORKSPACE) ----------------

export async function getAllNotes(ownerId = activeWorkspaceId) {
  const db = await dbPromise;
  const notes = await db.getAllFromIndex('notes', 'by-owner', ownerId);
  return notes.sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) {
      return b.pinned ? 1 : -1;
    }
    return b.updatedAt - a.updatedAt;
  });
}

export async function saveNote(partial, ownerId = activeWorkspaceId) {
  const db = await dbPromise;
  const now = Date.now();
  const existing = partial.id ? await db.get('notes', partial.id) : null;

  const content = partial.content ?? existing?.content ?? '';
  const title = (partial.title ?? existing?.title ?? 'Untitled Note').trim() || 'Untitled Note';
  const rawTags = partial.tags ?? existing?.tags ?? [];
  const cleanTags = [...new Set(rawTags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

  const record = {
    id: existing?.id || partial.id || crypto.randomUUID(),
    ownerId: partial.ownerId || existing?.ownerId || ownerId,
    isStarter: partial.isStarter ?? existing?.isStarter ?? false,
    title,
    content,
    tags: cleanTags,
    pinned: partial.pinned ?? existing?.pinned ?? false,
    wordCount: countWords(content),
    charCount: content.length,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  await db.put('notes', record);
  return record;
}

export async function deleteNote(id) {
  const db = await dbPromise;
  const tx = db.transaction(['notes', 'ai_runs'], 'readwrite');
  await tx.objectStore('notes').delete(id);

  const runsIndex = tx.objectStore('ai_runs').index('by-note');
  let cursor = await runsIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Carries over Guest notes & AI runs when a user signs into Google so they never see
 * an unexpected blank screen—and resets Guest workspace cleanly so Google data never leaks on Sign Out.
 */
export async function syncGuestToAuthenticatedWorkspace(googleUid) {
  if (!googleUid || googleUid === GUEST_WORKSPACE_ID) return;

  const db = await dbPromise;
  const guestNotes = await db.getAllFromIndex('notes', 'by-owner', GUEST_WORKSPACE_ID);
  const userNotes = await db.getAllFromIndex('notes', 'by-owner', googleUid);

  const tx = db.transaction(['notes', 'ai_runs'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const runsStore = tx.objectStore('ai_runs');

  if (userNotes.length === 0 && guestNotes.length > 0) {
    // First-time Google sign-in on this device: move all current Guest notes into their Google workspace
    for (const note of guestNotes) {
      await notesStore.put({ ...note, ownerId: googleUid });
    }
    const guestRuns = await runsStore.index('by-owner').getAll(GUEST_WORKSPACE_ID);
    for (const run of guestRuns) {
      await runsStore.put({ ...run, ownerId: googleUid });
    }
  } else {
    // Returning Google user: move only non-starter custom drafts created in Guest mode
    const customGuestDrafts = guestNotes.filter((n) => !n.isStarter);
    for (const draft of customGuestDrafts) {
      await notesStore.put({ ...draft, ownerId: googleUid });
    }
  }

  await tx.done;
}

// ---------------- AI PROVENANCE HISTORY (SCOPED BY WORKSPACE) ----------------

export async function saveAIRun(entry) {
  const db = await dbPromise;
  const record = {
    id: crypto.randomUUID(),
    ownerId: activeWorkspaceId,
    noteId: entry.noteId || 'multi-note',
    action: entry.action,
    promptPreview: entry.promptPreview || '',
    output: entry.output,
    sourceRaw: entry.sourceRaw,
    sourceLabel: entry.sourceLabel,
    modeUsed: entry.modeUsed,
    latencyMs: entry.latencyMs || 0,
    createdAt: Date.now()
  };
  await db.put('ai_runs', record);
  return record;
}

export async function getRecentAIRuns(limit = 25, ownerId = activeWorkspaceId) {
  const db = await dbPromise;
  const all = await db.getAllFromIndex('ai_runs', 'by-owner', ownerId);
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function clearAIRuns(ownerId = activeWorkspaceId) {
  const db = await dbPromise;
  const tx = db.transaction('ai_runs', 'readwrite');
  const index = tx.store.index('by-owner');
  let cursor = await index.openCursor(ownerId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ---------------- SETTINGS ----------------

export async function getSetting(key, fallback = null) {
  const db = await dbPromise;
  const row = await db.get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = await dbPromise;
  await db.put('settings', { key, value, updatedAt: Date.now() });
  return value;
}

// ---------------- SEED RESEARCH NOTES ----------------

const STARTER_SAMPLES = [
  {
    title: 'Field Interview #12: Rural Clinic Offline Sync Bottlenecks',
    pinned: true,
    isStarter: true,
    tags: ['field-research', 'offline-first', 'healthcare'],
    content: `Date: Nov 10, 2026 | Location: Regional Community Triage Desk
Interviewee: Senior Nurse Coordinator Maya Gurung

Key observations from shadowing morning patient intake:
- Cellular connectivity drops every afternoon between 1:30 PM and 4:00 PM during heavy weather.
- Staff currently write patient vitals on paper clipboards when cloud EHR forms freeze, then re-type 40+ records after 5:00 PM.
- Re-typing introduces transcription errors on medication dosages and delays shift handoffs by 45 minutes.
- Nurses asked for instant local note capture with automatic tag suggestions and quick plain-language patient discharge summaries that work with zero internet.`
  },
  {
    title: 'Benchmark Notes: On-Device Small Language Models vs Cloud Frontier',
    pinned: false,
    isStarter: true,
    tags: ['benchmarks', 'hybrid-ai', 'latency'],
    content: `Testing summary across desktop workflows:
1. Short notes under 1,200 words (summarization, bullet polishing, tone rewrite, tag extraction, quick factual Q&A):
   - On-device Gemini Nano produces zero network cost, keeps sensitive draft text strictly inside local memory, and works inside airplane mode.
2. Multi-document synthesis & long literature reviews (3+ notes or >6,000 characters):
   - Cloud fallback via Gemini Flash handles wide cross-document context windows, contradiction detection, and structured citation tables without exhausting local context limits.
3. Recommended product architecture:
   - Default to PREFER_ON_DEVICE for everyday note actions, offer an explicit ONLY_ON_DEVICE privacy lock for confidential notes, and route multi-note synthesis to Cloud when permitted.`
  },
  {
    title: 'Literature Review: Local-First Storage & Conflict-Free UX Patterns',
    pinned: false,
    isStarter: true,
    tags: ['indexeddb', 'ux-architecture', 'privacy'],
    content: `Core findings from reviewing 6 local-first software papers (2023–2026):
- Users lose trust when spinners block typing or when an AI assistant hides whether private text left the device.
- Provenance transparency ("On device" vs "Cloud" badge on every AI generation) increases adoption among researchers handling embargoed interviews or unpublished grant drafts.
- IndexedDB paired with structured metadata indexes allows sub-10ms local full-text filtering across thousands of research notes without server round-trips.
- Open design question for our prototype: How do we reconcile Nurse Maya's zero-connectivity clinic constraints with researchers who occasionally need deep multi-document synthesis when Wi-Fi returns?`
  }
];

export async function ensureStarterNotes(ownerId = activeWorkspaceId) {
  const existing = await getAllNotes(ownerId);
  if (existing.length > 0) return existing;

  // Only seed starter templates once per workspace so if a user intentionally deletes all notes, they stay deleted
  const seededFlagKey = `seeded_${ownerId}`;
  const alreadySeeded = await getSetting(seededFlagKey, false);
  if (alreadySeeded && ownerId !== GUEST_WORKSPACE_ID) {
    return existing;
  }

  for (const sample of STARTER_SAMPLES) {
    await saveNote(sample, ownerId);
  }
  await setSetting(seededFlagKey, true);

  return getAllNotes(ownerId);
}
