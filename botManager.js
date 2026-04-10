// // const path = require('path');
// // const fs = require('fs');
// // const Database = require('./database/database');
// // const RouletteProcessor = require('./rouletteProcessor');

// // /**
// //  * BotManager — strict profile isolation.
// //  * Each userId:profileName combo gets its own processor + database instance.
// //  * Profiles NEVER share state, sockets, or DB handles.
// //  */
// // class BotManager {
// //   constructor(io) {
// //     this.io = io;
// //     this.instances = new Map();
// //   }

// //   _key(userId, profileName) {
// //     const safe = profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
// //     return `${userId}:${safe}`;
// //   }

// //   _room(userId, profileName) {
// //     return `profile:${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
// //   }

// //   _dataDir(userId, profileName) {
// //     const base = process.env.DATA_DIR || './data';
// //     const safe = profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
// //     const dir = path.join(base, userId, safe);
// //     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
// //     return dir;
// //   }

// //   async getOrCreateInstance(userId, profileName) {
// //     const key = this._key(userId, profileName);
// //     if (this.instances.has(key)) return this.instances.get(key);

// //     const dbPath = path.join(this._dataDir(userId, profileName), 'accounts.db');
// //     const db = new Database(dbPath);
// //     await db.init();

// //     const processor = new RouletteProcessor(db);
// //     processor.instanceId = `${userId.substring(0, 6)}_${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

// //     const room = this._room(userId, profileName);
// //     const emit = (event, data) => this.io.to(room).emit(event, { ...data, _profile: profileName });

// //     const eventMap = {
// //       'terminal': 'bot:terminal', 'status': 'bot:status', 'progress': 'bot:progress',
// //       'completed': 'bot:completed', 'cycleStart': 'bot:cycleStart',
// //       'cycleComplete': 'bot:cycleComplete', 'cycleProgress': 'bot:cycleProgress',
// //       'cycleUpdate': 'bot:cycleUpdate', 'betUpdate': 'bot:betUpdate',
// //       'betConfigChanged': 'bot:betConfigChanged', 'betError': 'bot:betError',
// //     };

// //     const boundHandlers = {};
// //     for (const [procEvent, socketEvent] of Object.entries(eventMap)) {
// //       boundHandlers[procEvent] = (data) => emit(socketEvent, data);
// //       processor.on(procEvent, boundHandlers[procEvent]);
// //     }

// //     const instance = { processor, db, boundHandlers, room, createdAt: Date.now() };
// //     this.instances.set(key, instance);
// //     console.log(`🤖 [${key}] Bot instance created → DB: ${dbPath}`);
// //     return instance;
// //   }

// //   async getInstance(userId, profileName) {
// //     const key = this._key(userId, profileName);
// //     return this.instances.get(key) || null;
// //   }

// //   async destroyInstance(userId, profileName) {
// //     const key = this._key(userId, profileName);
// //     const instance = this.instances.get(key);
// //     if (!instance) return;
// //     try { await instance.processor.stopProcessing(); } catch (_) {}
// //     for (const [procEvent, handler] of Object.entries(instance.boundHandlers)) {
// //       try { instance.processor.off(procEvent, handler); } catch (_) {}
// //     }
// //     instance.processor.removeAllListeners();
// //     try { instance.db.close(); } catch (_) {}
// //     this.instances.delete(key);
// //     console.log(`🗑️ [${key}] Bot instance destroyed`);
// //   }

// //   getActiveProcessors(userId) {
// //     const result = [];
// //     for (const [key, instance] of this.instances.entries()) {
// //       if (!key.startsWith(`${userId}:`)) continue;
// //       const profileName = key.substring(userId.length + 1);
// //       result.push({
// //         profileName,
// //         isRunning: instance.processor.isProcessing,
// //         currentCycle: instance.processor.currentCycle || 0,
// //         totalCycles: instance.processor.totalCycles || 0,
// //       });
// //     }
// //     return result;
// //   }

// //   async shutdownAll() {
// //     const keys = [...this.instances.keys()];
// //     await Promise.allSettled(keys.map(key => {
// //       const [userId, ...rest] = key.split(':');
// //       return this.destroyInstance(userId, rest.join(':'));
// //     }));
// //   }
// // }

// // module.exports = BotManager;


// const path = require('path');
// const fs = require('fs');
// const Database = require('./database/database');
// const RouletteProcessor = require('./rouletteProcessor');
// const SocketCoordinator = require('./socketCoordinator');

// /**
//  * BotManager — strict profile isolation.
//  *
//  * FIXED:
//  *  - Each profile gets its OWN SocketCoordinator instance (not a shared global).
//  *    Profile_1 hitting its socket cap never affects Profile_2, Profile_3, etc.
//  *  - Coordinator is injected into the processor via processor.globalCoordinator
//  *    (the field the processor already reads — no processor changes needed).
//  *  - Coordinator is reset() on destroyInstance so no leaked waiters remain.
//  *  - MAX_SOCKETS_PER_PROFILE is tunable; 15 is safe for 4 concurrent profiles
//  *    on one direct IP. With proxies each profile gets its own IP budget anyway.
//  */

// const MAX_SOCKETS_PER_PROFILE = 15;

// class BotManager {
//   constructor(io) {
//     this.io = io;
//     this.instances = new Map();
//   }

//   _key(userId, profileName) {
//     const safe = profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
//     return `${userId}:${safe}`;
//   }

//   _room(userId, profileName) {
//     return `profile:${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
//   }

//   _dataDir(userId, profileName) {
//     const base = process.env.DATA_DIR || './data';
//     const safe = profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
//     const dir = path.join(base, userId, safe);
//     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
//     return dir;
//   }

//   async getOrCreateInstance(userId, profileName) {
//     const key = this._key(userId, profileName);
//     if (this.instances.has(key)) return this.instances.get(key);

//     const dbPath = path.join(this._dataDir(userId, profileName), 'accounts.db');
//     const db = new Database(dbPath);
//     await db.init();

//     const processor = new RouletteProcessor(db);
//     processor.instanceId = `${userId.substring(0, 6)}_${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

//     // FIX: create a dedicated SocketCoordinator for this profile only.
//     // The processor reads this.globalCoordinator in acquireSocket/releaseSocket/
//     // getGlobalSocketCount — so injecting here wires it up with zero changes
//     // to rouletteProcessor.js.
//     const coordinator = new SocketCoordinator(key, MAX_SOCKETS_PER_PROFILE);
//     processor.globalCoordinator = coordinator;

//     const room = this._room(userId, profileName);
//     const emit = (event, data) => this.io.to(room).emit(event, { ...data, _profile: profileName });

//     const eventMap = {
//       'terminal':         'bot:terminal',
//       'status':           'bot:status',
//       'progress':         'bot:progress',
//       'completed':        'bot:completed',
//       'cycleStart':       'bot:cycleStart',
//       'cycleComplete':    'bot:cycleComplete',
//       'cycleProgress':    'bot:cycleProgress',
//       'cycleUpdate':      'bot:cycleUpdate',
//       'betUpdate':        'bot:betUpdate',
//       'betConfigChanged': 'bot:betConfigChanged',
//       'betError':         'bot:betError',
//     };

//     const boundHandlers = {};
//     for (const [procEvent, socketEvent] of Object.entries(eventMap)) {
//       boundHandlers[procEvent] = (data) => emit(socketEvent, data);
//       processor.on(procEvent, boundHandlers[procEvent]);
//     }

//     const instance = { processor, db, coordinator, boundHandlers, room, createdAt: Date.now() };
//     this.instances.set(key, instance);
//     console.log(`🤖 [${key}] Bot instance created → DB: ${dbPath} | maxSockets: ${MAX_SOCKETS_PER_PROFILE}`);
//     return instance;
//   }

//   async getInstance(userId, profileName) {
//     const key = this._key(userId, profileName);
//     return this.instances.get(key) || null;
//   }

//   async destroyInstance(userId, profileName) {
//     const key = this._key(userId, profileName);
//     const instance = this.instances.get(key);
//     if (!instance) return;

//     try { await instance.processor.stopProcessing(); } catch (_) {}

//     for (const [procEvent, handler] of Object.entries(instance.boundHandlers)) {
//       try { instance.processor.off(procEvent, handler); } catch (_) {}
//     }
//     instance.processor.removeAllListeners();

//     // FIX: reset coordinator — resolves any stuck waiters so shutdown is clean
//     try { instance.coordinator.reset(); } catch (_) {}

//     try { instance.db.close(); } catch (_) {}

//     this.instances.delete(key);
//     console.log(`🗑️ [${key}] Bot instance destroyed`);
//   }

//   getActiveProcessors(userId) {
//     const result = [];
//     for (const [key, instance] of this.instances.entries()) {
//       if (!key.startsWith(`${userId}:`)) continue;
//       const profileName = key.substring(userId.length + 1);
//       result.push({
//         profileName,
//         isRunning:    instance.processor.isProcessing,
//         currentCycle: instance.processor.currentCycle || 0,
//         totalCycles:  instance.processor.totalCycles  || 0,
//         socketCount:  instance.coordinator.getTotalCount(),
//       });
//     }
//     return result;
//   }

//   async shutdownAll() {
//     const keys = [...this.instances.keys()];
//     await Promise.allSettled(keys.map(key => {
//       const [userId, ...rest] = key.split(':');
//       return this.destroyInstance(userId, rest.join(':'));
//     }));
//   }
// }

// module.exports = BotManager;




const path = require('path');
const fs   = require('fs');
const Database         = require('./database/database');
const RouletteProcessor = require('./rouletteProcessor');
const SocketCoordinator = require('./socketCoordinator');

/**
 * BotManager — 200-user scale, single profile per user.
 *
 * KEY DESIGN DECISIONS for scale:
 *
 * 1. ONE profile per user ("Profile_1") — each user's data is isolated by
 *    userId in the file path and socket room. Two users both named "Profile_1"
 *    never touch each other's data.
 *
 * 2. Each instance gets its OWN SocketCoordinator — no shared state between
 *    users. User A exhausting their socket budget never delays User B.
 *
 * 3. MAX_SOCKETS_PER_USER = 12 — with 200 users that's up to 2400 outbound
 *    WebSocket connections to the game server. Tuned to avoid game server
 *    rate bans while keeping per-user throughput high.
 *
 * 4. Lazy creation — instances are only created when a user first accesses
 *    the API. Idle users (logged in but not running) use zero resources.
 *
 * 5. Memory management — instances are NOT auto-destroyed when processing
 *    completes (user may want to restart). Use destroyInstance() on explicit
 *    logout or idle timeout (implement in your session management layer).
 */

const MAX_SOCKETS_PER_USER = parseInt(process.env.MAX_SOCKETS_PER_USER) || 30;

class BotManager {
  constructor(io) {
    this.io        = io;
    this.instances = new Map(); // key → { processor, db, coordinator, boundHandlers, room }
  }

  // ── Key/path helpers ────────────────────────────────────────────────────────

  _key(userId, profileName) {
    return `${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  _room(userId, profileName) {
    return `profile:${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  _dataDir(userId, profileName) {
    const base = process.env.DATA_DIR || './data';
    const dir  = path.join(base, userId, profileName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── Instance lifecycle ──────────────────────────────────────────────────────

  async getOrCreateInstance(userId, profileName) {
    const key = this._key(userId, profileName);
    if (this.instances.has(key)) return this.instances.get(key);

    // Each user gets their own SQLite file — complete data isolation
    const dbPath = path.join(this._dataDir(userId, profileName), 'accounts.db');
    const db = new Database(dbPath);
    await db.init();

    const processor     = new RouletteProcessor(db);
    processor.instanceId = `${userId.substring(0, 8)}_${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    // Each user gets their own socket coordinator — zero cross-user interference
    const coordinator        = new SocketCoordinator(key, MAX_SOCKETS_PER_USER);
    processor.globalCoordinator = coordinator;

    // All events from this processor go only to this user's profile room
    const room = this._room(userId, profileName);
    const emit = (event, data) =>
      this.io.to(room).emit(event, { ...data, _profile: profileName });

    const eventMap = {
      terminal:         'bot:terminal',
      status:           'bot:status',
      progress:         'bot:progress',
      completed:        'bot:completed',
      cycleStart:       'bot:cycleStart',
      cycleComplete:    'bot:cycleComplete',
      cycleProgress:    'bot:cycleProgress',
      cycleUpdate:      'bot:cycleUpdate',
      betUpdate:        'bot:betUpdate',
      betConfigChanged: 'bot:betConfigChanged',
      betError:         'bot:betError',
    };

    const boundHandlers = {};
    for (const [procEvent, socketEvent] of Object.entries(eventMap)) {
      boundHandlers[procEvent] = (data) => emit(socketEvent, data);
      processor.on(procEvent, boundHandlers[procEvent]);
    }

    const instance = { processor, db, coordinator, boundHandlers, room, createdAt: Date.now() };
    this.instances.set(key, instance);

    console.log(`🤖 [${key}] instance created | db: ${dbPath} | maxSockets: ${MAX_SOCKETS_PER_USER}`);
    return instance;
  }

  async getInstance(userId, profileName) {
    return this.instances.get(this._key(userId, profileName)) || null;
  }

  async destroyInstance(userId, profileName) {
    const key      = this._key(userId, profileName);
    const instance = this.instances.get(key);
    if (!instance) return;

    try { await instance.processor.stopProcessing(); } catch (_) {}

    for (const [ev, handler] of Object.entries(instance.boundHandlers)) {
      try { instance.processor.off(ev, handler); } catch (_) {}
    }
    instance.processor.removeAllListeners();

    // Drain any waiting socket acquires so shutdown doesn't hang
    try { instance.coordinator.reset(); } catch (_) {}

    try { instance.db.close(); } catch (_) {}

    this.instances.delete(key);
    console.log(`🗑️ [${key}] instance destroyed`);
  }

  // ── Status helpers ──────────────────────────────────────────────────────────

  /**
   * Returns status for all profiles belonging to a user.
   * With 1 profile per user this returns a single-element array,
   * but the API shape stays identical so the frontend works unchanged.
   */
  getActiveProcessors(userId) {
    const result = [];
    for (const [key, instance] of this.instances.entries()) {
      if (!key.startsWith(`${userId}:`)) continue;
      const profileName = key.substring(userId.length + 1);
      result.push({
        profileName,
        isRunning:    instance.processor.isProcessing,
        currentCycle: instance.processor.currentCycle || 0,
        totalCycles:  instance.processor.totalCycles  || 0,
        socketCount:  instance.coordinator.getTotalCount(),
        accountCount: instance.db.getAccountCount(),
      });
    }
    return result;
  }

  /**
   * Server-wide stats for the /health endpoint.
   */
  getServerStats() {
    let totalInstances = 0, totalRunning = 0, totalSockets = 0;
    for (const instance of this.instances.values()) {
      totalInstances++;
      if (instance.processor.isProcessing) totalRunning++;
      totalSockets += instance.coordinator.getTotalCount();
    }
    return { totalInstances, totalRunning, totalSockets };
  }

  async shutdownAll() {
    const keys = [...this.instances.keys()];
    console.log(`🛑 Shutting down ${keys.length} bot instances...`);
    await Promise.allSettled(keys.map(key => {
      const [userId, ...rest] = key.split(':');
      return this.destroyInstance(userId, rest.join(':'));
    }));
    console.log('✅ All instances shut down');
  }
}

module.exports = BotManager;
