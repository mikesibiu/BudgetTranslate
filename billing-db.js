/**
 * Billing Database Module
 * Handles persistent storage of usage tracking data in PostgreSQL
 * Automatically purges data older than 90 days
 */

const { Pool } = require('pg');

// PostgreSQL connection pool
let pool = null;

/**
 * Initialize database connection
 * Uses DATABASE_URL environment variable (automatically set by Heroku)
 */
function initializeDatabase(logger) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        logger.warn('⚠️ DATABASE_URL not found - billing data will not be persisted');
        logger.warn('   Set up Heroku Postgres: heroku addons:create heroku-postgresql:mini');
        return false;
    }

    try {
        pool = new Pool({
            connectionString,
            ssl: process.env.NODE_ENV === 'production' ? {
                rejectUnauthorized: false
            } : false,
            max: 10, // Maximum connections in pool
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });

        logger.info('✅ PostgreSQL connection pool initialized');
        return true;
    } catch (error) {
        logger.error('❌ Failed to initialize PostgreSQL pool:', error.message);
        return false;
    }
}

/**
 * Create database schema if it doesn't exist
 */
async function createSchema(logger) {
    if (!pool) {
        logger.warn('Database not initialized - skipping schema creation');
        return false;
    }

    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS billing_usage (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            session_date DATE NOT NULL,
            source_language VARCHAR(10) NOT NULL,
            usage_type VARCHAR(20) NOT NULL CHECK (usage_type IN ('stt', 'translation', 'glossary')),
            amount NUMERIC(12, 4) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_billing_session_date ON billing_usage(session_date);
        CREATE INDEX IF NOT EXISTS idx_billing_source_language ON billing_usage(source_language);
        CREATE INDEX IF NOT EXISTS idx_billing_created_at ON billing_usage(created_at);

        CREATE TABLE IF NOT EXISTS translation_log (
            id SERIAL PRIMARY KEY,
            session_id VARCHAR(64) NOT NULL,
            client_id VARCHAR(64) NOT NULL,
            source_text TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            source_language VARCHAR(10),
            target_language VARCHAR(10),
            translation_reason VARCHAR(40),
            app_version VARCHAR(20),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_tlog_session ON translation_log(session_id);
        CREATE INDEX IF NOT EXISTS idx_tlog_created_at ON translation_log(created_at);
    `;

    try {
        await pool.query(createTableSQL);
        logger.info('✅ Billing database schema created/verified');
        return true;
    } catch (error) {
        logger.error('❌ Failed to create database schema:', error.message);
        return false;
    }
}

/**
 * Track usage (STT, translation, or glossary)
 * @param {string} usageType - 'stt', 'translation', or 'glossary'
 * @param {number} amount - Minutes (for STT) or characters (for translation/glossary)
 * @param {string} sourceLanguage - Language code (e.g., 'ro-RO', 'en-US')
 */
async function trackUsage(usageType, amount, sourceLanguage) {
    if (!pool) {
        return false; // Database not available
    }

    const query = `
        INSERT INTO billing_usage (session_date, source_language, usage_type, amount)
        VALUES (CURRENT_DATE, $1, $2, $3)
    `;

    try {
        await pool.query(query, [sourceLanguage, usageType, amount]);
        return true;
    } catch (error) {
        console.error('Failed to track usage:', error.message);
        return false;
    }
}

/**
 * Get usage summary for a date range
 * @param {Date} startDate - Start date (inclusive)
 * @param {Date} endDate - End date (inclusive)
 * @returns {Promise<Object>} Usage summary with totals and per-language breakdown
 */
async function getUsageSummary(startDate, endDate) {
    if (!pool) {
        return {
            totals: { sttMinutes: 0, translationChars: 0, glossaryChars: 0 },
            languages: {}
        };
    }

    const query = `
        SELECT
            source_language,
            usage_type,
            SUM(amount) as total_amount
        FROM billing_usage
        WHERE session_date >= $1 AND session_date <= $2
        GROUP BY source_language, usage_type
        ORDER BY source_language, usage_type
    `;

    try {
        const result = await pool.query(query, [startDate, endDate]);

        const summary = {
            totals: {
                sttMinutes: 0,
                translationChars: 0,
                glossaryChars: 0
            },
            languages: {}
        };

        result.rows.forEach(row => {
            const lang = row.source_language;
            const type = row.usage_type;
            const amount = parseFloat(row.total_amount);

            // Initialize language entry if needed
            if (!summary.languages[lang]) {
                summary.languages[lang] = {
                    sttMinutes: 0,
                    translationChars: 0,
                    glossaryChars: 0
                };
            }

            // Update language-specific totals
            if (type === 'stt') {
                summary.languages[lang].sttMinutes += amount;
                summary.totals.sttMinutes += amount;
            } else if (type === 'translation') {
                summary.languages[lang].translationChars += amount;
                summary.totals.translationChars += amount;
            } else if (type === 'glossary') {
                summary.languages[lang].glossaryChars += amount;
                summary.totals.glossaryChars += amount;
            }
        });

        return summary;
    } catch (error) {
        console.error('Failed to get usage summary:', error.message);
        return {
            totals: { sttMinutes: 0, translationChars: 0, glossaryChars: 0 },
            languages: {}
        };
    }
}

/**
 * Get daily usage for the last N days
 * @param {number} days - Number of days to retrieve
 * @returns {Promise<Array>} Array of daily usage totals
 */
async function getDailyUsage(days = 30) {
    if (!pool) {
        return [];
    }

    const query = `
        SELECT
            session_date,
            usage_type,
            SUM(amount) as total_amount
        FROM billing_usage
        WHERE session_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY session_date, usage_type
        ORDER BY session_date DESC, usage_type
    `;

    try {
        const result = await pool.query(query);

        // Group by date
        const dailyUsage = {};
        result.rows.forEach(row => {
            const date = row.session_date.toISOString().split('T')[0];
            if (!dailyUsage[date]) {
                dailyUsage[date] = {
                    date,
                    sttMinutes: 0,
                    translationChars: 0,
                    glossaryChars: 0
                };
            }

            const amount = parseFloat(row.total_amount);
            if (row.usage_type === 'stt') {
                dailyUsage[date].sttMinutes += amount;
            } else if (row.usage_type === 'translation') {
                dailyUsage[date].translationChars += amount;
            } else if (row.usage_type === 'glossary') {
                dailyUsage[date].glossaryChars += amount;
            }
        });

        return Object.values(dailyUsage);
    } catch (error) {
        console.error('Failed to get daily usage:', error.message);
        return [];
    }
}

/**
 * Purge billing data older than specified days
 * @param {number} days - Delete data older than this many days (default: 90)
 */
async function purgeOldData(days = 90, logger) {
    if (!pool) {
        return 0;
    }

    const query = `
        DELETE FROM billing_usage
        WHERE created_at < CURRENT_DATE - INTERVAL '${days} days'
    `;

    try {
        const result = await pool.query(query);
        const deletedCount = result.rowCount;

        if (deletedCount > 0) {
            logger.info(`🗑️ Purged ${deletedCount} billing records older than ${days} days`);
        }

        return deletedCount;
    } catch (error) {
        logger.error('Failed to purge old data:', error.message);
        return 0;
    }
}

/**
 * Log a translation event for debugging and quality review.
 * Performs lazy cleanup: deletes entries older than 45 minutes before inserting,
 * and caps the table at 500 rows to stay within free-tier limits.
 *
 * @param {Object} entry - Translation event data
 * @param {string} entry.sessionId  - Unique session identifier
 * @param {string} entry.clientId   - Socket client ID
 * @param {string} entry.sourceText - Original (STT) text
 * @param {string} entry.translatedText - Translated output
 * @param {string} entry.sourceLanguage - e.g. 'ro-RO'
 * @param {string} entry.targetLanguage - e.g. 'en'
 * @param {string} entry.reason     - Decision reason ('sentence_ending', 'max_interval', …)
 * @param {string} entry.appVersion - e.g. 'v160'
 */
async function logTranslation(entry) {
    if (!pool) return false;

    try {
        // Lazy cleanup: remove entries older than 45 minutes for this session
        await pool.query(
            `DELETE FROM translation_log WHERE created_at < NOW() - INTERVAL '45 minutes'`
        );

        // Hard cap: keep only the newest 499 rows across all sessions (free-tier safety)
        await pool.query(`
            DELETE FROM translation_log WHERE id NOT IN (
                SELECT id FROM translation_log ORDER BY created_at DESC LIMIT 499
            )
        `);

        await pool.query(
            `INSERT INTO translation_log
                (session_id, client_id, source_text, translated_text,
                 source_language, target_language, translation_reason, app_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                entry.sessionId || '',
                entry.clientId || '',
                (entry.sourceText || '').substring(0, 1000),
                (entry.translatedText || '').substring(0, 1000),
                entry.sourceLanguage || '',
                entry.targetLanguage || '',
                entry.reason || '',
                entry.appVersion || ''
            ]
        );
        return true;
    } catch (error) {
        // Non-fatal — don't let logging errors break translation flow
        console.error('Failed to log translation:', error.message);
        return false;
    }
}

/**
 * Close database connection (for graceful shutdown)
 */
async function closeDatabase(logger) {
    if (pool) {
        await pool.end();
        logger.info('PostgreSQL connection pool closed');
    }
}

module.exports = {
    initializeDatabase,
    createSchema,
    trackUsage,
    getUsageSummary,
    getDailyUsage,
    purgeOldData,
    logTranslation,
    closeDatabase
};
