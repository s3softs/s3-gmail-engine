const { createClient } = require('../core/gmail.client');
const { saveToken } = require('../core/token.manager');
const { encrypt, decrypt } = require('../utils/encrypt');
const { google } = require('googleapis');

exports.connect = (req, res) => {
  const { tenant_id, context = 'shop', dbType = 'SHARED' } = req.query;
  
  if (!tenant_id) {
    return res.status(400).send("tenant_id is required");
  }

  const client = createClient();

  // Create secure state with Phase 2 metadata
  const stateObj = {
    tenant_id,
    context,
    dbType,
    timestamp: Date.now()
  };
  const state = encrypt(JSON.stringify(stateObj));

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', 
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid'
    ],
    state: state
  });

  res.redirect(url);
};

exports.callback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!state) {
      return res.status(400).send("Invalid request: State missing");
    }

    // Decrypt and validate state (Phase 2 aware)
    const decryptedState = decrypt(state);
    const stateObj = JSON.parse(decryptedState);

    const { tenant_id, context, dbType, timestamp } = stateObj;

    // Validate timestamp (10 mins expiry)
    if (Date.now() - timestamp > (10 * 60 * 1000)) {
      return res.status(400).send("Auth session expired. Please try again.");
    }

    const client = createClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user email
    const oauth2 = google.oauth2({ auth: client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // Save with contextual metadata
    const projectCode = process.env.PROJECT_CODE || 'PLATFORM';
    await saveToken(projectCode, tenant_id, email, tokens, req.db, context, dbType);

    res.send(`Gmail connected successfully for ${email} as ${context}. You can close this window.`);
  } catch (error) {
    console.error("OAuth Callback Error:", error);
    res.status(500).send("Failed to connect Gmail.");
  }
};