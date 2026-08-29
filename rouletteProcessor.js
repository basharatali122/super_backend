/**
 * rouletteProcessor.js — STEALTH ROULETTE (ZERO-LOSS EDITION)
 *
 * SELF-CONTAINED: proxyUtils inlined — no require('./proxyUtils') needed.
 *
 * ═══════════════════════════════════════════════════════════════
 *  ROOT CAUSE OF LOSSES (250/3000 accounts = ~8% loss rate)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Old code placed bet at a FIXED TIMER after connecting:
 *    setTimeout(() => gameWs.send(betPayload), 800-1800ms)
 *
 *  Roulette table has a strict round cycle:
 *    [BETTING OPEN ~20s] → [SPINNING ~5s] → [RESULT ~3s] → repeat
 *
 *  If bot connected during SPINNING or RESULT phase → bet arrived when
 *  server was not accepting bets → server silently dropped it → LOSS.
 *
 *  Manual play never loses because you SEE the table state and wait.
 *
 * ═══════════════════════════════════════════════════════════════
 *  THE FIX
 * ═══════════════════════════════════════════════════════════════
 *
 *  Server sends a route:31 response with current round phase.
 *  It also broadcasts automatic state-change messages.
 *
 *  New code:
 *   1. Sends route:31 after joining (same as before)
 *   2. WAITS for _isBettingOpen() to return true
 *   3. Bets the INSTANT the window opens
 *   4. If connected mid-spin → waits up to 35s for next window
 *   5. If no window in 35s → SKIPS cleanly (no bet = no loss)
 */

'use strict';

const WebSocket    = require('ws');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const dns          = require('dns').promises;
const net          = require('net');

// ═══════════════════════════════════════════════════════════════
//  INLINED PROXY UTILITIES (replaces require('./proxyUtils'))
// ═══════════════════════════════════════════════════════════════

/**
 * normalizeProxy — converts any proxy format to a canonical URL string.
 *
 * Supported formats:
 *   socks5h://user:pass@host:port   (pass-through)
 *   socks5://user:pass@host:port
 *   http://user:pass@host:port
 *   user:pass@host:port             (no scheme → socks5h://)
 *   host:port:user:pass             (common list format)
 */
function normalizeProxy(raw) {
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if (!raw) return null;

  const KNOWN_SCHEMES = ['socks5h://', 'socks5://', 'socks4a://', 'socks4://', 'http://', 'https://'];
  for (const scheme of KNOWN_SCHEMES) {
    if (raw.toLowerCase().startsWith(scheme)) {
      try { new URL(raw); return raw; } catch (_) { return null; }
    }
  }

  // Format: host:port:user:pass
  const hostPortUserPass = raw.match(/^([^:@\s]+):(\d+):([^:@\s]+):([^:@\s]+)$/);
  if (hostPortUserPass) {
    const [, host, port, user, pass] = hostPortUserPass;
    return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Format: user:pass@host:port
  const userPassAtHostPort = raw.match(/^([^@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/);
  if (userPassAtHostPort) {
    const [, user, pass, host, port] = userPassAtHostPort;
    return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  try {
    const attempt = `socks5h://${raw}`;
    new URL(attempt);
    return attempt;
  } catch (_) {}

  return null;
}

/**
 * makeProxyAgent — creates a WebSocket-compatible proxy agent.
 *
 * http/https proxies → hpagent HttpsProxyAgent (HTTP CONNECT tunnel)
 * socks proxies      → socks-proxy-agent SocksProxyAgent
 *
 * Special case: if proxy HOST is a domain (not IP), pre-resolves it
 * to avoid socks-proxy-agent v8 hostname auth bug.
 */
async function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;

  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    console.warn(`[proxy] Bad proxy URL: ${proxyUrl}`);
    return null;
  }

  let parsed;
  try { parsed = new URL(normalized); }
  catch (err) { console.warn(`[proxy] URL parse failed: ${err.message}`); return null; }

  const scheme = parsed.protocol;

  // HTTP / HTTPS proxy
  if (scheme === 'http:' || scheme === 'https:') {
    try {
      const { HttpsProxyAgent } = require('hpagent');
      return new HttpsProxyAgent({ proxy: normalized, timeout: 15000 });
    } catch (err) {
      console.warn(`[proxy] hpagent error: ${err.message}`);
      return null;
    }
  }

  // SOCKS proxy — resolve hostname to IP if needed (socks-proxy-agent v8 bug workaround)
  const proxyHost = parsed.hostname;
  const isIp      = net.isIP(proxyHost) !== 0;
  let   agentUrl  = normalized;

  if (!isIp) {
    try {
      const result    = await dns.lookup(proxyHost, { family: 4 });
      const withIp    = new URL(normalized);
      withIp.hostname = result.address;
      agentUrl        = withIp.toString();
    } catch (dnsErr) {
      console.warn(`[proxy] DNS resolve failed for ${proxyHost}: ${dnsErr.message} — using hostname`);
    }
  }

  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(agentUrl, { timeout: 15000 });
  } catch (err) {
    console.warn(`[proxy] SocksProxyAgent failed: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  FINGERPRINT & UA POOLS
// ═══════════════════════════════════════════════════════════════

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
  'Mozilla/5.0 (Linux; Android 14; SM-S928U Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.143 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-F946B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.163 Mobile Safari/537.36',
];

const HEADER_VARIATIONS = [
  { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
  { 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.8,en-CA;q=0.6', 'Accept-Encoding': 'gzip, deflate', 'Cache-Control': 'no-cache' },
  { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'en-US,en;q=0.7', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'application/json, */*', 'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'application/json', 'Accept-Language': 'en-CA,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
];

function rand(arr)            { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max)    { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ═══════════════════════════════════════════════════════════════
//  GLOBAL CONNECTION BUDGET (direct / no-proxy mode)
// ═══════════════════════════════════════════════════════════════

const globalConnectionTracker = {
  active:    0,
  MAX_TOTAL: 60,
  inc()       { this.active++; },
  dec()       { this.active = Math.max(0, this.active - 1); },
  available() { return Math.max(0, this.MAX_TOTAL - this.active); },
};

// ═══════════════════════════════════════════════════════════════
//  MAIN PROCESSOR CLASS
// ═══════════════════════════════════════════════════════════════

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
      successCount:   0,
      failCount:      0,
      confirmedBets:  0,
      skippedBets:    0,
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
      LOGIN_WS_URL:          'wss://game.milkywayapp.xyz:7878/',
      SUPER_ROULETTE_WS_URL: 'wss://game.milkywayapp.xyz:2152/',
      GAME_VERSION:          '2.0.1',

      WORKERS_PROXY:  30,
      WORKERS_DIRECT: 20,

      STAGGER_MS:     80,
      RETRY_ATTEMPTS: 1,

      TIMEOUTS: {
        LOGIN:           12000,
        GAME_CONNECT:     8000,
        // How long to wait for a betting window after connecting.
        // Roulette cycle: ~20s bet + 5s spin + 3s result = ~28s.
        // We wait 35s to cover slow servers.
        WAIT_FOR_BETTING: 35000,
        // How long to wait for result after placing bet.
        WAIT_FOR_RESULT:  15000,
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

    // Proxy setup
    if (useProxy && proxyList.length > 0) {
      this._proxyList = this._validateProxies(proxyList);
    }

    // Worker count
    let workerCount;
    if (useProxy && this._proxyList.length > 0) {
      workerCount = this.config.WORKERS_PROXY;
      this._emit('terminal', { type: 'info', message: `🛡️ PROXY ON: ${this._proxyList.length} IPs — 1 IP per worker slot` });
    } else {
      const safe = Math.floor(globalConnectionTracker.MAX_TOTAL / Math.max(1, activeUserCount));
      workerCount = Math.max(5, Math.min(this.config.WORKERS_DIRECT, safe));
      this._emit('terminal', { type: 'warning', message: `⚠️ NO PROXY — direct VPS IP. Workers: ${workerCount}` });
    }

    const all = await this.db.getAllAccounts();
    this.currentAccounts = accountIds.length > 0
      ? all.filter(a => accountIds.includes(a.id))
      : all;

    const estHourly = Math.round(workerCount * (3600 / 25));

    this._emit('terminal', { type: 'info', message: '🎰 SUPER ROULETTE BOT STARTED (ZERO-LOSS EDITION)' });
    this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length} | Workers: ${workerCount} | Bet: ${this.getCurrentBetAmount()} | Est: ~${estHourly.toLocaleString()}/hr` });
    this._emit('terminal', { type: 'info', message: `🔑 Login: ${this.config.LOGIN_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `🎮 Game:  ${this.config.SUPER_ROULETTE_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `✅ Bet timing: WAITS for betting window — no blind bets — no losses` });
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
      const normalized = normalizeProxy(s);
      if (normalized) valid.push(normalized); else bad.push(s);
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

    if (result.skipped) {
      this.stats.skippedBets++;
      this._emit('progress', { index: globalIndex, total: this.currentAccounts.length, account: account.username, success: false, skipped: true, winAmount: 0 });
      return result;
    }

    if (result.confirmed) {
      this.stats.successCount++;
      this.stats.confirmedBets++;
      this.stats.totalWinAmount += (result.winCredit || 0);
      this.emit('betUpdate', { winAmount: result.winCredit, currentBet: this.getCurrentBetAmount() });
      this._emit('progress', { index: globalIndex, total: this.currentAccounts.length, account: account.username, success: true, winAmount: result.winCredit || 0 });
      return result;
    }

    if (!result.confirmed && attempt < this.config.RETRY_ATTEMPTS) {
      this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1} — ${result.error}`);
      await this._sleep(300 + Math.floor(Math.random() * 200));
      return this._processWithRetry(account, globalIndex, slotIndex, attempt + 1);
    }

    this.stats.failCount++;
    return result;
  }

  // ── Full session: Login → Game → Wait for window → Bet → Result ───────────────

  async _runAccountSession(account, index, slotIndex) {
    const sessionId = uuidv4().substring(0, 8);
    const userAgent = rand(MOBILE_USER_AGENTS);
    const headers   = rand(HEADER_VARIATIONS);
    const proxyUrl  = this._getProxyForSlot(slotIndex);

    this._log(index, 'info', `[${sessionId}] ${account.username}`);

    // Phase 1: Login
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

    // Phase 2: Game — enter room, wait for betting window, bet, get result
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
        try { const agent = await makeProxyAgent(proxyUrl); if (agent) wsOptions.agent = agent; } catch (_) {}
      }

      try { ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions); }
      catch (err) { clearTimeout(timer); return resolve({ success: false, error: `Login WS: ${err.message}` }); }

      ws.on('open', () => {
        ws.send(JSON.stringify({
          account: account.username, password: account.password,
          version: this.config.GAME_VERSION, mainID: 100, subID: 6,
        }));
      });

      ws.on('message', (raw) => {
        if (done) return;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.mainID === 100 && msg.subID === 116) {
            if (msg.data?.result === 0) {
              this._log(index, 'success', `✅ Login ${Date.now() - startTime}ms`);
              finish({
                success: true,
                accountData: {
                  userid: msg.data.userid, dynamicpass: msg.data.dynamicpass,
                  bossid: msg.data.bossid, gameid: msg.data.gameid, score: msg.data.score,
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

  // ── Game WebSocket (Connection 2) — THE CORE FIX ─────────────────────────────
  //
  // KEY DIFFERENCE FROM OLD CODE:
  //   OLD: setTimeout(sendBet, 800-1800ms)  — blind, causes losses
  //   NEW: wait for _isBettingOpen() signal, THEN bet
  //
  // The server sends a route:31 response and periodic broadcasts.
  // We check every message. Bet fires the instant the window is confirmed open.

  _gameBetAndResult(account, userAgent, headers, proxyUrl, index, sessionId) {
    return new Promise(async (resolve) => {
      let ws           = null;
      let done         = false;
      let closed       = false;
      let betSent      = false;
      let heartbeatIv  = null;
      let resultTimer  = null;
      let windowTimer  = null;

      // Hard session deadline
      const sessionTimer = setTimeout(() => {
        if (!done) {
          this._log(index, 'warning', `⏰ Session deadline — ${betSent ? 'no result after bet' : 'window never opened'}`);
          finish(betSent
            ? { confirmed: false, error: 'No result received after bet' }
            : { confirmed: false, skipped: true, error: 'Betting window never opened — skipped' }
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

      // Called when betting window confirmed open — send bet immediately
      const sendBet = () => {
        if (betSent || done || !ws || ws.readyState !== WebSocket.OPEN) return;
        betSent = true;
        const amount = this.getCurrentBetAmount();
        this._log(index, 'info', `🎯 Betting window OPEN → placing bet ${amount}`);
        ws.send(JSON.stringify(this._createBetPayload()));

        // Start result wait timer
        resultTimer = setTimeout(() => {
          if (!done) {
            this._log(index, 'warning', `⏰ Result timeout after bet`);
            finish({ confirmed: false, error: 'Result timeout after bet sent' });
          }
        }, this.config.TIMEOUTS.WAIT_FOR_RESULT);
      };

      const wsOptions = {
        handshakeTimeout: this.config.TIMEOUTS.GAME_CONNECT,
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };

      if (proxyUrl) {
        try { const agent = await makeProxyAgent(proxyUrl); if (agent) wsOptions.agent = agent; } catch (_) {}
      }

      try { ws = new WebSocket(this.config.SUPER_ROULETTE_WS_URL, ['wl'], wsOptions); }
      catch (err) { clearTimeout(sessionTimer); return resolve({ confirmed: false, error: `Game WS: ${err.message}` }); }

      ws.on('open', () => {
        this._log(index, 'success', `🎮 Game connected`);

        const send = (payload, delay) => setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN && !done) ws.send(JSON.stringify(payload));
        }, delay);

        // Room entry sequence (matches manual play)
        send({ mainID: 1, subID: 5, userid: account.userid, password: account.dynamicpass }, 50);
        send({ mainID: 1, subID: 4, gameid: account.gameid || 10658796, password: account.dynamicpass, reenter: 0 }, 200);
        send({ route: 31, mainID: 200, subID: 100 }, 400); // ← request table state
        send({ mainID: 1, subID: 6, bossid: account.bossid }, 600);

        // Heartbeat to keep connection alive while waiting for window
        heartbeatIv = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN && !done) {
            ws.send(JSON.stringify({ mainID: 1, subID: 6, bossid: account.bossid }));
          }
        }, 5000);

        // Skip timer — if window never opens in WAIT_FOR_BETTING ms → skip cleanly
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

          // Track balance
          if (msg.mainID === 1 && msg.subID === 104 && msg.data?.score != null) {
            account.score = msg.data.score;
          }

          if (msg.mainID === 200 && msg.subID === 100) {
            const d = msg.data || {};

            // Route 31: table state response — check if betting window is open
            if (d.route === 31) {
              this._log(index, 'info', `🎲 Table state: status=${d.status} phase=${d.phase} bettingOpen=${d.bettingOpen}`);
              if (this._isBettingOpen(d) && !betSent) {
                clearTimeout(windowTimer);
                sendBet();
              } else if (!this._isBettingOpen(d)) {
                this._log(index, 'info', `⏳ Waiting for next betting window (status:${d.status})...`);
              }
              return;
            }

            // Route 39: bet result
            if (d.route === 39 && betSent) {
              const winCredit    = d.winCredit    || 0;
              const playerCredit = d.playerCredit || account.score;
              account.score = playerCredit;
              this._log(index, 'success', `🎉 BET CONFIRMED | Win:${winCredit} | Bal:${playerCredit}`);
              finish({ confirmed: true, winCredit, newBalance: playerCredit });
              return;
            }

            // Any other message — check for betting-open broadcast
            if (!betSent && this._isBettingOpen(d)) {
              this._log(index, 'info', `🟢 Betting window broadcast → betting now`);
              clearTimeout(windowTimer);
              sendBet();
            }
          }

          // Catch-all for servers using different mainID for broadcasts
          if (!betSent && msg.data && this._isBettingOpen(msg.data)) {
            this._log(index, 'info', `🟢 Betting signal (mainID:${msg.mainID} subID:${msg.subID})`);
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
            ? { confirmed: false, error: 'Game WS closed after bet — no result' }
            : { confirmed: false, skipped: true, error: 'Game WS closed before bet' }
          );
        }
      });
    });
  }

  /**
   * _isBettingOpen — checks a message data object for any betting-window signal.
   *
   * Returns true ONLY when we are certain the window is open.
   * A bet sent when this returns false = dropped by server = loss.
   * We check every known signal pattern from live server captures.
   */
  _isBettingOpen(d) {
    if (!d) return false;

    // status field: 1=betting open, 2=spinning, 3=result
    if (d.status === 1)                     return true;
    if (d.status === 2 || d.status === 3)   return false;

    // phase field
    if (d.phase === 1 || d.phase === 'bet' || d.phase === 'betting') return true;
    if (d.phase === 2 || d.phase === 3)                              return false;

    // explicit boolean
    if (d.bettingOpen === true)  return true;
    if (d.bettingOpen === false) return false;

    // state string
    if (typeof d.state === 'string') {
      const s = d.state.toLowerCase();
      if (s === 'betting' || s === 'open' || s === 'bet') return true;
      if (s === 'spinning' || s === 'spin' || s === 'result' || s === 'settle') return false;
    }

    // countdown/timer fields (betting open = time remaining > 0)
    if (typeof d.countDown === 'number' && d.countDown > 0) return true;
    if (typeof d.betTime   === 'number' && d.betTime   > 0) return true;

    return false;
  }

  // ── Completion ────────────────────────────────────────────────────────────────

  _complete() {
    this.isProcessing = false;
    const elapsed = this.stats.startTime
      ? ((Date.now() - this.stats.startTime) / 1000).toFixed(1) : '?';
    const rate = elapsed > 0 ? Math.round((this.stats.processed / elapsed) * 3600) : 0;

    this._emit('terminal', { type: 'success', message: '\n🎉 ALL DONE!' });
    this._emit('terminal', {
      type: 'info',
      message: `✅ Bets confirmed: ${this.stats.confirmedBets} | ⏭️ Skipped: ${this.stats.skippedBets} | ❌ Errors: ${this.stats.failCount}`,
    });
    this._emit('terminal', {
      type: 'info',
      message: `💰 Total winnings: ${this.stats.totalWinAmount} | ⏱️ ${elapsed}s | ⚡ ${rate.toLocaleString()}/hr`,
    });

    if (this.stats.skippedBets > 0) {
      this._emit('terminal', {
        type: 'warning',
        message: `ℹ️  ${this.stats.skippedBets} skipped (connected mid-spin, not losses). Re-run to pick them up.`,
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
    this.emit('terminal', { type, message: `[${index}] ${message}`, timestamp: new Date().toISOString() });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = StealthRouletteProcessor;
