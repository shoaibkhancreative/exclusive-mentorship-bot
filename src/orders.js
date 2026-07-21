// ───────────────────────────────────────────────────────────────────────────
//  Order creation review, payment-proof processing, order-related callbacks
// ───────────────────────────────────────────────────────────────────────────

import { CHANNELS, PAYMENT_REVIEW_EXPECTATION_TEXT, SPLIT_INSTALLMENT2_STATUSES, SUPPORT_GROUPS, TIER2_SPLIT, TIER_NAMES } from './constants.js';
import { editOrSendMessage, forwardMessage, kickChatMember, safeAnswerCallbackQuery, sendMessage } from './telegram.js';
import { escapeHtml, formatAddonsList, formatAmount, formatDueDate, getForwardableMediaKind, isRateLimited, notifyAdminError } from './utils.js';
import { wipeUserData } from './db.js';
import { getSupportGroupForUser, getUserBestTier, grantChannelInvite, grantEntitlementsForOrder, hasOpenPaymentOrder } from './entitlements.js';
import { buildAdminChatButton, moveUserTicketToGroup, routeMessageToSupportThread } from './crm.js';

export function buildOrderSummary(order) {
  const lines = [`<b>Order #${order.id}</b>`, `Plan: ${escapeHtml(TIER_NAMES[order.plan] || order.plan)}`];
  if (order.is_upgrade) lines.push(`⬆️ Upgrade from: ${escapeHtml(TIER_NAMES[order.upgrade_from] || order.upgrade_from)}`);
  lines.push(`Add-ons granted: ${escapeHtml(formatAddonsList(order.addons))}`);
  if (order.is_split) {
    const stage = SPLIT_INSTALLMENT2_STATUSES.includes(order.status) ? "Installment 2" : "Installment 1";
    lines.push(`Payment plan: Split (${stage} of 2)`);
  }
  lines.push(`Amount due this step: ${formatAmount(getOrderDueAmount(order))} USDT`);
  return lines.join("\n");
}

/** The amount due for whatever step this order is currently on. */
export function getOrderDueAmount(order) {
  if (order.is_split) {
    const inSecondStage = SPLIT_INSTALLMENT2_STATUSES.includes(order.status) || order.confirmed_at;
    return inSecondStage ? TIER2_SPLIT.installment2 : TIER2_SPLIT.installment1;
  }
  return order.total;
}

/** Stylish welcome card shown right after a site-checkout deep-link,
 *  BEFORE any payment address is revealed. */
export function buildOrderChoiceCard(order, fullName) {
  return [
    `👋 <b>স্বাগতম, ${escapeHtml(fullName)}!</b>`,
    "",
    "🎉 <b>আপনার সিট নিশ্চিত করা হয়েছে — এক্সক্লুসিভ মেন্টরশিপে আপনার জায়গা রিজার্ভড।</b>",
    "",
    `📦 <b>প্যাকেজ:</b> ${escapeHtml(TIER_NAMES[order.plan] || order.plan)}`,
    order.addons ? `✨ <b>এর সাথে আছে:</b> ${escapeHtml(formatAddonsList(order.addons))}` : "",
    `💵 <b>পরিশোধযোগ্য পরিমাণ:</b> ${formatAmount(getOrderDueAmount(order))} USDT`,
    "",
    "আপনার অ্যাক্সেস মাত্র একধাপ দূরে — নিচের কোনটি এখন আপনার জন্য প্রযোজ্য?",
    "",
    "— NLT Exclusive Mentorship Team"
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildOrderChoiceKeyboard(orderId) {
  return [
    [{ text: "✅ পেমেন্ট করেছি — পেমেন্ট ডিটেইলস দেখান", callback_data: `orderchoice:paid:${orderId}` }],
    [{ text: "💬 আগে সাপোর্ট প্রয়োজন", callback_data: `orderchoice:support:${orderId}` }]
  ];
}

/** Any incoming forwardable media (photo/document/video/video_note/
 *  animation/voice/sticker — see getForwardableMediaKind) is routed based
 *  on whether the user CURRENTLY has an order actually awaiting payment
 *  proof — checked directly against the orders table each time
 *  (hasOpenPaymentOrder), not a separate mutable "mode" flag that could
 *  drift out of sync with the order's real status:
 *   - Order in 'awaiting_photo', 'phase1_active', or 'phase1_expired' →
 *     ask "what is this for?" (Payment Proof vs Support). Applies
 *     uniformly to every media kind — photos, voice notes, and stickers
 *     alike, and to both on-time and late Installment-2 submissions.
 *   - No such order → skip the question entirely and forward it straight
 *     into their support thread, same as a text message would be. */
export async function handleIncomingMedia(env, db, message) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);

  const mediaRateLimitMs = isRateLimited(userId, "media");
  if (mediaRateLimitMs) {
    const waitSeconds = Math.max(1, Math.ceil(mediaRateLimitMs / 1000));
    await sendMessage(env, chatId, `⚠️ অনুগ্রহ করে একটু ধীরে করুন। ${waitSeconds} সেকেন্ড পর আবার চেষ্টা করুন।\n\n— NLT Exclusive Mentorship Team`);
    return;
  }

  const kind = getForwardableMediaKind(message);

  const awaitingPayment = await hasOpenPaymentOrder(db, userId);
  if (!awaitingPayment) {
    await routeMessageToSupportThread(env, db, message.from, chatId, message.message_id, kind);
    return;
  }

  if (!kind) return; // Unsupported media type — ignore.

  // photo is the one irregular case: Telegram sends an array of sizes, and
  // we want the largest/last one. Every other kind's file_id sits directly
  // on message[kind] — the exact same field getForwardableMediaKind() just
  // checked (message.voice, message.sticker, message.document, ...) — so a
  // single lookup covers document/video/video_note/animation/voice/sticker.
  const fileId = kind === "photo" ? message.photo[message.photo.length - 1].file_id : message[kind].file_id;

  await db
    .prepare(
      `INSERT INTO pending_media (telegram_user_id, file_id, kind, message_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET file_id = excluded.file_id, kind = excluded.kind, message_id = excluded.message_id`
    )
    .bind(userId, fileId, kind, message.message_id)
    .run();

  await sendMessage(env, chatId, "এটি কীসের জন্য?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🧾 পেমেন্ট স্ক্রিনশট/প্রমাণ", callback_data: "mediaclass:payment" },
          { text: "💬 সাপোর্ট / অন্যকিছু", callback_data: "mediaclass:support" }
        ]
      ]
    }
  });
}

/** Processes media that's been classified as payment proof. Finds the
 *  right in-flight order (handles normal single-step orders, Tier-2
 *  split-payment installment 1 → installment 2 progression, AND a late
 *  Installment-2 screenshot submitted after the 30-day window already
 *  lapsed into 'phase1_expired'), then forwards the original media to the
 *  admin followed by a review card with Confirm/Reject + the permanent
 *  chat button. */
export async function processPaymentProof(env, db, fromUser, chatId, mediaKind, fileId, mediaMessageId) {
  const userId = String(fromUser.id);

  const order = await db
    .prepare(
      `SELECT * FROM orders WHERE telegram_user_id = ? AND status IN ('awaiting_photo','phase1_active','phase1_expired') ORDER BY id DESC LIMIT 1`
    )
    .bind(userId)
    .first();

  if (!order) {
    await sendMessage(env, chatId, "আপনার জন্য এই মুহূর্তে কোনো পেন্ডিং অর্ডার দেখা যাচ্ছে না। কেনাকাটা শুরু করতে 📚 মেনু বাটনে ট্যাপ করুন।\n\n— NLT Exclusive Mentorship Team");
    return;
  }

  const statusAtRead = order.status;
  // phase1_active (on-time Installment 2) → pending_review_2
  // phase1_expired (LATE Installment 2, window already lapsed) → pending_review_2_late
  // anything else (awaiting_photo — non-split order, or Installment 1) → pending
  const nextStatus =
    statusAtRead === "phase1_active" ? "pending_review_2" : statusAtRead === "phase1_expired" ? "pending_review_2_late" : "pending";

  // Atomic conditional update — guards against double-processing if this
  // gets triggered twice for the same order (a fast double-tap on the
  // "Payment Screenshot/Proof" classification button, or a duplicate
  // webhook delivery slipping through for any other reason).
  const updateResult = await db
    .prepare(`UPDATE orders SET status = ?, media_kind = ?, media_file_id = ?, media_message_id = ? WHERE id = ? AND status = ?`)
    .bind(nextStatus, mediaKind, fileId, mediaMessageId, order.id, statusAtRead)
    .run();

  if (!updateResult.meta.changes) {
    await sendMessage(env, chatId, "✅ পেয়েছি — এই অর্ডারটি ইতিমধ্যেই রিভিউ করা হচ্ছে।\n\n— NLT Exclusive Mentorship Team");
    return;
  }

  order.status = nextStatus;
  order.media_kind = mediaKind;

  const nameLine = escapeHtml(fromUser.first_name || "Customer");
  const usernameLine = fromUser.username ? `@${escapeHtml(fromUser.username)}` : `ID ${userId}`;

  const lateNote = statusAtRead === "phase1_expired" ? "\n\n⏰ <b>Note:</b> this is a LATE Installment 2 submission — their 30-day window had already lapsed." : "";
  const caption = ["🧾 <b>New Payment Submission</b>", "", `From: ${nameLine} (${usernameLine})`, `User ID: <code>${userId}</code>`, "", buildOrderSummary(order) + lateNote].join("\n");
  const chatButton = await buildAdminChatButton(env, db, fromUser);
  const reviewKeyboard = [[{ text: "✅ Confirm", callback_data: `confirm:${order.id}` }, { text: "❌ Reject", callback_data: `reject:${order.id}` }]];
  if (chatButton) reviewKeyboard.push([chatButton]);

  // Forwarding the raw proof + posting the review card can fail
  // independently of the DB update above (network blip, the customer
  // deleting the source message right after sending it, etc). If that
  // happens, the order must NOT be left silently stuck in
  // 'pending'/'pending_review_2'/'pending_review_2_late' with no review
  // card and no admin aware of it — so on any failure here we fall back
  // to a plain-text admin alert carrying the order ID (the media_file_id
  // is already saved on the order row either way, so it isn't lost), and
  // we still confirm receipt to the customer below regardless of which
  // path succeeded, since asking them to resend would just create a
  // second submission for the same order.
  let adminNotified = false;
  try {
    await forwardMessage(env, env.ADMIN_CHAT_ID, chatId, mediaMessageId);
    const adminMessage = await sendMessage(env, env.ADMIN_CHAT_ID, caption, { parse_mode: "HTML", reply_markup: { inline_keyboard: reviewKeyboard } });
    await db.prepare(`UPDATE orders SET admin_chat_id = ?, admin_message_id = ? WHERE id = ?`).bind(String(env.ADMIN_CHAT_ID), adminMessage.message_id, order.id).run();
    adminNotified = true;
  } catch (err) {
    console.error(`processPaymentProof: failed to forward proof / notify admin for order #${order.id}:`, err);
    await notifyAdminError(env, err, `processPaymentProof: forwardMessage failed for order #${order.id} (user ${userId})`, { mediaKind });
  }

  if (!adminNotified) {
    try {
      const adminMessage = await sendMessage(
        env,
        env.ADMIN_CHAT_ID,
        ["⚠️ <b>Payment proof received but forwarding failed</b>", "Please open this customer's chat directly to view the screenshot/document they sent.", "", caption].join("\n"),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: reviewKeyboard } }
      );
      await db.prepare(`UPDATE orders SET admin_chat_id = ?, admin_message_id = ? WHERE id = ?`).bind(String(env.ADMIN_CHAT_ID), adminMessage.message_id, order.id).run();
    } catch (fallbackErr) {
      // Both attempts failed — this is the one case this request truly
      // can't self-heal. Logged loudly; the order is still correctly
      // marked pending/pending_review_2/pending_review_2_late in D1, so it
      // still surfaces in /stats' "Pending Reviews" count for manual
      // follow-up.
      console.error(`processPaymentProof: fallback admin alert ALSO failed for order #${order.id}:`, fallbackErr);
    }
  }

  await sendMessage(env, chatId, `✅ পেয়েছি! আপনার পেমেন্ট রিভিউ করা হচ্ছে।\n\n${PAYMENT_REVIEW_EXPECTATION_TEXT}`);
}

// ─────────────────────────────────────────────────────────────────────────
//  CALLBACK QUERY HANDLERS
// ─────────────────────────────────────────────────────────────────────────

/** Customer taps "✅ I've Paid" / "💬 I Need Support" on the stylish
 *  site-order welcome card. */
export async function handleOrderChoiceCallback(env, db, callbackQuery) {
  const [, choice, orderIdStr] = (callbackQuery.data || "").split(":");
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const userId = String(callbackQuery.from.id);
  const orderId = parseInt(orderIdStr, 10);

  const order = await db.prepare(`SELECT * FROM orders WHERE id = ? AND telegram_user_id = ?`).bind(orderId, userId).first();
  if (!order || order.status !== "awaiting_choice") {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "এই অর্ডারটি ইতিমধ্যে এগিয়ে গেছে।", true);
    return;
  }

  if (choice === "paid") {
    const updateResult = await db.prepare(`UPDATE orders SET status = 'awaiting_photo' WHERE id = ? AND status = 'awaiting_choice'`).bind(orderId).run();
    if (!updateResult.meta.changes) {
      await safeAnswerCallbackQuery(env, callbackQuery.id, "এই অর্ডারটি ইতিমধ্যে এগিয়ে গেছে।", true);
      return;
    }
    // No separate "mode" flag to flip: the order is now 'awaiting_photo',
    // which hasOpenPaymentOrder() picks up directly on the customer's
    // very next upload.

    const text = [
      "✅ <b>ধন্যবাদ!</b>",
      "",
      buildOrderSummary({ ...order, status: "awaiting_photo" }),
      "",
      "📸 এখন আপনার পেমেন্ট স্ক্রিনশট/প্রমাণ এখানে পাঠান।",
      "",
      "— NLT Exclusive Mentorship Team"
    ].join("\n");
    await editOrSendMessage(env, chatId, messageId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } });
    await safeAnswerCallbackQuery(env, callbackQuery.id);
    return;
  }

  // choice === "support": keep the order open (they can still pay later),
  // but don't push payment details. The order stays 'awaiting_choice',
  // which is NOT one of the "awaiting payment" statuses hasOpenPaymentOrder()
  // checks for, so any upload the user sends now routes straight to
  // support with no classify prompt needed.
  await editOrSendMessage(
    env,
    chatId,
    messageId,
    [
      "💬 <b>কোনো সমস্যা নেই — আমরা এখানেই আছি।</b>",
      "",
      "নিচে আপনার প্রশ্ন টাইপ করুন, সরাসরি আমাদের টিমের কাছে চলে যাবে।",
      "",
      "প্রস্তুত হলে পরিবর্তে পেমেন্ট প্রমাণ জমা দিতে নিচে ট্যাপ করুন।",
      "",
      "— NLT Exclusive Mentorship Team"
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✅ আসলে, পেমেন্ট করেছি", callback_data: `orderchoice:paid:${orderId}` }]] }
    }
  );
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

/**
 * Admin taps ✅ Confirm / ❌ Reject.
 * Confirm behavior depends on the order's current stage:
 *   - Non-split order (any plan) in 'pending'                → full grant.
 *   - Split T2 order in 'pending' (this IS installment 1)    → phase1 grant.
 *   - Split T2 order in 'pending_review_2'                   → full grant,
 *     kicked from the temporary phase1 channel.
 *   - Split T2 order in 'pending_review_2_late' (a LATE       → full grant,
 *     Installment-2 submission after phase1_expired)            NOT kicked
 *                                                                from phase1
 *                                                                (already
 *                                                                removed by
 *                                                                the daily
 *                                                                cron).
 * Reject always reverts the order to its prior waiting state AND adds a
 * one-time "🗑 Delete this user's data / Keep" follow-up prompt.
 */
export async function handleOrderReviewCallback(env, db, callbackQuery) {
  const [action, orderIdStr] = (callbackQuery.data || "").split(":");
  const originChatId = String(callbackQuery.message?.chat?.id ?? "");
  if (originChatId !== String(env.ADMIN_CHAT_ID)) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "🚫 You're not authorized to do this.", true);
    return;
  }

  await safeAnswerCallbackQuery(env, callbackQuery.id);

  const orderId = parseInt(orderIdStr, 10);
  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first();
  if (!order) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "⚠️ Order not found.", true);
    return;
  }

  const originMessageId = callbackQuery.message.message_id;
  const statusAtRead = order.status;
  const reviewable = statusAtRead === "pending" || statusAtRead === "pending_review_2" || statusAtRead === "pending_review_2_late";
  if (!reviewable) {
    // Cheap fast-path: this card's buttons are only valid while the order
    // is actually awaiting review. This catches an obviously-stale click
    // (the order was fully processed a while ago) without even attempting
    // a write. It is NOT the actual race protection — see below.
    await editOrSendMessage(env, env.ADMIN_CHAT_ID, originMessageId, `${callbackQuery.message.text || buildOrderSummary(order)}\n\n⚠️ Already processed (current status: ${escapeHtml(statusAtRead)}).`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
    await safeAnswerCallbackQuery(env, callbackQuery.id, "This order was already processed.", true);
    return;
  }

  const isInstallment1 = Boolean(order.is_split) && statusAtRead === "pending";
  const isInstallment2 = Boolean(order.is_split) && (statusAtRead === "pending_review_2" || statusAtRead === "pending_review_2_late");
  const installment2DueAt = new Date(Date.now() + TIER2_SPLIT.penaltyDays * 24 * 60 * 60 * 1000).toISOString();

  // MUST be read before the atomic UPDATE below: on the full-grant path
  // that UPDATE marks THIS order 'confirmed' immediately, and
  // getUserBestTier() only looks at status = 'confirmed' rows — reading
  // it any later would make this very order look like pre-existing
  // history and incorrectly skip granting the core course channel on a
  // customer's first-ever purchase.
  const alreadyHadCore = action === "confirm" ? Boolean(await getUserBestTier(db, order.telegram_user_id)) : false;

  // The REAL race protection: every transition below is an atomic
  // conditional UPDATE, gated on the order still being in EXACTLY the
  // status we just read. If two requests for the same order both reach
  // this point at once (a fast double-tap, two admins, or a duplicate
  // webhook delivery), only the one whose UPDATE reports changes > 0
  // "wins" and proceeds to grant entitlements / message anyone; the other
  // sees changes === 0 and exits below without re-running any of that.
  let updateResult;
  if (action === "reject") {
    const revertStatus =
      statusAtRead === "pending_review_2" ? "phase1_active" : statusAtRead === "pending_review_2_late" ? "phase1_expired" : "awaiting_photo";
    updateResult = await db.prepare(`UPDATE orders SET status = ? WHERE id = ? AND status = ?`).bind(revertStatus, orderId, statusAtRead).run();
  } else if (isInstallment1) {
    updateResult = await db
      .prepare(`UPDATE orders SET status = 'phase1_active', installment2_due_at = ? WHERE id = ? AND status = ?`)
      .bind(installment2DueAt, orderId, statusAtRead)
      .run();
  } else {
    updateResult = await db.prepare(`UPDATE orders SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`).bind(orderId, statusAtRead).run();
  }

  if (!updateResult.meta.changes) {
    await editOrSendMessage(env, env.ADMIN_CHAT_ID, originMessageId, `${callbackQuery.message.text || buildOrderSummary(order)}\n\n⚠️ Already handled by another request.`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Already handled by another request.", true);
    return;
  }

  await editOrSendMessage(env, env.ADMIN_CHAT_ID, originMessageId, callbackQuery.message.text || buildOrderSummary(order), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] }
  });

  const fromUser = { id: order.telegram_user_id, username: order.telegram_username };
  const chatButton = await buildAdminChatButton(env, db, fromUser);
  const chatButtonRow = chatButton ? [chatButton] : [];

  if (action === "reject") {
    await sendMessage(
      env,
      order.telegram_user_id,
      `আপনার Order #${order.id}-এর স্ক্রিনশটে লেনদেনের পুরো বিস্তারিত স্পষ্টভাবে দেখা যায়নি, তাই এখনো নিশ্চিত করতে পারিনি। কোনো সমস্যা নেই — সম্পূর্ণ লেনদেন স্পষ্টভাবে দেখা যায় এমন একটি স্ক্রিনশট/ডকুমেন্ট আবার পাঠান, আমরা সঙ্গে সঙ্গে রিভিউ করব।\n\n— NLT Exclusive Mentorship Team`
    );

    await sendMessage(env, env.ADMIN_CHAT_ID, `${buildOrderSummary(order)}\n\n❌ <b>Rejected</b> by admin.`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑 Delete this user's data", callback_data: `deleteuser:${order.telegram_user_id}` }, { text: "✔️ Keep (default)", callback_data: "keepuser:noop" }],
          ...chatButtonRow.map((b) => [b])
        ]
      }
    });

    await safeAnswerCallbackQuery(env, callbackQuery.id, "Order rejected.");
    return;
  }

  // action === "confirm" (alreadyHadCore was already computed above, before the atomic UPDATE)

  if (isInstallment1) {
    const link = await grantChannelInvite(env, CHANNELS.phase1, `Order #${order.id} - Phase 1`);
    if (link) {
      await sendMessage(
        env,
        order.telegram_user_id,
        `✅ <b>Installment 1 নিশ্চিত হয়েছে — স্বাগতম!</b>\n\nএই যে আপনার Phase 1 অ্যাক্সেস লিঙ্ক (Part 1 ভিডিও):\n🔗 ${link}\n\nপূর্ণ অ্যাক্সেস, Priority Support, Live Q&A এবং সব add-on এখনো বাকি — বাকি ${formatAmount(TIER2_SPLIT.installment2)} USDT <b>${formatDueDate(installment2DueAt)}</b> তারিখের মধ্যে পরিশোধ করলে সবকিছু আনলক হয়ে যাবে। এই সময়ের মধ্যে পরিশোধ না হলে Phase 1 অ্যাক্সেসও সাময়িকভাবে বন্ধ হয়ে যাবে, তাই সময়মতো সেরে ফেলাই ভালো।\n\n— NLT Exclusive Mentorship Team`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } else {
      await sendMessage(env, env.ADMIN_CHAT_ID, `⚠️ Order #${order.id}: Installment 1 confirmed but the Phase 1 invite link failed. Please check bot permissions in that channel and send it manually.`);
    }

    await sendMessage(env, env.ADMIN_CHAT_ID, `${buildOrderSummary({ ...order, status: "phase1_active" })}\n\n✅ <b>Installment 1 Confirmed</b> — Phase 1 access sent.`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: chatButtonRow.map((b) => [b]) }
    });
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Installment 1 confirmed.");
    return;
  }

  // Full grant (non-split order, or split installment 2 — on-time or late)
  order.status = "confirmed";

  // Order fully resolved — no "mode" flag to reset: the order is now
  // 'confirmed', which falls outside the statuses hasOpenPaymentOrder()
  // checks for, so future uploads from this customer route straight to
  // support automatically (unless/until a new order puts them back into
  // 'awaiting_photo').

  const oldSupportGroup = await getSupportGroupForUser(db, order.telegram_user_id);
  const { links, failedTargets } = await grantEntitlementsForOrder(env, db, order, { alreadyHadCore });
  const newSupportGroup = await getSupportGroupForUser(db, order.telegram_user_id);

  // Only kick from the temporary Phase 1 holding channel when this
  // Installment-2 confirmation came from an ON-TIME submission
  // (statusAtRead === 'pending_review_2'). A LATE submission
  // (statusAtRead === 'pending_review_2_late', originating from
  // 'phase1_expired') means the customer was already removed from Phase 1
  // by the daily cron (checkSplitPaymentDeadlines) when their window
  // lapsed — attempting to kick them again here would just be a pointless
  // API call against someone who isn't currently a member.
  if (isInstallment2 && statusAtRead === "pending_review_2") {
    try {
      await kickChatMember(env, CHANNELS.phase1, Number(order.telegram_user_id));
    } catch (err) {
      /* best-effort */
    }
  }

  if (links.length > 0) {
    const linkList = links.map(([label, url]) => `🔗 ${label}: ${url}`).join("\n");
    await sendMessage(env, order.telegram_user_id, `🎉 <b>পেমেন্ট নিশ্চিত হয়েছে — আনুষ্ঠানিকভাবে আপনি এখন NLT Exclusive Mentorship-এর অংশ!</b>\n\nএই যে আপনার এক্সক্লুসিভ অ্যাক্সেস (single-use লিঙ্ক — শেয়ার করবেন না):\n\n${linkList}\n\nআমাদের টিম আপনার যাত্রায় সঙ্গে আছে — কোনো প্রশ্ন থাকলে যেকোনো সময় জানান।\n\n— NLT Exclusive Mentorship Team`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    });
  }

  if (failedTargets.length > 0) {
    await sendMessage(
      env,
      env.ADMIN_CHAT_ID,
      `⚠️ Order #${order.id} was confirmed, but invite link creation failed for: ${failedTargets.join(", ")}. Please check bot admin/invite permissions there and send the link manually.`
    );
  }

  if (newSupportGroup !== oldSupportGroup) {
    const label = { [SUPPORT_GROUPS.consultation]: "VIP Consultation", [SUPPORT_GROUPS.priority]: "Priority", [SUPPORT_GROUPS.basic]: "Basic" }[newSupportGroup] || "General";
    await sendMessage(env, order.telegram_user_id, `🎉 অভিনন্দন! আপনার সাপোর্ট লেভেল এখন upgrade হয়ে গেছে: <b>${label}</b> — এখন থেকে অগ্রাধিকারভিত্তিক ও দ্রুততর সহায়তা পাবেন, ঠিক যেমনটা এই লেভেলের সদস্যরা পান।\n\n— NLT Exclusive Mentorship Team`, { parse_mode: "HTML" });
    await moveUserTicketToGroup(env, db, order.telegram_user_id, newSupportGroup);
  }

  await sendMessage(env, env.ADMIN_CHAT_ID, `${buildOrderSummary(order)}\n\n✅ <b>Confirmed</b> — access links sent to the customer.`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: chatButtonRow.map((b) => [b]) }
  });

  await safeAnswerCallbackQuery(env, callbackQuery.id, "Order confirmed.");
}

/** Admin taps "🗑 Delete this user's data" after rejecting a payment. */
export async function handleDeleteUserCallback(env, db, callbackQuery) {
  const originChatId = String(callbackQuery.message?.chat?.id ?? "");
  if (originChatId !== String(env.ADMIN_CHAT_ID)) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "🚫 You're not authorized to do this.", true);
    return;
  }
  const userId = (callbackQuery.data || "").split(":")[1];
  await wipeUserData(db, userId);
  await sendMessage(env, userId, "আপনার আগের অর্ডার ডেটা মুছে ফেলা হয়েছে। নতুন করে শুরু করতে প্রস্তুত হলে 📚 মেনু বাটনে ট্যাপ করুন — আমরা এখানেই আছি।\n\n— NLT Exclusive Mentorship Team").catch(() => {});
  await editOrSendMessage(env, env.ADMIN_CHAT_ID, callbackQuery.message.message_id, `${callbackQuery.message.text || ""}\n\n🗑 <b>User data deleted</b> — they can order again from scratch.`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] }
  });
  await safeAnswerCallbackQuery(env, callbackQuery.id, "User data deleted.");
}

export async function handleKeepUserCallback(env, db, callbackQuery) {
  await editOrSendMessage(env, callbackQuery.message.chat.id, callbackQuery.message.message_id, `${callbackQuery.message.text || ""}\n\n✔️ Data kept.`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] }
  });
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Kept.");
}

/** Customer taps "🧾 Payment Screenshot/Proof" or "💬 Support / Other". */
export async function handleMediaClassificationCallback(env, db, callbackQuery) {
  const [, choice] = (callbackQuery.data || "").split(":");
  const fromUser = callbackQuery.from;
  const userId = String(fromUser.id);
  const chatId = callbackQuery.message.chat.id;
  const promptMessageId = callbackQuery.message.message_id;

  const pending = await db.prepare(`SELECT * FROM pending_media WHERE telegram_user_id = ?`).bind(userId).first();
  if (!pending) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "এই আপলোড রিকোয়েস্টের মেয়াদ শেষ হয়ে গেছে বা এটি আগেই প্রসেস করা হয়েছে।", true);
    return;
  }

  // Atomic claim: only the request that actually deletes this exact row
  // (message_id included, so a stale classification tap for an OLD upload
  // can't accidentally claim/process a NEWER one that has since replaced
  // it) proceeds to process it. A duplicate tap or duplicate webhook
  // delivery that loses the race exits gracefully instead of forwarding /
  // routing the same file twice.
  const claimResult = await db.prepare(`DELETE FROM pending_media WHERE telegram_user_id = ? AND message_id = ?`).bind(userId, pending.message_id).run();
  if (!claimResult.meta.changes) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "এই আপলোড রিকোয়েস্টের মেয়াদ শেষ হয়ে গেছে বা এটি আগেই প্রসেস করা হয়েছে।", true);
    return;
  }

  await safeAnswerCallbackQuery(env, callbackQuery.id);

  if (choice === "payment") {
    await processPaymentProof(env, db, fromUser, chatId, pending.kind, pending.file_id, pending.message_id);
    await editOrSendMessage(env, chatId, promptMessageId, "🧾 বুঝেছি — এটিকে পেমেন্ট প্রমাণ হিসেবে গণ্য করা হচ্ছে।", { reply_markup: { inline_keyboard: [] } });
  } else {
    await routeMessageToSupportThread(env, db, fromUser, chatId, pending.message_id, pending.kind);
    await editOrSendMessage(env, chatId, promptMessageId, "💬 বুঝেছি — এটি আমাদের সাপোর্ট টিমের কাছে পাঠানো হয়েছে।", { reply_markup: { inline_keyboard: [] } });
  }
}