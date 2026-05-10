# 📧 s3-gmail-engine

A multi-tenant, template-driven, production-grade communication engine for SaaS projects (Medical POS, Gym POS, etc.). 

This engine is designed to be **Database-Agnostic**, supporting Shared, Dedicated, and BYOD architectures while providing strict protection against Google account suspension.

---

## 🔥 Philosophy
- **DB-Agnostic:** Injects models into the provided `dbConnection`. No global Mongoose coupling.
- **Trusted Code Only.** The engine strictly executes code-level templates. No unsafe `eval()`.
- **Smart Retries.** Implements Exponential Backoff (1s, 2s, 4s) but instantly stops on permanent auth failures (`invalid_grant`) to prevent account blocking.
- **Performance:** In-memory token caching with mutex locking prevents parallel refresh race conditions.
- **Log Lifecycle:** 90-day TTL automatically cleans up heavy logs while preserving idempotency.

---

## 📌 API Examples

The engine adapts to your DB architecture based on the parameters passed.

### 1. Tenant Business Email (Shared DB)
Used for Invoices, Welcome messages, etc.
```javascript
const { emailService } = require('s3-gmail-engine');

await emailService.send({
  projectCode: process.env.PROJECT_CODE,
  dbConnection: req.db,
  tenant_id: req.shopConfig.shopId, // REQUIRED for Shared DB
  
  type: "invoice",
  to: "customer@gmail.com",
  idempotency_key: `inv_001`,
  
  data: { sale: { billNo: "INV-001" } },
  subject: ({ data }) => `Invoice #${data.sale.billNo}`,
  template: async ({ data }) => `<h1>Hello!</h1> Your bill is ${data.sale.billNo}`,
});
```

### 2. System Email (Dedicated DB or Master Account)
Used for OTPs, Password Reset using the Company's master Gmail account.
```javascript
await emailService.send({
  projectCode: process.env.PROJECT_CODE,
  dbConnection: req.db,
  // tenant_id is OMITTED/UNDEFINED for System/BYOD emails
  
  type: "system", // Use 'system' to trigger the master account
  to: "user@gmail.com",
  idempotency_key: `otp_5522`,
  
  data: { code: "1234" },
  subject: "Your OTP Code",
  template: ({ data }) => `Your code is: ${data.code}`
});
```

---

## 🏗️ Guardrails
- **Attachment Limit:** 25MB total. Raw buffer limit is enforced at **18.75MB (75%)** to account for the ~33% size increase during Base64 encoding.
- **Timeout:** 5-second timeout on template execution.
- **Idempotency:** Unique compound index on `(projectCode, tenant_id, idempotency_key)` prevents double-sending.

---

## 🛠️ Requirements
Ensure your `.env` contains:
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI`
- `GMAIL_ENCRYPTION_KEY` (32 chars)
- `GMAIL_SYSTEM_EMAIL` (The master sender email)
