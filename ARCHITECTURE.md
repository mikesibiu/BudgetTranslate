# GTranslate V4 — Architecture

Real-time speech translation system. Listens to a live speaker in Romanian,
transcribes the speech, translates it to English, and displays or speaks the
result — all with under 15 seconds of lag.

Built as a practical tool for a Jehovah's Witnesses congregation where the speaker
addresses a bilingual audience.

---

## High-Level Flow

```
Browser mic
    │
    │  Raw audio (PCM 16-bit, 16kHz)
    │  WebSocket (Socket.IO)
    ▼
Node.js Server (Heroku)
    │
    ├──► Google Cloud Speech-to-Text  ──►  Streaming transcript (Romanian)
    │                                            │
    │                          TranslationRulesEngine decides: translate now?
    │                                            │
    ├──► Google Cloud Translation v3  ──►  English translation
    │       (with domain glossary)
    │
    │  Socket.IO emit
    ▼
Browser UI — display text card  or  Text-to-Speech (earbuds mode)
```

---

## Components

### 1. Browser Client (`index.html`)

Single-page app. No framework. Plain HTML/CSS/JavaScript.

**What it does:**
- Requests microphone access via `getUserMedia`
- Records audio using `MediaRecorder` in ~250ms chunks
- Sends raw audio over Socket.IO as `ArrayBuffer`
- Receives translated text from server, shows it as a card on screen
- In EarBuds mode: speaks translation via Web Speech API (`speechSynthesis`)
- Two modes selectable by user: **Talks** (visual) and **EarBuds** (audio-only)

**Key choice:** The browser does zero speech processing. It's a pure audio pipe.
All intelligence is on the server. This keeps the client simple and means the
same server can serve multiple clients simultaneously.

---

### 2. Server (`server.js`)

Node.js + Express + Socket.IO. Runs on Heroku.

One Socket.IO connection = one active speaker session. The server maintains a
completely independent state per connected client:

- `recognizeStream` — the live Google STT stream
- `accumulatedText` — full transcript so far this session
- `committedTranslation` — full English translation so far (for LCP extraction)
- `translationRules` — instance of TranslationRulesEngine
- `translationInFlight` — mutex flag (only one translation at a time)

**Connection lifecycle:**
1. Client connects → server creates a new Google STT stream
2. Client sends audio chunks → server pipes them to STT stream
3. Google returns interim/final transcripts → server runs translation rules
4. Translation fires → result emitted to client
5. STT stream proactively restarted at 290s (Google hard limit is ~305s)
6. Client disconnects → all state torn down

**The 290-second restart problem** was the hardest engineering challenge.
Google's STT streaming API silently dies around 305 seconds. The solution:
- Start a timer when the stream opens
- At 290s, gracefully close the stream and open a new one
- Preserve `accumulatedText` across the restart (not a new session)
- Reset `committedTranslation` so the LCP extraction starts fresh on the new stream

---

### 3. Translation Rules Engine (`translation-rules-engine.js`)

A standalone class that makes one decision: **should we translate right now?**

This is intentionally separated from the server so it can be unit-tested in isolation.

**Decision priority order:**

| Priority | Trigger | When |
|----------|---------|------|
| 1 | Sentence ending | Transcript ends in `.` `!` `?` and has ≥6 words |
| 2 | Max interval | 15 seconds since last translation, regardless of pauses |
| 3 | Final result | Google marks this STT chunk as final and has ≥6 words |
| 4 | Pause detected | No new words for 4 seconds |

**Why 15 seconds for max interval?**
Fast Romanian speakers can produce 80+ words in 15 seconds. Shorter intervals
caused choppy translations without enough context. 15s balances responsiveness
with translation accuracy.

**Duplicate suppression:**
The engine tracks the last 20 seconds of translated output. If a new translation
is ≥80% similar to something recently shown (word-overlap algorithm), it's
silently dropped. This prevents repeated output when Google returns near-identical
results for slightly different phrasings of the same text.

**New-text extraction:**
Before translating, the engine computes what text is *new* since the last
translation:
- If current transcript starts with the last-translated text → extract the tail
- If 65%+ overlap with last-translated text → consider it a duplicate, skip
- Otherwise → treat as a new utterance, send in full

---

### 4. Translation Pipeline

**Strategy: full-context translation + LCP extraction.**

This was the key insight that made translation quality work.

**Naive approach (rejected):** Translate only the new chunk of text since last
translation. Problem: short chunks lose context and produce poor translations.
"słujitorii" by itself → Google guesses wrong. In the full sentence it's obvious.

**Full-context approach:**
1. Send the **entire accumulated Romanian transcript** to Google Translation
2. Google returns a full English translation with context → much better quality
3. Compare the new full translation to the `committedTranslation` (what was
   already shown to the user)
4. Use **word-level Longest Common Prefix (LCP) matching** to extract only the
   new tail
5. Emit only the new tail to the client
6. Store the full translation as `committedTranslation` for the next cycle

**LCP matching (60% threshold):** The new full translation is expected to start
with roughly the same words as `committedTranslation`. If ≥60% of the committed
words match the start of the new translation, the tail (new words) is extracted.
If the match fails (Google rephrased heavily), fall back to translating the chunk
alone.

**Post-translation corrections** applied after every translation:
- Domain term replacements: `congress → convention`, `church → congregation`,
  `vestitori → publishers`
- Source number preservation: numbers in the Romanian source are copied to the
  English output (Google sometimes drops or changes them)
- Date preservation: keeps date formats consistent

---

### 5. Domain Glossary (Google Cloud Translation API)

Google's Translation API v3 supports a custom glossary — a CSV of
`romanian_term,english_term` pairs that the model is required to use.

**Glossary: 734 entries** covering:
- Core JW terminology: `congregație→congregation`, `congres→convention`,
  `vestitor→publisher`, `Iehova→Jehovah`, `Sala Regatului→Kingdom Hall`
- Bible books: `Eclesiastul→Ecclesiastes`, `Deuteronomul→Deuteronomy`, etc.
- People: `Avraam→Abraham`, `Iacov→Jacob`, `Moise→Moses`, etc.
- Concepts: `răscumpărare→ransom`, `mântuire→salvation`, `speranță→hope`

**How it was built:**
1. Downloaded JW.org publications in `.jwpub` format (a ZIP containing a SQLite DB)
2. Extracted Romanian vocabulary from the SQLite search index
3. Translated each term via Google Translate API v2
4. Validated each translation by checking it appeared verbatim in the official
   English edition of the same publication (ground-truth validation)
5. Manually curated a core set of 104 JW-specific terms as a guaranteed baseline
6. Uploaded CSV to Google Cloud Storage, created glossary via Translation API

**Hosted:** `gs://mlf-gtranslate-glossaries/ro-en-religious-terms.csv`
**Glossary ID:** `ro-en-religious-terms`

Note: even with the glossary enabled, Google's model sometimes overrides it
(especially for words like `congres` which also means "congress" in a political
context). These overrides are caught by the post-translation term mapping layer.

---

### 6. Database (`billing-db.js`)

PostgreSQL via Heroku Postgres (free tier).

**Tables:**
- `usage_log` — per-session usage tracking (audio seconds, translation count,
  language pair, client IP). Used for billing/monitoring.
- `translation_log` — rolling 45-minute log of every translation event
  (source text, translated text, reason, app version). Used for debugging.
  Auto-purged: rows older than 45 minutes are deleted on every write.
  Hard cap: 500 rows maximum (free-tier safety).

The translation log uses a **lazy cleanup** pattern — no background timer.
Every `INSERT` first runs two `DELETE` statements (age purge + row cap), then
inserts. This keeps the table small without any scheduled jobs.

---

### 7. Deployment

**Platform:** Heroku (single web dyno)

**Environment variables:**
```
GOOGLE_CREDENTIALS_JSON   — Service account JSON (base64 or raw)
GOOGLE_CLOUD_PROJECT      — GCP project ID (mlf-gtranslate)
GOOGLE_CLOUD_LOCATION     — us-central1
GLOSSARY_ENABLED          — true/false
DATABASE_URL              — Heroku Postgres connection string
```

**Credentials handling:** In production, the Google service account JSON is
stored as a Heroku config var (`GOOGLE_CREDENTIALS_JSON`). On startup, the server
parses it and initializes both the Speech and Translation clients with explicit
credentials. No credentials files on disk in production.

---

## What Didn't Work (and Why)

Understanding the failures is as useful as the final design.

**Chunk-only translation** — Translating only the new text since the last
translation gave poor results. Short Romanian fragments like "suferința" or
"slujitorii" lack the sentence context Google needs.

**Streaming translation** — Translating every interim STT result (every partial
word) caused a flood of partial, conflicting translations. The rules engine with
minimum word counts and timing gates solved this.

**Short max intervals (8 seconds)** — With fast Romanian speakers, 8s of speech
often isn't a complete thought. 15s gives Google enough context to produce a
coherent sentence.

**PDF-based glossary building** — Extracted text from PDF publications and tried
to build a glossary. PDF text extraction concatenates words at line breaks
(`acitireabibiliei` instead of `a citirea bibliei`), producing ~95% garbage.
JWPUB format (SQLite inside a ZIP) solved this completely.

**Glossary alone isn't enough** — The Translation API glossary enforces most
terms, but Google's model confidently overrides some entries (like `congres →
congress`). The post-translation term mapping layer in the server is the final
safety net.

---

## Key Libraries

| Library | Purpose |
|---------|---------|
| `@google-cloud/speech` | Streaming speech-to-text |
| `@google-cloud/translate` | Translation API v3 with glossary support |
| `socket.io` | WebSocket communication (audio in, text out) |
| `express` | HTTP server + static file serving |
| `winston` | Structured logging |
| `pg` | PostgreSQL client |

---

## File Structure

```
server.js                    Main server — STT stream, translation pipeline
translation-rules-engine.js  Decision engine — when to translate
billing-db.js                PostgreSQL usage and translation logging
index.html                   Browser client — mic capture, UI, TTS
glossaries/
  glossary_final.csv         734-entry domain glossary (source of truth)
  upload-to-gcloud.sh        Script to upload glossary to GCS
glossary-temp/
  lff_M.jwpub                Romanian JW publication (source for glossary)
  lff_E.jwpub                English JW publication (validation reference)
  build-glossary-from-jwpub.js  Glossary builder from JWPUB files
test/
  translation-rules-engine.test.js  Unit tests for rules engine
```

---

## Approximate Cost (Google Cloud)

- **Speech-to-Text:** ~$0.016 per minute of audio (Chirp model, streaming)
- **Translation API v3:** ~$20 per million characters (advanced model + glossary)
- **Cloud Storage:** Negligible (one small CSV file)
- **Heroku Postgres:** Free tier (10,000 rows limit)
- **Heroku Dyno:** Eco dyno ~$5/month

For a typical 1-hour meeting with one speaker, approximate cost is under $2.
