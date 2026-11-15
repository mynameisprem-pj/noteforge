import { createHybridModel, HYBRID_MODES, CLOUD_MODELS } from './firebase.js';
import { saveAIRun } from './db.js';

export const USER_PRIVACY_MODES = {
  HYBRID_DEFAULT: 'PREFER_ON_DEVICE',
  STRICT_LOCAL: 'ONLY_ON_DEVICE'
};

export const ON_DEVICE_CHAR_LIMIT = 4500;

const SYSTEM_COMPANION_PROMPT =
  'You are NoteForge, a concise, accurate research assistant. Use clean Markdown formatting. Never fabricate facts outside the provided notes or image.';

function normalizeInferenceSource(rawSource, requestedMode) {
  const s = String(rawSource || '').toLowerCase();
  if (s.includes('on_device') || s.includes('on-device') || s === 'local') {
    return 'On device';
  }
  if (s.includes('in_cloud') || s.includes('cloud')) {
    return 'Cloud';
  }
  return requestedMode === HYBRID_MODES.ONLY_ON_DEVICE ? 'On device' : 'Cloud';
}

function selectInferencePlan({ privacyMode, totalChars, isMultiNote = false }) {
  if (privacyMode === USER_PRIVACY_MODES.STRICT_LOCAL) {
    return {
      sdkMode: HYBRID_MODES.ONLY_ON_DEVICE,
      modeLabel: 'ONLY_ON_DEVICE (Strict Privacy Lock)',
      cloudModel: CLOUD_MODELS.FAST_DEFAULT
    };
  }

  if (isMultiNote || totalChars > ON_DEVICE_CHAR_LIMIT) {
    return {
      sdkMode: HYBRID_MODES.PREFER_IN_CLOUD,
      modeLabel: isMultiNote
        ? 'PREFER_IN_CLOUD (Multi-Note Synthesis)'
        : 'PREFER_IN_CLOUD (Long Context Fallback)',
      cloudModel: CLOUD_MODELS.FAST_DEFAULT
    };
  }

  return {
    sdkMode: HYBRID_MODES.PREFER_ON_DEVICE,
    modeLabel: 'PREFER_ON_DEVICE (Local-First Hybrid)',
    cloudModel: CLOUD_MODELS.FAST_DEFAULT
  };
}

/**
 * Core Hybrid Runner with Live Token Streaming (`generateContentStream`) + Provenance Tracking.
 * Gracefully falls back to `generateContent` if a local browser runtime doesn't expose streaming.
 */
async function executeHybridTask({
  action,
  noteId,
  prompt,
  contentParts = null,
  multimodal = false,
  privacyMode,
  totalChars,
  isMultiNote = false,
  onStreamChunk = null
}) {
  const plan = selectInferencePlan({ privacyMode, totalChars, isMultiNote });
  const startedAt = performance.now();

  if (!navigator.onLine && plan.sdkMode === HYBRID_MODES.PREFER_IN_CLOUD) {
    plan.sdkMode = HYBRID_MODES.ONLY_ON_DEVICE;
    plan.modeLabel = 'ONLY_ON_DEVICE (Offline Emergency Route)';
  }

  try {
    const model = createHybridModel(
      plan.sdkMode,
      plan.cloudModel,
      SYSTEM_COMPANION_PROMPT,
      multimodal
    );

    const requestPayload = contentParts || prompt;
    let output = '';
    let rawSource = null;

    if (typeof onStreamChunk === 'function' && typeof model.generateContentStream === 'function') {
      try {
        const streamResult = await model.generateContentStream(requestPayload);
        for await (const chunk of streamResult.stream) {
          const piece = typeof chunk.text === 'function' ? chunk.text() : '';
          if (piece) {
            output += piece;
            if (!rawSource && chunk?.inferenceSource) {
              rawSource = chunk.inferenceSource;
            }
            onStreamChunk({
              text: output,
              sourceLabel: rawSource ? normalizeInferenceSource(rawSource, plan.sdkMode) : null,
              modeUsed: plan.modeLabel
            });
          }
        }
        const finalResponse = await streamResult.response;
        rawSource = finalResponse?.inferenceSource || rawSource || 'unknown';
        if (!output && typeof finalResponse?.text === 'function') {
          output = finalResponse.text()?.trim() || '';
        }
      } catch (streamErr) {
        // If streaming fails before emitting tokens on an experimental local session, retry non-streamed
        if (output.length > 0) throw streamErr;
        const fallbackRes = await model.generateContent(requestPayload);
        output = fallbackRes.response.text()?.trim() || '';
        rawSource = fallbackRes.response.inferenceSource || 'unknown';
      }
    } else {
      const result = await model.generateContent(requestPayload);
      output = result.response.text()?.trim() || '';
      rawSource = result.response.inferenceSource || 'unknown';
    }

    output = output.trim() || '(No output returned)';
    const latencyMs = Math.round(performance.now() - startedAt);
    const sourceLabel = normalizeInferenceSource(rawSource, plan.sdkMode);

    const savedRecord = await saveAIRun({
      noteId,
      action,
      promptPreview: prompt.slice(0, 180),
      output,
      sourceRaw: rawSource,
      sourceLabel,
      modeUsed: plan.modeLabel,
      latencyMs
    });

    return savedRecord;
  } catch (err) {
    console.error(`[NoteForge AI Error - ${action}]:`, err);

    if (plan.sdkMode === HYBRID_MODES.ONLY_ON_DEVICE) {
      throw new Error(
        'On-device Gemini Nano is unavailable on this browser/hardware (or lacks multimodal flag support), and Privacy Mode is locked to ONLY_ON_DEVICE. Switch to Hybrid Mode to allow Cloud fallback.'
      );
    }

    if (!navigator.onLine) {
      throw new Error(
        'You are offline and local Gemini Nano is not ready in this browser. Reconnect to the internet or enable Chrome Built-in AI flags.'
      );
    }

    throw new Error(err?.message || 'Hybrid AI inference failed. Check your Firebase AI Logic setup.');
  }
}

// ---------------- PUBLIC CAPABILITIES ----------------

export async function summarizeNote(note, privacyMode, onStreamChunk) {
  const prompt = `Summarize the following research note into:
1. **TL;DR** (1-2 crisp sentences)
2. **Key Takeaways** (3-5 bullet points)
3. **Action Items / Open Questions** (if any)

Note Title: ${note.title}
Note Content:
${note.content}`;

  return executeHybridTask({
    action: 'Summarize',
    noteId: note.id,
    prompt,
    privacyMode,
    totalChars: note.content.length,
    onStreamChunk
  });
}

export async function generateTagsForNote(note, privacyMode, onStreamChunk) {
  const prompt = `Read this research note and return ONLY a comma-separated list of 3 to 5 short lowercase kebab-case topic tags (example: offline-sync, clinical-workflow, hybrid-ai). Do not include explanations or numbering.

Note Title: ${note.title}
Note Content:
${note.content}`;

  const run = await executeHybridTask({
    action: 'Auto-Tag',
    noteId: note.id,
    prompt,
    privacyMode,
    totalChars: note.content.length,
    onStreamChunk
  });

  const parsedTags = run.output
    .replace(/[#*`\n]/g, ',')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-\s]/g, '').replace(/\s+/g, '-'))
    .filter((t) => t.length >= 2 && t.length <= 28)
    .slice(0, 5);

  return { run, parsedTags };
}

export async function rewriteNote(note, style = 'clarity', privacyMode, onStreamChunk) {
  const styleInstructions = {
    clarity: 'Rewrite the note for maximum clarity, conciseness, and clean Markdown structure while preserving every factual detail.',
    executive: 'Transform the note into a crisp Executive Research Brief with bold headings and high-signal bullet points.',
    academic: 'Rewrite the note in formal academic prose suitable for a research methodology or literature review section.'
  };

  const instruction = styleInstructions[style] || styleInstructions.clarity;
  const prompt = `${instruction}

Original Title: ${note.title}
Original Content:
${note.content}`;

  return executeHybridTask({
    action: `Rewrite (${style})`,
    noteId: note.id,
    prompt,
    privacyMode,
    totalChars: note.content.length,
    onStreamChunk
  });
}

export async function askNoteQuestion(note, question, privacyMode, onStreamChunk) {
  const prompt = `Answer the researcher's question strictly using the provided note. If the note does not contain enough information, state what is missing clearly.

Note Title: ${note.title}
Note Content:
${note.content}

Question: ${question}`;

  return executeHybridTask({
    action: 'Note Q&A',
    noteId: note.id,
    prompt,
    privacyMode,
    totalChars: note.content.length + question.length,
    onStreamChunk
  });
}

export async function extractNoteFromImage({ base64Data, mimeType, fileName = 'image' }, noteId, privacyMode, onStreamChunk) {
  const prompt = `Examine this captured research image (${fileName} — e.g., handwritten field notes, whiteboard diagram, slide, or document table) and extract it into clean, structured Markdown:
1. **Extracted Content**: Accurate transcription of text, bullet lists, or Markdown tables.
2. **Visual / Diagram Observations**: Brief summary of any charts, arrows, or layout relationships (omit if plain text).`;

  const contentParts = [
    prompt,
    {
      inlineData: {
        data: base64Data,
        mimeType
      }
    }
  ];

  return executeHybridTask({
    action: 'Image Scan',
    noteId: noteId || 'image-scan',
    prompt,
    contentParts,
    multimodal: true,
    privacyMode,
    totalChars: prompt.length,
    onStreamChunk
  });
}

export async function synthesizeMultipleNotes(notes, focusGoal = '', privacyMode, onStreamChunk) {
  const combinedNotes = notes
    .map(
      (n, idx) =>
        `--- [Note ${idx + 1}: "${n.title}"] ---\nTags: ${n.tags.join(', ') || 'none'}\n${n.content}`
    )
    .join('\n\n');

  const prompt = `Synthesize the following ${notes.length} research notes into a unified **Cross-Note Research Synthesis**.
${focusGoal ? `Specific Research Focus: ${focusGoal}\n` : ''}
Include:
1. **Core Cross-Cutting Themes** (cite sources explicitly as [Note 1], [Note 2], etc.)
2. **Tensions, Trade-offs, or Gaps** across the notes
3. **Recommended Next Research / Engineering Steps**

Corpus:
${combinedNotes}`;

  return executeHybridTask({
    action: `Synthesize (${notes.length} Notes)`,
    noteId: 'multi-note',
    prompt,
    privacyMode,
    totalChars: combinedNotes.length,
    isMultiNote: true,
    onStreamChunk
  });
}
