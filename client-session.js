// BudgetTranslate session methods — latency, billing, export
// Requires: client.js loaded before this script

Object.assign(GTranslateV4Client.prototype, {
    startLatencyMonitoring() {
        this.stopLatencyMonitoring(); // Guard against duplicate intervals on reconnect
        // Ping server every 5 seconds to measure latency
        this.latencyMonitorInterval = setInterval(() => {
            this.pingStartTime = Date.now();
            this.socket.emit('ping');
        }, 5000);
    },

    stopLatencyMonitoring() {
        if (this.latencyMonitorInterval) {
            clearInterval(this.latencyMonitorInterval);
            this.latencyMonitorInterval = null;
        }
    },

    async trackBilling(type, amount, language) {
        // Send billing data to API for persistent storage in database
        try {
            const response = await fetch('/api/billing/track', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ type, amount, language })
            });

            if (response.ok) {
                console.log(`💰 Billing tracked: ${type} = ${Number(amount).toFixed(2)} for ${language || 'unknown'}`);
            } else {
                console.warn('Failed to track billing:', await response.text());
            }
        } catch (e) {
            console.warn('Failed to track billing:', e);
        }

        // Also update localStorage as a backup/cache (for offline viewing)
        try {
            const billingData = JSON.parse(localStorage.getItem('gtranslate_billing_session') || '{}');

            // Initialize if needed
            if (!billingData.languages) {
                billingData.languages = {};
                billingData.sttMinutes = 0;
                billingData.translationChars = 0;
                billingData.glossaryChars = 0;
                billingData.startTime = Date.now();
            }

            // Update totals
            switch(type) {
                case 'stt':
                    billingData.sttMinutes = (billingData.sttMinutes || 0) + amount;
                    break;
                case 'translation':
                    billingData.translationChars = (billingData.translationChars || 0) + amount;
                    break;
                case 'glossary':
                    billingData.glossaryChars = (billingData.glossaryChars || 0) + amount;
                    break;
            }

            // Update per-language
            if (language) {
                if (!billingData.languages[language]) {
                    billingData.languages[language] = {
                        sttMinutes: 0,
                        translationChars: 0,
                        glossaryChars: 0
                    };
                }

                switch(type) {
                    case 'stt':
                        billingData.languages[language].sttMinutes += amount;
                        break;
                    case 'translation':
                        billingData.languages[language].translationChars += amount;
                        break;
                    case 'glossary':
                        billingData.languages[language].glossaryChars += amount;
                        break;
                }
            }

            localStorage.setItem('gtranslate_billing_session', JSON.stringify(billingData));
        } catch (e) {
            console.warn('Failed to update localStorage billing:', e);
        }
    },

    exportSession() {
        if (this.sessionTranslations.length === 0) {
            alert('No translations to export');
            return;
        }

        // Create export data
        const exportData = {
            sessionDate: new Date().toISOString(),
            translationCount: this.sessionTranslations.length,
            wordsTranslated: this.wordsTranslated,
            translations: this.sessionTranslations
        };

        // Generate filename
        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const filename = `gtranslate-session-${dateStr}.json`;

        // Create blob and download
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // Cleanup with delay to ensure download starts
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        console.log(`✅ Session exported: ${filename} (${this.sessionTranslations.length} translations)`);
    },

    exportPartialSession(translations) {
        const exportData = {
            sessionDate: new Date().toISOString(),
            translationCount: translations.length,
            isPartialExport: true,
            note: 'Auto-exported due to reaching session limit',
            translations: translations
        };

        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const filename = `gtranslate-partial-${dateStr}.json`;

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        console.log(`📦 Partial session auto-exported: ${filename} (${translations.length} translations)`);
    }

});
