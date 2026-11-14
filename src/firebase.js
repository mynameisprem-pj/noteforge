import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  getToken as getAppCheckToken
} from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode
} from 'firebase/ai';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
      !firebaseConfig.apiKey.includes('your_') &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

// 1. Initialize core Firebase App
export const firebaseApp = initializeApp(firebaseConfig);

// 2. Initialize App Check FIRST (with explicit debug token support)
let appCheckInstance = null;

if (typeof window !== 'undefined') {
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN?.trim();
  if (import.meta.env.DEV || debugToken) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken && !debugToken.includes('your_') ? debugToken : true;
  }

  const siteKey = import.meta.env.VITE_RECAPTCHA_V3_SITE_KEY?.trim();
  if (siteKey && !siteKey.includes('your_')) {
    appCheckInstance = initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true
    });
  }
}

export const appCheck = appCheckInstance;

export async function verifyAppCheckStatus() {
  if (!appCheckInstance) {
    return { ok: false, detail: 'Missing VITE_RECAPTCHA_V3_SITE_KEY in .env' };
  }
  try {
    const result = await getAppCheckToken(appCheckInstance, false);
    return {
      ok: Boolean(result?.token),
      detail: 'Valid App Check token issued'
    };
  } catch (err) {
    return {
      ok: false,
      detail: err?.message || 'App Check token fetch failed'
    };
  }
}

// 3. Initialize Firebase Auth with IndexedDB persistence for offline support
export const auth = initializeAuth(firebaseApp, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: browserPopupRedirectResolver
});

const googleProvider = new GoogleAuthProvider();

export const signInGuest = () => signInAnonymously(auth);
export const signInGoogle = () => signInWithPopup(auth, googleProvider);
export const logOutUser = () => signOut(auth);
export { onAuthStateChanged };

// 4. Initialize Firebase AI Logic (Gemini Developer API + Hybrid Inference)
export const ai = getAI(firebaseApp, {
  backend: new GoogleAIBackend()
});

export const HYBRID_MODES = {
  PREFER_ON_DEVICE: InferenceMode.PREFER_ON_DEVICE,
  ONLY_ON_DEVICE: InferenceMode.ONLY_ON_DEVICE,
  PREFER_IN_CLOUD: InferenceMode.PREFER_IN_CLOUD,
  ONLY_IN_CLOUD: InferenceMode.ONLY_IN_CLOUD
};

export const CLOUD_MODELS = {
  FAST_DEFAULT: 'gemini-3.5-flash-lite', // SDK v13 default cloud fallback
  DEEP_SYNTHESIS: 'gemini-3.8-flash'     // Frontier reasoning for multi-note synthesis & long docs
};

/**
 * Creates a hybrid GenerativeModel instance.
 * When cloudModelName is omitted, Firebase AI Logic uses its v13 default (gemini-3.5-flash-lite).
 */
export function createHybridModel(
  mode = InferenceMode.PREFER_ON_DEVICE,
  cloudModelName = CLOUD_MODELS.FAST_DEFAULT,
  systemInstruction = ''
) {
  const config = {
    mode,
    inCloudParams: {
      model: cloudModelName,
      ...(systemInstruction ? { systemInstruction } : {})
    }
  };

  if (systemInstruction && mode !== InferenceMode.ONLY_IN_CLOUD) {
    config.onDeviceParams = {
      createOptions: {
        initialPrompts: [{ role: 'system', content: systemInstruction }]
      }
    };
  }

  return getGenerativeModel(ai, config);
}

// Inspect Chrome built-in Gemini Nano availability
export async function checkOnDeviceModelStatus() {
  try {
    if (typeof LanguageModel !== 'undefined' && typeof LanguageModel.availability === 'function') {
      const state = await LanguageModel.availability();
      return { supported: true, state }; // 'available' | 'downloadable' | 'downloading' | 'unavailable'
    }
    return { supported: false, state: 'unavailable' };
  } catch (err) {
    return { supported: false, state: 'unavailable', error: err?.message };
  }
}

// Trigger Chrome Gemini Nano download with progress callback if 'downloadable'
export async function warmUpOnDeviceModel(onProgress) {
  if (typeof LanguageModel === 'undefined' || typeof LanguageModel.create !== 'function') {
    throw new Error('Chrome Prompt API (LanguageModel) is not enabled in chrome://flags.');
  }
  const session = await LanguageModel.create({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        if (typeof onProgress === 'function') {
          onProgress(Math.round((e.loaded || 0) * 100));
        }
      });
    }
  });
  session.destroy();
  return checkOnDeviceModelStatus();
}
