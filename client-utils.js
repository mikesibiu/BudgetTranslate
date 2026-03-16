// BudgetTranslate client utilities
// Loaded before client.js

// Unicode sanitization function to prevent formatting-based attacks
// Compile regex once for performance
const SANITIZE_REGEX = /[\u202E\u202D\u202C\u200E\u200F\u200B-\u200D\uFEFF\u0000-\u001F\u007F-\u009F]/g;

function sanitizeText(text) {
    if (!text) return '';
    return text.replace(SANITIZE_REGEX, '').trim();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
