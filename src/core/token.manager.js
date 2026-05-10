const NodeCache = require('node-cache');
const { encrypt, decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger').createLogger('TokenManager');

// Cache TTL 15 minutes, check every 2 minutes
const cache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// Mutex locks for ongoing refreshes to prevent race conditions (Issue 1)
const locks = new Map();

/**
 * Save or update tokens. Ensures refresh_token is not lost if Google doesn't return it.
 */
async function saveToken(projectCode, tenant_id, email, tokens, dbConnection) {
  const GmailIntegration = require('../models/GmailIntegration.model')(dbConnection);
  
  const hasTenant = tenant_id !== undefined && tenant_id !== null && tenant_id !== "";
  const query = hasTenant 
      ? { projectCode, tenant_id, email }
      : { projectCode, email, $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

  let integration = await GmailIntegration.findOne(query);

  let refreshToken = tokens.refresh_token;

  if (integration) {
    // 🔴 GRACEFUL HANDLING: Don't overwrite existing refresh token with null
    if (!refreshToken && integration.refresh_token) {
      refreshToken = decrypt(integration.refresh_token);
    }
    
    integration.access_token = encrypt(tokens.access_token);
    if (refreshToken) integration.refresh_token = encrypt(refreshToken);
    integration.expiry = new Date(tokens.expiry_date || Date.now() + (tokens.expiry_in * 1000));
    integration.status = 'connected';
    integration.token_version += 1;
    await integration.save();
  } else {
    integration = new GmailIntegration({
      projectCode,
      tenant_id: hasTenant ? tenant_id : undefined,
      email,
      access_token: encrypt(tokens.access_token),
      refresh_token: encrypt(refreshToken),
      expiry: new Date(tokens.expiry_date || Date.now() + (tokens.expiry_in * 1000)),
      status: 'connected',
      token_version: 1
    });
    await integration.save();
  }

  // 🔴 CACHE UPDATE
  const cacheKey = `token:${projectCode}:${tenant_id || 'noTenant'}:${email}`;
  cache.set(cacheKey, {
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    expiry: integration.expiry
  });

  return integration;
}

/**
 * Get valid tokens. Returns decrypted tokens.
 * Implements locking to prevent parallel refresh race conditions.
 */
async function getToken(projectCode, tenant_id, email, dbConnection) {
  const cacheKey = `token:${projectCode}:${tenant_id || 'noTenant'}:${email}`;
  
  // 1. Check if another process is currently refreshing this specific token
  if (locks.has(cacheKey)) {
    return locks.get(cacheKey);
  }

  const promise = (async () => {
    try {
      let tokens = cache.get(cacheKey);

      if (!tokens) {
        const GmailIntegration = require('../models/GmailIntegration.model')(dbConnection);
        const hasTenant = tenant_id !== undefined && tenant_id !== null && tenant_id !== "";
        
        const query = hasTenant 
            ? { projectCode, tenant_id, email, status: 'connected' }
            : { projectCode, email, status: 'connected', $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

        const integration = await GmailIntegration.findOne(query);
        if (!integration) return null;

        tokens = {
          access_token: decrypt(integration.access_token),
          refresh_token: decrypt(integration.refresh_token),
          expiry: integration.expiry
        };
        cache.set(cacheKey, tokens);
      }

      return tokens;
    } finally {
      locks.delete(cacheKey);
    }
  })();

  locks.set(cacheKey, promise);
  return promise;
}

/**
 * Mark as disconnected and clear cache
 */
async function disconnectToken(projectCode, tenant_id, email, dbConnection) {
  const GmailIntegration = require('../models/GmailIntegration.model')(dbConnection);
  
  const hasTenant = tenant_id !== undefined && tenant_id !== null && tenant_id !== "";
  const query = hasTenant 
      ? { projectCode, tenant_id, email }
      : { projectCode, email, $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

  await GmailIntegration.findOneAndUpdate(query, { status: 'disconnected' });
  
  const cacheKey = `token:${projectCode}:${tenant_id || 'noTenant'}:${email}`;
  cache.del(cacheKey);
}

module.exports = { saveToken, getToken, disconnectToken };