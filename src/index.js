const emailService    = require('./services/email.service');
const gmailRoutes     = require('./routes/gmail.routes');
const tenantGmailRoutes = require('./routes/tenant.gmail.routes');

/**
 * s3-gmail-engine Exports
 *
 * SYSTEM mode:
 *   emailService.send()              — OTP, security emails via company Gmail
 *   gmailRoutes                      — OAuth connect/callback for Super Admin
 *
 * TENANT mode (new):
 *   emailService.sendTenantEmail()   — Invoice/receipt via tenant's own Gmail
 *   emailService.getTenantGmailStatus()
 *   emailService.disconnectTenantGmail()
 *   tenantGmailRoutes                — Status + disconnect routes for host apps
 */
module.exports = {
  emailService,
  gmailRoutes,
  tenantGmailRoutes
};