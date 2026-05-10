const express = require('express');
const router = express.Router();
const controller = require('../controllers/gmail.controller');

router.get('/connect', controller.connect);
router.get('/callback', controller.callback);

module.exports = router;