// 🛡️ [SAAS ENGINE CONFIG] - Agnostic Gmail Configuration
let config = null;

/**
 * Initialize the Gmail engine with project-specific settings.
 * This prevents the library from being locked to a single .env file.
 */
const initGmailConfig = (options) => {
  if (!options || !options.clientId || !options.clientSecret || !options.redirectUri) {
    throw new Error("❌ [S3-GMAIL-ENGINE] Missing mandatory OAuth configuration (clientId, clientSecret, redirectUri).");
  }

  config = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    encryptionKey: options.encryptionKey || process.env.GMAIL_ENCRYPTION_KEY,
    systemEmail: options.systemEmail || process.env.GMAIL_SYSTEM_EMAIL
  };

  if (!config.encryptionKey) {
    throw new Error("❌ [S3-GMAIL-ENGINE] encryptionKey is required for token security.");
  }

  console.log(`✅ [Gmail Engine] Initialized for ${config.redirectUri}`);
  return config;
};

const getConfig = () => {
  if (!config) {
    // Fallback for legacy support (will be removed in v3)
    if (process.env.GMAIL_CLIENT_ID) {
        return initGmailConfig({
            clientId: process.env.GMAIL_CLIENT_ID,
            clientSecret: process.env.GMAIL_CLIENT_SECRET,
            redirectUri: process.env.GMAIL_REDIRECT_URI,
            encryptionKey: process.env.GMAIL_ENCRYPTION_KEY,
            systemEmail: process.env.GMAIL_SYSTEM_EMAIL
        });
    }
    throw new Error("❌ [S3-GMAIL-ENGINE] Engine not initialized. Call initGmailConfig() first.");
  }
  return config;
};

module.exports = {
  initGmailConfig,
  getConfig,
  // Proxy properties for backward compatibility
  get clientId() { return getConfig().clientId; },
  get clientSecret() { return getConfig().clientSecret; },
  get redirectUri() { return getConfig().redirectUri; },
  get encryptionKey() { return getConfig().encryptionKey; },
  get systemEmail() { return getConfig().systemEmail; }
};