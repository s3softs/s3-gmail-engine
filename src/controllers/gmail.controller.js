const { createClient } = require('../core/gmail.client');
const { saveToken, saveTenantToken } = require('../core/token.manager');
const { encrypt, decrypt } = require('../utils/encrypt');
const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING: SYSTEM connect (unchanged — used by Super Admin for company Gmail)
// ─────────────────────────────────────────────────────────────────────────────

exports.connect = (req, res) => {
  const { tenant_id, context = 'shop', dbType = 'SHARED' } = req.query;
  
  if (!tenant_id) {
    return res.status(400).send("tenant_id is required");
  }

  const client = createClient();

  const stateObj = {
    mode: 'SYSTEM',
    tenant_id,
    context,
    dbType,
    timestamp: Date.now()
  };
  const state = encrypt(JSON.stringify(stateObj));

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', 
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid'
    ],
    state: state
  });

  res.redirect(url);
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW: TENANT connect — initiated by host app on behalf of a tenant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiate OAuth for a tenant's own Gmail.
 *
 * Required query params:
 *   - projectCode  e.g. 'med_pos'
 *   - tenantId     e.g. 'SHOP001' (shopId in Medical POS)
 *   - dbType       'SHARED' | 'DEDICATED' | 'BYOD'
 *
 * Security: NO dbUri in state — only identifiers.
 * The host app's resolveDbConnection() is called in the callback to get the actual DB.
 */
exports.tenantConnect = (req, res) => {
  const { tenantId, projectCode, dbType = 'SHARED', redirectBack } = req.query;

  if (!projectCode) {
    return res.status(400).send("projectCode is required");
  }
  // For SHARED mode, tenantId is required to scope the token correctly
  if (dbType === 'SHARED' && !tenantId) {
    return res.status(400).send("tenantId is required for SHARED database mode");
  }

  const client = createClient();

  // State contains ONLY identifiers — no secrets, no DB URIs
  const stateObj = {
    mode: 'TENANT',
    tenantId,        // will be used for SHARED mode token scoping
    projectCode,
    dbType,
    redirectBack,    // seamless return URL to the calling SaaS application
    timestamp: Date.now()
  };
  const state = encrypt(JSON.stringify(stateObj));

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid'
    ],
    state
  });

  res.redirect(url);
};

// ─────────────────────────────────────────────────────────────────────────────
// EXTENDED: callback — handles both SYSTEM and TENANT modes via state.mode
// Existing SYSTEM logic is completely preserved.
// ─────────────────────────────────────────────────────────────────────────────

exports.callback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!state) {
      return res.status(400).send("Invalid request: State missing");
    }

    // Decrypt and validate state
    const decryptedState = decrypt(state);
    const stateObj = JSON.parse(decryptedState);

    const { mode, tenant_id, tenantId, context, dbType, projectCode: stateProjectCode, redirectBack, timestamp } = stateObj;

    // Validate timestamp (10 mins expiry)
    if (Date.now() - timestamp > (10 * 60 * 1000)) {
      return res.status(400).send("Auth session expired. Please try again.");
    }

    const client = createClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user email from Google
    const oauth2 = google.oauth2({ auth: client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // ── TENANT mode ────────────────────────────────────────────────────────
    if (mode === 'TENANT') {
      // The host application MUST inject req.resolveDbConnection
      // This keeps the library agnostic of how DB connections are resolved
      const resolveDbConnection = req.resolveDbConnection;

      if (!resolveDbConnection) {
        console.error('[GmailCallback] ❌ resolveDbConnection not injected by host app.');
        return res.status(500).send(
          "Server configuration error: resolveDbConnection not available. " +
          "Please contact the system administrator."
        );
      }

      // Resolve the tenant's DB connection via host app resolver
      // Host app uses s3-saas-core's dbManager to look up TenantConfig
      const tenantDb = await resolveDbConnection({
        projectCode: stateProjectCode,
        tenantId,
        dbType
      });

      if (!tenantDb) {
        return res.status(404).send("Tenant database not found. Please check your configuration.");
      }

      // Save token to TENANT DB — not to Master DB
      await saveTenantToken({
        dbConnection: tenantDb,
        projectCode:  stateProjectCode,
        tenant_id:    dbType === 'SHARED' ? tenantId : undefined, // Only for SHARED
        email,
        tokens,
        dbType
      });

      console.log(`[GmailCallback] ✅ Tenant Gmail connected: ${email} (${stateProjectCode}, ${dbType})`);
      
      const redirectScript = redirectBack 
        ? `<script>setTimeout(() => { window.location.href = "${redirectBack}"; }, 1500);</script>`
        : '';

      return res.send(
        `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h2>✅ Gmail Connected!</h2>
          <p><b>${email}</b> has been connected successfully.</p>
          ${redirectBack ? `<p>Redirecting you back to the application settings...</p>` : `<p>You can close this window and return to the application.</p>`}
          ${redirectScript}
        </body></html>`
      );
    }

    // ── SYSTEM mode (Existing logic — UNTOUCHED) ───────────────────────────
    const finalProjectCode = stateProjectCode || process.env.PROJECT_CODE || 'PLATFORM';
    const finalTenantId    = tenant_id || 'PLATFORM_SYSTEM';
    const finalContext     = context   || 'shop';
    const finalDbType      = dbType    || 'SHARED';

    await saveToken(finalProjectCode, finalTenantId, email, tokens, req.db, finalContext, finalDbType);

    console.log(`[GmailCallback] ✅ System Gmail connected: ${email} as ${finalContext}`);
    res.send(`Gmail connected successfully for ${email} as ${finalContext}. You can close this window.`);

  } catch (error) {
    console.error("OAuth Callback Error:", error);
    res.status(500).send("Failed to connect Gmail: " + error.message);
  }
};