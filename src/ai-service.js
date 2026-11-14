import {
  createHybridModel,
  HYBRID_MODES,
  CLOUD_MODELS
} from './firebase.js';
import { saveAIRun } from './db.js';

// Threshold above which a single note is treated as a "long document"
export const ON_DEVICE_CHAR_LIMIT = 4500;

export const USER_PRIVACY_MODES = {
  HYBRID_DEFAULT: 'PREFER_ON_DEVICE', // Try on-device first, fall back to cloud
  STRICT_LOCAL: 'ONLY_ON_DEVICE'      // Refuse cloud if on-device is unavailable
};

/**
 * Normalizes Firebase AI Logic's `response.inferenceSource` ('ON_DEVICE' | 'IN_CLOUD')
 * into exact user-facing labels: 'On device' or 'Cloud'.
 */
export function formatInferenceSource(rawSource, effectiveMode) {
  const normalized = String(rawSource || '').toUpperCase();
  if (normalized.includes('ON_DEVICE') || effectiveMode === HYBRID_MODES.ONLY_ON_DEVICE) {
    return 'On device';
  }
  return 'Cloud';
}

/**
 * Determines the Firebase InferenceMode and Cloud Model based on:
 * 1. User's selected privacy policy (PREFER_ON_DEVICE vs ONLY_ON_DEVICE)
 * 2. Task complexity & context length (short single-note vs long doc / multi-note synthesis)
 * 3. Current browser connectivity (navigator.onLine)
 */
function resolveRoutingPlan({ privacyMode, isComplexTask, totalChars }) {
  // Privacy Lock: NEVER send data to cloud under any circumstance
  if (privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL) {
    return {
      sdkMode: HYBRID_MODES.ONLY_ON_DEVICE,
      cloudModel: CLOUD_MODELS.FAST_DEFAULT,
      routingReason: 'Privacy Lock active (ONLY_ON_DEVICE — cloud strictly refused)'
    };
  }

  const exceedsLocalWindow = totalChars > ON_DEVICE_CHAR_LIMIT;

  // Heavy multi-note synthesis or long documents -> route to frontier cloud model when online
  if (isComplexTask || exceedsLocalWindow) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return {
        sdkMode: HYBRID_MODES.PREFER_ON_DEVICE,
        cloudModel: CLOUD_MODELS.DEEP_SYNTHESIS,
        routingReason: 'Offline detected — attempting local Gemini Nano fallback'
      };
    }
    return {
      sdkMode: HYBRID_MODES.PREFER_IN_CLOUD,
      cloudModel: CLOUD_MODELS.DEEP_SYNTHESIS,
      routingReason: isComplexTask
        ? 'Multi-note synthesis / deep reasoning routed to Cloud with local fallback'
        : `Long document (${totalChars.toLocaleString()} chars) routed to Cloud`
    };
  }

  // Default everyday note actions -> On-device first, seamless cloud fallback
  return {
    sdkMode: HYBRID_MODES.PREFER_ON_DEVICE,
    cloudModel: CLOUD_MODELS.FAST_DEFAULT,
    routingReason: 'Short note task — trying Gemini Nano on-device first, Cloud fallback ready'
  };
}

/**
 * Executes a prompt through Firebase AI Logic and logs provenance to IndexedDB.
 */
async function executeHybridRequest({
  action,
  noteId,
  prompt,
  systemInstruction,
  privacyMode,
  isComplexTask = false,
  totalChars = 0
}) {
  const plan = resolveRoutingPlan({ privacyMode, isComplexTask, totalChars });
  const startedAt = performance.now();

  try {
    const model = createHybridModel(plan.sdkMode, plan.cloudModel, systemInstruction);
    const result = await model.generateContent(prompt);
    const latencyMs = Math.round(performance.now() - startedAt);

    const text = result.response.text().trim();
    const sourceRaw = result.response.inferenceSource || 'UNKNOWN';
    const sourceLabel = formatInferenceSource(sourceRaw, plan.sdkMode);

    const runRecord = await saveAIRun({
      noteId,
      action,
      promptPreview: prompt.slice(0, 140),
      output: text,
      sourceRaw,
      sourceLabel, // Always strictly "On device" or "Cloud"
      modeUsed: privacyMode,
      latencyMs
    });

    return {
      ...runRecord,
      routingReason: plan.routingReason
    };
  } catch (err) {
    if (privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL) {
      throw new Error(
        'Blocked by ONLY_ON_DEVICE Privacy Mode: On-device Gemini Nano is not available in this browser right now, so NoteForge refused to send your private note to the cloud.'
      );
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error(
        'You are currently offline and Chrome Gemini Nano is not yet downloaded on this device. Enable Gemini Nano while online to unlock 100% offline AI.'
      );
    }
    throw new Error(err?.message || 'Hybrid AI inference failed.');
  }
}

// ---------------- FEATURE ACTIONS ----------------

export async function summarizeNote(note, privacyMode) {
  const prompt = [
    `Summarize the following research note clearly with:`,
    `1. A 1-sentence core takeaway`,
    `2. 3–5 concise bullet points of key facts`,
    `3. Any open action items (if present)`,
    ``,
    `Title: ${note.title}`,
    `Content:\n${note.content}`
  ].join('\n');

  return executeHybridRequest({
    action: 'Summarize',
    noteId: note.id,
    prompt,
    systemInstruction:
      'You are NoteForge, a concise, accurate research assistant. Keep summaries crisp, factual, and grounded strictly in the provided note.',
    privacyMode,
    isComplexTask: false,
    totalChars: note.content.length
  });
}

export async function generateTagsForNote(note, privacyMode) {
  const prompt = [
    `Read this note and return ONLY a comma-separated list of 3 to 5 lowercase kebab-case research tags (no numbering, no explanation, no hashtags).`,
    `Example output: offline-sync, clinical-workflow, field-study, ux-research`,
    ``,
    `Title: ${note.title}`,
    `Content:\n${note.content}`
  ].join('\n');

  const res = await executeHybridRequest({
    action: 'Auto-Tag',
    noteId: note.id,
    prompt,
    systemInstruction:
      'Return only 3 to 5 comma-separated lowercase kebab-case tags with no extra commentary.',
    privacyMode,
    isComplexTask: false,
    totalChars: note.content.length
  });

  const parsedTags = res.output
    .replace(/[#*`\n]/g, ',')
    .split(',')
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-\s]/g, '')
        .replace(/\s+/g, '-')
    )
    .filter((t) => t.length >= 2 && t.length <= 28)
    .slice(0, 5);

  return {
    ...res,
    parsedTags
  };
}

export async function rewriteNote(note, stylePreset, privacyMode) {
  const styleGuides = {
    clarity: 'Tighten prose for maximum clarity, active voice, and readability while preserving every fact.',
    executive: 'Rewrite as a crisp executive research brief with clear subheadings and scannable bullets.',
    academic: 'Rewrite in clear, rigorous academic research prose suitable for a paper or technical report.'
  };

  const instruction = styleGuides[stylePreset] || styleGuides.clarity;
  const prompt = [
    `Task: ${instruction}`,
    `Do not invent facts not present in the source text.`,
    ``,
    `Title: ${note.title}`,
    `Original Note:\n${note.content}`
  ].join('\n');

  return executeHybridRequest({
    action: `Rewrite (${stylePreset})`,
    noteId: note.id,
    prompt,
    systemInstruction: 'You are an expert research editor. Output clean Markdown.',
    privacyMode,
    isComplexTask: false,
    totalChars: note.content.length
  });
}

export async function askNoteQuestion(note, question, privacyMode) {
  const prompt = [
    `Answer the user's question using ONLY the note below. If the note does not contain enough information, state what is missing clearly.`,
    ``,
    `Note Title: ${note.title}`,
    `Note Content:\n${note.content}`,
    ``,
    `Question: ${question}`
  ].join('\n');

  return executeHybridRequest({
    action: 'Note Q&A',
    noteId: note.id,
    prompt,
    systemInstruction: 'Answer accurately and concisely based on the user note.',
    privacyMode,
    isComplexTask: false,
    totalChars: note.content.length + question.length
  });
}

export async function synthesizeMultipleNotes(notes, researchGoal, privacyMode) {
  const combinedChars = notes.reduce((acc, n) => acc + n.content.length + n.title.length, 0);

  const formattedNotes = notes
    .map(
      (n, idx) =>
        `--- SOURCE NOTE [${idx + 1}]: "${n.title}" (tags: ${n.tags.join(', ') || 'none'}) ---\n${n.content}`
    )
    .join('\n\n');

  const prompt = [
    `Synthesize insights across these ${notes.length} research notes.`,
    researchGoal?.trim()
      ? `Specific Research Focus / Prompt: ${researchGoal.trim()}`
      : `Identify shared themes, tensions or trade-offs across sources, and concrete next recommendations.`,
    `Cite sources inline as [Note 1], [Note 2], etc., so every claim is traceable.`,
    ``,
    formattedNotes
  ].join('\n');

  return executeHybridRequest({
    action: `Multi-Note Synthesis (${notes.length} notes)`,
    noteId: 'multi-note',
    prompt,
    systemInstruction:
      'You are a senior research synthesis engine. Cross-reference sources, highlight connections and contradictions, and cite [Note N] inline.',
    privacyMode,
    isComplexTask: true,
    totalChars: combinedChars
  });
}
