// ───────────────────────────────────────────────────────────────────────────
//  Support ticket threads, profile cards, per-user management (usermgmt:*) callbacks
// ───────────────────────────────────────────────────────────────────────────

import { ADDON_NAMES, CHANNELS, SUPPORT_GROUPS, TIER_NAMES } from './constants.js';
import { banChatMemberUntil, callTelegramApi, closeForumTopic, createForumTopic, deleteForumTopic, editMessageReplyMarkup, forwardMessage, safeAnswerCallbackQuery, sendMessage } from './telegram.js';
import { escapeHtml, formatAmount, getForwardableMediaKind, notifyAdminError, stripSupergroupPrefix } from './utils.js';
import { getActiveSubscriptionDetails, getSupportGroupForUser } from './entitlements.js';
import { clearAdminState, purgeUser, setAdminState } from './admin.js';

// ─────────────────────────────────────────────────────────────────────────
//  CRM / SUPPORT HELPERS  (ticket threads, profile card, chat button)
// ─────────────────────────────────────────────────────────────────────────

export async function getOrCreateTicketThread(env, db, fromUser, groupId) {
  const userId = String(fromUser.id);
  const existing = await db.prepare(`SELECT * FROM tickets WHERE telegram_user_id = ?`).bind(userId).first();
  if (existing && existing.group_id === String(groupId)) {
    return { threadId: existing.thread_id, isNew: false };
  }

  const displayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ") || "Unknown";
  const topicName = (fromUser.username ? `${displayName} (@${fromUser.username})` : `${displayName} (${userId})`).slice(0, 128);

  let topic;
  try {
    topic = await createForumTopic(env, groupId, topicName);
  } catch (err) {
    await sendMessage(
      env,
      env.ADMIN_CHAT_ID,
      [
        "⚠️ <b>Forum Topic Creation Failed</b>",
        "",
        `Could not open a support thread for ${escapeHtml(topicName)} (User ID: <code>${escapeHtml(userId)}</code>) in group <code>${escapeHtml(String(groupId))}</code>.`,
        "",
        "Please verify: bot is admin there, \"Manage Topics\" is enabled, and Topics (Forum mode) is ON.",
        "",
        `Telegram error: ${escapeHtml(err.message)}`
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return null;
  }

  await db
    .prepare(
      `INSERT INTO tickets (telegram_user_id, group_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET group_id = excluded.group_id, thread_id = excluded.thread_id`
    )
    .bind(userId, String(groupId), topic.message_thread_id)
    .run();

  return { threadId: topic.message_thread_id, isNew: true };
}

export async function buildProfileCard(db, fromUser, groupId) {
  const userId = String(fromUser.id);
  const { results } = await db.prepare(`SELECT * FROM orders WHERE telegram_user_id = ? ORDER BY id DESC`).bind(userId).all();
  const orders = results || [];
  const confirmedOrders = orders.filter((o) => o.status === "confirmed");
  const totalSpent = confirmedOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

  const tierLabels = {
    [SUPPORT_GROUPS.consultation]: "🌟 VIP Consultation Client",
    [SUPPORT_GROUPS.priority]: "⭐ Priority Support Client",
    [SUPPORT_GROUPS.basic]: "✅ Tier Owner (Basic Support)",
    [SUPPORT_GROUPS.general]: "👤 General Inquiry (No Purchases)"
  };

  const displayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ") || "Unknown";
  const username = fromUser.username ? `@${fromUser.username}` : "—";

  const lines = [
    "🪪 <b>Profile Summary Card</b>",
    "",
    `<b>Name:</b> ${escapeHtml(displayName)}`,
    `<b>Username:</b> ${escapeHtml(username)}`,
    `<b>User ID:</b> <code>${userId}</code>`,
    `<b>Tier:</b> ${tierLabels[groupId] || "Unknown"}`,
    `<b>Confirmed Orders:</b> ${confirmedOrders.length}`,
    `<b>Lifetime Value:</b> ${formatAmount(totalSpent)} USDT`
  ];

  if (confirmedOrders.length > 0) {
    lines.push("", "<b>Order History:</b>");
    for (const order of confirmedOrders) {
      lines.push(`• #${order.id} — ${escapeHtml(TIER_NAMES[order.plan] || order.plan)} (${formatAmount(order.total)} USDT)`);
    }
  }
  return lines.join("\n");
}

/** Inline keyboard of CRM management controls attached under a ticket's
 *  profile card, so an admin/team member sitting inside that topic can
 *  act on the user without leaving the thread. */
export function buildUserManagementKeyboard(userId) {
  return [
    [
      { text: "🚫 Remove User", callback_data: `usermgmt:removeconfirm:${userId}` },
      { text: "⛔ Ban User", callback_data: `usermgmt:banmenu:${userId}` }
    ],
    [{ text: "🔁 Change Support Level", callback_data: `usermgmt:levelmenu:${userId}` }],
    [{ text: "✏️ Edit Add-on / Renewal", callback_data: `usermgmt:renewmenu:${userId}` }]
  ];
}

/** Builds the permanent "Chat with {user}" URL button. This is included on
 *  EVERY order review card and MUST remain even after the order is
 *  confirmed/rejected — never strip it out when editing a card later. */
export async function buildAdminChatButton(env, db, fromUser) {
  try {
    const groupId = await getSupportGroupForUser(db, String(fromUser.id));
    const ticket = await getOrCreateTicketThread(env, db, fromUser, groupId);
    if (!ticket) return null;

    if (ticket.isNew) {
      const profileCard = await buildProfileCard(db, fromUser, groupId);
      await sendMessage(env, groupId, profileCard, {
        parse_mode: "HTML",
        message_thread_id: ticket.threadId,
        reply_markup: { inline_keyboard: buildUserManagementKeyboard(fromUser.id) }
      });
    }

    const displayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ") || "User";
    const shortName = displayName.length > 20 ? `${displayName.slice(0, 20)}…` : displayName;

    return {
      text: `💬 Chat with ${shortName} (ID: ${fromUser.id})`,
      url: `https://t.me/c/${stripSupergroupPrefix(groupId)}/${ticket.threadId}`
    };
  } catch (err) {
    console.error("Failed to build admin chat button:", err);
    return null;
  }
}

/**
 * Routes an arbitrary customer message (text, or a media message already
 * classified as "Support / Other") into that customer's ticket thread in
 * the correct support group. This is the ONLY path non-payment-proof
 * messages take, so it must never silently drop the original message:
 *
 *   1. If the ticket thread can't even be opened (createForumTopic
 *      failed inside getOrCreateTicketThread — which already alerts the
 *      admin with the user's ID), the original message is forwarded
 *      directly to ADMIN_CHAT_ID as a fallback so a human still sees it.
 *   2. If the thread exists but posting the profile card / forwarding the
 *      message into it fails for any other reason (topic deleted
 *      concurrently, transient API error, etc.), the same ADMIN_CHAT_ID
 *      fallback forward is used.
 *   3. The customer always gets a clear reply either way — either their
 *      message went to their normal support thread, or (on any failure
 *      above) they're told the team has been notified directly.
 */
export async function routeMessageToSupportThread(env, db, fromUser, chatId, messageId, mediaKind = null) {
  const groupId = await getSupportGroupForUser(db, String(fromUser.id));
  const ticket = await getOrCreateTicketThread(env, db, fromUser, groupId);

  const displayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ") || "Unknown";
  const who = fromUser.username ? `${displayName} (@${fromUser.username})` : `${displayName} (ID ${fromUser.id})`;

  /** Last-resort delivery straight to the admin's private chat, with the
   *  original message forwarded (not just described) so nothing is lost.
   *  Returns true if this fallback itself succeeded. */
  const fallbackToAdmin = async (reason) => {
    try {
      await sendMessage(
        env,
        env.ADMIN_CHAT_ID,
        `⚠️ <b>Fallback delivery</b> — ${escapeHtml(reason)} for ${escapeHtml(who)} (User ID: <code>${escapeHtml(String(fromUser.id))}</code>). Forwarding their message directly below.`,
        { parse_mode: "HTML" }
      );
      await forwardMessage(env, env.ADMIN_CHAT_ID, chatId, messageId);
      return true;
    } catch (err) {
      console.error(`routeMessageToSupportThread: fallback forward to admin also failed for user ${fromUser.id}:`, err);
      return false;
    }
  };

  if (!ticket) {
    // getOrCreateTicketThread already alerted the admin (with the user's
    // ID) about the forum-topic-creation failure — but the message itself
    // must not vanish, so forward it directly too.
    await fallbackToAdmin("could not open a support thread");
    await sendMessage(env, chatId, "⚠️ আপনার মেসেজ পাঠাতে সাময়িক একটি সমস্যা হচ্ছে, তবে আমাদের টিমকে সরাসরি জানানো হয়েছে এবং শীঘ্রই আপনার সাথে যোগাযোগ করবে।\n\n— NLT Exclusive Mentorship Team");
    return;
  }

  try {
    if (ticket.isNew) {
      const profileCard = await buildProfileCard(db, fromUser, groupId);
      await sendMessage(env, groupId, profileCard, {
        parse_mode: "HTML",
        message_thread_id: ticket.threadId,
        reply_markup: { inline_keyboard: buildUserManagementKeyboard(fromUser.id) }
      });
    }
    await forwardMessage(env, groupId, chatId, messageId, { message_thread_id: ticket.threadId });
  } catch (err) {
    console.error(`routeMessageToSupportThread: failed to deliver into ticket thread for user ${fromUser.id}:`, err);
    await notifyAdminError(env, err, `routeMessageToSupportThread: forwardMessage into ticket thread failed for user ${fromUser.id}`, { mediaKind });
    const delivered = await fallbackToAdmin("delivery into the existing support thread failed");
    if (!delivered) {
      await sendMessage(env, chatId, "⚠️ আপনার মেসেজ পাঠাতে সাময়িক একটি সমস্যা হচ্ছে — একটু পর আবার চেষ্টা করুন, অথবা সরাসরি আমাদের সাথে যোগাযোগ করুন।\n\n— NLT Exclusive Mentorship Team");
      return;
    }
    await sendMessage(env, chatId, "⚠️ আপনার সাপোর্ট থ্রেডে সাময়িক একটি সমস্যা হয়েছিল, তবে আমাদের টিমকে সরাসরি জানানো হয়েছে এবং শীঘ্রই আপনার সাথে যোগাযোগ করবে।\n\n— NLT Exclusive Mentorship Team");
  }
}

export async function handleUserTextMessage(env, db, message) {
  await routeMessageToSupportThread(env, db, message.from, message.chat.id, message.message_id);
}

/** Admin message inside a support group's topic thread — routed back to the customer. */
/** Admin/team message inside a support group's topic thread — routed
 *  back to the customer. Text replies are sent as plain text (never
 *  break formatting on the admin's raw input); any media (photo,
 *  document, video, video note, animation, voice, sticker) is forwarded
 *  as-is, caption included automatically since it's a native Telegram
 *  forward. If delivery to the customer fails for any reason (most
 *  commonly: the customer has blocked the bot), the failure is reported
 *  back into the same topic so the team knows the message never arrived
 *  — it must never fail silently. */
export async function handleAdminGroupReply(env, db, message) {
  const groupId = String(message.chat.id);
  const threadId = message.message_thread_id;
  const ticket = await db.prepare(`SELECT telegram_user_id FROM tickets WHERE group_id = ? AND thread_id = ?`).bind(groupId, threadId).first();
  if (!ticket) return;

  const mediaKind = getForwardableMediaKind(message);

  try {
    if (mediaKind) {
      await forwardMessage(env, ticket.telegram_user_id, groupId, message.message_id);
    } else if (message.text) {
      await sendMessage(env, ticket.telegram_user_id, message.text);
    } else {
      // Nothing we know how to relay (e.g. a poll, a location, etc.) —
      // nothing to send, nothing to report as failed.
      return;
    }
  } catch (err) {
    console.error(`handleAdminGroupReply: failed to deliver ${mediaKind || "text"} reply to user ${ticket.telegram_user_id}:`, err);
    await sendMessage(
      env,
      groupId,
      `⚠️ <b>Delivery failed</b> — your ${mediaKind ? escapeHtml(mediaKind) : "message"} could NOT be sent to the customer (they may have blocked the bot, or another Telegram error occurred).\n\n<code>${escapeHtml(err.message || String(err))}</code>`,
      { parse_mode: "HTML", message_thread_id: threadId }
    ).catch((notifyErr) => {
      console.error(`handleAdminGroupReply: even the failure notice could not be posted for user ${ticket.telegram_user_id}:`, notifyErr);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  CRM: PER-USER MANAGEMENT CONTROLS  (buttons under a topic's profile card)
// ─────────────────────────────────────────────────────────────────────────

export const BAN_DURATION_OPTIONS = [
  { label: "1 Day", days: 1 },
  { label: "3 Days", days: 3 },
  { label: "7 Days", days: 7 },
  { label: "30 Days", days: 30 },
  { label: "Permanent", days: 0 }
];

export const SUPPORT_LEVEL_OPTIONS = [
  { key: "general", label: "💬 General", groupId: SUPPORT_GROUPS.general },
  { key: "basic", label: "✅ Basic", groupId: SUPPORT_GROUPS.basic },
  { key: "priority", label: "⭐ Priority", groupId: SUPPORT_GROUPS.priority },
  { key: "consultation", label: "🌟 VIP Consultation", groupId: SUPPORT_GROUPS.consultation }
];

/** Only lets ADMIN_CHAT_ID or one of the 4 support groups invoke these
 *  management actions (i.e. your team, from inside a ticket thread, or
 *  you directly). Anyone else (e.g. the customer themself, if this data
 *  ever leaked) is rejected. */
export function isManagementCaller(env, chatId) {
  const str = String(chatId);
  return str === String(env.ADMIN_CHAT_ID) || Object.values(SUPPORT_GROUPS).includes(str);
}

export async function handleUserMgmtRemoveConfirm(env, db, callbackQuery, userId) {
  await safeAnswerCallbackQuery(env, callbackQuery.id);
  await sendMessage(env, callbackQuery.message.chat.id, `🚫 Remove <code>${escapeHtml(userId)}</code> from every channel/group and wipe their data?`, {
    parse_mode: "HTML",
    message_thread_id: callbackQuery.message.message_thread_id,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Yes, remove them", callback_data: `usermgmt:removedo:${userId}` },
          { text: "❌ Cancel", callback_data: `usermgmt:cancel:${userId}` }
        ]
      ]
    }
  });
}

export async function handleUserMgmtRemoveDo(env, db, callbackQuery, userId) {
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Removing...");
  const failed = await purgeUser(env, db, userId);
  await sendMessage(
    env,
    callbackQuery.message.chat.id,
    failed.length === 0
      ? `🚫 User <code>${escapeHtml(userId)}</code> removed from everywhere and their data wiped.`
      : `🚫 User <code>${escapeHtml(userId)}</code> data wiped, but couldn't kick them from: ${failed.join(", ")}.`,
    { parse_mode: "HTML", message_thread_id: callbackQuery.message.message_thread_id }
  );
  await safeAnswerCallbackQuery(env, callbackQuery.id, "User removed.");
}

export async function handleUserMgmtBanMenu(env, db, callbackQuery, userId) {
  const buttons = BAN_DURATION_OPTIONS.map((opt) => [{ text: `⛔ ${opt.label}`, callback_data: `usermgmt:banconfirm:${userId}:${opt.days}` }]);
  buttons.push([{ text: "❌ Cancel", callback_data: `usermgmt:cancel:${userId}` }]);
  await sendMessage(env, callbackQuery.message.chat.id, `⛔ Select a ban duration for <code>${escapeHtml(userId)}</code>:`, {
    parse_mode: "HTML",
    message_thread_id: callbackQuery.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  });
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

export async function handleUserMgmtBanConfirm(env, db, callbackQuery, userId, daysStr) {
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Banning...");
  const days = parseInt(daysStr, 10) || 0;
  const bannedUntil = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

  await db
    .prepare(
      `INSERT INTO banned_users (telegram_user_id, banned_until) VALUES (?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET banned_until = excluded.banned_until, banned_at = CURRENT_TIMESTAMP`
    )
    .bind(userId, bannedUntil)
    .run();

  // Kick them out of everything right away — a ban isn't just a database
  // flag, it should take effect immediately across every channel/group.
  const allChats = [...Object.values(CHANNELS), ...Object.values(SUPPORT_GROUPS)];
  const untilUnix = bannedUntil ? Math.floor(new Date(bannedUntil).getTime() / 1000) : undefined;
  for (const chatId of allChats) {
    try {
      await banChatMemberUntil(env, chatId, Number(userId), untilUnix);
    } catch (err) {
      /* best-effort */
    }
  }

  const label = days > 0 ? `${days} day(s)` : "permanently";
  await sendMessage(env, callbackQuery.message.chat.id, `⛔ User <code>${escapeHtml(userId)}</code> banned ${label}.`, {
    parse_mode: "HTML",
    message_thread_id: callbackQuery.message.message_thread_id
  });
  await sendMessage(env, userId, `⛔ মেন্টরশিপ টিম আপনার অ্যাক্সেস${days > 0 ? ` ${days} দিনের জন্য` : ""} স্থগিত করেছে।\n\n— NLT Exclusive Mentorship Team`).catch(() => {});
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Banned.");
}

export async function handleUserMgmtRenewMenu(env, db, callbackQuery, userId) {
  const details = await getActiveSubscriptionDetails(db, userId);
  const buttons = [];
  for (const letter of ["i", "a", "r", "c"]) {
    const sub = details.find((d) => d.addon === letter);
    const label = sub ? `${ADDON_NAMES[letter]} (exp ${new Date(sub.expires_at).toISOString().slice(0, 10)})` : `${ADDON_NAMES[letter]} (inactive)`;
    buttons.push([{ text: `✏️ ${label}`, callback_data: `usermgmt:renewpick:${userId}:${letter}` }]);
  }
  buttons.push([{ text: "❌ Cancel", callback_data: `usermgmt:cancel:${userId}` }]);
  await sendMessage(env, callbackQuery.message.chat.id, `✏️ Pick an add-on to edit the expiry/renewal for <code>${escapeHtml(userId)}</code>:`, {
    parse_mode: "HTML",
    message_thread_id: callbackQuery.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  });
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

export async function handleUserMgmtRenewPick(env, db, callbackQuery, userId, letter) {
  const chatId = String(callbackQuery.message.chat.id);
  const threadId = callbackQuery.message.message_thread_id || 0;
  await setAdminState(db, chatId, threadId, "awaiting_renewal_days", JSON.stringify({ userId, letter }));
  await sendMessage(
    env,
    chatId,
    `✏️ Reply here with the number of days to (re)set <b>${escapeHtml(ADDON_NAMES[letter] || letter)}</b> to, from today. Send <code>0</code> to expire it immediately, or <code>perm</code> for permanent.`,
    {
      parse_mode: "HTML",
      message_thread_id: threadId,
      // Previously this prompt had no way out at all — the admin had to
      // type SOMETHING (even garbage) to escape the awaiting-input state.
      // Now there's an explicit Cancel, consistent with every other
      // admin_state-driven prompt in the bot.
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `usermgmt:cancel:${userId}` }]] }
    }
  );
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

export async function handleUserMgmtLevelMenu(env, db, callbackQuery, userId) {
  const buttons = SUPPORT_LEVEL_OPTIONS.map((opt) => [{ text: opt.label, callback_data: `usermgmt:setlevel:${userId}:${opt.key}` }]);
  buttons.push([{ text: "❌ Cancel", callback_data: `usermgmt:cancel:${userId}` }]);
  await sendMessage(env, callbackQuery.message.chat.id, `🔁 Move <code>${escapeHtml(userId)}</code> to which support level?`, {
    parse_mode: "HTML",
    message_thread_id: callbackQuery.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  });
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

/**
 * Moves a user's support ticket from whatever group/topic they're
 * currently in to a NEW topic in `newGroupId`, and removes the old topic.
 *
 * ⚠️ Telegram Bot API limitation: bots have no method to bulk-export or
 * copy a topic's past message history into a new topic. This function
 * creates the new topic, posts a fresh profile card + management
 * controls there, leaves a "moved from" reference note, and then deletes
 * the old topic. It is the closest equivalent achievable with the Bot
 * API — true "full history" migration is not something a bot can do
 * (only Telegram's own client-side topic tools can do that, and only for
 * users/admins browsing the chat directly, not via the Bot API).
 */
export async function moveUserTicketToGroup(env, db, userId, newGroupId) {
  const existingTicket = await db.prepare(`SELECT * FROM tickets WHERE telegram_user_id = ?`).bind(userId).first();
  if (existingTicket && existingTicket.group_id === String(newGroupId)) return; // already there

  // Look up basic identity info from Telegram so the new topic gets a
  // sensible name even without a fresh incoming message from the user.
  let displayName = `User ${userId}`;
  try {
    const chatInfo = await callTelegramApi(env, "getChat", { chat_id: userId });
    displayName = [chatInfo.first_name, chatInfo.last_name].filter(Boolean).join(" ") || displayName;
    if (chatInfo.username) displayName += ` (@${chatInfo.username})`;
  } catch (err) {
    /* best-effort — fall back to the generic name above */
  }

  let newTopic;
  try {
    newTopic = await createForumTopic(env, newGroupId, displayName.slice(0, 128));
  } catch (err) {
    await sendMessage(env, env.ADMIN_CHAT_ID, `⚠️ Could not create a new support topic for <code>${escapeHtml(userId)}</code> in the target group. Telegram error: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    return;
  }

  const oldGroupId = existingTicket?.group_id;
  const oldThreadId = existingTicket?.thread_id;

  await db
    .prepare(
      `INSERT INTO tickets (telegram_user_id, group_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET group_id = excluded.group_id, thread_id = excluded.thread_id`
    )
    .bind(userId, String(newGroupId), newTopic.message_thread_id)
    .run();

  const fromUser = { id: userId, first_name: displayName };
  const profileCard = await buildProfileCard(db, fromUser, newGroupId);
  const noteSuffix = oldGroupId ? `\n\n<i>↪️ Moved here from a previous support group. Full message history could not be carried over — the Telegram Bot API doesn't support migrating topic history, only Telegram's own clients can do that.</i>` : "";
  await sendMessage(env, newGroupId, profileCard + noteSuffix, {
    parse_mode: "HTML",
    message_thread_id: newTopic.message_thread_id,
    reply_markup: { inline_keyboard: buildUserManagementKeyboard(userId) }
  });

  if (oldGroupId && oldThreadId) {
    try {
      await deleteForumTopic(env, oldGroupId, oldThreadId);
    } catch (err) {
      try {
        await closeForumTopic(env, oldGroupId, oldThreadId);
      } catch (err2) {
        /* best-effort */
      }
    }
  }
}

export async function handleUserMgmtSetLevel(env, db, callbackQuery, userId, levelKey) {
  const target = SUPPORT_LEVEL_OPTIONS.find((o) => o.key === levelKey);
  if (!target) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "Unknown level.", true);
    return;
  }
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Moving...");
  await moveUserTicketToGroup(env, db, userId, target.groupId);
  await sendMessage(env, callbackQuery.message.chat.id, `🔁 <code>${escapeHtml(userId)}</code> moved to <b>${target.label}</b> support.`, {
    parse_mode: "HTML",
    message_thread_id: callbackQuery.message.message_thread_id
  });
  await sendMessage(env, userId, `🔔 আপনার সাপোর্ট লেভেল আপডেট করা হয়েছে: <b>${target.label}</b>।\n\n— NLT Exclusive Mentorship Team`, { parse_mode: "HTML" }).catch(() => {});
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Moved.");
}

/** Universal "back out of whatever sub-menu/prompt I was in" handler for
 *  the per-user management flows. Previously this only answered the
 *  callback with a "Cancelled." toast and left the original menu's
 *  buttons fully intact and tappable — an admin could "cancel" a ban and
 *  then accidentally still apply it by tapping a now-stale duration
 *  button. Now it strips the stale menu's buttons, clears any pending
 *  admin_state (e.g. an in-progress "reply with a number of days"
 *  prompt), and re-offers the management keyboard so the admin isn't
 *  left with nowhere to go. */
export async function handleUserMgmtCancel(env, db, callbackQuery, userId) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const threadId = callbackQuery.message.message_thread_id || 0;

  await clearAdminState(db, String(chatId), threadId);

  try {
    await editMessageReplyMarkup(env, chatId, messageId, { inline_keyboard: [] });
  } catch (err) {
    // Best-effort — the menu/prompt message may already be gone or too
    // old to edit. Nothing more to do about that specific message.
  }

  const backKeyboard = userId ? buildUserManagementKeyboard(userId) : [];
  await sendMessage(env, chatId, "❌ Cancelled.", {
    message_thread_id: callbackQuery.message.message_thread_id,
    reply_markup: { inline_keyboard: backKeyboard }
  });
  await safeAnswerCallbackQuery(env, callbackQuery.id, "Cancelled.");
}

/** Top-level dispatcher for all `usermgmt:*` callback actions. */
export async function handleUserMgmtCallback(env, db, callbackQuery) {
  if (!isManagementCaller(env, callbackQuery.message.chat.id)) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "🚫 Not authorized.", true);
    return;
  }
  const [, action, userId, extra] = (callbackQuery.data || "").split(":");

  switch (action) {
    case "removeconfirm":
      return handleUserMgmtRemoveConfirm(env, db, callbackQuery, userId);
    case "removedo":
      return handleUserMgmtRemoveDo(env, db, callbackQuery, userId);
    case "banmenu":
      return handleUserMgmtBanMenu(env, db, callbackQuery, userId);
    case "banconfirm":
      return handleUserMgmtBanConfirm(env, db, callbackQuery, userId, extra);
    case "renewmenu":
      return handleUserMgmtRenewMenu(env, db, callbackQuery, userId);
    case "renewpick":
      return handleUserMgmtRenewPick(env, db, callbackQuery, userId, extra);
    case "levelmenu":
      return handleUserMgmtLevelMenu(env, db, callbackQuery, userId);
    case "setlevel":
      return handleUserMgmtSetLevel(env, db, callbackQuery, userId, extra);
    case "cancel":
      return handleUserMgmtCancel(env, db, callbackQuery, userId);
    default:
      await safeAnswerCallbackQuery(env, callbackQuery.id, "Unrecognized action.");
  }
}