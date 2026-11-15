import { openDB } from 'idb';
import {
  firestoreDb,
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc
} from './firebase.js';

const DB_NAME = 'noteforge-vault-db';
const DB_VERSION = 3;

export const GUEST_WORKSPACE_ID = 'guest';

let activeWorkspaceId = GUEST_WORKSPACE_ID;
let cloudSyncAllowed = true;

export function setActiveWorkspace(workspaceId) {
  activeWorkspaceId = workspaceId || GUEST_WORKSPACE_ID;
}

export function getActiveWorkspace() {
  return activeWorkspaceId;
}

export function setCloudSyncAllowed(allowed) {
  cloudSyncAllowed = Boolean(allowed);
}

function canSyncWithCloud(ownerId = activeWorkspaceId) {
  return (
    Boolean(ownerId) &&
    ownerId !== GUEST_WORKSPACE_ID &&
    cloudSyncAllowed &&
    typeof navigator !== 'undefined' &&
    navigator.onLine
  );
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

    if (!db.objectStoreNames.contains('pending_deletes')) {
      const delStore = db.createObjectStore('pending_deletes', { keyPath: 'id' });
      delStore.createIndex('by-owner', 'ownerId');
    }
  }
});

// ---------------- CLOUD FIRESTORE SYNC ----------------

async function pushNoteToCloud(note) {
  if (!canSyncWithCloud(note.ownerId)) return false;
  try {
    const noteRef = doc(firestoreDb, 'users', note.ownerId, 'notes', note.id);
    const { needsCloudSync, ...cleanPayload } = note;
    await setDoc(noteRef, cleanPayload);

    const db = await dbPromise;
    const latestLocal = await db.get('notes', note.id);
    if (latestLocal && latestLocal.updatedAt === note.updatedAt && latestLocal.needsCloudSync) {
      await db.put('notes', { ...latestLocal, needsCloudSync: false });
    }
    return true;
  } catch (err) {
    console.warn('[Cloud Sync] Deferred note upload to offline queue:', err?.message);
    return false;
  }
}

export async function syncCloudWorkspace(ownerId = activeWorkspaceId) {
  if (!canSyncWithCloud(ownerId)) return { synced: false };

  try {
    const db = await dbPromise;

    // 1. Flush queued offline deletions
    const pendingDeletes = await db.getAllFromIndex('pending_deletes', 'by-owner', ownerId);
    for (const item of pendingDeletes) {
      await deleteDoc(doc(firestoreDb, 'users', ownerId, 'notes', item.noteId));
      await db.delete('pending_deletes', item.id);
    }

    // 2. Fetch remote notes from Firestore
    const notesCol = collection(firestoreDb, 'users', ownerId, 'notes');
    const snap = await getDocs(notesCol);
    const remoteMap = new Map();
    snap.forEach((docSnap) => {
      remoteMap.set(docSnap.id, docSnap.data());
    });

    // 3. Reconcile with local IndexedDB notes
    const localNotes = await db.getAllFromIndex('notes', 'by-owner', ownerId);
    const localMap = new Map(localNotes.map((n) => [n.id, n]));

    // Pull newer or missing remote notes
    for (const [id, remoteNote] of remoteMap.entries()) {
      const localNote = localMap.get(id);
      if (!localNote || (remoteNote.updatedAt || 0) > (localNote.updatedAt || 0)) {
        await db.put('notes', {
          ...remoteNote,
          id,
          ownerId,
          needsCloudSync: false
        });
      }
    }

    // If a note existed locally as already-synced (needsCloudSync === false) and was deleted on another device, remove locally
    for (const [id, localNote] of localMap.entries()) {
      if (!remoteMap.has(id) && localNote.needsCloudSync === false) {
        await db.delete('notes', id);
        localMap.delete(id);
      }
    }

    // Push newer or unsynced local notes up to Firestore
    for (const [id, localNote] of localMap.entries()) {
      const remoteNote = remoteMap.get(id);
      if (
        !remoteNote ||
        localNote.needsCloudSync ||
        (localNote.updatedAt || 0) > (remoteNote.updatedAt || 0)
      ) {
        await pushNoteToCloud(localNote);
      }
    }

    return { synced: true };
  } catch (err) {
    console.warn('[Cloud Sync] Could not complete cloud sync:', err?.message);
    return { synced: false, error: err?.message };
  }
}

// ---------------- NOTES CRUD ----------------

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

  const targetOwner = partial.ownerId || existing?.ownerId || ownerId;
  const content = partial.content ?? existing?.content ?? '';
  const title = (partial.title ?? existing?.title ?? 'Untitled Note').trim() || 'Untitled Note';
  const rawTags = partial.tags ?? existing?.tags ?? [];
  const cleanTags = [...new Set(rawTags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

  // If a user modifies an existing starter sample note, promote it to a real custom user note (isStarter = false)
  let isStarter = partial.isStarter ?? existing?.isStarter ?? false;
  if (
    existing?.isStarter &&
    partial.isStarter === undefined &&
    (title !== existing.title ||
      content !== existing.content ||
      cleanTags.join(',') !== (existing.tags || []).join(','))
  ) {
    isStarter = false;
  }

  const record = {
    id: existing?.id || partial.id || crypto.randomUUID(),
    ownerId: targetOwner,
    isStarter,
    title,
    content,
    tags: cleanTags,
    pinned: partial.pinned ?? existing?.pinned ?? false,
    wordCount: countWords(content),
    charCount: content.length,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    needsCloudSync: targetOwner !== GUEST_WORKSPACE_ID
  };

  await db.put('notes', record);

  if (canSyncWithCloud(targetOwner)) {
    pushNoteToCloud(record);
  }

  return record;
}

export async function deleteNote(id) {
  const db = await dbPromise;
  const existing = await db.get('notes', id);
  const ownerId = existing?.ownerId || activeWorkspaceId;

  const tx = db.transaction(['notes', 'ai_runs'], 'readwrite');
  await tx.objectStore('notes').delete(id);

  const runsIndex = tx.objectStore('ai_runs').index('by-note');
  let cursor = await runsIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;

  if (ownerId !== GUEST_WORKSPACE_ID) {
    if (canSyncWithCloud(ownerId)) {
      try {
        await deleteDoc(doc(firestoreDb, 'users', ownerId, 'notes', id));
      } catch {
        await db.put('pending_deletes', { id: `${ownerId}_${id}`, ownerId, noteId: id });
      }
    } else {
      await db.put('pending_deletes', { id: `${ownerId}_${id}`, ownerId, noteId: id });
    }
  }
}

// ---------------- EXPLICIT GUEST DRAFT IMPORT & SAMPLE LOADER ----------------

/**
 * Returns custom (non-starter) notes created or edited in Guest Mode that haven't been dismissed.
 */
export async function getImportableGuestDrafts(targetGoogleUid) {
  if (!targetGoogleUid || targetGoogleUid === GUEST_WORKSPACE_ID) return [];
  const db = await dbPromise;
  const guestNotes = await db.getAllFromIndex('notes', 'by-owner', GUEST_WORKSPACE_ID);
  const dismissedIds = await getSetting(`dismissed_guest_${targetGoogleUid}`, []);
  const dismissedSet = new Set(dismissedIds);

  return guestNotes.filter(
    (n) => !n.isStarter && !dismissedSet.has(n.id) && (n.content.trim() || n.title !== 'Untitled Research Note')
  );
}

/**
 * Explicitly moves custom Guest drafts into the signed-in Google user's workspace upon user consent.
 */
export async function importGuestDraftsToUser(googleUid) {
  if (!googleUid || googleUid === GUEST_WORKSPACE_ID) return 0;
  const drafts = await getImportableGuestDrafts(googleUid);
  if (drafts.length === 0) return 0;

  const db = await dbPromise;
  const tx = db.transaction('notes', 'readwrite');
  const migrated = [];

  for (const draft of drafts) {
    const movedRecord = {
      ...draft,
      ownerId: googleUid,
      isStarter: false,
      updatedAt: Date.now(),
      needsCloudSync: true
    };
    await tx.store.put(movedRecord);
    migrated.push(movedRecord);
  }
  await tx.done;

  // Re-seed Guest workspace starter samples cleanly if needed so Sign Out always looks tidy
  await ensureGuestStarterNotes();

  if (canSyncWithCloud(googleUid)) {
    for (const note of migrated) {
      pushNoteToCloud(note);
    }
  }

  return migrated.length;
}

/**
 * Dismisses the Guest import prompt for the current Guest draft IDs without deleting them from Guest mode.
 */
export async function dismissGuestDraftsImport(googleUid) {
  if (!googleUid || googleUid === GUEST_WORKSPACE_ID) return;
  const drafts = await getImportableGuestDrafts(googleUid);
  const existing = await getSetting(`dismissed_guest_${googleUid}`, []);
  const merged = [...new Set([...existing, ...drafts.map((d) => d.id)])];
  await setSetting(`dismissed_guest_${googleUid}`, merged);
}

// ---------------- AI PROVENANCE HISTORY ----------------

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

// ---------------- SAMPLE RESEARCH NOTES ----------------

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

/**
 * Seeds sample notes ONLY for Guest Mode on initial browser visit (so judges can test immediately).
 * Google Sign-In accounts NEVER auto-seed sample notes unless the user clicks "Load 3 Sample Notes".
 */
export async function ensureGuestStarterNotes() {
  const existing = await getAllNotes(GUEST_WORKSPACE_ID);
  if (existing.length > 0) return existing;

  const alreadySeededGuest = await getSetting('seeded_guest_once', false);
  if (alreadySeededGuest) return existing;

  for (const sample of STARTER_SAMPLES) {
    await saveNote(sample, GUEST_WORKSPACE_ID);
  }
  await setSetting('seeded_guest_once', true);
  return getAllNotes(GUEST_WORKSPACE_ID);
}

/**
 * Explicit 1-click helper to load the 3 research sample notes into the active workspace.
 */
export async function loadSampleNotesIntoWorkspace(ownerId = activeWorkspaceId) {
  for (const sample of STARTER_SAMPLES) {
    await saveNote(
      {
        ...sample,
        isStarter: ownerId === GUEST_WORKSPACE_ID
      },
      ownerId
    );
  }
  return getAllNotes(ownerId);
}
