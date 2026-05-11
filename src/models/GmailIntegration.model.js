/**
 * GmailIntegration Model Factory
 * 
 * To be injected into tenant DB via s3-saas-core
 */
module.exports = (connection) => {
    if (connection.models.GmailIntegration) {
        return connection.models.GmailIntegration;
    }

    const { Schema } = require('mongoose');

    const GmailIntegrationSchema = new Schema({
        tenant_id: { type: String, required: false }, // Optional for Dedicated/BYOD
        projectCode: { type: String, required: true },
        email: { type: String, required: true }, // Allows multiple emails (support, billing) per project
        access_token: { type: String, required: true }, // encrypted
        refresh_token: { type: String, required: true }, // encrypted
        expiry: { type: Date, required: true },
        token_version: { type: Number, default: 1 },
        status: { type: String, enum: ['connected', 'disconnected', 'expired'], default: 'connected' }
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
    
    // Index for Multi-Tenant Case (Shared DB)
    GmailIntegrationSchema.index(
        { projectCode: 1, tenant_id: 1, email: 1 }, 
        { unique: true, partialFilterExpression: { tenant_id: { $exists: true } } }
    );
    
    // Index for Dedicated / BYOD Case (No Tenant)
    GmailIntegrationSchema.index(
        { projectCode: 1, email: 1 }, 
        { unique: true, partialFilterExpression: { tenant_id: { $exists: false } } }
    );

    return connection.model('GmailIntegration', GmailIntegrationSchema);
};
