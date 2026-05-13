const express = require('express');
const router = express.Router();
const controller = require('../controllers/tenant.gmail.controller');

/**
 * Tenant Gmail Routes
 *
 * Mount in host app BEHIND authentication middleware:
 *   const { tenantGmailRoutes } = require('s3-gmail-engine');
 *   app.use('/api/settings/gmail', authenticate, tenantGmailRoutes);
 *
 * GET  /status      — Check if tenant Gmail is connected
 * POST /disconnect  — Disconnect tenant Gmail
 *
 * Note: The connect flow is handled by Super Admin's /api/gmail/tenant-connect
 *       (OAuth must go through Super Admin since that's the registered redirect URI)
 */
router.get('/status',     controller.getStatus);
router.post('/disconnect', controller.disconnect);

module.exports = router;
