require('dotenv').config();

module.exports = {
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  redirectUri: process.env.GMAIL_REDIRECT_URI,
  encryptionKey: process.env.GMAIL_ENCRYPTION_KEY // Must be 32 chars
};