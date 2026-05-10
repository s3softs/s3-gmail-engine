const emailWorker = require('../workers/email.worker');

// In-memory queue array. 
// For production, this interface will be swapped with BullMQ wrapper.
const queue = [];
let isProcessing = false;

async function add(payload) {
  queue.push(payload);
  processQueue();
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (queue.length > 0) {
    const job = queue.shift();
    try {
      await emailWorker.processJob(job);
    } catch (error) {
      console.error("Queue Processing Error:", error);
    }
  }

  isProcessing = false;
}

module.exports = { add };
