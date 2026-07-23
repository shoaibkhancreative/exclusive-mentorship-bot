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
//  BULK TELEGRAM CALLS ACROSS MANY CHATS (per-chat rate-limit pacing)
// ─────────────────────────────────────────────────────────────────────────

/** Reorders `items` round-robin by `keyFn(item)` so consecutive items are as
 *  likely as possible to target DIFFERENT keys — e.g. turns
 *  [g1,g1,g1,g2,g2,g3] into [g1,g2,g3,g1,g2,g1]. Used before
 *  runPacedByChat() so a bulk job doesn't accidentally serialize itself:
 *  if the input happens to already be grouped/sorted by chat (e.g. rows
 *  came back from the DB ordered by group_id), processing it in that order
 *  would mean every consecutive call targets the SAME chat and has to wait
 *  out the full per-chat interval, even though calls to other chats could
 *  have safely been interleaved in between for free. */
export function interleaveByKey(items, keyFn) {
  const buckets = new Map();
  for (const item of items) {
    const key = String(keyFn(item));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const queues = [...buckets.values()];
  const result = [];
  let more = true;
  while (more) {
    more = false;
    for (const q of queues) {
      if (q.length) {
        result.push(q.shift());
        more = true;
      }
    }
  }
  return result;
}

/** Runs `fn(item)` once per item, pacing calls so that two calls sharing the
 *  same chat (per `chatIdFn(item)`) are never fired less than `minIntervalMs`
 *  apart — Telegram enforces roughly 20 actions/minute per chat for group
 *  admin actions (kicking members, deleting forum topics, etc.), i.e. one
 *  call every ~3s. Calls to DIFFERENT chats are NOT delayed against each
 *  other, only against themselves, so this stays fast when a job spans many
 *  chats and only slows down for chats that actually receive a lot of calls.
 *
 *  This replaces a flat sleep()-between-every-call approach, which is only
 *  safe when every call happens to target a different chat. A bulk job like
 *  a full database wipe concentrates most of its calls on a small, fixed
 *  set of chats (a handful of channels/support groups), so a flat delay
 *  that's short enough to be practical for a large user base is nowhere
 *  near enough spacing for any ONE of those chats — calls start failing
 *  with 429s faster than the built-in single-retry-on-429 in
 *  callTelegramApiWithRetry can absorb, and those failures are what were
 *  showing up as "topics/removals that didn't happen".
 *
 *  `fn` is expected to handle/report its own errors (this helper doesn't
 *  swallow or retry them) — it only controls the timing between calls. */
export async function runPacedByChat(items, chatIdFn, fn, minIntervalMs = 3100) {
  const lastCallAt = new Map();
  for (const item of items) {
    const chatId = String(chatIdFn(item));
    const last = lastCallAt.get(chatId);
    if (last !== undefined) {
      const wait = minIntervalMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastCallAt.set(chatId, Date.now());
    await fn(item);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  ERROR NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────

/** Notifies the admin of an error, always including the raw stack, but
 *  ALSO pulling out the specific Telegram API failure reason when the
 *  error came from callTelegramApi() (see src/telegram.js) — i.e. when
 *  error.telegramResponse is present. That's the piece that actually
 *  answers "why did this fail" (file too big, protect_content enabled on
 *  the source chat, message to forward not found / already deleted, bot
 *  lacking permission in the target chat, etc.) — without surfacing it,
 *  the admin only ever sees a generic stack trace and has to guess.
 *
 *  `meta.mediaKind`, when passed, gets its own banner line so a failed
 *  video/video_note forward is impossible to miss in the admin chat —
 *  the exact Telegram reason is visible right there next time it
 *  happens, instead of just another anonymous forward failure. */
export async function notifyAdminError(env, error, context = "", meta = {}) {
  console.error(`[${context}]`, error);
  if (!env.ADMIN_CHAT_ID || !env.BOT_TOKEN) return;
  try {
    const lines = [`🔥 <b>Bot Error</b>${context ? ` — ${escapeHtml(context)}` : ""}`];

    const mediaKind = meta && meta.mediaKind;
    if (mediaKind === "video" || mediaKind === "video_note") {
      lines.push("", `🎥 <b>VIDEO FORWARD FAILED</b> (mediaKind: <code>${escapeHtml(mediaKind)}</code>)`);
    } else if (mediaKind) {
      lines.push("", `📎 Media kind: <code>${escapeHtml(mediaKind)}</code>`);
    }

    const tg = error && error.telegramResponse;
    if (tg) {
      lines.push("", `<b>Telegram says:</b> ${escapeHtml(tg.description || "Unknown error")} (error_code: <code>${escapeHtml(String(tg.error_code ?? "?"))}</code>)`);
      if (tg.parameters && Object.keys(tg.parameters).length) {
        lines.push(`Parameters: <code>${escapeHtml(JSON.stringify(tg.parameters))}</code>`);
      }
    }

    const rawDetails = error && error.stack ? error.stack : String(error);
    lines.push("", `<code>${escapeHtml(rawDetails.slice(0, 3000))}</code>`);

    await sendMessage(env, env.ADMIN_CHAT_ID, lines.join("\n"), { parse_mode: "HTML" });
  } catch (notifyErr) {
    console.error("Failed to notify admin of the error above:", notifyErr);
  }
}