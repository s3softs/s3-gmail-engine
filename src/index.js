const emailService = require('./services/email.service');
const gmailRoutes = require('./routes/gmail.routes');

// Export the main service interface and routes
module.exports = {
  emailService,
  gmailRoutes
};