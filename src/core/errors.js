class TemplateError extends Error {
    constructor(message, tenant_id, template_key) {
        super(message);
        this.name = "TemplateError";
        this.error_type = "TEMPLATE_ERROR";
        this.tenant_id = tenant_id;
        this.template_key = template_key;
    }
}

module.exports = { TemplateError };
