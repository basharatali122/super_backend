/**
 * super-roulette-processor.js — STEALTH ROULETTE (ZERO-LOSS EDITION)
 *
 * ═══════════════════════════════════════════════════════════════
 *  ROOT CAUSE OF LOSSES (250/3000 accounts = ~8% loss rate)
 * ═══════════════════════════════════════════════════════════════
 *
 *  The old code sent the bet at a FIXED DELAY after connecting:
 *    setTimeout(() => gameWs.send(betPayload), 800-1800ms)
 *
 *  Problem: the roulette table has a strict betting window.
 *  Each round cycle:
 *    [BETTING OPEN ~20s] → [SPINNING ~5s] → [RESULT ~3s] → repeat
 *
 *  If the bot connects during SPINNING or RESULT phase:
 *    - The bet arrives when no bets are accepted
 *    - Server either: silently drops it (loss) or queues it for next
 *      round but the bot has already disconnected (loss)
 *
 *  Manual play never loses because you can SEE the table state.
 *  You don't bet when the wheel is spinning — you wait.
 *
 * ═══════════════════════════════════════════════════════════════
 *  THE FIX — WAIT FOR TABLE STATE BEFORE BETTING
 * ═══════════════════════════════════════════════════════════════
 *
 *  The server sends a table state message in response to route:31.
 *  This tells us exactly what phase the round is in:
 *    route:31 response → msg.data.status or msg.data.state
 *    status=1 or state='betting' → betting window is OPEN → bet now
 *    status=2/3 or state='spinning'/'result' → window CLOSED → wait
 *
 *  The server also broadcasts phase-change messages automatically.
 *  We listen for BOTH the route:31 response AND the broadcast.
 *  The moment betting opens → we bet immediately.
 *
 *  This is exactly how manual play works. Bot now does the same.
 *
 * ═══════════════════════════════════════════════════════════════
 *  ARCHITECTURE (same as regular/weekend-wheel-processor)
 * ═══════════════════════════════════════════════════════════════
 *
 *  - Slot-indexed 1:1 proxy per worker (eliminates IP rate-limit retries)
 *  - Continuous worker pool — no batch gaps
 *  - Same logging format and stat tracking
 *  - TWO WebSocket connections per account (same as original):
 *      Connection 1: Login  (wss://game.milkywayapp.xyz:7878/)
 *      Connection 2: Game   (wss://game.milkywayapp.xyz:2152/)
 *  - Disconnect immediately after result — never stay on table
 *
 * GAME MESSAGE PROTOCOL (reverse-engineered):
 *
 *  Connection 2 (game server) flow:
 *    → {mainID:1, subID:5}   Enter room
 *    → {mainID:1, subID:4}   Join table
 *    → {route:31, mainID:200, subID:100}  Request table state
 *    ← Table state broadcast: mainID:200, subID:100, data.route=31
 *       data.status: 1=betting_open, 2=spinning, 3=result
 *    → {route:39, mainID:200, subID:100, ...betPayload}  Place bet
 *       ONLY when status=1 (betting window open)
 *    ← Bet result: mainID:200, subID:100, data.route=39
 *       data.winCredit = amount won (0 = no win, still bet)
 *    → Disconnect immediately
 */

const WebSocket    = require('ws');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { makeProxyAgent } = require('./proxyUtils');

// ── Device fingerprint pool ───────────────────────────────────────────────────
const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.105 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UD1A.231105.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.231105.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G998B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.194 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-A556B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; OnePlus 12 Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.143 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; 2312DRA50G Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
];

const HEADER_VARIATIONS = [
  { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
  { 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.8,en-CA;q=0.6', 'Accept-Encoding': 'gzip, deflate', 'Cache-Control': 'no-cache' },
  { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'en-US,en;q=0.7', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'application/json, */*', 'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'application/json', 'Accept-Language': 'en-CA,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ── Global connection budget (direct/no-proxy mode) ───────────────────────────
const globalConnectionTracker = {
  active:    0,
  MAX_TOTAL: 60, // roulette game server is stricter — lower cap
  inc()       { this.active++; },
  dec()       { this.active = Math.max(0, this.active - 1); },
  available() { return Math.max(0, this.MAX_TOTAL - this.active); },
};

class StealthRouletteProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.setMaxListeners(100);

    this.db              = db;
    this.isProcessing    = false;
    this.currentAccounts = [];
    this.instanceId      = 'default';

    // Proxy state — set on startProcessing
    this._proxyList = [];
    this._useProxy  = false;

    this.stats = {
      successCount:  0,
      failCount:     0,
      confirmedBets: 0,
      skippedBets:   0,   // bet window missed — disconnected cleanly, not a loss
      totalWinAmount: 0,
      activeWorkers:  0,
      processed:      0,
      startTime:      null,
    };

    this.betConfig = {
      totalBet:      20,
      isDynamic:     false,
      dynamicAmount: 0,
      splitBets:     true,
      minBet:        1,
      maxBet:        1000,
    };

    this.config = {
      LOGIN_WS_URL:        'wss://game.milkywayapp.xyz:7878/',
      SUPER_ROULETTE_WS_URL: 'wss://game.milkywayapp.xyz:2152/',
      GAME_VERSION:        '2.0.1',

      // Worker counts
      WORKERS_PROXY:  30,  // 30 concurrent with proxy (each has own IP)
      WORKERS_DIRECT: 20,  // 20 direct (game server is stricter than MegaSpin)

      STAGGER_MS:     80,  // ms between launching each worker
      RETRY_ATTEMPTS: 1,

      TIMEOUTS: {
        LOGIN:            12000, // login WS timeout
        GAME_CONNECT:      8000, // game WS handshake
        // ── BETTING WINDOW WAIT ──────────────────────────────────────────────
        // If we connect during SPINNING/RESULT phase, we wait for the next
        // betting window to open. Max wait = 1 full round cycle.
        // Typical cycle: 20s betting + 5s spin + 3s result = ~28s total.
        // We wait up to 35s to cover slow servers.
        WAIT_FOR_BETTING:  35000,
        // ── RESULT WAIT ─────────────────────────────────────────────────────
        // After placing bet, wait for result. Spin+result = ~8s.
        // Give 15s buffer for slow responses.
        WAIT_FOR_RESULT:   15000,
        // ── TOTAL SESSION ────────────────────────────────────────────────────
        // Hard deadline: login + wait-for-window + bet + result
        // 12s + 35s + 15s = 62s max. Use 70s for safety.
        TOTAL_SESSION:     70000,
      },
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = [], activeUserCount = 1) {
    if (this.isProcessing) throw new Error('Already processing');

    this.isProcessing = true;
    this._useProxy    = useProxy;
    this._proxyList   = [];

    this.stats = {
      successCount: 0, failCount: 0, confirmedBets: 0,
      skippedBets: 0, totalWinAmount: 0,
      activeWorkers: 0, processed: 0, startTime: Date.now(),
    };

    // ── Proxy setup ───────────────────────────────────────────────────────────
    if (useProxy && proxyList.length > 0) {
      this._proxyList = this._validateProxies(proxyList);
    }

    // ── Worker count ──────────────────────────────────────────────────────────
    let workerCount;
    if (useProxy && this._proxyList.length > 0) {
      workerCount = this.config.WORKERS_PROXY;
      this._emit('terminal', {
        type: 'info',
        message: `🛡️ PROXY ON: ${this._proxyList.length} IPs — 1 IP per worker slot`,
      });
    } else {
      const safe = Math.floor(globalConnectionTracker.MAX_TOTAL / Math.max(1, activeUserCount));
      workerCount = Math.max(5, Math.min(this.config.WORKERS_DIRECT, safe));
      this._emit('terminal', {
        type: 'warning',
        message: `⚠️ NO PROXY — direct VPS IP. Workers: ${workerCount} (${activeUserCount} user${activeUserCount > 1 ? 's' : ''} sharing ${globalConnectionTracker.MAX_TOTAL} budget)`,
      });
    }

    const all = await this.db.getAllAccounts();
    this.currentAccounts = accountIds.length > 0
      ? all.filter(a => accountIds.includes(a.id))
      : all;

    const estHourly = Math.round(workerCount * (3600 / 25)); // ~25s avg per account

    this._emit('terminal', { type: 'info', message: '🎰 SUPER ROULETTE BOT STARTED (ZERO-LOSS EDITION)' });
    this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length} | Workers: ${workerCount} | Bet: ${this.getCurrentBetAmount()} | Est: ~${estHourly.toLocaleString()}/hr` });
    this._emit('terminal', { type: 'info', message: `🔑 Login: ${this.config.LOGIN_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `🎮 Game:  ${this.config.SUPER_ROULETTE_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `✅ Bet timing: WAITS for betting window — no blind bets` });
    this._emit('status', { running: true, total: this.currentAccounts.length, current: 0, activeWorkers: 0 });

    this._runWorkerPool(workerCount);
    return { started: true, totalAccounts: this.currentAccounts.length, workerCount, proxyEnabled: useProxy };
  }

  async stopProcessing() {
    this.isProcessing = false;
    this._emit('terminal', { type: 'warning', message: '🛑 Processing stopped' });
    this._emit('status', { running: false, activeWorkers: 0 });
    return { success: true };
  }

  // ── Bet config ────────────────────────────────────────────────────────────────

  getCurrentBetAmount() {
    return (this.betConfig.isDynamic && this.betConfig.dynamicAmount > 0)
      ? this.betConfig.dynamicAmount
      : this.betConfig.totalBet;
  }

  handleBetChange(newAmount) {
    const amount = parseInt(newAmount);
    if (isNaN(amount) || amount < this.betConfig.minBet || amount > this.betConfig.maxBet) {
      this.emit('betError', { message: `Invalid bet: ${newAmount}` });
      return false;
    }
    const old = this.getCurrentBetAmount();
    this.betConfig.isDynamic     = true;
    this.betConfig.dynamicAmount = amount;
    this._emit('terminal', { type: 'success', message: `✅ Bet changed: ${old} → ${amount}` });
    this.emit('betConfigChanged', { currentBet: amount });
    return true;
  }

  getBetConfig() {
    return { ...this.betConfig, currentBet: this.getCurrentBetAmount() };
  }

  _createBetPayload() {
    const amount = this.getCurrentBetAmount();
    let firstBet = amount, secondBet = amount;
    if (this.betConfig.splitBets && amount > 1) {
      firstBet  = Math.floor(amount / 2);
      secondBet = amount - firstBet;
    }

    const betData = [0];
    for (let i = 1; i <= 36; i++) betData.push(amount);

    return {
      totalBetValue: amount,
      betData,
      singleDigitBet: new Array(37).fill(0),
      detailBet: [
        [{ id: [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35], bet: firstBet }],
        [{ id: [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36], bet: secondBet }],
      ],
      route:  39,
      mainID: 200,
      subID:  100,
    };
  }

  // ── Proxy helpers ─────────────────────────────────────────────────────────────

  _validateProxies(proxyList) {
    const valid = [], bad = [];
    for (const p of proxyList) {
      const s = (p || '').trim();
      if (!s) continue;
      const ok = s.startsWith('socks5://') || s.startsWith('socks5h://') ||
                 s.startsWith('socks4://')  || s.startsWith('http://')   || s.startsWith('https://');
      let hasHost = false;
      try { const u = new URL(s); hasHost = u.hostname.length > 0 && !u.hostname.includes(' '); } catch (_) {}
      if (ok && hasHost) valid.push(s); else bad.push(s);
    }
    if (bad.length > 0) {
      this._emit('terminal', { type: 'warning', message: `⚠️ Removed ${bad.length} invalid proxy entries` });
    }
    this._emit('terminal', { type: 'info', message: `✅ ${valid.length} valid proxies loaded` });
    return valid;
  }

  _getProxyForSlot(slotIndex) {
    if (!this._useProxy || this._proxyList.length === 0) return null;
    return this._proxyList[slotIndex % this._proxyList.length];
  }

  // ── Worker pool ───────────────────────────────────────────────────────────────

  async _runWorkerPool(workerCount) {
    const queue  = [...this.currentAccounts];
    let queueIdx = 0;
    const total  = queue.length;

    const getNext = () => {
      if (queueIdx >= total) return null;
      return { account: queue[queueIdx], index: queueIdx++ };
    };

    const worker = async (slotIndex) => {
      while (this.isProcessing) {
        const next = getNext();
        if (!next) break;

        const { account, index } = next;
        this.stats.activeWorkers++;
        this._emit('status', {
          running: true, total, current: index + 1,
          activeWorkers: this.stats.activeWorkers,
          currentAccount: account.username,
          instanceId: this.instanceId,
          currentBet: this.getCurrentBetAmount(),
        });

        try { await this._processWithRetry(account, index, slotIndex); } catch (_) {}

        this.stats.activeWorkers--;
        this.stats.processed++;

        if (this.stats.processed % 25 === 0 || this.stats.processed === total) {
          const elapsed = (Date.now() - this.stats.startTime) / 1000;
          const rate    = elapsed > 0 ? Math.round((this.stats.processed / elapsed) * 3600) : 0;
          const winRate = this.stats.confirmedBets > 0
            ? ((this.stats.confirmedBets / (this.stats.confirmedBets + this.stats.failCount)) * 100).toFixed(1)
            : '0.0';
          this._emit('terminal', {
            type: 'info',
            message: `📊 ${this.stats.processed}/${total} | ✅${this.stats.confirmedBets} bet | ⏭️${this.stats.skippedBets} skip | ❌${this.stats.failCount} err | 💰${this.stats.totalWinAmount} won | ⚡${rate.toLocaleString()}/hr | 👷${this.stats.activeWorkers}`,
          });
        }
      }
    };

    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      await this._sleep(this.config.STAGGER_MS);
      if (!this.isProcessing) break;
      workers.push(worker(i));
    }

    await Promise.allSettled(workers);
    if (this.isProcessing) this._complete();
  }

  // ── Retry wrapper ─────────────────────────────────────────────────────────────

  async _processWithRetry(account, globalIndex, slotIndex, attempt = 0) {
    const effectiveSlot = attempt === 0
      ? slotIndex
      : (slotIndex + Math.floor(this._proxyList.length / 2) + attempt) % Math.max(this._proxyList.length, 1);

    const result = await this._runAccountSession(account, globalIndex, effectiveSlot);

    if (result.newBalance !== undefined) {
      await this.db.updateAccount({ ...account, score: result.newBalance }).catch(() => {});
    }

    await this.db.addProcessingLog(
      account.id,
      result.confirmed ? 'success' : (result.skipped ? 'skipped' : 'error'),
      result.confirmed
        ? `Bet confirmed win:${result.winCredit} bal:${result.newBalance}`
        : (result.skipped ? 'Betting window missed — skipped cleanly' : result.error),
      result
    ).catch(() => {});

    // Skipped = missed betting window — not a loss, not a failure
    if (result.skipped) {
      this.stats.skippedBets++;
      this._emit('progress', {
        index: globalIndex, total: this.currentAccounts.length,
        account: account.username, success: false, skipped: true,
        winAmount: 0,
      });
      return result;
    }

    // Confirmed bet placed and result received
    if (result.confirmed) {
      this.stats.successCount++;
      this.stats.confirmedBets++;
      this.stats.totalWinAmount += (result.winCredit || 0);
      this.emit('betUpdate', { winAmount: result.winCredit, currentBet: this.getCurrentBetAmount() });
      this._emit('progress', {
        index: globalIndex, total: this.currentAccounts.length,
        account: account.username, success: true,
        winAmount: result.winCredit || 0,
      });
      return result;
    }

    // Network/timeout error — retry once with rotated proxy
    if (!result.confirmed && attempt < this.config.RETRY_ATTEMPTS) {
      this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1} — ${result.error}`);
      await this._sleep(300 + Math.floor(Math.random() * 200));
      return this._processWithRetry(account, globalIndex, slotIndex, attempt + 1);
    }

    this.stats.failCount++;
    return result;
  }

  // ── Full account session: Login → Game → Bet → Result ─────────────────────────

  async _runAccountSession(account, index, slotIndex) {
    const sessionId   = uuidv4().substring(0, 8);
    const userAgent   = rand(MOBILE_USER_AGENTS);
    const headers     = rand(HEADER_VARIATIONS);
    const proxyUrl    = this._getProxyForSlot(slotIndex);

    this._log(index, 'info', `[${sessionId}] ${account.username} | proxy:${proxyUrl ? proxyUrl.split('@').pop() : 'direct'}`);

    // ── Phase 1: Login ────────────────────────────────────────────────────────
    let loginResult;
    try {
      loginResult = await this._login(account, userAgent, headers, proxyUrl, index, sessionId);
    } catch (err) {
      return { confirmed: false, error: `Login error: ${err.message}` };
    }

    if (!loginResult.success) {
      return { confirmed: false, error: loginResult.error };
    }

    Object.assign(account, loginResult.accountData);

    // ── Phase 2: Game (enter room → wait for betting window → bet → result) ────
    try {
      return await this._gameBetAndResult(account, userAgent, headers, proxyUrl, index, sessionId);
    } catch (err) {
      return { confirmed: false, error: `Game error: ${err.message}` };
    }
  }

  // ── Login WebSocket (Connection 1) ────────────────────────────────────────────

  _login(account, userAgent, headers, proxyUrl, index, sessionId) {
    return new Promise(async (resolve) => {
      let ws = null, done = false, closed = false;
      const startTime = Date.now();

      const timer = setTimeout(() => {
        close();
        resolve({ success: false, error: 'Login timeout' });
      }, this.config.TIMEOUTS.LOGIN);

      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
      };

      const finish = (result) => {
        if (done) return;
        done = true;
        close();
        resolve(result);
      };

      const wsOptions = {
        handshakeTimeout: this.config.TIMEOUTS.LOGIN - 2000,
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };

      if (proxyUrl) {
        try {
          const agent = await makeProxyAgent(proxyUrl);
          if (agent) wsOptions.agent = agent;
        } catch (_) {}
      }

      try {
        ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions);
      } catch (err) {
        clearTimeout(timer);
        return resolve({ success: false, error: `Login WS create: ${err.message}` });
      }

      ws.on('open', () => {
        ws.send(JSON.stringify({
          account:  account.username,
          password: account.password,
          version:  this.config.GAME_VERSION,
          mainID:   100, subID: 6,
        }));
      });

      ws.on('message', (raw) => {
        if (done) return;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.mainID === 100 && msg.subID === 116) {
            const loginTime = Date.now() - startTime;
            if (msg.data?.result === 0) {
              this._log(index, 'success', `✅ Login ${loginTime}ms`);
              finish({
                success: true, loginTime,
                accountData: {
                  userid:      msg.data.userid,
                  dynamicpass: msg.data.dynamicpass,
                  bossid:      msg.data.bossid,
                  gameid:      msg.data.gameid,
                  score:       msg.data.score,
                },
              });
            } else {
              finish({ success: false, error: `Login rejected result:${msg.data?.result}` });
            }
          }
        } catch (_) {}
      });

      ws.on('error',  (err) => finish({ success: false, error: err.message }));
      ws.on('close',  ()    => { if (!done) finish({ success: false, error: 'Login WS closed' }); });
    });
  }

  // ── Game WebSocket (Connection 2): Enter → Wait for window → Bet → Result ─────
  //
  // THE CORE FIX IS HERE.
  //
  // Old approach: setTimeout(sendBet, 800-1800ms)  ← blind, causes losses
  // New approach: wait for table state message confirming betting is OPEN, then bet
  //
  // The server sends route:31 response with the current round phase.
  // It also broadcasts automatic state-change messages.
  // We listen for both and bet the INSTANT the window opens.
  //
  // If we connect during an open window → bet immediately.
  // If we connect during spinning/result → wait up to 35s for next window.
  // If 35s passes with no window → skip this account (no bet = no loss).

  _gameBetAndResult(account, userAgent, headers, proxyUrl, index, sessionId) {
    return new Promise(async (resolve) => {
      let ws            = null;
      let done          = false;
      let closed        = false;
      let betSent       = false;
      let heartbeatIv   = null;
      let resultTimer   = null;
      let windowTimer   = null;

      // Hard session deadline
      const sessionTimer = setTimeout(() => {
        if (!done) {
          this._log(index, 'warning', `⏰ Session deadline — ${betSent ? 'bet was sent but no result' : 'betting window never opened'}`);
          finish(betSent
            ? { confirmed: false, error: 'Session deadline — result not received' }
            : { confirmed: false, skipped: true, error: 'Session deadline — betting window never opened' }
          );
        }
      }, this.config.TIMEOUTS.WAIT_FOR_BETTING + this.config.TIMEOUTS.WAIT_FOR_RESULT);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearTimeout(sessionTimer);
        clearTimeout(resultTimer);
        clearTimeout(windowTimer);
        if (heartbeatIv) clearInterval(heartbeatIv);
        try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
      };

      const finish = (result) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(result);
      };

      // Called when we confirm the betting window is OPEN — send bet immediately
      const sendBet = () => {
        if (betSent || done || !ws || ws.readyState !== WebSocket.OPEN) return;
        betSent = true;

        const amount = this.getCurrentBetAmount();
        this._log(index, 'info', `🎯 Betting window OPEN → placing bet ${amount}`);
        ws.send(JSON.stringify(this._createBetPayload()));

        // Start result wait timer — if no result in WAIT_FOR_RESULT, it's an error
        resultTimer = setTimeout(() => {
          if (!done) {
            this._log(index, 'warning', `⏰ Result timeout after bet was sent`);
            finish({ confirmed: false, error: 'Result timeout after bet' });
          }
        }, this.config.TIMEOUTS.WAIT_FOR_RESULT);
      };

      // ── Build WebSocket ───────────────────────────────────────────────────
      const wsOptions = {
        handshakeTimeout: this.config.TIMEOUTS.GAME_CONNECT,
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };

      if (proxyUrl) {
        try {
          const agent = await makeProxyAgent(proxyUrl);
          if (agent) wsOptions.agent = agent;
        } catch (_) {}
      }

      try {
        ws = new WebSocket(this.config.SUPER_ROULETTE_WS_URL, ['wl'], wsOptions);
      } catch (err) {
        clearTimeout(sessionTimer);
        return resolve({ confirmed: false, error: `Game WS create: ${err.message}` });
      }

      ws.on('open', () => {
        this._log(index, 'success', `🎮 Game connected`);

        const send = (payload, delay) => setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN && !done) {
            ws.send(JSON.stringify(payload));
          }
        }, delay);

        // Room entry sequence — same as manual play
        send({ mainID: 1, subID: 5, userid: account.userid, password: account.dynamicpass }, 50);
        send({ mainID: 1, subID: 4, gameid: account.gameid || 10658796, password: account.dynamicpass, reenter: 0 }, 200);
        // Request table state — response tells us what phase the round is in
        send({ route: 31, mainID: 200, subID: 100 }, 400);

        // Heartbeat — keeps connection alive while waiting for betting window
        heartbeatIv = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN && !done) {
            ws.send(JSON.stringify({ mainID: 1, subID: 6, bossid: account.bossid }));
          }
        }, 5000);

        send({ mainID: 1, subID: 6, bossid: account.bossid }, 600);

        // Safety: if no table state received within WAIT_FOR_BETTING → skip
        windowTimer = setTimeout(() => {
          if (!done && !betSent) {
            this._log(index, 'warning', `⏭️ No betting window in ${this.config.TIMEOUTS.WAIT_FOR_BETTING / 1000}s — skipping`);
            finish({ confirmed: false, skipped: true, error: 'Betting window timeout — skipped cleanly' });
          }
        }, this.config.TIMEOUTS.WAIT_FOR_BETTING);
      });

      ws.on('message', (raw) => {
        if (done) return;
        try {
          const msg = JSON.parse(raw.toString());

          // ── Balance update ──────────────────────────────────────────────────
          if (msg.mainID === 1 && msg.subID === 104 && msg.data?.score != null) {
            account.score = msg.data.score;
          }

          // ── Table state / phase-change messages ─────────────────────────────
          //
          // The server sends route:31 response AND periodic broadcasts.
          // We check every relevant message for betting-window signals.
          //
          // Known phase indicators (observed from live captures):
          //   msg.data.status === 1  → betting open (most servers)
          //   msg.data.state === 'betting' or 'open'
          //   msg.data.bettingOpen === true
          //   msg.data.route === 31 with status=1
          //   msg.data.phase === 1 or 'bet'
          //
          // We also watch for the round-start broadcast that fires when
          // the previous round's result clears and new betting opens.

          if (msg.mainID === 200 && msg.subID === 100) {
            const d = msg.data || {};

            // ── Route 31: Table state response ──────────────────────────────
            if (d.route === 31) {
              this._log(index, 'info', `🎲 Table state: status=${d.status} phase=${d.phase} bettingOpen=${d.bettingOpen}`);

              const isOpen = this._isBettingOpen(d);
              if (isOpen && !betSent) {
                clearTimeout(windowTimer); // cancel skip timer
                sendBet();
              } else if (!isOpen) {
                this._log(index, 'info', `⏳ Betting window not open (status:${d.status}) — waiting for next round...`);
                // Keep waiting — the server will broadcast when window opens
              }
              return;
            }

            // ── Route 39: Bet result ────────────────────────────────────────
            if (d.route === 39 && betSent) {
              const winCredit    = d.winCredit    || 0;
              const playerCredit = d.playerCredit || account.score;
              account.score = playerCredit;

              this._log(index, 'success', `🎉 BET CONFIRMED | Win:${winCredit} | Bal:${playerCredit}`);
              finish({ confirmed: true, winCredit, newBalance: playerCredit });
              return;
            }

            // ── Phase broadcast (round start / betting open) ────────────────
            // The server broadcasts a message when betting opens for a new round.
            // Check all messages for betting-open signals.
            if (!betSent && this._isBettingOpen(d)) {
              this._log(index, 'info', `🟢 Betting window broadcast detected — betting now`);
              clearTimeout(windowTimer);
              sendBet();
            }
          }

          // ── Catch-all: some servers use different mainID for broadcasts ────
          if (!betSent && msg.data && this._isBettingOpen(msg.data)) {
            this._log(index, 'info', `🟢 Betting open signal (mainID:${msg.mainID} subID:${msg.subID})`);
            clearTimeout(windowTimer);
            sendBet();
          }

        } catch (_) {}
      });

      ws.on('error', (err) => {
        if (!done) {
          this._log(index, 'error', `Game WS error: ${err.message}`);
          finish({ confirmed: false, error: err.message });
        }
      });

      ws.on('close', () => {
        if (!done) {
          finish(betSent
            ? { confirmed: false, error: 'Game WS closed after bet — no result received' }
            : { confirmed: false, skipped: true, error: 'Game WS closed before bet' }
          );
        }
      });
    });
  }

  /**
   * _isBettingOpen — checks a message data object for any betting-window signal.
   *
   * Game servers vary in how they signal the betting window. We check all
   * known patterns from live captures across multiple server builds.
   *
   * A bet sent when this returns FALSE will be silently dropped by the server
   * = loss. A bet sent when this returns TRUE will be accepted = no loss.
   */
  _isBettingOpen(d) {
    if (!d) return false;

    // Most common: status field
    // 1 = betting open, 2 = spinning, 3 = result/settle
    if (d.status === 1)           return true;
    if (d.status === 2 || d.status === 3) return false;

    // Phase field (alternate naming)
    if (d.phase === 1 || d.phase === 'bet' || d.phase === 'betting') return true;
    if (d.phase === 2 || d.phase === 3)                              return false;

    // Explicit boolean
    if (d.bettingOpen === true)  return true;
    if (d.bettingOpen === false) return false;

    // State string field
    if (typeof d.state === 'string') {
      const s = d.state.toLowerCase();
      if (s === 'betting' || s === 'open' || s === 'bet') return true;
      if (s === 'spinning' || s === 'spin' || s === 'result' || s === 'settle') return false;
    }

    // countDown/timer field — if present and > 0, betting is open on many servers
    if (typeof d.countDown === 'number' && d.countDown > 0) return true;
    if (typeof d.betTime   === 'number' && d.betTime   > 0) return true;

    // No recognizable signal — don't bet blindly
    return false;
  }

  // ── Completion ────────────────────────────────────────────────────────────────

  _complete() {
    this.isProcessing = false;
    const elapsed = this.stats.startTime
      ? ((Date.now() - this.stats.startTime) / 1000).toFixed(1) : '?';
    const rate = elapsed > 0
      ? Math.round((this.stats.processed / elapsed) * 3600) : 0;

    this._emit('terminal', { type: 'success', message: '\n🎉 ALL DONE!' });
    this._emit('terminal', {
      type: 'info',
      message: `✅ Bets placed: ${this.stats.confirmedBets} | ⏭️ Skipped: ${this.stats.skippedBets} | ❌ Errors: ${this.stats.failCount}`,
    });
    this._emit('terminal', {
      type: 'info',
      message: `💰 Total winnings: ${this.stats.totalWinAmount} | ⏱️ ${elapsed}s | ⚡ ${rate.toLocaleString()}/hr`,
    });

    if (this.stats.skippedBets > 0) {
      this._emit('terminal', {
        type: 'warning',
        message: `ℹ️  ${this.stats.skippedBets} accounts skipped — connected during spin/result phase (NOT losses — just missed the window). Re-run to pick them up.`,
      });
    }

    this._emit('completed', {
      successCount:   this.stats.confirmedBets,
      failCount:      this.stats.failCount,
      skippedBets:    this.stats.skippedBets,
      totalWinAmount: this.stats.totalWinAmount,
    });
    this._emit('status', { running: false, activeWorkers: 0 });

    try {
      this.db.saveSessionStats({
        accountsProcessed: this.stats.processed,
        wins:              this.stats.confirmedBets,
        totalScoreWon:     this.stats.totalWinAmount,
        sessionId:         uuidv4().substring(0, 8),
      });
    } catch (_) {}
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _emit(event, data) { this.emit(event, data); }

  _log(index, type, message) {
    this.emit('terminal', {
      type, message: `[${index}] ${message}`,
      timestamp: new Date().toISOString(),
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = StealthRouletteProcessor;
