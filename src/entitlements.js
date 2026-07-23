// ───────────────────────────────────────────────────────────────────────────
//  User entitlement / tier / subscription helpers
// ───────────────────────────────────────────────────────────────────────────

import { ADDON_DURATION_DAYS, ADDON_NAMES, CHANNELS, SUPPORT_GROUPS, TIER_ORDER } from './constants.js';
import { createChatInviteLink, sendMessage } from './telegram.js';
import { escapeHtml } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────
//  TIME-BOUND ADD-ON SUBSCRIPTIONS
// ─────────────────────────────────────────────────────────────────────────

export async function createSubscription(db, userId, letter, orderId, days) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare(`INSERT INTO subscriptions (telegram_user_id, addon, order_id, expires_at, active) VALUES (?, ?, ?, ?, 1)`)
    .bind(userId, letter, orderId, expiresAt)
    .run();
}

export async function getActiveTimedAddons(db, userId) {
  const nowIso = new Date().toISOString();
  const { results } = await db
    .prepare(`SELECT DISTINCT addon FROM subscriptions WHERE telegram_user_id = ? AND active = 1 AND expires_at > ?`)
    .bind(userId, nowIso)
    .all();
  return new Set((results || []).map((r) => r.addon));
}

export async function getActiveSubscriptionDetails(db, userId) {
  const nowIso = new Date().toISOString();
  const { results } = await db
    .prepare(`SELECT id, addon, expires_at FROM subscriptions WHERE telegram_user_id = ? AND active = 1 AND expires_at > ? ORDER BY expires_at DESC`)
    .bind(userId, nowIso)
    .all();
  return results || [];
}

/** Has the user EVER had a subscription row for this addon (used to gate
 *  "renewal-only" add-ons r/c so they're never sold to someone who never
 *  had them in the first place). */
export async function hasEverHadAddon(db, userId, letter) {
  const row = await db.prepare(`SELECT id FROM subscriptions WHERE telegram_user_id = ? AND addon = ? LIMIT 1`).bind(userId, letter).first();
  return Boolean(row);
}

/** True if the user has EVER had ANY confirmed order (a tier purchase, an
 *  upgrade, or a standalone ADDONS purchase) — used to decide whether the
 *  in-bot shop can show them Upgrade/Renew options at all, or whether
 *  they must be sent to the website first (first purchases are
 *  website-only; see SITE_CHECKOUT_URL). */
export async function hasAnyOrderHistory(db, userId) {
  const row = await db.prepare(`SELECT id FROM orders WHERE telegram_user_id = ? AND status = 'confirmed' LIMIT 1`).bind(userId).first();
  return Boolean(row);
}

/** True if the user currently has an order actually awaiting payment
 *  proof — a normal single-step purchase in 'awaiting_photo', a Tier-2
 *  split payment mid-way through waiting on Installment 2
 *  ('phase1_active'), or a Tier-2 split payment whose 30-day Installment-2
 *  window has already lapsed but who hasn't submitted a late screenshot
 *  yet ('phase1_expired' — still resumable, see processPaymentProof).
 *  This is checked directly against the orders table every time media
 *  arrives, rather than tracked via a separate mutable "mode" flag that
 *  could drift out of sync with the order's real state. */
export async function hasOpenPaymentOrder(db, userId) {
  const row = await db
    .prepare(`SELECT id FROM orders WHERE telegram_user_id = ? AND status IN ('awaiting_photo','phase1_active','phase1_expired') LIMIT 1`)
    .bind(userId)
    .first();
  return Boolean(row);
}

// ─────────────────────────────────────────────────────────────────────────
//  ENTITLEMENTS
// ─────────────────────────────────────────────────────────────────────────

export async function isBanned(db, userId) {
  const nowIso = new Date().toISOString();
  const row = await db.prepare(`SELECT telegram_user_id, banned_until FROM banned_users WHERE telegram_user_id = ?`).bind(userId).first();
  if (!row) return false;
  // A banned_until in the past means a timed ban has lapsed — treat as
  // no-longer-banned but leave the historical row alone (harmless).
  if (row.banned_until && new Date(row.banned_until).getTime() <= Date.now()) return false;
  return true;
}

/** The highest tier the user has ever had CONFIRMED (T1 < T2 < T3), or null. */
export async function getUserBestTier(db, userId) {
  const { results } = await db
    .prepare(`SELECT plan FROM orders WHERE telegram_user_id = ? AND status = 'confirmed' AND plan IN ('T1','T2','T3')`)
    .bind(userId)
    .all();
  const plans = (results || []).map((r) => r.plan);
  let best = null;
  for (const p of TIER_ORDER) {
    if (plans.includes(p)) best = p;
  }
  return best;
}

/** True if user has an unresolved Tier-2 split-payment order in progress
 *  (awaiting proof, awaiting admin review — on-time or late — or in the
 *  Phase-1 waiting period) — used to block starting a new tier upgrade
 *  mid-flow. */
export async function getOpenSplitOrder(db, userId) {
  return db
    .prepare(
      `SELECT * FROM orders WHERE telegram_user_id = ? AND is_split = 1
       AND status IN ('awaiting_choice','awaiting_photo','pending','phase1_active','pending_review_2','phase1_expired','pending_review_2_late')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(userId)
    .first();
}

/** Full entitlement snapshot for a user: permanent core/course access,
 *  the permanent Setup Templates flag, and all currently-active timed
 *  add-ons with expiry. */
export async function getUserEntitlements(db, userId) {
  if (await isBanned(db, userId)) {
    return { hasCore: false, bestTier: null, permanentTemplates: false, activeAddons: new Set(), activeDetails: [] };
  }
  const bestTier = await getUserBestTier(db, userId);
  const { results } = await db
    .prepare(`SELECT addons FROM orders WHERE telegram_user_id = ? AND status = 'confirmed'`)
    .bind(userId)
    .all();
  const permanentTemplates = (results || []).some((o) => (o.addons || "").includes("t"));
  const activeAddons = await getActiveTimedAddons(db, userId);
  const activeDetails = await getActiveSubscriptionDetails(db, userId);
  return { hasCore: Boolean(bestTier), bestTier, permanentTemplates, activeAddons, activeDetails };
}

/** Which of the 4 support groups this user's messages should route to. */
export async function getSupportGroupForUser(db, userId) {
  if (await isBanned(db, userId)) return SUPPORT_GROUPS.general;
  const active = await getActiveTimedAddons(db, userId);
  if (active.has("c")) return SUPPORT_GROUPS.consultation;
  if (active.has("r")) return SUPPORT_GROUPS.priority;
  const bestTier = await getUserBestTier(db, userId);
  if (bestTier) return SUPPORT_GROUPS.basic;
  return SUPPORT_GROUPS.general;
}

// ─────────────────────────────────────────────────────────────────────────
//  GRANTING ACCESS (channel invites + support-tier changes) ON CONFIRM
// ─────────────────────────────────────────────────────────────────────────

/** Sends the customer an invite link for a single channel, tracking any
 *  failure so the admin can be told to fix bot permissions / send it
 *  manually. Returns the invite link string, or null on failure. */
export async function grantChannelInvite(env, channelId, note) {
  try {
    const invite = await createChatInviteLink(env, channelId, { name: note || undefined });
    return invite.invite_link;
  } catch (err) {
    return null;
  }
}

/**
 * Grants everything a confirmed order entitles the user to: the permanent
 * core course channel (only if not already granted), each add-on letter's
 * channel + timer, and reports back a message plus any failures for the
 * admin. Used for: normal T1/T2/T3 confirms, ADDONS-only confirms,
 * Tier-2 split Installment-2 confirms (on-time or late), and upgrade
 * confirms.
 */
export async function grantEntitlementsForOrder(env, db, order, { alreadyHadCore = false } = {}) {
  const userId = order.telegram_user_id;
  const links = [];
  const failedTargets = [];

  if (order.plan !== "ADDONS" && !alreadyHadCore) {
    const link = await grantChannelInvite(env, CHANNELS.core, `Order #${order.id} - Core Course`);
    if (link) links.push(["🎓 Core Course (Recorded Classes)", link]);
    else failedTargets.push(CHANNELS.core);
  }

  for (const letter of order.addons || "") {
    const days = ADDON_DURATION_DAYS[letter];
    if (days) await createSubscription(db, userId, letter, order.id, days);

    if (letter === "i" || letter === "a" || letter === "t") {
      const chan = letter === "i" ? CHANNELS.insight : letter === "a" ? CHANNELS.archive : CHANNELS.templates;
      const link = await grantChannelInvite(env, chan, `Order #${order.id} - ${ADDON_NAMES[letter]}`);
      if (link) links.push([`${ADDON_NAMES[letter]}`, link]);
      else failedTargets.push(chan);
    } else if (letter === "r") {
      const link = await grantChannelInvite(env, CHANNELS.liveqa, `Order #${order.id} - Live Q&A`);
      if (link) links.push(["🎙 Bi-Weekly Live Q&A", link]);
      else failedTargets.push(CHANNELS.liveqa);
      // Priority Support is NOT an invite-link/membership grant — it's
      // topic-based, same as General/Basic Support. getSupportGroupForUser()
      // already routes the customer's messages into a topic inside
      // SUPPORT_GROUPS.priority (owner/admin-only group) as soon as their
      // "r" subscription is active, so nothing needs to be sent here.
    } else if (letter === "c") {
      // VIP Consultation Support is also NOT an invite-link/membership
      // grant — it's topic-based, same as Priority/Basic/General. Since
      // getSupportGroupForUser() checks active.has("c") before
      // active.has("r"), a Tier 3 customer (who gets both "r" and "c")
      // lands straight in the Consultation topic, not the Priority one.
      // The actual 1-on-1 call itself is a separate, human-scheduled
      // thing — hence the admin ping below — but no chat-group link is
      // ever sent to the customer for it.
      await sendMessage(
        env,
        env.ADMIN_CHAT_ID,
        `📞 <b>Action needed:</b> Order #${order.id} grants VIP 1-on-1 Consultation. Please personally schedule/send the call link to this student (User ID: <code>${escapeHtml(userId)}</code>).`,
        { parse_mode: "HTML" }
      );
    }
  }

  return { links, failedTargets };
}

/** Kicks the user out of a channel/group tied to a single expired add-on
 *  letter (used by the daily cron). */
export function channelForExpiredAddon(letter) {
  if (letter === "i") return [CHANNELS.insight];
  if (letter === "a") return [CHANNELS.archive];
  // Priority Support and VIP Consultation Support (SUPPORT_GROUPS.priority /
  // .consultation) are topic-based, not membership-based — the customer is
  // never actually added to either group, so there's nothing to kick them
  // from. Once "r"/"c" expires, getSupportGroupForUser() simply stops
  // routing them there.
  if (letter === "r") return [CHANNELS.liveqa];
  if (letter === "c") return [];
  return [];
}