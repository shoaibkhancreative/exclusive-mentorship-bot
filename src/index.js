/**
 * =============================================================================
 *  NLT Exclusive Mentorship — Telegram CRM & Course Delivery Bot (v2)
 *  Cloudflare Worker (ES Modules) + Cloudflare D1 + Telegram Bot API
 * =============================================================================
 *
 *  This is a FULL REWRITE of the previous bot to match the current
 *  T1 / T2 / T3 tier + add-on pricing model used on the website
 *  (apps/web/src/data/pricing.js + lib/telegram.js).
 *
 *  ⚠️  IMPORTANT — READ BEFORE DEPLOYING
 *  Because the business model changed completely (old bot sold individual
 *  chapters; new bot sells 3 tiers + 3 add-ons), this file defines a fresh
 *  D1 schema. It is safe to deploy over your EXISTING D1 database — it will
 *  simply create new tables (orders/subscriptions/etc. get new columns
 *  appropriate for this model) — but old order history from the previous
 *  bot will not automatically map to the new tier system. If you want a
 *  totally clean start, point this Worker at a brand-new D1 database.
 *
 *  REQUIRED BINDINGS / ENVIRONMENT VARIABLES (wrangler.toml or dashboard):
 *
 *    DB                 D1 database binding
 *    BOT_TOKEN          Telegram bot token from @BotFather
 *    ADMIN_CHAT_ID      Your personal admin chat id (receives ALL order
 *                       reviews, alerts, and can run /admin, /stats,
 *                       /broadcast — this is NOT one of the 4 group chats)
 *    WEBHOOK_SECRET     Secret string used to verify incoming webhook calls
 *    DB_WIPE_PASSWORD   Secret password required to wipe the database from
 *                       the in-bot Advanced Admin Menu. Pick something long
 *                       and random — anyone who knows it can nuke your DB.
 *
 *  SETTING THE WEBHOOK (run once after deploying):
 *
 *    curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
 *      -d "url=https://<your-worker-subdomain>.workers.dev" \
 *      -d "secret_token=<WEBHOOK_SECRET>"
 *
 *  CRON TRIGGER (required for expiring add-ons / split-payment reminders):
 *  add this to wrangler.toml:
 *
 *    [triggers]
 *    crons = ["0 0 * * *"]
 *
 *  FIRST-TIME SETUP INSIDE TELEGRAM (after webhook is set):
 *    1. Send /setupchannels in your ADMIN_CHAT_ID chat. This makes the bot
 *       automatically rename all 6 content channels + 4 support groups to
 *       sensible names (requires the bot to be an admin with "Change Chat
 *       Info" permission in each — you already made it admin everywhere).
 *    2. Send /admin in your ADMIN_CHAT_ID chat any time to open the
 *       Advanced Admin Menu (stats, broadcast, remove user, wipe DB).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  CHANNEL / GROUP MAPPING
 *  ─────────────────────────────────────────────────────────────────────
 *  You told me you already made the bot admin in 8 private channels and
 *  4 support groups. I've reused those exact IDs from your old code and
 *  re-purposed 6 of the 8 channels for the new model (2 are left spare —
 *  see CHANNELS below — free for you to wire into something later, e.g. a
 *  future add-on).
 *
 *    Content (channels):
 *      core       — the single course channel. ALL tiers (T1/T2/T3) get
 *                   the exact same access here. Recorded class access is
 *                   PERMANENT — it is never revoked, no matter what else
 *                   expires.
 *      insight    — "Daily Market Insight" add-on. Expires after 180 days.
 *      templates  — "Setup Templates (Chart & Journal)" add-on. PERMANENT,
 *                   never expires once granted.
 *      archive    — "Live Trade Breakdown Archive" add-on. Expires after
 *                   180 days.
 *      liveqa     — Bi-Weekly Live Q&A channel (T2/T3 Priority Support
 *                   perk). Expires together with Priority Support (180
 *                   days).
 *      phase1     — Temporary holding channel for Tier 2 "Split Payment"
 *                   customers between Installment 1 and Installment 2.
 *
 *    Support (groups — forum/topics mode required):
 *      general      — anyone who has messaged the bot but never purchased.
 *      basic        — Tier 1 owners (or any tier owner whose Priority /
 *                     Consultation access has lapsed).
 *      priority     — active Priority Support (Tier 2 or Tier 3, 180 days).
 *      consultation — active VIP 1-on-1 Consultation (Tier 3 only, 90
 *                     days). 1-on-1 call links are sent MANUALLY by you —
 *                     the bot only manages group access + reminders.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  PRICING (must match the website — apps/web/src/data/pricing.js)
 *  ─────────────────────────────────────────────────────────────────────
 *    Tier 1 — Recorded Class                : $25  (course + Basic support)
 *    Tier 2 — Live Mentorship               : $39  (+ Priority Support,
 *             Live Q&A, all 3 add-ons free) — or Split: $24 now (unlocks
 *             ONLY the temporary Phase-1 channel) + $20 within 30 days
 *             (unlocks everything else) — true total paid across both
 *             installments is $44 (see TIER2_SPLIT). Miss the 30-day
 *             window → kicked from Phase-1, admin notified. Customer gets
 *             a reminder to pay the balance roughly once a week (4x)
 *             during that month. A late Installment 2 screenshot sent
 *             AFTER the window has closed is still accepted and routed
 *             for review as normal (see phase1_expired handling below).
 *    Tier 3 — 1-on-1 Mentorship             : $149 (everything in Tier 2
 *             + 3 months Weekly 1-on-1 Consultation, personal review)
 *
 *    Standalone add-ons (only sellable outside a tier, or as a renewal
 *    once a bundled add-on has expired):
 *      Daily Market Insight            $15  (180-day access)
 *      Setup Templates (Chart&Journal) $10  (permanent access)
 *      Live Trade Breakdown Archive    $14  (180-day access)
 *
 *    Renewal-only add-ons (only offered once previously granted & lapsed —
 *    NOT sold to someone who never had them; buy/upgrade the tier for
 *    that instead). Prices are NOT specified anywhere on the website, so
 *    I picked sensible defaults below — change PRIORITY_RENEWAL_PRICE_USD
 *    / CONSULTATION_RENEWAL_PRICE_USD to whatever you actually want to
 *    charge:
 *      Renew Priority Support + Live Q&A (180 days)   — see constant below
 *      Renew VIP 1-on-1 Consultation (90 days)          — see constant below
 *
 *    Upgrades: T1→T2/T3 or T2→T3 cost the DIFFERENCE between the tier
 *    prices (what you already paid is deducted). Upgrading fully restores
 *    / restarts every timer (Priority, Live Q&A, Consultation) to a fresh
 *    full duration, as you asked.
 *
 *    No refunds. /refund now returns information about the "ICT Mastery
 *    Accountability Protocol" instead of a refund workflow.
 *  =============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────
//  CONSTANTS — CHANNELS / GROUPS  (IDs carried over from your old bot)
// ─────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
//  Worker entrypoint (fetch/scheduled) + update router
// ───────────────────────────────────────────────────────────────────────────

import { MENU_BUTTON_TEXT, SUPPORT_GROUPS } from './constants.js';
import { editOrSendMessage, safeAnswerCallbackQuery, sendMessage } from './telegram.js';
import { getForwardableMediaKind, isRateLimited, notifyAdminError } from './utils.js';
import { claimUpdateId, ensureSchema } from './db.js';
import { isBanned } from './entitlements.js';
import { handleAdminCommand, handleAdminMenuCallback, handleBroadcastCallback, handleBroadcastCommand, handleStatsCommand, setupChannelNames, tryHandleAdminStateInput } from './admin.js';
import { handleAdminGroupReply, handleUserMgmtCallback, handleUserTextMessage } from './crm.js';
import { handleDeleteUserCallback, handleIncomingMedia, handleKeepUserCallback, handleMediaClassificationCallback, handleOrderChoiceCallback, handleOrderReviewCallback } from './orders.js';
import { handleCartCallback, handleMenuCallback, handleMenuCommand, handleRefundCommand, handleStartCommand, renderMainMenu } from './shop.js';
import { runScheduledChecks } from './cron.js';

/** Top-level callback_query dispatcher. */
export async function handleCallbackQuery(env, db, callbackQuery, ctx) {
  const namespace = (callbackQuery.data || "").split(":")[0];
  const adminOnlyNamespaces = ["confirm", "reject", "deleteuser", "keepuser", "admin", "usermgmt", "broadcast"];
  if (!adminOnlyNamespaces.includes(namespace)) {
    const buttonRateLimitMs = isRateLimited(callbackQuery.from.id, "button");
    if (buttonRateLimitMs) {
      const waitSeconds = Math.max(1, Math.ceil(buttonRateLimitMs / 1000));
      await safeAnswerCallbackQuery(env, callbackQuery.id, `⚠️ অনুগ্রহ করে একটু ধীরে করুন। ${waitSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`, true);
      return;
    }
  }

  try {
    switch (namespace) {
      case "confirm":
      case "reject":
        await handleOrderReviewCallback(env, db, callbackQuery);
        break;
      case "deleteuser":
        await handleDeleteUserCallback(env, db, callbackQuery);
        break;
      case "keepuser":
        await handleKeepUserCallback(env, db, callbackQuery);
        break;
      case "orderchoice":
        await handleOrderChoiceCallback(env, db, callbackQuery);
        break;
      case "mediaclass":
        await handleMediaClassificationCallback(env, db, callbackQuery);
        break;
      case "menu":
        await handleMenuCallback(env, db, callbackQuery);
        break;
      case "cart":
        await handleCartCallback(env, db, callbackQuery);
        break;
      case "usermgmt":
        await handleUserMgmtCallback(env, db, callbackQuery);
        break;
      case "admin":
        await handleAdminMenuCallback(env, db, callbackQuery, ctx);
        break;
      case "broadcast":
        await handleBroadcastCallback(env, db, callbackQuery, ctx);
        break;
      default: {
        // Never leave the customer on a dead end: a button that no longer
        // maps to anything (a stale message from before a bot update, an
        // expired flow, etc) falls back to re-rendering the main menu
        // instead of a bare "Unrecognized action" toast with no next step.
        const view = renderMainMenu();
        await editOrSendMessage(env, callbackQuery.message.chat.id, callbackQuery.message.message_id, view.text, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: view.keyboard }
        });
        await safeAnswerCallbackQuery(env, callbackQuery.id, "সেই অ্যাকশনটি আর উপলব্ধ নেই — এই যে মেনু।");
      }
    }
  } catch (err) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "⚠️ কিছু একটা সমস্যা হয়েছে।", true).catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────────────────────────────────

export async function routeUpdate(env, db, update, ctx) {
  // Telegram's webhook delivery is at-least-once, never exactly-once — the
  // same update_id can legitimately arrive more than once (e.g. our
  // response was slow or dropped and Telegram retried). Claim it here,
  // atomically, before doing anything else: if this exact update_id has
  // already been recorded, every handler below is skipped entirely rather
  // than re-run — re-running is exactly what caused double order
  // transitions / double messages before this fix.
  if (update.update_id != null) {
    const isNewUpdate = await claimUpdateId(db, update.update_id);
    if (!isNewUpdate) {
      console.log(`Update ${update.update_id}: duplicate delivery — already processed, skipping.`);
      return;
    }
  }

  if (update.callback_query) {
    await handleCallbackQuery(env, db, update.callback_query, ctx);
    return;
  }

  const message = update.message;
  if (!message) return;

  const isPrivateChat = message.chat.type === "private";
  const chatIdStr = String(message.chat.id);
  const isSupportGroup = Object.values(SUPPORT_GROUPS).includes(chatIdStr);
  const isAdminChat = chatIdStr === String(env.ADMIN_CHAT_ID);

  if ((isAdminChat || isSupportGroup) && message.text && (await tryHandleAdminStateInput(env, db, message, ctx))) {
    return;
  }

  const hasMedia = Array.isArray(message.photo) && message.photo.length > 0 || message.document || message.video || message.video_note || message.animation;

  if (isAdminChat && message.text && message.text.startsWith("/stats")) {
    await handleStatsCommand(env, db, message);
  } else if (isAdminChat && message.text && message.text.startsWith("/broadcast")) {
    await handleBroadcastCommand(env, db, message, ctx);
  } else if (isAdminChat && message.text && message.text.startsWith("/admin")) {
    await handleAdminCommand(env, message);
  } else if (isAdminChat && message.text && message.text.startsWith("/setupchannels")) {
    const failed = await setupChannelNames(env);
    await sendMessage(env, message.chat.id, failed.length === 0 ? "✅ All channel/group names updated." : `⚠️ Some failed:\n${failed.join("\n")}`);
  } else if (isPrivateChat && hasMedia) {
    await handleIncomingMedia(env, db, message);
  } else if (isPrivateChat && message.text && message.text.startsWith("/start")) {
    await handleStartCommand(env, db, message);
  } else if (isPrivateChat && message.text && message.text.startsWith("/refund")) {
    await handleRefundCommand(env, db, message);
  } else if (isPrivateChat && message.text && (message.text.startsWith("/menu") || message.text === MENU_BUTTON_TEXT)) {
    await handleMenuCommand(env, db, message);
  } else if (isPrivateChat && message.text && !message.text.startsWith("/")) {
    if (await isBanned(db, String(message.from.id))) {
      await sendMessage(env, message.chat.id, "মেন্টরশিপ টিম আপনার অ্যাক্সেস বাতিল করেছে। এটি ভুল হয়েছে মনে করলে অনুগ্রহ করে সরাসরি সাপোর্টে যোগাযোগ করুন।\n\n— NLT Exclusive Mentorship Team");
      return;
    }
    await handleUserTextMessage(env, db, message);
  } else if (isSupportGroup && message.message_thread_id && (getForwardableMediaKind(message) || (message.text && !message.text.startsWith("/")))) {
    await handleAdminGroupReply(env, db, message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  WORKER ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "GET") return new Response("Bot is running ✅", { status: 200 });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.WEBHOOK_SECRET || secretHeader !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

      await ensureSchema(env.DB);
      const update = await request.json();
      console.log(`Update ${update.update_id}: ${update.message ? "message" : update.callback_query ? "callback_query" : "other"}`);
      await routeUpdate(env, env.DB, update, ctx);

      return new Response("OK", { status: 200 });
    } catch (error) {
      await notifyAdminError(env, error, "Top-level fetch handler");
      return new Response("OK", { status: 200 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledChecks(env));
  }
};
