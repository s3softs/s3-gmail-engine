const crypto = require('crypto');
const config = require('../config/gmail.config');

const algorithm = 'aes-256-cbc';
// Ensure the key is exactly 32 bytes. If not, pad or slice it.
const rawKey = config.encryptionKey || 'default_secret_key_32_chars_long!!';
const key = Buffer.alloc(32);
Buffer.from(rawKey).copy(key);

function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  if (!text) return text;
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
