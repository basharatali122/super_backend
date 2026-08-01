const router = require('express').Router();

// GET /api/processing/all/status — MUST be before /:profile routes
router.get('/all/status', (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const profiles = botManager.getActiveProcessors(req.userId);
    res.json({ success: true, profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processing/:profile/start
router.post('/:profile/start', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { processor, db } = await botManager.getOrCreateInstance(
      req.userId, req.params.profile
    );

    if (processor.isProcessing) {
      return res.status(400).json({ error: 'Already processing' });
    }

    const { accountIds, repetitions = 1, betAmount, gameConfig } = req.body;

    // Apply game server config if provided
    if (gameConfig && typeof gameConfig === 'object') {
      const allowed = ['LOGIN_WS_URL', 'SUPER_ROULETTE_WS_URL', 'GAME_VERSION'];
      for (const key of allowed) {
        if (gameConfig[key] && typeof gameConfig[key] === 'string') {
          processor.config[key] = gameConfig[key];
        }
      }
    }

    // Load proxy config from DB
    const proxyConfig = db.getProxyConfig();
    let useProxy  = false;
    let proxyList = [];

    if (proxyConfig?.enabled) {
      useProxy  = true;
      proxyList = Array.isArray(proxyConfig.proxyList)
        ? proxyConfig.proxyList
        : (proxyConfig.proxyList || '').split('\n').filter(Boolean);
    }

    // Get account IDs
    let ids = accountIds;
    if (!ids || ids.length === 0) {
      const accounts = db.getAllAccounts();
      ids = accounts.map(a => a.id);
    }

    if (betAmount) processor.handleBetChange(betAmount);

    // startProcessing will throw PROXY_REQUIRED if proxy not configured
    const result = await processor.startProcessing(ids, repetitions, useProxy, proxyList);
    res.json({ success: true, ...result });
  } catch (err) {
    // PROXY_REQUIRED = user config error → 400, not 500
    const isProxyError = err.message?.startsWith('PROXY_REQUIRED:');
    const status = isProxyError ? 400 : 500;
    const msg = isProxyError ? err.message.replace('PROXY_REQUIRED: ', '') : err.message;
    res.status(status).json({ error: msg, code: isProxyError ? 'PROXY_REQUIRED' : 'SERVER_ERROR' });
  }
});

// POST /api/processing/:profile/stop
router.post('/:profile/stop', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const instance = await botManager.getInstance(req.userId, req.params.profile);
    if (!instance) return res.json({ success: true, message: 'Not running' });
    const result = await instance.processor.stopProcessing();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/processing/:profile/status
router.get('/:profile/status', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const instance = await botManager.getInstance(req.userId, req.params.profile);
    if (!instance) return res.json({ running: false });
    const p = instance.processor;
    res.json({
      running:         p.isProcessing,
      currentCycle:    p.currentCycle,
      totalCycles:     p.totalCycles,
      currentBet:      p.getCurrentBetAmount(),
      proxyEnabled:    p.useProxy,
      adaptiveStagger: p.adaptiveState?.currentStaggerMs,
      activeGameUrl:   p.config?.LOGIN_WS_URL || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/processing/:profile/bet
router.put('/:profile/bet', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { processor } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
    const { amount } = req.body;
    const success = processor.handleBetChange(amount);
    res.json({ success, currentBet: processor.getCurrentBetAmount() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
