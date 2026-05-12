const NodeCache = require('node-cache');
const { encrypt, decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger').createLogger('TokenManager');

// Cache TTL 15 minutes, check every 2 minutes
const cache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// Mutex locks for ongoing refreshes to prevent race conditions (Issue 1)
const locks = new Map();

const mongoose = require('mongoose');

async function getOrInitConnection(dbConnection) {
  if (dbConnection && dbConnection.models && dbConnection.readyState === 1) return dbConnection;
  
  // Fallback to Master DB from env if connection is lost (common in workers)
  const masterUri = process.env.MASTER_DB_URI;
  if (masterUri) {
    try {
      logger.info('[GMAIL_TOKEN] 🔄 Recovering connection from MASTER_DB_URI');
      const conn = mongoose.createConnection(masterUri);
      await conn.asPromise(); // Wait for actual connection
      if (!conn.models) conn.models = {};
      return conn;
    } catch (err) {
      logger.error('[GMAIL_TOKEN] ❌ Connection recovery failed:', err.message);
    }
  }
  return dbConnection;
}

/**
 * Save or update tokens. Ensures refresh_token is not lost if Google doesn't return it.
 * [Phase 2] Context aware: handles system, shop, or owner settings.
 */
async function saveToken(projectCode, tenant_id, email, tokens, dbConnection, context = 'shop', dbType = 'SHARED') {
  const connection = await getOrInitConnection(dbConnection);
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);
  
  // SHARED DBs require tenant_id. DEDICATED/BYOD do not.
  const isShared = dbType === 'SHARED';
  const query = isShared 
      ? { projectCode, tenant_id, email, context }
      : { projectCode, email, context, $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

  let integration = await GmailIntegration.findOne(query);

  let refreshToken = tokens.refresh_token;

  if (integration) {
    if (!refreshToken && integration.refresh_token) {
      refreshToken = decrypt(integration.refresh_token);
    }
    
    integration.access_token = encrypt(tokens.access_token);
    if (refreshToken) integration.refresh_token = encrypt(refreshToken);
    integration.expiry = new Date(tokens.expiry_date || Date.now() + (tokens.expiry_in * 1000));
    integration.status = 'connected';
    integration.token_version += 1;
    integration.dbType = dbType; // Ensure dbType is stored/updated
    await integration.save();
  } else {
    integration = new GmailIntegration({
      projectCode,
      tenant_id: isShared ? tenant_id : undefined,
      email,
      context,
      dbType,
      access_token: encrypt(tokens.access_token),
      refresh_token: encrypt(refreshToken),
      expiry: new Date(tokens.expiry_date || Date.now() + (tokens.expiry_in * 1000)),
      status: 'connected',
      token_version: 1
    });
    await integration.save();
  }

  // 🔴 CACHE UPDATE (Includes context to avoid collisions)
  const cacheKey = `token:${projectCode}:${tenant_id || 'global'}:${email}:${context}`;
  cache.set(cacheKey, {
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    expiry: integration.expiry
  });

  return integration;
}

/**
 * Get valid tokens. Returns decrypted tokens.
 */
async function getToken(projectCode, tenant_id, email, dbConnection, context = 'shop', dbType = 'SHARED') {
  const cacheKey = `token:${projectCode}:${tenant_id || 'global'}:${email}:${context}`;
  
  if (locks.has(cacheKey)) {
    return locks.get(cacheKey);
  }

  const promise = (async () => {
    try {
      let tokens = cache.get(cacheKey);

      if (!tokens) {
        const connection = await getOrInitConnection(dbConnection);
        const GmailIntegration = require('../models/GmailIntegration.model')(connection);
        
        const isShared = dbType === 'SHARED';
        const query = isShared 
            ? { projectCode, tenant_id, email, context, status: 'connected' }
            : { projectCode, email, context, status: 'connected', $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

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
async function disconnectToken(projectCode, tenant_id, email, dbConnection, context = 'shop', dbType = 'SHARED') {
  const connection = await getOrInitConnection(dbConnection);
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);
  
  const isShared = dbType === 'SHARED';
  const query = isShared 
      ? { projectCode, tenant_id, email, context }
      : { projectCode, email, context, $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

  await GmailIntegration.findOneAndUpdate(query, { status: 'disconnected' });
  
  const cacheKey = `token:${projectCode}:${tenant_id || 'global'}:${email}:${context}`;
  cache.del(cacheKey);
}

module.exports = { saveToken, getToken, disconnectToken };