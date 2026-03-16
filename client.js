// BudgetTranslate client — core class
// Requires: client-utils.js loaded before this script
// Audio/session/TTS methods mixed in by client-audio.js, client-session.js, client-tts.js

class GTranslateV4Client {
    constructor() {
        this.socket = null;
        this.recognition = null;
        this.audioContext = null;
        this.mediaStream = null;
        this.levelStream = null;
        this.analyserNode = null;
        this.levelAnimFrame = null;
        this.processor = null;
        this.isRecording = false;
        this.translationCount = 0;
        this.sessionStartTime = null;
        this.sessionTimer = null;
        this.wordsTranslated = 0;
        this.audioChunkBuffer = [];
        this.audioBufferSize = 4096;
        this.translationInterval = 6000; // Default: 6 seconds
        this.interimElements = new Set(); // Track interim DOM elements for fast removal
        this.audioWorkletLoaded = false; // Prevent loading module multiple times
        this.lastTranslation = ''; // Store last translated text for EarBuds/TTS display
        this.lastTranslationTime = 0; // Timestamp of last translation update
        this.lastEarbudsInterimSpoken = '';
        this.wakeLockHeartbeat = null;

        // Network quality monitoring
        this.pingStartTime = null;
        this.latency = 0;
        this.latencyHistory = [];
        this.latencyMonitorInterval = null;

        // Session export data
        this.sessionTranslations = [];
        this.MAX_SESSION_TRANSLATIONS = 1000; // Prevent memory exhaustion

        // Mode tracking
        this.currentMode = 'talks'; // Default mode: talks or earbuds

        // Text-to-Speech
        this.ttsEnabled = false;
        this.speechSynthesis = window.speechSynthesis;
        this.currentUtterance = null;
        this.ttsQueue = []; // Queue for pending translations to speak
        this.isSpeaking = false; // Track if currently speaking
        this._speakStartTime = 0; // Watchdog: timestamp when TTS speech started
        this.speechRate = 0.9; // Default speech rate (slower = less anxious/rushed)
        this.voicePreference = 'auto'; // Voice selection preference ('auto' or voice name)
        this.selectedVoice = null; // Actual voice object when user selects specific voice
        this.voiceCache = new Map(); // Cache voices by language for fast lookup
        this.recentlySpoken = []; // Track recently spoken text with timestamps (for duplicate detection)
        this.lastDedupCleanup = 0; // Last time we cleaned up recentlySpoken array

        // Load saved voice preference from localStorage
        const savedVoicePreference = localStorage.getItem('gtranslate_voice_preference');
        if (savedVoicePreference) {
            this.voicePreference = savedVoicePreference;
            console.log(`🎤 Loaded saved voice preference: ${this.voicePreference}`);
        }

        // STT billing tracking
        this.sttStartTime = null;
        this.currentSourceLanguage = null;

        // Screen Wake Lock (keep screen on during recording)
        this.wakeLock = null;

        // Initialize voice cache (handle race condition)
        if (this.speechSynthesis) {
            // Handle voiceschanged event (fires when voices are loaded)
            this.speechSynthesis.addEventListener('voiceschanged', () => {
                console.log('🎤 voiceschanged event fired');
                this.buildVoiceCache();
            });

            // Try immediate load (works in Safari/Firefox, fails in Chrome/Edge)
            const immediateVoices = this.speechSynthesis.getVoices();
            if (immediateVoices.length > 0) {
                console.log('🎤 Voices available immediately:', immediateVoices.length);
                this.buildVoiceCache();
            } else {
                console.log('🎤 Voices not loaded yet, waiting for voiceschanged event...');
            }
        }

        // Check browser compatibility on startup
        this.checkBrowserCompatibility();

        this.initElements();
        this.initSocket();
        this.initModeToggle();
    }

    checkBrowserCompatibility() {
        const issues = [];

        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            issues.push('❌ Web Speech API not supported — please use Chrome or Edge');
        }

        if (typeof WebSocket === 'undefined') {
            issues.push('❌ WebSocket not supported');
        }

        const ua = navigator.userAgent;
        const isChrome = /Chrome/.test(ua) && /Google Inc/.test(navigator.vendor);
        const isEdge = /Edg/.test(ua);

        if (!isChrome && !isEdge) {
            issues.push('⚠️ For best results, use Chrome or Edge (Web Speech API works best there)');
        }

        if (issues.length > 0) {
            console.warn('Browser compatibility issues:', issues);
            const hasErrors = issues.some(i => i.startsWith('❌'));
            if (hasErrors) {
                alert('Browser compatibility issue:\n\n' + issues.join('\n'));
            }
        }
    }

    initElements() {
        this.startBtn = document.getElementById('startBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.audioSource = document.getElementById('audioSource');
        this.sourceLanguage = document.getElementById('sourceLanguage');
        this.targetLanguage = document.getElementById('targetLanguage');
        this.statusDiv = document.getElementById('status');
        this.interimText = document.getElementById('interimText');
        this.resultsContainer = document.getElementById('resultsContainer');
        this.translationCountEl = document.getElementById('translationCount');
        this.sessionTimeEl = document.getElementById('sessionTime');
        this.wordsTranslatedEl = document.getElementById('wordsTranslated');
        this.audioLevelBar = document.getElementById('audioLevelBar');
        this.audioLevelText = document.getElementById('audioLevelText');
        this.exportBtn = document.getElementById('exportBtn');
        this.ttsRateContainer = document.getElementById('ttsRateContainer');
        this.ttsRateSelect = document.getElementById('ttsRate');
        this.voiceSelectionContainer = document.getElementById('voiceSelectionContainer');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.micGainSlider = document.getElementById('micGainSlider');
        this.micGainValue = document.getElementById('micGainValue');
        this.autoGainToggle = document.getElementById('autoGainToggle');
        this.gainHint = document.getElementById('gainHint');

        this.startBtn.addEventListener('click', () => this.startRecording());
        this.stopBtn.addEventListener('click', () => this.stopRecording());
        this.exportBtn.addEventListener('click', () => this.exportSession());

        // Re-acquire wake lock and resume synthesis when page becomes visible again
        document.addEventListener('visibilitychange', async () => {
            if (!document.hidden) {
                // Chrome pauses speechSynthesis when tab is backgrounded — resume it
                if (this.ttsEnabled && this.speechSynthesis && this.speechSynthesis.paused) {
                    console.log('📱 Page visible — resuming paused speechSynthesis');
                    this.speechSynthesis.resume();
                }

                if (this.isRecording && 'wakeLock' in navigator) {
                    // Page became visible again while recording - re-acquire wake lock
                    console.log('📱 Page visible again - re-acquiring wake lock');
                    try {
                        await this.requestWakeLock();
                    } catch (err) {
                        console.warn('⚠️ Could not re-acquire wake lock on visibility change:', err.message);
                    }
                }
            }
        });

        // TTS rate control (dropdown)
        this.ttsRateSelect.addEventListener('change', (e) => {
            this.speechRate = parseFloat(e.target.value);
            console.log(`🔊 Speech rate set to ${this.speechRate.toFixed(1)}x`);
        });

        // Voice selection control
        this.voiceSelect.addEventListener('change', (e) => {
            const selectedValue = e.target.value;

            // Log all available voices
            const allVoices = this.speechSynthesis.getVoices();

            if (selectedValue === 'auto') {
                // Auto mode - let system choose best voice
                this.voicePreference = 'auto';
                this.selectedVoice = null;
            } else {
                // Specific voice selected - store the voice object
                const voice = allVoices.find(v => v.name === selectedValue);
                if (voice) {
                    this.voicePreference = selectedValue; // Store voice name
                    this.selectedVoice = voice; // Store voice object
                } else {
                    this.voicePreference = 'auto';
                    this.selectedVoice = null;

                    // Notify user via console about voice selection failure
                    console.warn(`⚠️ Selected voice not available. Falling back to AUTO mode.`);
                }
            }

            // Save voice preference to localStorage
            try {
                localStorage.setItem('gtranslate_voice_preference', this.voicePreference);
                console.log(`🎤 Voice selection saved: ${this.voicePreference}`);
            } catch (error) {
                console.error(`❌ Failed to save voice preference to localStorage:`, error);
            }
        });

        // Target language change - update voice dropdown
        this.targetLanguage.addEventListener('change', () => {
            // Re-populate voice dropdown for new language
            this.populateVoiceDropdown();

            // Reset voice selection to auto when language changes
            if (this.voiceSelect) {
                this.voiceSelect.value = 'auto';
                this.voicePreference = 'auto';
                this.selectedVoice = null;

                try {
                    localStorage.setItem('gtranslate_voice_preference', 'auto');
                } catch (error) {
                    console.error(`❌ Failed to update localStorage:`, error);
                }
            }
        });

        // Microphone gain control — manual slider
        this.micGainSlider.addEventListener('input', (e) => {
            const gain = parseFloat(e.target.value);
            this.micGainValue.textContent = gain.toFixed(1);

            // Disable auto-gain when user manually adjusts slider
            if (this.autoGainToggle.checked) {
                this.autoGainToggle.checked = false;
                this.micGainSlider.disabled = false;
                this.gainHint.textContent = 'Manual gain mode';
            }

            // Update both the Web Audio gain node AND the AudioWorklet gain
            if (this.gainNode) {
                this.gainNode.gain.value = gain;
            }

            // Send new gain to AudioWorklet (this also disables auto-gain in worklet)
            if (this.processor && this.processor.port) {
                this.processor.port.postMessage({ command: 'setGain', value: gain });
            }

            console.log(`🎤 Microphone gain manually set to ${gain.toFixed(1)}x`);
        });

        // Auto-gain toggle
        this.autoGainToggle.addEventListener('change', (e) => {
            const autoEnabled = e.target.checked;
            this.micGainSlider.disabled = autoEnabled;
            this.gainHint.textContent = autoEnabled
                ? 'Auto-gain enabled: level adjusts automatically'
                : 'Manual gain mode';

            if (this.processor && this.processor.port) {
                this.processor.port.postMessage({ command: 'setAutoGain', value: autoEnabled });
            }

            console.log(`🎤 Auto-gain ${autoEnabled ? 'enabled' : 'disabled'}`);
        });

        // Initialize slider state based on auto-gain default
        this.micGainSlider.disabled = this.autoGainToggle.checked;
    }

    initSocket() {
        // Configure Socket.IO with reconnection settings
        this.socket = io({
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            timeout: 10000
        });

        this.socket.on('connect', () => {
            console.log('✅ Connected to server');
            this.updateStatus('Ready to start', 'ready');
            this.startLatencyMonitoring();
        });

        // Latency monitoring with ping/pong
        this.socket.on('pong', () => {
            if (this.pingStartTime) {
                this.latency = Date.now() - this.pingStartTime;
                this.latencyHistory.push(this.latency);

                // Keep only last 10 measurements
                if (this.latencyHistory.length > 10) {
                    this.latencyHistory.shift();
                }

                const avgLatency = this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;

                console.log(`📡 Network latency: ${this.latency}ms (avg: ${avgLatency.toFixed(0)}ms)`);

                // Warn if latency is high
                if (avgLatency > 500) {
                    console.warn('⚠️ High latency detected, audio quality may be affected');
                }
            }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('❌ Disconnected from server:', reason);
            this.updateStatus('Disconnected from server', 'error');
            this.stopLatencyMonitoring();

            // Auto-stop recording if disconnected during session
            if (this.isRecording) {
                this.stopRecording();
            }
        });

        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            this.updateStatus('Cannot connect to server', 'error');
        });

        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log(`Reconnection attempt ${attemptNumber}...`);
            this.updateStatus(`Reconnecting... (${attemptNumber}/5)`, 'error');
        });

        this.socket.on('reconnect_failed', () => {
            console.error('Reconnection failed');
            this.updateStatus('Connection failed. Please refresh the page.', 'error');
            if (this.isRecording) {
                this.stopRecording();
            }
        });

        // Handle server-side connection rejection
        this.socket.on('connection-error', (data) => {
            console.error('Connection rejected:', data.message);
            this.updateStatus(data.message, 'error');
            alert(data.message); // Show alert for critical connection issues
        });

        // Handle session timeout
        this.socket.on('session-timeout', (data) => {
            console.warn('Session timeout:', data.message);
            this.updateStatus(data.message, 'error');
            alert(`Session expired: ${data.message}`);
            if (this.isRecording) {
                this.stopRecording();
            }
        });

        this.socket.on('session-started', (data) => {
            console.log('🎤 Session started', data);
            this.updateStatus('Listening...', 'listening');

            // Store source language for billing tracking
            this.currentSourceLanguage = data.sourceLanguage;
        });

        this.socket.on('interim-result', (data) => {
            if (this.currentMode === 'earbuds') {
                // Show live STT text in earbuds mode so user can confirm mic is working
                this.interimText.textContent = data.text ? `Hearing: ${data.text}...` : 'Listening...';
                return;
            }
            const hasRecentTranslation = this.lastTranslation &&
                (Date.now() - this.lastTranslationTime < 20000);

            if (hasRecentTranslation) {
                this.interimText.textContent = `${this.lastTranslation}...`;
            } else {
                this.interimText.textContent = 'Listening...';
            }
        });

        this.socket.on('translation-result', (data) => {
            console.log('📥 TRANSLATION RECEIVED!', data);

            if (data.translated) {
                this.lastTranslation = sanitizeText(data.translated);
                this.lastTranslationTime = Date.now();
            }

            this.addTranslation(data);

            // Track translation usage for billing (only on final translations to avoid double-counting)
            if (!data.isInterim && data.translated && this.currentSourceLanguage) {
                const charCount = data.translated.length;
                // Assume glossary is used if available (you could enhance this with actual glossary status)
                const useGlossary = false; // Set to true when glossary is confirmed enabled

                if (useGlossary) {
                    this.trackBilling('glossary', charCount, this.currentSourceLanguage);
                } else {
                    this.trackBilling('translation', charCount, this.currentSourceLanguage);
                }
            }
        });

        this.socket.on('session-stopped', (data) => {
            console.log('⏹️ Session stopped', data);
        });

        this.socket.on('recognition-error', (error) => {
            console.error('Recognition error:', error);
            const errorMsg = error.message || JSON.stringify(error);
            const errorCode = error.code ? String(error.code) : '';

            // Don't show errors for auto-restart events (server handles it)
            if (!errorCode || (!errorCode.includes('STREAM_ENDED') && !errorCode.includes('STREAM_CLOSED'))) {
                this.updateStatus(`⚠️ ${errorMsg}`, 'error');

                // Auto-stop only for fatal errors, not stream restarts
                if (errorCode && errorCode.includes('DESTROYED')) {
                    console.warn('Stream is dead, stopping recording');
                    if (this.isRecording) {
                        this.stopRecording();
                    }
                }
            } else {
                console.log('Stream restarting...', errorCode);
            }
        });

        this.socket.on('translation-error', (error) => {
            console.error('Translation error:', error);
        });
    }

    initModeToggle() {
        const modeOptions = document.querySelectorAll('.mode-option');

        modeOptions.forEach(option => {
            option.addEventListener('click', () => {
                // Remove active class from all options
                modeOptions.forEach(opt => opt.classList.remove('active'));

                // Add active class to clicked option
                option.classList.add('active');

                // Update current mode
                this.currentMode = option.dataset.mode;

                // Update translation interval
                const parsed = parseInt(option.dataset.interval, 10);
                this.translationInterval = isNaN(parsed) ? 8000 : parsed;

                // Handle TTS auto-enable for EarBuds mode
                const enableTTS = option.dataset.enableTts === 'true';
                this.ttsEnabled = enableTTS;

                // Show/hide TTS rate control and voice selection based on TTS state
                if (this.ttsRateContainer) {
                    this.ttsRateContainer.style.display = enableTTS ? 'flex' : 'none';
                }
                if (this.voiceSelectionContainer) {
                    this.voiceSelectionContainer.style.display = enableTTS ? 'block' : 'none';
                }

                // Stop any currently playing speech if TTS is being disabled
                if (!enableTTS && this.speechSynthesis) {
                    this.speechSynthesis.cancel();
                    this.ttsQueue = [];
                    this.isSpeaking = false;
                }

                console.log(`Mode changed: ${this.currentMode}, Interval: ${this.translationInterval}ms, TTS: ${enableTTS}`);
            });
        });
    }


    addTranslation(data) {
        // Server-side duplicate detection handles dedup (3 layers in translation-rules-engine)
        // Client-side dedup removed to avoid silently dropping legitimate translations

        // Display translations on screen (ALL modes including EarBuds)
        this.translationCount++;
        this.wordsTranslated += (data.original || '').split(/\s+/).filter(Boolean).length;

        this.translationCountEl.textContent = `${this.translationCount} translations`;
        this.wordsTranslatedEl.textContent = this.wordsTranslated;

        // Store translation for export (only final translations)
        if (!data.isInterim) {
            this.sessionTranslations.push({
                timestamp: new Date().toISOString(),
                original: data.original,
                translated: data.translated
            });

            // Prevent memory exhaustion with auto-export
            if (this.sessionTranslations.length > this.MAX_SESSION_TRANSLATIONS) {
                console.warn(`⚠️ Session translation limit reached (${this.MAX_SESSION_TRANSLATIONS}), auto-exporting oldest 500...`);

                // Export oldest 500 to file
                const oldTranslations = this.sessionTranslations.splice(0, 500);
                this.exportPartialSession(oldTranslations);
            }

            // Enable export button once we have translations
            this.exportBtn.disabled = false;

            // Speak final translations only (EarBuds auto-enables TTS)
            this.lastEarbudsInterimSpoken = '';
            this.speakTranslation(data.translated, this.targetLanguage.value);
        }

        // If this is a final translation (not interim), clear all previous interim translations
        if (!data.isInterim) {
            this.clearInterimTranslations();
        }

        // EarBuds mode: Audio-first, skip visual translation cards (only show STT interim text)
        if (this.currentMode === 'earbuds') {
            return; // Skip visual display in EarBuds mode
        }

        // Use template literals for faster HTML construction
        const item = document.createElement('div');
        item.className = data.isInterim ? 'translation-item interim' : 'translation-item';

        item.innerHTML = `
            <div class="original">📝 ${escapeHtml(sanitizeText(data.original))}</div>
            <div class="translated">💬 ${escapeHtml(sanitizeText(data.translated))}</div>
        `;

        // Track interim elements for fast removal
        if (data.isInterim) {
            this.interimElements.add(item);
        }

        // Use fragment to batch DOM operations
        const fragment = document.createDocumentFragment();
        fragment.appendChild(item);
        this.resultsContainer.insertBefore(fragment, this.resultsContainer.firstChild);

        // Limit DOM size to prevent performance degradation
        const maxItems = 50;
        while (this.resultsContainer.children.length > maxItems) {
            const lastChild = this.resultsContainer.lastChild;
            // Remove from interim tracking if applicable
            this.interimElements.delete(lastChild);
            this.resultsContainer.removeChild(lastChild);
        }
    }

    clearInterimTranslations() {
        // O(n) removal without DOM queries
        this.interimElements.forEach(element => {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        this.interimElements.clear();
    }

    startSessionTimer() {
        this.sessionStartTime = Date.now();
        this.sessionTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            this.sessionTimeEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    stopSessionTimer() {
        if (this.sessionTimer) {
            clearInterval(this.sessionTimer);
            this.sessionTimer = null;
        }
    }

    updateStatus(message, type) {
        this.statusDiv.textContent = message;
        this.statusDiv.className = `status ${type}`;
    }
}
