import { openDB } from 'idb';

const DB_NAME = 'noteforge-vault-db';
const DB_VERSION = 1;

function countWords(text = '') {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('notes')) {
      const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
      notesStore.createIndex('by-updated', 'updatedAt');
    }

    if (!db.objectStoreNames.contains('ai_runs')) {
      const runsStore = db.createObjectStore('ai_runs', { keyPath: 'id' });
      runsStore.createIndex('by-created', 'createdAt');
      runsStore.createIndex('by-note', 'noteId');
    }

    if (!db.objectStoreNames.contains('settings')) {
      db.createObjectStore('settings', { keyPath: 'key' });
    }
  }
});

// ---------------- NOTES CRUD ----------------

export async function getAllNotes() {
  const db = await dbPromise;
  const notes = await db.getAll('notes');
  return notes.sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) {
      return b.pinned ? 1 : -1;
    }
    return b.updatedAt - a.updatedAt;
  });
}

export async function getNoteById(id) {
  const db = await dbPromise;
  return db.get('notes', id);
}

export async function saveNote(partial) {
  const db = await dbPromise;
  const now = Date.now();
  const existing = partial.id ? await db.get('notes', partial.id) : null;

  const content = partial.content ?? existing?.content ?? '';
  const title = (partial.title ?? existing?.title ?? 'Untitled Note').trim() || 'Untitled Note';
  const rawTags = partial.tags ?? existing?.tags ?? [];
  const cleanTags = [...new Set(rawTags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

  const record = {
    id: existing?.id || partial.id || crypto.randomUUID(),
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

// ---------------- AI PROVENANCE HISTORY ----------------

export async function saveAIRun(entry) {
  const db = await dbPromise;
  const record = {
    id: crypto.randomUUID(),
    noteId: entry.noteId || 'multi-note',
    action: entry.action,
    promptPreview: entry.promptPreview || '',
    output: entry.output,
    sourceRaw: entry.sourceRaw,     // e.g. 'on_device' | 'in_cloud'
    sourceLabel: entry.sourceLabel, // 'On device' | 'Cloud'
    modeUsed: entry.modeUsed,       // 'PREFER_ON_DEVICE' | 'ONLY_ON_DEVICE'
    latencyMs: entry.latencyMs || 0,
    createdAt: Date.now()
  };
  await db.put('ai_runs', record);
  return record;
}

export async function getRecentAIRuns(limit = 25) {
  const db = await dbPromise;
  const all = await db.getAll('ai_runs');
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function clearAIRuns() {
  const db = await dbPromise;
  await db.clear('ai_runs');
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

export async function ensureStarterNotes() {
  const existing = await getAllNotes();
  if (existing.length > 0) return existing;

  const samples = [
    {
      title: 'Field Interview #12: Rural Clinic Offline Sync Bottlenecks',
      pinned: true,
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
      tags: ['indexeddb', 'ux-architecture', 'privacy'],
      content: `Core findings from reviewing 6 local-first software papers (2023–2026):
- Users lose trust when spinners block typing or when an AI assistant hides whether private text left the device.
- Provenance transparency ("On device" vs "Cloud" badge on every AI generation) increases adoption among researchers handling embargoed interviews or unpublished grant drafts.
- IndexedDB paired with structured metadata indexes allows sub-10ms local full-text filtering across thousands of research notes without server round-trips.
- Open design question for our prototype: How do we reconcile Nurse Maya's zero-connectivity clinic constraints with researchers who occasionally need deep multi-document synthesis when Wi-Fi returns?`
    }
  ];

  for (const sample of samples) {
    await saveNote(sample);
  }

  return getAllNotes();
}
