'use strict';

/**
 * STT Replay Harness — end-to-end event sequence tests
 *
 * These tests simulate realistic sequences of Google Cloud STT events
 * (interim → interim → isFinal → next utterance) flowing through the full
 * TranslationRulesEngine pipeline.
 *
 * Unit tests in translation-rules-engine.test.js call functions in isolation.
 * This file tests STATE TRANSITIONS across a sequence of calls — the class of
 * bugs that slips through individual unit tests.
 */

const { expect } = require('chai');
const TranslationRulesEngine = require('../translation-rules-engine');

const mockLogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {}
};

/**
 * Feed an ordered list of STT events through the engine and return all
 * approved decisions in order.
 *
 * Each event: { text, isFinal, trigger, timeSinceLastChange? }
 * Optional `advanceIntervalMs`: set lastTranslationTime that many ms in
 * the past before processing this event (simulates time passing).
 */
function replayEvents(engine, events) {
    const approved = [];
    for (const ev of events) {
        if (ev.advanceIntervalMs) {
            engine.lastTranslationTime = Date.now() - ev.advanceIntervalMs;
        }
        const decision = engine.shouldTranslate({
            text: ev.text,
            isFinal: ev.isFinal || false,
            timeSinceLastChange: ev.timeSinceLastChange || 0,
            trigger: ev.isFinal ? 'final' : 'interim',
            clientId: 'replay-test'
        });
        if (decision.shouldTranslate) {
            approved.push({ decision, text: ev.text });
        }
    }
    return approved;
}

// ─────────────────────────────────────────────────────────────────
// Scenario 1: Growing utterance — interval fires once mid-utterance
// ─────────────────────────────────────────────────────────────────
describe('STT Replay: growing utterance', () => {
    it('interval fires once mid-utterance — not on every interim', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        const events = [
            { text: 'Fratii', isFinal: false, timeSinceLastChange: 0 },
            { text: 'Fratii nostri', isFinal: false, timeSinceLastChange: 100 },
            { text: 'Fratii nostri buni', isFinal: false, timeSinceLastChange: 200 },
            // Simulate 16 seconds elapsed — interval fires on this event
            { text: 'Fratii nostri buni sa fie binecuvantati astazi si in viata lor', isFinal: false, timeSinceLastChange: 200, advanceIntervalMs: 16000 },
        ];

        const approved = replayEvents(engine, events);
        expect(approved).to.have.length(1);
        expect(approved[0].decision.reason).to.equal('max_interval');
        expect(approved[0].text).to.include('binecuvantati');
    });

    it('isFinal after interval carries additional words — both fire, in order', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        const events = [
            // Interval fires at this event — needs ≥6 words to pass the interim quality check
            { text: 'Fratii nostri buni sa fie astazi', isFinal: false, advanceIntervalMs: 16000 },
            // isFinal adds two more words (2-word continuation tail)
            { text: 'Fratii nostri buni sa fie astazi binecuvantati Amin', isFinal: true },
        ];

        const approved = replayEvents(engine, events);
        // Interval fires on event 1; isFinal fires on event 2 with 2-word tail
        expect(approved).to.have.length(2);
        expect(approved[0].decision.reason).to.equal('max_interval');
        expect(approved[1].decision.reason).to.equal('final_result');
        // The tail extracted for event 2 is 'binecuvantati Amin' (2 words)
        // This would have been DROPPED before the isContinuationTail fix
        expect(approved[1].decision.newText).to.match(/binecuvantati\s+Amin/i);
    });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 2: Pause detection fires mid-utterance, then isFinal tail
// (The exact production bug that caused word dropping)
// ─────────────────────────────────────────────────────────────────
describe('STT Replay: pause mid-utterance → isFinal short tail', () => {
    it('pause timer fires, then isFinal delivers 2-word tail — NOT dropped', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        // Step 1: Pause timer fires after 4+ seconds of silence
        const pauseDecision = engine.shouldTranslate({
            text: 'ne putem uita la punctul de conexiune dintre congregatie si edificare',
            isFinal: false,
            timeSinceLastChange: 5000,  // 5s with no change → pause detected
            trigger: 'pause',
            clientId: 'replay-test'
        });
        expect(pauseDecision.shouldTranslate).to.be.true;
        expect(pauseDecision.reason).to.equal('pause_detected');

        // Step 2: isFinal fires with the complete utterance (2 new words appended)
        // Before the fix: 'si pace' (2 words) < MIN_WORDS(6) → dropped
        // After the fix: isContinuationTail → threshold 2 → passes
        const finalDecision = engine.shouldTranslate({
            text: 'ne putem uita la punctul de conexiune dintre congregatie si edificare si pace',
            isFinal: true,
            timeSinceLastChange: 0,
            trigger: 'final',
            clientId: 'replay-test'
        });
        expect(finalDecision.shouldTranslate).to.be.true;
        expect(finalDecision.reason).to.equal('final_result');
        expect(finalDecision.newText).to.match(/si\s+pace/i);
    });

    it('interval fires mid-utterance, isFinal delivers 2-word tail — NOT dropped', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        // Step 1: 15s interval fires mid-utterance
        engine.lastTranslationTime = Date.now() - 16000;
        const intervalDecision = engine.shouldTranslate({
            text: 'ne putem uita la punctul de conexiune dintre congregatie si edificare',
            isFinal: false,
            timeSinceLastChange: 100,
            trigger: 'interim',
            clientId: 'replay-test'
        });
        expect(intervalDecision.shouldTranslate).to.be.true;
        expect(intervalDecision.reason).to.equal('max_interval');

        // Step 2: Same as above — 2-word tail must not be dropped
        const finalDecision = engine.shouldTranslate({
            text: 'ne putem uita la punctul de conexiune dintre congregatie si edificare si pace',
            isFinal: true,
            timeSinceLastChange: 0,
            trigger: 'final',
            clientId: 'replay-test'
        });
        expect(finalDecision.shouldTranslate).to.be.true;
        expect(finalDecision.newText).to.match(/si\s+pace/i);
    });

    it('1-word isFinal tail is still dropped even with isContinuationTail (threshold is 2)', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        engine.lastTranslationTime = Date.now() - 16000;
        engine.shouldTranslate({
            text: 'ne putem uita la punctul de conexiune dintre congregatie si edificare',
            isFinal: false, timeSinceLastChange: 100, trigger: 'interim', clientId: 'test'
        });

        const finalDecision = engine.shouldTranslate({
            text: 'ne putem uita la punctul de conexiune dintre congregatie si edificare Amin',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        // 'Amin' = 1 word < threshold 2 → still rejected
        expect(finalDecision.shouldTranslate).to.be.false;
        expect(finalDecision.reason).to.equal('too_few_words');
    });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 3: Two consecutive utterances
// ─────────────────────────────────────────────────────────────────
describe('STT Replay: consecutive utterances', () => {
    it('first utterance finalizes, second utterance fires correctly', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        // Utterance 1 isFinal
        engine.lastTranslationTime = Date.now() - 16000;
        const d1 = engine.shouldTranslate({
            text: 'Iehova este suveranul Universului nostru',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        expect(d1.shouldTranslate).to.be.true;

        // Utterance 2 — completely different topic, 3 words, isFinal
        // Should fire as standalone isFinal (threshold 3)
        const d2 = engine.shouldTranslate({
            text: 'prin regatul ceresc',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        expect(d2.shouldTranslate).to.be.true;
        expect(d2.reason).to.equal('final_result');
    });

    it('second utterance does not get suppressed as duplicate of first', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        engine.lastTranslationTime = Date.now() - 16000;
        engine.shouldTranslate({
            text: 'ne bucuram ca suntem creatie ta',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });

        // New utterance that shares NO words with the first
        engine.lastTranslationTime = Date.now() - 16000;
        const d2 = engine.shouldTranslate({
            text: 'ajuta-ne sa fim vestitori buni credinciosia ta',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        expect(d2.shouldTranslate).to.be.true;
    });

    it('genuinely repeated utterance (speaker says same thing twice) IS suppressed', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);

        engine.lastTranslationTime = Date.now() - 16000;
        engine.shouldTranslate({
            text: 'va multumim foarte mult pentru raspuns',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });

        // Same words again — should be suppressed as duplicate
        const d2 = engine.shouldTranslate({
            text: 'va multumim foarte mult pentru raspuns',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        expect(d2.shouldTranslate).to.be.false;
    });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 4: Short standalone utterances (Q&A, responses)
// ─────────────────────────────────────────────────────────────────
describe('STT Replay: short utterances in Q&A context', () => {
    it('3-word standalone isFinal fires (threshold 3)', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);
        const d = engine.shouldTranslate({
            text: 'da foarte bine',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        expect(d.shouldTranslate).to.be.true;
        expect(d.reason).to.equal('final_result');
    });

    it('2-word standalone isFinal does NOT fire (below threshold 3)', () => {
        const engine = new TranslationRulesEngine('talks', mockLogger);
        const d = engine.shouldTranslate({
            text: 'multumesc bine',
            isFinal: true, timeSinceLastChange: 0, trigger: 'final', clientId: 'test'
        });
        expect(d.shouldTranslate).to.be.false;
    });
});
