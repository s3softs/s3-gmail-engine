const queueService = require('../queue/queue.service');
const crypto = require('crypto');
const Validator = require('../core/Validator');
const logger = require('../utils/logger').createLogger('EmailService');

const MAX_GMAIL_SIZE = 25 * 1024 * 1024; // 25MB
const SAFE_BUFFER_LIMIT = MAX_GMAIL_SIZE * 0.75; // ~18.75MB to allow for Base64 overhead

/**
 * Unified service entry point.
 * Executes caller-provided templates safely before pushing to queue.
 */
async function send(config) {
  const { 
    projectCode, dbConnection, // New required params
    tenant_id, type, to, data, subject, template, attachments 
  } = config;

  if (!projectCode || !dbConnection || !to || !subject || !template) {
    throw new Error("Missing required fields: projectCode, dbConnection, to, subject, template");
  }

  const idempotency_key = config.idempotency_key || crypto.randomUUID();
  const startTime = Date.now();

  try {
    // 1. Resolve Subject
    const resolvedSubject = await Validator.executeWithTimeout(subject, data, tenant_id, type);

    // 2. Resolve HTML Body
    const resolvedHtml = await Validator.executeWithTimeout(template, data, tenant_id, type);
    Validator.validateHtml(resolvedHtml, tenant_id, type);

    // 3. Resolve Attachments sequentially to control concurrency
    let resolvedAttachments = [];
    let totalSize = 0;
    
    if (attachments && Array.isArray(attachments)) {
        for (const att of attachments) {
            const filename = await Validator.executeWithTimeout(att.filename, data, tenant_id, type);
            const content = await Validator.executeWithTimeout(att.content, data, tenant_id, type);
            
            if (!Buffer.isBuffer(content)) {
                throw new Error(`Attachment ${filename} content must be a Buffer`);
            }
            
            totalSize += content.length;
            resolvedAttachments.push({ filename, content, mimetype: att.mimetype });
        }
    }

    // 🔴 ATTACHMENT GUARDRAIL (Issue 3 from review)
    if (totalSize > SAFE_BUFFER_LIMIT) {
        throw new Error(`Total attachment size (${(totalSize/1024/1024).toFixed(2)}MB) exceeds safe Gmail limit after Base64 encoding.`);
    }

    Validator.validateAttachments(resolvedAttachments, tenant_id, type);

    const execution_time_ms = Date.now() - startTime;

    // 4. Push to Queue (including DB connection for worker)
    await queueService.add({
        projectCode,
        dbConnection,
        tenant_id,
        email_type: type || 'invoice',
        to,
        subject: resolvedSubject,
        html: resolvedHtml,
        attachments: resolvedAttachments,
        idempotency_key,
        execution_time_ms 
    });

    return { 
        success: true, 
        idempotency_key, 
        execution_time_ms,
        message: "Templates resolved successfully. Queued for sending." 
    };

  } catch (error) {
      logger.error(`[EmailService] Failed to queue message for ${tenant_id || 'SYSTEM'}:`, error.message);
      throw error; 
  }
}

async function getStatus({ dbConnection, tenant_id, context = 'owner' }) {
    if (!dbConnection) throw new Error("dbConnection is required to check status");

    try {
        const GmailIntegration = dbConnection.model('GmailIntegration');
        const query = context === 'system' ? { context: 'system' } : { tenant_id, context };
        
        const integration = await GmailIntegration.findOne(query);
        
        if (!integration) return { connected: false };

        return {
            connected: true,
            email: integration.email,
            type: integration.type,
            context: integration.context,
            updatedAt: integration.updatedAt
        };
    } catch (error) {
        logger.error(`[EmailService] Failed to get status:`, error.message);
        return { connected: false, error: error.message };
    }
}

async function saveSmtpConfig({ dbConnection, tenant_id, email, appPassword, context = 'owner' }) {
    if (!dbConnection) throw new Error("dbConnection is required");
    
    try {
        const Token = dbConnection.model('Token');
        await Token.findOneAndUpdate(
            { tenant_id, context, type: 'smtp' },
            { 
                email, 
                tokens: { appPassword },
                isActive: true
            },
            { upsert: true, new: true }
        );
        return { success: true, message: 'SMTP configuration saved' };
    } catch (error) {
        logger.error(`[EmailService] Failed to save SMTP config:`, error.message);
        throw error;
    }
}

async function disconnect({ dbConnection, tenant_id, context = 'owner' }) {
    if (!dbConnection) throw new Error("dbConnection is required");

    try {
        const Token = dbConnection.model('Token');
        const query = context === 'system' ? { context: 'system' } : { tenant_id, context };
        
        await Token.deleteMany({ 
            ...query,
            type: { $in: ['gmail', 'smtp'] } 
        });
        
        return { success: true, message: 'Email disconnected' };
    } catch (error) {
        logger.error(`[EmailService] Failed to disconnect:`, error.message);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Tenant Email Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send email strictly via tenant's own Gmail (TENANT mode).
 *
 * SHARED (Medical POS): pass tenant_id (shopId)
 * DEDICATED/BYOD (School POS): tenant_id optional — not required
 *
 * Throws a clear error if tenant Gmail is not connected (no silent fallback).
 */
async function sendTenantEmail(config) {
  const { 
    projectCode, dbConnection, 
    tenant_id, dbType = 'SHARED',
    type, to, data, subject, template, attachments 
  } = config;

  if (!projectCode || !dbConnection || !to || !subject || !template) {
    throw new Error("Missing required fields: projectCode, dbConnection, to, subject, template");
  }

  const idempotency_key = config.idempotency_key || crypto.randomUUID();
  const startTime = Date.now();

  try {
    const resolvedSubject = await Validator.executeWithTimeout(subject, data, tenant_id, type);
    const resolvedHtml    = await Validator.executeWithTimeout(template, data, tenant_id, type);
    Validator.validateHtml(resolvedHtml, tenant_id, type);

    let resolvedAttachments = [];
    let totalSize = 0;

    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        const filename = await Validator.executeWithTimeout(att.filename, data, tenant_id, type);
        const content  = await Validator.executeWithTimeout(att.content,  data, tenant_id, type);
        if (!Buffer.isBuffer(content)) throw new Error(`Attachment ${filename} content must be a Buffer`);
        totalSize += content.length;
        resolvedAttachments.push({ filename, content, mimetype: att.mimetype });
      }
    }

    if (totalSize > SAFE_BUFFER_LIMIT) {
      throw new Error(`Total attachment size exceeds safe Gmail limit after Base64 encoding.`);
    }

    Validator.validateAttachments(resolvedAttachments, tenant_id, type);

    const execution_time_ms = Date.now() - startTime;

    // Push to queue — mode:'TENANT' tells worker to use sendTenantEmail() in provider
    await queueService.add({
      projectCode,
      dbConnection,
      tenant_id,
      dbType,
      mode: 'TENANT',                        // ← key field for worker routing
      email_type: type || 'transactional',
      to,
      subject: resolvedSubject,
      html:    resolvedHtml,
      attachments: resolvedAttachments,
      idempotency_key,
      execution_time_ms
    });

    return { 
      success: true, 
      idempotency_key, 
      execution_time_ms,
      message: "Tenant email queued for sending." 
    };
  } catch (error) {
    logger.error(`[TenantMailer] Failed to queue for ${tenant_id || 'DEDICATED'}:`, error.message);
    throw error;
  }
}

/**
 * Check if tenant Gmail is connected.
 * Safe for UI display — does not decrypt or expose tokens.
 */
async function getTenantGmailStatus({ dbConnection, projectCode, tenant_id, dbType = 'SHARED' }) {
  if (!dbConnection) throw new Error("dbConnection is required");
  const { getTenantStatus } = require('../core/token.manager');
  return await getTenantStatus({ dbConnection, projectCode, tenant_id, dbType });
}

/**
 * Disconnect tenant Gmail.
 * Clears access_token + refresh_token. Status set to 'disconnected'.
 */
async function disconnectTenantGmail({ dbConnection, projectCode, tenant_id, dbType = 'SHARED' }) {
  if (!dbConnection) throw new Error("dbConnection is required");
  const { disconnectTenantToken } = require('../core/token.manager');
  const result = await disconnectTenantToken({ dbConnection, projectCode, tenant_id, dbType });
  return { success: true, message: 'Tenant Gmail disconnected successfully.' };
}

module.exports = { 
  // Existing (SYSTEM/AUTO mode — DO NOT TOUCH)
  send, getStatus, saveSmtpConfig, disconnect,
  // New (TENANT mode)
  sendTenantEmail, getTenantGmailStatus, disconnectTenantGmail
};