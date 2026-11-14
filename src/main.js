import {
  auth,
  isFirebaseConfigured,
  verifyAppCheckStatus,
  signInGuest,
  onAuthStateChanged,
  createHybridModel,
  HYBRID_MODES,
  CLOUD_MODELS,
  checkOnDeviceModelStatus,
  warmUpOnDeviceModel
} from './firebase.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <main class="boot-card">
    <span class="boot-badge">Step 5B — Hybrid AI Verification</span>
    <h1>NoteForge Connectivity Check</h1>
    <p id="diag-log" style="margin-top:0.75rem; white-space:pre-wrap; font-family:monospace; font-size:0.85rem;">Running checks...</p>
    <div style="margin-top:1rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button id="btn-nano" style="padding:0.5rem 0.9rem; border-radius:0.5rem; border:1px solid #475569; background:#334155; color:#fff; cursor:pointer; font-weight:600;">Warm Up On-Device Nano</button>
      <button id="btn-ai" style="padding:0.5rem 0.9rem; border-radius:0.5rem; border:none; background:#059669; color:#fff; cursor:pointer; font-weight:600;">Test Hybrid Ping (PREFER_ON_DEVICE)</button>
    </div>
  </main>
`;

const logEl = document.querySelector('#diag-log');
const lines = [];
function log(msg) {
  lines.push(msg);
  logEl.textContent = lines.join('\n');
}

(async () => {
  log(`Config loaded: ${isFirebaseConfigured() ? 'YES' : 'NO'}`);

  const nano = await checkOnDeviceModelStatus();
  log(`Chrome Gemini Nano status: ${nano.state}`);

  const appCheckRes = await verifyAppCheckStatus();
  log(`App Check: ${appCheckRes.ok ? 'OK' : 'WARN'} (${appCheckRes.detail})`);

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      log(`Auth ready: uid=${user.uid.slice(0, 8)}... (${user.isAnonymous ? 'Guest' : user.email})`);
    } else {
      await signInGuest();
    }
  });
})();

document.querySelector('#btn-nano').addEventListener('click', async () => {
  log('Checking / downloading Chrome Gemini Nano...');
  try {
    const status = await warmUpOnDeviceModel((pct) => {
      logEl.textContent = [...lines, `Downloading Gemini Nano: ${pct}%`].join('\n');
    });
    log(`Gemini Nano ready state: ${status.state}`);
  } catch (err) {
    log(`Nano warm-up info: ${err.message}`);
  }
});

document.querySelector('#btn-ai').addEventListener('click', async () => {
  log(`Running PREFER_ON_DEVICE (fallback: ${CLOUD_MODELS.FAST_DEFAULT})...`);
  try {
    const model = createHybridModel(HYBRID_MODES.PREFER_ON_DEVICE, CLOUD_MODELS.FAST_DEFAULT);
    const result = await model.generateContent('Reply in 5 words confirming NoteForge hybrid AI works.');
    const source = result.response.inferenceSource || 'UNKNOWN';
    log(`Source: ${source}`);
    log(`Reply: ${result.response.text().trim()}`);
  } catch (err) {
    log(`AI error: ${err.message}`);
  }
});
