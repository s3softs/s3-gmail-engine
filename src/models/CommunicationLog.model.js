/**
 * CommunicationLog Model Factory
 */
module.exports = (connection) => {
    if (connection.models.CommunicationLog) {
        return connection.models.CommunicationLog;
    }

    const { Schema } = require('mongoose');

    const CommunicationLogSchema = new Schema({
        tenant_id: { type: String, required: false }, // Optional for Dedicated/BYOD
        projectCode: { type: String, required: true },
        idempotency_key: { type: String, required: true }, // Normalized to project_tenant_key
        type: { type: String, required: true, default: 'email' },
        email_type: { type: String, required: true }, // e.g., 'invoice', 'otp'
        status: { type: String, enum: ['pending', 'sent', 'failed', 'failed_permanently'], default: 'pending' },
        error_message: { type: String },
        to: { type: String, required: true },
        subject: { type: String, required: true },
        message_id: { type: String }, // Maps to gmail_response.id
        retry_count: { type: Number, default: 0 },
        execution_time_ms: { type: Number } // For monitoring template performance
    }, { timestamps: true });

    // 1. Schema Normalization
    CommunicationLogSchema.pre("validate", async function() {
        if (!this.tenant_id) {
            this.tenant_id = undefined; 
        }
    });

    // 2. CRITICAL: Unique Idempotency constraint (Dual Index logic)
    
    // Shared DB constraint
    CommunicationLogSchema.index(
        { projectCode: 1, tenant_id: 1, idempotency_key: 1 }, 
        { unique: true, partialFilterExpression: { tenant_id: { $exists: true } } }
    );
    // Dedicated DB constraint
    CommunicationLogSchema.index(
        { projectCode: 1, idempotency_key: 1 }, 
        { unique: true, partialFilterExpression: { tenant_id: { $exists: false } } }
    );
    
    // 3. 90-Day TTL Index (Preventing DB bloat from heavy logs)
    CommunicationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

    // Optimized querying
    CommunicationLogSchema.index({ tenant_id: 1, status: 1 });
    CommunicationLogSchema.index({ projectCode: 1, status: 1 }); // Fallback for dedicated

    return connection.model('CommunicationLog', CommunicationLogSchema);
};
