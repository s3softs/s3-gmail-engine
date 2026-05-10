const { google } = require('googleapis');
const config = require('../config/gmail.config');

function createClient() {
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  );
}

module.exports = { createClient };