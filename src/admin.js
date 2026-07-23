// ───────────────────────────────────────────────────────────────────────────
//  /admin, /stats, /broadcast admin commands + admin_state helpers
// ───────────────────────────────────────────────────────────────────────────

import { ADDON_NAMES, CHANNELS, CHAT_TITLES, SUPPORT_GROUPS } from './constants.js';
import { deleteForumTopic, editOrSendMessage, kickChatMember, safeAnswerCallbackQuery, sendMessage, setChatTitle } from './telegram.js';
import { escapeHtml, formatAmount, interleaveByKey, notifyAdminError, runPacedByChat, sleep } from './utils.js';
import { ensureSchema, resetSchemaCache, wipeUserData } from './db.js';
import { channelForExpiredAddon, createSubscription } from './entitlements.js';

// ─────────────────────────────────────────────────────────────────────────
//  ADMIN DASHBOARD / ADVANCED MENU / BROADCAST
// ─────────────────────────────────────────────────────────────────────────

export async function buildStatsDashboard(db) {
  const nowIso = new Date().toISOString();
  // Was 7 separate awaited db.prepare(...).first() calls fired via
  // Promise.all() — 7 individual round-trips to D1. D1's batch API DOES
  // support read (SELECT) statements, not just writes: db.batch() sends
  // every statement in the array to D1 as ONE HTTP call and runs them
  // together in an implicit transaction, so this collapses those 7
  // round-trips into 1. This matters independently of D1's rows-read
  // billing (which is the same either way) because it also cuts 6
  // subrequests off this single Worker invocation, which is what counts
  // against Workers' per-invocation subrequest limit.
  //
  // The one shape difference from Promise.all()+.first(): db.batch()
  // returns an array of full D1Result objects (each with a `.results`
  // array of rows), not a single row each — so we pull `.results[0]`
  // ourselves below instead of relying on .first()'s built-in unwrapping.
  const [usersResult, revenueResult, todayRevenueResult, pendingResult, t2Result, t3Result, subsResult] = await db.batch([
    db.prepare(`SELECT COUNT(*) as count FROM (SELECT telegram_user_id FROM orders UNION SELECT telegram_user_id FROM tickets)`),
    db.prepare(`SELECT COALESCE(SUM(total), 0) as revenue FROM orders WHERE status = 'confirmed'`),
    db.prepare(`SELECT COALESCE(SUM(total), 0) as revenue FROM orders WHERE status = 'confirmed' AND date(confirmed_at) = date('now')`),
    db.prepare(`SELECT COUNT(*) as count FROM orders WHERE status IN ('pending','pending_review_2','pending_review_2_late')`),
    db.prepare(`SELECT COUNT(DISTINCT telegram_user_id) as count FROM orders WHERE status = 'confirmed' AND plan = 'T2'`),
    db.prepare(`SELECT COUNT(DISTINCT telegram_user_id) as count FROM orders WHERE status = 'confirmed' AND plan = 'T3' AND date(confirmed_at) >= date('now','start of month')`),
    db.prepare(`SELECT COUNT(DISTINCT telegram_user_id) as count FROM subscriptions WHERE active = 1 AND expires_at > ?`).bind(nowIso)
  ]);
  const usersRow = usersResult.results[0];
  const revenueRow = revenueResult.results[0];
  const todayRevenueRow = todayRevenueResult.results[0];
  const pendingRow = pendingResult.results[0];
  const t2Row = t2Result.results[0];
  const t3Row = t3Result.results[0];
  const subsRow = subsResult.results[0];

  // NOTE on revenue accuracy: a split T2 order is a SINGLE orders row that
  // only ever transitions to status = 'confirmed' once, at the moment
  // Installment 2 clears (see handleOrderReviewCallback) — Installment 1
  // alone leaves the order at 'phase1_active', which this SUM never
  // counts. So by the time a split order is included in revenueRow /
  // todayRevenueRow, order.total already holds the TRUE combined amount
  // the customer paid across both installments (TIER2_SPLIT.installment1
  // + TIER2_SPLIT.installment2 = 44 — see computeSitePayloadTotal), not
  // just the $39 full-payment tier price. No double counting, no
  // undercounting.
  return [
    "📊 <b>Admin Dashboard</b>",
    "",
    `👥 Total Unique Users: <b>${usersRow.count}</b>`,
    `💰 Total Lifetime Revenue: <b>${formatAmount(revenueRow.revenue)} USDT</b>`,
    `📅 Today's Revenue: <b>${formatAmount(todayRevenueRow.revenue)} USDT</b>`,
    `⏳ Pending Reviews: <b>${pendingRow.count}</b>`,
    `🎁 Tier 2 Students (all-time, batch cap: 50): <b>${t2Row.count}</b>`,
    `👑 Tier 3 Students This Month (cap: 5): <b>${t3Row.count}</b>`,
    `🔁 Active Timed Add-on Subscribers: <b>${subsRow.count}</b>`
  ].join("\n");
}

export async function handleStatsCommand(env, db, message) {
  await sendMessage(env, message.chat.id, await buildStatsDashboard(db), { parse_mode: "HTML" });
}

export function renderAdminMenu() {
  return {
    text: "🛠 <b>Advanced Admin Menu</b>",
    keyboard: [
      [{ text: "📊 Stats Dashboard", callback_data: "admin:stats" }],
      [{ text: "🏷 Setup Channel/Group Names", callback_data: "admin:setupchannels" }],
      [{ text: "🚫 Remove a User (kick everywhere)", callback_data: "admin:removeuser" }],
      [{ text: "🧹 Wipe Entire Database", callback_data: "admin:wipe" }]
    ]
  };
}

export async function handleAdminCommand(env, message) {
  const view = renderAdminMenu();
  await sendMessage(env, message.chat.id, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
}

/** admin_state is now keyed per (chat_id, thread_id) so that concurrent
 *  flows in different topics of the SAME support group (or the admin
 *  private chat, thread_id 0) never clobber each other. */
export function adminStateKey(chatId, threadId) {
  return `${chatId}:${threadId || 0}`;
}

export async function setAdminState(db, chatId, threadId, action, payload = "") {
  const key = adminStateKey(chatId, threadId);
  await db
    .prepare(
      `INSERT INTO admin_state (state_key, chat_id, thread_id, action, payload) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET action = excluded.action, payload = excluded.payload, created_at = CURRENT_TIMESTAMP`
    )
    .bind(key, String(chatId), threadId || 0, action, payload)
    .run();
}

export async function getAdminState(db, chatId, threadId) {
  return db.prepare(`SELECT * FROM admin_state WHERE state_key = ?`).bind(adminStateKey(chatId, threadId)).first();
}

export async function clearAdminState(db, chatId, threadId) {
  await db.prepare(`DELETE FROM admin_state WHERE state_key = ?`).bind(adminStateKey(chatId, threadId)).run();
}

/** Kicks a user out of EVERY channel/group the bot manages, deletes their
 *  support topic, and wipes their order history so they can order again
 *  from a clean slate. This is a REMOVAL, not a ban — it deliberately
 *  does NOT touch banned_users. A removed user can /start again and
 *  checkout like a brand-new customer. Only the explicit "⛔ Ban User"
 *  flow (handleUserMgmtBanConfirm) writes to banned_users. */
export async function purgeUser(env, db, userId) {
  const allChats = [...Object.values(CHANNELS), ...Object.values(SUPPORT_GROUPS)];
  const failed = [];
  for (const chatId of allChats) {
    try {
      await kickChatMember(env, chatId, Number(userId));
    } catch (err) {
      failed.push(chatId);
    }
    // Small pacing delay so a single user's removals across many chats
    // don't queue up back-to-back and trip Telegram's per-chat rate
    // limit (~20 actions/min/chat). kickChatMember/deleteForumTopic
    // already retry once on a 429 via callTelegramApiWithRetry — this
    // delay just makes hitting that limit less likely in the first place.
    await sleep(75);
  }

  const ticket = await db.prepare(`SELECT * FROM tickets WHERE telegram_user_id = ?`).bind(userId).first();
  if (ticket) {
    try {
      await deleteForumTopic(env, ticket.group_id, ticket.thread_id);
    } catch (err) {
      /* best-effort */
    }
    await db.prepare(`DELETE FROM tickets WHERE telegram_user_id = ?`).bind(userId).run();
  }

  await wipeUserData(db, userId);
  return failed;
}

/** One-time helper: renames all 6 content channels + 4 support groups to
 *  sensible titles. Requires the bot to have "Change Chat Info" admin
 *  rights in each (you've already made it admin everywhere). */
export async function setupChannelNames(env) {
  const failed = [];
  for (const [chatId, title] of Object.entries(CHAT_TITLES)) {
    try {
      await setChatTitle(env, chatId, title);
    } catch (err) {
      failed.push(`${chatId} (${title}): ${err.message}`);
    }
  }
  return failed;
}

export async function getUserIdsForTier(db, tier) {
  const nowIso = new Date().toISOString();
  if (tier === "all") {
    const { results } = await db.prepare(`SELECT telegram_user_id FROM (SELECT telegram_user_id FROM orders UNION SELECT telegram_user_id FROM tickets)`).all();
    return (results || []).map((r) => r.telegram_user_id);
  }
  if (tier === "consultation" || tier === "priority") {
    const letter = tier === "consultation" ? "c" : "r";
    const { results } = await db.prepare(`SELECT DISTINCT telegram_user_id FROM subscriptions WHERE addon = ? AND active = 1 AND expires_at > ?`).bind(letter, nowIso).all();
    return (results || []).map((r) => r.telegram_user_id);
  }
  if (tier === "basic" || tier === "general") {
    const { results } = await db.prepare(`SELECT DISTINCT telegram_user_id FROM orders WHERE status = 'confirmed'`).all();
    const owners = new Set((results || []).map((r) => r.telegram_user_id));
    const { results: allR } = await db.prepare(`SELECT telegram_user_id FROM (SELECT telegram_user_id FROM orders UNION SELECT telegram_user_id FROM tickets)`).all();
    const all = (allR || []).map((r) => r.telegram_user_id);
    return tier === "basic" ? [...owners] : all.filter((u) => !owners.has(u));
  }
  return [];
}

/** Sends one broadcast message, retrying exactly once if Telegram answers
 *  with 429 Too Many Requests — honoring the retry_after seconds it gives
 *  us. Only counts as failed if the retry also fails (or the original
 *  error wasn't a 429 at all, in which case there's nothing to retry). */
export async function sendBroadcastMessageWithRetry(env, userId, text) {
  try {
    await sendMessage(env, userId, text);
    return true;
  } catch (err) {
    const retryAfter = err?.telegramResponse?.parameters?.retry_after;
    if (err?.telegramResponse?.error_code === 429 && retryAfter) {
      await sleep((Number(retryAfter) || 1) * 1000);
      try {
        await sendMessage(env, userId, text);
        return true;
      } catch (retryErr) {
        return false;
      }
    }
    return false;
  }
}

export async function runBroadcastInBackground(env, db, adminChatId, tier, text) {
  try {
    const userIds = await getUserIdsForTier(db, tier);
    if (userIds.length === 0) {
      await sendMessage(env, adminChatId, `No users found in the "${tier}" tier.`);
      return;
    }
    const BATCH_SIZE = 20;
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((userId) => sendBroadcastMessageWithRetry(env, userId, text)));
      for (const r of results) (r.status === "fulfilled" && r.value ? sent++ : failed++);
    }
    await sendMessage(env, adminChatId, `✅ Broadcast complete (tier: ${escapeHtml(tier)}): ${sent} sent, ${failed} failed.`, { parse_mode: "HTML" });
  } catch (err) {
    await notifyAdminError(env, err, `Broadcast (tier: ${tier})`);
  }
}

/** /broadcast no longer sends immediately — it stashes the parsed tier +
 *  message in admin_state and shows an exact preview with explicit
 *  Confirm/Cancel buttons. runBroadcastInBackground is only ever called
 *  from handleBroadcastCallback, after the admin taps "✅ Confirm Send". */
export async function handleBroadcastCommand(env, db, message, ctx) {
  const parts = message.text.split(" ");
  const tierArg = (parts[1] || "").toLowerCase();
  const broadcastText = parts.slice(2).join(" ").trim();
  const validTiers = ["all", "general", "basic", "priority", "consultation"];
  if (!validTiers.includes(tierArg) || !broadcastText) {
    await sendMessage(env, message.chat.id, "Usage: /broadcast [all|general|basic|priority|consultation] [Your Message]");
    return;
  }

  const chatId = String(message.chat.id);
  const threadId = message.message_thread_id || 0;
  await setAdminState(db, chatId, threadId, "awaiting_broadcast_confirm", JSON.stringify({ tier: tierArg, text: broadcastText }));

  await sendMessage(
    env,
    message.chat.id,
    ["📢 <b>Broadcast Preview</b>", "", `<b>Audience:</b> ${escapeHtml(tierArg)}`, "", "<b>Message:</b>", escapeHtml(broadcastText), "", "Send this exactly as shown above?"].join("\n"),
    {
      parse_mode: "HTML",
      message_thread_id: message.message_thread_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Confirm Send", callback_data: "broadcast:confirm" },
          { text: "❌ Cancel", callback_data: "broadcast:cancel" }
        ]]
      }
    }
  );
}

/** Admin taps "✅ Confirm Send" / "❌ Cancel" on the broadcast preview. */
export async function handleBroadcastCallback(env, db, callbackQuery, ctx) {
  const [, action] = (callbackQuery.data || "").split(":");
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const threadId = callbackQuery.message.message_thread_id || 0;

  if (String(chatId) !== String(env.ADMIN_CHAT_ID)) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "🚫 Not authorized.", true);
    return;
  }

  const stateKey = adminStateKey(String(chatId), threadId);
  const state = await db.prepare(`SELECT * FROM admin_state WHERE state_key = ? AND action = 'awaiting_broadcast_confirm'`).bind(stateKey).first();
  if (!state) {
    await editOrSendMessage(env, chatId, messageId, `${callbackQuery.message.text || ""}\n\n⚠️ This broadcast preview has expired or was already handled.`, { reply_markup: { inline_keyboard: [] } });
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Expired.", true);
    return;
  }

  // Atomically consume the pending broadcast state so a double-tap on
  // either button can never act twice (e.g. queue the same broadcast to
  // everyone in the tier a second time).
  const claimResult = await db.prepare(`DELETE FROM admin_state WHERE state_key = ? AND action = 'awaiting_broadcast_confirm'`).bind(stateKey).run();
  if (!claimResult.meta.changes) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Already handled.", true);
    return;
  }

  if (action === "cancel") {
    await editOrSendMessage(env, chatId, messageId, "❌ Broadcast cancelled — nothing was sent.", { reply_markup: { inline_keyboard: [] } });
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Cancelled.");
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(state.payload || "{}");
  } catch (err) {
    payload = null;
  }
  if (!payload || !payload.tier || !payload.text) {
    await editOrSendMessage(env, chatId, messageId, "⚠️ Couldn't read the saved broadcast — please run /broadcast again.", { reply_markup: { inline_keyboard: [] } });
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Error.", true);
    return;
  }

  await editOrSendMessage(env, chatId, messageId, `📢 Broadcast to "${escapeHtml(payload.tier)}" queued — I'll report back shortly.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Sending...");

  const task = runBroadcastInBackground(env, db, chatId, payload.tier, payload.text);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
  else await task;
}

export async function handleAdminMenuCallback(env, db, callbackQuery, ctx) {
  const [, action] = (callbackQuery.data || "").split(":");
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (String(chatId) !== String(env.ADMIN_CHAT_ID)) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "🚫 You're not authorized to do this.", true);
    return;
  }

  if (action === "stats") {
    await editOrSendMessage(env, chatId, messageId, await buildStatsDashboard(db), { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin:home" }]] } });
  } else if (action === "setupchannels") {
    await safeAnswerCallbackQuery(env, callbackQuery.id);
    const failed = await setupChannelNames(env);
    const text = failed.length === 0 ? "✅ All channel/group names updated." : `⚠️ Updated with some failures:\n${failed.join("\n")}`;
    await editOrSendMessage(env, chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin:home" }]] } });
  } else if (action === "removeuser") {
    await setAdminState(db, chatId, 0, "awaiting_remove_user_id");
    await editOrSendMessage(env, chatId, messageId, "🚫 Send the Telegram User ID to remove (as plain text). They'll be kicked from every channel/group and their order history wiped.", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin:cancelstate" }]] }
    });
  } else if (action === "wipe") {
    await setAdminState(db, chatId, 0, "awaiting_wipe_password");
    await editOrSendMessage(
      env,
      chatId,
      messageId,
      "🧹 This will:\n• Kick EVERY user from EVERY channel/group\n• Delete every support topic\n• PERMANENTLY DROP every table (orders, subscriptions, carts, pending media, bans, support tickets, admin state, processed updates) and rebuild them empty\n\nEveryone starts completely fresh. This can take a little while for large user counts — I'll confirm here when it's done. Type the database wipe password to confirm.",
      { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin:cancelstate" }]] } }
    );
  } else if (action === "cancelstate") {
    await clearAdminState(db, chatId, 0);
    const view = renderAdminMenu();
    await editOrSendMessage(env, chatId, messageId, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
  } else {
    const view = renderAdminMenu();
    await editOrSendMessage(env, chatId, messageId, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
  }
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

/** Kicks every known user out of every channel/group and deletes every
 *  support topic, THEN drops and rebuilds all tables. Used exclusively by
 *  the "Wipe Entire Database" admin flow, so a DB wipe also fully cleans
 *  up the live Telegram side (memberships + topics), not just the D1
 *  rows. Runs in the background (ctx.waitUntil) since it can involve many
 *  API calls for larger communities. */
export async function performFullWipe(env, db, adminChatId) {
  try {
    const [{ results: orderUsers }, { results: ticketRows }] = await Promise.all([
      db.prepare(`SELECT DISTINCT telegram_user_id FROM orders`).all(),
      db.prepare(`SELECT telegram_user_id, group_id, thread_id FROM tickets`).all()
    ]);

    const allUserIds = new Set([...(orderUsers || []).map((r) => r.telegram_user_id), ...(ticketRows || []).map((r) => r.telegram_user_id)]);

    // Every (userId, chatId) pair is one kickChatMember call. With many
    // users and only a handful of channels/support groups, most calls are
    // concentrated on the SAME small set of chats — a flat delay between
    // calls (however short) can't respect Telegram's per-chat rate limit
    // (~20 actions/min/chat) once enough calls pile up on one chat, and
    // calls just start failing 429 faster than the single built-in retry
    // in callTelegramApiWithRetry can absorb. interleaveByKey() spreads
    // consecutive calls across DIFFERENT chats first, and runPacedByChat()
    // then only makes a call wait on ITS OWN chat's last call, so kicks to
    // distinct chats fire back-to-back while same-chat kicks get properly
    // spaced out — no more, no less than Telegram actually requires.
    const allChats = [...Object.values(CHANNELS), ...Object.values(SUPPORT_GROUPS)];
    let kickFailures = 0;
    const failedKicks = []; // e.g. "user 123 in chat -100456"
    const kickJobs = interleaveByKey(
      [...allUserIds].flatMap((userId) => allChats.map((chatId) => ({ userId, chatId }))),
      (job) => job.chatId
    );
    await runPacedByChat(kickJobs, (job) => job.chatId, async (job) => {
      try {
        await kickChatMember(env, job.chatId, Number(job.userId));
      } catch (err) {
        kickFailures++;
        failedKicks.push(`user ${job.userId} in ${job.chatId}`);
      }
    });

    // Same reasoning for forum-topic deletion: every user's topic lives in
    // one of only 4 support groups, so with any real number of users most
    // deleteForumTopic calls target the same handful of chats. Pace these
    // per-chat too — this is what was actually causing topics to survive a
    // wipe (silent 429s beyond the single retry, previously only visible if
    // an admin scrolled the failure report), not a missing deletion call.
    let topicFailures = 0;
    let failedTicketRows = []; // rows still pending deletion after the current pass
    const topicJobs = interleaveByKey(ticketRows || [], (t) => t.group_id);
    await runPacedByChat(topicJobs, (t) => t.group_id, async (ticket) => {
      try {
        await deleteForumTopic(env, ticket.group_id, ticket.thread_id);
      } catch (err) {
        failedTicketRows.push(ticket);
      }
    });
    // One paced retry pass over whatever's still left — now that calls are
    // properly spaced per chat, a first-pass failure is much more likely to
    // be a transient blip (or a 429 whose retry_after outlasted the single
    // retry inside callTelegramApiWithRetry) than a real permanent failure,
    // so it's worth giving those a second, equally-paced shot before
    // reporting them to the admin as needing manual cleanup.
    if (failedTicketRows.length > 0) {
      const retryJobs = interleaveByKey(failedTicketRows, (t) => t.group_id);
      const stillFailed = [];
      await runPacedByChat(retryJobs, (t) => t.group_id, async (ticket) => {
        try {
          await deleteForumTopic(env, ticket.group_id, ticket.thread_id);
        } catch (err) {
          stillFailed.push(ticket);
        }
      });
      failedTicketRows = stillFailed;
    }
    topicFailures = failedTicketRows.length;
    const failedTopics = failedTicketRows.map((t) => `${t.group_id} / thread ${t.thread_id}`); // e.g. "group -100456 / thread 42"

    // Every table this bot creates must be dropped here — including
    // processed_updates (webhook-idempotency dedupe table), which was
    // previously missing from this list. Leaving it out would mean a
    // full wipe left stale update_id rows behind while every OTHER table
    // was freshly emptied; harmless on its own (dedupe rows are already
    // pruned daily and only ever block a literal duplicate delivery), but
    // inconsistent with "everyone/everything starts completely fresh".
    // Net effect of including it: right after a wipe, webhook idempotency
    // briefly "resets" (any update_id Telegram might redeliver from
    // before the wipe would no longer be recognized as already-processed)
    // — acceptable, since ensureSchema() immediately recreates the table
    // and it starts filling in again from the very next update.
    await db.batch([
      db.prepare(`DROP TABLE IF EXISTS orders`),
      db.prepare(`DROP TABLE IF EXISTS subscriptions`),
      db.prepare(`DROP TABLE IF EXISTS carts`),
      db.prepare(`DROP TABLE IF EXISTS pending_media`),
      db.prepare(`DROP TABLE IF EXISTS banned_users`),
      db.prepare(`DROP TABLE IF EXISTS tickets`),
      db.prepare(`DROP TABLE IF EXISTS admin_state`),
      db.prepare(`DROP TABLE IF EXISTS processed_updates`)
    ]);
    // ensureSchema() is now cached to only do real work once per Worker
    // isolate (see db.js) — without this reset, an isolate that had
    // already ensured the schema before this wipe would see its cached
    // flag still set to true and skip re-creating the tables we just
    // dropped, leaving the DB schema-less until the isolate happened to
    // recycle. Resetting the cache here forces the call right below to
    // actually run its CREATE TABLE / CREATE INDEX / ALTER TABLE battery
    // again, so it recreates every dropped table (including
    // processed_updates via its own CREATE TABLE IF NOT EXISTS) — the
    // very next webhook call after a wipe is handled on a fully rebuilt,
    // empty schema, no manual follow-up needed.
    resetSchemaCache();
    await ensureSchema(db);

    // Cap the itemized failure list at 15 lines per section so the report
    // stays readable (and under Telegram's message length limits) even for
    // large communities — the rest are summarized as "...and N more".
    const FAILURE_LIST_CAP = 15;
    const formatFailureList = (items) => {
      if (items.length === 0) return "";
      const shown = items.slice(0, FAILURE_LIST_CAP).map((item) => `  • ${escapeHtml(item)}`);
      if (items.length > FAILURE_LIST_CAP) shown.push(`  …and ${items.length - FAILURE_LIST_CAP} more`);
      return shown.join("\n");
    };

    const reportLines = [
      "🧹 <b>Database Wipe Complete</b>",
      "",
      `👥 Users processed: <b>${allUserIds.size}</b>`,
      `🚪 Membership removals with failures: <b>${kickFailures}</b>`,
      `🗑 Support topics deleted: <b>${(ticketRows || []).length - topicFailures}</b> / ${(ticketRows || []).length} (${topicFailures} failed)`
    ];

    if (failedKicks.length > 0) {
      reportLines.push("", "⚠️ Membership removals that failed (manual cleanup may be needed):", formatFailureList(failedKicks));
    }
    if (failedTopics.length > 0) {
      reportLines.push("", "⚠️ Support topics that failed to delete (group_id / thread_id):", formatFailureList(failedTopics));
    }

    reportLines.push("", "Every table was dropped and rebuilt empty. Every user starts completely fresh.");

    await sendMessage(env, adminChatId, reportLines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    await notifyAdminError(env, err, "Full database wipe");
  }
}

/** Handles a plain-text message from the admin chat OR from inside a
 *  support-group ticket thread while an admin_state flow (remove-user id,
 *  wipe password, renewal-days edit) is awaiting input. Returns true if it
 *  consumed the message (so the normal router should stop). */
export async function tryHandleAdminStateInput(env, db, message, ctx) {
  const chatId = String(message.chat.id);
  const threadId = message.message_thread_id || 0;
  const isAdminPrivate = chatId === String(env.ADMIN_CHAT_ID);
  const isSupportGroup = Object.values(SUPPORT_GROUPS).includes(chatId);
  if (!isAdminPrivate && !isSupportGroup) return false;

  const state = await getAdminState(db, chatId, threadId);
  if (!state) return false;

  const text = (message.text || "").trim();

  if (state.action === "awaiting_wipe_password" && isAdminPrivate) {
    await clearAdminState(db, chatId, threadId);
    if (!env.DB_WIPE_PASSWORD || text !== env.DB_WIPE_PASSWORD) {
      await sendMessage(env, chatId, "❌ Incorrect password. Database was NOT wiped.");
      return true;
    }
    await sendMessage(env, chatId, "🧹 Wiping now — removing every member, deleting every support topic, then rebuilding the database. This may take a moment, I'll confirm here when it's done.");
    const task = performFullWipe(env, db, chatId);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
    else await task;
    return true;
  }

  if (state.action === "awaiting_remove_user_id" && isAdminPrivate) {
    await clearAdminState(db, chatId, threadId);
    const userId = text.replace(/[^0-9]/g, "");
    if (!userId) {
      await sendMessage(env, chatId, "❌ That doesn't look like a valid numeric Telegram User ID. Nothing was removed.");
      return true;
    }
    const failed = await purgeUser(env, db, userId);
    await sendMessage(
      env,
      chatId,
      failed.length === 0
        ? `🚫 User <code>${escapeHtml(userId)}</code> removed from everywhere and their data wiped.`
        : `🚫 User <code>${escapeHtml(userId)}</code> data wiped, but the bot couldn't kick them from: ${failed.join(", ")}. Please check bot admin permissions there.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  if (state.action === "awaiting_renewal_days" && isSupportGroup) {
    await clearAdminState(db, chatId, threadId);
    let payload;
    try {
      payload = JSON.parse(state.payload || "{}");
    } catch (err) {
      return true;
    }
    const { userId, letter } = payload;
    const normalized = text.toLowerCase();

    if (normalized === "perm" || normalized === "permanent") {
      // Treat as "no expiry": remove any existing timed rows for this
      // addon and just note it's permanent (only meaningful for 't', but
      // we don't hard-block it — admin's call).
      await db.prepare(`DELETE FROM subscriptions WHERE telegram_user_id = ? AND addon = ?`).bind(userId, letter).run();
      await sendMessage(env, chatId, `✏️ ${escapeHtml(ADDON_NAMES[letter] || letter)} for <code>${escapeHtml(userId)}</code> set to permanent (no expiry tracked).`, {
        parse_mode: "HTML",
        message_thread_id: threadId
      });
      return true;
    }

    const days = parseInt(normalized, 10);
    if (isNaN(days) || days < 0) {
      await sendMessage(env, chatId, "❌ Please reply with a whole number of days (0 or more), or 'perm'.", { message_thread_id: threadId });
      return true;
    }

    await db.prepare(`DELETE FROM subscriptions WHERE telegram_user_id = ? AND addon = ?`).bind(userId, letter).run();
    if (days > 0) {
      await createSubscription(db, userId, letter, null, days);
      await sendMessage(env, chatId, `✏️ ${escapeHtml(ADDON_NAMES[letter] || letter)} for <code>${escapeHtml(userId)}</code> renewed for ${days} day(s) from today.`, {
        parse_mode: "HTML",
        message_thread_id: threadId
      });
    } else {
      // 0 days = expire it right now, and kick from the relevant channel(s).
      const targets = channelForExpiredAddon(letter);
      for (const targetChatId of targets) {
        try {
          await kickChatMember(env, targetChatId, Number(userId));
        } catch (err) {
          /* best-effort */
        }
      }
      await sendMessage(env, chatId, `✏️ ${escapeHtml(ADDON_NAMES[letter] || letter)} for <code>${escapeHtml(userId)}</code> expired immediately.`, {
        parse_mode: "HTML",
        message_thread_id: threadId
      });
    }
    return true;
  }

  return false;
}
