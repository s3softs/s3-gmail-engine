const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { createClient } = require('../core/gmail.client');
const { getToken, saveToken } = require('../core/token.manager');
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

/**
 * Sends an email using Gmail API (OAuth2) OR Nodemailer (SMTP/App Password Fallback).
 */
async function sendEmail({ projectCode, tenant_id, dbConnection, to, subject, html, attachments, type }) {
  const isSystem = (type === 'system' || type === 'otp');
  const systemEmail = process.env.GMAIL_SYSTEM_EMAIL;
  const appPassword = process.env.GMAIL_APP_PASSWORD;

  // 🟢 HYBRID MODE: If system email + App Password provided, use SMTP (Easier for testing)
  if (isSystem && appPassword) {
    logger.info(`[SMTP] Sending system email to ${to} using App Password fallback`);
    
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: systemEmail,
        pass: appPassword
      }
    });

    const mailOptions = {
      from: `"${process.env.PROJECT_CODE || 'Medical POS'}" <${systemEmail}>`,
      to,
      subject,
      html,
      attachments: attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        contentType: att.mimetype
      }))
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId, provider: 'smtp' };
  }

  // 🔴 ENTERPRISE MODE: OAuth2 (Requires Client ID & Refresh Token)
  logger.info(`[OAuth2] Sending email to ${to} for tenant ${tenant_id || 'SYSTEM'}`);
  const activeTenantId = isSystem ? 'SYSTEM' : tenant_id;
  
  const tokens = await getToken(projectCode, activeTenantId, isSystem ? systemEmail : undefined, dbConnection);

  if (!tokens) {
    throw new Error(`Gmail not connected for tenant: ${activeTenantId}. Please configure OAuth or GMAIL_APP_PASSWORD.`);
  }

  const client = createClient();
  client.setCredentials(tokens);

  client.on('tokens', async (newTokens) => {
      logger.info(`Token automatically refreshed by Google for ${activeTenantId}`);
      await saveToken(projectCode, activeTenantId, isSystem ? systemEmail : undefined, newTokens, dbConnection);
  });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const finalSubject = (!isSystem) ? `[S3SOFTS_INVOICE] ${subject}` : subject;

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
    return { success: true, messageId: res.data.id, provider: 'oauth2' };
  } catch (error) {
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('invalid_grant') || error.code === 401) {
        error.isPermanent = true;
        error.reason = "Authentication failed (Refresh Token invalid).";
    } else if (errorMsg.includes('quotaexceeded') || error.code === 403) {
        error.isPermanent = true;
        error.reason = "Daily quota exceeded.";
    } else if (error.code === 429 || error.code >= 500) {
        error.isPermanent = false;
    } else {
        error.isPermanent = true;
    }
    throw error;
  }
}

module.exports = { sendEmail };