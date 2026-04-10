const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class WebDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    // Cache prepared statements for performance
    this._stmts = {};
  }

  async init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    // Performance pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');

    this._createTables();
    this._prepareStatements();
    console.log(`✅ Database ready: ${this.dbPath}`);
    return this;
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        score INTEGER DEFAULT 0,
        userid TEXT,
        dynamicpass TEXT,
        bossid TEXT,
        gameid TEXT,
        last_processed DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
      CREATE INDEX IF NOT EXISTS idx_accounts_last_processed ON accounts(last_processed);

      CREATE TABLE IF NOT EXISTS processing_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT,
        message TEXT,
        details TEXT,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS proxy_config (
        id INTEGER PRIMARY KEY,
        config TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        accounts_processed INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        total_bet INTEGER DEFAULT 0,
        total_win INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        session_id TEXT
      );
    `);
  }

  _prepareStatements() {
    this._stmts.getAllAccounts = this.db.prepare('SELECT * FROM accounts ORDER BY created_at DESC');
    this._stmts.addAccount = this.db.prepare(
      'INSERT INTO accounts (username, password, score) VALUES (?, ?, ?)'
    );
    this._stmts.insertOrIgnore = this.db.prepare(
      'INSERT OR IGNORE INTO accounts (username, password, score) VALUES (?, ?, ?)'
    );
    this._stmts.updateAccount = this.db.prepare(`
      UPDATE accounts SET username=?, password=?, score=?, userid=?, dynamicpass=?,
        bossid=?, gameid=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `);
    this._stmts.deleteAccount = this.db.prepare('DELETE FROM accounts WHERE id=?');
    this._stmts.clearAll = this.db.prepare('DELETE FROM accounts');
    this._stmts.countAccounts = this.db.prepare('SELECT COUNT(*) as count FROM accounts');
    this._stmts.getProxyConfig = this.db.prepare('SELECT config FROM proxy_config WHERE id=1');
    this._stmts.saveProxyConfig = this.db.prepare(
      'INSERT OR REPLACE INTO proxy_config (id, config) VALUES (1, ?)'
    );
    this._stmts.saveStats = this.db.prepare(
      'INSERT INTO stats (accounts_processed, wins, total_bet, total_win, success_rate, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._stmts.getStatsTotals = this.db.prepare(`
      SELECT SUM(accounts_processed) as totalProcessed, SUM(wins) as totalWins,
             SUM(total_bet) as totalBet, SUM(total_win) as totalWin,
             COUNT(*) as totalSessions, AVG(success_rate) as avgSuccessRate
      FROM stats
    `);
    this._stmts.getRecentStats = this.db.prepare('SELECT * FROM stats ORDER BY timestamp DESC LIMIT 10');
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  getAllAccounts() {
    return this._stmts.getAllAccounts.all();
  }

  getAccountCount() {
    return this._stmts.countAccounts.get().count;
  }

  addAccount(account) {
    const result = this._stmts.addAccount.run(account.username, account.password, account.score || 0);
    return { id: result.lastInsertRowid, ...account };
  }

  addBulkAccounts(accounts) {
    const insertMany = this.db.transaction((accs) => {
      let added = 0, duplicates = 0;
      for (const a of accs) {
        const result = this._stmts.insertOrIgnore.run(a.username, a.password, a.score || 0);
        if (result.changes > 0) added++; else duplicates++;
      }
      return { added, duplicates };
    });
    return insertMany(accounts);
  }

  updateAccount(account) {
    this._stmts.updateAccount.run(
      account.username, account.password, account.score,
      account.userid || null, account.dynamicpass || null,
      account.bossid || null, account.gameid || null,
      account.id
    );
    return account;
  }

  deleteAccount(id) {
    return this._stmts.deleteAccount.run(id);
  }

  deleteMultipleAccounts(ids) {
    const del = this.db.transaction((idList) => {
      const stmt = this.db.prepare(`DELETE FROM accounts WHERE id IN (${idList.map(() => '?').join(',')})`);
      return stmt.run(...idList);
    });
    return del(ids);
  }

  clearAllAccounts() {
    return this._stmts.clearAll.run();
  }

  // ── Processing logs ───────────────────────────────────────────────────────

  addProcessingLog(accountId, status, message, details = null) {
    return this.db.prepare(
      'INSERT INTO processing_logs (account_id, status, message, details) VALUES (?, ?, ?, ?)'
    ).run(accountId, status, message, details ? JSON.stringify(details) : null).lastInsertRowid;
  }

  getRecentLogs(limit = 100) {
    return this.db.prepare(
      'SELECT * FROM processing_logs ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
  }

  // ── Proxy config ──────────────────────────────────────────────────────────

  saveProxyConfig(config) {
    this._stmts.saveProxyConfig.run(JSON.stringify(config || {}));
    return { saved: true };
  }

  getProxyConfig() {
    const row = this._stmts.getProxyConfig.get();
    if (!row) return null;
    try { return JSON.parse(row.config); } catch (_) { return null; }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  saveSessionStats(stats) {
    this._stmts.saveStats.run(
      stats.accountsProcessed, stats.wins, stats.totalBet,
      stats.totalWin, stats.successRate, stats.sessionId
    );
  }

  getStats() {
    const totals = this._stmts.getStatsTotals.get();
    const recent = this._stmts.getRecentStats.all();
    return { totals, recent };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log(`✅ Database closed: ${this.dbPath}`);
    }
  }
}

module.exports = WebDatabase;
