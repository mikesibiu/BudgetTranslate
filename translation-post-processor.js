'use strict';

/**
 * Translation post-processing utilities.
 *
 * Pure functions — no external state, no logger, no socket dependencies.
 * Extracted from server.js so they can be unit-tested and shared.
 *
 * Used by both GTranslateV4 (main) and NovaTranslate branches,
 * and by BudgetTranslate.
 */

/**
 * Apply JW domain term corrections to translated text.
 *
 * Fixes known mistranslations and JW-specific terminology that Google Translate
 * gets wrong without sufficient context (e.g. "vestitori" → "publishers",
 * "congres" → "convention", "congregație" → "congregation" not "church").
 *
 * @param {string} text - Translated output to correct
 * @param {string} [sourceText=''] - Original STT source (Romanian) for source-aware fixes
 * @returns {string} Corrected translation
 */
function applyTermMappings(text, sourceText = '') {
    // Normalize source for diacritic-insensitive matching: Deepgram sometimes drops
    // diacritics (e.g. "congregatie" instead of "congregație"), so source-aware regex
    // checks must work against both the original and the stripped form.
    const sourceNorm = sourceText.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const mappings = [
        { pattern: /\bvestitori\b/gi, replacement: 'publishers' },
        { pattern: /\bMartorii lui Iehova\b/gi, replacement: "Jehovah's Witnesses" },
        { pattern: /\bnume nou\b/gi, replacement: 'new name' },
        { pattern: /\bnume noi\b/gi, replacement: 'new names' },
        // "congres" is a JW convention, not a political congress
        { pattern: /\bcongresses\b/gi, replacement: 'conventions' },
        { pattern: /\bcongress\b/gi, replacement: 'convention' },
        // Bible reference format: Romanian "Proverbe de 7,3" → translated "Proverbs of 7,3"
        // → should be "Proverbs 7:3". Pattern: CapitalizedWord + "of" + N,M → N:M
        { pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+of\s+(\d+)[,.](\d+)\b/g, replacement: '$1 $2:$3' },
    ];

    let result = text;
    for (const { pattern, replacement } of mappings) {
        result = result.replace(pattern, replacement);
    }

    // Source-aware fix: "congregație" → "congregation" (not "church").
    // Google Translate sometimes returns "church" for "congregație" in religious contexts.
    // JW terminology strictly uses "congregation", never "church".
    // Uses sourceNorm (diacritics stripped) to match even when Deepgram drops ț → t.
    if (/congregati/i.test(sourceNorm)) {
        result = result.replace(/\bchurch\b/gi, 'congregation');
        result = result.replace(/\bchurches\b/gi, 'congregations');
    }

    // Source-aware fix: STT garbles "congrese speciale" → "congrete fiare" (beasts).
    // When the source contains "congres" family words, "beast/beasts" in the output
    // is always a garble artifact — replace with "convention/conventions".
    if (/congres/i.test(sourceText)) {
        result = result.replace(/\bbeasts?\b/gi, (match) => match.toLowerCase() === 'beast' ? 'convention' : 'conventions');
    }

    // Source-aware fix: STT garbles "Tongo" (venue/stadium name) → "Togo" (country).
    // "Togo" in this domain context is always the venue, never the African country.
    if (/tongo/i.test(sourceText)) {
        result = result.replace(/\bTogo\b/g, 'Tongo');
    }

    // Source-aware fix: "Cartea Bucuriei" = "The Book of Joy" (JW publication).
    // Google Translate sometimes renders "bucurie" as "Rejoice" without context.
    if (/cart(?:ea|e)\s+bucur/i.test(sourceText)) {
        result = result.replace(/\bRejoice\b/gi, 'Joy');
        result = result.replace(/\bbook\s+rejoice\b/gi, 'Book of Joy');
    }

    // Source-aware fix: "bunătate" (kindness) garbled to "bani" (money) by STT.
    // If source contains "bunătate" and output has "money", it's the STT error.
    if (/bun[ăa]tate/i.test(sourceText)) {
        result = result.replace(/\bmoney\b/gi, 'kindness');
    }

    // Source-aware fix: "cu siguranță" = certainly/surely (adverb), NOT "safety" (noun).
    // Google/Claude maps "siguranță" to "safety" but "cu siguranță" is the adverb "certainly".
    if (/cu\s+siguranta/i.test(sourceNorm)) {
        result = result.replace(/\bSafety\b/g, 'Certainly');
        result = result.replace(/\bsafety\b/g, 'certainly');
    }

    // Grammar fix: "say/says [pronoun]" → "tell/tells [pronoun]".
    // Romanian "a spune cuiva" (to tell someone) translates literally as "say me/you/him"
    // but English requires "tell" when a personal object follows.
    result = result.replace(/\bsays\s+(me|us|him|her|them|you)\b/gi, 'tells $1');
    result = result.replace(/\bsay\s+(me|us|him|her|them|you)\b/gi, 'tell $1');

    // Collapse consecutive duplicate 2-3 word phrases (e.g. "you can't you can't" → "you can't").
    // Caused by Romanian emphasis doubling ("nu poți nu poți") or stream restart repeats.
    result = result.replace(/\b([\w']+(?:\s+[\w']+){1,2})\s+\1\b/gi, '$1');

    // Source-aware fix: "conștiință curată" = clean conscience (curată = adjective "clean/pure").
    // Claude sometimes picks the verb "cleanse" instead of the adjective "clean".
    if (/constiinta/i.test(sourceNorm)) {
        result = result.replace(/\bcleanse\s+conscience\b/gi, 'clean conscience');
    }

    // Fix noun/verb confusion: "will/can/could/etc. Decision" → "decide".
    // Claude occasionally uses the noun "Decision" after modal verbs instead of the verb.
    result = result.replace(/\b(will|can|could|might|may|should|would|to)\s+Decision\b/g, '$1 decide');

    // Source-aware fix: "adunare" = congregation (local) or assembly (circuit/district).
    // Google Translate maps "adunare" to "gathering" which is incorrect in JW context.
    if (/\badunare\b/i.test(sourceText)) {
        result = result.replace(/\bgathering\b/gi, 'congregation');
        result = result.replace(/\bgatherings\b/gi, 'congregations');
    }

    // Source-aware fix: "romani" in Romanian = Romani people/language (Roma), not Romans.
    // JW meetings regularly reference "limba romani" (Romani language) and "frații romani"
    // (Romani brothers). Exception: "cartea Romani" = the biblical book of Romans.
    if (/\bromani\b/i.test(sourceText) && !/cart(?:ea)?\s+romani\b/i.test(sourceText)) {
        result = result.replace(/\bRomans\b/g, 'Romani');
    }

    return result;
}

/**
 * Verify religious proper nouns survived translation correctly (en→ro direction).
 *
 * When translating English to Romanian, Google may produce incorrect variants of
 * JW proper nouns (e.g. 'Jehova' instead of 'Iehova', 'Biblie' instead of 'Biblia').
 * This function patches known bad variants to the authoritative Romanian JW form.
 *
 * Only runs when targetLang is 'ro'.
 *
 * @param {string} translated - Translation output to verify
 * @param {string} sourceText - Original English source (used to detect which terms appeared)
 * @param {string} targetLang - Target language code (only patches when 'ro')
 * @returns {string} Corrected translation
 */
function verifyReligiousTerms(translated, sourceText, targetLang) {
    if (targetLang !== 'ro') return translated;

    // English trigger term → canonical Romanian JW form
    const religiousTerms = {
        'jehovah':  'Iehova',
        'satan':    'Satana',
        'bible':    'Biblia',
        'jesus':    'Isus',
        'christ':   'Hristos',
        'god':      'Dumnezeu',
        'devil':    'diavolul',
        'kingdom':  'regatul',
        'heaven':   'cerul',
        'prayer':   'rugăciune',
        'faith':    'credință',
    };

    // Canonical Romanian form → incorrect variants Google may produce
    const romanianVariants = {
        'Iehova':    ['Iehvoa', 'Ievhova', 'Jehova'],
        'Satana':    ['Satan'],
        'Isus':      ['Iisus'],
        'Hristos':   ['Cristos', 'Christos'],
        'Dumnezeu':  ['Dumnezău'],
        'Biblia':    ['Biblie'],
        'diavolul':  ['diavol'],
        'regatul':   ['regat'],
        'cerul':     ['cer'],
        'rugăciune': ['rugăciunea'],
        'credință':  ['credința'],
    };

    const sourceLower = sourceText.toLowerCase();
    let result = translated;

    for (const [engTerm, roTerm] of Object.entries(religiousTerms)) {
        if (new RegExp('\\b' + engTerm + '\\b').test(sourceLower)) {
            for (const variant of (romanianVariants[roTerm] || [])) {
                const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), roTerm);
            }
        }
    }

    return result;
}

/**
 * Preserve numbers from source text to avoid numeric drift in translation.
 *
 * Google Translate sometimes alters or drops numbers. Romanian uses '.' as a
 * thousands separator ("68.128" = 68,128 in English); we must not replace
 * Google's correctly-converted English comma-format back to the dot-format.
 *
 * @param {string} sourceText - Original Romanian source with authoritative numbers
 * @param {string} translatedText - Translation output that may have drifted numbers
 * @returns {string} Translation with numbers restored from source
 */
function preserveSourceNumbers(sourceText, translatedText) {
    const numberRegex = /\d+(?:\.\d{3})+|\d+(?:[.,]\d+)?/g;
    const sourceNumbers = sourceText.match(numberRegex) || [];
    if (sourceNumbers.length === 0) return translatedText;

    const isRomanianThousands = (n) => /^(\d+\.)+\d{3}$/.test(n);

    let result = translatedText;
    const translatedNumbers = translatedText.match(numberRegex) || [];

    if (translatedNumbers.length === sourceNumbers.length) {
        sourceNumbers.forEach((srcNum, idx) => {
            if (isRomanianThousands(srcNum)) return;
            const targetNum = translatedNumbers[idx];
            if (targetNum) {
                result = result.replace(targetNum, srcNum);
            }
        });
        return result;
    }

    sourceNumbers.forEach((srcNum) => {
        if (isRomanianThousands(srcNum)) return;
        const digits = srcNum.replace(/[.,]/g, '');
        const splitPattern = new RegExp(`(\\d+[\\s.,]+){0,2}\\d+`, 'g');
        const matches = [...result.matchAll(splitPattern)];
        for (const m of matches) {
            const candidate = m[0];
            const candidateDigits = candidate.replace(/[\s.,]/g, '');
            if (candidateDigits === digits) {
                result = result.replace(candidate, srcNum);
                break;
            }
        }
    });

    return result;
}

/**
 * Preserve date components if month drops out in translation.
 *
 * Google sometimes drops the Romanian month name when translating a full date
 * ("15 martie 2024" → "15 2024"). Restores the month from source when missing.
 *
 * @param {string} sourceText - Original Romanian source with complete dates
 * @param {string} translatedText - Translation output that may be missing the month
 * @returns {string} Translation with dates restored
 */
function preserveDates(sourceText, translatedText) {
    const monthNames = [
        'ianuarie','februarie','martie','aprilie','mai','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie',
        'january','february','march','april','may','june','july','august','september','october','november','december'
    ];
    const monthRegex = new RegExp(`\\b(${monthNames.join('|')})\\b`, 'i');
    const dateRegex = /(\d{1,2})\s+([A-Za-zăâîșțéó]+)\s+(\d{4})/gi;

    let result = translatedText;
    let m;
    while ((m = dateRegex.exec(sourceText)) !== null) {
        const [, day, month, year] = m;
        const hasMonthInTranslation = monthRegex.test(result);
        const hasDay = result.includes(day);
        const hasYear = result.includes(year);

        if (hasDay && hasYear && !hasMonthInTranslation) {
            const dayYearPattern = new RegExp(`${day}[\\s.,]*${year}`);
            if (dayYearPattern.test(result)) {
                result = result.replace(dayYearPattern, `${day} ${month} ${year}`);
            } else {
                result = result.replace(year, `${month} ${year}`);
            }
        }
    }
    return result;
}

/**
 * Extract the unemitted portion of a full translation using word-level LCP matching.
 *
 * Sends the full STT transcript to Google Translate for maximum context quality,
 * then extracts only the new (unemitted) portion using word-level LCP matching.
 *
 * If ≥75% of committedTranslation words match the prefix of translatedFull,
 * returns the tail (new words). Otherwise returns null — caller should emit the
 * full translation.
 *
 * Romanian diacritics (ă, â, î, ș, ț) are preserved as word characters via
 * Unicode property escapes (\p{L}\p{N} with /u flag).
 *
 * @param {string} translatedFull - Translation of the full STT transcript
 * @param {string} committedTranslation - Full translation from the previous call
 * @returns {string|null} New tail to emit, or null if LCP ratio < 75%
 */
function extractByWordLCP(translatedFull, committedTranslation) {
    const trimmedFull = translatedFull.trim();
    const trimmedCommitted = committedTranslation.trim();
    if (!trimmedCommitted) return trimmedFull;
    if (!trimmedFull) return null;

    // Normalize: split on whitespace, strip leading/trailing punctuation, lowercase.
    // Use \p{L}\p{N} (unicode property escapes) so Romanian diacritics (ă, â, î, ș, ț)
    // are preserved as word characters and not stripped by the boundary replace.
    const normalizeWords = (s) =>
        s.split(/\s+/)
         .map(w => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
         .filter(w => w.length > 0);

    const committedNorm = normalizeWords(trimmedCommitted);
    const fullNorm = normalizeWords(trimmedFull);
    const fullOrigWords = trimmedFull.split(/\s+/);

    if (committedNorm.length === 0) return trimmedFull;
    if (fullNorm.length <= committedNorm.length) return null;

    // Greedy subsequence scan with bounded lookahead window.
    //
    // Problem: Google Translate non-determinism produces translations that differ in
    // multiple scattered ways: inserted/deleted articles ("the"), word-form changes
    // ("congregate"→"congregation"), synonym swaps ("connection"→"contact"). Strict
    // prefix matching breaks on the first difference; a substitution budget (previous
    // fix) is exhausted after 1-2 scattered changes in a 30-word sequence, so the
    // ratio drops below 75% and the entire full text is re-emitted as a duplicate.
    //
    // Solution: for each committed word, search for it in fullNorm within a small
    // lookahead window starting at the current scan position. If found, advance the
    // scan cursor past it. If not found (deleted or substituted in full), skip the
    // committed word without advancing the scan cursor — the 75% match threshold
    // still guards against genuine divergence.
    //
    // The tail starts immediately after the last matched full-position, so skipped
    // committed words and inserted full words between matched positions are absorbed
    // into the "committed prefix" region and do not re-appear in the output.
    //
    // WINDOW=3 handles up to 3 consecutive word insertions in full between any two
    // consecutive matched committed words (e.g. multiple articles/prepositions).
    const WINDOW = 3;
    let matchCount = 0;
    let lastMatchedInFull = -1;
    let iInFull = 0;

    for (let iCommitted = 0; iCommitted < committedNorm.length; iCommitted++) {
        if (iInFull >= fullNorm.length) break;
        const searchEnd = Math.min(iInFull + WINDOW + 1, fullNorm.length);
        for (let j = iInFull; j < searchEnd; j++) {
            if (fullNorm[j] === committedNorm[iCommitted]) {
                matchCount++;
                lastMatchedInFull = j;
                iInFull = j + 1;
                break;
            }
        }
        // If not found in window: committed word was deleted or substituted in full.
        // Don't advance iInFull — retry from same position for the next committed word.
    }

    const matchRatio = matchCount / committedNorm.length;
    if (matchRatio < 0.75) return null;
    if (lastMatchedInFull < 0) return null;

    const tail = fullOrigWords.slice(lastMatchedInFull + 1).join(' ').trim();
    return tail || null;
}

module.exports = {
    applyTermMappings,
    verifyReligiousTerms,
    preserveSourceNumbers,
    preserveDates,
    extractByWordLCP,
};
