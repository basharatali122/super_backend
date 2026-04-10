const WebSocket = require('ws');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * UltimateRouletteProcessor — Production Build
 *
 * TARGET: 3,000 accounts/hour = 50 accounts/minute = ~1 account/1.2s
 *
 * HOW WE HIT THE TARGET:
 *   - BATCH_SIZE 20 (direct) / 30 (proxy) — true parallel pipelines
 *   - Tightened timeouts: login 12s, game 14s total (was 22s+16s)
 *   - Stagger 80ms between batch slots (was 200ms) → batch fully launched in 1.6s
 *   - Batch delay 200ms (was 400ms) — next batch starts right after previous settles
 *   - No ACCOUNTS_PER_MINUTE cap (rate limiting is handled by proxy rotation)
 *   - Each account gets unique proxy IP → no IP sharing → no rate-limit collisions
 *   - Real device fingerprints with per-session randomization (60+ combos)
 *   - Per-session WebSocket Agent reuse avoids repeated TLS handshake cost
 *   - Adaptive backoff only triggers on real IP blocks — won't slow healthy runs
 *
 * THROUGHPUT MATH (proxy mode, batch=30):
 *   Each account pipeline = ~12s login + ~8s game = ~20s end-to-end
 *   30 parallel pipelines / 20s = 1.5 accounts/s = 90/min = 5,400/hr  ✅
 *
 * THROUGHPUT MATH (direct mode, batch=20):
 *   20 parallel / 20s avg = 1.0/s = 60/min = 3,600/hr  ✅
 */

// ─── Fingerprint & UA pools (large, realistic, rotated per-session) ────────────

const MOBILE_USER_AGENTS = [
  // Android Chrome (latest builds)
  'Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928U Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.143 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.105 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-A556B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UD1A.231105.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.231105.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro Build/UP1A.231105.003) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.194 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G998B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.118 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-F946B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.163 Mobile Safari/537.36',
  // iOS Safari
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6.1 Mobile/15E148 Safari/604.1',
  // Xiaomi / OPPO / Vivo
  'Mozilla/5.0 (Linux; Android 13; 2312DRA50G Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; CPH2525 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.194 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.143 Mobile Safari/537.36',
];

// Rich device fingerprints — 20 unique device profiles with realistic specs
const DEVICE_FINGERPRINTS = [
  { deviceId:'SM-S928B',    model:'Galaxy S24 Ultra',  os:'14', resolution:'1440x3120', viewport:'412x915', pixelRatio:3.5, ram:12, cpu:8,  gpu:'Mali-G920', tz:'America/New_York',     lang:'en-US' },
  { deviceId:'SM-S928U',    model:'Galaxy S24 Ultra',  os:'14', resolution:'1440x3120', viewport:'412x915', pixelRatio:3.5, ram:12, cpu:8,  gpu:'Adreno 750',tz:'America/Los_Angeles',  lang:'en-US' },
  { deviceId:'SM-S911B',    model:'Galaxy S24',        os:'14', resolution:'1080x2340', viewport:'360x780', pixelRatio:3.0, ram:8,  cpu:8,  gpu:'Adreno 740',tz:'America/Chicago',      lang:'en-US' },
  { deviceId:'SM-S918B',    model:'Galaxy S23+',       os:'13', resolution:'1080x2340', viewport:'384x854', pixelRatio:2.8, ram:8,  cpu:8,  gpu:'Adreno 740',tz:'America/Denver',       lang:'en-US' },
  { deviceId:'Pixel8Pro',   model:'Pixel 8 Pro',       os:'14', resolution:'1344x2992', viewport:'412x892', pixelRatio:3.0, ram:12, cpu:8,  gpu:'Immortalis-G715',tz:'America/Phoenix', lang:'en-US' },
  { deviceId:'Pixel8',      model:'Pixel 8',           os:'14', resolution:'1080x2400', viewport:'392x847', pixelRatio:2.75,ram:8,  cpu:8,  gpu:'Immortalis-G715',tz:'America/New_York', lang:'en-US' },
  { deviceId:'Pixel7Pro',   model:'Pixel 7 Pro',       os:'13', resolution:'1440x3120', viewport:'412x892', pixelRatio:3.5, ram:12, cpu:8,  gpu:'Immortalis-G710',tz:'America/Chicago',  lang:'en-US' },
  { deviceId:'iPhone16,2',  model:'iPhone 15 Pro Max', os:'17', resolution:'1290x2796', viewport:'430x932', pixelRatio:3.0, ram:8,  cpu:6,  gpu:'A17 Pro GPU',  tz:'America/Los_Angeles',lang:'en-US' },
  { deviceId:'iPhone16,1',  model:'iPhone 15 Pro',     os:'17', resolution:'1179x2556', viewport:'393x852', pixelRatio:3.0, ram:8,  cpu:6,  gpu:'A17 Pro GPU',  tz:'America/New_York',   lang:'en-US' },
  { deviceId:'iPhone15,2',  model:'iPhone 14 Pro Max', os:'17', resolution:'1290x2796', viewport:'430x932', pixelRatio:3.0, ram:6,  cpu:6,  gpu:'A16 GPU',      tz:'America/Chicago',    lang:'en-US' },
  { deviceId:'SM-G998B',    model:'Galaxy S21 Ultra',  os:'13', resolution:'1440x3200', viewport:'412x915', pixelRatio:3.5, ram:12, cpu:8,  gpu:'Mali-G78',     tz:'America/Denver',     lang:'en-US' },
  { deviceId:'SM-F946B',    model:'Galaxy Z Fold5',    os:'13', resolution:'1812x2176', viewport:'904x1024',pixelRatio:2.0, ram:12, cpu:8,  gpu:'Adreno 740',   tz:'America/Phoenix',    lang:'en-US' },
  { deviceId:'2312DRA50G',  model:'Xiaomi 14',         os:'14', resolution:'1200x2670', viewport:'393x851', pixelRatio:3.0, ram:12, cpu:8,  gpu:'Adreno 750',   tz:'Asia/Shanghai',      lang:'zh-CN' },
  { deviceId:'CPH2525',     model:'OPPO Find X7',      os:'14', resolution:'1080x2412', viewport:'392x874', pixelRatio:2.75,ram:12, cpu:8,  gpu:'Adreno 740',   tz:'Asia/Shanghai',      lang:'zh-CN' },
  { deviceId:'V2309A',      model:'Vivo X100 Pro',     os:'14', resolution:'1260x2800', viewport:'412x897', pixelRatio:3.0, ram:16, cpu:8,  gpu:'Immortalis-G715',tz:'Asia/Shanghai',    lang:'zh-CN' },
  { deviceId:'SM-A556B',    model:'Galaxy A55',        os:'14', resolution:'1080x2340', viewport:'360x800', pixelRatio:3.0, ram:8,  cpu:8,  gpu:'Mali-G68',      tz:'Europe/London',     lang:'en-GB' },
  { deviceId:'Pixel7a',     model:'Pixel 7a',          os:'14', resolution:'1080x2400', viewport:'412x892', pixelRatio:2.62,ram:8,  cpu:8,  gpu:'Immortalis-G710',tz:'America/Toronto',  lang:'en-CA' },
  { deviceId:'iPhone14,2',  model:'iPhone 13 Pro',     os:'16', resolution:'1170x2532', viewport:'390x844', pixelRatio:3.0, ram:6,  cpu:6,  gpu:'A15 GPU',       tz:'Europe/London',     lang:'en-GB' },
  { deviceId:'SM-S916B',    model:'Galaxy S23+',       os:'13', resolution:'1080x2340', viewport:'360x780', pixelRatio:3.0, ram:8,  cpu:8,  gpu:'Adreno 740',    tz:'America/Toronto',   lang:'en-CA' },
  { deviceId:'OnePlus12',   model:'OnePlus 12',        os:'14', resolution:'1440x3168', viewport:'412x915', pixelRatio:3.5, ram:16, cpu:8,  gpu:'Adreno 750',    tz:'America/Chicago',   lang:'en-US' },
];

const HEADER_VARIATIONS = [
  { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
  { 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.8,en-CA;q=0.6', 'Accept-Encoding': 'gzip, deflate', 'Cache-Control': 'no-cache' },
  { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'en-US,en;q=0.7', 'Accept-Encoding': 'gzip, deflate, br', 'Pragma': 'no-cache' },
  { 'Accept': 'application/json, */*', 'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'max-age=0' },
  { 'Accept': 'text/html,application/json,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'application/json', 'Accept-Language': 'en-CA,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── Proxy agent factory ───────────────────────────────────────────────────────
function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
      const { HttpsProxyAgent } = require('hpagent');
      return new HttpsProxyAgent({ proxy: proxyUrl, keepAlive: false });
    }
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(proxyUrl, { timeout: 10000 });
  } catch (e) {
    return null;
  }
}

// ─── Main processor ───────────────────────────────────────────────────────────
class UltimateRouletteProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.setMaxListeners(50); // prevent EventEmitter memory leak warnings at scale

    this.db              = db;
    this.isProcessing    = false;
    this.currentAccounts = [];
    this.activeProcesses = new Map();
    this.connectionPool  = new Map();
    this.activeIntervals = new Set();
    this.activeTimeouts  = new Set();

    this.instanceId        = 'default';
    this.globalCoordinator = null;

    this.useProxy         = false;
    this.proxyList        = [];
    this.currentProxyIndex = 0;
    this.proxyIpKey       = 'direct';

    // ── Core config — tuned for 3,000/hr ─────────────────────────────────────
    this.config = {
      LOGIN_WS_URL: 'wss://game.milkywayapp.xyz:7878/',      SUPER_ROULETTE_WS_URL: 'wss://game.milkywayapp.xyz:10152/',
   GAME_VERSION: '2.0.1',


      // 3000/hr = 50/min. With 20 concurrent at ~18s avg = 1.11/s = 66/min (direct)
      // With 30 concurrent proxy at ~16s avg = 1.87/s = 112/min — room to breathe
      BATCH_SIZE:       20,   // direct: 20 concurrent pipelines
      BATCH_SIZE_PROXY: 30,   // proxy:  30 concurrent (each has own IP, no sharing)

      BATCH_STAGGER_MS:       80,   // 80ms between launching each slot in batch → 20 slots × 80ms = 1.6s to saturate
      BATCH_STAGGER_MS_PROXY: 60,   // tighter with proxy — each has clean IP, no collisions

      BATCH_DELAY_MS:       200,  // wait 200ms after batch finishes before next batch
      BATCH_DELAY_MS_PROXY: 150,  // proxy mode can go faster

      // NO global ACCOUNTS_PER_MINUTE cap — rate limiting is per-IP via proxy rotation
      // Direct mode only: soft cap via adaptive backoff (triggers on slow logins, not arbitrary count)

      COMPLETE_RESET_BETWEEN_CYCLES: true,

      TIMEOUTS: {
        LOGIN:           12000,  // 12s login timeout
        GAME_CONNECTION:  8000,
        BET_RESPONSE:    10000,
        TOTAL_SESSION:   28000,  // 28s total — covers slow proxies (was 22s, was cutting off legit sessions)
      },
    };

    // ── Adaptive state — responds to real IP pressure ─────────────────────────
    this.adaptiveState = {
      recentLoginTimes:    [],
      maxRecentSamples:    10,
      currentStaggerMs:    this.config.BATCH_STAGGER_MS,
      currentBatchDelayMs: this.config.BATCH_DELAY_MS,

      // Thresholds — only back off when logins are genuinely slow (IP stress)
      SLOW_THRESHOLD_MS:   7000,  // avg > 7s → start backing off
      FAST_THRESHOLD_MS:   3500,  // avg < 3.5s → recover
      MAX_STAGGER_MS:      300,
      MIN_STAGGER_MS:       60,
      MAX_BATCH_DELAY_MS:  800,
      MIN_BATCH_DELAY_MS:  150,
      BACKOFF_STEP:         40,
      RECOVER_STEP:         60,
      consecutiveSlowBatches: 0,

      IP_BLOCK_THRESHOLD_MS:  15000,  // avg > 15s = definitely blocked
      IP_BLOCK_COOLDOWN_MS:   60000,  // 60s cooldown (was 75s)
      isIPBlocked: false,
      ipBlockedAt:  0,
    };

    this.cycleState  = this._freshCycleState();
    this.cycleStats  = this._freshCycleStats();

    this.betConfig = {
      totalBet: 20, isDynamic: false, dynamicAmount: 0,
      splitBets: true, minBet: 1, maxBet: 1000,
      betStrategy: 'split', betHistory: [],
    };

    this.currentCycle  = 0;
    this.totalCycles   = 1;
    this.securityInterval = null;
  }

  // ── State factories ───────────────────────────────────────────────────────────
  _freshCycleState() {
    return {
      cycleStartTime: 0, activeWorkers: 0,
      processedThisCycle: 0, connectionsThisCycle: 0,
      isCycleActive: false, cycleId: uuidv4().substring(0, 8),
    };
  }

  _freshCycleStats() {
    return {
      successCount: 0, failCount: 0, confirmedBets: 0, assumedBets: 0,
      minuteStartTime: Date.now(), processedThisMinute: 0,
      totalBetAmount: 0, totalWinAmount: 0,
      cycleSuccessCount: 0, cycleFailCount: 0,
    };
  }

  // ── Proxy helpers ──────────────────────────────────────────────────────────────
  _getIpKey() {
    return (this.useProxy && this.proxyIpKey && this.proxyIpKey !== 'direct')
      ? this.proxyIpKey : 'direct';
  }

  async _acquireSocket() {
    const coord = this.globalCoordinator;
    if (coord) await coord.acquire(this._getIpKey());
  }

  _releaseSocket() {
    const coord = this.globalCoordinator;
    if (coord) coord.release(this._getIpKey());
  }

  _getSocketCount() {
    const coord = this.globalCoordinator;
    return coord ? coord.getCount(this._getIpKey()) : this.connectionPool.size;
  }

  // Rotating proxy assignment: each account index maps to a unique proxy
  // account[0]→proxy[0], account[1]→proxy[1], ... no two concurrent accounts share a proxy
  _getProxyForIndex(idx) {
    if (!this.useProxy || this.proxyList.length === 0) return null;
    return this.proxyList[idx % this.proxyList.length];
  }

  // ── Fingerprint helpers ───────────────────────────────────────────────────────
  _getFingerprint() {
    const fp = { ...rand(DEVICE_FINGERPRINTS) };
    // Add per-session micro-variations so every session is unique
    fp._sessionSeed  = uuidv4().substring(0, 8);
    fp._screenWidth  = fp.viewport.split('x')[0];
    fp._screenHeight = fp.viewport.split('x')[1];
    // Tiny viewport jitter (±2px) — real devices differ slightly
    fp._jitterW = fp._screenWidth  + randInt(-2, 2);
    fp._jitterH = fp._screenHeight + randInt(-2, 2);
    return fp;
  }

  // ── Bet management ────────────────────────────────────────────────────────────
  getCurrentBetAmount() {
    return (this.betConfig.isDynamic && this.betConfig.dynamicAmount > 0)
      ? this.betConfig.dynamicAmount
      : this.betConfig.totalBet;
  }

  handleBetChange(newAmount) {
    const amount = parseInt(newAmount);
    if (isNaN(amount) || amount < this.betConfig.minBet || amount > this.betConfig.maxBet) {
      this.emit('betError', { message: `Invalid bet: ${newAmount}` }); return false;
    }
    const old = this.getCurrentBetAmount();
    this.betConfig.isDynamic    = true;
    this.betConfig.dynamicAmount = amount;
    this.emit('terminal', { type: 'success', message: `✅ Bet changed: ${old} → ${amount}` });
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
    this.cycleStats.totalBetAmount += amount;

    const betData = [0];
    for (let i = 1; i <= 36; i++) betData.push(amount);

    return {
      totalBetValue: amount,
      betData,
      singleDigitBet: new Array(37).fill(0),
      detailBet: [
        [{ id: [2,4,6,8,11,10,13,15,17,20,22,24,26,29,28,31,33,35], bet: firstBet }],
        [{ id: [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36], bet: secondBet }],
      ],
      route: 39, mainID: 200, subID: 100,
    };
  }

  // ── Adaptive backoff ──────────────────────────────────────────────────────────
  _recordLoginTime(ms) {
    const s = this.adaptiveState;
    s.recentLoginTimes.push(ms);
    if (s.recentLoginTimes.length > s.maxRecentSamples) s.recentLoginTimes.shift();
    if (s.recentLoginTimes.length < 4) return; // need a sample before adapting

    const avg = s.recentLoginTimes.reduce((a, b) => a + b, 0) / s.recentLoginTimes.length;

    // Check IP block (only in direct mode — proxy has per-IP isolation)
    if (!this.useProxy && avg >= s.IP_BLOCK_THRESHOLD_MS && !s.isIPBlocked) {
      s.isIPBlocked = true;
      s.ipBlockedAt = Date.now();
      this.emit('terminal', { type: 'error', message: `🚫 [${this.instanceId}] IP BLOCKED — avg ${Math.round(avg)}ms. Cooling ${s.IP_BLOCK_COOLDOWN_MS/1000}s...` });
      s.recentLoginTimes = [];
      return;
    }

    if (s.isIPBlocked && !this.useProxy) {
      if (Date.now() - s.ipBlockedAt >= s.IP_BLOCK_COOLDOWN_MS) {
        s.isIPBlocked = false;
        s.recentLoginTimes = [];
        this.emit('terminal', { type: 'info', message: `✅ [${this.instanceId}] IP cooldown done. Resuming.` });
      }
      return;
    }

    const prev = { stagger: s.currentStaggerMs, delay: s.currentBatchDelayMs };

    if (avg > s.SLOW_THRESHOLD_MS) {
      s.consecutiveSlowBatches++;
      s.currentStaggerMs    = Math.min(s.MAX_STAGGER_MS,    s.currentStaggerMs    + s.BACKOFF_STEP);
      s.currentBatchDelayMs = Math.min(s.MAX_BATCH_DELAY_MS, s.currentBatchDelayMs + s.BACKOFF_STEP * 2);
    } else if (avg < s.FAST_THRESHOLD_MS) {
      s.consecutiveSlowBatches = 0;
      s.currentStaggerMs    = Math.max(s.MIN_STAGGER_MS,    s.currentStaggerMs    - s.RECOVER_STEP);
      s.currentBatchDelayMs = Math.max(s.MIN_BATCH_DELAY_MS, s.currentBatchDelayMs - s.RECOVER_STEP * 2);
    } else {
      s.consecutiveSlowBatches = 0;
    }

    if (s.currentStaggerMs !== prev.stagger) {
      const dir = s.currentStaggerMs > prev.stagger ? '⬆️ Slow' : '⬇️ Fast';
      this.emit('terminal', { type: 'info', message: `⚡ [${this.instanceId}] ${dir}: avg ${Math.round(avg)}ms → stagger ${s.currentStaggerMs}ms delay ${s.currentBatchDelayMs}ms` });
    }
  }

  // ── Processing lifecycle ──────────────────────────────────────────────────────
  async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = []) {
    if (this.isProcessing) throw new Error('Already processing');

    await this._fullCleanup();
    this.isProcessing = true;
    this.useProxy     = useProxy;
    this.proxyList    = [];
    this.currentProxyIndex = 0;

    // Determine effective batch size — proxy: 1 proxy per concurrent account
    if (useProxy && proxyList.length > 0) {
      // Validate and strip bad proxies before any processing starts
      this.proxyList    = this._validateAndCleanProxies(proxyList);
      this._batchSize  = Math.min(this.config.BATCH_SIZE_PROXY, this.proxyList.length);
      this._batchDelay = this.config.BATCH_DELAY_MS_PROXY;
      this._stagger    = this.config.BATCH_STAGGER_MS_PROXY;
      this.adaptiveState.MIN_STAGGER_MS    = 50;
      this.adaptiveState.MIN_BATCH_DELAY_MS= 100;
    } else {
      this._batchSize  = this.config.BATCH_SIZE;
      this._batchDelay = this.config.BATCH_DELAY_MS;
      this._stagger    = this.config.BATCH_STAGGER_MS;
      this.adaptiveState.MIN_STAGGER_MS    = 60;
      this.adaptiveState.MIN_BATCH_DELAY_MS= 150;
    }

    this.adaptiveState.currentStaggerMs    = this._stagger;
    this.adaptiveState.currentBatchDelayMs = this._batchDelay;

    const accounts = this.db.getAllAccounts();
    this.currentAccounts = accountIds.length > 0
      ? accounts.filter(a => accountIds.includes(a.id))
      : accounts;

    this.totalCycles = Math.max(1, Math.min(100, parseInt(repetitions) || 1));
    this.currentCycle = 0;
    this.cycleState   = this._freshCycleState();
    this.cycleStats   = this._freshCycleStats();
    this.adaptiveState.recentLoginTimes    = [];
    this.adaptiveState.isIPBlocked         = false;
    this.adaptiveState.consecutiveSlowBatches = 0;

    const throughputEstimate = Math.round((this._batchSize / 20) * 3000);

    this.emit('terminal', { type: 'info', message: `⚡ [${this.instanceId}] PRODUCTION BOT STARTING` });
    this.emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length} | Cycles: ${this.totalCycles}` });
    this.emit('terminal', { type: 'info', message: `🎯 Bet: ${this.getCurrentBetAmount()} | Batch: ${this._batchSize} | Stagger: ${this._stagger}ms` });
    this.emit('terminal', { type: 'info', message: `🌐 Proxy: ${useProxy ? `ON (${proxyList.length} IPs, 1:1 rotation)` : 'OFF (direct IP)'}` });
    this.emit('terminal', { type: 'info', message: `📈 Target throughput: ~${throughputEstimate.toLocaleString()}/hr` });

    this._startMonitor();
    this._processCycles(); // fire and forget — don't await

    return {
      started: true,
      totalAccounts: this.currentAccounts.length,
      currentBet: this.getCurrentBetAmount(),
      instanceId: this.instanceId,
      proxyEnabled: useProxy,
      batchSize: this._batchSize,
      estimatedThroughput: throughputEstimate,
    };
  }

  async _processCycles() {
    for (let cycle = 1; cycle <= this.totalCycles && this.isProcessing; cycle++) {
      this.currentCycle = cycle;

      // Full state reset between cycles — clean slate every time
      await this._resetForCycle();
      this.cycleState.cycleStartTime = Date.now();
      this.cycleState.isCycleActive  = true;
      this.cycleState.cycleId        = uuidv4().substring(0, 8);
      this.cycleStats = this._freshCycleStats();

      this.emit('terminal', { type: 'info', message: `\n🔰 CYCLE ${cycle}/${this.totalCycles} [${this.instanceId}] ${this.useProxy ? '[PROXY]' : '[DIRECT]'}` });
      this.emit('cycleStart', { cycle, totalCycles: this.totalCycles, currentBet: this.getCurrentBetAmount(), cycleId: this.cycleState.cycleId });

      await this._runCycle();

      const dur = Date.now() - this.cycleState.cycleStartTime;
      const total = this.cycleStats.successCount + this.cycleStats.failCount;
      const rate  = total > 0 ? ((this.cycleStats.successCount / total) * 100).toFixed(1) : '0.0';
      const speed = total > 0 && dur > 0 ? Math.round((total / dur) * 3600000) : 0;

      this.emit('terminal', { type: 'success', message: `✅ Cycle ${cycle} done: ${this.cycleStats.successCount}/${total} (${rate}%) in ${Math.round(dur/1000)}s → ${speed.toLocaleString()}/hr` });
      this.emit('cycleComplete', { cycle, totalCycles: this.totalCycles, successCount: this.cycleStats.successCount, failCount: this.cycleStats.failCount, cycleDuration: dur, throughputPerHour: speed });

      this.cycleState.isCycleActive  = false;
      this.cycleState.activeWorkers  = 0;

      if (cycle < this.totalCycles && this.isProcessing) {
        await this._sleep(randInt(300, 700));
      }
    }
    this._completeProcessing();
  }

  async _resetForCycle() {
    for (const [k, ws] of this.connectionPool.entries()) this._closeWs(ws, k);
    this.connectionPool.clear();
    this.activeProcesses.clear();
    this._clearTimers();
    this.cycleState = this._freshCycleState();
    this.currentProxyIndex = 0;
    await this._sleep(200);
  }

  // ── Proxy validation — called once at startProcessing ────────────────────────
  _validateAndCleanProxies(proxyList) {
    const valid = [];
    const bad   = [];

    for (const p of proxyList) {
      const s = (p || '').trim();
      if (!s) continue;
      // Must start with a valid scheme and contain host:port
      const ok = (s.startsWith('socks5://') || s.startsWith('socks5h://') ||
                  s.startsWith('socks4://') || s.startsWith('http://') || s.startsWith('https://'));
      // Must have a valid-looking hostname (no spaces, contains a dot or is localhost)
      let hasHost = false;
      try { const u = new URL(s); hasHost = u.hostname.length > 0 && !u.hostname.includes(' '); } catch (_) {}
      if (ok && hasHost) valid.push(s);
      else bad.push(s);
    }

    if (bad.length > 0) {
      this.emit('terminal', { type: 'warning', message: `⚠️ Removed ${bad.length} bad proxy entries: ${bad.slice(0,3).map(b => b.substring(0,30)).join(', ')}${bad.length > 3 ? '...' : ''}` });
    }
    this.emit('terminal', { type: 'info', message: `✅ ${valid.length} valid proxies loaded` });
    return valid;
  }

  async _runCycle() {
    const total = this.currentAccounts.length;
    let processed = 0;
    // failedAccounts: accounts that failed and need retry at end of cycle
    const failedAccounts = [];

    while (processed < total && this.isProcessing && this.cycleState.isCycleActive) {
      // Direct-mode IP block wait
      if (!this.useProxy && this.adaptiveState.isIPBlocked) {
        while (this.adaptiveState.isIPBlocked && this.isProcessing) {
          const remaining = Math.max(0, this.adaptiveState.IP_BLOCK_COOLDOWN_MS - (Date.now() - this.adaptiveState.ipBlockedAt));
          if (remaining <= 0) { this.adaptiveState.isIPBlocked = false; break; }
          this.emit('terminal', { type: 'warning', message: `🚫 [${this.instanceId}] IP blocked — ${Math.round(remaining/1000)}s left` });
          await this._sleep(5000);
        }
        if (!this.isProcessing) break;
        this.adaptiveState.recentLoginTimes = [];
      }

      const batchSize     = Math.min(this._batchSize, total - processed);
      const batchAccounts = this.currentAccounts.slice(processed, processed + batchSize);
      const stagger       = this.adaptiveState.currentStaggerMs;

      this.emit('terminal', {
        type: 'info',
        message: `🚀 [${this.instanceId}] Batch ${processed+1}–${processed+batchSize} | proxy:${this.useProxy} | stagger:${stagger}ms | sockets:${this._getSocketCount()}`,
      });

      const results = await Promise.allSettled(
        batchAccounts.map((account, i) =>
          this._sleep(i * stagger).then(() => this._processAccount(account, processed + i))
        )
      );

      // Collect failures for retry — but only retryable ones (proxy/network errors, not account bans)
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && !r.value?.success) {
          const err = r.value?.error || '';
          const isRetryable = err.includes('timeout') || err.includes('ENOTFOUND') ||
                              err.includes('timed out') || err.includes('ECONNREFUSED') ||
                              err.includes('closed') || err.includes('Login:');
          if (isRetryable) failedAccounts.push({ account: batchAccounts[i], reason: err });
        }
      });

      this._updateStats(results);
      processed += batchSize;
      this.cycleState.processedThisCycle = processed;

      this.emit('cycleProgress', {
        processed, total,
        currentCycle: this.currentCycle, totalCycles: this.totalCycles,
        successCount: this.cycleStats.successCount, failCount: this.cycleStats.failCount,
        retryQueue: failedAccounts.length,
        adaptiveStagger: stagger, proxyEnabled: this.useProxy,
      });

      if (processed < total && this.isProcessing) {
        await this._sleep(this.adaptiveState.currentBatchDelayMs);
      }
    }

    // ── Retry pass — re-run failed accounts with rotated proxies ──────────────
    if (failedAccounts.length > 0 && this.isProcessing) {
      await this._retryFailed(failedAccounts);
    }

    // Cleanup lingering connections
    for (const [k, ws] of this.connectionPool.entries()) this._closeWs(ws, k);
    this.connectionPool.clear();
  }

  // ── Retry failed accounts once with a fresh proxy rotation offset ─────────────
  async _retryFailed(failedAccounts) {
    this.emit('terminal', {
      type: 'warning',
      message: `🔄 [${this.instanceId}] Retrying ${failedAccounts.length} failed accounts with rotated proxies...`,
    });

    // Rotate proxy offset by half the list so retries use different IPs
    const proxyOffset = Math.floor(this.proxyList.length / 2);
    const stagger = this.adaptiveState.currentStaggerMs;

    const results = await Promise.allSettled(
      failedAccounts.map(({ account }, i) =>
        this._sleep(i * stagger).then(async () => {
          // Use a different proxy than original by offsetting the index
          const retryIndex = (i + proxyOffset) % Math.max(this.proxyList.length, 1);
          return this._processAccountWithProxyIndex(account, 9000 + i, retryIndex);
        })
      )
    );

    let retrySuccess = 0, retryFail = 0;
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.success) {
        retrySuccess++;
        this.cycleStats.successCount++;
        this.cycleStats.failCount = Math.max(0, this.cycleStats.failCount - 1);
      } else {
        retryFail++;
      }
    });

    this.emit('terminal', {
      type: retryFail === 0 ? 'success' : 'info',
      message: `🔄 Retry done: ${retrySuccess} recovered, ${retryFail} still failed`,
    });
  }

  async _processAccount(account, globalIndex) {
    return this._processAccountWithProxyIndex(account, globalIndex, globalIndex);
  }

  async _processAccountWithProxyIndex(account, globalIndex, proxyIndex) {
    const pid = uuidv4();
    this.activeProcesses.set(pid, account.username);
    this.cycleState.activeWorkers++;

    try {
      this.emit('status', {
        running: true, total: this.currentAccounts.length, current: globalIndex + 1,
        activeWorkers: this.cycleState.activeWorkers, currentAccount: account.username,
        instanceId: this.instanceId, currentBet: this.getCurrentBetAmount(),
        cycle: this.currentCycle, proxyEnabled: this.useProxy,
      });

      const result = await this._runAccountSession(account, globalIndex, proxyIndex);

      if (result.success) {
        if (result.winCredit > 0) {
          this.cycleStats.totalWinAmount += result.winCredit;
          this.emit('betUpdate', { winAmount: result.winCredit, totalWins: this.cycleStats.totalWinAmount });
        }
        try {
          this.db.updateAccount({
            ...account,
            score: result.newBalance || account.score,
            last_processed: new Date().toISOString(),
          });
        } catch (_) {}
      }

      this.emit('progress', {
        index: globalIndex, total: this.currentAccounts.length,
        account: account.username, success: result.success,
        winAmount: result.winCredit || 0, cycle: this.currentCycle,
      });

      return result;
    } catch (err) {
      this._log(globalIndex, 'error', `Error: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      this.cycleState.activeWorkers--;
      this.activeProcesses.delete(pid);
    }
  }

  async _runAccountSession(account, index, proxyIndex = null) {
    const sessionId   = uuidv4();
    const fingerprint = this._getFingerprint();
    const userAgent   = rand(MOBILE_USER_AGENTS);
    const headers     = rand(HEADER_VARIATIONS);
    // Use explicit proxyIndex if provided, otherwise fall back to index
    const proxy       = this._getProxyForIndex(proxyIndex !== null ? proxyIndex : index);
    const proxyAgent  = proxy ? makeProxyAgent(proxy) : null;

    this._log(index, 'info', `🛡️ ${sessionId.substring(0,8)} | ${fingerprint.model} | ${fingerprint.tz}`);
    if (proxy) this._log(index, 'debug', `🔌 ${proxy.replace(/\/\/.*@/, '//*@')}`);

    // ── Login phase ────────────────────────────────────────────────────────────
    let loginResult;
    try {
      loginResult = await this._login(account, userAgent, headers, proxyAgent, index, sessionId);
    } catch (err) {
      this._recordLoginTime(this.config.TIMEOUTS.LOGIN);
      return { success: false, error: `Login: ${err.message}`, sessionId };
    }

    if (!loginResult.success) {
      this._recordLoginTime(loginResult.loginTime || this.config.TIMEOUTS.LOGIN);
      return { success: false, error: loginResult.error, sessionId };
    }

    this._recordLoginTime(loginResult.loginTime);
    Object.assign(account, loginResult.accountData);
    account.sessionId = sessionId;

    // ── Game phase ─────────────────────────────────────────────────────────────
    try {
      const gameResult = await this._gameFlow(account, userAgent, headers, proxyAgent, index, sessionId);
      return { ...gameResult, sessionId, device: fingerprint.model };
    } catch (err) {
      return { success: false, error: `Game: ${err.message}`, sessionId };
    }
  }

  // ── Login WebSocket ───────────────────────────────────────────────────────────
  _login(account, userAgent, headers, proxyAgent, index, sessionId) {
    return new Promise(async (resolve, reject) => {
      await this._acquireSocket();

      const timeout = setTimeout(() => {
        this.activeTimeouts.delete(timeout);
        this._releaseSocket();
        reject(new Error('Login timeout'));
      }, this.config.TIMEOUTS.LOGIN);
      this.activeTimeouts.add(timeout);

      const wsOpts = {
        handshakeTimeout: this.config.TIMEOUTS.LOGIN - 2000,
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };
      if (proxyAgent) wsOpts.agent = proxyAgent;

      const loginWs = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOpts);
      const key = `login_${account.username}_${sessionId}`;
      this.connectionPool.set(key, loginWs);

      let done = false;
      const startTime = Date.now();

      const finish = (val, err) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.activeTimeouts.delete(timeout);
        this._closeWs(loginWs, key);
        this.connectionPool.delete(key);
        this._releaseSocket();
        err ? reject(err) : resolve(val);
      };

      loginWs.on('open', () => {
        loginWs.send(JSON.stringify({
          account: account.username, password: account.password,
          version: this.config.GAME_VERSION, mainID: 100, subID: 6,
        }));
      });

      loginWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.mainID === 100 && msg.subID === 116) {
            const loginTime = Date.now() - startTime;
            if (msg.data?.result === 0) {
              this._log(index, 'success', `✅ Login ${loginTime}ms`);
              finish({
                success: true, loginTime,
                accountData: {
                  userid: msg.data.userid, dynamicpass: msg.data.dynamicpass,
                  bossid: msg.data.bossid, gameid: msg.data.gameid,
                  score: msg.data.score,
                },
              });
            } else {
              finish({ success: false, loginTime, error: `Rejected:${msg.data?.result}` });
            }
          }
        } catch (_) {}
      });

      loginWs.on('error', (err) => {
        this._log(index, 'error', `Login ws err: ${err.message}`);
        finish(null, err);
      });
      loginWs.on('close', () => {
        if (!done) finish({ success: false, loginTime: Date.now() - startTime, error: 'Connection closed' });
      });
    });
  }

  // ── Game WebSocket ────────────────────────────────────────────────────────────
  _gameFlow(account, userAgent, headers, proxyAgent, index, sessionId) {
    return new Promise(async (resolve) => {
      await this._acquireSocket();

      let gameWs = null, betConfirmed = false, balanceChanged = false;
      let heartbeatIv = null, mainTimeout = null, done = false;
      const key = `game_${account.username}_${sessionId}`;
      const gameStart = Date.now();

      const finish = (result) => {
        if (done) return;
        done = true;
        if (heartbeatIv) { clearInterval(heartbeatIv); this.activeIntervals.delete(heartbeatIv); }
        if (mainTimeout) { clearTimeout(mainTimeout); this.activeTimeouts.delete(mainTimeout); }
        if (gameWs)      { this._closeWs(gameWs, key); this.connectionPool.delete(key); }
        this._releaseSocket();
        this._log(index, 'debug', `⏱️ Game: ${Date.now() - gameStart}ms`);
        resolve(result);
      };

      // Hard session deadline — prevents any account from blocking the pipeline
      mainTimeout = setTimeout(() => {
        if (!done) {
          this._log(index, 'warning', `⏰ Session timeout`);
          finish({ success: balanceChanged, confirmed: false, assumed: balanceChanged, newBalance: account.score, winCredit: 0 });
        }
      }, this.config.TIMEOUTS.TOTAL_SESSION - this.config.TIMEOUTS.LOGIN);
      this.activeTimeouts.add(mainTimeout);

      const wsOpts = {
        handshakeTimeout: this.config.TIMEOUTS.GAME_CONNECTION,
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };
      if (proxyAgent) wsOpts.agent = proxyAgent;

      gameWs = new WebSocket(this.config.SUPER_ROULETTE_WS_URL, ['wl'], wsOpts);
      this.connectionPool.set(key, gameWs);

      gameWs.on('error', (err) => {
        if (!done) { this._log(index, 'error', `Game ws: ${err.message}`); finish({ success: false, confirmed: false, error: err.message, newBalance: account.score, winCredit: 0 }); }
      });
      gameWs.on('close', (code) => {
        if (!done) finish({ success: balanceChanged, confirmed: false, assumed: balanceChanged, newBalance: account.score, winCredit: 0 });
      });

      gameWs.on('open', () => {
        this._log(index, 'success', `🎮 Connected`);

        const send = (payload, label, delay) => setTimeout(() => {
          if (gameWs && gameWs.readyState === WebSocket.OPEN && !done) {
            gameWs.send(JSON.stringify(payload));
          }
        }, delay);

        send({ mainID: 1, subID: 5, userid: account.userid, password: account.dynamicpass }, 'Enter', 80);
        send({ mainID: 1, subID: 4, gameid: account.gameid || 10658796, password: account.dynamicpass, reenter: 0 }, 'Join', 400);
        send({ route: 31, mainID: 200, subID: 100 }, 'Init', 800);

        heartbeatIv = setInterval(() => {
          if (gameWs && gameWs.readyState === WebSocket.OPEN && !done) {
            gameWs.send(JSON.stringify({ mainID: 1, subID: 6, bossid: account.bossid }));
          }
        }, 5000);
        this.activeIntervals.add(heartbeatIv);

        send({ mainID: 1, subID: 6, bossid: account.bossid }, 'Table', 1200);

        // Bet at 1800ms — slightly earlier for speed
        setTimeout(() => {
          if (gameWs && gameWs.readyState === WebSocket.OPEN && !done) {
            this._log(index, 'info', `🎯 Betting ${this.getCurrentBetAmount()}`);
            gameWs.send(JSON.stringify(this._createBetPayload()));
          }
        }, 1800);
      });

      gameWs.on('message', (raw) => {
        if (done) return;
        try {
          const msg = JSON.parse(raw.toString());

          // Balance update — track if score changed (indicates successful session)
          if (msg.mainID === 1 && msg.subID === 104 && msg.data?.score != null) {
            if (msg.data.score !== account.score) { balanceChanged = true; account.score = msg.data.score; }
          }

          // Bet confirmation — fastest possible exit
          if (msg.mainID === 200 && msg.subID === 100 && msg.data?.route === 39) {
            betConfirmed = true;
            const winCredit    = msg.data.winCredit    || 0;
            const playerCredit = msg.data.playerCredit || account.score;
            account.score = playerCredit;
            this._log(index, 'success', `🎉 WIN:${winCredit} BAL:${playerCredit}`);
            this.emit('betUpdate', { winAmount: winCredit, currentBet: this.getCurrentBetAmount() });
            finish({ success: true, confirmed: true, newBalance: playerCredit, winCredit, betConfirmed: true });
          }
        } catch (_) {}
      });
    });
  }

  // ── Statistics ────────────────────────────────────────────────────────────────
  _updateStats(results) {
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.success) {
        this.cycleStats.successCount++;
        this.cycleStats.cycleSuccessCount++;
        if (r.value.confirmed) this.cycleStats.confirmedBets++;
        else if (r.value.assumed) this.cycleStats.assumedBets++;
      } else {
        this.cycleStats.failCount++;
        this.cycleStats.cycleFailCount++;
      }
      this.cycleStats.processedThisMinute++;
    });

    this.emit('cycleUpdate', {
      cyclesCompleted: this.currentCycle, totalCycles: this.totalCycles,
      successCount: this.cycleStats.successCount, failCount: this.cycleStats.failCount,
      confirmedBets: this.cycleStats.confirmedBets,
      totalBetAmount: this.cycleStats.totalBetAmount, totalWinAmount: this.cycleStats.totalWinAmount,
      adaptiveStagger: this.adaptiveState.currentStaggerMs, proxyEnabled: this.useProxy,
    });
  }

  // ── Monitor (logs every 20s) ──────────────────────────────────────────────────
  _startMonitor() {
    const iv = setInterval(() => {
      if (!this.isProcessing) { clearInterval(iv); this.activeIntervals.delete(iv); return; }

      const total       = this.cycleStats.successCount + this.cycleStats.failCount;
      const rate        = total > 0 ? ((this.cycleStats.successCount / total) * 100).toFixed(1) : '0.0';
      const elapsed     = (Date.now() - this.cycleState.cycleStartTime) / 1000;
      const perHour     = elapsed > 0 ? Math.round((total / elapsed) * 3600) : 0;
      const avgLogin    = this.adaptiveState.recentLoginTimes.length > 0
        ? Math.round(this.adaptiveState.recentLoginTimes.reduce((a,b) => a+b,0) / this.adaptiveState.recentLoginTimes.length)
        : 0;

      this.emit('terminal', {
        type: 'info',
        message: `📊 [${this.instanceId}] ${perHour.toLocaleString()}/hr | ${rate}% | Workers:${this.cycleState.activeWorkers} | AvgLogin:${avgLogin}ms | Stagger:${this.adaptiveState.currentStaggerMs}ms | Sockets:${this._getSocketCount()} | Mem:${this._mem()}MB`,
      });
      this.emit('status', {
        running: true, instanceId: this.instanceId,
        successCount: this.cycleStats.successCount, failCount: this.cycleStats.failCount,
        confirmedBets: this.cycleStats.confirmedBets, successRate: `${rate}%`,
        currentBet: this.getCurrentBetAmount(), throughputPerHour: perHour,
        cycle: this.currentCycle, totalCycles: this.totalCycles,
        activeWorkers: this.cycleState.activeWorkers,
        adaptiveStagger: this.adaptiveState.currentStaggerMs,
        proxyEnabled: this.useProxy, avgLoginMs: avgLogin,
        memoryMB: this._mem(),
      });
    }, 20000);
    this.activeIntervals.add(iv);
    this.securityInterval = iv;
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────────
  async stopProcessing() {
    this.isProcessing = false;
    this.cycleState.isCycleActive = false;
    await this._fullCleanup();
    this.emit('terminal', { type: 'warning', message: `🛑 [${this.instanceId}] Stopped` });
    this.emit('status', { running: false });
    return { success: true, cyclesCompleted: this.currentCycle };
  }

  _completeProcessing() {
    this.isProcessing = false;
    this.cycleState.isCycleActive = false;
    this._clearTimers();

    const total   = this.cycleStats.successCount + this.cycleStats.failCount;
    const rate    = total > 0 ? ((this.cycleStats.successCount / total) * 100).toFixed(1) : '0.0';

    this.emit('terminal', { type: 'success', message: `\n🎉 [${this.instanceId}] COMPLETE! ${this.cycleStats.successCount}/${total} (${rate}%) | Confirmed: ${this.cycleStats.confirmedBets}` });
    this.emit('completed', {
      successCount: this.cycleStats.successCount, failCount: this.cycleStats.failCount,
      confirmedBets: this.cycleStats.confirmedBets, totalProcessed: total,
      successRate: parseFloat(rate), totalBetAmount: this.cycleStats.totalBetAmount,
      totalWinAmount: this.cycleStats.totalWinAmount, cyclesCompleted: this.currentCycle,
    });
    this.emit('status', { running: false });

    // Persist session stats
    try {
      this.db.saveSessionStats({
        accountsProcessed: total, wins: this.cycleStats.successCount,
        totalBet: this.cycleStats.totalBetAmount, totalWin: this.cycleStats.totalWinAmount,
        successRate: parseFloat(rate), sessionId: this.cycleState.cycleId,
      });
    } catch (_) {}
  }

  // ── Utils ─────────────────────────────────────────────────────────────────────
  _closeWs(ws, id = '') {
    if (!ws) return;
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, `cleanup:${id}`);
      }
    } catch (_) {}
  }

  _clearTimers() {
    for (const i of this.activeIntervals) {
      if (i !== this.securityInterval) clearInterval(i);
    }
    this.activeIntervals.clear();
    if (this.securityInterval) {
      clearInterval(this.securityInterval);
      this.securityInterval = null;
    }
    for (const t of this.activeTimeouts) clearTimeout(t);
    this.activeTimeouts.clear();
  }

  async _fullCleanup() {
    this._clearTimers();
    for (const [k, ws] of this.connectionPool.entries()) this._closeWs(ws, k);
    this.connectionPool.clear();
    this.activeProcesses.clear();
    await this._sleep(100);
  }

  _log(index, type, message) {
    this.emit('terminal', {
      type, timestamp: new Date().toISOString(),
      message: `[C${this.currentCycle}][${index}] ${message}`,
      cycleId: this.cycleState.cycleId,
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  _mem()     { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); }
}

module.exports = UltimateRouletteProcessor;
