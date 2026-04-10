/**
 * SocketCoordinator — per-user concurrent WebSocket budget.
 *
 * One instance per user. Enforces MAX_SOCKETS concurrent outbound
 * WebSocket connections for that user only.
 *
 * At 200 users × 30 sockets each = 6,000 outbound connections max.
 * Each user's budget is completely independent.
 *
 * FIFO queue within each IP key ensures fair ordering.
 * setImmediate() on release prevents stack overflow during burst.
 */
class SocketCoordinator {
  constructor(userKey, maxSockets = 30) {
    this.userKey    = userKey;
    this.maxSockets = maxSockets;
    this._counts  = new Map();
    this._waiters = new Map();
  }

  _count(ipKey)  { return this._counts.get(ipKey) || 0; }
  _queue(ipKey)  {
    if (!this._waiters.has(ipKey)) this._waiters.set(ipKey, []);
    return this._waiters.get(ipKey);
  }

  acquire(ipKey = 'direct') {
    return new Promise((resolve) => {
      const attempt = () => {
        const n = this._count(ipKey);
        if (n < this.maxSockets) {
          this._counts.set(ipKey, n + 1);
          resolve();
        } else {
          this._queue(ipKey).push(attempt);
        }
      };
      attempt();
    });
  }

  release(ipKey = 'direct') {
    const n = this._count(ipKey);
    this._counts.set(ipKey, Math.max(0, n - 1));
    const next = this._queue(ipKey).shift();
    if (next) setImmediate(next);
  }

  getCount(ipKey = 'direct') { return this._count(ipKey); }

  getTotalCount() {
    let t = 0;
    for (const v of this._counts.values()) t += v;
    return t;
  }

  // Drain all waiters on shutdown — prevents hanging
  reset() {
    for (const q of this._waiters.values()) {
      for (const fn of q) setImmediate(fn);
    }
    this._counts.clear();
    this._waiters.clear();
  }
}

module.exports = SocketCoordinator;
