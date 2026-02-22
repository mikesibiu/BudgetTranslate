# GTranslate V4 — Budget / Free-Tier Analysis

This document describes what would need to change to run the full translation pipeline
at **$0/month** using free tiers and free browser APIs.

Usage baseline: ~4 hours of active speech translation per week (one meeting/week).

---

## Current Paid Services and Their Costs

| Service | Current Provider | ~Cost/month |
|---|---|---|
| Speech-to-Text | Google Cloud STT (Chirp, streaming) | ~$6.48 |
| Translation API | Google Cloud Translation v3 + glossary | ~$0 (within 500K free) |
| Glossary storage | Google Cloud Storage | ~$0.01 |
| Database | Heroku Postgres | $5.00 |
| Hosting | Heroku Eco Dyno | $5.00 |
| **Total** | | **~$16.50/month** |

---

## Recommended Free Stack

| Service | Replace With | Cost |
|---|---|---|
| Google Cloud STT | **Web Speech API** (browser-native) | $0 |
| Google Cloud Translation v3 | Keep (already within free tier) | $0 |
| Google Cloud Storage | GitHub raw file URL (already in repo) | $0 |
| Heroku Postgres | **Neon** (free PostgreSQL) | $0 |
| Heroku Dyno | **Koyeb** (free always-on Node.js) | $0 |
| **Total** | | **$0/month** |

---

## Change 1: Speech-to-Text → Web Speech API (biggest change)

### What the Web Speech API gives us

The browser's built-in `webkitSpeechRecognition` (Chrome, Edge) sends audio to Google's
servers on the back end — the same Google ASR infrastructure as the paid Cloud API.
Accuracy for Romanian (`ro-RO`) is comparable to the paid standard model.

**Cost:** Completely free. No API key. No server-side audio processing.

**Browser requirement:** Chrome or Edge (Chromium-based). Firefox has no SpeechRecognition support.

### Architecture shift

**Current flow:**
```
Browser mic → raw PCM audio (WebSocket) → Server → Google STT → transcript → Server → translate → Client
```

**Budget flow:**
```
Browser mic → Web Speech API → transcript text (WebSocket) → Server → translate → Client
```

This is a major simplification. The server **stops receiving audio entirely** and instead
receives text transcripts from the browser.

### What gets removed from `server.js`

- `@google-cloud/speech` dependency and `speechClient` initialization
- All Google credentials setup (still needed for Translation API)
- `createRecognitionStream()` — the entire 250-line STT stream management function
- `scheduleAutoRestart()` — the 290-second restart logic (no longer needed)
- `cleanupStream()` — stream teardown
- `recognizeStream` variable and all its state
- Audio buffering during restart (`audioBufferDuringRestart`)
- Audio chunk rate limiting and size validation
- `socket.on('audio-data')` handler — no longer receiving audio
- STT phrase hints (`STT_PHRASE_HINTS` array) — no control over Web Speech API hints
- `STREAM_DURATION_LIMIT_MS` constant

### New socket protocol

**Client → Server (replaces `start-streaming` / `audio-data` / `stop-streaming`):**

| Old event | New event | Payload |
|---|---|---|
| `start-streaming` | `start-session` | `{ sourceLanguage, targetLang, mode }` |
| `audio-data` | `transcript-result` | `{ text, isFinal }` |
| `stop-streaming` | `stop-session` | *(none)* |

**Server → Client (unchanged):**
- `translation-result` — same as before
- `translation-error` — same as before
- `session-started` / `session-stopped` (renamed from `streaming-started` / `streaming-stopped`)

### New `socket.on('transcript-result')` handler in server.js

The server receives text instead of audio. The translation logic is identical — pass the
transcript through `translationRules.shouldTranslate()` and then `performTranslation()`.

```javascript
socket.on('transcript-result', async ({ text, isFinal }) => {
    if (!sessionActive || !translationRules) return;

    updateActivity();

    const textChanged = text !== lastInterimText;
    lastInterimText = text;

    // Visual feedback — re-emit the transcript so UI can show it
    socket.emit('interim-result', { text, isFinal });

    const decision = translationRules.shouldTranslate({
        text,
        isFinal,
        timeSinceLastChange: textChanged ? 0 : (Date.now() - (lastTextChangeTime || Date.now())),
        trigger: isFinal ? 'final' : 'interim',
        clientId
    });

    if (textChanged) lastTextChangeTime = Date.now();

    if (decision.shouldTranslate && !translationInFlight) {
        await performTranslation(text, decision, true);
    } else if (!isFinal && !restartStreamTimer && textChanged && translationRules) {
        const pauseMs = translationRules.getConfig().pauseDetectionMs;
        restartStreamTimer = setTimeout(async () => {
            const pauseDecision = translationRules.shouldTranslate({
                text: lastInterimText, isFinal: false,
                timeSinceLastChange: pauseMs, trigger: 'pause', clientId
            });
            if (pauseDecision.shouldTranslate && sessionActive && !translationInFlight) {
                await performTranslation(lastInterimText, pauseDecision, false);
            }
            restartStreamTimer = null;
        }, pauseMs);
    }
});
```

### Changes to `index.html`

Replace the `MediaRecorder` / `AudioWorklet` audio capture section with Web Speech API:

```javascript
const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.lang = 'ro-RO';
recognition.continuous = true;
recognition.interimResults = true;

recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        const isFinal = event.results[i].isFinal;
        socket.emit('transcript-result', { text: transcript, isFinal });
    }
};

// Auto-restart on end (Chrome cuts off at ~60 seconds)
recognition.onend = () => {
    if (isListening) recognition.start();
};

recognition.onerror = (event) => {
    console.error('Web Speech API error:', event.error);
};
```

The `audio-processor.js` AudioWorklet file is no longer needed.

### Trade-offs vs. paid Google STT

| Feature | Web Speech API | Google Cloud STT (paid) |
|---|---|---|
| Cost | Free | ~$6.48/month |
| Romanian accuracy | Good (Google backend) | Better (Chirp model) |
| Custom phrase hints | No | Yes (STT_PHRASE_HINTS) |
| Browser requirement | Chrome/Edge only | Any browser |
| 290s restart complexity | Gone | Needed |
| Server audio handling | Gone | Complex |
| Offline fallback | No | No |
| Network: audio leaves browser | Still goes to Google | Goes to your server then Google |

**Key limitation:** The phrase hints (`vestitori`, `Martorii lui Iehova`, etc.) can no
longer be injected. Some STT mis-hearings that were fixed by phrase hints may reappear.
The post-translation `applyTermMappings()` function remains as the safety net.

---

## Change 2: Database → Neon (free PostgreSQL)

**No code changes required.** Neon is fully PostgreSQL-compatible.

Just set `DATABASE_URL` to the Neon connection string in the hosting platform's
environment variables. `billing-db.js` works unchanged.

**Neon free tier:** 500 MB storage, scale-to-zero (wakes in <1 second). For a weekly
meeting app this is fine — the DB wakes on the first query of the meeting.

Sign up at https://neon.tech → create project → copy connection string.

---

## Change 3: Hosting → Koyeb (free always-on Node.js)

**No code changes required** for the app itself. Koyeb's free tier gives:
- 1 always-on web service (no sleep/hibernation)
- 512 MB RAM, 0.1 vCPU
- WebSocket support (Socket.IO works)

Since the budget version offloads STT to the browser and translation to Google's API,
the server is purely I/O-bound (WebSocket relay + API calls). 0.1 vCPU is sufficient.

**Deployment:** Connect GitHub repo to Koyeb, set environment variables, deploy.

Environment variables needed on Koyeb:
```
GOOGLE_CREDENTIALS_JSON   (same service account JSON — still needed for Translation API)
GOOGLE_CLOUD_PROJECT      mlf-gtranslate
GOOGLE_CLOUD_LOCATION     us-central1
GLOSSARY_ENABLED          true
DATABASE_URL              (Neon connection string)
NODE_ENV                  production
```

**CORS update:** Add the Koyeb app URL to the `allowedOrigins` array in `server.js`.

---

## Change 4: Glossary Storage (already ~free, minor cleanup)

The glossary CSV is already in the GitHub repo at `glossaries/glossary_final.csv`.
Google Cloud Storage was needed to feed the Translation API v3 glossary creation — but
once the glossary is created and active in GCP, the GCS file is no longer read at
runtime. The GCS cost is effectively $0.

If you wanted to eliminate GCS entirely, you would need to either:
1. Keep the existing GCP glossary (already created, no ongoing GCS cost)
2. Switch to DeepL's glossary API (see below)

No action needed here — GCS cost is already negligible.

---

## Alternative: DeepL API Free (if leaving Google Translation too)

If you want to eliminate all Google Cloud services entirely, **DeepL API Free** is
a viable translation backend:

- 500,000 characters/month free (same as Google's free tier)
- **Glossary support included on free tier** (up to 1,000 entries per glossary)
- Often produces more natural-sounding European language translations
- No GCP project, no service account JSON needed

**Trade-offs:**
- DeepL's free tier may use your translations for model training
- API is different from Google's (need to swap `@google-cloud/translate` for `deepl-node`)
- Would need to re-upload the 734-entry glossary to DeepL's glossary API

At current usage (~4 hours/week ≈ 200,000-300,000 chars/month), either Google or DeepL
stays within their respective free tiers.

---

## Summary: Files That Change

| File | Change Required |
|---|---|
| `server.js` | Remove Google STT client; remove `createRecognitionStream`, `scheduleAutoRestart`, `cleanupStream`, audio buffering, audio socket handler; add `socket.on('transcript-result')` handler |
| `index.html` | Replace MediaRecorder/AudioWorklet with Web Speech API; update socket events |
| `audio-processor.js` | **Delete** — AudioWorklet no longer needed |
| `package.json` | Remove `@google-cloud/speech` dependency |
| `billing-db.js` | No changes |
| `translation-rules-engine.js` | No changes |
| `ARCHITECTURE.md` | Update to reflect new STT approach |

### Environment variable changes

| Variable | Old | New |
|---|---|---|
| `DATABASE_URL` | Heroku Postgres URL | Neon PostgreSQL URL |
| *(deploy target)* | Heroku | Koyeb |
| All Google vars | Unchanged | Unchanged (still need Translation API) |

---

## What We Learned That Makes This Viable

1. **The 290-second restart problem disappears.** This was the hardest engineering
   challenge in the original build. Web Speech API handles reconnection automatically.

2. **The server simplifies dramatically.** Removing audio ingestion eliminates ~40%
   of the server code (all the STT stream management, audio buffering, format detection,
   rate limiting).

3. **Translation quality stays the same.** The full-context translation + LCP extraction
   approach, the glossary, and the `applyTermMappings()` corrections all remain intact.
   The only quality risk is losing STT phrase hints.

4. **The free Google Translation tier is generous enough.** At ~4 hours/week, you use
   roughly 200,000-300,000 characters/month — comfortably within Google's 500,000/month
   free tier. Current production likely costs $0 for translation already.

5. **Neon and Koyeb are production-ready.** These aren't hobby toys — Neon was acquired
   by Databricks and Koyeb has enterprise customers. Their free tiers are stable.
