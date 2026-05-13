const express = require('express');
const router = express.Router();
const controller = require('../controllers/gmail.controller');

// SYSTEM OAuth routes (company Gmail — used by Super Admin)
router.get('/connect',        controller.connect);        // Existing — UNTOUCHED
router.get('/callback',       controller.callback);       // Extended — handles both SYSTEM and TENANT

// TENANT OAuth initiation (tenant's own Gmail — called from host app)
router.get('/tenant-connect', controller.tenantConnect);  // NEW

module.exports = router;