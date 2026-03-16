// BudgetTranslate TTS methods — speech synthesis, voice cache, queue
// Requires: client.js loaded before this script

Object.assign(GTranslateV4Client.prototype, {
    speakTranslation(text, targetLanguage, options = {}) {
        const { recordHistory = true } = options;
        if (!this.ttsEnabled || !this.speechSynthesis) {
            return;
        }

        // Normalize text for comparison (trim whitespace, lowercase)
        const normalizedText = text.trim().toLowerCase();

        // Skip empty text
        if (normalizedText.length === 0) {
            return;
        }

        // Clean up old entries periodically (not on every call for performance)
        const now = Date.now();
        const safeInterval = (typeof this.translationInterval === 'number' && this.translationInterval > 0)
            ? this.translationInterval
            : 10000;
        const DEDUP_WINDOW_MS = Math.max(safeInterval * 2, 12000);

        if (!this.lastDedupCleanup || now - this.lastDedupCleanup > 5000 || this.recentlySpoken.length > 50) {
            this.recentlySpoken = this.recentlySpoken.filter(entry =>
                now - entry.timestamp < DEDUP_WINDOW_MS
            );
            this.lastDedupCleanup = now;
        }

        // Check for duplicates in recently spoken
        const isDuplicate = this.recentlySpoken.some(entry => {
            // Exact match
            if (entry.text === normalizedText) {
                console.log(`⏭️ [DEDUP] Exact match - skipping`);
                return true;
            }

            // Only apply substring checks if both texts are substantial (>= 10 chars)
            const bothSubstantial = entry.text.length >= 10 && normalizedText.length >= 10;

            if (bothSubstantial) {
                // New text is subset of old (old contains new)
                if (entry.text.includes(normalizedText)) {
                    console.log(`⏭️ [DEDUP] New is substring of old - skipping`);
                    return true;
                }

                // Old text is subset of new (new contains old)
                if (normalizedText.includes(entry.text)) {
                    const overlap = entry.text.length / normalizedText.length;
                    const additionalChars = normalizedText.length - entry.text.length;

                    // Block if >80% overlap AND less than 10 new characters
                    if (overlap > 0.80 && additionalChars < 10) {
                        console.log(`⏭️ [DEDUP] Too similar - ${(overlap*100).toFixed(0)}% overlap, +${additionalChars} chars`);
                        return true;
                    }
                }
            }

            return false;
        });

        if (isDuplicate) {
            return;
        }

        // Skip if already in queue
        const alreadyInQueue = this.ttsQueue.some(item =>
            item.text.trim().toLowerCase() === normalizedText
        );
        if (alreadyInQueue) {
            console.log(`⏭️ [DEDUP] Already in queue - skipping`);
            return;
        }

        // Add to queue
        this.ttsQueue.push({ text, targetLanguage });

        // Add to recentlySpoken IMMEDIATELY to prevent race conditions
        if (recordHistory) {
            this.recentlySpoken.push({
                text: normalizedText,
                timestamp: Date.now()
            });
        }

        console.log(`📝 Added to TTS queue (${this.ttsQueue.length} pending): "${text.substring(0, 50)}..."`);

        // Start processing queue if not already speaking
        if (!this.isSpeaking) {
            this.processNextInQueue();
        } else {
            // Watchdog: Chrome synthesis can silently crash leaving isSpeaking stuck true.
            // If we've been "speaking" for >25s with no onend event, reset and restart.
            const stuckMs = this._speakStartTime ? Date.now() - this._speakStartTime : 0;
            if (stuckMs > 25000) {
                console.warn(`⚠️ [TTS] isSpeaking stuck for ${Math.round(stuckMs / 1000)}s — Chrome synthesis may have crashed, resetting`);
                this.isSpeaking = false;
                this._speakStartTime = 0;
                this.speechSynthesis.cancel();
                this.processNextInQueue();
            }
        }
    },

    buildVoiceCache() {
        this.voiceCache.clear();
        const voices = this.speechSynthesis.getVoices();

        // Group voices by language code for instant O(1) lookup
        voices.forEach(voice => {
            const baseLang = voice.lang.split('-')[0];

            if (!this.voiceCache.has(voice.lang)) {
                this.voiceCache.set(voice.lang, []);
            }
            if (!this.voiceCache.has(baseLang)) {
                this.voiceCache.set(baseLang, []);
            }

            this.voiceCache.get(voice.lang).push(voice);
            this.voiceCache.get(baseLang).push(voice);
        });

        console.log(`✅ Voice cache built: ${this.voiceCache.size} language variants, ${voices.length} total voices`);

        // Log high-quality voices for debugging
        const highQualityVoices = voices.filter(v =>
            v.name.includes('Neural') || v.name.includes('Wavenet') || v.name.includes('Studio') ||
            v.name.includes('Premium') || v.name.includes('Enhanced') || v.name.includes('Natural') ||
            (v.name.includes('Microsoft') && v.name.includes('Online')) ||
            (v.name.includes('Google') && !v.localService)
        );
        if (highQualityVoices.length > 0) {
            console.log(`🎙️ High-quality voices available:`, highQualityVoices.map(v => `${v.name} [${v.lang}]`));
        } else {
            console.log(`⚠️ No high-quality voices detected. Available voices:`, voices.slice(0, 10).map(v => `${v.name} [${v.lang}]`));
        }

        // Update voice dropdown with available voices
        this.populateVoiceDropdown();
    },

    populateVoiceDropdown() {
        if (!this.voiceSelect) return;

        const voices = this.speechSynthesis.getVoices();

        // Log ALL available voices for debugging
        console.log(`🎤 ALL VOICES (${voices.length} total):`, voices.map(v => `${v.name} [${v.lang}] ${v.localService ? 'Local' : 'Cloud'}`));

        // Get current target language if available
        const targetLang = this.targetLanguage?.value || 'en';

        // Filter voices for current language
        const relevantVoices = voices.filter(v =>
            v.lang.startsWith(targetLang) || v.lang.split('-')[0] === targetLang
        );

        console.log(`🎤 Found ${relevantVoices.length} voices for language: ${targetLang}`);
        console.log(`🎤 Filtered voices:`, relevantVoices.map(v => `${v.name} [${v.lang}]`));

        // Clear existing options except "Auto"
        this.voiceSelect.innerHTML = '<option value="auto">Auto (Best Quality)</option>';

        // Add ALL relevant voices (not just top 4) so user can see everything
        relevantVoices.forEach((voice) => {
            const option = document.createElement('option');
            option.value = voice.name;
            option.textContent = `${voice.name} ${voice.localService ? '(Local)' : '(Cloud)'}`;
            this.voiceSelect.appendChild(option);
        });

        console.log(`🎤 Populated dropdown with ${relevantVoices.length} voices`);

        // Restore saved voice preference if applicable
        if (this.voicePreference && this.voicePreference !== 'auto') {
            // Try to find the saved voice in the current language's voices
            const savedVoice = voices.find(v => v.name === this.voicePreference);
            if (savedVoice) {
                // Check if voice is in the dropdown (matches current language)
                const isInDropdown = relevantVoices.some(v => v.name === this.voicePreference);
                if (isInDropdown) {
                    this.voiceSelect.value = this.voicePreference;
                    this.selectedVoice = savedVoice;
                    console.log(`🎤 Restored saved voice: ${savedVoice.name} [${savedVoice.lang}]`);
                } else {
                    // Saved voice doesn't match current language - reset to auto
                    console.log(`🎤 Saved voice "${this.voicePreference}" not available for ${targetLang}, resetting to auto`);
                    this.voiceSelect.value = 'auto';
                    this.voicePreference = 'auto';
                    this.selectedVoice = null;
                }
            }
        } else {
            // Ensure dropdown shows "auto"
            this.voiceSelect.value = 'auto';
        }
    },

    processNextInQueue() {
        // Check if queue is empty
        if (this.ttsQueue.length === 0) {
            this.isSpeaking = false;
            return;
        }

        // CRITICAL: Ensure voices are loaded before processing TTS
        let allVoices = this.speechSynthesis.getVoices();

        if (allVoices.length === 0) {
            console.warn('⚠️ Voices not loaded yet, retrying in 100ms...');
            // Don't dequeue yet - will retry
            this.isSpeaking = false;

            // Retry after short delay
            setTimeout(() => {
                if (this.ttsQueue.length > 0 && !this.isSpeaking) {
                    this.processNextInQueue();
                }
            }, 100);
            return;
        }

        // Rebuild voice cache if empty (race condition protection)
        if (this.voiceCache.size === 0) {
            console.warn('⚠️ Voice cache empty, rebuilding...');
            this.buildVoiceCache();
        }

        // Get next item from queue
        const { text, targetLanguage } = this.ttsQueue.shift();
        this.isSpeaking = true;
        this._speakStartTime = Date.now(); // Watchdog timestamp

        // Note: Already added to recentlySpoken in speakTranslation() to prevent race conditions
        // Don't add again here or we'll have duplicates in the tracking array

        // Create utterance
        const utterance = new SpeechSynthesisUtterance(text);
        this.currentUtterance = utterance;

        // Map target language codes to speech synthesis language codes
        const langMap = {
            'en': 'en-US',
            'en-US': 'en-US',
            'es': 'es-ES',
            'fr': 'fr-FR',
            'de': 'de-DE',
            'it': 'it-IT',
            'pt': 'pt-PT',
            'ru': 'ru-RU',
            'ja': 'ja-JP',
            'ko': 'ko-KR',
            'zh': 'zh-CN',
            'ar': 'ar-SA',
            'hi': 'hi-IN',
            'ro': 'ro-RO'
        };

        // Set language for voice
        const speechLang = langMap[targetLanguage] || targetLanguage || 'en-US';
        utterance.lang = speechLang;

        // O(1) lookup from voice cache instead of O(n) search
        const langVoices = this.voiceCache.get(speechLang) ||
                           this.voiceCache.get(speechLang.split('-')[0]) ||
                           [];

        // Find best voice based on user preference
        let preferredVoice;

        if (this.voicePreference && this.voicePreference !== 'auto') {
            // User selected a specific voice — look up fresh each time since voice objects
            // go stale after Web Speech API restarts (Chrome invalidates the old references)
            preferredVoice = allVoices.find(v => v.name === this.voicePreference) || null;
            if (preferredVoice) {
                this.selectedVoice = preferredVoice; // keep in sync
                console.log(`🔊 Using user-selected voice: ${preferredVoice.name} [${preferredVoice.lang}]`);
            } else {
                console.warn(`⚠️ Saved voice "${this.voicePreference}" not found — falling back to auto`);
            }
        } else if (this.voicePreference === 'auto') {
            // Auto mode - prioritize most natural sounding
            preferredVoice =
                // Priority 1: Google Cloud voices (most natural - Neural/Wavenet/Studio)
                langVoices.find(voice =>
                    voice.name.includes('Google') &&
                    (voice.name.includes('Neural') || voice.name.includes('Studio') || voice.name.includes('Wavenet') || voice.name.includes('Natural'))
                ) ||
                // Priority 2: Microsoft high-quality voices (Edge/Azure)
                langVoices.find(voice =>
                    (voice.name.includes('Microsoft') || voice.name.includes('Edge')) &&
                    (voice.name.includes('Neural') || voice.name.includes('Online'))
                ) ||
                // Priority 3: Apple premium voices (macOS/iOS)
                langVoices.find(voice =>
                    (voice.name.includes('Premium') || voice.name.includes('Enhanced')) ||
                    (voice.name.includes('Samantha') || voice.name.includes('Alex') ||
                     voice.name.includes('Karen') || voice.name.includes('Tessa') ||
                     voice.name.includes('Flo') || voice.name.includes('Grandma') ||
                     voice.name.includes('Eddy') || voice.name.includes('Reed'))
                ) ||
                // Priority 4: Any remote/cloud voice (usually better quality)
                langVoices.find(voice => voice.localService === false) ||
                // Priority 5: English-specific high quality voices
                langVoices.find(voice =>
                    voice.name.includes('Daniel') || voice.name.includes('Moira') ||
                    voice.name.includes('Amelie') || voice.name.includes('Anna')
                ) ||
                // Priority 6: First available local voice
                langVoices[0];
        } else {
            // Fallback: try to find voice by name (for legacy saved preferences)
            const savedVoices = this.speechSynthesis.getVoices();
            preferredVoice = savedVoices.find(v => v.name === this.voicePreference);

            // Fallback to auto selection if exact match not found
            if (!preferredVoice) {
                console.warn(`⚠️ Saved voice "${this.voicePreference}" not found, using auto selection`);
                preferredVoice = langVoices[0];
            }
        }

        // Final fallback if no voice found for target language
        if (!preferredVoice && langVoices.length > 0) {
            preferredVoice = langVoices[0];
            console.warn(`⚠️ Using fallback voice for ${speechLang}: ${preferredVoice.name}`);
        }

        // CRITICAL: If still no voice, use ANY available voice (prevents silent failure on mobile)
        if (!preferredVoice && allVoices.length > 0) {
            preferredVoice = allVoices[0];
            console.error(`❌ No matching voice found, using first available: ${preferredVoice.name}`);
        }

        // Fail gracefully if absolutely no voices available
        if (!preferredVoice) {
            console.error('❌ CRITICAL: No voices available at all! Cannot play TTS.');
            this.processNextInQueue(); // Skip this item and continue
            return;
        }

        utterance.voice = preferredVoice;
        console.log(`🔊 Using voice: ${preferredVoice.name} (${preferredVoice.lang}) - Local: ${preferredVoice.localService}`);

        // Speech settings - optimize based on voice quality
        // High-quality voices sound better at normal pitch, low-quality need lower pitch
        const isHighQuality = preferredVoice && (
            preferredVoice.name.includes('Neural') ||
            preferredVoice.name.includes('Wavenet') ||
            preferredVoice.name.includes('Studio') ||
            preferredVoice.name.includes('Premium') ||
            preferredVoice.name.includes('Enhanced') ||
            !preferredVoice.localService
        );

        utterance.rate = this.speechRate;
        utterance.pitch = isHighQuality ? 1.0 : 0.92; // Natural pitch for HQ voices, lower for robotic ones
        utterance.volume = 1.0;

        console.log(`🔊 TTS Settings: rate=${utterance.rate}, pitch=${utterance.pitch}, volume=${utterance.volume}, highQuality=${isHighQuality}`);

        // Event handlers
        utterance.onstart = () => {
            console.log(`🔊 Speaking (${this.ttsQueue.length} in queue): "${text.substring(0, 50)}..."`);
            console.log(`🔊 Actual utterance rate: ${utterance.rate}, pitch: ${utterance.pitch}`);
        };

        utterance.onend = () => {
            console.log(`✅ Finished speaking`);
            // Process next item in queue
            this.processNextInQueue();
        };

        utterance.onerror = (event) => {
            // 'interrupted' and 'canceled' fire when speechSynthesis.cancel() is called deliberately
            // (e.g. stop button, tab switch). These are not real errors — skip silently.
            if (event.error === 'interrupted' || event.error === 'canceled') {
                this.isSpeaking = false;
                return;
            }
            console.error('🔊 Speech synthesis error:', event.error);
            // Continue to next item even on error
            this.isSpeaking = false;
            this.processNextInQueue();
        };

        // Chrome bug: synthesis can get stuck in paused state when tab is backgrounded
        if (this.speechSynthesis.paused) {
            this.speechSynthesis.resume();
        }

        // Speak
        this.speechSynthesis.speak(utterance);
    },

    async startAudioLevelMonitor() {
        try {
            this.levelStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            this.audioContext = new AudioContext();
            const source = this.audioContext.createMediaStreamSource(this.levelStream);
            this.analyserNode = this.audioContext.createAnalyser();
            this.analyserNode.fftSize = 256;
            source.connect(this.analyserNode);
            const levelData = new Uint8Array(this.analyserNode.frequencyBinCount);
            const tick = () => {
                if (!this.isRecording) return;
                this.analyserNode.getByteTimeDomainData(levelData);
                let sumSq = 0;
                for (let i = 0; i < levelData.length; i++) {
                    const v = (levelData[i] - 128) / 128;
                    sumSq += v * v;
                }
                const rms = Math.sqrt(sumSq / levelData.length);
                this.updateAudioLevel(Math.min(rms * 5, 1.0));
                this.levelAnimFrame = requestAnimationFrame(tick);
            };
            this.levelAnimFrame = requestAnimationFrame(tick);
        } catch (e) {
            console.warn('Audio level monitor unavailable:', e);
        }
    },

    stopAudioLevelMonitor() {
        if (this.levelAnimFrame) {
            cancelAnimationFrame(this.levelAnimFrame);
            this.levelAnimFrame = null;
        }
        if (this.analyserNode) {
            this.analyserNode.disconnect();
            this.analyserNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this.levelStream) {
            this.levelStream.getTracks().forEach(t => t.stop());
            this.levelStream = null;
        }
        this.updateAudioLevel(0);
    }

});
