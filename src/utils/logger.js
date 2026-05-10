/**
 * Standard Logger for Gmail Engine
 */
const createLogger = (context) => {
    return {
        info: (msg, ...args) => console.log(`[${context}] INFO: ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[${context}] ERROR: ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[${context}] WARN: ${msg}`, ...args),
        debug: (msg, ...args) => console.debug(`[${context}] DEBUG: ${msg}`, ...args),
    };
};

module.exports = { createLogger };
