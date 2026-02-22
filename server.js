/**
 * GTranslate V4 Server
 * Real-time speech translation using Google Cloud Speech-to-Text API
 * Stream proactively restarts at 290s (Google Cloud limit is ~305s)
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const speech = require('@google-cloud/speech');
const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const billingDb = require('./billing-db');
const TranslationRulesEngine = require('./translation-rules-engine');

// ===== CONFIGURATION =====
// Load environment variables if .env file exists
try {
    require('dotenv').config();
} catch (e) {
    // dotenv not installed, use defaults
}

const PORT = process.env.PORT || 3003;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '50');
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || '5');
const INACTIVITY_TIMEOUT = parseInt(process.env.INACTIVITY_TIMEOUT || String(30 * 60 * 1000));
const MAX_AUDIO_CHUNK_SIZE = 1024 * 1024; // 1MB per chunk
const STREAM_DURATION_LIMIT_MS = 290000; // Proactive restart at 290s (Google limit is ~305s)

// ===== LOGGING SETUP =====
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = path.join(LOG_DIR, 'gtranslate-v4.log');

// Initialize logger FIRST before using it
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug'),
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
            return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: LOG_FILE })
    ]
});

// ===== GOOGLE CLOUD CREDENTIALS SETUP =====
// Support both file-based (local/Docker) and environment variable (Heroku) credentials
let googleCredentials;
let CREDENTIALS_PATH;
let credentialsProjectId = null;

if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // Heroku/Cloud deployment: credentials from environment variable
    try {
        googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        credentialsProjectId = googleCredentials.project_id || null;
        logger.info('✅ Using Google credentials from environment variable');
    } catch (error) {
        logger.error('❌ Failed to parse GOOGLE_CREDENTIALS_JSON environment variable');
        logger.error('Error:', error.message);
        process.exit(1);
    }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Docker/VM deployment: credentials from file path
    const credPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const appDir = path.resolve(__dirname);

    // Resolve symlinks to get real path and prevent traversal attacks
    let realCredPath;
    try {
        realCredPath = fs.realpathSync(credPath);
    } catch (error) {
        logger.error('❌ Credentials file does not exist or is not accessible', {
            providedPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            resolvedPath: credPath,
            error: error.message
        });
        process.exit(1);
    }

    // Only allow credentials files within the application directory or standard system paths
    const allowedDirs = [appDir, '/usr/', '/etc/'];
    const isAllowed = allowedDirs.some(dir => realCredPath.startsWith(path.resolve(dir)));
    if (isAllowed) {
        // Ensure it's actually a file, not a directory
        const stats = fs.statSync(realCredPath);
        if (!stats.isFile()) {
            logger.error('❌ Credentials path is not a file', { realCredPath });
            process.exit(1);
        }
        CREDENTIALS_PATH = realCredPath;
    } else {
        logger.error('❌ Credentials path outside allowed directories', { credPath, realCredPath });
        process.exit(1);
    }
    try {
        const rawCreds = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const parsedCreds = JSON.parse(rawCreds);
        credentialsProjectId = parsedCreds.project_id || null;
    } catch (error) {
        logger.warn('⚠️ Unable to read project_id from credentials file', { error: error.message });
    }
} else {
    // Local development: credentials from default file
    CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');
    if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
            const rawCreds = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
            const parsedCreds = JSON.parse(rawCreds);
            credentialsProjectId = parsedCreds.project_id || null;
        } catch (error) {
            logger.warn('⚠️ Unable to read project_id from default credentials', { error: error.message });
        }
    }
}

// ===== CHECK CREDENTIALS =====
if (googleCredentials) {
    // Using credentials from environment variable (Heroku)
    // Google Cloud clients will be initialized with explicit credentials
} else if (CREDENTIALS_PATH && fs.existsSync(CREDENTIALS_PATH)) {
    // Using credentials from file (local/Docker)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = CREDENTIALS_PATH;
} else {
    logger.error('❌ Credentials not found!');
    logger.error('Please provide credentials via:');
    logger.error('  1. GOOGLE_CREDENTIALS_JSON environment variable (Heroku/Cloud)');
    logger.error('  2. GOOGLE_APPLICATION_CREDENTIALS path (Docker/VM)');
    logger.error('  3. google-credentials.json file (Local development)');
    process.exit(1);
}

// ===== INITIALIZE GOOGLE CLOUD CLIENTS =====
const speechClient = googleCredentials
    ? new speech.SpeechClient({ credentials: googleCredentials })
    : new speech.SpeechClient();

const translateClient = googleCredentials
    ? new TranslationServiceClient({ credentials: googleCredentials })
    : new TranslationServiceClient();

// Get project ID and location for v3 API
const projectId = googleCredentials?.project_id || credentialsProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const parent = projectId ? `projects/${projectId}/locations/${location}` : null;
const glossaryId = 'ro-en-religious-terms';
const glossaryPath = parent ? `${parent}/glossaries/${glossaryId}` : null;
const glossaryEnabled = process.env.GLOSSARY_ENABLED === 'true'; // opt-in only: set GLOSSARY_ENABLED=true to enable
const translationModel = process.env.TRANSLATION_MODEL || 'advanced';

if (!projectId) {
    logger.error('❌ No Google Cloud project ID found - translations will fail');
    logger.error('Set project ID via:');
    logger.error('  1. GOOGLE_CLOUD_PROJECT environment variable');
    logger.error('  2. GCP_PROJECT environment variable');
    logger.error('  3. project_id in credentials JSON');
    process.exit(1);
}

logger.info('✅ Google Cloud Speech-to-Text client initialized');
logger.info('✅ Google Cloud Translation v3 client initialized', {
    projectId,
    location,
    translationModel,
    glossaryEnabled,
    glossaryPath: glossaryEnabled ? glossaryPath : 'disabled'
});

// Log startup configuration
logger.info('Server Configuration', {
    nodeEnv: NODE_ENV,
    port: PORT,
    maxConnections: MAX_CONNECTIONS,
    maxConnectionsPerIP: MAX_CONNECTIONS_PER_IP,
    inactivityTimeoutMs: INACTIVITY_TIMEOUT
});

// ===== EXPRESS SETUP =====
const app = express();
const server = http.createServer(app);

// Security headers middleware
app.use((req, res, next) => {
    // Content Security Policy
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' ws: wss:; " +
        "img-src 'self' data:; " +
        "font-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'; " +
        "frame-ancestors 'none'; " +
        "upgrade-insecure-requests"
    );

    // Other security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'microphone=*, camera=(), geolocation=(), payment=()');

    next();
});

// Strengthen CORS configuration
const io = socketIo(server, {
    cors: {
        origin: (origin, callback) => {
            // Allow same-origin requests (no origin header)
            if (!origin) return callback(null, true);

            // Whitelist of allowed origins
            const allowedOrigins = [
                'http://localhost:3003',
                'http://127.0.0.1:3003',
            ];

            // Allow any Koyeb app URL
            if (origin && origin.endsWith('.koyeb.app')) {
                return callback(null, true);
            }

            // Also allow app URL from environment (any platform)
            if (process.env.APP_URL) {
                allowedOrigins.push(process.env.APP_URL);
            }

            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                logger.warn('CORS blocked origin', { origin });
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type"]
    },
    // Additional Socket.IO security
    maxHttpBufferSize: 1e6, // 1MB max
    pingTimeout: 60000,
    pingInterval: 25000
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/billing', (req, res) => {
    res.sendFile(path.join(__dirname, 'billing.html'));
});

app.get('/audio-processor.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'audio-processor.js'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        connections: activeConnections,
        env: NODE_ENV
    });
});

// ===== BILLING API ENDPOINTS =====

// Track usage (called from client)
app.post('/api/billing/track', express.json(), async (req, res) => {
    try {
        const { type, amount, language } = req.body;

        // Validate input
        if (!type || !amount || !language) {
            return res.status(400).json({ error: 'Missing required fields: type, amount, language' });
        }

        if (!['stt', 'translation', 'glossary'].includes(type)) {
            return res.status(400).json({ error: 'Invalid type. Must be: stt, translation, or glossary' });
        }

        if (typeof amount !== 'number' || amount < 0) {
            return res.status(400).json({ error: 'Amount must be a positive number' });
        }

        // Cap per-request amount to prevent data inflation from malformed/malicious clients
        const MAX_BILLING_AMOUNT = 50000;
        if (amount > MAX_BILLING_AMOUNT) {
            return res.status(400).json({ error: `Amount exceeds maximum allowed value (${MAX_BILLING_AMOUNT})` });
        }

        // Track usage in database
        const success = await billingDb.trackUsage(type, amount, language);

        if (success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to track usage' });
        }
    } catch (error) {
        logger.error('Error tracking billing usage:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get usage summary
app.get('/api/billing/summary', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        // Default to current month if no dates provided
        const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const end = endDate ? new Date(endDate) : new Date();

        const summary = await billingDb.getUsageSummary(start, end);

        res.json({
            success: true,
            startDate: start.toISOString().split('T')[0],
            endDate: end.toISOString().split('T')[0],
            data: summary
        });
    } catch (error) {
        logger.error('Error getting billing summary:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get daily usage for charts
app.get('/api/billing/daily', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30');

        if (days < 1 || days > 365) {
            return res.status(400).json({ error: 'Days must be between 1 and 365' });
        }

        const dailyUsage = await billingDb.getDailyUsage(days);

        res.json({
            success: true,
            days,
            data: dailyUsage
        });
    } catch (error) {
        logger.error('Error getting daily usage:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== HELPER FUNCTIONS =====

/**
 * Translation with exponential backoff retry logic
 * Uses Translation API v3 with glossary support for improved accuracy
 * Handles transient failures (503, 429, network errors) and glossary fallback
 */
async function translateWithRetry(text, targetLang, sourceLanguage, clientId, maxRetries = 3) {
    if (!parent) {
        logger.error('Translation failed - no project ID configured', { clientId });
        throw new Error('Translation service not properly configured');
    }

    // Validate source language
    if (!sourceLanguage || typeof sourceLanguage !== 'string') {
        logger.error('Invalid source language parameter', { clientId, sourceLanguage });
        throw new Error('Source language is required for translation');
    }

    let useGlossary = glossaryEnabled && glossaryPath;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Extract language code (e.g., 'ro' from 'ro-RO')
            const sourceLangCode = sourceLanguage.includes('-')
                ? sourceLanguage.split('-')[0]
                : sourceLanguage;

            // Build translation request
            const request = {
                parent: parent,
                contents: [text],
                mimeType: 'text/plain',
                sourceLanguageCode: sourceLangCode,
                targetLanguageCode: targetLang,
            };

            // Add model parameter only if using 'nmt' (standard neural translation)
            // Don't specify model to use Google's latest/best automatic model selection
            if (translationModel === 'nmt') {
                request.model = `${parent}/models/nmt`;
            }
            // For 'advanced', omit model parameter to use Google's best available model

            // Add glossary if enabled and available (for domain-specific terms like religious terminology)
            if (useGlossary) {
                request.glossaryConfig = {
                    glossary: glossaryPath,
                    ignoreCase: true  // Case-insensitive for Romanian religious terms (Dumnezeu vs dumnezeu)
                };
                logger.debug('Using glossary for translation', { glossaryPath, clientId });
            }

            const [response] = await translateClient.translateText(request);
            const translation = response.translations[0].translatedText;

            return translation;
        } catch (error) {
            const errorCode = error.code ? String(error.code) : '';
            const errorMessage = error.message || '';

            // Check if this is a glossary-related error
            const isGlossaryError = errorMessage.includes('glossary') ||
                                   errorMessage.includes('NOT_FOUND') ||
                                   errorCode === '5'; // NOT_FOUND code

            // If glossary error on first attempt with glossary, retry without glossary
            if (isGlossaryError && useGlossary) {
                logger.warn('Glossary not found or error, retrying without glossary', {
                    clientId,
                    glossaryPath,
                    error: errorMessage
                });
                useGlossary = false;
                // Don't count this as a retry attempt - try again immediately
                attempt--;
                continue;
            }

            // Check if error is retryable (transient network/service issues)
            const isRetryable = errorCode === '503' ||
                               errorCode === '429' ||
                               errorCode === '14' ||  // UNAVAILABLE
                               errorCode === '8' ||   // RESOURCE_EXHAUSTED
                               error.code === 503 ||
                               error.code === 429 ||
                               error.code === 14 ||
                               error.code === 8 ||
                               error.code === 'ECONNRESET' ||
                               error.code === 'ETIMEDOUT' ||
                               error.code === 'UNAVAILABLE' ||
                               error.code === 'RESOURCE_EXHAUSTED';

            if (!isRetryable || attempt === maxRetries) {
                logger.error('Translation failed (non-retryable or max retries)', {
                    clientId,
                    attempt,
                    error: errorMessage,
                    code: error.code,
                    sourceLanguage,
                    targetLang,
                    usedGlossary: useGlossary
                });
                throw error;
            }

            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            logger.warn(`Translation retry ${attempt}/${maxRetries}`, {
                clientId,
                error: errorMessage,
                code: error.code,
                delayMs: delay
            });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// ===== SOCKET.IO CONNECTION HANDLING =====
let activeConnections = 0;
const connectionsByIp = new Map(); // Track connections per IP

io.on('connection', (socket) => {
    // Get client IP address
    const clientIp = socket.handshake.address || socket.conn.remoteAddress;

    // Check global connection limit
    if (activeConnections >= MAX_CONNECTIONS) {
        logger.warn('Connection rejected - max connections reached', {
            activeConnections,
            maxConnections: MAX_CONNECTIONS,
            clientIp
        });
        socket.emit('connection-error', {
            message: 'Server is at maximum capacity. Please try again later.'
        });
        socket.disconnect(true);
        return;
    }

    // Check per-IP connection limit
    const ipConnections = connectionsByIp.get(clientIp) || 0;
    if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
        logger.warn('Connection rejected - max connections per IP reached', {
            clientIp,
            connections: ipConnections,
            maxPerIp: MAX_CONNECTIONS_PER_IP
        });
        socket.emit('connection-error', {
            message: 'Too many connections from your IP address. Please try again later.'
        });
        socket.disconnect(true);
        return;
    }

    activeConnections++;
    connectionsByIp.set(clientIp, ipConnections + 1);

    const clientId = socket.id.substring(0, 8);

    logger.info('✅ Client connected', {
        socketId: socket.id,
        clientIp,
        totalConnections: activeConnections,
        ipConnections: ipConnections + 1
    });

    let recognizeStream = null;
    let currentLanguage = 'ro-RO';
    let targetLanguage = 'en';
    let accumulatedText = '';
    let translationCount = 0;
    let sessionActive = false;
    let restartStreamTimer = null;
    let lastInterimText = '';
    let lastTranslationTime = null; // Track when last translation happened for 15s max interval
    let lastTranslatedText = ''; // Track concatenated source text already translated
    let translationInterval = 6000; // Store translation interval for restarts
    let lastActivityTime = Date.now();
    let inactivityTimer = null;
    const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT; // Use config value
    let isRestarting = false; // Prevent race conditions during auto-restart
    let translationInFlight = false; // Prevent concurrent translations (race condition fix)
    let restartTimeout = null; // Track the scheduled restart timeout
    let restartAttempts = 0; // Track restart attempts
    const MAX_RESTART_ATTEMPTS = 10; // Maximum auto-restart attempts
    let audioBufferDuringRestart = []; // Buffer audio during stream restarts
    let audioBufferWarned = false; // Flag to log buffer-full warning only once
    let streamDurationTimer = null; // Proactive restart timer (290s)
    const MAX_AUDIO_BUFFER_SIZE = 50; // Max chunks to buffer (prevent memory issues)
    let translationRules = null; // Centralized translation rules engine
    let currentMode = 'talks'; // Persist selected mode across restarts
    let lastTextChangeTime = Date.now(); // Track when text last changed for pause detection
    // v160: full-text-then-extract restored with the KEY FIX: committedTranslation = translatedFull
    // (not committedTranslation = prev_committed + emitted, which caused cascade divergence in v155)
    let committedTranslation = ''; // Full translation emitted so far (reset on session start)
    let lastFullTranslation = ''; // Last full-transcript translation (for LCP matching)

    // Domain-specific STT phrase hints to reduce mis-hearings (e.g., “vestitori”)
    // STT phrase hints — boost domain-specific vocabulary the base model struggles with.
    //
    // RULES FOR THIS LIST:
    //  1. Only include words/phrases that actually fail without hints.
    //  2. Prefer multi-word phrases over single tokens — single-token hints cause the
    //     decoder to commit early, then decode the NEXT word with weakened beam energy,
    //     producing garbles in the immediately following word (confirmed root cause).
    //  3. NEVER include high-frequency Romanian function words or particles.
    //     “mai” (meaning “more/also/still”) appears in virtually every sentence;
    //     boosting it at any level creates a global attractor that garbles adjacent tokens.
    //  4. Boost is set to 10 (half of Google's documented max of 20). Max boost=20
    //     explicitly increases false positives per Google documentation.
    const STT_PHRASE_HINTS = [
        'vestitori',
        'Martorii lui Iehova',
        // Convention vocabulary — use only multi-word forms to avoid early-commit garbling
        // (single-token 'congres'/'congrese' removed: they caused adjacent-word substitutions)
        'congres special',
        'congrese speciale',
        'congres regional',
        'congrese regionale',
        'congres de circuit',
        'congrese de circuit',
        'asistența totală',
        'glosar',
        'traducere',
        'EarBuds',
        'gheață',
        'gheată',
        'Noua Zeelandă',
        'New Zealand',
        'New York',
        'New World',
        'nume nou',
        'nume noi',
        // Joy/rejoice vocabulary — prevents “bucuriei” → English “rejoice” code-switch
        'bucurie',
        'bucuriei',
        'bucurați-vă',
        'bucurați',
        'cartea bucuriei',
        // Congregation — prevents STT code-switch and helps Translation API pick “congregation” not “church”
        'congregație',
        'congregației',
        'congregațiile',
        'congregații',
        // Location/context terms
        'domiciliu',   // prevents mishearing as “domesti” (house arrest / home territory)
        'Domești',     // Romanian village name (JW preaching territory reports)
        'Tongo',       // stadium/venue name (STT garbles to “Togo” — country in Africa)
        // Hospitality/kindness vocabulary — prevents “bunătate” (kindness) → “bani” (money)
        'bunătate',
        'bunătatea',
        'cu bunătate',
        // Biblical people — commonly garbled by STT in JW meeting context
        'Isaia',       // Isaiah → STT produces "Nisa aia", "zona" etc. for Bible book references
        'Ieremia',     // Jeremiah
        'Ezechiel',    // Ezekiel
        'Avraam',      // Abraham
        'David',       // King David → STT produced "Daddy" (Yankee) in one session
        'Iacov',       // Jacob → STT produced "Yankee" in one session
        'Moise',       // Moses
        // Biblical Hebrew words in common Romanian JW use
        'cei răi',     // the wicked ones → STT produced "cei răni" (wounded) — Matthew 5:45
        'cei drepți',  // the righteous ones
        'cei buni',    // the good ones
        // Months — Romanian only; 'mai' OMITTED (it's the most common Romanian particle;
        // boosting it globally destroys token-boundary stability throughout every sentence)
        'ianuarie','februarie','martie','aprilie','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie',
        'january','february','march','april','may','june','july','august','september','october','november','december'
    ];

    // Helper function to update last activity time
    function updateActivity() {
        lastActivityTime = Date.now();

        // Clear existing inactivity timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
        }

        // Set new inactivity timer
        if (sessionActive) {
            inactivityTimer = setTimeout(() => {
                const inactiveMinutes = Math.floor((Date.now() - lastActivityTime) / 60000);
                logger.warn('Session timeout due to inactivity', {
                    clientId,
                    inactiveMinutes,
                    translationCount
                });

                sessionActive = false;
                cleanupStream();

                socket.emit('session-timeout', {
                    message: `Session stopped due to ${Math.floor(INACTIVITY_TIMEOUT_MS / 60000)} minutes of inactivity`,
                    inactiveMinutes
                });
            }, INACTIVITY_TIMEOUT_MS);
        }
    }

    // Helper function to clean up stream properly
    function cleanupStream() {
        isRestarting = false; // Cancel any pending auto-restart
        translationInFlight = false; // Reset so new sessions aren't blocked
        lastTranslatedText = '';
        lastInterimText = ''; // BUG-13: prevent stale pause-timer retranslation after restart

        // Cancel proactive stream duration timer
        if (streamDurationTimer) {
            clearTimeout(streamDurationTimer);
            streamDurationTimer = null;
        }

        // Cancel any pending restart timeout
        if (restartTimeout) {
            clearTimeout(restartTimeout);
            restartTimeout = null;
        }

        if (recognizeStream) {
            try {
                // Remove all event listeners to prevent memory leaks
                recognizeStream.removeAllListeners('error');
                recognizeStream.removeAllListeners('end');
                recognizeStream.removeAllListeners('close');
                recognizeStream.removeAllListeners('data');
                recognizeStream.removeAllListeners('pipe');
                recognizeStream.removeAllListeners('unpipe');

                // End the stream if it's still writable
                if (recognizeStream.writable) {
                    recognizeStream.end();
                }

                recognizeStream = null;
            } catch (error) {
                logger.error('Error cleaning up stream', {
                    clientId,
                    error: error.message
                });
                recognizeStream = null;
            }
        }
    }

    // Helper function to schedule auto-restart (prevents code duplication)
    // Guards against double-fire from both 'end' and 'close' events
    function scheduleAutoRestart() {
        if (!sessionActive || isRestarting) {
            recognizeStream = null; // Still clear stale reference
            return; // Already restarting or session ended
        }

        isRestarting = true;

        // Cancel any pending restart timeout
        if (restartTimeout) {
            clearTimeout(restartTimeout);
            restartTimeout = null;
        }

        restartAttempts++;

        if (restartAttempts > MAX_RESTART_ATTEMPTS) {
            logger.error('❌ Maximum restart attempts exceeded', {
                clientId,
                attempts: restartAttempts
            });
            sessionActive = false;
            isRestarting = false;
            cleanupStream();
            socket.emit('recognition-error', {
                message: 'Stream restarted too many times. Please refresh the page and try again.',
                code: 'MAX_RESTARTS_EXCEEDED'
            });
            return;
        }

        logger.info('🔄 Auto-restarting stream...', {
            clientId,
            attempt: restartAttempts,
            maxAttempts: MAX_RESTART_ATTEMPTS
        });

        // Clean up old stream before scheduling restart
        recognizeStream = null;
        translationInFlight = false; // BUG-21: prevent deadlock if translation was mid-flight at restart

        restartTimeout = setTimeout(() => {
            restartTimeout = null;
            if (sessionActive && isRestarting) {
                isRestarting = false;
                createRecognitionStream(currentLanguage, targetLanguage, translationInterval, currentMode, true)
                    .catch((error) => {
                        logger.error('Failed to restart stream', { clientId, error: error.message });
                        isRestarting = false;
                    });
            } else {
                isRestarting = false;
            }
        }, 0); // No delay - restart immediately
    }

    // Fallback single-word translations for common Romanian terms that may pass through unchanged
    const FALLBACK_TRANSLATIONS = {
        gheata: 'ice',
        gheată: 'boot',
        gheață: 'ice'
    };

    /**
     * Replace known domain terms in translated output.
     * @param {string} text - Translated (English) output to fix
     * @param {string} sourceText - Original Romanian source text (used for context-aware fixes)
     */
    function applyTermMappings(text, sourceText = '') {
        const mappings = [
            { pattern: /\bvestitori\b/gi, replacement: 'publishers' },
            { pattern: /\bMartorii lui Iehova\b/gi, replacement: "Jehovah's Witnesses" },
            { pattern: /\bnume nou\b/gi, replacement: 'new name' },
            { pattern: /\bnume noi\b/gi, replacement: 'new names' },
            // "congres" is a JW convention, not a political congress
            { pattern: /\bcongresses\b/gi, replacement: 'conventions' },
            { pattern: /\bcongress\b/gi, replacement: 'convention' },
        ];

        let result = text;
        for (const { pattern, replacement } of mappings) {
            result = result.replace(pattern, replacement);
        }

        // Source-aware fix: "congregație" → "congregation" (not "church").
        // Google Translate sometimes returns "church" for "congregație" in religious contexts.
        // JW terminology strictly uses "congregation", never "church".
        if (/congregați/i.test(sourceText)) {
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

        return result;
    }

    /**
     * Preserve numbers from source text to avoid numeric drift in translation.
     */
    function preserveSourceNumbers(sourceText, translatedText) {
        // Match multi-group Romanian thousands first (e.g. "1.234.567"), then single-group
        // thousands/decimals (e.g. "68.128" or "3.14"), then bare integers.
        // Multi-group must come first so the regex engine captures the full token in one pass.
        const numberRegex = /\d+(?:\.\d{3})+|\d+(?:[.,]\d+)?/g;
        const sourceNumbers = sourceText.match(numberRegex) || [];
        if (sourceNumbers.length === 0) return translatedText;

        // Romanian uses '.' as a thousands separator:
        //   "68.128"    = 68,128 (English)   — one separator group
        //   "1.234.567" = 1,234,567 (English) — two separator groups
        // Google Translate correctly converts these to English comma-format; we must NOT
        // replace them back with the Romanian dot-format or English readers see a decimal.
        //
        // Heuristic: one-or-more groups of (digits + dot) followed by exactly 3 digits
        // unambiguously identifies a thousands-separated number in this domain (religious speech).
        // Known acceptable false positive: genuine 3-decimal-place values like "3.141"
        // are essentially impossible in JW meeting content, so the domain risk is negligible.
        const isRomanianThousands = (n) => /^(\d+\.)+\d{3}$/.test(n);

        let result = translatedText;
        const translatedNumbers = translatedText.match(numberRegex) || [];

        // Exact one-to-one replacement when counts match
        if (translatedNumbers.length === sourceNumbers.length) {
            sourceNumbers.forEach((srcNum, idx) => {
                if (isRomanianThousands(srcNum)) return; // leave the English comma-format intact
                const targetNum = translatedNumbers[idx];
                if (targetNum) {
                    result = result.replace(targetNum, srcNum);
                }
            });
            return result;
        }

        // Heuristic: if translated has the same digits split across adjacent tokens, merge them
        sourceNumbers.forEach((srcNum) => {
            if (isRomanianThousands(srcNum)) return; // leave the English comma-format intact
            const digits = srcNum.replace(/[.,]/g, '');
            // Build regex to find runs of numbers separated by space/comma/dot
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
     * Preserve date components (day month year) if month drops out in translation.
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
            const [full, day, month, year] = m;
            const hasMonthInTranslation = monthRegex.test(result);
            const hasDay = result.includes(day);
            const hasYear = result.includes(year);

            if (hasDay && hasYear && !hasMonthInTranslation) {
                // Try to replace "day ... year" with full date
                const dayYearPattern = new RegExp(`${day}[\\s.,]*${year}`);
                if (dayYearPattern.test(result)) {
                    result = result.replace(dayYearPattern, `${day} ${month} ${year}`);
                } else {
                    // If not found, append month between day and year occurrences
                    result = result.replace(year, `${month} ${year}`);
                }
            }
        }
        return result;
    }

    /**
     * Extract the unemitted portion of a full translation using word-level LCP matching.
     *
     * HOW IT WORKS:
     *   Normalizes both strings (lowercase, strips edge punctuation per word), then counts
     *   how many words at the START of translatedFull match committedTranslation.
     *   If ≥60% match, treat that prefix as "committed" and return the tail.
     *   If <60%, return null — caller falls back to chunk-only translation.
     *
     * KEY FIX vs v155:
     *   Caller must set committedTranslation = translatedFull (not += emitted).
     *   This ensures each call compares the ENTIRE previous full translation against the
     *   new full translation — no divergence cascade.
     *
     * @param {string} translatedFull - Translation of the full STT transcript
     * @param {string} committedTranslation - Full translation from the previous call
     * @returns {string|null} New tail to emit, or null if LCP ratio < 60%
     */
    function extractByWordLCP(translatedFull, committedTranslation) {
        const trimmedFull = translatedFull.trim();
        const trimmedCommitted = committedTranslation.trim();
        if (!trimmedCommitted) return trimmedFull;
        if (!trimmedFull) return null;

        // Normalize: split on whitespace, strip leading/trailing punctuation, lowercase
        const normalizeWords = (s) =>
            s.split(/\s+/)
             .map(w => w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, ''))
             .filter(w => w.length > 0);

        const committedNorm = normalizeWords(trimmedCommitted);
        const fullNorm = normalizeWords(trimmedFull);
        const fullOrigWords = trimmedFull.split(/\s+/); // Preserve original case/punctuation

        if (committedNorm.length === 0) return trimmedFull;
        if (fullNorm.length <= committedNorm.length) return null; // Nothing new

        // Count consecutive matching words from the start
        let matchCount = 0;
        for (let i = 0; i < committedNorm.length && i < fullNorm.length; i++) {
            if (fullNorm[i] === committedNorm[i]) {
                matchCount++;
            } else {
                break;
            }
        }

        const matchRatio = matchCount / committedNorm.length;
        if (matchRatio < 0.6) return null; // LCP match failed

        const tail = fullOrigWords.slice(matchCount).join(' ').trim();
        return tail || null;
    }

    /**
     * Full-text translation with LCP extraction (v160).
     *
     * Sends the full STT transcript to Google Translate for maximum context quality,
     * then extracts only the new (unemitted) portion using word-level LCP matching.
     *
     * KEY FIX vs v155: committedTranslation = translatedFull (not += emitted),
     * so each subsequent LCP match compares the whole previous full translation —
     * eliminating the divergence cascade that broke v150–v156.
     *
     * Fallback: if LCP match ratio < 60%, translates decision.newText (the delta chunk)
     * directly — same as v157. committedTranslation is still set to translatedFull so
     * the next attempt has a clean baseline.
     *
     * @param {string} fullText - Full STT transcript for this utterance
     * @param {Object} decision - Decision object from shouldTranslate()
     * @param {boolean} clearInterim - If true, clear lastInterimText after a complete translation
     */
    async function performTranslation(fullText, decision, clearInterim = false) {
        const newText = (decision.newText || '').trim();
        if (!newText) {
            logger.info('⏭️ Approved but empty newText - skipping emit', { clientId, reason: decision.reason });
            return;
        }

        translationInFlight = true;
        try {
            // ── Step 1: Translate the FULL current transcript for maximum context ──
            const translatedFull = await translateWithRetry(fullText.trim(), targetLanguage, currentLanguage, clientId);

            logger.debug('🔤 Full-text translation', {
                clientId,
                fullTextWords: fullText.trim().split(/\s+/).length,
                newTextWords: newText.split(/\s+/).length,
                hasCommitted: !!committedTranslation,
                committedWords: committedTranslation ? committedTranslation.split(/\s+/).length : 0
            });

            // ── Step 2: Extract only the NEW portion via word-level LCP ──
            let emitted = null;
            let usedLCP = false;

            if (committedTranslation) {
                const tail = extractByWordLCP(translatedFull, committedTranslation);
                if (tail) {
                    emitted = tail;
                    usedLCP = true;
                    logger.debug('✂️ LCP extraction succeeded', { clientId, tailWords: tail.split(/\s+/).length });
                } else {
                    logger.info('⚠️ LCP extraction failed (<60% match) — falling back to chunk translation', {
                        clientId,
                        committedPreview: committedTranslation.substring(0, 60),
                        fullPreview: translatedFull.substring(0, 60)
                    });
                }
            } else {
                // First translation in this session — emit entire full translation
                emitted = translatedFull.trim();
                usedLCP = true;
            }

            // ── Fallback: chunk-only translation when LCP fails ──
            if (!emitted) {
                const chunkTranslated = await translateWithRetry(newText, targetLanguage, currentLanguage, clientId);
                emitted = chunkTranslated.trim();
            }

            // ── KEY FIX: committedTranslation = translatedFull (not += emitted) ──
            // This prevents the divergence cascade that broke v150-v156:
            // each subsequent LCP starts from the WHOLE previous full translation.
            committedTranslation = translatedFull;
            lastFullTranslation = translatedFull;

            // ── Step 3: Post-processing ──
            // Apply domain term mappings using fullText for source-aware fixes
            emitted = applyTermMappings(emitted, fullText);
            emitted = preserveSourceNumbers(newText, emitted);
            emitted = preserveDates(newText, emitted);

            // Single-word fallback translation
            const normalizedSource = newText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const normalizedEmitted = emitted.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (normalizedSource === normalizedEmitted && FALLBACK_TRANSLATIONS[normalizedSource]) {
                emitted = FALLBACK_TRANSLATIONS[normalizedSource];
            }

            // Update source tracking
            const ltRaw = `${lastTranslatedText} ${newText}`.trim();
            lastTranslatedText = ltRaw.length > 2000 ? ltRaw.slice(-2000) : ltRaw;
            lastTranslationTime = Date.now();

            if (!emitted) {
                logger.info('⏭️ Empty translation result - skipping emit', { clientId });
            } else {
                const isDuplicate = translationRules.isTranslationDuplicate(emitted);

                if (isDuplicate) {
                    logger.info('🚫 POST-TRANSLATION DUPLICATE detected - skipping emit', {
                        clientId,
                        emittedPreview: emitted.substring(0, 200)
                    });
                }

                translationRules.recordTranslatedOutput(emitted);

                if (!isDuplicate) {
                    const acRaw = (accumulatedText ? accumulatedText + ' ' : '') + emitted;
                    accumulatedText = acRaw.length > 1000 ? acRaw.slice(-1000) : acRaw;
                    translationCount++;

                    logger.info('✅ Translation completed', {
                        clientId,
                        reason: decision.reason,
                        confidence: decision.confidence,
                        method: usedLCP ? 'full+lcp' : 'chunk_fallback',
                        newContent: emitted.substring(0, 200),
                        sourceText: newText.substring(0, 200),
                        count: translationCount,
                        isComplete: decision.isComplete
                    });

                    translationRules.recordTranslation(fullText, emitted);

                    socket.emit('translation-result', {
                        original: newText,
                        translated: emitted,
                        accumulated: accumulatedText,
                        count: translationCount,
                        isInterim: !decision.isComplete,
                        reason: decision.reason
                    });

                    // Persist to translation_log for debugging (fire-and-forget)
                    billingDb.logTranslation({
                        sessionId: clientId,
                        clientId: clientId,
                        sourceText: newText,
                        translatedText: emitted,
                        sourceLanguage: currentLanguage,
                        targetLanguage: targetLanguage,
                        reason: decision.reason,
                        appVersion: 'v160'
                    }).catch(() => {}); // Non-fatal

                    restartAttempts = 0;
                }
            }

            // Clear interim text after a complete result (main handler only)
            if (clearInterim && decision.isComplete) {
                lastInterimText = '';
            }

        } catch (error) {
            logger.error('Translation error', {
                clientId,
                reason: decision.reason,
                error: error.message
            });
            socket.emit('translation-error', {
                message: error.message
            });
        } finally {
            translationInFlight = false;
        }
    }

    // Extract stream creation logic into separate function (fixes recursive event emission)
    async function createRecognitionStream(sourceLanguage, targetLang, interval, mode = 'talks', isRestart = false) {
        try {
            currentLanguage = sourceLanguage;
            targetLanguage = targetLang;
            translationInterval = interval;
            const intervalMs = translationInterval;

            // Only reset counters on initial start, not on auto-restart
            if (!isRestart) {
                accumulatedText = '';
                translationCount = 0;
                restartAttempts = 0; // Reset restart counter on new session
                committedTranslation = ''; // Reset full-context translation state for new session
                lastFullTranslation = '';
            }

            sessionActive = true;
            updateActivity(); // Start inactivity timer

            logger.info('🎤 Starting speech recognition stream', {
                clientId,
                sourceLanguage: currentLanguage,
                targetLanguage,
                receivedInterval: translationInterval,
                finalIntervalMs: intervalMs
            });

            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: 48000,
                    languageCode: currentLanguage,
                    enableAutomaticPunctuation: true,
                    model: 'latest_long',
                    useEnhanced: true,
                    maxAlternatives: 1,
                    enableWordTimeOffsets: false,
                    enableWordConfidence: false,
                    enableSpeakerDiarization: false,
                    speechContexts: [
                        {
                            phrases: STT_PHRASE_HINTS,
                            boost: 10  // 10 = midpoint; 20 (max) explicitly increases false positives per Google docs
                        }
                    ]
                },
                interimResults: true,
                singleUtterance: false
            };

            recognizeStream = speechClient
                .streamingRecognize(request)
                .on('error', (error) => {
                    const errorCode = error.code ? String(error.code) : '';
                    logger.error('Speech recognition error', {
                        clientId,
                        error: error.message,
                        code: error.code,
                        errorCode,
                        stack: error.stack
                    });

                    // Check if this is a stream timeout error (305 seconds exceeded)
                    // gRPC codes: 11 = OUT_OF_RANGE, 4 = DEADLINE_EXCEEDED
                    const isStreamTimeout = error.code === 11 ||
                                          error.code === 4 ||
                                          error.message.includes('maximum allowed stream duration') ||
                                          error.message.includes('Exceeded maximum allowed stream duration');

                    // "Audio Timeout" means Google got no audio for ~10s (silence: prayer, song, break).
                    // This is NOT a real error — reset the restart counter so silence never kills the stream.
                    const isAudioTimeout = error.message.includes('Audio Timeout') ||
                                          error.message.includes('Long duration elapsed without audio');

                    if (isStreamTimeout && sessionActive) {
                        if (isAudioTimeout) {
                            logger.info('🔇 Audio timeout (silence detected) — resetting restart counter', { clientId });
                            restartAttempts = 0; // Silence is not a failure; don't count toward max
                        }
                        logger.info('🔄 Stream timeout detected, auto-restarting...', { clientId });
                        scheduleAutoRestart();
                    } else {
                        // Only emit error for non-timeout errors
                        socket.emit('recognition-error', {
                            message: error.message,
                            code: error.code
                        });
                    }
                })
                .on('end', () => {
                    logger.warn('⚠️ Recognition stream ended by Google Cloud', { clientId });
                    scheduleAutoRestart();
                })
                .on('close', () => {
                    logger.warn('⚠️ Recognition stream closed by Google Cloud', { clientId });
                    scheduleAutoRestart();
                })
                .on('pipe', () => {
                    logger.debug('📡 Stream pipe event', { clientId });
                })
                .on('unpipe', () => {
                    logger.debug('📡 Stream unpipe event', { clientId });
                })
                .on('data', async (data) => {
                    logger.info('📥 GOOGLE CLOUD DATA EVENT!', {
                        clientId,
                        hasResults: !!data.results,
                        resultsLength: data.results?.length,
                        rawData: JSON.stringify(data).substring(0, 200)
                    });

                    const result = data.results[0];
                    if (!result) return;

                    const alternative = result.alternatives[0];
                    const transcript = alternative.transcript || '';
                    const isFinal = result.isFinal || false;

                    // Skip empty transcripts but don't block the flow
                    if (transcript.length === 0) {
                        logger.debug('Empty transcript in alternative', { clientId });
                        return;
                    }

                    logger.debug('📝 Recognition result', {
                        clientId,
                        transcript: transcript.substring(0, 200),
                        isFinal,
                        length: transcript.length,
                        sessionActive
                    });

                    // Send interim results to client for visual feedback
                    if (sessionActive) {
                        socket.emit('interim-result', {
                            text: transcript,
                            isFinal
                        });

                        // Update activity timestamp
                        updateActivity();

                        // Track text changes for pause detection
                        const previousInterimText = lastInterimText;
                        lastInterimText = transcript;
                        const textChanged = previousInterimText !== transcript;

                        // Clear pause detection timer if text is still changing
                        if (textChanged && restartStreamTimer) {
                            clearTimeout(restartStreamTimer);
                            restartStreamTimer = null;
                        }

                        // ===========================================
                        // CENTRALIZED TRANSLATION DECISION
                        // ===========================================

                        // Safety check: If rules engine not initialized, skip translation logic
                        if (!translationRules) {
                            logger.error('❌ Translation rules engine not initialized!', { clientId });
                            return;
                        }

                        const decision = translationRules.shouldTranslate({
                            text: transcript,
                            isFinal: isFinal,
                            timeSinceLastChange: textChanged ? 0 : (Date.now() - (lastTextChangeTime || Date.now())),
                            trigger: isFinal ? 'final' : 'interim',
                            clientId: clientId
                        });

                        // Update last text change time
                        if (textChanged) {
                            lastTextChangeTime = Date.now();
                        }

                        // ===========================================
                        // ACT ON DECISION
                        // ===========================================

                        if (decision.shouldTranslate) {
                            // Skip if another translation is already in flight (prevents race conditions)
                            if (translationInFlight) {
                                logger.debug('⏳ Translation in flight, deferring', { clientId });
                            } else {
                            // Clear any pending pause timer - we're translating now
                            if (restartStreamTimer) {
                                clearTimeout(restartStreamTimer);
                                restartStreamTimer = null;
                            }

                            await performTranslation(transcript, decision, true);
                            } // end of translationInFlight guard
                        } else {
                            // Translation rejected - maybe start pause detection timer
                            // Only set pause timer for interim results when max interval not reached
                            if (!isFinal && !restartStreamTimer && textChanged && translationRules) {
                                const pauseMs = translationRules.getConfig().pauseDetectionMs;

                                restartStreamTimer = setTimeout(async () => {
                                    logger.info('⏰ PAUSE timer fired - checking rules engine', { clientId });

                                    // Re-check with rules engine after pause
                                    const pauseDecision = translationRules.shouldTranslate({
                                        text: lastInterimText,
                                        isFinal: false,
                                        timeSinceLastChange: pauseMs,
                                        trigger: 'pause',
                                        clientId: clientId
                                    });

                                    if (pauseDecision.shouldTranslate && sessionActive && !translationInFlight) {
                                        await performTranslation(lastInterimText, pauseDecision, false);
                                    }

                                    restartStreamTimer = null;
                                }, pauseMs);
                            }

                            logger.debug('⏭️ Translation skipped', {
                                clientId,
                                reason: decision.reason,
                                textPreview: transcript.substring(0, 30),
                                isFinal
                            });
                        }
                    }
                });

            // Set proactive restart timer (290s before Google's ~305s limit)
            if (streamDurationTimer) {
                clearTimeout(streamDurationTimer);
            }
            streamDurationTimer = setTimeout(() => {
                streamDurationTimer = null;
                if (sessionActive && !isRestarting) {
                    logger.info('⏰ Proactive stream restart at 290s', { clientId });
                    scheduleAutoRestart();
                }
            }, STREAM_DURATION_LIMIT_MS);

            // Flush buffered audio from restart gap
            if (audioBufferDuringRestart.length > 0) {
                logger.info('📦 Flushing buffered audio from restart', {
                    clientId,
                    bufferedChunks: audioBufferDuringRestart.length
                });
                for (const audioData of audioBufferDuringRestart) {
                    if (recognizeStream && recognizeStream.writable) {
                        try {
                            const buffer = Buffer.from(audioData);
                            recognizeStream.write(buffer);
                        } catch (e) {
                            logger.warn('⚠️ Error flushing buffered audio chunk', {
                                clientId,
                                error: e.message
                            });
                        }
                    }
                }
                audioBufferDuringRestart = []; // Clear buffer
                audioBufferWarned = false;
            }

            socket.emit('streaming-started', {
                sourceLanguage: currentLanguage,
                targetLanguage
            });

        } catch (error) {
            logger.error('Failed to start streaming', {
                clientId,
                error: error.message
            });
            socket.emit('start-error', { message: error.message });
        }
    }

    // Socket handler for start-streaming event (validates and calls createRecognitionStream)
    socket.on('start-streaming', async ({ sourceLanguage, targetLang, translationInterval: interval, mode, isRestart }) => {
        // Input validation
        const validLanguageCodes = /^[a-z]{2}-[A-Z]{2}$/;
        const validTargetLanguages = /^[a-z]{2}(-[A-Z]{2})?$/;

        if (sourceLanguage && !validLanguageCodes.test(sourceLanguage)) {
            logger.warn('Invalid source language code', { clientId, sourceLanguage });
            socket.emit('start-error', { message: 'Invalid source language code' });
            return;
        }

        if (targetLang && !validTargetLanguages.test(targetLang)) {
            logger.warn('Invalid target language code', { clientId, targetLang });
            socket.emit('start-error', { message: 'Invalid target language code' });
            return;
        }

        let sanitizedInterval = undefined;
        if (interval !== undefined) {
            if (typeof interval === 'number' && !Number.isNaN(interval) && interval >= 1000 && interval <= 60000) {
                sanitizedInterval = interval;
            } else {
                logger.warn('Invalid translation interval provided, falling back to mode default', { clientId, interval });
            }
        }

        const validModes = ['talks', 'earbuds'];
        const selectedMode = mode && validModes.includes(mode) ? mode : 'talks';
        currentMode = selectedMode;

        // Guard: clean up existing gRPC stream before starting a new one.
        // Without this, a duplicate start-streaming event leaks the old stream.
        if (recognizeStream) {
            logger.warn('⚠️ start-streaming while stream active - stopping existing stream', { clientId });
            cleanupStream();
        }

        // Initialize translation rules engine for this session
        translationRules = new TranslationRulesEngine(selectedMode, logger);
        const modeConfig = translationRules.getConfig();

        logger.info('🎯 Translation rules engine initialized', {
            clientId,
            mode: selectedMode,
            config: translationRules.getConfig()
        });

        // Call the extracted function
        await createRecognitionStream(
            sourceLanguage || 'ro-RO',
            targetLang || 'en',
            sanitizedInterval || modeConfig.translationInterval || 6000,
            selectedMode,
            isRestart || false
        );
    });

    // Receive audio data from client
    let audioChunkCount = 0;

    // Rate limiting for audio data
    let audioDataReceived = 0;
    let audioRateLimitWindow = Date.now();
    const MAX_AUDIO_BYTES_PER_SECOND = 1024 * 1024 * 2; // 2MB/sec max

    // Detect audio format once for efficiency
    let audioDataFormat = null;

    socket.on('audio-data', (audioData) => {
        // Buffer audio during restart to prevent gaps
        if (isRestarting && sessionActive) {
            if (audioBufferDuringRestart.length < MAX_AUDIO_BUFFER_SIZE) {
                audioBufferDuringRestart.push(audioData);
            } else if (!audioBufferWarned) {
                logger.warn('⚠️ Audio buffer full during restart - dropping chunks', {
                    clientId,
                    bufferSize: MAX_AUDIO_BUFFER_SIZE
                });
                audioBufferWarned = true;
            }
            // Still update activity during restart
            updateActivity();
            return;
        }

        if (recognizeStream && sessionActive && !recognizeStream.destroyed && recognizeStream.writable) {
            try {
                updateActivity(); // Reset inactivity timer on audio
                audioChunkCount++;

                // Detect format once, reuse for all subsequent chunks
                if (!audioDataFormat) {
                    if (audioData instanceof Buffer) {
                        audioDataFormat = 'buffer';
                    } else if (audioData instanceof ArrayBuffer) {
                        audioDataFormat = 'arraybuffer';
                    } else if (audioData.buffer) {
                        audioDataFormat = 'typed-array';
                    } else {
                        audioDataFormat = 'unknown';
                    }
                    logger.info(`📊 Audio format detected: ${audioDataFormat}`, { clientId });
                }

                // Fast path based on detected format
                let buffer;
                switch (audioDataFormat) {
                    case 'buffer':
                        buffer = audioData;
                        break;
                    case 'arraybuffer':
                        buffer = Buffer.from(audioData);
                        break;
                    case 'typed-array':
                        buffer = Buffer.from(audioData.buffer);
                        break;
                    default:
                        buffer = Buffer.from(audioData);
                }

                // Validate chunk size to prevent DoS attacks
                if (buffer.length > MAX_AUDIO_CHUNK_SIZE) {
                    logger.warn('Audio chunk exceeds maximum size', {
                        clientId,
                        chunkSize: buffer.length,
                        maxSize: MAX_AUDIO_CHUNK_SIZE
                    });
                    socket.emit('recognition-error', {
                        message: 'Audio chunk too large',
                        code: 'CHUNK_TOO_LARGE'
                    });
                    return;
                }

                // Rate limiting: check if client is sending too much data
                const now = Date.now();
                if (now - audioRateLimitWindow >= 1000) {
                    // Reset window every second
                    audioDataReceived = 0;
                    audioRateLimitWindow = now;
                }

                audioDataReceived += buffer.length;

                if (audioDataReceived > MAX_AUDIO_BYTES_PER_SECOND) {
                    logger.warn('Audio data rate limit exceeded', {
                        clientId,
                        bytesPerSecond: audioDataReceived,
                        maxBytes: MAX_AUDIO_BYTES_PER_SECOND
                    });
                    socket.emit('recognition-error', {
                        message: 'Audio data rate limit exceeded',
                        code: 'RATE_LIMIT_EXCEEDED'
                    });
                    return;
                }

                if (buffer.length === 0) {
                    logger.warn('Empty audio chunk received', { clientId });
                    return;
                }

                if (audioChunkCount === 1 || audioChunkCount === 5 || audioChunkCount === 10) {
                    // Log chunks with sample data for debugging
                    const samples = [];
                    for (let i = 0; i < Math.min(10, buffer.length / 2); i++) {
                        samples.push(buffer.readInt16LE(i * 2));
                    }
                    const allZeros = samples.every(s => s === 0);
                    const hasAudio = samples.some(s => Math.abs(s) > 100);
                    logger.info(`📊 Audio chunk #${audioChunkCount} received`, {
                        clientId,
                        byteLength: buffer.length,
                        firstSamples: samples,
                        allZeros,
                        hasAudio
                    });
                } else if (audioChunkCount % 50 === 0) {
                    logger.info('📊 Audio data received', {
                        clientId,
                        chunkNumber: audioChunkCount,
                        byteLength: buffer.length
                    });
                }

                const writeSuccess = recognizeStream.write(buffer);
                if (audioChunkCount === 1) {
                    logger.info('📤 First chunk written to Google Cloud', {
                        clientId,
                        writeSuccess,
                        streamWritable: recognizeStream.writable,
                        streamReadable: recognizeStream.readable
                    });
                }
            } catch (error) {
                logger.error('Error writing audio data', {
                    clientId,
                    error: error.message,
                    code: error.code,
                    stack: error.stack
                });

                // If stream is destroyed, notify client
                if (error.code === 'ERR_STREAM_DESTROYED') {
                    recognizeStream = null;
                    socket.emit('recognition-error', {
                        message: 'Stream destroyed - please restart recording',
                        code: 'STREAM_DESTROYED'
                    });
                }
            }
        } else if (recognizeStream && !recognizeStream.writable && sessionActive) {
            // Stream exists but is not writable - notify client once
            logger.warn('⚠️ Attempted to write to non-writable stream', { clientId });
            recognizeStream = null;
            socket.emit('recognition-error', {
                message: 'Stream no longer writable - please restart recording',
                code: 'STREAM_NOT_WRITABLE'
            });
        }
    });

    // Stop streaming
    socket.on('stop-streaming', () => {
        logger.info('⏹️ Stopping speech recognition stream', {
            clientId,
            translationCount,
            accumulatedLength: accumulatedText.length
        });

        sessionActive = false;

        // Clear forced translation timer
        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        // Clear inactivity timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }

        cleanupStream();

        socket.emit('streaming-stopped', {
            translationCount,
            accumulatedText
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        activeConnections--;
        sessionActive = false;

        // Decrement IP connection count
        const currentIpConnections = connectionsByIp.get(clientIp) || 1;
        if (currentIpConnections <= 1) {
            connectionsByIp.delete(clientIp);
        } else {
            connectionsByIp.set(clientIp, currentIpConnections - 1);
        }

        // Clear forced translation timer
        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        // Clear inactivity timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }

        cleanupStream();

        logger.info('❌ Client disconnected', {
            socketId: socket.id,
            clientIp,
            remainingConnections: activeConnections,
            translationCount
        });
    });
});

// ===== START SERVER =====
server.listen(PORT, async () => {
    logger.info('═══════════════════════════════════════');
    logger.info('🎉 GTranslate V4 - Google Cloud Speech');
    logger.info('═══════════════════════════════════════');
    logger.info(`🌐 Server: http://localhost:${PORT}`);
    logger.info('🎤 Speech Recognition: Google Cloud (No timeout)');
    logger.info('🌍 Translation: Google Cloud');
    logger.info(`📝 Logging: ${path.relative(__dirname, LOG_FILE)}`);
    logger.info('═══════════════════════════════════════');

    // Initialize billing database
    const dbInitialized = billingDb.initializeDatabase(logger);
    if (dbInitialized) {
        await billingDb.createSchema(logger);

        // Purge old billing data (older than 90 days)
        await billingDb.purgeOldData(90, logger);

        // Schedule daily purge at 2 AM
        const scheduleDailyPurge = () => {
            const now = new Date();
            const next2AM = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() + 1,
                2, 0, 0
            );
            const timeUntil2AM = next2AM.getTime() - now.getTime();

            setTimeout(async () => {
                await billingDb.purgeOldData(90, logger);
                // Schedule next purge
                setInterval(() => {
                    billingDb.purgeOldData(90, logger);
                }, 24 * 60 * 60 * 1000); // Every 24 hours
            }, timeUntil2AM);
        };

        scheduleDailyPurge();
        logger.info('🗑️ Scheduled daily purge of billing data older than 90 days');
    }

    logger.info('✅ Ready to receive connections');
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await billingDb.closeDatabase(logger);
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully (SIGTERM)...');
    await billingDb.closeDatabase(logger);
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});
