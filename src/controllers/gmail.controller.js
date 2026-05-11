const { createClient } = require('../core/gmail.client');
const { saveToken } = require('../core/token.manager');
const { encrypt, decrypt } = require('../utils/encrypt');
const { google } = require('googleapis');

exports.connect = (req, res) => {
  const { tenant_id } = req.query;
  
  if (!tenant_id) {
    return res.status(400).send("tenant_id is required");
  }

  const client = createClient();

  // Create secure state with timestamp for expiry validation
  const stateObj = {
    tenant_id,
    timestamp: Date.now()
  };
  const state = encrypt(JSON.stringify(stateObj));

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Force consent to ensure we get a refresh token
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email'
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

    // Decrypt and validate state
    const decryptedState = decrypt(state);
    const stateObj = JSON.parse(decryptedState);

    // Validate timestamp (10 mins expiry)
    const tenMinutes = 10 * 60 * 1000;
    if (Date.now() - stateObj.timestamp > tenMinutes) {
      return res.status(400).send("Auth session expired. Please try again.");
    }

    const tenant_id = stateObj.tenant_id;

    const client = createClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user email
    const oauth2 = google.oauth2({ auth: client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    const projectCode = process.env.PROJECT_CODE || 'PLATFORM';
    await saveToken(projectCode, tenant_id, email, tokens, req.db);

    res.send(`Gmail connected successfully for ${email}. You can close this window.`);
  } catch (error) {
    console.error("OAuth Callback Error:", error);
    res.status(500).send("Failed to connect Gmail.");
  }
};