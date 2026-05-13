/**
 * GmailIntegration Model Factory
 *
 * account_type = 'SYSTEM'  → Company Gmail, stored in Master DB
 * account_type = 'TENANT'  → Tenant Gmail, stored in Tenant DB
 *
 * To be injected into any DB connection via model factory pattern.
 */
module.exports = (connection) => {
    if (connection.models.GmailIntegration) {
        return connection.models.GmailIntegration;
    }

    const { Schema } = require('mongoose');

    const GmailIntegrationSchema = new Schema({
        tenant_id:    { type: String, required: false }, // Optional — required only for SHARED db mode
        projectCode:  { type: String, required: true },
        email:        { type: String, required: true },

        // ── Mode Classification (NEW) ─────────────────────────────────
        // 'SYSTEM'  → Company Gmail (Master DB). Used for OTP, security emails.
        // 'TENANT'  → Tenant Gmail (Tenant DB). Used for invoices, receipts.
        // Default 'SYSTEM' ensures full backward compatibility with existing records.
        account_type: {
            type: String,
            enum: ['SYSTEM', 'TENANT'],
            default: 'SYSTEM'
        },

        // context kept for backward compat — new code should use account_type
        context: { type: String, enum: ['system', 'shop', 'owner', 'tenant'], default: 'shop' },

        dbType:        { type: String, enum: ['SHARED', 'DEDICATED', 'BYOD'], required: false },
        access_token:  { type: String, required: true }, // encrypted
        refresh_token: { type: String, required: true }, // encrypted
        expiry:        { type: Date,   required: true },
        token_version: { type: Number, default: 1 },
        status:        { type: String, enum: ['connected', 'disconnected', 'expired'], default: 'connected' }
    }, { timestamps: true });

    // 1. Schema Normalization
    GmailIntegrationSchema.pre("validate", async function() {
        if (!this.tenant_id) {
            this.tenant_id = undefined; 
        }
    });

    // 2. Mixed Data Guard (Best-effort corruption prevention)
    GmailIntegrationSchema.pre("save", async function() {
        const isTenantDoc = this.tenant_id !== undefined && this.tenant_id !== null;
        const query = isTenantDoc 
            ? { projectCode: this.projectCode, tenant_id: { $exists: false } }
            : { projectCode: this.projectCode, tenant_id: { $exists: true } };

        const hasMixed = await this.constructor.exists(query);

        if (hasMixed) {
            throw new Error("Mixed tenant/non-tenant data not allowed in the same database");
        }
    });

    // 3. Dual Partial Indexes (Email-based)
    
    // 1. Index for Multi-Tenant Case (Shared DB)
    GmailIntegrationSchema.index(
        { projectCode: 1, tenant_id: 1, email: 1, context: 1 }, 
        { unique: true, partialFilterExpression: { tenant_id: { $exists: true } } }
    );
    
    // 2. Index for Dedicated / BYOD Case (No Tenant)
    GmailIntegrationSchema.index(
        { projectCode: 1, email: 1, context: 1 }, 
        { unique: true, partialFilterExpression: { tenant_id: { $exists: false } } }
    );

    return connection.model('GmailIntegration', GmailIntegrationSchema);
};
