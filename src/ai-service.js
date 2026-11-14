import {
  createHybridModel,
  HYBRID_MODES,
  CLOUD_MODELS
} from './firebase.js';
import { saveAIRun } from './db.js';

export const ON_DEVICE_CHAR_LIMIT = 4500;
const AI_TIMEOUT_MS = 35000;

export const USER_PRIVACY_MODES = {
  HYBRID_DEFAULT: 'PREFER_ON_DEVICE',
  STRICT_LOCAL: 'ONLY_ON_DEVICE'
};

export function formatInferenceSource(rawSource, effectiveMode) {
  const normalized = String(rawSource || '').toUpperCase();
  if (
    normalized.includes('ON_DEVICE') ||
    effectiveMode === HYBRID_MODES.ONLY_ON_DEVICE
  ) {
    return 'On device';
  }
  return 'Cloud';
}

function resolveRoutingPlan({ privacyMode, isComplexTask, totalChars }) {
  // 1. Strict Privacy Lock: NEVER send data to cloud
  if (privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL) {
    return {
      sdkMode: HYBRID_MODES.ONLY_ON_DEVICE,
      cloudModel: CLOUD_MODELS.FAST_DEFAULT,
      routingReason: 'Privacy Lock active (ONLY_ON_DEVICE — cloud strictly refused)'
    };
  }

  const exceedsLocalWindow = totalChars > ON_DEVICE_CHAR_LIMIT;

  // 2. Multi-note synthesis or long documents -> direct Cloud execution (fast & reliable)
  if (isComplexTask || exceedsLocalWindow) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return {
        sdkMode: HYBRID_MODES.PREFER_ON_DEVICE,
        cloudModel: CLOUD_MODELS.FAST_DEFAULT,
        routingReason: 'Offline detected — attempting local Gemini Nano fallback'
      };
    }
    return {
      sdkMode: HYBRID_MODES.ONLY_IN_CLOUD,
      // Use proven fast cloud model so multi-note synthesis returns in ~2-5s without hanging
      cloudModel: CLOUD_MODELS.FAST_DEFAULT,
      routingReason: isComplexTask
        ? 'Multi-note synthesis routed directly to Cloud'
        : `Long document (${totalChars.toLocaleString()} chars) routed directly to Cloud`
    };
  }

  // 3. Default short note actions -> Try Gemini Nano on-device first, fall back to Cloud
  return {
    sdkMode: HYBRID_MODES.PREFER_ON_DEVICE,
    cloudModel: CLOUD_MODELS.FAST_DEFAULT,
    routingReason: 'Short note task — trying Gemini Nano on-device first, Cloud fallback ready'
  };
}

function withTimeout(promise, ms) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`AI request timed out after ${Math.round(ms / 1000)}s. Check your connection or try again.`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
}

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
    const result = await withTimeout(model.generateContent(prompt), AI_TIMEOUT_MS);
    const latencyMs = Math.round(performance.now() - startedAt);

    const text = result.response.text().trim();
    const sourceRaw = result.response.inferenceSource || (plan.sdkMode === HYBRID_MODES.ONLY_IN_CLOUD ? 'IN_CLOUD' : 'UNKNOWN');
    const sourceLabel = formatInferenceSource(sourceRaw, plan.sdkMode);

    const runRecord = await saveAIRun({
      noteId,
      action,
      promptPreview: prompt.slice(0, 140),
      output: text,
      sourceRaw,
      sourceLabel,
      modeUsed: privacyMode,
      latencyMs
    });

    return {
      ...runRecord,
      routingReason: plan.routingReason
    };
  } catch (err) {
    console.error(`[NoteForge AI Error - ${action}]:`, err);

    if (privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL) {
      throw new Error(
        'Blocked by ONLY_ON_DEVICE Privacy Mode: On-device Gemini Nano is not available in this browser right now, so NoteForge refused to send your notes to the cloud.'
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
