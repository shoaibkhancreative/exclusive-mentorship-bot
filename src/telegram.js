// ───────────────────────────────────────────────────────────────────────────
//  Telegram Bot API wrapper helpers
// ───────────────────────────────────────────────────────────────────────────

export const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";

// ─────────────────────────────────────────────────────────────────────────
//  TELEGRAM API HELPERS
// ─────────────────────────────────────────────────────────────────────────

export async function callTelegramApi(env, method, payload) {
  const url = `${TELEGRAM_API_ROOT}${env.BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) {
    const error = new Error(`Telegram API "${method}" failed: ${data.description || "Unknown error"}`);
    error.telegramResponse = data;
    throw error;
  }
  return data.result;
}

export async function sendMessage(env, chatId, text, extra = {}) {
  return callTelegramApi(env, "sendMessage", { chat_id: chatId, text, ...extra });
}

export async function forwardMessage(env, chatId, fromChatId, messageId, extra = {}) {
  return callTelegramApi(env, "forwardMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...extra });
}

export async function answerCallbackQuery(env, callbackQueryId, text = "", showAlert = false) {
  return callTelegramApi(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

export async function safeAnswerCallbackQuery(env, callbackQueryId, text = "", showAlert = false) {
  try {
    await answerCallbackQuery(env, callbackQueryId, text, showAlert);
  } catch (err) {
    console.error("safeAnswerCallbackQuery failed for callback_query_id " + callbackQueryId + ":", err.message);
  }
}

export async function editMessageText(env, chatId, messageId, text, extra = {}) {
  return callTelegramApi(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
}

export async function editMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  return callTelegramApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
}

/** Edits a message in place; falls back to sending a fresh message if the
 *  edit fails (identical content, message too old / deleted, or it was a
 *  media message with no `text` to edit — e.g. a forwarded photo). When it
 *  has to fall back, it also makes a best-effort attempt to strip any
 *  inline keyboard off the now-stale original message first, so old
 *  buttons sitting on it can never be tapped again once a fresh message
 *  has taken over as the "current" one. */
export async function editOrSendMessage(env, chatId, messageId, text, extra = {}) {
  try {
    return await editMessageText(env, chatId, messageId, text, extra);
  } catch (err) {
    try {
      await editMessageReplyMarkup(env, chatId, messageId, { inline_keyboard: [] });
    } catch (stripErr) {
      // Best-effort only — the original message may already be deleted,
      // too old to edit, or otherwise unreachable. Nothing more we can do
      // about it; the fresh message below is the source of truth either way.
    }
    return await sendMessage(env, chatId, text, extra);
  }
}

export async function createChatInviteLink(env, chatId, opts = {}) {
  return callTelegramApi(env, "createChatInviteLink", { chat_id: chatId, member_limit: 1, ...opts });
}

export async function createForumTopic(env, chatId, name) {
  return callTelegramApi(env, "createForumTopic", { chat_id: chatId, name });
}

export async function deleteForumTopic(env, chatId, threadId) {
  return callTelegramApi(env, "deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
}

export async function closeForumTopic(env, chatId, threadId) {
  return callTelegramApi(env, "closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
}

export async function setChatTitle(env, chatId, title) {
  return callTelegramApi(env, "setChatTitle", { chat_id: chatId, title });
}

/** Kicks (ban then immediately unban) so the user is removed now but free
 *  to rejoin via a fresh invite link if they purchase/renew later. */
export async function kickChatMember(env, chatId, userId) {
  await callTelegramApi(env, "banChatMember", { chat_id: chatId, user_id: userId });
  await callTelegramApi(env, "unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
}

/** Bans a user permanently (no auto-unban) — used for timed/permanent bans. */
export async function banChatMemberUntil(env, chatId, userId, untilUnixSeconds) {
  const payload = { chat_id: chatId, user_id: userId };
  if (untilUnixSeconds) payload.until_date = untilUnixSeconds;
  await callTelegramApi(env, "banChatMember", payload);
}
