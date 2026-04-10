const router = require('express').Router();

/**
 * FIXED: Route ordering bug.
 * 
 * THE BUG: The original code defined GET /all/status AFTER the parametric
 * routes like /:profile/start. Express matches routes in order, so when a
 * request came in for GET /processing/all/status, the router tried to match
 * "all" as a :profile value and called getInstance(userId, "all") instead
 * of hitting the all-status handler. This returned empty/wrong data.
 *
 * THE FIX: /all/status is declared FIRST, before any /:profile routes.
 * Static route segments always beat parametric ones when declared first.
 */

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

    // ── Apply game server config if provided ────────────────────────────────
    // gameConfig carries { LOGIN_WS_URL, SUPER_ROULETTE_WS_URL, GAME_VERSION }
    // sent from the frontend game selector. Merge into processor.config so
    // it connects to the selected game server for this run.
    if (gameConfig && typeof gameConfig === 'object') {
      const allowed = ['LOGIN_WS_URL', 'SUPER_ROULETTE_WS_URL', 'GAME_VERSION'];
      for (const key of allowed) {
        if (gameConfig[key] && typeof gameConfig[key] === 'string') {
          processor.config[key] = gameConfig[key];
        }
      }
      console.log(`🎮 [${req.userId}:${req.params.profile}] Game server → ${gameConfig.LOGIN_WS_URL || 'default'}`);
    }
    // ────────────────────────────────────────────────────────────────────────

    // Load proxy config from this profile's own database
    const proxyConfig = db.getProxyConfig();
    let useProxy = false;
    let proxyList = [];

    if (proxyConfig?.enabled) {
      useProxy = true;
      proxyList = Array.isArray(proxyConfig.proxyList)
        ? proxyConfig.proxyList
        : (proxyConfig.proxyList || '').split('\n').filter(Boolean);

      if (proxyList.length > 0) {
        try {
          const u = new URL(proxyList[0]);
          processor.proxyIpKey = `proxy_${u.hostname}_${u.port}`;
        } catch (_) {}
      }
    }

    if (betAmount) processor.handleBetChange(betAmount);

    let ids = accountIds;
    if (!ids || ids.length === 0) {
      const accounts = db.getAllAccounts();
      ids = accounts.map(a => a.id);
    }

    const result = await processor.startProcessing(ids, repetitions, useProxy, proxyList);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      running: p.isProcessing,
      currentCycle: p.currentCycle,
      totalCycles: p.totalCycles,
      currentBet: p.getCurrentBetAmount(),
      proxyEnabled: p.useProxy,
      proxyIpKey: p.proxyIpKey,
      adaptiveStagger: p.adaptiveState?.currentStaggerMs,
      // Return the game server currently in use so the frontend can display it
      activeGameUrl: p.config?.LOGIN_WS_URL || null,
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
