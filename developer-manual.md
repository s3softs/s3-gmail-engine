# 📘 Developer Manual: Integrating s3-gmail-engine

This manual provides step-by-step instructions for developers to integrate the standalone `s3-gmail-engine` library into SaaS projects like **Medical POS** (Shared DB) or **College POS** (Dedicated/BYOD DB).

---

## 🛠️ Prerequisites

1. Ensure the `s3-gmail-engine` folder exists on your server.
2. Inside your **Project Backend** (`backend/`), add the engine as a local dependency in `package.json`:
   ```bash
   npm install file:../../s3-gmail-engine
   ```
3. Ensure your `backend/.env` has the required Google OAuth and Encryption keys:
   ```env
   # Google OAuth Credentials
   GMAIL_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=your-google-client-secret
   GMAIL_REDIRECT_URI=https://your-domain.com/api/gmail/callback
   
   # Engine Security Key (Must be exactly 32 characters)
   GMAIL_ENCRYPTION_KEY=your-32-character-secret-key-here
   
   # Master System Email
   GMAIL_SYSTEM_EMAIL=noreply@s3softs.com
   ```

---

## 🚀 Step 1: Initialize DB Flexibility

Unlike legacy versions, the new Gmail Engine **does not** rely on a global Mongoose connection. It injects models into the `dbConnection` you provide.

The Engine automatically creates `GmailIntegration` and `CommunicationLog` models inside your database. **Do not create these manually.**

---

## 🔌 Step 2: Sending Emails (DB Architecture Rules)

How you send an email depends on your project's Database Architecture.

### Scenario A: SHARED DATABASE (e.g., Medical POS)
In a Shared Database, multiple tenants share the same DB. **You MUST pass the `tenant_id`**.

```javascript
const { emailService } = require('s3-gmail-engine');

await emailService.send({
    projectCode: process.env.PROJECT_CODE,
    dbConnection: req.db, // Passed directly from s3-saas-core
    
    // 🔴 SHARED DB: Must pass tenant_id
    tenant_id: req.shopConfig.shopId, 
    
    type: "invoice",
    to: "customer@gmail.com",
    idempotency_key: `inv_${sale._id}`, 
    
    data: { sale, shop: req.shopProfile },
    subject: ({ data }) => `Invoice #${data.sale.billNo}`,
    template: async ({ data }) => await ejs.renderFile(path, data)
});
```

### Scenario B: SYSTEM EMAILS (OTP / Forget Password)
Used for platform-level communication using the master account defined in `.env`. **Do NOT pass `tenant_id`.**

```javascript
await emailService.send({
    projectCode: process.env.PROJECT_CODE,
    dbConnection: req.db,
    
    // 🟢 SYSTEM EMAIL: tenant_id is omitted or undefined
    type: "system", 
    to: user.email,
    idempotency_key: `otp_${Date.now()}`,
    
    data: { otp: "123456" },
    subject: "Your Password Reset OTP",
    template: ({ data }) => `Your code is ${data.otp}`
});
```

---

## 🚦 Step 3: Production Guardrails (Critical)

### 1. Attachment Size Margin
Gmail has a hard 25MB limit. However, Base64 encoding increases file size by ~33%. 
The Engine enforces a **18.75MB raw buffer limit**. If your total attachments exceed this, the engine will throw an error immediately to prevent a silent failure in Google's API.

### 2. Auto-Log Cleanup
The engine implements a **90-day TTL index** on logs. Emails older than 90 days will be automatically deleted from your DB to prevent bloat. **Note:** This means Idempotency is only guaranteed for 90 days.

### 3. Smart Retries
The engine automatically handles Gmail Rate Limits (429 errors) using **Exponential Backoff**. 
However, if a Google account's token expires (`invalid_grant`), the engine **stops retrying immediately** and marks the log as `failed_permanently`. This prevents your Google account from being flagged for suspicious activity.

---

## 📱 Step 4: UI Integration (OAuth Flow)

To let a tenant connect their Gmail, redirect them to the engine's built-in OAuth route.

```jsx
const handleConnect = () => {
    // For Shared DB, pass tenant_id
    const url = `/api/gmail/connect?projectCode=${P_CODE}&tenant_id=${T_ID}`;
    window.location.href = url;
};
```

---

## 🧹 Step 5: Cleanup

Once integration is verified:
1. **Delete** old `nodemailer` services.
2. **Uninstall** `nodemailer` and `googleapis` from your main project, as the engine now manages these dependencies natively.

Your project is now fully powered by an enterprise-grade SaaS email engine! 🎉
