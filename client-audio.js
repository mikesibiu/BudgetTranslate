// BudgetTranslate audio methods — wake lock, recording, audio level
// Requires: client.js loaded before this script

Object.assign(GTranslateV4Client.prototype, {
    async requestWakeLock() {
        // Release any existing sentinel before acquiring a new one (prevents double-sentinel leak)
        await this.releaseWakeLock();

        // Request screen wake lock to keep screen on during recording
        // Critical for mobile EarBuds mode where user listens with screen off
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('🔒 Screen wake lock acquired - screen will stay on');
                this.startWakeLockHeartbeat();

                // Re-acquire wake lock automatically if it's released
                this.wakeLock.addEventListener('release', async () => {
                    console.log('🔓 Wake lock released - attempting to re-acquire');

                    // Only re-acquire if we're still recording
                    if (this.isRecording) {
                        try {
                            await this.requestWakeLock();
                            console.log('🔒 Wake lock re-acquired successfully');
                        } catch (err) {
                            console.warn('⚠️ Could not re-acquire wake lock:', err.message);
                        }
                    }
                });
            } catch (err) {
                console.warn('⚠️ Could not acquire wake lock:', err.message);
                // Non-fatal - continue without wake lock

                // Warn user on mobile if wake lock fails
                if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
                    this.updateStatus('⚠️ Screen may turn off - keep phone unlocked', 'warning');
                }
            }
        } else {
            console.log('ℹ️ Wake Lock API not supported on this device');

            // Warn mobile users that screen must stay on
            if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
                this.updateStatus('⚠️ Keep screen on - app will stop if screen locks', 'warning');
                setTimeout(() => {
                    this.updateStatus('Listening...', 'listening');
                }, 5000);
            }
        }
    },

    startWakeLockHeartbeat() {
        if (this.wakeLockHeartbeat || !('wakeLock' in navigator)) {
            return;
        }

        this.wakeLockHeartbeat = setInterval(async () => {
            if (!this.isRecording) {
                this.stopWakeLockHeartbeat();
                return;
            }

            if (!this.wakeLock) {
                try {
                    await this.requestWakeLock();
                } catch (err) {
                    console.warn('⚠️ Wake lock heartbeat failed:', err.message);
                }
            }
        }, 45000); // Retry roughly every 45 seconds
    },

    stopWakeLockHeartbeat() {
        if (this.wakeLockHeartbeat) {
            clearInterval(this.wakeLockHeartbeat);
            this.wakeLockHeartbeat = null;
        }
    },

    async releaseWakeLock() {
        if (this.wakeLock) {
            try {
                await this.wakeLock.release();
                this.wakeLock = null;
                console.log('🔓 Screen wake lock released - screen can turn off');
            } catch (err) {
                console.warn('⚠️ Error releasing wake lock:', err);
            }
        }

        this.stopWakeLockHeartbeat();
    },

    async startRecording() {
        try {
            // Request wake lock to keep screen on (critical for mobile EarBuds mode)
            await this.requestWakeLock();

            // Validate inputs before starting
            const sourceLanguage = this.sourceLanguage.value;
            const targetLang = this.targetLanguage.value;
            const audioSourceType = this.audioSource.value;

            // Input validation
            if (!sourceLanguage || !targetLang) {
                throw new Error('Please select both source and target languages');
            }

            const validLanguageCodes = /^[a-z]{2}-[A-Z]{2}$/;
            const validTargetLanguages = /^[a-z]{2}(-[A-Z]{2})?$/;

            if (!validLanguageCodes.test(sourceLanguage)) {
                throw new Error('Invalid source language code');
            }

            if (!validTargetLanguages.test(targetLang)) {
                throw new Error('Invalid target language code');
            }

            if (typeof this.translationInterval !== 'number' || this.translationInterval < 1000 || this.translationInterval > 60000) {
                throw new Error('Invalid translation interval');
            }

            if (audioSourceType !== 'microphone') {
                throw new Error('Invalid audio source');
            }

            // Start Web Speech API recognition
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                throw new Error('Web Speech API not supported. Please use Chrome or Edge.');
            }

            this.recognition = new SpeechRecognition();
            this.recognition.lang = sourceLanguage || 'ro-RO';
            this.recognition.continuous = true;
            this.recognition.interimResults = true;
            this.recognition.maxAlternatives = 1;

            this.lastSpeechResultTime = Date.now();

            this.recognition.onresult = (event) => {
                if (!this.isRecording) return;
                this.lastSpeechResultTime = Date.now(); // Reset watchdog
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    const isFinal = event.results[i].isFinal;
                    this.socket.emit('transcript-result', { text: transcript, isFinal });
                }
            };

            this.recognition.onend = () => {
                // Chrome cuts off after ~60s — auto-restart if still recording
                if (this.isRecording) {
                    console.log('🔄 Web Speech API ended, restarting...');
                    this.lastSpeechResultTime = Date.now(); // Reset watchdog on restart
                    try { this.recognition.start(); } catch(e) { console.warn('Restart failed:', e); }
                }
            };

            this.recognition.onerror = (event) => {
                console.error('Web Speech API error:', event.error);
                if (event.error === 'not-allowed') {
                    this.updateStatus('❌ Microphone permission denied', 'error');
                    this.stopRecording();
                } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
                    console.warn('Speech recognition error:', event.error);
                }
            };

            // Watchdog: if Chrome silently stalls (no onend fires, just stops delivering
            // results), restart after 45 seconds of silence. 45s chosen to avoid false
            // positives during prayers/songs which can run 2-3 minutes — the no-speech
            // error + onend loop handles those; this only catches true silent stalls.
            this.speechWatchdog = setInterval(() => {
                if (!this.isRecording) return;
                const silentMs = Date.now() - this.lastSpeechResultTime;
                if (silentMs > 45000) {
                    console.warn('⚠️ Watchdog: no results for 45s — forcing recognition restart');
                    this.lastSpeechResultTime = Date.now();
                    try {
                        this.recognition.stop(); // triggers onend → restart
                    } catch(e) {
                        console.warn('Watchdog restart failed:', e);
                    }
                }
            }, 10000);

            this.recognition.start();
            console.log('🎤 Web Speech API started (lang: ' + this.recognition.lang + ')');

            // Tell server to initialize translation session
            this.socket.emit('start-session', {
                sourceLanguage: sourceLanguage,
                targetLang: targetLang,
                mode: this.currentMode
            });

            this.isRecording = true;
            this.sttStartTime = Date.now(); // Start STT billing timer
            this.startAudioLevelMonitor();
            this.translationCount = 0;
            this.wordsTranslated = 0;
            this.resultsContainer.innerHTML = '';
            clearTimeout(this.paragraphSealTimer);
            this.paragraphSealTimer = null;
            this.currentParagraphEl = null;
            this.paragraphWordCount = 0;
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
            this.audioSource.disabled = true;
            this.sourceLanguage.disabled = true;
            this.targetLanguage.disabled = true;

            this.startSessionTimer();

        } catch (error) {
            console.error('Failed to start recording:', error);
            this.updateStatus(`Error: ${error.message}`, 'error');
        }
    },

    stopRecording() {
        this.isRecording = false;
        this.stopAudioLevelMonitor();

        // Track STT usage for billing
        if (this.sttStartTime && this.currentSourceLanguage) {
            const sttDurationMs = Date.now() - this.sttStartTime;
            const sttMinutes = sttDurationMs / 60000;
            this.trackBilling('stt', sttMinutes, this.currentSourceLanguage);
            this.sttStartTime = null;
        }

        // Release wake lock - screen can turn off now
        this.releaseWakeLock();

        if (this.speechWatchdog) {
            clearInterval(this.speechWatchdog);
            this.speechWatchdog = null;
        }

        if (this.recognition) {
            this.recognition.onend = null; // Prevent auto-restart
            this.recognition.stop();
            this.recognition = null;
        }

        this.socket.emit('stop-session');

        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        this.audioSource.disabled = false;
        this.sourceLanguage.disabled = false;
        this.targetLanguage.disabled = false;

        this.stopSessionTimer();
        this.updateStatus('Ready to start', 'ready');
        this.interimText.textContent = 'Waiting for speech...';
        this.lastTranslation = '';
        this.lastTranslationTime = 0;
        clearTimeout(this.paragraphSealTimer);
        this.paragraphSealTimer = null;
        this.currentParagraphEl = null;
        this.paragraphWordCount = 0;

        // Stop any playing speech and clear queue
        if (this.speechSynthesis) {
            this.speechSynthesis.cancel();
            this.ttsQueue = []; // Clear pending translations
            this.isSpeaking = false;
            console.log('🔇 TTS stopped and queue cleared');
        }
    },

    updateAudioLevel(level) {
        // level is 0.0 to 1.0
        const percentage = Math.round(level * 100);
        this.audioLevelBar.style.width = `${percentage}%`;
        this.audioLevelText.textContent = `${percentage}%`;

        // Change color based on level
        if (level < 0.01) {
            this.audioLevelText.style.color = '#999'; // Too quiet
        } else if (level < 0.1) {
            this.audioLevelText.style.color = '#ff9800'; // Weak
        } else {
            this.audioLevelText.style.color = '#4caf50'; // Good
        }
    }
});
