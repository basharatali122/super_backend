// proxy.js
const router = require('express').Router();

// GET /api/proxy/:profile
router.get('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(
      req.userId, req.params.profile
    );
    res.json({ success: true, config: db.getProxyConfig() || { enabled: false, proxyUrl: '', proxyList: [] } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxy/:profile
router.post('/:profile', async (req, res) => {
  try {
    const { db, processor } = await req.app.get('botManager').getOrCreateInstance(
      req.userId, req.params.profile
    );
    const { enabled, proxyUrl, proxyList } = req.body;

    // Parse list
    const list = typeof proxyList === 'string'
      ? proxyList.split('\n').map(l => l.trim()).filter(Boolean)
      : (Array.isArray(proxyList) ? proxyList : []);

    const config = { enabled: !!enabled, proxyUrl: (proxyUrl || '').trim(), proxyList: list };
    db.saveProxyConfig(config);

    // Update live processor
    if (processor) {
      processor.useProxy = config.enabled;
      processor.proxyList = config.enabled
        ? (list.length > 0 ? list : (config.proxyUrl ? [config.proxyUrl] : []))
        : [];
      if (processor.proxyList.length > 0) {
        try {
          const u = new URL(processor.proxyList[0]);
          processor.proxyIpKey = `proxy_${u.hostname}_${u.port}`;
        } catch (_) {}
      }
    }

    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxy/:profile/test
router.post('/:profile/test', async (req, res) => {
  try {
    const { proxyUrl } = req.body;
    if (!proxyUrl) return res.status(400).json({ error: 'proxyUrl required' });

    const WebSocket = require('ws');
    let agent;
    if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
      const { HttpsProxyAgent } = require('hpagent');
      agent = new HttpsProxyAgent({ proxy: proxyUrl });
    } else {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      agent = new SocksProxyAgent(proxyUrl);
    }

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ success: false, message: '❌ Timed out after 10s' }), 10000);
      const ws = new WebSocket('ws://milkywayapp.xyz:8580/', ['wl'], {
        agent, handshakeTimeout: 9000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 'Origin': 'http://localhost' }
      });
      ws.on('open', () => { clearTimeout(timeout); ws.close(); resolve({ success: true, message: '✅ Proxy connected successfully!' }); });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        let msg = err.message;
        if (msg.includes('403')) msg = '❌ 403 — proxy blocking destination port';
        else if (msg.includes('407')) msg = '❌ 407 — wrong credentials';
        else if (msg.includes('ECONNREFUSED')) msg = '❌ Connection refused — wrong host/port';
        resolve({ success: false, message: msg });
      });
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
