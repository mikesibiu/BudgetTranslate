/**
 * BudgetTranslate Server
 * Real-time speech translation using Web Speech API (browser-side STT)
 * and Google Cloud Translation v3 (within free tier)
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const billingDb = require('./billing-db');
const TranslationRulesEngine = require('./translation-rules-engine');
const session = require('express-session');

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

const APP_PASSWORD = process.env.APP_PASSWORD || null;

// Guard: SESSION_SECRET must be set in production — hardcoded fallback is a security hole
if (NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET environment variable is not set. Refusing to start in production.');
    process.exit(1);
}
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'budgettranslate-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
});

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
const translateClient = googleCredentials
    ? new TranslationServiceClient({ credentials: googleCredentials })
    : new TranslationServiceClient();

// Get project ID and location for v3 API
const projectId = googleCredentials?.project_id || credentialsProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const parent = projectId ? `projects/${projectId}/locations/${location}` : null;
// Two unidirectional glossaries — one per translation direction.
// Both contain the same 734 JW domain entries; the en→ro one has columns swapped.
const roEnGlossaryPath = parent ? `${parent}/glossaries/ro-en-religious-terms` : null;
const enRoGlossaryPath = parent ? `${parent}/glossaries/en-ro-religious-terms` : null;
const glossaryEnabled = process.env.GLOSSARY_ENABLED === 'true'; // opt-in only: set GLOSSARY_ENABLED=true to enable

// Helper: pick the right glossary path for a given translation direction
function getGlossaryPath(sourceLangCode, targetLangCode) {
    if (!glossaryEnabled) return null;
    if (sourceLangCode === 'ro' && targetLangCode === 'en') return roEnGlossaryPath;
    if (sourceLangCode === 'en' && targetLangCode === 'ro') return enRoGlossaryPath;
    return null; // no glossary for other language pairs
}
const translationModel = process.env.TRANSLATION_MODEL || 'advanced';

if (!projectId) {
    logger.error('❌ No Google Cloud project ID found - translations will fail');
    logger.error('Set project ID via:');
    logger.error('  1. GOOGLE_CLOUD_PROJECT environment variable');
    logger.error('  2. GCP_PROJECT environment variable');
    logger.error('  3. project_id in credentials JSON');
    process.exit(1);
}

logger.info('✅ Google Cloud Translation v3 client initialized', {
    projectId,
    location,
    translationModel,
    glossaryEnabled,
    roEnGlossary: glossaryEnabled ? roEnGlossaryPath : 'disabled',
    enRoGlossary: glossaryEnabled ? enRoGlossaryPath : 'disabled',
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

app.set('trust proxy', 1);
app.use(sessionMiddleware);

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
                'https://freetranslate.farace.net',
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

io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
    if (!APP_PASSWORD) return next();
    if (req.session && req.session.authenticated) return next();
    if (req.path && req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
    res.redirect('/login');
}

app.get('/login', (req, res) => {
    if (!APP_PASSWORD || (req.session && req.session.authenticated)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const password = (req.body && req.body.password) || '';
    if (APP_PASSWORD && password === APP_PASSWORD) {
        req.session.authenticated = true;
        return res.redirect('/');
    }
    res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/billing', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'billing.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ===== BILLING API ENDPOINTS =====

// Track usage (called from client)
app.post('/api/billing/track', requireAuth, express.json(), async (req, res) => {
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
app.get('/api/billing/summary', requireAuth, async (req, res) => {
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
app.get('/api/billing/daily', requireAuth, async (req, res) => {
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

    // Pick direction-appropriate glossary (ro→en or en→ro; null for other pairs)
    const sourceLangCode = sourceLanguage.includes('-')
        ? sourceLanguage.split('-')[0]
        : sourceLanguage;
    let activeGlossaryPath = getGlossaryPath(sourceLangCode, targetLang);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
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

            // Add direction-appropriate glossary if available
            if (activeGlossaryPath) {
                request.glossaryConfig = {
                    glossary: activeGlossaryPath,
                    ignoreCase: true  // Case-insensitive for JW domain terms
                };
                logger.debug('Using glossary for translation', { glossaryPath: activeGlossaryPath, clientId });
            }

            const [response] = await translateClient.translateText(request);

            // When a glossary was applied, prefer glossary_translations (glossary-aware result)
            const translation = (activeGlossaryPath && response.glossaryTranslations?.length)
                ? response.glossaryTranslations[0].translatedText
                : response.translations[0].translatedText;

            return translation;
        } catch (error) {
            const errorCode = error.code ? String(error.code) : '';
            const errorMessage = error.message || '';

            // Check if this is a glossary-related error
            const isGlossaryError = errorMessage.includes('glossary') ||
                                   errorMessage.includes('NOT_FOUND') ||
                                   errorCode === '5'; // NOT_FOUND code

            // If glossary error on first attempt with glossary, retry without glossary
            if (isGlossaryError && activeGlossaryPath) {
                logger.warn('Glossary not found or error, retrying without glossary', {
                    clientId,
                    glossaryPath: activeGlossaryPath,
                    error: errorMessage
                });
                activeGlossaryPath = null;
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
                    usedGlossary: !!activeGlossaryPath
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
    // Reject unauthenticated socket connections
    if (APP_PASSWORD && !(socket.request.session && socket.request.session.authenticated)) {
        socket.emit('connection-error', { message: 'Authentication required', code: 'UNAUTHORIZED' });
        socket.disconnect(true);
        return;
    }

    // Get client IP address (trust proxy: read x-forwarded-for behind Heroku/Koyeb)
    const xForwardedFor = socket.handshake.headers['x-forwarded-for'];
    const clientIp = xForwardedFor
        ? xForwardedFor.split(',')[0].trim()
        : (socket.handshake.address || socket.conn.remoteAddress);

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

    let currentLanguage = 'ro-RO';
    let targetLanguage = 'en';
    let accumulatedText = '';
    let translationCount = 0;
    let sessionActive = false;
    let restartStreamTimer = null;
    let lastInterimText = '';
    let lastTranslationTime = null; // Track when last translation happened for 15s max interval
    let lastTranslatedText = ''; // Track concatenated source text already translated
    let lastActivityTime = Date.now();
    let inactivityTimer = null;
    const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT; // Use config value
    let translationInFlight = false; // Prevent concurrent translations (race condition fix)
    let pendingTranslation = null; // Deferred final translation waiting for in-flight to complete
    let translationRules = null; // Centralized translation rules engine
    let currentMode = 'talks'; // Persist selected mode across restarts
    let lastTextChangeTime = Date.now(); // Track when text last changed for pause detection
    // v160: full-text-then-extract restored with the KEY FIX: committedTranslation = translatedFull
    // (not committedTranslation = prev_committed + emitted, which caused cascade divergence in v155)
    let committedTranslation = ''; // Full translation emitted so far (reset on session start)
    let lastFullTranslation = ''; // Last full-transcript translation (for LCP matching)

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
                cleanupSession();

                socket.emit('session-timeout', {
                    message: `Session stopped due to ${Math.floor(INACTIVITY_TIMEOUT_MS / 60000)} minutes of inactivity`,
                    inactiveMinutes
                });
            }, INACTIVITY_TIMEOUT_MS);
        }
    }

    // Helper function to clean up session state
    function cleanupSession() {
        translationInFlight = false;
        pendingTranslation = null; // Discard any deferred translation
        lastTranslatedText = '';
        lastInterimText = '';

        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }
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
     * Verify religious proper nouns survived translation correctly (en→ro direction).
     *
     * When translating English to Romanian, Google may produce incorrect variants of
     * JW proper nouns (e.g. 'Jehova' instead of 'Iehova', 'Biblie' instead of 'Biblia').
     * This function patches known bad variants to the authoritative Romanian JW form.
     *
     * Only runs when targetLang is 'ro'. Ported from PhraseTranslation's
     * _verify_religious_terms().
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
            if (sourceLower.includes(engTerm)) {
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
     *   If ≥75% match, treat that prefix as "committed" and return the tail.
     *   If <75%, return null — caller emits the full translation (full context preserved).
     *
     * KEY FIX vs v155:
     *   Caller must set committedTranslation = translatedFull (not += emitted).
     *   This ensures each call compares the ENTIRE previous full translation against the
     *   new full translation — no divergence cascade.
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
        if (matchRatio < 0.75) return null; // LCP match failed (threshold: 75%)

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
                    logger.info('⚠️ LCP extraction failed (<75% match) — emitting full translation', {
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

            // ── Fallback: LCP failed — emit full translation (full context preserved) ──
            // Never translate chunks in isolation: a decontextualized fragment loses grammatical
            // context and produces broken English ("speaking like a foreigner").
            if (!emitted) {
                emitted = translatedFull.trim();
            }

            // ── KEY FIX: committedTranslation = translatedFull (not += emitted) ──
            // This prevents the divergence cascade that broke v150-v156:
            // each subsequent LCP starts from the WHOLE previous full translation.
            committedTranslation = translatedFull;
            lastFullTranslation = translatedFull;

            // ── Step 3: Post-processing ──
            // Apply domain term mappings using fullText for source-aware fixes
            emitted = applyTermMappings(emitted, fullText);
            emitted = verifyReligiousTerms(emitted, fullText, targetLanguage);
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
                        appVersion: 'v1'
                    }).catch(() => {}); // Non-fatal
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
            // Run any pending final translation that was deferred while we were in-flight
            if (pendingTranslation && sessionActive) {
                const { transcript: pt, decision: pd } = pendingTranslation;
                pendingTranslation = null;
                logger.info('▶️ Running deferred pending translation', { clientId, preview: pt.substring(0, 60) });
                performTranslation(pt, pd, true).catch(err => {
                    logger.error('Deferred translation error', { clientId, error: err.message });
                });
            }
        }
    }

    socket.on('start-session', ({ sourceLanguage, targetLang, mode }) => {
        const validLanguageCodes = /^[a-z]{2}-[A-Z]{2}$/;
        const validTargetLanguages = /^[a-z]{2}(-[A-Z]{2})?$/;

        if (sourceLanguage && !validLanguageCodes.test(sourceLanguage)) {
            socket.emit('start-error', { message: 'Invalid source language code' });
            return;
        }
        if (targetLang && !validTargetLanguages.test(targetLang)) {
            socket.emit('start-error', { message: 'Invalid target language code' });
            return;
        }

        currentLanguage = sourceLanguage || 'ro-RO';
        targetLanguage = targetLang || 'en';
        accumulatedText = '';
        translationCount = 0;
        committedTranslation = '';
        lastFullTranslation = '';
        lastTranslatedText = '';
        lastInterimText = '';

        const validModes = ['talks', 'earbuds'];
        currentMode = mode && validModes.includes(mode) ? mode : 'talks';

        translationRules = new TranslationRulesEngine(currentMode, logger);

        sessionActive = true;
        updateActivity();

        logger.info('🎤 Session started (Web Speech API)', { clientId, sourceLanguage: currentLanguage, targetLanguage, mode: currentMode });

        socket.emit('session-started', { sourceLanguage: currentLanguage, targetLanguage });
    });

    socket.on('transcript-result', async ({ text, isFinal }) => {
        if (!sessionActive || !translationRules) return;

        updateActivity();

        const textChanged = text !== lastInterimText;
        const previousText = lastInterimText;
        lastInterimText = text;

        // Echo transcript back for interim display
        socket.emit('interim-result', { text, isFinal });

        // Clear pause timer if text changed
        if (textChanged && restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        const decision = translationRules.shouldTranslate({
            text,
            isFinal,
            timeSinceLastChange: textChanged ? 0 : (Date.now() - (lastTextChangeTime || Date.now())),
            trigger: isFinal ? 'final' : 'interim',
            clientId
        });

        if (textChanged) lastTextChangeTime = Date.now();

        if (decision.shouldTranslate) {
            if (translationInFlight) {
                logger.debug('⏳ Translation in flight, deferring', { clientId });
                // For final results, save the latest deferred translation to run after in-flight completes
                if (isFinal) {
                    pendingTranslation = { transcript: text, decision };
                    logger.info('📋 Queued pending final translation', { clientId, preview: text.substring(0, 60) });
                }
            } else {
                if (restartStreamTimer) {
                    clearTimeout(restartStreamTimer);
                    restartStreamTimer = null;
                }
                await performTranslation(text, decision, true);
            }
        } else if (!isFinal && !restartStreamTimer && textChanged && translationRules) {
            const pauseMs = translationRules.getConfig().pauseDetectionMs;
            restartStreamTimer = setTimeout(async () => {
                const pauseDecision = translationRules.shouldTranslate({
                    text: lastInterimText,
                    isFinal: false,
                    timeSinceLastChange: pauseMs,
                    trigger: 'pause',
                    clientId
                });
                if (pauseDecision.shouldTranslate && sessionActive && !translationInFlight) {
                    await performTranslation(lastInterimText, pauseDecision, false);
                }
                restartStreamTimer = null;
            }, pauseMs);
        }
    });

    socket.on('stop-session', () => {
        logger.info('⏹️ Session stopped', { clientId, translationCount });

        sessionActive = false;

        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }

        cleanupSession();

        socket.emit('session-stopped', { translationCount, accumulatedText });
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

        cleanupSession();

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
    logger.info('🎉 BudgetTranslate - Web Speech API');
    logger.info('═══════════════════════════════════════');
    logger.info(`🌐 Server: http://localhost:${PORT}`);
    logger.info('🎤 Speech Recognition: Web Speech API (browser-side)');
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
