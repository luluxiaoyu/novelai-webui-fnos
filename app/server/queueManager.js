const { getConfig } = require('./configManager');

class QueueManager {
  constructor() {
    this.queue = [];
    this.activeCount = 0;
  }

  getMaxConcurrency() {
    const cfg = getConfig();
    const val = parseInt(cfg.maxConcurrency, 10);
    return isNaN(val) || val < 1 ? 1 : val;
  }

  async enqueue(req, res, task) {
    const maxConcurrency = this.getMaxConcurrency();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = 180000; // 3 minutes queue timeout

    return new Promise((resolve, reject) => {
      let timeoutTimer = null;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        res.removeListener('close', onClose);
      };

      const onClose = () => {
        if (!res.writableEnded && !res.headersSent && this.removeItem(id)) {
          cleanup();
          const err = new Error('Client closed connection while in queue');
          err.status = 499;
          reject(err);
        }
      };

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (this.removeItem(id)) {
            cleanup();
            const err = new Error('生图排队等待超时 (120秒)，当前任务繁忙，请稍后重试');
            err.status = 503;
            reject(err);
          }
        }, timeoutMs);
      }

      res.once('close', onClose);

      const item = {
        id,
        enqueuedAt: Date.now(),
        req,
        res,
        task,
        resolve,
        reject,
        cleanup
      };

      this.queue.push(item);
      const waitingCount = this.queue.length;
      if (waitingCount > 1 || this.activeCount >= maxConcurrency) {
        console.log(`[Queue] Task ${id} enqueued. Waiting: ${waitingCount}, Active: ${this.activeCount}/${maxConcurrency}`);
      }

      this.processNext();
    });
  }

  removeItem(id) {
    const idx = this.queue.findIndex(item => item.id === id);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  async processNext() {
    const maxConcurrency = this.getMaxConcurrency();
    if (this.activeCount >= maxConcurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    item.cleanup();
    this.activeCount += 1;

    const waitTime = Date.now() - item.enqueuedAt;
    if (waitTime > 200) {
      console.log(`[Queue] Task ${item.id} executing after ${waitTime}ms wait.`);
    }

    try {
      await item.task();
      item.resolve();
    } catch (err) {
      item.reject(err);
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.processNext();
    }
  }

  getStatus() {
    const maxConcurrency = this.getMaxConcurrency();
    return {
      waiting: this.queue.length,
      active: this.activeCount,
      maxConcurrency,
      isBusy: this.activeCount >= maxConcurrency || this.queue.length > 0
    };
  }
}

const queueManager = new QueueManager();

module.exports = {
  queueManager
};
