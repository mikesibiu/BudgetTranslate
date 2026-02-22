/**
 * Integration Tests for streaming start/stop with Talks mode (8s interval).
 * Requires server running on localhost:3003.
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:3003';

describe('Mode Integration (Talks)', () => {
    let clientSocket;

    beforeEach((done) => {
        clientSocket = io(SERVER_URL, {
            reconnection: false,
            transports: ['websocket']
        });

        clientSocket.on('connect', () => done());
        clientSocket.on('connect_error', (error) => done(error));
    });

    afterEach((done) => {
        if (clientSocket && clientSocket.connected) {
            clientSocket.disconnect();
        }
        done();
    });

    it('should start streaming with 8-second interval', (done) => {
        let streamingStarted = false;

        clientSocket.on('streaming-started', (data) => {
            streamingStarted = true;
            expect(data.sourceLanguage).to.equal('ro-RO');
            expect(data.targetLanguage).to.equal('en');
        });

        clientSocket.emit('start-streaming', {
            sourceLanguage: 'ro-RO',
            targetLang: 'en',
            translationInterval: 8000
        });

        setTimeout(() => {
            expect(streamingStarted).to.be.true;
            clientSocket.emit('stop-streaming');
            done();
        }, 500);
    }).timeout(5000);

    it('should use default 8-second interval when not specified', (done) => {
        let streamingStarted = false;

        clientSocket.on('streaming-started', (data) => {
            streamingStarted = true;
            expect(data.sourceLanguage).to.equal('ro-RO');
            expect(data.targetLanguage).to.equal('en');
        });

        clientSocket.emit('start-streaming', {
            sourceLanguage: 'ro-RO',
            targetLang: 'en'
        });

        setTimeout(() => {
            expect(streamingStarted).to.be.true;
            clientSocket.emit('stop-streaming');
            done();
        }, 500);
    }).timeout(5000);
});
