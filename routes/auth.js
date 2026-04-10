const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');

// GET /api/auth/me — verify token and return user info
router.get('/me', verifyToken, (req, res) => {
  res.json({ success: true, userId: req.userId, email: req.userEmail });
});

module.exports = router;
