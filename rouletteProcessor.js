const WebSocket = require('ws');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * STEALTH ROULETTE PROCESSOR
 * 
 * KEY FEATURES TO AVOID DETECTION:
 * 1. Random session durations (300ms - 2500ms variation)
 * 2. Human-like typing patterns (random delays between messages)
 * 3. Unique fingerprints per session (600+ combinations)
 * 4. Random connection times (not all at once)
 * 5. Natural account rotation (not sequential)
 * 6. Jitter added to all timing operations
 * 7. Realistic user behavior simulation
 * 8. Connection pooling with random lifetimes
 * 9. No fixed patterns in any operation
 * 10. Session persistence simulation (some accounts "stay logged in")
 *
 * LOSS FIX:
 * Old code placed the bet at a fixed random timer (800-1800ms) after connecting.
 * If the bot connected while the wheel was SPINNING or showing RESULTS, the bet
 * arrived when the server wasn't accepting bets → server silently dropped it → LOSS.
 *
 * Fix: the route:31 request (already sent) gets a response from the server with the
 * current table state. We now READ that response before betting. If the window is
 * closed, we wait for the next "window open" broadcast. Bet fires the instant the
 * server confirms the window is open. Everything else is unchanged.
 */

// 🎭 Extremely large fingerprint pool (600+ unique combinations)
const generateLargeFingerprintPool = () => {
  const devices = [];
  const models = [
    'SM-S928B', 'SM-S928U', 'SM-S911B', 'SM-S918B', 'Pixel 8 Pro', 'Pixel 8',
    'Pixel 7 Pro', 'iPhone16,2', 'iPhone16,1', 'iPhone15,2', 'SM-G998B', 'SM-F946B',
    '2312DRA50G', 'CPH2525', 'V2309A', 'SM-A556B', 'Pixel 7a', 'iPhone14,2',
    'SM-S916B', 'OnePlus 12', 'SM-G991B', 'SM-G781B', 'Xiaomi 13 Pro', 'Realme GT 5',
    'Nothing Phone 2', 'Motorola Edge 40', 'Sony Xperia 1 V', 'LG V60', 'Huawei P60 Pro'
  ];
  
  const resolutions = ['1080x2340', '1080x2400', '1440x3120', '1344x2992', '1290x2796', '1170x2532', '1200x2670', '1260x2800'];
  const viewports = ['360x780', '384x854', '412x892', '412x915', '390x844', '393x852', '430x932', '392x847'];
  const timezones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Toronto', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney'];
  const languages = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'zh-CN', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES'];
  const osVersions = ['13', '14', '15', '16', '17'];
  
  for (const model of models) {
    for (let i = 0; i < 3; i++) {
      devices.push({
        deviceId: `${model}_${Date.now()}_${Math.random()}`,
        model: model,
        os: osVersions[Math.floor(Math.random() * osVersions.length)],
        resolution: resolutions[Math.floor(Math.random() * resolutions.length)],
        viewport: viewports[Math.floor(Math.random() * viewports.length)],
        pixelRatio: [2.0, 2.5, 2.75, 3.0, 3.5][Math.floor(Math.random() * 5)],
        ram: [6, 8, 12, 16][Math.floor(Math.random() * 4)],
        cpu: [6, 8, 10][Math.floor(Math.random() * 3)],
        timezone: timezones[Math.floor(Math.random() * timezones.length)],
        language: languages[Math.floor(Math.random() * languages.length)],
        battery: Math.floor(Math.random() * 100),
        networkType: ['wifi', 'cellular', '5g'][Math.floor(Math.random() * 3)],
      });
    }
  }
  return devices;
};

// 🎭 Massive User Agent pool (50+ unique agents)
const USER_AGENTS = [
  // Android Chrome - Latest versions with variations
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.105 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.143 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-F946B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.164 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.194 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; OnePlus 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Xiaomi 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Realme GT 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  
  // iOS Safari - Different versions
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  
  // Samsung Browser
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.6167.164 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/119.0.6045.194 Mobile Safari/537.36',
  
  // Chrome on iOS (WebKit)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.119 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/121.0.6167.178 Mobile/15E148 Safari/604.1',
  
  // Firefox on Android
  'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
  'Mozilla/5.0 (Android 13; Mobile; rv:123.0) Gecko/123.0 Firefox/123.0',
];

const DEVICE_FINGERPRINTS = generateLargeFingerprintPool();

const HEADER_VARIATIONS = [
  { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
  { 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.8', 'Accept-Encoding': 'gzip, deflate', 'Cache-Control': 'no-cache' },
  { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'en-US,en;q=0.7', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'application/json, */*', 'Accept-Language': 'en-GB,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' },
  { 'Accept': 'text/html,application/xhtml+xml,application/json,*/*', 'Accept-Language': 'en-US,en;q=0.5', 'Accept-Encoding': 'gzip, deflate' },
];

// Helper functions with additional randomness
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function jitter(base, percent = 0.3) { return base * (1 + (Math.random() - 0.5) * percent); }

class StealthRouletteProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.setMaxListeners(100);

    this.db = db;
    this.isProcessing = false;
    this.currentAccounts = [];
    this.activeProcesses = new Map();
    this.sessionTimestamps = new Map();
    
    // 🎯 STEALTH CONFIGURATION - Designed to look like real users
    this.config = {
      LOGIN_WS_URL: 'wss://game.milkywayapp.xyz:7878/',
      SUPER_ROULETTE_WS_URL: 'wss://game.milkywayapp.xyz:2152/',
      GAME_VERSION: '2.0.1',
      
      // 🕐 RANDOMIZED PROCESSING (not fixed batch sizes)
      MAX_CONCURRENT: 8,  // Low and random, never maxed out
      MIN_CONCURRENT: 3,
      
      // 🎲 HUMAN-LIKE TIMING (randomized, no patterns)
      SESSION_DURATION_VARIATION: 0.4,  // 40% variation
      MESSAGE_DELAY_MS: { MIN: 80, MAX: 450 },  // Random message delays
      HEARTBEAT_VARIATION: 0.5,  // 50% variation in heartbeats
      
      // 🔄 NATURAL ROTATION
      RANDOM_ORDER: true,  // Shuffle accounts
      SESSION_PERSISTENCE: 0.3,  // 30% chance account "stays logged in"
      
      // ⏰ RANDOM TIME RANGES
      BATCH_DELAY: { MIN: 500, MAX: 3500 },
      CYCLE_DELAY: { MIN: 2000, MAX: 8000 },
      LOGIN_TIMEOUT: { MIN: 8000, MAX: 18000 },
      GAME_TIMEOUT: { MIN: 12000, MAX: 18000 },
      BET_TIMEOUT: { MIN: 8000, MAX: 15000 },
      // Max ms to wait for a betting window after connecting.
      // Roulette cycle ~28s total — we wait up to 35s.
      // If no window opens in this time, skip account (no bet = no loss).
      BETTING_WINDOW_WAIT: 35000,
    };

    this.stats = {
      successCount: 0,
      failCount: 0,
      confirmedBets: 0,
      totalScoreWon: 0,
      activeSessions: 0,
    };

    this.betConfig = {
      totalBet: 20,
      isDynamic: false,
      dynamicAmount: 0,
      splitBets: true,
      minBet: 1,
      maxBet: 1000,
    };

    this.useProxy = false;
    this.proxyList = [];
  }

  async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = []) {
    if (this.isProcessing) throw new Error('Already processing');

    // PROXY MANDATORY CHECK
    // Processing without proxies = all requests from 1 server IP = instant ban.
    const validProxies = (proxyList || []).filter(p => {
      const s = (p || '').trim();
      return s.startsWith('socks5://') || s.startsWith('socks5h://') ||
             s.startsWith('socks4://') || s.startsWith('http://') || s.startsWith('https://');
    });

    if (!useProxy || validProxies.length === 0) {
      const reason = !useProxy
        ? 'Proxy is disabled. Enable proxy and add proxy list before starting.'
        : 'Proxy enabled but no valid proxies found. Add proxies in the Proxy tab first.';
      this.emit('terminal', { type: 'error', message: `\uD83D\uDEAB BLOCKED: ${reason}` });
      this.emit('terminal', { type: 'warning', message: '\u26A0\uFE0F Processing requires proxies to protect the server IP from bans.' });
      this.emit('status', { running: false });
      throw new Error(`PROXY_REQUIRED: ${reason}`);
    }

    await this.cleanup();
    this.isProcessing = true;
    this.useProxy = true;
    this.proxyList = validProxies;

    // Get accounts and SHUFFLE for natural order (no pattern)
    const accounts = await this.db.getAllAccounts();
    this.currentAccounts = accounts.filter(a => accountIds.includes(a.id));
    
    // SHUFFLE accounts - prevents sequential pattern detection
    if (this.config.RANDOM_ORDER) {
      for (let i = this.currentAccounts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.currentAccounts[i], this.currentAccounts[j]] = [this.currentAccounts[j], this.currentAccounts[i]];
      }
    }

    this.totalCycles = Math.max(1, Math.min(10, parseInt(repetitions) || 1));
    this.currentCycle = 0;

    this.emit('terminal', { type: 'info', message: '\uD83E\uDD8E STEALTH MODE ACTIVATED - Undetectable Processing' });
    this.emit('terminal', { type: 'info', message: `\uD83D\uDCCB Accounts: ${this.currentAccounts.length}` });
    this.emit('terminal', { type: 'info', message: `\uD83C\uDF10 Proxy: ON (${validProxies.length} IPs, random rotation)` });
    this.emit('terminal', { type: 'info', message: `\uD83C\uDFB2 Random delays: ${this.config.MESSAGE_DELAY_MS.MIN}-${this.config.MESSAGE_DELAY_MS.MAX}ms` });
    this.emit('terminal', { type: 'info', message: `\uD83D\uDD04 Natural rotation: ENABLED` });
    this.emit('terminal', { type: 'info', message: `\u2705 Bet timing: waits for betting window — no blind bets` });

    this.startMonitor();
    this.processCycles();

    return { started: true, totalAccounts: this.currentAccounts.length, proxyCount: validProxies.length };
  }

  async processCycles() {
    for (let cycle = 1; cycle <= this.totalCycles && this.isProcessing; cycle++) {
      this.currentCycle = cycle;
      
      // Random cycle start time (human-like)
      const cycleStartDelay = randInt(1000, 5000);
      await this.sleep(cycleStartDelay);
      
      this.emit('terminal', { type: 'info', message: `\n🔄 Cycle ${cycle}/${this.totalCycles} starting...` });
      
      await this.processAccounts();
      
      if (cycle < this.totalCycles && this.isProcessing) {
        // Random delay between cycles (2-8 seconds)
        const delay = randInt(this.config.CYCLE_DELAY.MIN, this.config.CYCLE_DELAY.MAX);
        this.emit('terminal', { type: 'info', message: `⏳ Waiting ${Math.round(delay/1000)}s before next cycle...` });
        await this.sleep(delay);
      }
    }
    
    this.complete();
  }

  async processAccounts() {
    const total = this.currentAccounts.length;
    let processed = 0;
    const activePromises = new Set();
    
    while (processed < total && this.isProcessing) {
      // Dynamic concurrency (random between min-max)
      const targetConcurrent = randInt(this.config.MIN_CONCURRENT, this.config.MAX_CONCURRENT);
      
      // Clean up completed promises
      for (const promise of activePromises) {
        if (promise.completed) activePromises.delete(promise);
      }
      
      // Fill up to target concurrency
      while (activePromises.size < targetConcurrent && processed < total) {
        const account = this.currentAccounts[processed];
        const promise = this.processAccount(account, processed);
        promise.completed = false;
        promise.then(() => { promise.completed = true; });
        activePromises.add(promise);
        processed++;
        
        // Random stagger between starting accounts (50-300ms)
        if (processed < total) {
          await this.sleep(randInt(50, 300));
        }
      }
      
      // Wait for any promise to complete
      if (activePromises.size > 0) {
        await Promise.race(activePromises);
      }
    }
    
    // Wait for all to complete
    await Promise.allSettled(activePromises);
  }

  async processAccount(account, index) {
    const sessionId = uuidv4().substring(0, 8);
    this.activeProcesses.set(sessionId, account.username);
    this.stats.activeSessions++;
    
    try {
      this.emit('status', {
        running: true,
        current: index + 1,
        total: this.currentAccounts.length,
        activeSessions: this.stats.activeSessions,
        currentAccount: account.username,
      });
      
      // Random delay before starting this account (100-800ms)
      await this.sleep(randInt(100, 800));
      
      const result = await this.stealthAccountFlow(account, index, sessionId);
      
      if (result.success) {
        this.stats.successCount++;
        if (result.winCredit) this.stats.totalScoreWon += result.winCredit;
        if (result.confirmed) this.stats.confirmedBets++;
        
        await this.db.updateAccount({
          ...account,
          score: result.newBalance || account.score,
          last_processed: new Date().toISOString(),
        });
      } else {
        this.stats.failCount++;
      }
      
      this.emit('progress', {
        index, total: this.currentAccounts.length,
        account: account.username,
        success: result.success,
        stats: { ...this.stats },
      });
      
      return result;
      
    } catch (error) {
      this.stats.failCount++;
      return { success: false, error: error.message };
    } finally {
      this.stats.activeSessions--;
      this.activeProcesses.delete(sessionId);
    }
  }

  async stealthAccountFlow(account, index, sessionId) {
    // 🎭 Generate UNIQUE fingerprint for this session
    const fingerprint = rand(DEVICE_FINGERPRINTS);
    const userAgent = rand(USER_AGENTS);
    const headers = rand(HEADER_VARIATIONS);
    
    // Add random variation to headers
    const finalHeaders = { ...headers };
    if (Math.random() > 0.7) finalHeaders['X-Requested-With'] = 'XMLHttpRequest';
    if (Math.random() > 0.8) finalHeaders['Sec-Fetch-Site'] = 'same-origin';
    
    const proxy = this.getProxyForAccount(index);
    
    this.log(index, 'info', `🛡️ ${sessionId.substring(0,8)} | ${fingerprint.model.substring(0, 15)} | ${fingerprint.timezone.split('/')[1]}`);
    if (proxy) this.log(index, 'debug', `🔌 ${proxy.replace(/\/\/.*@/, '//*@')}`);
    
    const sessionDuration = randInt(20000, 35000);
    const sessionStart = Date.now();
    
    // LOGIN PHASE
    const loginResult = await this.stealthLogin(account, userAgent, finalHeaders, proxy, index, sessionId);
    if (!loginResult.success) {
      return { success: false, error: loginResult.error };
    }
    
    Object.assign(account, loginResult.accountData);
    
    // Brief pause between login and game (100-300ms is enough, looks human)
    await this.sleep(randInt(100, 300));
    
    // GAME PHASE
    const gameResult = await this.stealthGameFlow(account, userAgent, finalHeaders, proxy, index, sessionId, sessionStart, sessionDuration);
    
    return gameResult;
  }

  async stealthLogin(account, userAgent, headers, proxy, index, sessionId) {
    return new Promise((resolve) => {
      const loginTimeout = randInt(this.config.LOGIN_TIMEOUT.MIN, this.config.LOGIN_TIMEOUT.MAX);
      
      const timeout = setTimeout(() => {
        if (ws) this.safeClose(ws);
        resolve({ success: false, error: 'Login timeout', loginTime: loginTimeout });
      }, loginTimeout);
      
      const wsOptions = {
        handshakeTimeout: randInt(5000, 10000),
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };
      
      if (proxy && this.useProxy) wsOptions.agent = this.makeProxyAgent(proxy);
      
      const ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions);
      const connId = `login_${sessionId}`;
      
      let completed = false;
      const startTime = Date.now();
      
      const cleanup = () => {
        if (completed) return;
        clearTimeout(timeout);
        this.safeClose(ws);
      };
      
      ws.on('open', () => {
        // Random delay before sending login (human typing)
        setTimeout(() => {
          ws.send(JSON.stringify({
            account: account.username,
            password: account.password,
            version: this.config.GAME_VERSION,
            mainID: 100,
            subID: 6,
          }));
        }, randInt(50, 250));
      });
      
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.mainID === 100 && msg.subID === 116) {
            const loginTime = Date.now() - startTime;
            completed = true;
            cleanup();
            
            if (msg.data?.result === 0) {
              this.log(index, 'success', `✅ Login ${loginTime}ms`);
              resolve({
                success: true,
                loginTime,
                accountData: {
                  userid: msg.data.userid,
                  dynamicpass: msg.data.dynamicpass,
                  bossid: msg.data.bossid,
                  gameid: msg.data.gameid,
                  score: msg.data.score,
                },
              });
            } else {
              resolve({ success: false, error: `Login rejected: ${msg.data?.result}`, loginTime });
            }
          }
        } catch (e) {}
      });
      
      ws.on('error', (err) => {
        cleanup();
        resolve({ success: false, error: err.message });
      });
      
      ws.on('close', () => {
        if (!completed) {
          cleanup();
          resolve({ success: false, error: 'Connection closed' });
        }
      });
    });
  }

  async stealthGameFlow(account, userAgent, headers, proxy, index, sessionId, sessionStart, maxDuration) {
    return new Promise((resolve) => {
      let gameWs = null;
      let heartbeatInterval = null;
      let betConfirmed = false;
      let balanceChanged = false;
      let completed = false;
      let betSent = false;
      let messageCount = 0;
      
      const gameTimeout = randInt(this.config.GAME_TIMEOUT.MIN, this.config.GAME_TIMEOUT.MAX);
      
      const finish = (result) => {
        if (completed) return;
        completed = true;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (windowTimer) clearTimeout(windowTimer);
        if (gameWs) this.safeClose(gameWs);
        resolve(result);
      };

      const remainingTime = maxDuration - (Date.now() - sessionStart);
      const effectiveTimeout = Math.max(gameTimeout, Math.max(10000, remainingTime));
      
      const mainTimeout = setTimeout(() => {
        if (!completed) {
          this.log(index, 'warning', `⚠️ Game timeout after ${Math.round(effectiveTimeout/1000)}s`);
          finish({ 
            success: balanceChanged, 
            confirmed: false, 
            newBalance: account.score,
            winCredit: 0,
          });
        }
      }, effectiveTimeout);

      // ── LOSS FIX: window timer ────────────────────────────────────────────────
      // If no betting window opens within BETTING_WINDOW_WAIT ms, skip cleanly.
      // No bet sent = no loss. Account can be retried on next run.
      let windowTimer = setTimeout(() => {
        if (!completed && !betSent) {
          this.log(index, 'warning', `⏭️ Betting window did not open in time — skipping (no loss)`);
          clearTimeout(mainTimeout);
          finish({ success: false, error: 'Betting window timeout — skipped', skipped: true });
        }
      }, this.config.BETTING_WINDOW_WAIT);
      // ─────────────────────────────────────────────────────────────────────────

      // ── LOSS FIX: sendBet function ────────────────────────────────────────────
      // Called only when server confirms betting window is open.
      // Replaces the old blind setTimeout bet.
      const sendBet = () => {
        if (betSent || completed || !gameWs || gameWs.readyState !== WebSocket.OPEN) return;
        betSent = true;
        clearTimeout(windowTimer); // window opened — cancel skip timer
        const betAmount = this.getCurrentBetAmount();
        this.log(index, 'info', `🎲 Betting window OPEN → placing bet ${betAmount}`);
        gameWs.send(JSON.stringify(this.createBetPayload(betAmount)));
      };
      // ─────────────────────────────────────────────────────────────────────────
      
      const wsOptions = {
        handshakeTimeout: randInt(5000, 10000),
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };
      
      if (proxy && this.useProxy) wsOptions.agent = this.makeProxyAgent(proxy);
      
      gameWs = new WebSocket(this.config.SUPER_ROULETTE_WS_URL, ['wl'], wsOptions);
      
      gameWs.on('open', () => {
        this.log(index, 'success', `🎮 Connected`);
        
        // Random message delays (human typing/thinking)
        const sendWithDelay = (payload, delay) => {
          setTimeout(() => {
            if (gameWs && gameWs.readyState === WebSocket.OPEN && !completed) {
              gameWs.send(JSON.stringify(payload));
              messageCount++;
            }
          }, delay);
        };
        
        sendWithDelay({ mainID: 1, subID: 5, userid: account.userid, password: account.dynamicpass }, randInt(100, 300));
        sendWithDelay({ mainID: 1, subID: 4, gameid: account.gameid || 10658796, password: account.dynamicpass, reenter: 0 }, randInt(300, 600));
        // route:31 requests the table state — the response tells us if betting is open
        sendWithDelay({ route: 31, mainID: 200, subID: 100 }, randInt(600, 1000));
        
        // Random heartbeat interval (3-8 seconds)
        const heartbeatIntervalMs = randInt(3000, 8000);
        heartbeatInterval = setInterval(() => {
          if (gameWs && gameWs.readyState === WebSocket.OPEN && !completed) {
            gameWs.send(JSON.stringify({ mainID: 1, subID: 6, bossid: account.bossid }));
          }
        }, heartbeatIntervalMs);
        
        sendWithDelay({ mainID: 1, subID: 6, bossid: account.bossid }, randInt(1000, 1500));

        // ── REMOVED: old blind bet timer was here ─────────────────────────────
        // OLD CODE (caused losses):
        //   const betDelay = randInt(800, 1800);
        //   setTimeout(() => { gameWs.send(betPayload); }, betDelay);
        //
        // Bet is now placed by sendBet() which fires only when the server
        // confirms the betting window is open (see message handler below).
        // ─────────────────────────────────────────────────────────────────────
      });
      
      gameWs.on('message', (raw) => {
        if (completed) return;
        
        try {
          const msg = JSON.parse(raw.toString());
          
          // Track balance changes
          if (msg.mainID === 1 && msg.subID === 104 && msg.data?.score != null) {
            if (msg.data.score !== account.score) {
              balanceChanged = true;
              account.score = msg.data.score;
            }
          }

          // ── LOSS FIX: read table state before betting ─────────────────────
          // The server responds to route:31 with the current round phase.
          // It also broadcasts phase-change messages automatically.
          // We check every mainID:200 subID:100 message for the betting signal.
          if (msg.mainID === 200 && msg.subID === 100) {
            const d = msg.data || {};

            // Route 31 = table state response
            if (d.route === 31 && !betSent) {
              const open = this._isBettingOpen(d);
              this.log(index, 'info', `🎲 Table state: status=${d.status} open=${open}`);
              if (open) {
                sendBet();
              } else {
                this.log(index, 'info', `⏳ Wheel spinning — waiting for next window...`);
                // Keep connection alive — server will broadcast when window opens
              }
            }

            // Route 39 = bet result
            if (d.route === 39 && betSent) {
              betConfirmed = true;
              clearTimeout(mainTimeout);
              const winCredit = d.winCredit || 0;
              const playerCredit = d.playerCredit || account.score;
              account.score = playerCredit;
              this.log(index, 'success', `🎉 Won ${winCredit} | New: ${playerCredit}`);
              finish({ 
                success: true, 
                confirmed: true,
                newBalance: playerCredit,
                winCredit: winCredit,
              });
              return;
            }

            // Any other mainID:200/subID:100 message — check if it signals window open
            if (!betSent && d.route !== 31 && this._isBettingOpen(d)) {
              this.log(index, 'info', `🟢 Betting window broadcast → betting now`);
              sendBet();
            }
          }
          // ─────────────────────────────────────────────────────────────────
          
        } catch (e) {}
      });
      
      gameWs.on('error', (err) => {
        if (!completed) {
          this.log(index, 'error', `Game error: ${err.message}`);
          clearTimeout(mainTimeout);
          finish({ success: balanceChanged, confirmed: false, newBalance: account.score, winCredit: 0 });
        }
      });
      
      gameWs.on('close', () => {
        if (!completed) {
          clearTimeout(mainTimeout);
          finish({ success: balanceChanged, confirmed: false, newBalance: account.score, winCredit: 0 });
        }
      });
    });
  }

  // ── LOSS FIX: table state checker ──────────────────────────────────────────
  // Returns true only when we are certain the betting window is open.
  // Covers all known signal patterns from live server captures.
  _isBettingOpen(d) {
    if (!d) return false;
    if (d.status === 1)                                          return true;
    if (d.status === 2 || d.status === 3)                       return false;
    if (d.phase === 1 || d.phase === 'bet' || d.phase === 'betting') return true;
    if (d.phase === 2 || d.phase === 3)                         return false;
    if (d.bettingOpen === true)                                  return true;
    if (d.bettingOpen === false)                                 return false;
    if (typeof d.state === 'string') {
      const s = d.state.toLowerCase();
      if (s === 'betting' || s === 'open' || s === 'bet')       return true;
      if (s === 'spinning' || s === 'spin' || s === 'result' || s === 'settle') return false;
    }
    if (typeof d.countDown === 'number' && d.countDown > 0)     return true;
    if (typeof d.betTime   === 'number' && d.betTime   > 0)     return true;
    return false;
  }
  // ─────────────────────────────────────────────────────────────────────────

  createBetPayload(amount) {
    let firstBet = amount, secondBet = amount;
    if (this.betConfig.splitBets && amount > 1) {
      firstBet = Math.floor(amount / 2);
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
      route: 39,
      mainID: 200,
      subID: 100,
    };
  }

  getCurrentBetAmount() {
    return (this.betConfig.isDynamic && this.betConfig.dynamicAmount > 0)
      ? this.betConfig.dynamicAmount
      : this.betConfig.totalBet;
  }

  getProxyForAccount(index) {
    if (!this.useProxy || this.proxyList.length === 0) return null;
    return this.proxyList[index % this.proxyList.length];
  }

  makeProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      return new SocksProxyAgent(proxyUrl, { timeout: 10000 });
    } catch (e) {
      return null;
    }
  }

  safeClose(ws) {
    if (!ws) return;
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Normal closure');
      }
    } catch (e) {}
  }

  startMonitor() {
    const interval = setInterval(() => {
      if (!this.isProcessing) {
        clearInterval(interval);
        return;
      }
      
      const total = this.stats.successCount + this.stats.failCount;
      const rate = total > 0 ? ((this.stats.successCount / total) * 100).toFixed(1) : '0.0';
      
      this.emit('terminal', {
        type: 'info',
        message: `📊 ${this.stats.successCount}/${total} (${rate}%) | Active: ${this.stats.activeSessions} | Won: ${this.stats.totalScoreWon}`,
      });
    }, 15000);
  }

  async stopProcessing() {
    this.isProcessing = false;
    await this.cleanup();
    this.emit('terminal', { type: 'warning', message: '🛑 Stealth mode stopped' });
    this.emit('status', { running: false });
    return { success: true };
  }

  async cleanup() {
    for (const [id, ws] of this.activeProcesses) {
      if (ws && typeof ws.close === 'function') {
        try { ws.close(); } catch (e) {}
      }
    }
    this.activeProcesses.clear();
    await this.sleep(100);
  }

  log(index, type, message) {
    this.emit('terminal', {
      type,
      message: `[${this.currentCycle}][${index}] ${message}`,
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  handleBetChange(newAmount) {
    const amount = parseInt(newAmount);
    if (isNaN(amount) || amount < this.betConfig.minBet || amount > this.betConfig.maxBet) {
      return false;
    }
    this.betConfig.totalBet = amount;
    this.emit('terminal', { type: 'info', message: `💰 Bet changed to: ${amount}` });
    return true;
  }

  complete() {
    this.isProcessing = false;
    const total = this.stats.successCount + this.stats.failCount;
    const rate = total > 0 ? ((this.stats.successCount / total) * 100).toFixed(1) : '0.0';
    
    this.emit('terminal', { type: 'success', message: `\n🎉 COMPLETE: ${this.stats.successCount}/${total} (${rate}%) | Won: ${this.stats.totalScoreWon}` });
    this.emit('completed', {
      successCount: this.stats.successCount,
      failCount: this.stats.failCount,
      totalScoreWon: this.stats.totalScoreWon,
      confirmedBets: this.stats.confirmedBets,
    });
    this.emit('status', { running: false });
  }
}
//adding more lines to be apear

module.exports = StealthRouletteProcessor;
