'use strict';

/**
 * Golden Corpus — LCP extraction regression suite
 *
 * Each fixture in golden-lcp.json is a {committed, full, expectedTail} triplet
 * recorded from real or realistic production content. Running extractByWordLCP
 * against these fixtures without touching the live API catches algorithmic
 * regressions (synonym-swap repeats, index alignment bugs, etc.) on every CI run.
 *
 * To update fixtures when Google Translate output legitimately changes:
 *   1. Run the live system, capture the new committed/full pair from Koyeb logs
 *   2. Add the pair here with a clear description
 *   3. expectedTail: null means LCP correctly fails (full text will be emitted)
 */

const { expect } = require('chai');
const path = require('path');
const { extractByWordLCP } = require('../translation-post-processor');
const fixtures = require('./fixtures/golden-lcp.json');

describe('Golden Corpus: extractByWordLCP', () => {
    for (const fixture of fixtures) {
        it(fixture.description, () => {
            const result = extractByWordLCP(fixture.full, fixture.committed);

            if (fixture.expectedTail === null) {
                expect(result).to.be.null;
            } else {
                expect(result).to.not.be.null;
                expect(result.trim().toLowerCase())
                    .to.equal(fixture.expectedTail.trim().toLowerCase());
            }
        });
    }
});
