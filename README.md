# NoteForge — Offline-First Hybrid AI Research Companion

Built for **#BuildHybridAI 2026** using **Firebase AI Logic**, **Chrome Built-in Gemini Nano**, **Gemini Cloud Fallback**, **IndexedDB**, **Cloud Firestore Lite**, **Firebase Authentication**, and **Firebase App Check**.

NoteForge is an offline-first notes and field research workspace engineered for environments with intermittent connectivity and strict data-privacy boundaries. Every AI generation transparently reports whether inference executed **`⚡ On device`** or in the **`☁️ Cloud`**.

---

## Core Hybrid AI Architecture

```text
+-------------------------------------------------------------------------+
|                        NoteForge Web Client (PWA)                       |
|  Vite 8 Vanilla JS  •  Service Worker Asset Cache  •  IndexedDB Vault   |
+------------------------------------+------------------------------------+
                                     |
                      +--------------+--------------+
                      |  Hybrid Routing Controller  |
                      |      (src/ai-service.js)    |
                      +--------------+--------------+
                                     |
          +--------------------------+--------------------------+
          |                                                     |
          v                                                     v
+-----------------------------------+       +-----------------------------------+
|   PREFER_ON_DEVICE (Default)      |       |   ONLY_ON_DEVICE (Privacy Lock)   |
| • Short notes (<4,500 chars):     |       | • Strictly executes via local     |
|   Tries Chrome Gemini Nano first; |       |   Gemini Nano on-device           |
|   falls back to Cloud seamlessly  |       | • Refuses cloud fallback if       |
| • Multi-note synthesis / long     |       |   hardware/model unavailable      |
|   docs: Routes to Cloud Gemini    |       | • Pauses background Firestore     |
|   when online                     |       |   note synchronization            |
+-----------------------------------+       +-----------------------------------+

```

### Capability & Routing Matrix

| Capability | Default Mode (`PREFER_ON_DEVICE`) | Privacy Lock (`ONLY_ON_DEVICE`) | Provenance Badge |
| --- | --- | --- | --- |
| **Summarize Note** | On-device Gemini Nano first -> Cloud fallback | Local Gemini Nano only (Cloud refused) | `⚡ On device` / `☁️ Cloud` |
| **Auto-Tag Note** | On-device Gemini Nano first -> Cloud fallback | Local Gemini Nano only (Cloud refused) | `⚡ On device` / `☁️ Cloud` |
| **Rewrite (Clarity / Executive / Academic)** | On-device Gemini Nano first -> Cloud fallback | Local Gemini Nano only (Cloud refused) | `⚡ On device` / `☁️ Cloud` |
| **Single-Note Q&A** | On-device Gemini Nano first -> Cloud fallback | Local Gemini Nano only (Cloud refused) | `⚡ On device` / `☁️ Cloud` |
| **Multimodal Image Scan (`📷 Scan Image`)** | Multimodal Gemini Nano first -> Cloud fallback | Local Multimodal Nano only (Cloud refused) | `⚡ On device` / `☁️ Cloud` |
| **Multi-Note Research Synthesis (2+ Notes)** | Cloud Gemini reasoning (`[Note N]` citations) | Blocked locally unless local model handles request | `☁️ Cloud` / `⚡ On device` |

---

## Key Technical Highlights

* **Real-Time Token Streaming (`generateContentStream`) & Multimodal Vision:** Streams AI summaries, rewrites, syntheses, and whiteboard/handwritten photo transcriptions live word-by-word with client-side canvas image compression.
* **Transparent Execution Provenance:** Reads `result.response.inferenceSource` from `firebase/ai` on every response, displaying a persistent **`⚡ On device`** or **`☁️ Cloud`** badge alongside execution latency (`ms`) and active policy mode.
* **True Offline-First Storage & PWA Shell:**
* Notes, tags, and AI provenance history write to **IndexedDB** (`idb`) first in `<5ms`.
* A custom zero-dependency Service Worker (`public/sw.js` + `scripts/inject-sw.mjs`) pre-caches hashed Vite bundles so the entire workspace loads and functions with Wi-Fi disabled.


* **User-Isolated Workspaces & Cross-Browser Sync:**
* **Guest Mode:** Immediate local workspace seeded with field-research notes; zero sign-up friction.
* **Google Sign-In (`firebase/auth` + `firebase/firestore/lite`):** Seamlessly migrates Guest drafts on first sign-in, syncs notes across desktop and mobile browsers via per-UID Firestore security rules, queues offline edits/deletions for automatic reconnection sync, and isolates private notes upon Sign Out.


* **Security & Zero-Bloat Stack:**
* **Firebase App Check** (reCAPTCHA v3 in production + explicit debug token support in local/Codespaces development).
* Sanitized Markdown rendering via `marked` + `DOMPurify`.
* Built on **Vite 8 + Vanilla ES Modules** with **0 deprecated packages** and **0 `npm audit` vulnerabilities**.



---

## Enabling Chrome On-Device Gemini Nano (Optional for Local Hardware Testing)

NoteForge works out of the box on **all** modern browsers via automatic Cloud fallback. To experience `⚡ On device` local inference on eligible desktop hardware (Chrome 139+, 4GB+ VRAM / eligible CPU-GPU class):

1. Open `chrome://flags/#prompt-api-for-gemini-nano` and `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` -> set to **Enabled**.
2. Relaunch Chrome and check `chrome://components` -> **Optimization Guide On Device Model** -> **Check for update**.
3. Click the **Ready** status pill in NoteForge's top bar to inspect live Gemini Nano readiness in the **Hybrid Runtime Diagnostics** popover.

---

## Local Development Setup

1. Clone the repository and install dependencies:
```bash
git clone [https://github.com/mynameisprem-pj/noteforge.git](https://github.com/mynameisprem-pj/noteforge.git)
cd noteforge
npm install

```


2. Copy `.env.example` to `.env` and populate your Firebase project credentials, reCAPTCHA v3 site key, and (for local/Codespaces dev) an App Check debug token:
```bash
cp .env.example .env

```


3. Start the Vite development server:
```bash
npm run dev

```


4. Build and preview the offline-capable production bundle:
```bash
npm run build
npm run preview

```



---

## License

Apache License 2.0 (see [LICENSE](./LICENSE))
