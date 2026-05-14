const NodeCache = require('node-cache');
const { encrypt, decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger').createLogger('TokenManager');

// Cache TTL 15 minutes, check every 2 minutes
const cache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// Mutex locks for ongoing refreshes to prevent race conditions
const locks = new Map();

const mongoose = require('mongoose');

// 🔐 [SECURITY LOG] Verify encryption key availability on startup
logger.info('[Crypto] Gmail encryption key status:', !!process.env.GMAIL_ENCRYPTION_KEY ? 'LOADED' : 'MISSING');

async function getOrInitConnection(dbConnection) {
  if (dbConnection && dbConnection.models && dbConnection.readyState === 1) return dbConnection;
  
  // Fallback to Master DB from env if connection is lost (common in workers)
  const masterUri = process.env.MASTER_DB_URI;
  if (masterUri) {
    try {
      logger.info('[GMAIL_TOKEN] 🔄 Recovering connection from MASTER_DB_URI');
      const conn = mongoose.createConnection(masterUri);
      await conn.asPromise();
      if (!conn.models) conn.models = {};
      return conn;
    } catch (err) {
      logger.error('[GMAIL_TOKEN] ❌ Connection recovery failed:', err.message);
    }
  }
  return dbConnection;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING SYSTEM FUNCTIONS — DO NOT MODIFY (OTP flow depends on these)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save or update tokens. Ensures refresh_token is not lost if Google doesn't return it.
 * [Phase 2] Context aware: handles system, shop, or owner settings.
 */
async function saveToken(projectCode, tenant_id, email, tokens, dbConnection, context = 'shop', dbType = 'SHARED') {
  // 🛡️ [CRITICAL] Auto-resolve Master DB for System tokens
  let connection = dbConnection;
  if (tenant_id === 'PLATFORM_SYSTEM' && process.env.MASTER_DB_URI) {
    const mongoose = require('mongoose');
    // Use existing connection if it's already master, or create/reuse one
    if (connection?.name !== 'master_db') {
       connection = await getOrInitConnection(null); 
    }
  } else {
    connection = await getOrInitConnection(dbConnection);
  }
  
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);
  
  const isShared = dbType === 'SHARED';
  const isSystem = tenant_id === 'PLATFORM_SYSTEM' || context === 'system';
  const accountType = isSystem ? 'SYSTEM' : 'TENANT';

  const query = isShared 
      ? { projectCode, tenant_id, email, status: 'connected' }
      : { projectCode, email, status: 'connected', $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };
  
  // Also support account_type or context for backward compatibility
  query.$or = [
    { account_type: accountType },
    { context: context }
  ];

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
    integration.dbType = dbType;
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
        // 🛡️ [CRITICAL] Auto-resolve Master DB for System tokens
        let connection = dbConnection;
        if (tenant_id === 'PLATFORM_SYSTEM' && process.env.MASTER_DB_URI) {
          const mongoose = require('mongoose');
          if (connection?.name !== 'master_db') {
             connection = await getOrInitConnection(null); // This forces use of MASTER_DB_URI
          }
        } else {
          connection = await getOrInitConnection(dbConnection);
        }

        const GmailIntegration = require('../models/GmailIntegration.model')(connection);
        
        const isSystem = tenant_id === 'PLATFORM_SYSTEM' || context === 'system';
        
        let query;
        if (isSystem) {
          // 🛡️ LOCKED REQUIREMENT: Strict Global SYSTEM Token Resolution
          query = {
            tenant_id: 'PLATFORM_SYSTEM',
            projectCode: 'PLATFORM',
            account_type: 'SYSTEM',
            status: 'connected'
          };
          logger.info('[OAuth2] Executing SYSTEM fallback query:', query);
        } else {
          const isShared = dbType === 'SHARED';
          query = isShared 
              ? { projectCode, tenant_id, email, context, status: 'connected' }
              : { projectCode, email, context, status: 'connected', $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };
        }

        const integration = await GmailIntegration.findOne(query);
        if (isSystem) {
          logger.info('[OAuth2] SYSTEM token found:', !!integration);
          if (integration) logger.info('[OAuth2] Resolved Email:', integration.email);
        }
        if (!integration) return null;

        tokens = {
          access_token: decrypt(integration.access_token),
          refresh_token: decrypt(integration.refresh_token),
          expiry: integration.expiry,
          email: integration.email
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

// ─────────────────────────────────────────────────────────────────────────────
// TENANT-SPECIFIC FUNCTIONS — New additions, existing functions above UNTOUCHED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save Tenant Gmail Token.
 *
 * SHARED  (Medical POS):  tenant_id required → token stored per-tenant in shared DB
 * DEDICATED (School POS): tenant_id ignored  → token stored in tenant's own DB (only one tenant)
 * BYOD:                   tenant_id ignored  → token stored in customer's DB
 *
 * @param {object} params
 * @param {object} params.dbConnection  Tenant DB connection (resolved by host app)
 * @param {string} params.projectCode   e.g. 'med_pos'
 * @param {string} [params.tenant_id]   Required only for SHARED dbType
 * @param {string} params.email         Gmail address being connected
 * @param {object} params.tokens        OAuth token object from Google
 * @param {string} params.dbType        'SHARED' | 'DEDICATED' | 'BYOD'
 */
async function saveTenantToken({ dbConnection, projectCode, tenant_id, email, tokens, dbType = 'SHARED' }) {
  const connection = await getOrInitConnection(dbConnection);
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);

  const isShared = dbType === 'SHARED';

  // SHARED: scope by tenant_id; DEDICATED/BYOD: no tenant_id filter needed
  const query = isShared
    ? { projectCode, tenant_id, account_type: 'TENANT' }
    : { projectCode, account_type: 'TENANT', $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

  let integration = await GmailIntegration.findOne(query);
  let refreshToken = tokens.refresh_token;

  if (integration) {
    // Preserve existing refresh_token if Google did not return a new one
    if (!refreshToken && integration.refresh_token) {
      refreshToken = decrypt(integration.refresh_token);
    }
    integration.access_token  = encrypt(tokens.access_token);
    if (refreshToken) integration.refresh_token = encrypt(refreshToken);
    integration.expiry         = new Date(tokens.expiry_date || Date.now() + ((tokens.expires_in || 3600) * 1000));
    integration.status         = 'connected';
    integration.token_version += 1;
    integration.email          = email;
    await integration.save();
  } else {
    integration = new GmailIntegration({
      projectCode,
      tenant_id:    isShared ? tenant_id : undefined,
      email,
      account_type: 'TENANT',
      context:      'tenant',
      dbType,
      access_token:  encrypt(tokens.access_token),
      refresh_token: encrypt(refreshToken),
      expiry:        new Date(tokens.expiry_date || Date.now() + ((tokens.expires_in || 3600) * 1000)),
      status:        'connected',
      token_version: 1
    });
    await integration.save();
  }

  // Cache with TENANT-specific key namespace to avoid collisions with SYSTEM tokens
  const cacheKey = `tenant_token:${projectCode}:${tenant_id || 'dedicated'}`;
  cache.set(cacheKey, {
    access_token:  tokens.access_token,
    refresh_token: refreshToken,
    expiry:        integration.expiry,
    email
  });

  logger.info(`[TenantToken] ✅ Saved for ${email} (${dbType}, project: ${projectCode})`);
  return integration;
}

/**
 * Get Tenant Gmail Token.
 *
 * SHARED:           Looks up by projectCode + tenant_id + account_type:'TENANT'
 * DEDICATED / BYOD: Looks up by projectCode + account_type:'TENANT' only (no tenant_id filter)
 *
 * @returns {{ access_token, refresh_token, expiry, email } | null}
 */
async function getTenantToken({ dbConnection, projectCode, tenant_id, dbType = 'SHARED' }) {
  const isShared = dbType === 'SHARED';
  const cacheKey = `tenant_token:${projectCode}:${tenant_id || 'dedicated'}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const connection = await getOrInitConnection(dbConnection);
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);

  const query = {
    projectCode,
    account_type: 'TENANT',
    status: 'connected'
  };

  if (isShared) {
    if (!tenant_id) {
      logger.warn(`[TenantToken] ⚠️  SHARED mode requires tenant_id. Got none.`);
      return null;
    }
    query.tenant_id = tenant_id;
  }
  // DEDICATED / BYOD: no tenant_id filter — only one tenant exists in this DB

  const integration = await GmailIntegration.findOne(query);
  if (!integration) return null;

  const tokenData = {
    access_token:  decrypt(integration.access_token),
    refresh_token: decrypt(integration.refresh_token),
    expiry:        integration.expiry,
    email:         integration.email
  };

  cache.set(cacheKey, tokenData);
  return tokenData;
}

/**
 * Disconnect Tenant Gmail.
 * Clears tokens (access + refresh) and marks status as 'disconnected'.
 */
async function disconnectTenantToken({ dbConnection, projectCode, tenant_id, dbType = 'SHARED' }) {
  const connection = await getOrInitConnection(dbConnection);
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);

  const isShared = dbType === 'SHARED';
  const query = { projectCode, account_type: 'TENANT' };
  if (isShared) query.tenant_id = tenant_id;

  const result = await GmailIntegration.findOneAndUpdate(
    query,
    { $set: { status: 'disconnected', access_token: null, refresh_token: null } },
    { new: true }
  );

  // Clear cache
  const cacheKey = `tenant_token:${projectCode}:${tenant_id || 'dedicated'}`;
  cache.del(cacheKey);

  logger.info(`[TenantToken] 🔌 Disconnected — project: ${projectCode}, tenant: ${tenant_id || 'DEDICATED'}`);
  return result;
}

/**
 * Get Tenant Gmail connection status (without decrypting tokens — safe for UI display).
 */
async function getTenantStatus({ dbConnection, projectCode, tenant_id, dbType = 'SHARED' }) {
  const connection = await getOrInitConnection(dbConnection);
  const GmailIntegration = require('../models/GmailIntegration.model')(connection);

  const isShared = dbType === 'SHARED';
  const query = { projectCode, account_type: 'TENANT' };
  if (isShared) query.tenant_id = tenant_id;

  const integration = await GmailIntegration.findOne(query);
  if (!integration) return { connected: false };

  return {
    connected:   integration.status === 'connected',
    email:       integration.email,
    status:      integration.status,
    connectedAt: integration.updatedAt
  };
}

module.exports = { 
  // Existing (SYSTEM mode — DO NOT TOUCH)
  saveToken, 
  getToken, 
  disconnectToken,
  // New (TENANT mode)
  saveTenantToken,
  getTenantToken,
  disconnectTenantToken,
  getTenantStatus
};