const { google } = require('googleapis');
const { createClient } = require('../core/gmail.client');
const { getToken, saveToken, getTenantToken, saveTenantToken } = require('../core/token.manager');
const logger = require('../utils/logger').createLogger('GmailProvider');

/**
 * Builds a multipart/mixed MIME email message to support attachments (OAuth2 Mode).
 */
function buildMimeMessage(to, subject, html, attachments = []) {
  const boundary = '==Multipart_Boundary_x' + Math.random().toString(16) + 'x';

  let message = [
    `To: ${to}`,
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    '--' + boundary,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    ''
  ];

  if (attachments && attachments.length > 0) {
    for (const file of attachments) {
      message.push('--' + boundary);
      message.push(`Content-Type: ${file.mimetype || 'application/pdf'}; name="${file.filename}"`);
      message.push('Content-Disposition: attachment; filename="' + file.filename + '"');
      message.push('Content-Transfer-Encoding: base64');
      message.push('');
      message.push(file.content.toString('base64'));
      message.push('');
    }
  }

  message.push('--' + boundary + '--');
  return message.join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING sendEmail() — SYSTEM mode + AUTO fallback
// DO NOT MODIFY — OTP forgot password flow depends on this exact function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends an email using Gmail API (OAuth2) with Priority Fallback logic:
 * 1. Owner OAuth
 * 2. Shop OAuth
 * 3. System OAuth (Master DB)
 */
async function sendEmail({ 
  projectCode, 
  tenant_id, 
  dbConnection, 
  dbType = 'SHARED', 
  to, 
  subject, 
  html, 
  attachments, 
  type,
  ownerEmail,
  shopEmail,
  context
}) {
  const isSystem = (type === 'system' || type === 'otp' || context === 'system');
  const systemEmail = process.env.GMAIL_SYSTEM_EMAIL;

  // ── PRIORITY 1 & 2: Tenant Level (Owner or Shop) ──────────────────────────
  if (!isSystem) {
    const priorityList = [
      { context: 'owner', email: ownerEmail },
      { context: 'shop',  email: shopEmail }
    ];

    for (const target of priorityList) {
      if (!target.email) continue;
      
      logger.info(`[OAuth2] Attempting to send from ${target.context}: ${target.email}`);
      const tokens = await getToken(projectCode, tenant_id, target.email, dbConnection, target.context, dbType);
      
      if (tokens) {
        try {
          return await sendViaOAuth2(tokens, { to, subject, html, attachments, projectCode, tenant_id, email: target.email, dbConnection, context: target.context, dbType });
        } catch (err) {
          logger.warn(`[OAuth2] Failed for ${target.context}: ${err.message}. Moving to next priority.`);
        }
      }
    }
  }

  // ── PRIORITY 3: System Level (Master DB Fallback) ─────────────────────────
  logger.info(`[OAuth2] Using System Fallback: ${systemEmail}`);
  
  const masterDb = dbConnection.app?.get('masterDb') || dbConnection;
  
  let tokens = await getToken(projectCode, 'PLATFORM_SYSTEM', systemEmail, masterDb, 'system', 'SHARED');
  
  if (!tokens) {
    logger.info(`[OAuth2] System token not found in ${projectCode}. Trying 'PLATFORM' project code with legacy context.`);
    tokens = await getToken('PLATFORM', 'PLATFORM_SYSTEM', systemEmail, masterDb, 'shop', 'SHARED');
  }

  if (!tokens) {
    throw new Error(`Gmail not connected for PLATFORM_SYSTEM. Please configure in Super Admin.`);
  }

  return await sendViaOAuth2(tokens, { 
    to, subject, html, attachments, 
    projectCode: 'PLATFORM', 
    tenant_id: 'PLATFORM_SYSTEM', 
    email: tokens.email || systemEmail, 
    dbConnection: masterDb, 
    context: 'system', 
    dbType: 'SHARED' 
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW sendTenantEmail() — Explicit TENANT mode only
// Strict: no fallback to company Gmail. Throws clear error if not connected.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends email strictly via the tenant's own connected Gmail account.
 *
 * SHARED (Medical POS):     Looks up token by projectCode + tenant_id
 * DEDICATED/BYOD (School):  Looks up token by projectCode only (no tenant_id needed)
 *
 * @param {object} params
 * @param {string} params.projectCode
 * @param {string} [params.tenant_id]   Required only for SHARED mode
 * @param {object} params.dbConnection  Tenant DB connection (resolved by host app)
 * @param {string} params.dbType        'SHARED' | 'DEDICATED' | 'BYOD'
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {Array}  [params.attachments]
 */
async function sendTenantEmail({ projectCode, tenant_id, dbConnection, dbType = 'SHARED', to, subject, html, attachments }) {
  const tokenData = await getTenantToken({ dbConnection, projectCode, tenant_id, dbType });

  if (!tokenData) {
    // Clear, actionable error — no silent fallback to company Gmail
    throw new Error(
      'Tenant Gmail is not connected. ' +
      'Please connect your Gmail account from Settings > Email Integration.'
    );
  }

  const client = createClient();
  client.setCredentials(tokenData);

  // Auto-save refreshed tokens back to tenant DB
  client.on('tokens', async (newTokens) => {
    logger.info(`[TenantOAuth2] Token refreshed for tenant: ${tenant_id || 'DEDICATED'}`);
    await saveTenantToken({
      dbConnection,
      projectCode,
      tenant_id,
      email: tokenData.email,
      tokens: newTokens,
      dbType
    });
  });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const mimeMessage = buildMimeMessage(to, subject, html, attachments);

  const encodedMessage = Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });
    logger.info(`[TenantOAuth2] Sent from ${tokenData.email} to ${to}`);
    return { success: true, messageId: res.data.id, provider: 'oauth2', from: tokenData.email, mode: 'TENANT' };
  } catch (error) {
    error.isPermanent = !(error.code === 429 || error.code >= 500);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE helper — used internally by sendEmail()
// ─────────────────────────────────────────────────────────────────────────────

async function sendViaOAuth2(tokens, params) {
  const { to, subject, html, attachments, projectCode, tenant_id, email, dbConnection, context, dbType } = params;
  
  const client = createClient();
  client.setCredentials(tokens);

  client.on('tokens', async (newTokens) => {
    logger.info(`Token automatically refreshed by Google for ${email} (${context})`);
    await saveToken(projectCode, tenant_id, email, newTokens, dbConnection, context, dbType);
  });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const finalSubject = (context === 'shop' || context === 'owner') ? `[S3SOFTS_INVOICE] ${subject}` : subject;

  const mimeMessage = buildMimeMessage(to, finalSubject, html, attachments);
  
  const encodedMessage = Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });
    return { success: true, messageId: res.data.id, provider: 'oauth2', from: email, context };
  } catch (error) {
    error.isPermanent = !(error.code === 429 || error.code >= 500);
    throw error;
  }
}

module.exports = { sendEmail, sendTenantEmail };