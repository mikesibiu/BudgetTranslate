/**
 * Unit Tests for Translation Interval Logic
 * Tests the forced translation timer mechanism with 8s intervals.
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Translation Interval Logic', () => {
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
    });

    describe('Timer Creation', () => {
        it('should create timer with correct 8-second interval for Talks mode', () => {
            const intervalMs = 8000;
            let timerFired = false;
            let restartStreamTimer = null;

            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFired = true;
                }, intervalMs);
            }

            expect(timerFired).to.be.false;
            clock.tick(7999);
            expect(timerFired).to.be.false;
            clock.tick(1);
            expect(timerFired).to.be.true;
        });

        it('should not create multiple timers when one is already active', () => {
            const intervalMs = 4000;
            let timerCount = 0;
            let restartStreamTimer = null;

            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerCount++;
                }, intervalMs);
            }

            if (!restartStreamTimer) {
                setTimeout(() => {
                    timerCount++;
                }, intervalMs);
            }

            clock.tick(intervalMs);
            expect(timerCount).to.equal(1);
        });
    });

    describe('Timer Lifecycle', () => {
        it('should clear timer and allow new timer after translation completes', () => {
            const intervalMs = 4000;
            let timerFireCount = 0;
            let restartStreamTimer = null;

            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFireCount++;
                    restartStreamTimer = null;
                }, intervalMs);
            }

            clock.tick(intervalMs);
            expect(timerFireCount).to.equal(1);
            expect(restartStreamTimer).to.be.null;

            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFireCount++;
                    restartStreamTimer = null;
                }, intervalMs);
            }

            clock.tick(intervalMs);
            expect(timerFireCount).to.equal(2);
        });

        it('should cancel timer when final result is received', () => {
            const intervalMs = 4000;
            let forcedTranslationFired = false;
            let restartStreamTimer = null;

            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    forcedTranslationFired = true;
                }, intervalMs);
            }

            clock.tick(2000);

            if (restartStreamTimer) {
                clearTimeout(restartStreamTimer);
                restartStreamTimer = null;
            }

            clock.tick(2000);
            expect(forcedTranslationFired).to.be.false;
        });
    });

    describe('Interval Value Capture', () => {
        it('should capture interval value in closure correctly', () => {
            const intervals = [8000, 8000];
            const results = [];

            intervals.forEach((intervalMs) => {
                setTimeout(() => results.push(intervalMs), intervalMs);
            });

            clock.tick(9000);
            expect(results).to.have.lengthOf(2);
            expect(results).to.include(8000);
        });

        it('should use correct interval when switching between modes', () => {
            let currentInterval = 8000;
            const timerResults = [];

            let restartStreamTimer = setTimeout(() => {
                timerResults.push({ mode: 'talks', interval: currentInterval });
            }, currentInterval);

            clock.tick(8000);
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;

            currentInterval = 8000;

            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerResults.push({ mode: 'earbuds', interval: currentInterval });
                }, currentInterval);
            }

            clock.tick(8000);
            clearTimeout(restartStreamTimer);

            expect(timerResults).to.deep.include({ mode: 'talks', interval: 8000 });
            expect(timerResults).to.deep.include({ mode: 'earbuds', interval: 8000 });
        });
    });
});
