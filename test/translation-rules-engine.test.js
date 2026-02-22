/**
 * Unit Tests for TranslationRulesEngine
 * Tests centralized translation decision logic
 */

const { expect } = require('chai');
const TranslationRulesEngine = require('../translation-rules-engine');

// Mock logger
const mockLogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {}
};

describe('TranslationRulesEngine', () => {

    describe('Mode Configurations', () => {
        it('should load Talks mode configuration', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);
            const config = engine.getConfig();

            expect(config.name).to.equal('Talks');
            expect(config.translationInterval).to.equal(15000);
            expect(config.pauseDetectionMs).to.equal(4000);
            expect(config.displayVisualCards).to.be.true;
        });

        it('should load EarBuds mode configuration', () => {
            const engine = new TranslationRulesEngine('earbuds', mockLogger);
            const config = engine.getConfig();

            expect(config.name).to.equal('EarBuds');
            expect(config.translationInterval).to.equal(15000);
            expect(config.enableTTS).to.be.true;
            expect(config.displayVisualCards).to.be.false;
        });

        it('should default to Talks mode for invalid mode', () => {
            const engine = new TranslationRulesEngine('invalid', mockLogger);
            const config = engine.getConfig();

            expect(config.name).to.equal('Talks');
        });
    });

    describe('Quality Checks', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should reject empty text', () => {
            const quality = engine.checkQuality('');
            expect(quality.meetsMinimum).to.be.false;
            expect(quality.reason).to.equal('empty_text');
        });

        it('should reject text that is too short (too few words)', () => {
            // With MIN_WORDS=6, short inputs are caught by too_few_words first
            const quality = engine.checkQuality('a b c');
            expect(quality.meetsMinimum).to.be.false;
            expect(quality.reason).to.equal('too_few_words');
        });

        it('should reject text with too few words', () => {
            const quality = engine.checkQuality('hello world');
            expect(quality.meetsMinimum).to.be.false;
            expect(quality.reason).to.equal('too_few_words');
        });

        it('should reject filler words only', () => {
            const quality = engine.checkQuality('uh um ah uh um ah');
            expect(quality.meetsMinimum).to.be.false;
            expect(quality.isFillerOnly).to.be.true;
            expect(quality.reason).to.equal('filler_words_only');
        });

        it('should accept quality text with minimum words', () => {
            const quality = engine.checkQuality('this is good quality text here');
            expect(quality.meetsMinimum).to.be.true;
            expect(quality.isFillerOnly).to.be.false;
            expect(quality.reason).to.equal('quality_ok');
        });

        it('should accept text with some filler words mixed in', () => {
            const quality = engine.checkQuality('uh this is um good text');
            expect(quality.meetsMinimum).to.be.true;
            expect(quality.isFillerOnly).to.be.false;
        });
    });

    describe('Sentence Ending Detection', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should detect period ending', () => {
            expect(engine.detectSentenceEnding('This is a sentence.')).to.be.true;
        });

        it('should detect exclamation mark', () => {
            expect(engine.detectSentenceEnding('This is exciting!')).to.be.true;
        });

        it('should detect question mark', () => {
            expect(engine.detectSentenceEnding('Is this a question?')).to.be.true;
        });

        it('should not detect ellipsis as sentence ending', () => {
            expect(engine.detectSentenceEnding('This is...')).to.be.false;
        });

        it('should not detect text without punctuation', () => {
            expect(engine.detectSentenceEnding('this is not complete')).to.be.false;
        });

        it('should handle trailing spaces', () => {
            expect(engine.detectSentenceEnding('This is a sentence.  ')).to.be.true;
        });
    });

    describe('Translation Decisions - Sentence Endings', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should approve translation for complete sentence', () => {
            const decision = engine.shouldTranslate({
                text: 'This is a complete and correct sentence.',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.true;
            expect(decision.reason).to.equal('sentence_ending');
            expect(decision.confidence).to.equal(1.0);
            expect(decision.isComplete).to.be.true;
        });

        it('should reject incomplete sentence without enough words', () => {
            const decision = engine.shouldTranslate({
                text: 'hello there',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.false;
            expect(decision.reason).to.equal('waiting_for_trigger');
        });
    });

    describe('Translation Decisions - Max Interval', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
            // Initialize last translation time (must exceed 15s interval)
            engine.lastTranslationTime = Date.now() - 16000; // 16 seconds ago
        });

        it('should approve translation when max interval reached (Talks: 15s)', () => {
            const decision = engine.shouldTranslate({
                text: 'this is good enough text for translation',
                isFinal: false,
                timeSinceLastChange: 500,
                trigger: 'interim',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.true;
            expect(decision.reason).to.equal('max_interval');
            expect(decision.confidence).to.equal(0.9);
        });

        it('should use different interval for EarBuds mode (15s)', () => {
            const earbudsEngine = new TranslationRulesEngine('earbuds', mockLogger);
            earbudsEngine.lastTranslationTime = Date.now() - 16000; // >15 seconds ago

            const decision = earbudsEngine.shouldTranslate({
                text: 'this is good enough text now',
                isFinal: false,
                timeSinceLastChange: 500,
                trigger: 'interim',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.true;
            expect(decision.reason).to.equal('max_interval');
        });

        it('should reject max interval translation if quality is poor', () => {
            const decision = engine.shouldTranslate({
                text: 'hi',  // Too short
                isFinal: false,
                timeSinceLastChange: 500,
                trigger: 'interim',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.false;
            expect(decision.reason).to.equal('max_interval_poor_quality');
        });
    });

    describe('Translation Decisions - Final Results', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should approve final result with quality text', () => {
            const decision = engine.shouldTranslate({
                text: 'this is final quality text here',
                isFinal: true,
                timeSinceLastChange: 1000,
                trigger: 'final',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.true;
            expect(decision.reason).to.equal('final_result');
            expect(decision.confidence).to.equal(0.8);
        });

        it('should reject final result with single word', () => {
            const decision = engine.shouldTranslate({
                text: 'pair',
                isFinal: true,
                timeSinceLastChange: 1000,
                trigger: 'final',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.false;
            expect(decision.reason).to.equal('too_few_words');
        });

        it('should reject final result with filler words only', () => {
            const decision = engine.shouldTranslate({
                text: 'uh um ah uh um ah',
                isFinal: true,
                timeSinceLastChange: 1000,
                trigger: 'final',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.false;
            expect(decision.reason).to.equal('filler_words_only');
        });
    });

    describe('Translation Decisions - Pause Detection', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should approve translation after pause threshold', () => {
            const decision = engine.shouldTranslate({
                text: 'this is quality text after pause',
                isFinal: false,
                timeSinceLastChange: 4500, // > 4000ms pause threshold
                trigger: 'pause',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.true;
            expect(decision.reason).to.equal('pause_detected');
            expect(decision.confidence).to.equal(0.7);
        });

        it('should reject if pause reached but text quality is poor', () => {
            const decision = engine.shouldTranslate({
                text: 'hi',
                isFinal: false,
                timeSinceLastChange: 3500,
                trigger: 'pause',
                clientId: 'test-123'
            });

            expect(decision.shouldTranslate).to.be.false;
        });
    });

    describe('New Text Extraction', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should return full text when no previous translation', () => {
            const newText = engine.getNewText('this is new text');
            expect(newText).to.equal('this is new text');
        });

        it('should extract only new text after previous translation', () => {
            engine.lastTranslatedText = 'this is';
            const newText = engine.getNewText('this is new text');
            expect(newText).to.equal('new text');
        });

        it('should return full text if it does not start with previous', () => {
            engine.lastTranslatedText = 'old text';
            const newText = engine.getNewText('completely new utterance');
            expect(newText).to.equal('completely new utterance');
        });

        it('should handle trailing/leading spaces', () => {
            engine.lastTranslatedText = 'this is';
            const newText = engine.getNewText('this is   new text  ');
            expect(newText).to.equal('new text');
        });
    });

    describe('State Management', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should record translation and update state', () => {
            // NOTE: recordTranslation() does NOT update lastTranslatedText anymore
            // to prevent async race conditions. lastTranslatedText is set in approveTranslation().
            engine.recordTranslation(
                'original text here',
                'translated text here'
            );

            // Should NOT update lastTranslatedText (that's done in approveTranslation)
            expect(engine.lastTranslatedText).to.equal('');

            // Should update accumulated text and count
            expect(engine.accumulatedText).to.include('translated text here');
            expect(engine.translationCount).to.equal(1);
        });

        it('should accumulate multiple translations', () => {
            engine.recordTranslation('first text', 'first translation');
            engine.recordTranslation('second text', 'second translation');

            expect(engine.accumulatedText).to.include('first translation');
            expect(engine.accumulatedText).to.include('second translation');
            expect(engine.translationCount).to.equal(2);
        });

        it('should reset state for new utterance', () => {
            engine.lastTranslatedText = 'previous text';
            engine.resetForNewUtterance();

            expect(engine.lastTranslatedText).to.equal('');
        });
    });

    describe('Metrics Tracking', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should track approval metrics', () => {
            // Approve one translation
            engine.shouldTranslate({
                text: 'This is a complete and correct sentence.',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            const metrics = engine.getMetrics();
            expect(metrics.totalChecks).to.equal(1);
            expect(metrics.translationsApproved).to.equal(1);
            expect(metrics.translationsBlocked).to.equal(0);
            expect(metrics.approvalRate).to.equal(1.0);
        });

        it('should track rejection metrics', () => {
            // Reject one translation
            engine.shouldTranslate({
                text: 'hi',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            const metrics = engine.getMetrics();
            expect(metrics.totalChecks).to.equal(1);
            expect(metrics.translationsApproved).to.equal(0);
            expect(metrics.translationsBlocked).to.equal(1);
            expect(metrics.approvalRate).to.equal(0);
        });

        it('should track block reasons', () => {
            engine.shouldTranslate({
                text: 'hi',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            engine.shouldTranslate({
                text: 'hello',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            const metrics = engine.getMetrics();
            expect(metrics.blockReasons).to.have.property('waiting_for_trigger');
            expect(metrics.blockReasons.waiting_for_trigger).to.equal(2);
        });

        it('should calculate approval rate correctly', () => {
            // 1 approved
            engine.shouldTranslate({
                text: 'This is a very complete sentence.',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            // 2 rejected
            engine.shouldTranslate({
                text: 'hi',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            engine.shouldTranslate({
                text: 'hello',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            const metrics = engine.getMetrics();
            expect(metrics.totalChecks).to.equal(3);
            expect(metrics.translationsApproved).to.equal(1);
            expect(metrics.translationsBlocked).to.equal(2);
            expect(metrics.approvalRate).to.be.closeTo(0.333, 0.01);
        });
    });

    describe('Edge Cases', () => {
        let engine;

        beforeEach(() => {
            engine = new TranslationRulesEngine('talks', mockLogger);
        });

        it('should handle Romanian filler words', () => {
            const quality = engine.checkQuality('păi deci adică păi deci adică');
            expect(quality.isFillerOnly).to.be.true;
        });

        it('should handle mixed language filler words', () => {
            const quality = engine.checkQuality('um păi this is text deci good');
            expect(quality.meetsMinimum).to.be.true;
            expect(quality.isFillerOnly).to.be.false;
        });

        it('should handle very long text', () => {
            const longText = 'word '.repeat(100) + 'sentence.';
            const quality = engine.checkQuality(longText);
            expect(quality.meetsMinimum).to.be.true;
        });

        it('should handle text with punctuation in middle', () => {
            const decision = engine.shouldTranslate({
                text: 'This is a sentence. But not ending',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            // Should not detect as complete (period not at end)
            expect(decision.reason).to.not.equal('sentence_ending');
        });

        it('should initialize lastTranslationTime on first check', () => {
            expect(engine.lastTranslationTime).to.be.null;

            engine.shouldTranslate({
                text: 'some text here',
                isFinal: false,
                timeSinceLastChange: 0,
                trigger: 'interim',
                clientId: 'test-123'
            });

            expect(engine.lastTranslationTime).to.not.be.null;
        });
    });

    describe('Real-World Scenarios', () => {
        it('should handle continuous speech in Talks mode', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            // Scenario: Speaker talking continuously for 16 seconds (beyond 15s max interval)
            engine.lastTranslationTime = Date.now() - 16000;

            const decision = engine.shouldTranslate({
                text: 'welcome to JW Broadcasting in this program we will see',
                isFinal: false,
                timeSinceLastChange: 100,
                trigger: 'interim',
                clientId: 'test-123'
            });

            // Should translate due to max interval (15s) reached
            expect(decision.shouldTranslate).to.be.true;
            expect(decision.reason).to.equal('max_interval');
        });

        it('should handle single word from Google final result', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            const decision = engine.shouldTranslate({
                text: 'pair',
                isFinal: true,
                timeSinceLastChange: 1000,
                trigger: 'final',
                clientId: 'test-123'
            });

            // Should BLOCK single-word final result
            expect(decision.shouldTranslate).to.be.false;
            expect(decision.reason).to.equal('too_few_words');
        });

        it('should handle EarBuds mode longer intervals', () => {
            const engine = new TranslationRulesEngine('earbuds', mockLogger);
            engine.lastTranslationTime = Date.now() - 5000; // 5 seconds

            const decision = engine.shouldTranslate({
                text: 'this is some continuous speech content',
                isFinal: false,
                timeSinceLastChange: 100,
                trigger: 'interim',
                clientId: 'test-123'
            });

            // EarBuds mode: 8s interval, so 5s should NOT trigger yet
            expect(decision.shouldTranslate).to.be.false;
            expect(decision.reason).to.equal('waiting_for_trigger');
        });

        it('should reject case-insensitive duplicates (EN→RO bug from production)', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            // First translation: lowercase "hrănește"
            const decision1 = engine.shouldTranslate({
                text: 'hrănește ceea ce suntem în interior',
                isFinal: true,
                timeSinceLastChange: 100,
                trigger: 'final',
                clientId: 'test-123'
            });

            expect(decision1.shouldTranslate).to.be.true;
            expect(decision1.reason).to.equal('final_result');

            // Second translation: uppercase "Hrănește" (subset, case-insensitive match) - should be REJECTED
            const decision2 = engine.shouldTranslate({
                text: 'Hrănește ceea ce suntem',
                isFinal: true,
                timeSinceLastChange: 100,
                trigger: 'final',
                clientId: 'test-123'
            });

            // CRITICAL: Must reject despite case difference
            // normalizedLast.includes(normalizedFull) should catch this
            expect(decision2.shouldTranslate).to.be.false;
            expect(decision2.newText).to.equal(''); // Empty because it's a duplicate
        });

        it('should reject duplicates with 60-70% overlap (threshold lowered)', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            // First translation: 6 words
            const decision1 = engine.shouldTranslate({
                text: 'welcome to the program about mental health today',
                isFinal: true,
                timeSinceLastChange: 100,
                trigger: 'final',
                clientId: 'test-123'
            });

            expect(decision1.shouldTranslate).to.be.true;

            // Second translation: 4 words, 66.7% overlap (4/6)
            const decision2 = engine.shouldTranslate({
                text: 'welcome to the program',
                isFinal: true,
                timeSinceLastChange: 100,
                trigger: 'final',
                clientId: 'test-123'
            });

            // Should REJECT with 66.7% overlap (threshold is now 60%)
            expect(decision2.shouldTranslate).to.be.false;
            expect(decision2.newText).to.equal(''); // Duplicate detected
        });

        it('should update threshold to 45% to catch more duplicates', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            // First translation
            const decision1 = engine.shouldTranslate({
                text: 'The book of Obadiah is one of the shortest',
                isFinal: true,
                timeSinceLastChange: 100,
                trigger: 'final',
                clientId: 'test-123'
            });

            expect(decision1.shouldTranslate).to.be.true;

            // Second translation: 50% overlap
            const decision2 = engine.shouldTranslate({
                text: 'The book of Obadiah',
                isFinal: true,
                timeSinceLastChange: 100,
                trigger: 'final',
                clientId: 'test-123'
            });

            // Should REJECT with 50% overlap (threshold is now 45%)
            expect(decision2.shouldTranslate).to.be.false;
            expect(decision2.newText).to.equal('');
        });
    });

    describe('Post-Translation Duplicate Detection (CRITICAL FIX)', () => {
        it('should detect exact duplicate translations', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            // First translation output
            engine.recordTranslatedOutput('Cartea lui Obadia este una dintre cele mai scurte');

            // Check if same translation is duplicate
            const isDuplicate = engine.isTranslationDuplicate('Cartea lui Obadia este una dintre cele mai scurte');

            expect(isDuplicate).to.be.true;
        });

        it('should detect case-insensitive duplicate translations', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            engine.recordTranslatedOutput('Cartea lui Obadia este una dintre cele mai scurte');

            // Check with different case
            const isDuplicate = engine.isTranslationDuplicate('cartea lui obadia este una dintre cele mai scurte');

            expect(isDuplicate).to.be.true;
        });

        it('should detect substring duplicates (>90% overlap)', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            engine.recordTranslatedOutput('Cartea lui Obadia este una dintre cele mai scurte din Biblie');

            // Check shorter version (subset)
            const isDuplicate = engine.isTranslationDuplicate('Cartea lui Obadia este una dintre cele mai scurte');

            expect(isDuplicate).to.be.true;
        });

        it('should detect high word overlap duplicates (>80%)', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            engine.recordTranslatedOutput('Cartea lui Obadia este una dintre cele mai scurte cărți');

            // 9 out of 10 words match = 90% overlap
            const isDuplicate = engine.isTranslationDuplicate('Cartea lui Obadia este una dintre cele mai scurte');

            expect(isDuplicate).to.be.true;
        });

        it('should NOT detect translations with <80% word overlap', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            engine.recordTranslatedOutput('Cartea lui Obadia este una dintre cele mai scurte');

            // Only 3 out of 10 words match = 30% overlap
            const isDuplicate = engine.isTranslationDuplicate('Depresie și anxietate sunt probleme de sănătate mintală');

            expect(isDuplicate).to.be.false;
        });

        it('should clean up old translations after 20 seconds (TRANSLATION_DEDUP_WINDOW)', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            engine.recordTranslatedOutput('Cartea lui Obadia');

            // Manually set old timestamp
            engine.recentTranslations[0].timestamp = Date.now() - 21000; // 21 seconds ago (beyond 20s window)

            // Should not detect as duplicate (too old)
            const isDuplicate = engine.isTranslationDuplicate('Cartea lui Obadia');

            expect(isDuplicate).to.be.false;
        });

        it('should track multiple translations in queue', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            engine.recordTranslatedOutput('First translation');
            engine.recordTranslatedOutput('Second translation');
            engine.recordTranslatedOutput('Third translation');

            expect(engine.recentTranslations.length).to.equal(3);

            // All should be detected as duplicates
            expect(engine.isTranslationDuplicate('First translation')).to.be.true;
            expect(engine.isTranslationDuplicate('Second translation')).to.be.true;
            expect(engine.isTranslationDuplicate('Third translation')).to.be.true;
        });

        it('should solve the production bug: different English → identical Romanian', () => {
            const engine = new TranslationRulesEngine('talks', mockLogger);

            // Simulate: "The book of Obadiah, is one..." → "Cartea lui Obadia..."
            engine.recordTranslatedOutput('Cartea lui Obadia este una dintre cele mai scurte');

            // Simulate: "The book of Obadiah is one..." (no comma) → same Romanian
            const isDuplicate = engine.isTranslationDuplicate('Cartea lui Obadia este una dintre cele mai scurte');

            // CRITICAL: Must detect duplicate even though source texts differ
            expect(isDuplicate).to.be.true;
        });
    });
});
