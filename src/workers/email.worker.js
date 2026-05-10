const logger = require('../utils/logger').createLogger('EmailWorker');

/**
 * Processes email jobs from the queue.
 */
async function processJob(jobPayload) {
  const { 
    projectCode, tenant_id, dbConnection, 
    type, email_type, to, subject, html, attachments, 
    idempotency_key, execution_time_ms 
  } = jobPayload;

  // 1. Initialize Log Model via Factory
  require('../models/CommunicationLog.model')(dbConnection);
  const CommunicationLog = dbConnection.model('CommunicationLog');
  const gmailProvider = require('../providers/gmail.provider');

  // 2. Normalize Idempotency Key (Issue 2 from Review)
  const hasTenant = tenant_id !== undefined && tenant_id !== null && tenant_id !== "";
  const finalIdempotencyKey = `${projectCode}_${tenant_id || "noTenant"}_${idempotency_key}`;

  // 3. Strict Idempotency Check with Project Scope
  const query = hasTenant 
    ? { projectCode, tenant_id, idempotency_key: finalIdempotencyKey }
    : { projectCode, idempotency_key: finalIdempotencyKey, $or: [{ tenant_id: { $exists: false } }, { tenant_id: null }] };

  let log = await CommunicationLog.findOne(query);
  
  if (log && (log.status === 'sent' || log.status === 'failed_permanently')) {
    logger.info(`[Worker] Idempotency hit: Email ${finalIdempotencyKey} already processed.`);
    return;
  }

  if (!log) {
    log = new CommunicationLog({
      projectCode,
      tenant_id: hasTenant ? tenant_id : undefined,
      idempotency_key: finalIdempotencyKey,
      type: type || 'email',
      email_type,
      to,
      subject,
      status: 'pending',
      execution_time_ms
    });
    await log.save();
  }

  const MAX_RETRIES = 3;
  let attempt = log.retry_count;

  while (attempt < MAX_RETRIES) {
    try {
      // Attempt Send
      const result = await gmailProvider.sendEmail({
        projectCode,
        tenant_id,
        dbConnection,
        to,
        subject,
        html,
        attachments,
        type: email_type 
      });

      // Success
      log.status = 'sent';
      log.message_id = result.messageId;
      await log.save();
      return; 

    } catch (error) {
      attempt++;
      log.retry_count = attempt;
      log.error_message = error.reason || error.message;

      logger.error(`[Worker] Attempt ${attempt} failed for ${finalIdempotencyKey}:`, error.message);

      // 🔴 PERMANENT FAILURES (Issue 3): No retries for Auth/Quota issues
      if (error.isPermanent) {
        log.status = 'failed_permanently';
        await log.save();
        return;
      }

      if (attempt >= MAX_RETRIES) {
        log.status = 'failed';
        await log.save();
        return;
      }

      // Exponential Backoff (1s, 2s, 4s)
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

module.exports = { processJob };
