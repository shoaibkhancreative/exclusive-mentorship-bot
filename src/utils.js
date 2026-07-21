// ───────────────────────────────────────────────────────────────────────────
//  Small formatting / rate-limit / misc utility helpers
// ───────────────────────────────────────────────────────────────────────────

import { ADDON_DURATION_DAYS, ADDON_NAMES } from './constants.js';
import { sendMessage } from './telegram.js';

export const RATE_LIMIT_WINDOWS_MS = { media: 3000, button: 600 };
export const lastActionAt = new Map();

// ─────────────────────────────────────────────────────────────────────────
//  RATE LIMITING (lightweight, in-memory, best-effort — see old bot's notes)
// ─────────────────────────────────────────────────────────────────────────

/** Returns 0 if the action is allowed (and records this as the latest
 *  action for the key), or the number of milliseconds still remaining in
 *  the rate-limit window if it should be blocked. Existing callers that
 *  only care about yes/no can keep writing `if (isRateLimited(...))` —
 *  any positive number of remaining ms is truthy, 0 is falsy — while
 *  callers that want to tell the user exactly how long to wait can use
 *  the returned value directly instead of a hardcoded "a few seconds". */
export function isRateLimited(userId, category = "default") {
  const key = `${category}:${userId}`;
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOWS_MS[category] || 1000;
  if (lastActionAt.size > 5000) {
    for (const [k, ts] of lastActionAt) {
      if (now - ts > windowMs * 10) lastActionAt.delete(k);
    }
  }
  const last = lastActionAt.get(key);
  if (last) {
    const elapsed = now - last;
    if (elapsed < windowMs) return windowMs - elapsed;
  }
  lastActionAt.set(key, now);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
//  FORMATTING / UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────

export function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatAmount(amount) {
  const n = Number(amount) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function formatAddonsList(addons) {
  if (!addons) return "None";
  return addons.split("").map((l) => ADDON_NAMES[l] || l).join(", ");
}

export function formatAddonDuration(letter) {
  const days = ADDON_DURATION_DAYS[letter];
  if (!days) return " (permanent)";
  if (days % 30 === 0) return ` (${days / 30}-month access)`;
  return ` (${days}-day access)`;
}

/** YYYY-MM-DD formatting for absolute deadlines shown to customers —
 *  matches the same date format already used elsewhere for add-on expiry
 *  dates (see renderProfileView / handleUserMgmtRenewMenu), so due dates
 *  and expiry dates read consistently across the bot. */
export function formatDueDate(isoString) {
  if (!isoString) return "soon";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "soon";
  return date.toISOString().slice(0, 10);
}

export function stripSupergroupPrefix(chatId) {
  const str = String(chatId);
  return str.startsWith("-100") ? str.slice(4) : str.replace(/^-/, "");
}

/** Returns the media kind name for any message Telegram lets us forward
 *  (photo/document/video/video_note/animation/voice/sticker), or null if
 *  the message has no such media. Used both to detect admin replies that
 *  carry media and by handleIncomingMedia's existing checks. */
export function getForwardableMediaKind(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) return "photo";
  if (message.document) return "document";
  if (message.video) return "video";
  if (message.video_note) return "video_note";
  if (message.animation) return "animation";
  if (message.voice) return "voice";
  if (message.sticker) return "sticker";
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────
//  ERROR NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────

export async function notifyAdminError(env, error, context = "") {
  console.error(`[${context}]`, error);
  if (!env.ADMIN_CHAT_ID || !env.BOT_TOKEN) return;
  try {
    const rawDetails = error && error.stack ? error.stack : String(error);
    const details = rawDetails.slice(0, 3500);
    const text = `🔥 <b>Bot Error</b>${context ? ` — ${escapeHtml(context)}` : ""}\n\n<code>${escapeHtml(details)}</code>`;
    await sendMessage(env, env.ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
  } catch (notifyErr) {
    console.error("Failed to notify admin of the error above:", notifyErr);
  }
}
