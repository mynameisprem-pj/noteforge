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

// 2. Initialize App Check FIRST (with explicit debug token support in dev / Codespaces)
let appCheckInstance = null;

if (typeof window !== 'undefined') {
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN?.trim();
  if (import.meta.env.DEV || debugToken) {
    // Pass the pre-registered UUID string if set, otherwise `true` so Firebase logs one
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

// 3. Initialize Firebase Auth with IndexedDB persistence for true offline support
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
  ONLY_ON_DEVICE: InferenceMode.ONLY_ON_DEVICE
};

export function createHybridModel(mode = InferenceMode.PREFER_ON_DEVICE, cloudModelName = 'gemini-2.5-flash') {
  return getGenerativeModel(ai, {
    mode,
    inCloudParams: {
      model: cloudModelName
    }
  });
}

// Helper to inspect Chrome built-in Gemini Nano availability
export async function checkOnDeviceModelStatus() {
  try {
    if (typeof LanguageModel !== 'undefined' && typeof LanguageModel.availability === 'function') {
      const state = await LanguageModel.availability();
      return { supported: true, state }; // 'available' | 'downloadable' | 'downloading' | 'unavailable'
    }
    if (typeof window !== 'undefined' && window.ai?.languageModel?.capabilities) {
      const caps = await window.ai.languageModel.capabilities();
      return { supported: true, state: caps.available };
    }
    return { supported: false, state: 'unavailable' };
  } catch (err) {
    return { supported: false, state: 'unavailable', error: err?.message };
  }
}
