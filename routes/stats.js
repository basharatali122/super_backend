const router = require('express').Router();

// GET /api/stats/:profile
router.get('/:profile', async (req, res) => {
  try {
    const { db, processor } = await req.app.get('botManager').getOrCreateInstance(
      req.userId, req.params.profile
    );
    const stats = db.getStats();
    const liveStats = processor ? {
      isRunning: processor.isProcessing,
      currentCycle: processor.currentCycle,
      successCount: processor.cycleStats?.successCount || 0,
      failCount: processor.cycleStats?.failCount || 0,
      totalBetAmount: processor.cycleStats?.totalBetAmount || 0,
      totalWinAmount: processor.cycleStats?.totalWinAmount || 0,
      currentBet: processor.getCurrentBetAmount(),
    } : null;

    res.json({ success: true, ...stats, live: liveStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


// ─────────────────────────────────────────────────────────────────────────────
// auth.js — minimal auth routes (Firebase handles actual auth on client side)
// ─────────────────────────────────────────────────────────────────────────────
