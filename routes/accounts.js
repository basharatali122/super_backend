// const router = require('express').Router();
// const crypto = require('crypto');

// function md5(str) {
//   return crypto.createHash('md5').update(str).digest('hex');
// }

// function hashPassword(pw) {
//   if (!pw) return md5('');
//   return /^[a-f0-9]{32}$/.test(pw) ? pw : md5(pw);
// }

// // GET /api/accounts/:profile
// router.get('/:profile', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const accounts = db.getAllAccounts();
//     res.json({ success: true, accounts, total: accounts.length });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // POST /api/accounts/:profile — single account
// router.post('/:profile', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const { username, password, score = 0 } = req.body;
//     if (!username || !password) return res.status(400).json({ error: 'username and password required' });
//     const account = db.addAccount({ username: username.trim(), password: hashPassword(password), score });
//     res.json({ success: true, account });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // POST /api/accounts/:profile/bulk
// router.post('/:profile/bulk', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const { accounts } = req.body;
//     if (!Array.isArray(accounts) || accounts.length === 0)
//       return res.status(400).json({ error: 'accounts array required' });

//     const hashed = accounts.map(a => ({
//       username: (a.username || '').trim(),
//       password: hashPassword(a.password),
//       score: a.score || 0,
//     })).filter(a => a.username);

//     const result = db.addBulkAccounts(hashed);
//     res.json({ success: true, ...result });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // POST /api/accounts/:profile/generate — generate accounts by username + numeric range
// // Body: { username, startRange, endRange, password }
// // e.g. username="player", startRange=1, endRange=100 → player1 … player100
// router.post('/:profile/generate', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);

//     const username = (req.body.username || req.body.prefix || 'user').trim();
//     const password = req.body.password || 'password123';

//     // Support both old-style count and new-style startRange/endRange
//     let startRange = parseInt(req.body.startRange) || 1;
//     let endRange   = parseInt(req.body.endRange)   || (parseInt(req.body.count) + startRange - 1) || 100;

//     // Clamp to max 2000 accounts per request
//     if (endRange - startRange + 1 > 2000) endRange = startRange + 1999;
//     if (startRange > endRange) return res.status(400).json({ error: 'startRange must be ≤ endRange' });

//     const padLen = String(endRange).length; // auto-pad width from endRange
//     const hashed = hashPassword(password);

//     const accounts = [];
//     for (let i = startRange; i <= endRange; i++) {
//       accounts.push({
//         username: `${username}${String(i).padStart(padLen, '0')}`,
//         password: hashed,
//         score: 0,
//       });
//     }

//     const result = db.addBulkAccounts(accounts);
//     res.json({ success: true, generated: accounts.length, ...result });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // PUT /api/accounts/:profile/:id
// router.put('/:profile/:id', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const account = { ...req.body, id: parseInt(req.params.id) };
//     if (account.password) account.password = hashPassword(account.password);
//     db.updateAccount(account);
//     res.json({ success: true, account });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // DELETE /api/accounts/:profile/:id
// router.delete('/:profile/:id', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     db.deleteAccount(parseInt(req.params.id));
//     res.json({ success: true });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // DELETE /api/accounts/:profile/bulk/delete
// router.delete('/:profile/bulk/delete', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const { ids } = req.body;
//     if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
//     db.deleteMultipleAccounts(ids);
//     res.json({ success: true, deleted: ids.length });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // DELETE /api/accounts/:profile/all — clear all accounts in a profile
// router.delete('/:profile/all/clear', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     db.clearAllAccounts();
//     res.json({ success: true });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// module.exports = router;



const router = require('express').Router();
const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function hashPassword(pw) {
  if (!pw) return md5('');
  return /^[a-f0-9]{32}$/.test(pw) ? pw : md5(pw);
}

// GET /api/accounts/:profile
router.get('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const accounts = db.getAllAccounts();
    res.json({ success: true, accounts, total: accounts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:profile — single account
router.post('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const { username, password, score = 0 } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const account = db.addAccount({ username: username.trim(), password: hashPassword(password), score });
    res.json({ success: true, account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:profile/bulk
router.post('/:profile/bulk', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0)
      return res.status(400).json({ error: 'accounts array required' });

    const hashed = accounts.map(a => ({
      username: (a.username || '').trim(),
      password: hashPassword(a.password),
      score: a.score || 0,
    })).filter(a => a.username);

    const result = db.addBulkAccounts(hashed);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:profile/generate — generate accounts by username + numeric range
// Body: { username, startRange, endRange, password }
// e.g. username="player", startRange=1, endRange=100 → player1 … player100
router.post('/:profile/generate', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);

    const username = (req.body.username || req.body.prefix || 'user').trim();
    const password = req.body.password || 'password123';

    // Support both old-style count and new-style startRange/endRange
    let startRange = parseInt(req.body.startRange) || 1;
    let endRange   = parseInt(req.body.endRange)   || (parseInt(req.body.count) + startRange - 1) || 100;

    // Clamp to max 2000 accounts per request
    if (endRange - startRange + 1 > 2000) endRange = startRange + 1999;
    if (startRange > endRange) return res.status(400).json({ error: 'startRange must be ≤ endRange' });

    // No zero-padding — generate plain numbers: Kmm1, Kmm2 ... Kmm100
    const hashed = hashPassword(password);

    const accounts = [];
    for (let i = startRange; i <= endRange; i++) {
      accounts.push({
        username: `${username}${i}`,
        password: hashed,
        score: 0,
      });
    }

    const result = db.addBulkAccounts(accounts);
    res.json({ success: true, generated: accounts.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/accounts/:profile/:id
router.put('/:profile/:id', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const account = { ...req.body, id: parseInt(req.params.id) };
    if (account.password) account.password = hashPassword(account.password);
    db.updateAccount(account);
    res.json({ success: true, account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:profile/:id
router.delete('/:profile/:id', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    db.deleteAccount(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:profile/bulk/delete
router.delete('/:profile/bulk/delete', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    db.deleteMultipleAccounts(ids);
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:profile/all — clear all accounts in a profile
router.delete('/:profile/all/clear', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    db.clearAllAccounts();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;