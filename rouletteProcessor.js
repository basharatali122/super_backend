const WebSocket = require('ws');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

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

const USER_AGENTS = [
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
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.6167.164 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/119.0.6045.194 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.119 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/121.0.6167.178 Mobile/15E148 Safari/604.1',
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

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

class StealthRouletteProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.setMaxListeners(100);

    this.db = db;
    this.isProcessing = false;
    this.currentAccounts = [];
    this.activeProcesses = new Map();

    // 🛡️ LOSS CONTROL CONFIGURATION
    this.config = {
      LOGIN_WS_URL: 'wss://game.milkywayapp.xyz:7878/',
      SUPER_ROULETTE_WS_URL: 'wss://game.milkywayapp.xyz:2152/',
      GAME_VERSION: '2.0.1',
      
      // ⚡ Speed settings (slightly reduced for stability)
      MAX_CONCURRENT: 4,
      MIN_CONCURRENT: 2,
      
      // 🛡️ Loss Control
      MAX_LOSS_PER_ACCOUNT: 20,
      RETRY_ON_LOSS: 2,
      STOP_ON_LOSS: true,
      
      // ⏱️ Extended timeouts
      LOGIN_TIMEOUT: { MIN: 12000, MAX: 20000 },
      GAME_TIMEOUT: 30000,
      BET_CONFIRM_TIMEOUT: 25000,
      RESULT_WAIT: 20000,
      
      RANDOM_ORDER: true,
      CYCLE_DELAY: { MIN: 5000, MAX: 10000 },
    };

    this.stats = {
      successCount: 0,
      failCount: 0,
      confirmedBets: 0,
      totalScoreWon: 0,
      totalScoreLost: 0,
      activeSessions: 0,
      netProfit: 0,
      lossCount: 0,
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
    this.accountLossTracker = new Map();
  }

  async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = []) {
    if (this.isProcessing) throw new Error('Already processing');

    const validProxies = (proxyList || []).filter(p => {
      const s = (p || '').trim();
      return s.startsWith('socks5://') || s.startsWith('socks5h://') ||
             s.startsWith('socks4://') || s.startsWith('http://') || s.startsWith('https://');
    });

    if (!useProxy || validProxies.length === 0) {
      const reason = !useProxy
        ? 'Proxy is disabled. Enable proxy and add proxy list before starting.'
        : 'Proxy enabled but no valid proxies found. Add proxies in the Proxy tab first.';
      this.emit('terminal', { type: 'error', message: `BLOCKED: ${reason}` });
      this.emit('terminal', { type: 'warning', message: 'Processing requires proxies to protect the server IP from bans.' });
      this.emit('status', { running: false });
      throw new Error(`PROXY_REQUIRED: ${reason}`);
    }

    await this.cleanup();
    this.isProcessing = true;
    this.useProxy = true;
    this.proxyList = validProxies;
    this.accountLossTracker = new Map();

    const accounts = await this.db.getAllAccounts();
    this.currentAccounts = accounts.filter(a => accountIds.includes(a.id));

    if (this.config.RANDOM_ORDER) {
      for (let i = this.currentAccounts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.currentAccounts[i], this.currentAccounts[j]] = [this.currentAccounts[j], this.currentAccounts[i]];
      }
    }

    this.totalCycles = Math.max(1, Math.min(10, parseInt(repetitions) || 1));
    this.currentCycle = 0;

    this.stats = {
      successCount: 0,
      failCount: 0,
      confirmedBets: 0,
      totalScoreWon: 0,
      totalScoreLost: 0,
      activeSessions: 0,
      netProfit: 0,
      lossCount: 0,
    };

    this.emit('terminal', { type: 'info', message: '🛡️ STEALTH MODE ACTIVATED - Loss Control Enabled' });
    this.emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length}` });
    this.emit('terminal', { type: 'info', message: `🔒 Max Loss/Account: ${this.config.MAX_LOSS_PER_ACCOUNT}` });
    this.emit('terminal', { type: 'info', message: `🔄 Retry on Loss: ${this.config.RETRY_ON_LOSS}` });
    this.emit('terminal', { type: 'info', message: `🎯 Bet: ${this.getCurrentBetAmount()}` });

    this.startMonitor();
    this.processCycles();

    return { started: true, totalAccounts: this.currentAccounts.length, proxyCount: validProxies.length };
  }

  async processCycles() {
    for (let cycle = 1; cycle <= this.totalCycles && this.isProcessing; cycle++) {
      this.currentCycle = cycle;

      const cycleStartDelay = randInt(1000, 4000);
      await this.sleep(cycleStartDelay);

      this.emit('terminal', { type: 'info', message: `\n🔄 Cycle ${cycle}/${this.totalCycles} starting...` });

      await this.processAccounts();

      if (cycle < this.totalCycles && this.isProcessing) {
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
      const targetConcurrent = randInt(this.config.MIN_CONCURRENT, this.config.MAX_CONCURRENT);

      for (const promise of activePromises) {
        if (promise.completed) activePromises.delete(promise);
      }

      while (activePromises.size < targetConcurrent && processed < total) {
        const account = this.currentAccounts[processed];
        
        // Check loss limit
        const accountLoss = this.accountLossTracker.get(account.id) || 0;
        if (accountLoss >= this.config.MAX_LOSS_PER_ACCOUNT) {
          this.emit('terminal', { type: 'warning', message: `⛔ Skipping ${account.username} - Loss limit reached (${accountLoss})` });
          processed++;
          continue;
        }
        
        const promise = this.processAccountWithLossControl(account, processed);
        promise.completed = false;
        promise.then(() => { promise.completed = true; });
        activePromises.add(promise);
        processed++;

        if (processed < total) {
          await this.sleep(randInt(100, 400));
        }
      }

      if (activePromises.size > 0) {
        await Promise.race(activePromises);
      }
    }

    await Promise.allSettled(activePromises);
  }

  async processAccountWithLossControl(account, index) {
    const sessionId = uuidv4().substring(0, 8);
    this.activeProcesses.set(sessionId, account.username);
    this.stats.activeSessions++;

    let retryCount = 0;
    let result = null;
    let lossDetected = false;

    try {
      this.emit('status', {
        running: true,
        current: index + 1,
        total: this.currentAccounts.length,
        activeSessions: this.stats.activeSessions,
        currentAccount: account.username,
      });

      await this.sleep(randInt(100, 500));

      do {
        result = await this.stealthAccountFlow(account, index, sessionId);
        
        if (result && result.isLoss === true) {
          lossDetected = true;
          const currentLoss = this.accountLossTracker.get(account.id) || 0;
          this.accountLossTracker.set(account.id, currentLoss + this.getCurrentBetAmount());
          
          this.emit('terminal', { 
            type: 'warning', 
            message: `💸 Loss on ${account.username}: ${this.getCurrentBetAmount()} (Total: ${this.accountLossTracker.get(account.id)})` 
          });
          
          // Update loss stats
          this.stats.totalScoreLost += this.getCurrentBetAmount();
          this.stats.lossCount++;
        } else if (result && result.winCredit > 0) {
          // Win - reduce loss tracker
          const currentLoss = this.accountLossTracker.get(account.id) || 0;
          const reducedLoss = Math.max(0, currentLoss - result.winCredit);
          this.accountLossTracker.set(account.id, reducedLoss);
          
          this.emit('terminal', { 
            type: 'success', 
            message: `🎉 Win on ${account.username}: +${result.winCredit} (Loss reduced to: ${reducedLoss})` 
          });
          
          // Update win stats
          this.stats.totalScoreWon += result.winCredit;
        }
        
        if (lossDetected && retryCount < this.config.RETRY_ON_LOSS && this.isProcessing) {
          retryCount++;
          this.emit('terminal', { 
            type: 'info', 
            message: `🔄 Retry ${account.username} (${retryCount}/${this.config.RETRY_ON_LOSS})` 
          });
          await this.sleep(randInt(2000, 4000));
          lossDetected = false;
        } else {
          break;
        }
        
      } while (lossDetected && retryCount < this.config.RETRY_ON_LOSS && this.isProcessing);

      // Update final statistics
      if (result && result.success) {
        this.stats.successCount++;
        if (result.confirmed) {
          this.stats.confirmedBets++;
        }

        await this.db.updateAccount({
          ...account,
          score: result.newBalance || account.score,
          last_processed: new Date().toISOString(),
        });
      } else {
        this.stats.failCount++;
      }

      // Update net profit
      this.stats.netProfit = this.stats.totalScoreWon - this.stats.totalScoreLost;

      this.emit('progress', {
        index, 
        total: this.currentAccounts.length,
        account: account.username,
        success: result ? result.success : false,
        loss: result ? result.isLoss : false,
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
    const fingerprint = rand(DEVICE_FINGERPRINTS);
    const userAgent = rand(USER_AGENTS);
    const headers = rand(HEADER_VARIATIONS);

    const finalHeaders = { ...headers };
    if (Math.random() > 0.7) finalHeaders['X-Requested-With'] = 'XMLHttpRequest';

    const proxy = this.getProxyForAccount(index);

    this.log(index, 'info', `${sessionId} | ${fingerprint.model.substring(0, 15)}`);

    const initialBalance = account.score || 0;

    const loginResult = await this.stealthLogin(account, userAgent, finalHeaders, proxy, index, sessionId);
    if (!loginResult.success) {
      return { success: false, error: loginResult.error };
    }

    Object.assign(account, loginResult.accountData);

    await this.sleep(randInt(100, 300));

    const gameResult = await this.stealthGameFlowWithBalanceCheck(
      account, userAgent, finalHeaders, proxy, index, sessionId, initialBalance
    );

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
      let completed = false;
      const startTime = Date.now();

      const cleanup = () => {
        if (completed) return;
        clearTimeout(timeout);
        this.safeClose(ws);
      };

      ws.on('open', () => {
        setTimeout(() => {
          ws.send(JSON.stringify({
            account: account.username,
            password: account.password,
            version: this.config.GAME_VERSION,
            mainID: 100,
            subID: 6,
          }));
        }, randInt(50, 200));
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

  async stealthGameFlowWithBalanceCheck(account, userAgent, headers, proxy, index, sessionId, initialBalance) {
    return new Promise((resolve) => {
      let gameWs = null;
      let heartbeatInterval = null;
      let completed = false;
      let betPlaced = false;
      let resultReceived = false;
      let winCredit = 0;
      let finalBalance = initialBalance;
      let balanceBeforeBet = initialBalance;
      let lossDetected = false;

      const finish = (result) => {
        if (completed) return;
        completed = true;

        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (gameWs) this.safeClose(gameWs);

        // Final balance check for loss detection
        if (betPlaced && !resultReceived) {
          if (finalBalance < balanceBeforeBet) {
            lossDetected = true;
            this.log(index, 'warning', `💸 LOSS: ${balanceBeforeBet} → ${finalBalance}`);
          } else if (finalBalance === balanceBeforeBet) {
            this.log(index, 'warning', `⚠️ Balance unchanged - possible loss`);
            lossDetected = true;
          }
        }

        resolve({
          success: result.success || false,
          confirmed: resultReceived,
          newBalance: finalBalance,
          winCredit: winCredit,
          isLoss: lossDetected,
        });
      };

      const gameTimeout = this.config.GAME_TIMEOUT;

      const mainTimeout = setTimeout(() => {
        if (!completed) {
          this.log(index, 'warning', `⏰ Game timeout`);
          
          if (betPlaced && finalBalance < balanceBeforeBet) {
            lossDetected = true;
          }
          
          finish({
            success: false,
            confirmed: false,
            winCredit: 0,
          });
        }
      }, gameTimeout);

      const wsOptions = {
        handshakeTimeout: randInt(5000, 10000),
        headers: { 'User-Agent': userAgent, 'Origin': 'http://localhost', ...headers },
      };

      if (proxy && this.useProxy) wsOptions.agent = this.makeProxyAgent(proxy);

      gameWs = new WebSocket(this.config.SUPER_ROULETTE_WS_URL, ['wl'], wsOptions);

      gameWs.on('open', () => {
        this.log(index, 'success', `🎮 Game connected`);

        const sendWithDelay = (payload, delay) => {
          setTimeout(() => {
            if (gameWs && gameWs.readyState === WebSocket.OPEN && !completed) {
              gameWs.send(JSON.stringify(payload));
            }
          }, delay);
        };

        sendWithDelay({
          mainID: 1,
          subID: 5,
          userid: account.userid,
          password: account.dynamicpass
        }, randInt(100, 300));

        sendWithDelay({
          mainID: 1,
          subID: 4,
          gameid: account.gameid || 10658796,
          password: account.dynamicpass,
          reenter: 0
        }, randInt(400, 700));

        sendWithDelay({
          route: 31,
          mainID: 200,
          subID: 100
        }, randInt(700, 1100));

        const heartbeatIntervalMs = randInt(4000, 8000);
        heartbeatInterval = setInterval(() => {
          if (gameWs && gameWs.readyState === WebSocket.OPEN && !completed) {
            gameWs.send(JSON.stringify({ mainID: 1, subID: 6, bossid: account.bossid }));
          }
        }, heartbeatIntervalMs);

        sendWithDelay({
          mainID: 1,
          subID: 6,
          bossid: account.bossid
        }, randInt(1000, 1500));

        const betDelay = randInt(1200, 2000);
        setTimeout(() => {
          if (gameWs && gameWs.readyState === WebSocket.OPEN && !completed) {
            const betAmount = this.getCurrentBetAmount();
            betPlaced = true;
            balanceBeforeBet = account.score || initialBalance;
            
            this.log(index, 'info', `🎯 Bet ${betAmount} (Bal: ${balanceBeforeBet})`);

            const betPayload = this.createBetPayload(betAmount);
            gameWs.send(JSON.stringify(betPayload));

            const resultTimeout = setTimeout(() => {
              if (!completed && !resultReceived) {
                this.log(index, 'warning', `⏰ Result timeout - checking balance...`);
                
                if (account.score !== undefined) {
                  finalBalance = account.score;
                }
                
                if (finalBalance < balanceBeforeBet) {
                  lossDetected = true;
                  this.log(index, 'error', `💸 LOSS: ${balanceBeforeBet} → ${finalBalance}`);
                }
                
                finish({
                  success: false,
                  confirmed: false,
                  winCredit: 0,
                });
              }
            }, this.config.RESULT_WAIT);
            
            gameWs._resultTimeout = resultTimeout;
          }
        }, betDelay);
      });

      gameWs.on('message', (raw) => {
        if (completed) return;

        try {
          const msg = JSON.parse(raw.toString());

          if (msg.mainID === 1 && msg.subID === 104 && msg.data?.score != null) {
            finalBalance = msg.data.score;
            account.score = finalBalance;
          }

          if (msg.mainID === 200 && msg.subID === 100 && msg.data?.route === 39) {
            resultReceived = true;
            clearTimeout(mainTimeout);
            
            if (gameWs._resultTimeout) {
              clearTimeout(gameWs._resultTimeout);
              delete gameWs._resultTimeout;
            }

            winCredit = msg.data.winCredit || 0;
            const playerCredit = msg.data.playerCredit || account.score;
            finalBalance = playerCredit;
            account.score = playerCredit;

            if (winCredit > 0) {
              this.log(index, 'success', `🎉 WIN: +${winCredit} | Bal: ${playerCredit}`);
              lossDetected = false;
            } else {
              lossDetected = true;
              this.log(index, 'warning', `💸 LOSS: ${this.getCurrentBetAmount()} lost | Bal: ${playerCredit}`);
            }

            finish({
              success: true,
              confirmed: true,
              newBalance: playerCredit,
              winCredit: winCredit,
              isLoss: lossDetected,
            });
          }
        } catch (e) {}
      });

      gameWs.on('error', (err) => {
        if (!completed) {
          this.log(index, 'error', `❌ Game error: ${err.message}`);
          
          if (betPlaced && finalBalance < balanceBeforeBet) {
            lossDetected = true;
          }
          
          finish({
            success: false,
            confirmed: false,
            winCredit: 0,
            isLoss: lossDetected,
          });
        }
      });

      gameWs.on('close', () => {
        if (!completed) {
          if (betPlaced && finalBalance < balanceBeforeBet) {
            lossDetected = true;
          }
          
          finish({
            success: resultReceived,
            confirmed: resultReceived,
            winCredit: winCredit,
            isLoss: lossDetected,
          });
        }
      });
    });
  }

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
      betData: betData,
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
        message: `📊 ${this.stats.successCount}/${total} (${rate}%) | Active: ${this.stats.activeSessions} | Won: ${this.stats.totalScoreWon} | Lost: ${this.stats.totalScoreLost} | Profit: ${this.stats.netProfit}`,
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

    this.emit('terminal', { type: 'success', message: `\n🎉 COMPLETE: ${this.stats.successCount}/${total} (${rate}%)` });
    this.emit('terminal', { type: 'info', message: `💰 Won: ${this.stats.totalScoreWon} | Lost: ${this.stats.totalScoreLost} | Net: ${this.stats.netProfit}` });
    this.emit('terminal', { type: 'info', message: `💸 Loss Count: ${this.stats.lossCount} | Confirmed Bets: ${this.stats.confirmedBets}` });

    this.emit('completed', {
      successCount: this.stats.successCount,
      failCount: this.stats.failCount,
      totalScoreWon: this.stats.totalScoreWon,
      totalScoreLost: this.stats.totalScoreLost,
      netProfit: this.stats.netProfit,
      confirmedBets: this.stats.confirmedBets,
      lossCount: this.stats.lossCount,
    });
    this.emit('status', { running: false });
  }
}

module.exports = StealthRouletteProcessor;
