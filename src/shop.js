// ───────────────────────────────────────────────────────────────────────────
//  Cart + shop view + website deep-link checkout + top-level menu/start commands
// ───────────────────────────────────────────────────────────────────────────

import { ACCOUNTABILITY_PROTOCOL_TEXT, ADDON_NAMES, CONSULTATION_RENEWAL_PRICE_USD, MAIN_REPLY_KEYBOARD, PAYMENT_INSTRUCTIONS_TEXT, PRIORITY_RENEWAL_PRICE_USD, RENEWAL_PRICES, SITE_ADDON_BIT_ORDER, SITE_CHECKOUT_URL, STANDALONE_ADDON_PRICES, SUPPORT_GROUPS, TIER2_SPLIT, TIER_BUNDLED_ADDONS, TIER_NAMES, TIER_ORDER, TIER_PRICE } from './constants.js';
import { editOrSendMessage, safeAnswerCallbackQuery, sendMessage } from './telegram.js';
import { escapeHtml, formatAddonDuration, formatAddonsList, formatAmount, formatDueDate } from './utils.js';
import { getOpenSplitOrder, getSupportGroupForUser, getUserBestTier, getUserEntitlements, hasAnyOrderHistory, hasEverHadAddon, isBanned } from './entitlements.js';
import { buildOrderChoiceCard, buildOrderChoiceKeyboard, buildOrderSummary, getOrderDueAmount } from './orders.js';

// ─────────────────────────────────────────────────────────────────────────
//  SHOP / CART
// ─────────────────────────────────────────────────────────────────────────

export async function getOrCreateCart(db, userId) {
  let cart = await db.prepare(`SELECT * FROM carts WHERE telegram_user_id = ?`).bind(userId).first();
  if (!cart) {
    // ON CONFLICT DO NOTHING: if two requests for a brand-new user race
    // here (e.g. a double-tap before either INSERT commits), the loser's
    // insert silently no-ops instead of throwing a unique-constraint error
    // on telegram_user_id — both callers still get a valid, empty cart.
    await db.prepare(`INSERT INTO carts (telegram_user_id) VALUES (?) ON CONFLICT(telegram_user_id) DO NOTHING`).bind(userId).run();
    cart = { telegram_user_id: userId, tier_action: "", tier: "", split: 0, addons: "" };
  }
  return cart;
}

export function parseCartAddons(cart) {
  return cart.addons ? cart.addons.split("") : [];
}

/** Price of a standalone/renewal add-on letter selected in the cart. */
export function priceForCartAddon(letter) {
  if (STANDALONE_ADDON_PRICES[letter] != null) return STANDALONE_ADDON_PRICES[letter];
  if (RENEWAL_PRICES[letter] != null) return RENEWAL_PRICES[letter];
  return 0;
}

export function calculateCartTotal(cart, currentBestTier = null) {
  let total = 0;
  if (cart.tier_action === "upgrade") {
    total += Math.max(0, (TIER_PRICE[cart.tier] || 0) - (TIER_PRICE[currentBestTier] || 0));
  }
  for (const letter of parseCartAddons(cart)) total += priceForCartAddon(letter);
  return total;
}

/** Renders the Buy/Upgrade/Renew shop screen based on the user's current
 *  entitlements. */
export async function renderShopView(db, userId) {
  const cart = await getOrCreateCart(db, userId);
  const entitlements = await getUserEntitlements(db, userId);
  const openSplit = await getOpenSplitOrder(db, userId);

  const lines = ["🛒 <b>Upgrade / Renew</b>", ""];
  const buttons = [];

  if (openSplit) {
    const dueSuffix = openSplit.installment2_due_at ? ` ${formatDueDate(openSplit.installment2_due_at)} তারিখের মধ্যে` : "";
    lines.push(
      "⏳ আপনার একটি Tier 2 split-payment অর্ডার চলমান আছে।",
      `Installment 2 (${formatAmount(TIER2_SPLIT.installment2)} USDT)${dueSuffix} পরিশোধ করতে হবে — আপনি প্রস্তুত হলে যেকোনো সময় এখানে পেমেন্ট স্ক্রিনশট আপলোড করুন।`
    );
    buttons.push([{ text: "🔙 মেনুতে ফিরে যান", callback_data: "menu:home" }]);
    return { text: lines.join("\n"), keyboard: buttons };
  }

  // First-time purchases ONLY happen on the website (Terms & Conditions
  // agreement is a checkout step there that's impractical to replicate
  // in-bot). A brand-new visitor who's never bought anything gets sent
  // back to the site instead of any Buy button here.
  const everCustomer = await hasAnyOrderHistory(db, userId);
  if (!everCustomer) {
    lines.push(
      "প্রথমবার কেনার জন্য অনুগ্রহ করে আগে আমাদের ওয়েবসাইটে চেকআউট সম্পন্ন করুন — সেখানে আপনি Terms & Conditions-এ সম্মত হবেন, এরপর আপনার প্যাকেজ প্রি-লোড করা অবস্থায় সরাসরি এই বটে ফিরে আসবেন।",
      "",
      `🔗 ${SITE_CHECKOUT_URL}`
    );
    buttons.push([{ text: "🔙 মেনুতে ফিরে যান", callback_data: "menu:home" }]);
    return { text: lines.join("\n"), keyboard: buttons };
  }

  const cartAddons = new Set(parseCartAddons(cart));
  const cartLines = [];

  if (cart.tier_action === "upgrade") {
    const diff = Math.max(0, (TIER_PRICE[cart.tier] || 0) - (TIER_PRICE[entitlements.bestTier] || 0));
    cartLines.push(`⬆️ Upgrade ${entitlements.bestTier} → ${cart.tier} — ${diff} USDT`);
  }
  for (const letter of cartAddons) {
    cartLines.push(`➕ ${ADDON_NAMES[letter]} — ${priceForCartAddon(letter)} USDT${formatAddonDuration(letter)}`);
  }

  if (cartLines.length > 0) {
    lines.push("<b>আপনার কার্ট:</b>", ...cartLines, "", `<b>এখন পরিশোধযোগ্য মোট: ${formatAmount(calculateCartTotal(cart, entitlements.bestTier))} USDT</b>`, "");
  } else {
    lines.push("এখনো কিছু বাছাই করা হয়নি — নিচ থেকে একটি upgrade বা renewal বেছে নিন।", "");
  }

  if (entitlements.bestTier) {
    lines.push(`✅ আপনি বর্তমানে যা মালিকানাধীন: <b>${TIER_NAMES[entitlements.bestTier]}</b>`);
  }

  // --- Upgrade options (existing tier owners only — never a first buy) ---
  if (!cart.tier_action && entitlements.bestTier) {
    const idx = TIER_ORDER.indexOf(entitlements.bestTier);
    for (const higher of TIER_ORDER.slice(idx + 1)) {
      const diff = TIER_PRICE[higher] - TIER_PRICE[entitlements.bestTier];
      buttons.push([{ text: `⬆️ Upgrade to ${higher} (${TIER_NAMES[higher]}) — ${diff} USDT`, callback_data: `cart:upgrade_tier:${higher}` }]);
    }
  }

  // --- Standalone add-ons (never bought before, or currently lapsed) ---
  if (!entitlements.permanentTemplates && !cartAddons.has("t")) {
    buttons.push([{ text: `🗂 Setup Templates যোগ করুন — ${STANDALONE_ADDON_PRICES.t} USDT (permanent)`, callback_data: "cart:add_addon:t" }]);
  }
  if (!entitlements.activeAddons.has("i") && !cartAddons.has("i")) {
    buttons.push([{ text: `📈 Daily Market Insight নবায়ন করুন — ${STANDALONE_ADDON_PRICES.i} USDT (180 days)`, callback_data: "cart:add_addon:i" }]);
  }
  if (!entitlements.activeAddons.has("a") && !cartAddons.has("a")) {
    buttons.push([{ text: `🎥 Trade Archive নবায়ন করুন — ${STANDALONE_ADDON_PRICES.a} USDT (180 days)`, callback_data: "cart:add_addon:a" }]);
  }

  // --- Renewal-only add-ons (only if previously had them, now lapsed) ---
  if (!entitlements.activeAddons.has("r") && !cartAddons.has("r") && (await hasEverHadAddon(db, userId, "r"))) {
    buttons.push([{ text: `⭐ Priority Support + Live Q&A নবায়ন করুন — ${PRIORITY_RENEWAL_PRICE_USD} USDT (180 days)`, callback_data: "cart:add_addon:r" }]);
  }
  if (!entitlements.activeAddons.has("c") && !cartAddons.has("c") && (await hasEverHadAddon(db, userId, "c"))) {
    buttons.push([{ text: `🌟 VIP Consultation নবায়ন করুন — ${CONSULTATION_RENEWAL_PRICE_USD} USDT (90 days)`, callback_data: "cart:add_addon:c" }]);
  }

  const cartHasItems = Boolean(cart.tier_action) || cartAddons.size > 0;
  if (cart.tier_action) buttons.push([{ text: "❌ Tier নির্বাচন বাতিল করুন", callback_data: "cart:remove_tier" }]);
  for (const letter of cartAddons) {
    buttons.push([{ text: `❌ ${ADDON_NAMES[letter]} বাদ দিন`, callback_data: `cart:remove_addon:${letter}` }]);
  }
  if (cartHasItems) {
    buttons.push([
      { text: "🗑 কার্ট খালি করুন", callback_data: "cart:clear" },
      { text: "💳 চেকআউট", callback_data: "cart:checkout" }
    ]);
  }
  buttons.push([{ text: "🔙 মেনুতে ফিরে যান", callback_data: "menu:home" }]);

  return { text: lines.join("\n"), keyboard: buttons };
}

export function renderMainMenu() {
  return {
    text: "📚 <b>মূল মেনু</b>\n\nআপনি কী করতে চান?",
    keyboard: [
      [{ text: "🛒 Upgrade / Renew", callback_data: "menu:buy" }],
      [{ text: "👤 প্রোফাইল / সম্পর্কে", callback_data: "menu:profile" }],
      [{ text: "💡 Accountability Protocol (No Refund Policy)", callback_data: "menu:protocol" }]
    ]
  };
}

export async function renderProfileView(db, fromUser) {
  const userId = String(fromUser.id);
  const tierGroupId = await getSupportGroupForUser(db, userId);
  const entitlements = await getUserEntitlements(db, userId);

  const supportLabel = { [SUPPORT_GROUPS.consultation]: "VIP Consultation", [SUPPORT_GROUPS.priority]: "Priority", [SUPPORT_GROUPS.basic]: "Basic", [SUPPORT_GROUPS.general]: "General" }[tierGroupId] || "General";

  let addonsText = "None";
  if (entitlements.permanentTemplates || entitlements.activeAddons.size > 0) {
    const parts = [];
    if (entitlements.permanentTemplates) parts.push("Setup Templates (permanent)");
    for (const letter of entitlements.activeAddons) {
      if (letter === "t") continue;
      const sub = entitlements.activeDetails.find((s) => s.addon === letter);
      const name = ADDON_NAMES[letter] || letter;
      parts.push(sub ? `${name} (expires ${new Date(sub.expires_at).toISOString().slice(0, 10)})` : name);
    }
    addonsText = parts.join(", ") || "None";
  }

  return [
    "👤 <b>আমার প্রোফাইল</b>",
    "",
    `<b>User ID:</b> <code>${userId}</code>`,
    `<b>মালিকানাধীন Tier:</b> ${escapeHtml(entitlements.bestTier ? `${entitlements.bestTier} — ${TIER_NAMES[entitlements.bestTier]}` : "এখনো নেই")}`,
    `<b>সাপোর্ট লেভেল:</b> ${supportLabel}`,
    `<b>Add-ons:</b> ${escapeHtml(addonsText)}`
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
//  CHECKOUT
// ─────────────────────────────────────────────────────────────────────────

export async function handleCartCheckout(env, db, callbackQuery, userId, chatId, messageId) {
  const cart = await getOrCreateCart(db, userId);
  const cartAddons = parseCartAddons(cart);
  const hasItems = Boolean(cart.tier_action) || cartAddons.length > 0;

  if (!hasItems) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "আপনার কার্ট খালি — আগে কিছু যোগ করুন!", true);
    return;
  }

  if (cart.tier_action && (await getOpenSplitOrder(db, userId))) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "আপনার একটি Tier 2 split payment ইতিমধ্যে চলমান — আগে সেটি শেষ করুন।", true);
    return;
  }

  // Atomically claim + clear the cart, conditioned on it still holding
  // EXACTLY the snapshot we just read. This (not the hasItems check above,
  // which can go stale the instant another request slips in) is what
  // actually protects against a double-tap on "Checkout" — or a duplicate
  // webhook delivery — creating two orders from the same cart: only the
  // first request to commit this UPDATE "wins" and proceeds to insert the
  // order below; the second finds the cart already cleared (0 rows
  // affected) and exits instead of inserting a duplicate.
  const claimResult = await db
    .prepare(
      `UPDATE carts SET tier_action = '', tier = '', split = 0, addons = ''
       WHERE telegram_user_id = ? AND tier_action = ? AND tier = ? AND split = ? AND addons = ?`
    )
    .bind(userId, cart.tier_action || "", cart.tier || "", cart.split || 0, cart.addons || "")
    .run();

  if (!claimResult.meta.changes) {
    await safeAnswerCallbackQuery(env, callbackQuery.id, "এই চেকআউট আগেই প্রসেস করা হয়ে গেছে।", true);
    return;
  }

  const currentBestTier = await getUserBestTier(db, userId);

  let plan = "ADDONS";
  let addonsField = cartAddons.join("");
  let total = calculateCartTotal(cart, currentBestTier);
  let isSplit = 0;
  let isUpgrade = 0;
  let upgradeFrom = null;

  if (cart.tier_action === "upgrade") {
    plan = cart.tier;
    addonsField = (TIER_BUNDLED_ADDONS[cart.tier] || "") + cartAddons.filter((l) => !(TIER_BUNDLED_ADDONS[cart.tier] || "").includes(l)).join("");
    isUpgrade = 1;
    upgradeFrom = currentBestTier;
  }

  const insertResult = await db
    .prepare(
      `INSERT INTO orders (telegram_user_id, telegram_username, plan, addons, total, is_split, is_upgrade, upgrade_from, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_photo')`
    )
    .bind(userId, callbackQuery.from.username || "", plan, addonsField, total, isSplit, isUpgrade, upgradeFrom)
    .run();

  // No separate "mode" flag to flip here: the order row created above is
  // already in 'awaiting_photo', and handleIncomingMedia() checks the
  // orders table directly (hasOpenPaymentOrder) on every upload, so the
  // next photo/document this customer sends will automatically trigger
  // the "payment proof or support?" prompt.

  const order = { id: insertResult.meta.last_row_id, plan, addons: addonsField, total, is_split: isSplit, is_upgrade: isUpgrade, upgrade_from: upgradeFrom, status: "awaiting_photo" };

  const text = ["✅ <b>অর্ডার তৈরি হয়েছে!</b>", "", buildOrderSummary(order), "", escapeHtml(PAYMENT_INSTRUCTIONS_TEXT)].join("\n");

  await editOrSendMessage(env, chatId, messageId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } });
  await safeAnswerCallbackQuery(env, callbackQuery.id, "অর্ডার তৈরি হয়েছে!");
}

// ─────────────────────────────────────────────────────────────────────────
//  WEBSITE DEEP-LINK CHECKOUT  (/start payload from apps/web checkout page)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parses the `start` payload built by apps/web/src/lib/telegram.js:
 *   buildTelegramDeepLink({ packageKey, addonFlags, plan })
 *   → payload = `${packageKey}-${addonCode}-${plan}`
 *   e.g. "T1-100-FULL", "T2-111-SPLIT", "ADDONS-010-FULL"
 *
 * addonCode is a fixed 3-digit bitmask in the order [insight, templates,
 * archive] (SITE_ADDON_BIT_ORDER). Per the site's own comment, the link
 * carries ONLY the package id + add-on flags + plan — never a dollar
 * amount — so this bot always computes the price itself from its own
 * pricing constants (TIER_PRICE / STANDALONE_ADDON_PRICES / TIER2_SPLIT),
 * exactly like the website does. This keeps a single source of truth on
 * each side instead of trusting a number passed through a public link.
 */
export function parseSitePayload(payloadStr) {
  const parts = payloadStr.split("-");
  if (parts.length !== 3) throw new Error(`Malformed payload: "${payloadStr}"`);

  const [packageKey, addonCode, planToken] = parts;
  if (!["T1", "T2", "T3", "ADDONS"].includes(packageKey)) throw new Error(`Unknown package: "${packageKey}"`);
  if (!/^[01]{3}$/.test(addonCode)) throw new Error(`Malformed add-on code: "${addonCode}"`);
  if (!["FULL", "SPLIT"].includes(planToken)) throw new Error(`Unknown plan: "${planToken}"`);

  let addons = SITE_ADDON_BIT_ORDER.filter((_, i) => addonCode[i] === "1").join("");

  // T2 / T3 always bundle all 3 add-ons for free, by business rule —
  // enforced here regardless of exactly what the link's bitmask said.
  if (packageKey === "T2" || packageKey === "T3") addons = TIER_BUNDLED_ADDONS[packageKey];

  const isSplit = packageKey === "T2" && planToken === "SPLIT";
  return { packageKey, addons, isSplit };
}

/**
 * Computes this bot's own price for a parsed site payload — the single
 * source of truth for what's actually charged, matching pricing.js.
 *
 * ⚠️ For a Tier-2 SPLIT purchase, the customer pays TWO installments
 * (TIER2_SPLIT.installment1 + TIER2_SPLIT.installment2 = 44 total), which
 * is MORE than the $39 full up-front T2 price — that premium is the cost
 * of paying in two steps. orders.total must reflect this TRUE combined
 * amount, not the full-payment tier price, or every consumer of
 * order.total (buildOrderSummary, /stats revenue totals, the customer's
 * own profile "Lifetime Value") would silently undercount every split
 * sale by the difference (5 USDT) once the order is fully confirmed.
 */
export function computeSitePayloadTotal({ packageKey, addons, isSplit }) {
  if (packageKey === "ADDONS") {
    return addons.split("").reduce((sum, l) => sum + (STANDALONE_ADDON_PRICES[l] || 0), 0);
  }
  if (packageKey === "T1") {
    const extras = addons.split("").filter((l) => !(TIER_BUNDLED_ADDONS.T1 || "").includes(l));
    return TIER_PRICE.T1 + extras.reduce((sum, l) => sum + (STANDALONE_ADDON_PRICES[l] || 0), 0);
  }
  if (packageKey === "T2" && isSplit) {
    return TIER2_SPLIT.installment1 + TIER2_SPLIT.installment2; // 44, not TIER_PRICE.T2 (39)
  }
  return TIER_PRICE[packageKey]; // T2 (full payment) / T3 — add-ons are free/bundled
}

/** Any order for this user that's still in-flight (awaiting a choice,
 *  awaiting proof, or awaiting admin review — on-time or late) — used to
 *  avoid creating duplicate orders if someone clicks the site's checkout
 *  link more than once. */
export async function getAnyOpenOrder(db, userId) {
  return db
    .prepare(
      `SELECT * FROM orders WHERE telegram_user_id = ? AND status IN
       ('awaiting_choice','awaiting_photo','pending','phase1_active','pending_review_2','phase1_expired','pending_review_2_late')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(userId)
    .first();
}

/**
 * Creates the order straight from a parsed site payload. Because arriving
 * here via the site's checkout deep-link already implies the customer has
 * seen the payment details and pressed "Confirm & Proceed" on the site,
 * the bot does NOT dump the payment address again right away. Instead it
 * shows one stylish welcome card with two choices — "✅ I've Paid" (which
 * then reveals the payment instructions + asks for the screenshot) or
 * "💬 I Need Support" (which skips straight to support, no proof needed
 * yet). This matches the "no double payment-info dump" + "two clear
 * options" behavior requested.
 */
export async function startOrderFromSitePayload(env, db, message, parsed) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "there";

  // Guard against a deep-link handing the customer an order for something
  // they already own — e.g. re-opening an old "Confirm & Proceed" link
  // from the site, or a returning T1 owner opening a fresh T1 checkout
  // link. This is checked BEFORE any order row is created, so nothing is
  // ever left sitting in 'awaiting_choice' for something the customer
  // doesn't actually need to (re)buy.
  const currentBestTier = await getUserBestTier(db, userId);
  if (parsed.packageKey === "ADDONS") {
    if (parsed.addons) {
      const entitlements = await getUserEntitlements(db, userId);
      const alreadyHasEverything = parsed.addons
        .split("")
        .every((letter) => (letter === "t" ? entitlements.permanentTemplates : entitlements.activeAddons.has(letter)));
      if (alreadyHasEverything) {
        await sendMessage(
          env,
          chatId,
          `👋 হ্যালো ${escapeHtml(fullName)} — চেক করে দেখলাম, ${escapeHtml(
            formatAddonsList(parsed.addons)
          )}-এ আপনার সক্রিয় অ্যাক্সেস ইতিমধ্যেই আছে, তাই এখানে নতুন করে কেনার দরকার নেই। প্রোফাইল দেখতে বা অন্য কোনো upgrade দেখতে চাইলে 📚 মেনু বাটনে ট্যাপ করুন।`,
          { parse_mode: "HTML" }
        );
        return;
      }
    }
  } else if (currentBestTier && TIER_ORDER.indexOf(currentBestTier) >= TIER_ORDER.indexOf(parsed.packageKey)) {
    await sendMessage(
      env,
      chatId,
      `👋 হ্যালো ${escapeHtml(fullName)} — আপনি ইতিমধ্যেই <b>${escapeHtml(TIER_NAMES[currentBestTier])}</b>-এ আছেন, যেখানে <b>${escapeHtml(
        TIER_NAMES[parsed.packageKey]
      )}</b>-এর সবকিছু আগে থেকেই অন্তর্ভুক্ত। প্রোফাইল দেখতে বা আরও উঁচু কোনো tier-এ upgrade দেখতে চাইলে 📚 মেনু বাটনে ট্যাপ করুন।`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const total = computeSitePayloadTotal(parsed);

  // Atomic "insert only if this user doesn't already have an open order" —
  // a single INSERT...SELECT...WHERE NOT EXISTS is race-free even if the
  // site's checkout deep-link is opened twice in quick succession (two
  // distinct /start updates, so the update_id idempotency check alone
  // wouldn't catch this — it's a genuinely separate duplicate-order risk
  // on the `orders` table, fixed the same atomic-conditional way).
  const insertResult = await db
    .prepare(
      `INSERT INTO orders (telegram_user_id, telegram_username, plan, addons, total, is_split, is_upgrade, status)
       SELECT ?, ?, ?, ?, ?, ?, 0, 'awaiting_choice'
       WHERE NOT EXISTS (
         SELECT 1 FROM orders WHERE telegram_user_id = ? AND status IN
         ('awaiting_choice','awaiting_photo','pending','phase1_active','pending_review_2','phase1_expired','pending_review_2_late')
       )`
    )
    .bind(userId, message.from.username || "", parsed.packageKey, parsed.addons, total, parsed.isSplit ? 1 : 0, userId)
    .run();

  if (!insertResult.meta.changes) {
    // Someone (very likely this same user, from a double-click) already
    // has an open order — show them that instead of creating a duplicate.
    const existingOpen = await getAnyOpenOrder(db, userId);
    if (existingOpen && existingOpen.status === "awaiting_choice") {
      await sendMessage(env, chatId, buildOrderChoiceCard(existingOpen, fullName), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildOrderChoiceKeyboard(existingOpen.id) }
      });
      return;
    }
    if (existingOpen) {
      const dueSuffix = existingOpen.installment2_due_at ? ` (${formatDueDate(existingOpen.installment2_due_at)} তারিখের মধ্যে)` : "";
      await sendMessage(
        env,
        chatId,
        `⏳ আপনার একটি অর্ডার ইতিমধ্যে চলমান আছে: <b>Order #${existingOpen.id}</b> (${escapeHtml(TIER_NAMES[existingOpen.plan] || existingOpen.plan)})।\n\nএখন পরিশোধযোগ্য পরিমাণ: <b>${formatAmount(getOrderDueAmount(existingOpen))} USDT${dueSuffix}</b>।\n\nঅনুগ্রহ করে এখানে সেই পেমেন্টের স্ক্রিনশট পাঠান, অথবা সাহায্য প্রয়োজন হলে আমাদের মেসেজ করুন।`,
        { parse_mode: "HTML" }
      );
      return;
    }
    // Extremely unlikely fallback (the conflicting order was there a
    // moment ago but is gone by the time we re-checked) — let them retry.
    await sendMessage(env, chatId, "⚠️ আপনার অর্ডার ওপেন করতে গিয়ে একটি সমস্যা হয়েছে। অনুগ্রহ করে ওয়েবসাইটে ফিরে গিয়ে আবার Telegram বাটনে ট্যাপ করুন।");
    return;
  }

  const order = { id: insertResult.meta.last_row_id, plan: parsed.packageKey, addons: parsed.addons, total, is_split: parsed.isSplit ? 1 : 0, is_upgrade: 0, status: "awaiting_choice" };

  // Whoever arrives here — from the site or organically — lands in
  // General Support by default until proof is confirmed; nothing extra to
  // do here, getSupportGroupForUser() already defaults new users there.

  await sendMessage(env, chatId, buildOrderChoiceCard(order, fullName), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildOrderChoiceKeyboard(order.id) },
    link_preview_options: { is_disabled: true }
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  UPDATE HANDLERS
// ─────────────────────────────────────────────────────────────────────────

export async function handleStartCommand(env, db, message) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "there";

  if (await isBanned(db, userId)) {
    await sendMessage(env, chatId, "মেন্টরশিপ টিম আপনার অ্যাক্সেস বাতিল করেছে। এটি ভুল হয়েছে মনে করলে অনুগ্রহ করে সরাসরি সাপোর্টে যোগাযোগ করুন।");
    return;
  }

  const payloadStr = message.text.split(" ").slice(1).join(" ").trim();

  // Came from the website checkout ("Confirm & Proceed" → t.me deep link).
  // Parse the package + add-ons automatically. Payment details are only
  // shown once the customer explicitly says they've paid (see
  // startOrderFromSitePayload) — no double payment-info dump.
  if (payloadStr) {
    let parsed;
    try {
      parsed = parseSitePayload(payloadStr);
    } catch (err) {
      await sendMessage(
        env,
        chatId,
        "⚠️ এই অর্ডার লিঙ্কটি সঠিক নয় বা মেয়াদোত্তীর্ণ মনে হচ্ছে। অনুগ্রহ করে ওয়েবসাইটে ফিরে গিয়ে চেকআউট আবার শুরু করুন এবং Telegram বাটনে আবার ট্যাপ করুন।"
      );
      return;
    }
    await startOrderFromSitePayload(env, db, message, parsed);
    return;
  }

  // Plain /start (no payload) — e.g. someone found the bot directly, or is
  // returning after already ordering. They're auto-added to General
  // Support the moment they message the bot (getSupportGroupForUser()
  // defaults any non-customer there), so just send a warm, stylish
  // welcome explaining their current support level.
  const supportGroupId = await getSupportGroupForUser(db, userId);
  const supportLabel = { [SUPPORT_GROUPS.consultation]: "🌟 VIP Consultation", [SUPPORT_GROUPS.priority]: "⭐ Priority", [SUPPORT_GROUPS.basic]: "✅ Basic", [SUPPORT_GROUPS.general]: "💬 General" }[supportGroupId] || "💬 General";

  await sendMessage(
    env,
    chatId,
    [
      `👋 <b>স্বাগতম, ${escapeHtml(fullName)}!</b>`,
      "",
      "আপনি এখন <b>NLT Exclusive Mentorship</b>-এ আছেন।",
      `আপনার বর্তমান সাপোর্ট লেভেল: <b>${supportLabel}</b>`,
      "",
      "💬 যেকোনো প্রশ্ন থাকলে সরাসরি এখানে টাইপ করুন — সরাসরি আমাদের কাছে চলে যাবে।",
      "📚 প্রোফাইল দেখতে, upgrade করতে বা কোনো add-on নবায়ন করতে নিচের মেনু বাটনে ট্যাপ করুন।"
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: MAIN_REPLY_KEYBOARD }
  );
}

/** /refund — no cash refunds anymore; explain the Accountability Protocol. */
export async function handleRefundCommand(env, db, message) {
  await sendMessage(env, message.chat.id, ACCOUNTABILITY_PROTOCOL_TEXT, { parse_mode: "HTML" });
}

export async function handleMenuCommand(env, db, message) {
  const view = renderMainMenu();
  await sendMessage(env, message.chat.id, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
}

export async function handleMenuCallback(env, db, callbackQuery) {
  const [, action] = (callbackQuery.data || "").split(":");
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (action === "profile") {
    const text = await renderProfileView(db, callbackQuery.from);
    await editOrSendMessage(env, chatId, messageId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 মেনুতে ফিরে যান", callback_data: "menu:home" }]] } });
  } else if (action === "buy") {
    const view = await renderShopView(db, String(callbackQuery.from.id));
    await editOrSendMessage(env, chatId, messageId, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
  } else if (action === "protocol") {
    await editOrSendMessage(env, chatId, messageId, ACCOUNTABILITY_PROTOCOL_TEXT, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 মেনুতে ফিরে যান", callback_data: "menu:home" }]] } });
  } else {
    const view = renderMainMenu();
    await editOrSendMessage(env, chatId, messageId, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
  }
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

export async function handleCartCallback(env, db, callbackQuery) {
  const [, action, param] = (callbackQuery.data || "").split(":");
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (action === "checkout") {
    await handleCartCheckout(env, db, callbackQuery, userId, chatId, messageId);
    return;
  }

  const cart = await getOrCreateCart(db, userId);

  if (action === "upgrade_tier") {
    const currentTier = await getUserBestTier(db, userId);
    if (!currentTier) {
      await safeAnswerCallbackQuery(env, callbackQuery.id, "আপনার এখনো কোনো Tier নেই — অনুগ্রহ করে আগে আমাদের ওয়েবসাইট থেকে কিনুন।", true);
      return;
    }
    if (await getOpenSplitOrder(db, userId)) {
      await safeAnswerCallbackQuery(env, callbackQuery.id, "আপনার একটি Tier 2 split payment ইতিমধ্যে চলমান আছে।", true);
      return;
    }
    if (TIER_ORDER.indexOf(param) <= TIER_ORDER.indexOf(currentTier)) {
      await safeAnswerCallbackQuery(env, callbackQuery.id, "আপনার বর্তমান Tier থেকে এটি একটি বৈধ upgrade নয়।", true);
      return;
    }
    await db.prepare(`UPDATE carts SET tier_action = 'upgrade', tier = ?, split = 0 WHERE telegram_user_id = ?`).bind(param, userId).run();
    // Note: carts has no upgrade_from column — it's recomputed from the
    // user's current best confirmed tier at checkout time instead.
  } else if (action === "remove_tier") {
    await db.prepare(`UPDATE carts SET tier_action = '', tier = '', split = 0 WHERE telegram_user_id = ?`).bind(userId).run();
  } else if (action === "add_addon") {
    const letter = param;
    // Server-side re-validation — never trust the callback_data alone.
    // First-time purchases of ANY add-on happen on the website only; the
    // bot only ever offers a RENEWAL of something the user previously had
    // and that has since lapsed (or, for "t", never at all — it's
    // permanent once granted, so there's nothing to renew).
    if (letter === "t" || !ADDON_NAMES[letter]) {
      await safeAnswerCallbackQuery(env, callbackQuery.id, "এই add-on এখানে নবায়নের জন্য উপলব্ধ নয়।", true);
      return;
    }
    const entitlements = await getUserEntitlements(db, userId);
    const everHad = await hasEverHadAddon(db, userId, letter);
    if (!everHad || entitlements.activeAddons.has(letter)) {
      await safeAnswerCallbackQuery(env, callbackQuery.id, "এই মুহূর্তে এই add-on নবায়নের যোগ্য নয়।", true);
      return;
    }
    const cartAddons = new Set(parseCartAddons(cart));
    cartAddons.add(letter);
    await db.prepare(`UPDATE carts SET addons = ? WHERE telegram_user_id = ?`).bind([...cartAddons].join(""), userId).run();
  } else if (action === "remove_addon") {
    const letter = param;
    const cartAddons = new Set(parseCartAddons(cart));
    cartAddons.delete(letter);
    await db.prepare(`UPDATE carts SET addons = ? WHERE telegram_user_id = ?`).bind([...cartAddons].join(""), userId).run();
  } else if (action === "clear") {
    await db.prepare(`UPDATE carts SET tier_action = '', tier = '', split = 0, addons = '' WHERE telegram_user_id = ?`).bind(userId).run();
  }

  const view = await renderShopView(db, userId);
  await editOrSendMessage(env, chatId, messageId, view.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: view.keyboard } });
  await safeAnswerCallbackQuery(env, callbackQuery.id);
}