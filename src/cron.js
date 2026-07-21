// ───────────────────────────────────────────────────────────────────────────
//  Scheduled (cron) checks — expirations, split-payment deadlines, stalled orders
// ───────────────────────────────────────────────────────────────────────────

import { ADDON_NAMES, CHANNELS, STALLED_ORDER_ADMIN_ESCALATION_DAYS, STALLED_ORDER_REMINDER_HOURS, TIER2_SPLIT, TIER2_SPLIT_REMINDER_DAYS, TIER_NAMES } from './constants.js';
import { kickChatMember, sendMessage } from './telegram.js';
import { escapeHtml, formatAmount, formatDueDate, notifyAdminError } from './utils.js';
import { ensureSchema, pruneProcessedUpdates } from './db.js';
import { channelForExpiredAddon } from './entitlements.js';
import { buildOrderChoiceKeyboard } from './orders.js';

// ─────────────────────────────────────────────────────────────────────────
//  SCHEDULED (CRON) — subscription expiry + split-payment reminders
// ─────────────────────────────────────────────────────────────────────────

export async function checkExpiredSubscriptions(env, db) {
  const nowIso = new Date().toISOString();
  const { results } = await db.prepare(`SELECT * FROM subscriptions WHERE active = 1 AND expires_at <= ?`).bind(nowIso).all();
  const expired = results || [];
  const kickFailures = [];

  for (const sub of expired) {
    try {
      // Atomically claim this expiry before touching anything else: if an
      // admin renewed this exact addon (delete + fresh insert) in the gap
      // between the SELECT above and here, this affects 0 rows and we
      // skip kicking/notifying a user who was just renewed. Claiming
      // BEFORE kicking (rather than after, as before) also means a lost
      // race never kicks anyone in the first place.
      const claimResult = await db.prepare(`UPDATE subscriptions SET active = 0 WHERE id = ? AND active = 1`).bind(sub.id).run();
      if (!claimResult.meta.changes) continue;

      const targets = channelForExpiredAddon(sub.addon);
      for (const chatId of targets) {
        try {
          await kickChatMember(env, chatId, Number(sub.telegram_user_id));
        } catch (err) {
          kickFailures.push(`user ${sub.telegram_user_id} from ${chatId}`);
        }
      }

      const addonName = ADDON_NAMES[sub.addon] || sub.addon;
      await sendMessage(env, sub.telegram_user_id, `⏰ <b>অ্যাক্সেস মেয়াদোত্তীর্ণ হয়েছে</b>\n\nআপনার ${escapeHtml(addonName)}-এর মেয়াদ শেষ হয়ে গেছে, আর আপনার এক্সক্লুসিভ অ্যাক্সেস এখন সাময়িকভাবে বন্ধ। নিচে ট্যাপ করে এখনই নবায়ন করুন — সুযোগটি হাতছাড়া করবেন না!\n\n— NLT Exclusive Mentorship Team`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🛒 মেনু থেকে নবায়ন করুন", callback_data: "menu:buy" }]] }
      });
    } catch (err) {
      console.error(`Failed to process expired subscription ${sub.id}:`, err);
    }
  }

  if (kickFailures.length > 0) {
    await sendMessage(env, env.ADMIN_CHAT_ID, `⚠️ Daily check: couldn't remove ${kickFailures.length} expired member(s):\n${kickFailures.join("\n")}\n\nPlease check bot admin/ban permissions there.`);
  }
}

/** Tier 2 split-payment housekeeping: weekly reminders while waiting on
 *  Installment 2, and kick + admin alert once the 30-day window passes.
 *  This ONLY handles the initial expiry (phase1_active → phase1_expired).
 *  A customer's late screenshot AFTER this point is handled by
 *  processPaymentProof(), which explicitly still accepts orders in
 *  'phase1_expired' and routes them to 'pending_review_2_late'. */
export async function checkSplitPaymentDeadlines(env, db) {
  const now = new Date();
  const { results } = await db.prepare(`SELECT * FROM orders WHERE is_split = 1 AND status = 'phase1_active'`).all();

  for (const order of results || []) {
    if (!order.installment2_due_at) continue;
    const dueAt = new Date(order.installment2_due_at);
    const createdAt = new Date(`${(order.created_at || "").replace(" ", "T")}Z`);
    const daysElapsed = Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));

    if (now >= dueAt) {
      // 30 days passed with no Installment 2 — but atomically claim the
      // expiry FIRST, conditioned on the order still being phase1_active.
      // If the customer submitted proof (or an admin already confirmed
      // it) in the gap between the SELECT above and here, this affects 0
      // rows and we skip kicking someone who's actually mid-review or
      // already fully confirmed.
      const claimResult = await db.prepare(`UPDATE orders SET status = 'phase1_expired' WHERE id = ? AND status = 'phase1_active'`).bind(order.id).run();
      if (!claimResult.meta.changes) continue;

      try {
        await kickChatMember(env, CHANNELS.phase1, Number(order.telegram_user_id));
      } catch (err) {
        /* best-effort */
      }
      await sendMessage(
        env,
        order.telegram_user_id,
        `⏰ <b>Installment 2-এর সময়সীমা পার হয়ে গেছে</b>\n\nনির্ধারিত সময়ে পরিশোধ না হওয়ায় আপনার Phase 1 অ্যাক্সেস সাময়িকভাবে সরিয়ে নেওয়া হয়েছে। এনরোলমেন্ট এখনো সম্পন্ন করতে চাইলে, প্রস্তুত হলে যেকোনো সময় এখানে পেমেন্ট স্ক্রিনশট পাঠান — আমরা অগ্রাধিকার ভিত্তিতে রিভিউ করব।\n\n— NLT Exclusive Mentorship Team`
      );
      await sendMessage(env, env.ADMIN_CHAT_ID, `⚠️ Order #${order.id}: Tier 2 split-payment customer missed the 30-day Installment 2 window. They've been removed from Phase 1 access. A late screenshot from them is still accepted and will route for review.`);
      continue;
    }

    const sentDays = new Set((order.reminder_days_sent || "").split(",").filter(Boolean).map(Number));
    const lastReminderDay = TIER2_SPLIT_REMINDER_DAYS[TIER2_SPLIT_REMINDER_DAYS.length - 1];
    for (const markDay of TIER2_SPLIT_REMINDER_DAYS) {
      if (daysElapsed >= markDay && !sentDays.has(markDay)) {
        sentDays.add(markDay);
        // Escalating urgency: the earliest reminders read as a routine
        // nudge ("almost there"), the final reminder (closest to the
        // 30-day deadline) makes the loss-aversion explicit — losing
        // Phase 1 access is a real, near-term consequence at that point.
        const body =
          markDay === lastReminderDay
            ? `⚠️ <b>শেষ রিমাইন্ডার:</b> Order #${order.id}-এর Installment 2 (${formatAmount(TIER2_SPLIT.installment2)} USDT) পরিশোধের সময়সীমা <b>${formatDueDate(order.installment2_due_at)}</b>-তে শেষ হচ্ছে। এর মধ্যে পরিশোধ না করলে Phase 1 অ্যাক্সেস সাময়িকভাবে বন্ধ হয়ে যাবে। প্রস্তুত হলে এখনই এখানে পেমেন্ট প্রমাণ আপলোড করুন।\n\n— NLT Exclusive Mentorship Team`
            : `🔔 <b>রিমাইন্ডার:</b> আপনার পূর্ণ অ্যাক্সেস, Priority Support, Live Q&A এবং সব add-on মাত্র একধাপ দূরে। Order #${order.id}-এর বাকি Installment 2 (${formatAmount(TIER2_SPLIT.installment2)} USDT) <b>${formatDueDate(order.installment2_due_at)}</b> তারিখের মধ্যে পরিশোধ করুন। প্রস্তুত হলে এখনই এখানে পেমেন্ট প্রমাণ আপলোড করুন।\n\n— NLT Exclusive Mentorship Team`;
        await sendMessage(env, order.telegram_user_id, body, { parse_mode: "HTML" });
      }
    }
    const updatedField = [...sentDays].sort((a, b) => a - b).join(",");
    if (updatedField !== (order.reminder_days_sent || "")) {
      // Same defensive guard — don't write reminder-tracking data for an
      // order that moved past phase1_active in the interim.
      await db.prepare(`UPDATE orders SET reminder_days_sent = ? WHERE id = ? AND status = 'phase1_active'`).bind(updatedField, order.id).run();
    }
  }
}

/** Daily housekeeping for a normal (non-split) single-payment order — a
 *  T1 full purchase, T3, standalone add-on purchase, or a full-price T2
 *  — that's gone quiet in 'awaiting_photo' (customer said "I've Paid"
 *  but never uploaded proof) or 'awaiting_choice' (order created from a
 *  website deep-link but the customer never even tapped "I've Paid").
 *  Without this, these are silent lost sales — nobody ever nudges the
 *  customer back. Tier-2 split orders have their own weekly cadence in
 *  checkSplitPaymentDeadlines() once they reach phase1_active, so
 *  they're explicitly excluded here (is_split = 0) to avoid the two
 *  crons double-handling the same order. */
export async function checkStalledOrders(env, db) {
  const now = new Date();
  const { results } = await db.prepare(`SELECT * FROM orders WHERE is_split = 0 AND status IN ('awaiting_photo', 'awaiting_choice')`).all();

  // Batched into one roll-up message at the end, the same way
  // checkExpiredSubscriptions() batches its kickFailures — one admin
  // ping per cron run instead of one per stale order.
  const staleForAdmin = [];

  for (const order of results || []) {
    const createdAt = new Date(`${(order.created_at || "").replace(" ", "T")}Z`);
    if (isNaN(createdAt.getTime())) continue;
    const hoursElapsed = (now.getTime() - createdAt.getTime()) / (60 * 60 * 1000);
    const daysElapsed = Math.floor(hoursElapsed / 24);

    const sentMarks = new Set((order.stalled_reminder_sent || "").split(",").filter(Boolean).map(Number));
    let sentSomething = false;

    for (const markHour of STALLED_ORDER_REMINDER_HOURS) {
      if (hoursElapsed >= markHour && !sentMarks.has(markHour)) {
        sentMarks.add(markHour);
        sentSomething = true;

        const planLabel = escapeHtml(TIER_NAMES[order.plan] || order.plan);
        if (order.status === "awaiting_choice") {
          // Re-send the exact same choice card + buttons they saw when the
          // order was first created, so they don't have to remember what
          // to do next — just tap.
          await sendMessage(
            env,
            order.telegram_user_id,
            `🔔 <b>রিমাইন্ডার:</b> আপনার <b>Order #${order.id}</b> (${planLabel}) এখনো শুরু হয়নি — আপনার সিট এখনো অপেক্ষায় আছে। প্রস্তুত হলে নিচের বাটনে ট্যাপ করে পেমেন্ট ডিটেইলস দেখুন, কোনো প্রশ্ন থাকলে সাপোর্ট অপশনও ব্যবহার করতে পারেন। আমরা এখানেই আছি।\n\n— NLT Exclusive Mentorship Team`,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: buildOrderChoiceKeyboard(order.id) } }
          );
        } else {
          await sendMessage(
            env,
            order.telegram_user_id,
            `🔔 <b>রিমাইন্ডার:</b> আপনার <b>Order #${order.id}</b> (${planLabel}) প্রায় সম্পন্ন — শুধু পেমেন্ট স্ক্রিনশটটাই বাকি। এখানেই পাঠিয়ে দিন, আমরা সঙ্গে সঙ্গে রিভিউ করে অ্যাক্সেস চালু করে দেব। কোনো সমস্যা হলে নির্দ্বিধায় জানান, আমরা সাহায্য করতে প্রস্তুত।\n\n— NLT Exclusive Mentorship Team`,
            { parse_mode: "HTML" }
          );
        }
      }
    }

    if (sentSomething) {
      const updatedField = [...sentMarks].sort((a, b) => a - b).join(",");
      // Same atomic-conditional guard as checkSplitPaymentDeadlines: only
      // persist the reminder-tracking update if the order is still sitting
      // in the exact status it was in when we read it above. If the
      // customer submitted proof (or tapped "I've Paid") in the gap
      // between the SELECT and here, this affects 0 rows and we don't
      // write stale tracking data onto an order that's already moved on.
      await db.prepare(`UPDATE orders SET stalled_reminder_sent = ? WHERE id = ? AND status = ?`).bind(updatedField, order.id, order.status).run();
    }

    if (daysElapsed > STALLED_ORDER_ADMIN_ESCALATION_DAYS) {
      const who = order.telegram_username ? `@${order.telegram_username}` : order.telegram_user_id;
      staleForAdmin.push(`• #${order.id} — ${escapeHtml(TIER_NAMES[order.plan] || order.plan)} — ${order.status} — ${daysElapsed}d — ${escapeHtml(who)}`);
    }
  }

  if (staleForAdmin.length > 0) {
    await sendMessage(
      env,
      env.ADMIN_CHAT_ID,
      `📋 <b>দীর্ঘদিন আটকে থাকা অর্ডার (${STALLED_ORDER_ADMIN_ESCALATION_DAYS}+ দিন, এখনো proof/payment জমা পড়েনি):</b>\n\n${staleForAdmin.join(
        "\n"
      )}\n\nম্যানুয়াল ফলো-আপ বিবেচনা করুন।`,
      { parse_mode: "HTML" }
    );
  }
}

/** Auto-lifts timed bans whose window has passed, so isBanned() staying
 *  accurate doesn't depend solely on lazy on-read checks. */
export async function checkExpiredBans(env, db) {
  const nowIso = new Date().toISOString();
  const { results } = await db.prepare(`SELECT telegram_user_id FROM banned_users WHERE banned_until IS NOT NULL AND banned_until <= ?`).bind(nowIso).all();
  for (const row of results || []) {
    await db.prepare(`DELETE FROM banned_users WHERE telegram_user_id = ?`).bind(row.telegram_user_id).run();
  }
}

export async function runScheduledChecks(env) {
  try {
    await ensureSchema(env.DB);
    await checkExpiredSubscriptions(env, env.DB);
    await checkSplitPaymentDeadlines(env, env.DB);
    await checkStalledOrders(env, env.DB);
    await checkExpiredBans(env, env.DB);
    await pruneProcessedUpdates(env.DB);
  } catch (err) {
    await notifyAdminError(env, err, "Scheduled checks");
  }
}
