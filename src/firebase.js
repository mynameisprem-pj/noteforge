import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore/lite';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  signInWithPopup,
  linkWithPopup,
  signInAnonymously,
  signOut,
  onIdTokenChanged
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

const PROMPT_API_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
      !firebaseConfig.apiKey.includes('your_') &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

export const firebaseApp = initializeApp(firebaseConfig);

let appCheckInstance = null;

if (typeof window !== 'undefined') {
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN?.trim();
  if (import.meta.env.DEV) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken && !debugToken.includes('your_') ? debugToken : true;
  }

  const siteKey = import.meta.env.VITE_RECAPTCHA_V3_SITE_KEY?.trim();
  if (siteKey && !siteKey.includes('your_')) {
    appCheckInstance = initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: navigator.onLine
    });
  }
}

export const appCheck = appCheckInstance;

export async function verifyAppCheckStatus() {
  if (!appCheckInstance) {
    return { ok: false, detail: 'Missing VITE_RECAPTCHA_V3_SITE_KEY in .env' };
  }
  if (!navigator.onLine) {
    return { ok: true, detail: 'Offline mode (cached session)' };
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

export const auth = initializeAuth(firebaseApp, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: browserPopupRedirectResolver
});

const googleProvider = new GoogleAuthProvider();

export const signInGuest = () => signInAnonymously(auth);

/**
 * Upgrades anonymous Guest session to Google when possible, or signs into existing Google account.
 */
export async function signInGoogle() {
  if (auth.currentUser && auth.currentUser.isAnonymous) {
    try {
      const linked = await linkWithPopup(auth.currentUser, googleProvider, browserPopupRedirectResolver);
      return linked;
    } catch (err) {
      // If this Google account was already used before, sign into it normally
      if (
        err?.code === 'auth/credential-already-in-use' ||
        err?.code === 'auth/email-already-in-use'
      ) {
        return signInWithPopup(auth, googleProvider, browserPopupRedirectResolver);
      }
      throw err;
    }
  }
  return signInWithPopup(auth, googleProvider, browserPopupRedirectResolver);
}

export const logOutUser = () => signOut(auth);
export { onIdTokenChanged };

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
  FAST_DEFAULT: 'gemini-3.5-flash-lite',
  DEEP_SYNTHESIS: 'gemini-3.8-flash'
};

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

  if (mode !== InferenceMode.ONLY_IN_CLOUD) {
    config.onDeviceParams = {
      createOptions: {
        ...PROMPT_API_OPTIONS,
        ...(systemInstruction
          ? { initialPrompts: [{ role: 'system', content: systemInstruction }] }
          : {})
      }
    };
  }

  return getGenerativeModel(ai, config);
}

export async function checkOnDeviceModelStatus() {
  try {
    if (typeof LanguageModel !== 'undefined' && typeof LanguageModel.availability === 'function') {
      const state = await LanguageModel.availability(PROMPT_API_OPTIONS);
      return { supported: true, state };
    }
    return { supported: false, state: 'unavailable' };
  } catch (err) {
    return { supported: false, state: 'unavailable', error: err?.message };
  }
}

export async function warmUpOnDeviceModel(onProgress) {
  if (typeof LanguageModel === 'undefined' || typeof LanguageModel.create !== 'function') {
    throw new Error('Chrome Prompt API (LanguageModel) is not enabled in chrome://flags.');
  }
  const session = await LanguageModel.create({
    ...PROMPT_API_OPTIONS,
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

export const firestoreDb = getFirestore(firebaseApp);
export { collection, doc, getDocs, setDoc, deleteDoc };
