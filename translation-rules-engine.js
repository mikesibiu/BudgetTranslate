/**
 * Translation Rules Engine
 * Centralized decision-making for when to translate
 * Ensures consistent behavior across all translation triggers and modes
 */

class TranslationRulesEngine {
    constructor(mode = 'talks', logger = console) {
        this.mode = mode;
        this.logger = logger;
        this.modeConfig = this.getModeConfig(mode);

        // State tracking
        this.lastTranslationTime = null;
        this.lastTextChangeTime = Date.now();
        this.lastTranslatedText = '';
        this.accumulatedText = '';
        this.translationCount = 0;

        // Post-translation duplicate detection (CRITICAL FIX)
        this.recentTranslations = []; // Array of {text, timestamp}
        this.TRANSLATION_DEDUP_WINDOW = 20000; // Raised from 15s: interval is now 15s so dedup window must be wider

        // Decision metrics
        this.metrics = {
            totalChecks: 0,
            translationsApproved: 0,
            translationsBlocked: 0,
            blockReasons: {}
        };

        // Quality thresholds
        this.MIN_WORDS_FOR_TRANSLATION = 6; // Raised from 3: short chunks lack context for accurate chunk translation
        this.MIN_CHARS_FOR_TRANSLATION = 10;

        // Filler words to ignore (language-agnostic common fillers)
        this.FILLER_WORDS = new Set([
            // English
            'uh', 'um', 'ah', 'hmm', 'eh', 'er', 'like', 'you know',
            // Romanian
            'ă', 'e', 'ei', 'păi', 'deci', 'adică'
        ]);
    }

    /**
     * Get mode-specific configuration
     */
    getModeConfig(mode) {
        const configs = {
            talks: {
                name: 'Talks',
                translationInterval: 15000,  // 15 seconds (raised from 8s for fast-speaker context)
                pauseDetectionMs: 4000,      // 4 second pause
                requireSentenceEnding: false, // Translate even without sentence endings
                minWords: 6,
                enableTTS: false,            // Manual TTS control
                displayVisualCards: true,    // Show translation cards
                enableSummary: false
            },
            earbuds: {
                name: 'EarBuds',
                translationInterval: 15000,  // 15 seconds (raised from 8s for fast-speaker context)
                pauseDetectionMs: 4000,      // 4 second pause
                requireSentenceEnding: false,
                minWords: 6,
                enableTTS: true,             // Always enable TTS
                displayVisualCards: false,   // Hide translation cards (audio-only)
                enableSummary: false
            }
        };

        return configs[mode] || configs.talks;
    }

    /**
     * Central decision point: Should we translate now?
     *
     * @param {Object} context - Translation context
     * @param {string} context.text - Current text from STT
     * @param {boolean} context.isFinal - Is this a final result from Google?
     * @param {number} context.timeSinceLastChange - Time since text last changed (ms)
     * @param {string} context.trigger - What triggered this check? ('interim', 'final', 'timer')
     * @param {string} context.clientId - Client ID for logging
     *
     * @returns {Object} Decision with reasoning
     */
    shouldTranslate(context) {
        this.metrics.totalChecks++;
        const now = Date.now();

        // Initialize translation time on first check
        if (!this.lastTranslationTime) {
            this.lastTranslationTime = now;
        }

        // Calculate elapsed time since last translation
        const elapsedSinceLastTranslation = now - this.lastTranslationTime;

        // Extract new text that hasn't been translated yet
        const newText = this.getNewText(context.text);

        // Run quality checks
        const qualityCheck = this.checkQuality(newText, context.isFinal);

        // Detect sentence endings
        const hasSentenceEnding = this.detectSentenceEnding(context.text);

        // DECISION LOGIC (Priority Order):

        // Priority 1: Sentence ending (immediate translation)
        if (hasSentenceEnding && qualityCheck.meetsMinimum) {
            return this.approveTranslation(newText, 'sentence_ending', 1.0, context.clientId, context.text);
        }

        // Priority 2: Maximum interval reached (force translation)
        if (elapsedSinceLastTranslation >= this.modeConfig.translationInterval) {
            if (qualityCheck.meetsMinimum) {
                return this.approveTranslation(newText, 'max_interval', 0.9, context.clientId, context.text);
            } else {
                // Max interval reached but text doesn't meet quality - still skip
                return this.rejectTranslation('max_interval_poor_quality', newText);
            }
        }

        // Priority 3: Final result from Google (with quality validation)
        if (context.isFinal) {
            if (qualityCheck.meetsMinimum && !qualityCheck.isFillerOnly) {
                return this.approveTranslation(newText, 'final_result', 0.8, context.clientId, context.text);
            } else {
                // Final result but poor quality - DO NOT update lastTranslatedText
                // Only approveTranslation() should update it to prevent duplicate tracking bugs
                this.logger.info('⏭️ Skipping low-quality final result', {
                    clientId: context.clientId,
                    text: newText.substring(0, 30),
                    reason: qualityCheck.reason
                });
                return this.rejectTranslation(qualityCheck.reason, newText);
            }
        }

        // Priority 4: Pause detection (handled by timer in server, not here)
        // This check is only reached for interim results - wait for pause timer
        if (context.timeSinceLastChange >= this.modeConfig.pauseDetectionMs) {
            if (qualityCheck.meetsMinimum) {
                return this.approveTranslation(newText, 'pause_detected', 0.7, context.clientId, context.text);
            }
        }

        // Default: Wait for one of the above conditions
        return this.rejectTranslation('waiting_for_trigger', newText);
    }

    /**
     * Extract new text that hasn't been translated yet
     */
    getNewText(fullText) {
        if (!this.lastTranslatedText) {
            this.logger.debug('🔍 getNewText: No previous translation, returning full text');
            return fullText.trim();
        }

        const trimmedFull = fullText.trim();
        const trimmedLast = this.lastTranslatedText.trim();

        // Normalize for case-insensitive comparison (preserves original for extraction)
        const normalizedFull = trimmedFull.toLowerCase();
        const normalizedLast = trimmedLast.toLowerCase();

        this.logger.debug('🔍 getNewText comparing:', {
            current: trimmedFull.substring(0, 80),
            last: trimmedLast.substring(0, 80),
            currentLen: trimmedFull.length,
            lastLen: trimmedLast.length
        });

        // Check if we've already translated this exact text (case-insensitive)
        if (normalizedFull === normalizedLast) {
            this.logger.info('⛔ DUPLICATE DETECTED: Exact match (case-insensitive)');
            return ''; // Already translated, no new text
        }

        // Check if last translation contains the current text (subset/duplicate)
        // Example: last="Depression and Anxiety", current="depression" → skip
        // BUG-8 guard: only suppress if current is genuinely shorter (word count ≤ last).
        // Without this, after a 290s restart the accumulated lastTranslatedText contains
        // the full prior session — a new short phrase like "the brothers" would be found
        // inside it and silently suppressed even though it's a new utterance.
        const currentWordCount = normalizedFull.split(/\s+/).filter(Boolean).length;
        const lastWordCount = normalizedLast.split(/\s+/).filter(Boolean).length;
        if (normalizedLast.includes(normalizedFull) && currentWordCount <= lastWordCount) {
            this.logger.info('⛔ DUPLICATE DETECTED: Current is subset of last');
            return ''; // Current text is subset of what we already translated
        }

        // Check if current text starts with last translation (continuation)
        // Example: last="Depression", current="Depression and Anxiety" → extract "and Anxiety"
        if (normalizedFull.startsWith(normalizedLast)) {
            const extracted = trimmedFull.substring(trimmedLast.length).trim();
            this.logger.debug('📝 Extracting continuation:', {
                text: extracted.substring(0, 60),
                length: extracted.length,
                words: extracted.split(/\s+/).length
            });
            return extracted;
        }

        // Check if texts have significant overlap (>65% similarity)
        // Raised from 45% → 65% to avoid rejecting legitimate continuations
        // that share common words with the previous translation
        const overlap = this.calculateOverlap(trimmedLast, trimmedFull);
        this.logger.debug(`📊 Overlap: ${(overlap * 100).toFixed(1)}%`);
        if (overlap > 0.65) {
            this.logger.info(`⛔ DUPLICATE DETECTED: ${(overlap * 100).toFixed(1)}% overlap (threshold: 65%)`);
            return ''; // Too similar, likely duplicate
        }

        // Text doesn't match previous - return full text (new utterance)
        this.logger.debug('✅ New text detected, no duplication');
        return trimmedFull;
    }

    /**
     * Calculate word overlap between two texts (0.0 to 1.0)
     * Uses word-frequency bags (not Sets) so repeated words are counted correctly.
     * "the the the cat" vs "the cat" = 50%, not 100%.
     */
    calculateOverlap(text1, text2) {
        const toBag = str => {
            const bag = {};
            for (const w of str.toLowerCase().split(/\s+/).filter(Boolean)) {
                bag[w] = (bag[w] || 0) + 1;
            }
            return bag;
        };
        const bag1 = toBag(text1);
        const bag2 = toBag(text2);
        let common = 0;
        for (const [word, count] of Object.entries(bag1)) {
            common += Math.min(count, bag2[word] || 0);
        }
        const total1 = Object.values(bag1).reduce((a, b) => a + b, 0);
        const total2 = Object.values(bag2).reduce((a, b) => a + b, 0);
        const total = Math.max(total1, total2);
        return total > 0 ? common / total : 0;
    }

    /**
     * CRITICAL FIX: Check if translation output is a duplicate
     * This catches cases where different source texts translate to identical output
     * Example: "The book of Obadiah, is..." vs "The book of Obadiah is..." both → "Cartea lui Obadia..."
     *
     * @param {string} translation - The translated text to check
     * @returns {boolean} True if this translation was recently shown
     */
    isTranslationDuplicate(translation) {
        const normalized = translation.toLowerCase().trim();
        const now = Date.now();

        // Clean old entries (older than 15s — TRANSLATION_DEDUP_WINDOW)
        this.recentTranslations = this.recentTranslations.filter(
            entry => now - entry.timestamp < this.TRANSLATION_DEDUP_WINDOW
        );

        // Check for exact match or high similarity
        for (const entry of this.recentTranslations) {
            const entryNormalized = entry.text.toLowerCase().trim();

            // Exact match (case-insensitive)
            if (entryNormalized === normalized) {
                this.logger.info('🚫 POST-TRANSLATION DUPLICATE: Exact match', {
                    translation: normalized.substring(0, 50)
                });
                return true;
            }

            // Substring check (one contains the other with ≥65% overlap)
            if (entryNormalized.includes(normalized) || normalized.includes(entryNormalized)) {
                const overlap = Math.min(entryNormalized.length, normalized.length) /
                               Math.max(entryNormalized.length, normalized.length);
                if (overlap >= 0.65) {
                    this.logger.info(`🚫 POST-TRANSLATION DUPLICATE: ${(overlap * 100).toFixed(1)}% substring overlap`, {
                        translation: normalized.substring(0, 50)
                    });
                    return true;
                }
            }

            // Word overlap check (65% threshold for translated output — was 80%, too aggressive)
            const wordOverlap = this.calculateOverlap(entryNormalized, normalized);
            if (wordOverlap >= 0.65) {
                this.logger.info(`🚫 POST-TRANSLATION DUPLICATE: ${(wordOverlap * 100).toFixed(1)}% word overlap (threshold: 65%)`, {
                    translation: normalized.substring(0, 50)
                });
                return true;
            }
        }

        return false;
    }

    /**
     * Record a translation output for duplicate detection
     *
     * @param {string} translation - The translated text to record
     */
    recordTranslatedOutput(translation) {
        const now = Date.now();

        this.recentTranslations.push({
            text: translation,
            timestamp: now
        });

        // Keep only last 15 seconds (TRANSLATION_DEDUP_WINDOW)
        this.recentTranslations = this.recentTranslations.filter(
            entry => now - entry.timestamp < this.TRANSLATION_DEDUP_WINDOW
        );

        this.logger.debug('📝 Recorded translation output', {
            translation: translation.substring(0, 50),
            queueSize: this.recentTranslations.length
        });
    }

    /**
     * Check text quality (minimum words, characters, filler detection)
     */
    checkQuality(text, isFinal = false) {
        const trimmedText = text.trim();

        if (trimmedText.length === 0) {
            return {
                meetsMinimum: false,
                isFillerOnly: false,
                reason: 'empty_text'
            };
        }

        // Word count check (most specific - check first)
        const words = trimmedText.split(/\s+/).filter(w => w.length > 0);
        if (words.length < this.MIN_WORDS_FOR_TRANSLATION) {
            return {
                meetsMinimum: false,
                isFillerOnly: false,
                reason: 'too_few_words'
            };
        }

        // Filler word detection (check content quality)
        const nonFillerWords = words.filter(word => {
            const lowerWord = word.toLowerCase().replace(/[.,!?;:]/g, '');
            return !this.FILLER_WORDS.has(lowerWord);
        });

        if (nonFillerWords.length === 0) {
            return {
                meetsMinimum: false,
                isFillerOnly: true,
                reason: 'filler_words_only'
            };
        }

        // Character count check (sanity check - least specific)
        if (trimmedText.length < this.MIN_CHARS_FOR_TRANSLATION) {
            return {
                meetsMinimum: false,
                isFillerOnly: false,
                reason: 'too_short'
            };
        }

        // All checks passed
        return {
            meetsMinimum: true,
            isFillerOnly: false,
            reason: 'quality_ok'
        };
    }

    /**
     * Reset state for a new utterance (used by tests and server resets)
     */
    resetForNewUtterance() {
        this.lastTranslatedText = '';
        this.accumulatedText = '';
        this.translationCount = 0;
        this.recentTranslations = [];
    }

    /**
     * Detect sentence endings (. ! ? and regional variants)
     */
    detectSentenceEnding(text) {
        const trimmedText = text.trim();

        // Check for sentence-ending punctuation
        const hasPunctuation = /[.!?。！？]\s*$/.test(trimmedText);

        // Exclude ellipsis (not a real sentence ending)
        const hasEllipsis = /\.{2,}\s*$/.test(trimmedText);

        return hasPunctuation && !hasEllipsis;
    }

    /**
     * Approve translation (update state and metrics)
     */
    approveTranslation(newText, reason, confidence, clientId, fullText) {
        this.metrics.translationsApproved++;
        const prevTranslationTime = this.lastTranslationTime;
        this.lastTranslationTime = Date.now();

        // CRITICAL: Update lastTranslatedText IMMEDIATELY to prevent race conditions
        // Multiple final results from Google can arrive before first translation completes
        // Cap at 500 chars (keep tail) to prevent unbounded growth over long sessions.
        if (fullText) {
            this.lastTranslatedText = fullText.length > 500 ? fullText.slice(-500) : fullText;
        }

        this.logger.info('✅ Translation APPROVED', {
            clientId,
            reason,
            confidence,
            mode: this.mode,
            textPreview: newText.substring(0, 50),
            wordCount: newText.split(/\s+/).length,
            elapsedMs: prevTranslationTime ? this.lastTranslationTime - prevTranslationTime : 0,
            trackedText: this.lastTranslatedText.substring(0, 50)
        });

        return {
            shouldTranslate: true,
            reason,
            confidence,
            newText,
            // Mark as complete for TTS/storage if: sentence ending, final result, max interval, or pause
            // These all represent "good enough" stopping points for the user to hear translation
            isComplete: reason === 'sentence_ending' ||
                       reason === 'final_result' ||
                       reason === 'max_interval' ||
                       reason === 'pause_detected'
        };
    }

    /**
     * Reject translation (update metrics only)
     */
    rejectTranslation(reason, newText) {
        this.metrics.translationsBlocked++;
        this.metrics.blockReasons[reason] = (this.metrics.blockReasons[reason] || 0) + 1;

        return {
            shouldTranslate: false,
            reason,
            confidence: 0,
            newText,
            isComplete: false
        };
    }

    /**
     * Update state after successful translation
     * NOTE: this.translationCount is for internal rules-engine metrics only;
     * server.js maintains its own client-facing translationCount for emitting to the client.
     */
    recordTranslation(originalText, translatedText) {
        // NOTE: DO NOT update lastTranslatedText here!
        // It's already set in approveTranslation() to prevent race conditions.
        // Setting it here would overwrite newer values when translations complete out of order.

        const joined = (this.accumulatedText ? this.accumulatedText + ' ' : '') + translatedText;
        // Cap at 1000 chars (keep tail) to prevent unbounded growth over long sessions.
        this.accumulatedText = joined.length > 1000 ? joined.slice(-1000) : joined;
        this.translationCount++;
    }

    /**
     * Get current mode configuration
     */
    getConfig() {
        return this.modeConfig;
    }

    /**
     * Get decision metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            mode: this.mode,
            translationCount: this.translationCount,
            approvalRate: this.metrics.totalChecks > 0
                ? this.metrics.translationsApproved / this.metrics.totalChecks
                : 0
        };
    }
}

module.exports = TranslationRulesEngine;
