const { TemplateError } = require('./errors');

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const TEMPLATE_TIMEOUT_MS = 5000; // 5 seconds

class Validator {
    /**
     * Executes a template function with a strict timeout.
     */
    static async executeWithTimeout(fn, data, tenant_id, template_key) {
        if (typeof fn !== 'function') {
            return fn; // If it's already a string/value, just return it
        }

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new TemplateError(`Template execution timed out after ${TEMPLATE_TIMEOUT_MS}ms`, tenant_id, template_key));
            }, TEMPLATE_TIMEOUT_MS);
        });

        try {
            return await Promise.race([fn({ data }), timeoutPromise]);
        } catch (error) {
            if (error instanceof TemplateError) throw error;
            throw new TemplateError(`Execution crashed: ${error.message}`, tenant_id, template_key);
        }
    }

    /**
     * Validates that the rendered HTML is a valid string.
     */
    static validateHtml(html, tenant_id, template_key) {
        if (typeof html !== 'string' || !html.trim()) {
            throw new TemplateError("Template must return a valid non-empty string", tenant_id, template_key);
        }
    }

    /**
     * Validates attachments for size, count, and type.
     */
    static validateAttachments(attachments, tenant_id, template_key) {
        if (!attachments || !Array.isArray(attachments)) return;

        if (attachments.length > MAX_ATTACHMENTS) {
            throw new TemplateError(`Maximum allowed attachments is ${MAX_ATTACHMENTS}`, tenant_id, template_key);
        }

        let totalSize = 0;
        for (const att of attachments) {
            if (!att.filename || !att.content) {
                throw new TemplateError("Attachment must have 'filename' and 'content'", tenant_id, template_key);
            }
            if (!Buffer.isBuffer(att.content)) {
                throw new TemplateError(`Attachment content for ${att.filename} must be a Buffer`, tenant_id, template_key);
            }
            totalSize += att.content.length;
        }

        if (totalSize > MAX_ATTACHMENT_SIZE_BYTES) {
            throw new TemplateError(`Total attachments size exceeds 25MB limit. Current size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`, tenant_id, template_key);
        }
    }
}

module.exports = Validator;
