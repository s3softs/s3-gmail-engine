const logger = require('../utils/logger').createLogger('TenantGmailController');
const emailService = require('../services/email.service');

/**
 * Tenant Gmail Controller
 * Handles status check and disconnect for tenant Gmail integration.
 * Mounted by host apps (Medical POS, School POS) under their own auth middleware.
 *
 * Tenant ownership is enforced by the host app's auth middleware (protect + shopId from shopConfig).
 */

/**
 * GET /api/settings/gmail/status
 * Returns connection status for the current tenant's Gmail.
 * Safe — does not expose tokens.
 */
exports.getStatus = async (req, res) => {
  try {
    const projectCode = process.env.PROJECT_CODE;
    const dbType      = req.shopConfig?.dbType || 'SHARED';

    // SHARED: tenant_id comes from shopConfig (set by s3-saas-core identifyTenant)
    // DEDICATED/BYOD: tenant_id not needed — only one tenant in this DB
    const tenant_id = dbType === 'SHARED' ? req.shopConfig?.shopId : undefined;

    const status = await emailService.getTenantGmailStatus({
      dbConnection: req.db,
      projectCode,
      tenant_id,
      dbType
    });

    res.json(status);
  } catch (err) {
    logger.error('[TenantGmail] Status check failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/settings/gmail/disconnect
 * Disconnects tenant's Gmail — clears tokens from tenant DB.
 * Only the authenticated tenant can disconnect their own Gmail.
 */
exports.disconnect = async (req, res) => {
  try {
    const projectCode = process.env.PROJECT_CODE;
    const dbType      = req.shopConfig?.dbType || 'SHARED';
    const tenant_id   = dbType === 'SHARED' ? req.shopConfig?.shopId : undefined;

    const result = await emailService.disconnectTenantGmail({
      dbConnection: req.db,
      projectCode,
      tenant_id,
      dbType
    });

    res.json(result);
  } catch (err) {
    logger.error('[TenantGmail] Disconnect failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};
