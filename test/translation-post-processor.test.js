'use strict';

/**
 * Unit tests for translation-post-processor.js
 *
 * Covers: extractByWordLCP, applyTermMappings, verifyReligiousTerms,
 *         preserveSourceNumbers, preserveDates
 *
 * Each test is named after the real production bug or regression it protects.
 */

const { expect } = require('chai');
const {
    extractByWordLCP,
    applyTermMappings,
    verifyReligiousTerms,
    preserveSourceNumbers,
    preserveDates,
} = require('../translation-post-processor');

// ─────────────────────────────────────────────────────────────────────────────
// extractByWordLCP
// ─────────────────────────────────────────────────────────────────────────────
describe('extractByWordLCP', () => {

    describe('base cases', () => {
        it('returns full text when committedTranslation is empty', () => {
            expect(extractByWordLCP('Hello world today', '')).to.equal('Hello world today');
        });

        it('returns null when translatedFull is empty', () => {
            expect(extractByWordLCP('', 'Hello')).to.be.null;
        });

        it('returns null when translatedFull has no more words than committed', () => {
            // Nothing new to emit
            expect(extractByWordLCP('Hello world', 'Hello world')).to.be.null;
        });

        it('returns null when translated is shorter than committed', () => {
            expect(extractByWordLCP('Hello', 'Hello world')).to.be.null;
        });
    });

    describe('happy path extraction', () => {
        it('extracts tail when prefix matches 100%', () => {
            const result = extractByWordLCP(
                'Hello world today is a great day',
                'Hello world today'
            );
            expect(result).to.equal('is a great day');
        });

        it('preserves original casing and punctuation in tail', () => {
            const result = extractByWordLCP(
                'Hello world. Today is great!',
                'Hello world.'
            );
            expect(result).to.equal('Today is great!');
        });

        it('handles leading/trailing whitespace in inputs', () => {
            const result = extractByWordLCP(
                '  Hello world today  ',
                '  Hello  '
            );
            expect(result).to.equal('world today');
        });
    });

    describe('75% threshold boundary', () => {
        it('returns tail when match ratio is exactly 75% (3 of 4 words)', () => {
            // committed = 4 words: "one two three four"
            // full starts with: "one two three X ..." — 3/4 = 75% — should succeed
            const result = extractByWordLCP(
                'one two three DIFFERENT plus more words',
                'one two three four'
            );
            expect(result).to.equal('DIFFERENT plus more words');
        });

        it('returns null when match ratio is below 75% (2 of 4 words = 50%)', () => {
            // committed = 4 words, only 2 match prefix → 50% < 75%
            const result = extractByWordLCP(
                'one two completely different sentence here',
                'one two three four'
            );
            expect(result).to.be.null;
        });

        it('returns null when first word does not match (0%)', () => {
            const result = extractByWordLCP('Totally different text here', 'Hello world');
            expect(result).to.be.null;
        });
    });

    describe('Romanian diacritics (regression: unicode property escapes)', () => {
        it('matches words with ă correctly', () => {
            const result = extractByWordLCP(
                'Frații noștri buni să fie binecuvântați',
                'Frații noștri buni'
            );
            expect(result).to.equal('să fie binecuvântați');
        });

        it('matches words with â, î, ș, ț without stripping them', () => {
            // If unicode property escapes are broken, diacritics get stripped
            // and "Frații" → "" (empty), breaking matching
            const result = extractByWordLCP(
                'Frații buni din congregație sunt acolo',
                'Frații buni din'
            );
            expect(result).to.equal('congregație sunt acolo');
        });

        it('strips punctuation but keeps diacritics for comparison', () => {
            // "Frații," (with comma) should still match "Frații" in committed
            const result = extractByWordLCP(
                'Frații, noștri sunt buni',
                'Frații noștri'
            );
            expect(result).to.equal('sunt buni');
        });
    });

    describe('case-insensitive comparison', () => {
        it('matches committed lowercase against full mixed-case', () => {
            const result = extractByWordLCP('Hello World Today', 'hello world');
            expect(result).to.equal('Today');
        });

        it('matches committed mixed-case against full lowercase', () => {
            const result = extractByWordLCP('hello world today', 'Hello World');
            expect(result).to.equal('today');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyTermMappings
// ─────────────────────────────────────────────────────────────────────────────
describe('applyTermMappings', () => {

    describe('static mappings (no source needed)', () => {
        it('vestitori → publishers', () => {
            expect(applyTermMappings('The vestitori of Jehovah work hard')).to.equal(
                "The publishers of Jehovah work hard"
            );
        });

        it('Martorii lui Iehova → Jehovah\'s Witnesses', () => {
            expect(applyTermMappings('Martorii lui Iehova are present')).to.equal(
                "Jehovah's Witnesses are present"
            );
        });

        it('congress → convention (singular)', () => {
            expect(applyTermMappings('The annual congress was held')).to.equal(
                'The annual convention was held'
            );
        });

        it('congresses → conventions (plural)', () => {
            expect(applyTermMappings('Three congresses happened this year')).to.equal(
                'Three conventions happened this year'
            );
        });

        it('Bible reference: "Proverbs of 7,3" → "Proverbs 7:3"', () => {
            expect(applyTermMappings('As written in Proverbs of 7,3 we learn')).to.equal(
                'As written in Proverbs 7:3 we learn'
            );
        });

        it('Bible reference: "Matthew of 5.3" → "Matthew 5:3"', () => {
            expect(applyTermMappings('Read Matthew of 5.3 today')).to.equal(
                'Read Matthew 5:3 today'
            );
        });

        it('say me → tell me (grammar fix)', () => {
            expect(applyTermMappings('He wants to say me the truth')).to.equal(
                'He wants to tell me the truth'
            );
        });

        it('says us → tells us (grammar fix)', () => {
            expect(applyTermMappings('The elder says us to study more')).to.equal(
                'The elder tells us to study more'
            );
        });

        it('duplicate 2-word phrase collapsed', () => {
            expect(applyTermMappings("you can't you can't do that")).to.equal(
                "you can't do that"
            );
        });

        it('duplicate 3-word phrase collapsed', () => {
            expect(applyTermMappings('we need to we need to pray')).to.equal(
                'we need to pray'
            );
        });

        it('will Decision → will decide', () => {
            expect(applyTermMappings('We will Decision together')).to.equal(
                'We will decide together'
            );
        });

        it('can Decision → can decide', () => {
            expect(applyTermMappings('You can Decision now')).to.equal(
                'You can decide now'
            );
        });
    });

    describe('source-aware: congregație (with and without diacritics)', () => {
        it('church → congregation when source contains "congregație"', () => {
            expect(applyTermMappings('The church met on Sunday', 'în congregație'))
                .to.equal('The congregation met on Sunday');
        });

        it('church → congregation when source has "congregatie" (no diacritics, Deepgram drop)', () => {
            // Regression: Deepgram sometimes transcribes "congregație" as "congregatie"
            expect(applyTermMappings('Visit our church today', 'la congregatie'))
                .to.equal('Visit our congregation today');
        });

        it('churches → congregations (plural)', () => {
            expect(applyTermMappings('The churches are active', 'în congregație'))
                .to.equal('The congregations are active');
        });

        it('does NOT replace church when source has no congregație', () => {
            expect(applyTermMappings('We visited the church', 'ne-am bucurat mult'))
                .to.equal('We visited the church');
        });
    });

    describe('source-aware: congres beast garble', () => {
        it('beast → convention when source has "congres"', () => {
            expect(applyTermMappings('The beast was large', 'la congres special'))
                .to.equal('The convention was large');
        });

        it('beasts → conventions (plural)', () => {
            expect(applyTermMappings('Two beasts were there', 'la congrese speciale'))
                .to.equal('Two conventions were there');
        });
    });

    describe('source-aware: bunătate → kindness', () => {
        it('money → kindness when source has "bunătate"', () => {
            expect(applyTermMappings('Show money to others', 'bunătate față de toți'))
                .to.equal('Show kindness to others');
        });

        it('money → kindness when source has "bunatate" (diacritic dropped by STT)', () => {
            expect(applyTermMappings('We need money', 'bunatate si iubire'))
                .to.equal('We need kindness');
        });
    });

    describe('source-aware: cu siguranță → certainly', () => {
        it('safety → certainly when source has "cu siguranță"', () => {
            expect(applyTermMappings('This is for our safety', 'cu siguranță vom fi'))
                .to.equal('This is for our certainly');
        });

        it('Safety (capitalized) → Certainly when source has "cu siguranta" (no diacritics)', () => {
            expect(applyTermMappings('Safety is paramount', 'cu siguranta'))
                .to.equal('Certainly is paramount');
        });
    });

    describe('source-aware: conștiință → clean conscience', () => {
        it('cleanse conscience → clean conscience when source has "conștiință"', () => {
            expect(applyTermMappings('We must cleanse conscience always', 'conștiință curată'))
                .to.equal('We must clean conscience always');
        });

        it('works with diacritic-stripped "constiinta" in source', () => {
            expect(applyTermMappings('to cleanse conscience', 'constiinta curata'))
                .to.equal('to clean conscience');
        });
    });

    describe('source-aware: adunare → congregation', () => {
        it('gathering → congregation when source has "adunare"', () => {
            expect(applyTermMappings('The gathering will meet', 'adunare de circuit'))
                .to.equal('The congregation will meet');
        });

        it('gatherings → congregations (plural)', () => {
            expect(applyTermMappings('All gatherings are invited', 'adunare de circuit'))
                .to.equal('All congregations are invited');
        });
    });

    describe('source-aware: romani → Romani', () => {
        it('Romans → Romani when source has "romani" (people/language)', () => {
            expect(applyTermMappings('The Romans are here', 'frații romani din'))
                .to.equal('The Romani are here');
        });

        it('does NOT replace Romans when source has "cartea Romani" (biblical book)', () => {
            expect(applyTermMappings('As Paul wrote in Romans 5:8', 'cartea Romani'))
                .to.equal('As Paul wrote in Romans 5:8');
        });
    });

    describe('no source changes when no triggers present', () => {
        it('leaves clean English output unchanged', () => {
            const clean = 'Jehovah blesses those who seek righteousness.';
            expect(applyTermMappings(clean)).to.equal(clean);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyReligiousTerms
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyReligiousTerms', () => {

    describe('passthrough for non-Romanian targets', () => {
        it('does nothing when targetLang is "en"', () => {
            const text = 'We love Jehova and his Biblie';
            expect(verifyReligiousTerms(text, 'jehovah bible', 'en')).to.equal(text);
        });

        it('does nothing when targetLang is "fr"', () => {
            const text = 'Jehova est notre Seigneur';
            expect(verifyReligiousTerms(text, 'jehovah', 'fr')).to.equal(text);
        });
    });

    describe('Romanian term correction', () => {
        it('Jehova → Iehova when "jehovah" in source', () => {
            expect(verifyReligiousTerms('Jehova ne iubește', 'Jehovah loves us', 'ro'))
                .to.equal('Iehova ne iubește');
        });

        it('Iehvoa → Iehova (typo variant)', () => {
            expect(verifyReligiousTerms('Iehvoa este bun', 'jehovah', 'ro'))
                .to.equal('Iehova este bun');
        });

        it('Ievhova → Iehova (transposition variant)', () => {
            expect(verifyReligiousTerms('Ievhova ne ajută', 'jehovah', 'ro'))
                .to.equal('Iehova ne ajută');
        });

        it('Biblie → Biblia when "bible" in source', () => {
            expect(verifyReligiousTerms('Citiți din Biblie zilnic', 'Read the Bible daily', 'ro'))
                .to.equal('Citiți din Biblia zilnic');
        });

        it('Iisus → Isus when "jesus" in source', () => {
            expect(verifyReligiousTerms('Iisus Hristos', 'Jesus Christ', 'ro'))
                .to.equal('Isus Hristos');
        });

        it('Cristos → Hristos when "christ" in source', () => {
            expect(verifyReligiousTerms('Isus Cristos este Domn', 'Jesus Christ is Lord', 'ro'))
                .to.equal('Isus Hristos este Domn');
        });

        it('Satan → Satana when "satan" in source', () => {
            expect(verifyReligiousTerms('Satan este înfrânt', 'satan is defeated', 'ro'))
                .to.equal('Satana este înfrânt');
        });

        it('Dumnezău → Dumnezeu when "god" in source', () => {
            expect(verifyReligiousTerms('Dumnezău ne cheamă', 'God calls us', 'ro'))
                .to.equal('Dumnezeu ne cheamă');
        });

        it('fixes multiple terms in one pass', () => {
            const result = verifyReligiousTerms(
                'Jehova și Iisus și Biblie',
                'Jehovah and Jesus and the Bible',
                'ro'
            );
            expect(result).to.equal('Iehova și Isus și Biblia');
        });
    });

    describe('no false replacements', () => {
        it('does not replace when trigger term absent from source', () => {
            // "jehovah" not in source → no replacement
            const text = 'Jehova ne binecuvântează';
            expect(verifyReligiousTerms(text, 'God loves us', 'ro')).to.equal(text);
        });

        it('does not do partial word matches (word boundary check)', () => {
            // "godly" contains "god" but must not trigger the "god" fix
            const text = 'diavol este prezent';
            expect(verifyReligiousTerms(text, 'godly behaviour', 'ro')).to.equal(text);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveSourceNumbers
// ─────────────────────────────────────────────────────────────────────────────
describe('preserveSourceNumbers', () => {

    it('returns translated unchanged when source has no numbers', () => {
        expect(preserveSourceNumbers('Hello world', 'Hello world translated')).to.equal(
            'Hello world translated'
        );
    });

    it('preserves a simple integer from source', () => {
        expect(preserveSourceNumbers('psalm 23', 'psalm 24')).to.equal('psalm 23');
    });

    it('preserves decimal numbers from source', () => {
        expect(preserveSourceNumbers('rata de 3,5%', 'rate of 3.8%')).to.equal('rate of 3,5%');
    });

    it('does NOT replace Romanian thousands separator (68.128 → stays as 68,128 in English)', () => {
        // Romanian "68.128" = 68,128 in English; Google correctly converts to "68,128"
        // We must NOT restore the dot-format back (would make English readers see a decimal)
        const result = preserveSourceNumbers('68.128 de frați', '68,128 brothers');
        expect(result).to.equal('68,128 brothers');
    });

    it('does NOT replace multi-group Romanian thousands (1.234.567)', () => {
        const result = preserveSourceNumbers('1.234.567 de membri', '1,234,567 members');
        expect(result).to.equal('1,234,567 members');
    });

    it('preserves year numbers (non-thousands)', () => {
        const result = preserveSourceNumbers('în 2024', 'in 2025');
        expect(result).to.equal('in 2024');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveDates
// ─────────────────────────────────────────────────────────────────────────────
describe('preserveDates', () => {

    it('returns translated unchanged when source has no date', () => {
        expect(preserveDates('Hello world', 'Hello world')).to.equal('Hello world');
    });

    it('restores missing month in translated output', () => {
        // Google dropped "martie" from translation
        const result = preserveDates(
            'conferința din 15 martie 2024',
            'the conference on 15 2024'
        );
        expect(result).to.equal('the conference on 15 martie 2024');
    });

    it('leaves translation unchanged when month already present', () => {
        const result = preserveDates(
            'în 10 ianuarie 2023',
            'on January 10, 2023'
        );
        // Month already present ("January") → no change
        expect(result).to.equal('on January 10, 2023');
    });

    it('handles Romanian diacritic month names in source', () => {
        const result = preserveDates(
            'adunarea din 3 septembrie 2025',
            'the meeting on 3 2025'
        );
        expect(result).to.equal('the meeting on 3 septembrie 2025');
    });
});
