// ───────────────────────────────────────────────────────────────────────────
//  D1 schema management + update de-duplication helpers
// ───────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
//  SCHEMA-ENSURE CACHE
// ─────────────────────────────────────────────────────────────────────────
//
// ensureSchema() used to run its full battery of PRAGMA table_info checks,
// CREATE TABLE statements, and ALTER TABLE ADD COLUMN attempts on EVERY
// single incoming request (~35+ extra D1 queries per message/callback),
// even though the schema essentially never changes once the Worker isolate
// is warm. A Cloudflare Worker isolate can serve many requests before it's
// recycled, so this module-level flag lets ensureSchema() do its real work
// only once per isolate lifetime (the cold start), and become a no-op
// (single boolean check, zero queries) on every request after that.
//
// Both src/index.js (fetch()) and src/cron.js (runScheduledChecks()) import
// ensureSchema from this same module, so — because ES modules are
// singletons — they automatically share this exact cache; no separate
// wiring needed. Whichever of the two runs first on a given isolate does
// the real schema work, and the other one sees schemaEnsured === true and
// returns immediately.
//
// The flag is reset to false (via resetSchemaCache()) anywhere a table
// actually gets DROPped, so the very next ensureSchema() call fully
// rebuilds everything instead of incorrectly short-circuiting against a
// schema that no longer exists.
let schemaEnsured = false;

export function resetSchemaCache() {
  schemaEnsured = false;
}

// ─────────────────────────────────────────────────────────────────────────
//  DATABASE SCHEMA
// ─────────────────────────────────────────────────────────────────────────

/** Returns the set of column names currently present on `table`, or an
 *  empty set if the table doesn't exist at all yet. Used to detect
 *  "table exists but has the wrong shape" situations that plain
 *  `ALTER TABLE ADD COLUMN` can't fix — e.g. a PRIMARY KEY column that's
 *  missing entirely, which SQLite has no way to add after the fact. */
export async function getTableColumns(db, table) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((results || []).map((r) => r.name));
}

/**
 * For TRANSIENT session-data tables only (admin_state, carts,
 * pending_media): if the table already exists but is missing one or more
 * of its expected columns — most notably a PRIMARY KEY column, which
 * `ALTER TABLE ADD COLUMN` structurally cannot add — DROP the table
 * outright so the `CREATE TABLE IF NOT EXISTS` that runs right after this
 * in ensureSchema() recreates it fresh with the correct shape.
 *
 * This is deliberately safe to do only for these three tables: they hold
 * short-lived, easily-regenerated session state (an in-progress cart, a
 * pending admin prompt, a not-yet-classified upload), so losing any
 * in-flight rows here on the rare occasion this actually triggers is a
 * minor, self-recovering inconvenience — the user just re-taps a button
 * or re-uploads. It must NOT be used for orders, subscriptions, tickets,
 * or banned_users, whose rows are durable business records that must
 * never be silently dropped; those stay on the existing
 * addColumnIfMissing() migration path only.
 *
 * If the table doesn't exist yet at all, this is a no-op — there's
 * nothing to drop, and CREATE TABLE IF NOT EXISTS will create it from
 * scratch as normal.
 */
export async function dropTransientTableIfShapeMismatch(db, table, expectedColumns) {
  const existingColumns = await getTableColumns(db, table);
  if (existingColumns.size === 0) return; // table doesn't exist yet — nothing to fix
  const isMissingAColumn = expectedColumns.some((col) => !existingColumns.has(col));
  if (isMissingAColumn) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    // The table this cache was guarding no longer exists in the shape
    // ensureSchema() last verified, so the cache must not be trusted
    // until ensureSchema() runs (or finishes running) again.
    resetSchemaCache();
  }
}

export async function ensureSchema(db) {
  // Cold-start-once cache: after the first successful run on this Worker
  // isolate, every later call (from index.js's fetch() or cron.js's
  // runScheduledChecks()) is a single boolean check and nothing else — no
  // PRAGMA, no CREATE TABLE, no ALTER TABLE. See the cache comment above.
  if (schemaEnsured) return;

  // ── Self-healing for transient session tables ──────────────────────────
  // Must run BEFORE the CREATE TABLE IF NOT EXISTS batch below: if one of
  // these three tables exists but is missing an expected column (e.g. an
  // older/partial admin_state table with no state_key primary key), drop
  // it here so the CREATE TABLE IF NOT EXISTS immediately after actually
  // creates it fresh instead of silently no-op'ing against the malformed
  // existing table.
  await dropTransientTableIfShapeMismatch(db, "admin_state", ["state_key", "chat_id", "thread_id", "action", "payload", "created_at"]);
  await dropTransientTableIfShapeMismatch(db, "carts", ["telegram_user_id", "tier_action", "tier", "split", "addons"]);
  await dropTransientTableIfShapeMismatch(db, "pending_media", ["telegram_user_id", "file_id", "kind", "message_id", "reply_to_message_id"]);

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id     TEXT,
        telegram_username    TEXT,
        telegram_first_name  TEXT,
        telegram_last_name   TEXT,
        plan                 TEXT,   -- T1 | T2 | T3 | ADDONS
        addons               TEXT,   -- letters this order grants (i/t/a/r/c)
        total                REAL,
        is_split             INTEGER DEFAULT 0,
        is_upgrade           INTEGER DEFAULT 0,
        upgrade_from         TEXT,
        status               TEXT,   -- awaiting_choice | awaiting_photo | pending | confirmed | rejected
                                      -- | phase1_active | pending_review_2 | phase1_expired
                                      -- | pending_review_2_late | removed | cancelled
                                      -- (pending_review_2_late = a Tier-2 split customer submitted
                                      -- Installment-2 proof AFTER their 30-day window already
                                      -- lapsed into phase1_expired; reviewed exactly like
                                      -- pending_review_2, except on confirm the bot does NOT
                                      -- attempt to kick them from the temporary Phase 1 channel
                                      -- again, since the daily cron already removed them.)
        media_kind           TEXT,   -- photo | document | video | video_note | animation | voice | sticker
        media_file_id        TEXT,
        media_message_id     INTEGER,
        admin_chat_id        TEXT,
        admin_message_id     INTEGER,
        installment2_due_at  TEXT,
        reminder_days_sent   TEXT DEFAULT '',
        stalled_reminder_sent TEXT DEFAULT '',  -- comma list of STALLED_ORDER_REMINDER_HOURS
                                      -- marks already sent for a non-split
                                      -- order stuck in awaiting_photo /
                                      -- awaiting_choice — see checkStalledOrders()
        confirmed_at         TEXT,
        created_at           TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS tickets (
        telegram_user_id TEXT PRIMARY KEY,
        group_id         TEXT,
        thread_id        INTEGER,
        support_override TEXT  -- SUPPORT_GROUPS.* value when an admin has
                                -- manually pinned this user's routing via
                                -- "🔁 Change Support Level" (usermgmt:setlevel).
                                -- NULL means "no manual pin — compute the
                                -- group from real entitlements as usual."
                                -- See getSupportGroupForUser(). Cleared
                                -- automatically the next time a real order
                                -- confirmation changes the user's actual
                                -- entitlements, so a purchase always wins
                                -- over a stale manual pin.
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS carts (
        telegram_user_id TEXT PRIMARY KEY,
        tier_action      TEXT DEFAULT '', -- 'buy' | 'upgrade' | ''
        tier             TEXT DEFAULT '', -- T1 | T2 | T3
        split            INTEGER DEFAULT 0,
        addons           TEXT DEFAULT ''  -- standalone/renewal add-on letters
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pending_media (
        telegram_user_id    TEXT PRIMARY KEY,
        file_id             TEXT,
        kind                TEXT,
        message_id          INTEGER,
        reply_to_message_id INTEGER  -- message_id (in the user's own DM) this
                                      -- upload was itself a reply to, if any —
                                      -- carried through so the eventual
                                      -- copyMessage into the support thread
                                      -- (see routeMessageToSupportThread) can
                                      -- still be posted as a reply there too.
      )
    `),
    // message_map — remembers that "this message in the user's private
    // chat" and "this copy of it inside the support-group ticket thread"
    // are the same logical message, in both directions. This is what makes
    // two things possible that forwardMessage() alone can never support:
    //   1. Reply-threading: when routing a NEW message that is itself a
    //      reply to an earlier one, we look up the earlier message's twin
    //      on the other side and pass it as copyMessage's reply target, so
    //      the reply relationship is visibly preserved on BOTH sides
    //      instead of arriving as a disconnected new message.
    //   2. Reaction sync: a message_reaction update only ever tells us the
    //      chat_id + message_id it happened on — this table is how we find
    //      which message on the OTHER side to mirror that reaction onto.
    // Every row is created at most once (copyMessage always mints a brand
    // new message_id, so a given user_chat_id+user_message_id or
    // group_id+group_message_id pair can never legitimately repeat), which
    // is why recordMessageMap() below uses a plain INSERT ... ON CONFLICT
    // DO NOTHING rather than an upsert.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS message_map (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_chat_id      TEXT,
        user_message_id   INTEGER,
        group_id          TEXT,
        group_message_id  INTEGER,
        thread_id         INTEGER,
        created_at        TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_map_user ON message_map(user_chat_id, user_message_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_map_group ON message_map(group_id, group_message_id)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT,
        addon            TEXT,
        order_id         INTEGER,
        expires_at       TEXT,
        active           INTEGER DEFAULT 1
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS banned_users (
        telegram_user_id TEXT PRIMARY KEY,
        banned_at        TEXT DEFAULT CURRENT_TIMESTAMP,
        banned_until     TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS admin_state (
        state_key  TEXT PRIMARY KEY, -- "<chat_id>:<thread_id|0>"
        chat_id    TEXT,
        thread_id  INTEGER DEFAULT 0,
        action     TEXT,
        payload    TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id    INTEGER PRIMARY KEY, -- Telegram's update_id, used to
                                           -- de-duplicate at-least-once
                                           -- webhook redelivery
        processed_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    // ── Indexes ────────────────────────────────────────────────────────
    // Added right after table creation so a brand-new database gets them
    // immediately, and an existing database picks them up self-healingly
    // (CREATE INDEX IF NOT EXISTS is as idempotent as CREATE TABLE IF NOT
    // EXISTS). Chosen by grepping every WHERE clause across the codebase
    // for columns that aren't already a table's PRIMARY KEY (tickets.
    // telegram_user_id, carts.telegram_user_id, pending_media.
    // telegram_user_id, admin_state.state_key, and processed_updates.
    // update_id are all PRIMARY KEYs already and don't need one):
    //
    //   orders — looked up by telegram_user_id constantly (crm.js order
    //   history, entitlements.js access checks, shop.js duplicate-order
    //   guards, orders.js review flow), by status alone or combined with
    //   plan/is_split (admin.js dashboard, cron.js stalled/expiry sweeps),
    //   so both single-column and the two real composite access patterns
    //   get covered.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_telegram_user_id ON orders(telegram_user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_status_plan ON orders(status, plan)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_is_split_status ON orders(is_split, status)`),
    //   subscriptions — looked up by telegram_user_id (entitlements.js),
    //   by active+expires_at together (cron.js expiry sweep, admin.js
    //   dashboard's active-subscriber count), and by addon+active+
    //   expires_at together (admin.js broadcast-by-addon targeting).
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_subscriptions_telegram_user_id ON subscriptions(telegram_user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_subscriptions_active_expires_at ON subscriptions(active, expires_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_subscriptions_addon_active_expires_at ON subscriptions(addon, active, expires_at)`),
    //   tickets — telegram_user_id is already the PRIMARY KEY, but
    //   crm.js's admin-group-reply handler looks tickets up the OTHER
    //   direction, by (group_id, thread_id), which needs its own index.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tickets_group_thread ON tickets(group_id, thread_id)`),
    //   banned_users — telegram_user_id is already the PRIMARY KEY;
    //   cron.js's daily unban sweep filters by banned_until instead.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_banned_users_banned_until ON banned_users(banned_until)`),
    //   processed_updates — update_id is already the PRIMARY KEY;
    //   pruneProcessedUpdates() below deletes by processed_at instead.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_processed_updates_processed_at ON processed_updates(processed_at)`)
  ]);

  // ── Self-healing migration ──────────────────────────────────────────────
  // `CREATE TABLE IF NOT EXISTS` above does nothing if a table already
  // exists with an OLDER shape (e.g. this D1 database was previously used
  // by an earlier version of this bot, or by the old per-chapter bot).
  // Every column this bot currently relies on is (re)added here via
  // best-effort ALTER TABLE calls, so the bot self-heals on its very next
  // request no matter what state the database was already in — including
  // right after an admin wipes it (tables get DROPped, then this function
  // runs again and rebuilds everything from scratch).
  //
  // NOTE: this ADD-COLUMN approach only works for tables whose existing
  // rows are worth preserving AND whose missing column isn't a PRIMARY
  // KEY (SQLite can't ALTER TABLE ADD a PRIMARY KEY column). orders,
  // subscriptions, tickets, and banned_users hold durable business
  // records, so they stay on this safe, additive path only. admin_state,
  // carts, and pending_media are handled above instead (drop + recreate),
  // since they're transient session data and one of them (admin_state)
  // has state_key as its PRIMARY KEY.
  await addColumnIfMissing(db, "orders", "telegram_username", "TEXT");
  await addColumnIfMissing(db, "orders", "telegram_first_name", "TEXT");
  await addColumnIfMissing(db, "orders", "telegram_last_name", "TEXT");
  await addColumnIfMissing(db, "orders", "plan", "TEXT");
  await addColumnIfMissing(db, "orders", "addons", "TEXT");
  await addColumnIfMissing(db, "orders", "total", "REAL");
  await addColumnIfMissing(db, "orders", "is_split", "INTEGER DEFAULT 0");
  await addColumnIfMissing(db, "orders", "is_upgrade", "INTEGER DEFAULT 0");
  await addColumnIfMissing(db, "orders", "upgrade_from", "TEXT");
  await addColumnIfMissing(db, "orders", "status", "TEXT");
  await addColumnIfMissing(db, "orders", "media_kind", "TEXT");
  await addColumnIfMissing(db, "orders", "media_file_id", "TEXT");
  await addColumnIfMissing(db, "orders", "media_message_id", "INTEGER");
  await addColumnIfMissing(db, "orders", "admin_chat_id", "TEXT");
  await addColumnIfMissing(db, "orders", "admin_message_id", "INTEGER");
  await addColumnIfMissing(db, "orders", "installment2_due_at", "TEXT");
  await addColumnIfMissing(db, "orders", "reminder_days_sent", "TEXT DEFAULT ''");
  await addColumnIfMissing(db, "orders", "stalled_reminder_sent", "TEXT DEFAULT ''");
  await addColumnIfMissing(db, "orders", "confirmed_at", "TEXT");
  await addColumnIfMissing(db, "orders", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");

  await addColumnIfMissing(db, "carts", "tier_action", "TEXT DEFAULT ''");
  await addColumnIfMissing(db, "carts", "tier", "TEXT DEFAULT ''");
  await addColumnIfMissing(db, "carts", "split", "INTEGER DEFAULT 0");
  await addColumnIfMissing(db, "carts", "addons", "TEXT DEFAULT ''");

  await addColumnIfMissing(db, "subscriptions", "addon", "TEXT");
  await addColumnIfMissing(db, "subscriptions", "order_id", "INTEGER");
  await addColumnIfMissing(db, "subscriptions", "expires_at", "TEXT");
  await addColumnIfMissing(db, "subscriptions", "active", "INTEGER DEFAULT 1");

  await addColumnIfMissing(db, "tickets", "group_id", "TEXT");
  await addColumnIfMissing(db, "tickets", "thread_id", "INTEGER");
  await addColumnIfMissing(db, "tickets", "support_override", "TEXT");

  await addColumnIfMissing(db, "banned_users", "banned_until", "TEXT");

  await addColumnIfMissing(db, "admin_state", "chat_id", "TEXT");
  await addColumnIfMissing(db, "admin_state", "thread_id", "INTEGER DEFAULT 0");
  await addColumnIfMissing(db, "admin_state", "action", "TEXT");
  await addColumnIfMissing(db, "admin_state", "payload", "TEXT");
  await addColumnIfMissing(db, "admin_state", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");

  await addColumnIfMissing(db, "processed_updates", "processed_at", "TEXT DEFAULT CURRENT_TIMESTAMP");

  await addColumnIfMissing(db, "message_map", "user_chat_id", "TEXT");
  await addColumnIfMissing(db, "message_map", "user_message_id", "INTEGER");
  await addColumnIfMissing(db, "message_map", "group_id", "TEXT");
  await addColumnIfMissing(db, "message_map", "group_message_id", "INTEGER");
  await addColumnIfMissing(db, "message_map", "thread_id", "INTEGER");
  await addColumnIfMissing(db, "message_map", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");

  // Everything above completed without throwing — tables, columns, and
  // indexes are all confirmed present. Cache that fact so every later
  // ensureSchema() call on this isolate (from either fetch() or
  // runScheduledChecks()) short-circuits instead of repeating all of this.
  schemaEnsured = true;
}

/** Best-effort ALTER TABLE ADD COLUMN — silently ignores the error SQLite
 *  throws when the column already exists (the common/expected case on
 *  every request after the first). This is what makes ensureSchema()
 *  self-healing: call it as often as you like, on any database in any
 *  state, and every table/column this bot needs will end up present. */
export async function addColumnIfMissing(db, table, column, typeClause) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeClause}`).run();
  } catch (err) {
    // Column already exists (expected) — nothing to do. Any other failure
    // here would also surface loudly the next time that column is
    // actually queried, so it's safe to swallow at this stage.
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  WEBHOOK IDEMPOTENCY  (Telegram's delivery is at-least-once, never
//  exactly-once — the same update_id can legitimately arrive more than
//  once, e.g. if our response was slow/dropped and Telegram retried)
// ─────────────────────────────────────────────────────────────────────────

/** Atomically records that we've seen this update_id. Returns true the
 *  FIRST time it's seen (caller should process the update), or false if
 *  it's a duplicate delivery of an update we already handled (caller
 *  should skip it entirely — re-running a handler for the same update is
 *  exactly what causes double order transitions, double messages, etc).
 *  `update_id` is the table's PRIMARY KEY, so this is race-free even
 *  under truly concurrent invocations: at most one INSERT can win. */
export async function claimUpdateId(db, updateId) {
  const result = await db
    .prepare(`INSERT INTO processed_updates (update_id) VALUES (?) ON CONFLICT(update_id) DO NOTHING`)
    .bind(updateId)
    .run();
  return result.meta.changes > 0;
}

/** Keeps the processed_updates table from growing forever. Telegram's
 *  at-least-once redelivery window is at most a few hours in practice, so
 *  a few days of retention is generous padding. Runs once a day from the
 *  existing cron trigger — no new trigger required. */
export async function pruneProcessedUpdates(db) {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`DELETE FROM processed_updates WHERE processed_at < ?`).bind(cutoff).run();
}

// ─────────────────────────────────────────────────────────────────────────
//  MESSAGE_MAP — user-DM ⇄ support-group-thread message pairing
//  (used for reply-threading via copyMessage and for mirroring reactions —
//  see crm.js: routeMessageToSupportThread, handleAdminGroupReply,
//  handleMessageReaction)
// ─────────────────────────────────────────────────────────────────────────

/** Records that `userMessageId` (in the user's private chat) and
 *  `groupMessageId` (its copy inside the support-group ticket thread) are
 *  the same logical message. Safe to call exactly once per copy — a given
 *  (user_chat_id, user_message_id) or (group_id, group_message_id) pair is
 *  never reused, since copyMessage always mints a fresh message_id, so a
 *  unique-constraint collision here would only ever indicate a genuine
 *  duplicate (e.g. a retried webhook) and is silently ignored either way. */
export async function recordMessageMap(db, { userChatId, userMessageId, groupId, groupMessageId, threadId = null }) {
  await db
    .prepare(
      `INSERT INTO message_map (user_chat_id, user_message_id, group_id, group_message_id, thread_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .bind(String(userChatId), userMessageId, String(groupId), groupMessageId, threadId)
    .run();
}

/** Given a message in the USER's private chat, returns its twin inside the
 *  support-group ticket thread (or null if this message was never routed /
 *  has no twin — e.g. it's older than this feature, or delivery failed). */
export async function getGroupSideOfMessage(db, userChatId, userMessageId) {
  return db
    .prepare(`SELECT group_id, group_message_id, thread_id FROM message_map WHERE user_chat_id = ? AND user_message_id = ?`)
    .bind(String(userChatId), userMessageId)
    .first();
}

/** Given a message inside a support-group ticket thread, returns its twin
 *  in the user's private chat (or null if it has none). */
export async function getUserSideOfMessage(db, groupId, groupMessageId) {
  return db
    .prepare(`SELECT user_chat_id, user_message_id FROM message_map WHERE group_id = ? AND group_message_id = ?`)
    .bind(String(groupId), groupMessageId)
    .first();
}

/** Deletes ALL orders/subscriptions/cart/pending-media rows for a user so
 *  they can order again from a clean slate. Does NOT touch their support
 *  ticket thread mapping (so CRM history/thread continuity is preserved). */
export async function wipeUserData(db, userId) {
  await db.batch([
    db.prepare(`DELETE FROM orders WHERE telegram_user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM subscriptions WHERE telegram_user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM carts WHERE telegram_user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM pending_media WHERE telegram_user_id = ?`).bind(userId)
  ]);
}