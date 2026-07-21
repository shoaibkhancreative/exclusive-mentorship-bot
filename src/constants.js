// ───────────────────────────────────────────────────────────────────────────
//  Constants — channel/group IDs, tier & add-on pricing, customer-facing text
// ───────────────────────────────────────────────────────────────────────────
export const CHANNELS = {
  core: "-1004493567361", // was: bundle
  insight: "-1004384027186", // was: market
  templates: "-1004444556470", // was: ch1
  archive: "-1004467545472", // was: ch2
  liveqa: "-1004393432618", // was: ch3
  phase1: "-1003992135949" // was: ch4
  // Spare / unused, still admin'd by the bot, free for future use:
  //   ch5: "-1004394742699"
  //   ch6: "-1004407958337"
  //   ch7: "-1004358379626"
};

export const SUPPORT_GROUPS = {
  consultation: "-1004441541267",
  priority: "-1003993118856",
  basic: "-1004399970222",
  general: "-1004379809812"
};

export const CHAT_TITLES = {
  [CHANNELS.core]: "🎓 Core ICT Course — Recorded Classes",
  [CHANNELS.insight]: "📈 Daily Market Insight",
  [CHANNELS.templates]: "🗂 Setup Templates (Chart & Journal)",
  [CHANNELS.archive]: "🎥 Live Trade Breakdown Archive",
  [CHANNELS.liveqa]: "🎙 Bi-Weekly Live Q&A",
  [CHANNELS.phase1]: "⏳ Tier 2 — Phase 1 Access (Awaiting Installment 2)",
  [SUPPORT_GROUPS.general]: "💬 General Support",
  [SUPPORT_GROUPS.basic]: "💬 Basic Support (Tier 1)",
  [SUPPORT_GROUPS.priority]: "⭐ Priority Support",
  [SUPPORT_GROUPS.consultation]: "🌟 VIP 1-on-1 Consultation Support"
};

// ─────────────────────────────────────────────────────────────────────────
//  CONSTANTS — TIERS / ADD-ONS / PRICING
// ─────────────────────────────────────────────────────────────────────────

export const TIER_NAMES = { T1: "Recorded Class", T2: "Live Mentorship", T3: "1-on-1 Mentorship" };
export const TIER_ORDER = ["T1", "T2", "T3"]; // low → high, for upgrade math
export const TIER_PRICE = { T1: 25, T2: 39, T3: 149 };

// Add-on letter codes used in orders.addons / subscriptions.addon:
//   i = Daily Market Insight        (180 days)
//   t = Setup Templates             (permanent, never expires)
//   a = Live Trade Breakdown Archive(180 days)
//   r = Priority Support + Live Q&A (180 days) — bundled into T2/T3
//   c = VIP 1-on-1 Consultation     (90 days)  — bundled into T3 only
export const ADDON_NAMES = {
  i: "Daily Market Insight",
  t: "Setup Templates (Chart & Journal)",
  a: "Live Trade Breakdown Archive",
  r: "Priority Support + Bi-Weekly Live Q&A",
  c: "Weekly 1-on-1 VIP Consultation"
};
export const ADDON_DURATION_DAYS = { i: 180, a: 180, r: 180, c: 90 }; // "t" intentionally absent = permanent

// Bundled into each tier automatically (for free) at full price / on Tier-2
// installment-2 confirmation / on any upgrade:
export const TIER_BUNDLED_ADDONS = { T1: "", T2: "itar", T3: "itarc" };

// Standalone purchase prices (also used for FIRST-TIME purchase of a
// bundled add-on bought separately, e.g. a Tier 1 owner buying just Daily
// Market Insight):
export const STANDALONE_ADDON_PRICES = { i: 15, t: 10, a: 14 };

// Renewal-only prices for add-ons that are never sold on their own to
// someone who never had them (only offered once previously granted and
// now lapsed). ⚠️ Not specified on the website — adjust freely.
export const PRIORITY_RENEWAL_PRICE_USD = 20; // renews "r" (Priority Support + Live Q&A) for 180 more days
export const CONSULTATION_RENEWAL_PRICE_USD = 75; // renews "c" (VIP Consultation) for 90 more days
export const RENEWAL_PRICES = { r: PRIORITY_RENEWAL_PRICE_USD, c: CONSULTATION_RENEWAL_PRICE_USD };

export const TIER2_SPLIT = { installment1: 24, installment2: 20, penaltyDays: 30 };
// Weekly reminder days (within the 30-day window) to nudge the customer
// about the outstanding Installment 2 balance — 4 reminders in the month.
export const TIER2_SPLIT_REMINDER_DAYS = [7, 14, 21, 28];

// Follow-up schedule (in hours since order creation) for a normal
// single-payment order (T1 full purchase, T3, standalone add-ons, or a
// full-price T2) that's stuck in 'awaiting_photo' (customer said they
// paid but never sent proof) or 'awaiting_choice' (order created from a
// website deep-link but the customer never even tapped "I've Paid").
// See checkStalledOrders().
export const STALLED_ORDER_REMINDER_HOURS = [24, 72];
// Past this many days stuck open, stop nudging the customer every cycle
// and instead just keep them on the daily admin roll-up for manual
// follow-up (a lead this cold is more likely to need a human touch than
// another automated reminder).
export const STALLED_ORDER_ADMIN_ESCALATION_DAYS = 14;

export const MENU_BUTTON_TEXT = "📚 মেনু";
export const MAIN_REPLY_KEYBOARD = { keyboard: [[{ text: MENU_BUTTON_TEXT }]], resize_keyboard: true };

// ⚠️ Must match apps/web/src/data/pricing.js -> paymentMethods exactly. If
// you change the numbers on the website, update them here too.
export const PAYMENT_INSTRUCTIONS_TEXT =
  "নিচের যেকোনো একটি মাধ্যমে সঠিক পরিমাণ টাকা পাঠিয়ে পেমেন্টের স্ক্রিনশট এখানেই আপলোড করুন:\n\n" +
  "• Binance UID (USDT): 767376321\n" +
  "  Binance Pay / internal transfer এর মাধ্যমে এই UID-তে পাঠান। শুধুমাত্র USDT।\n\n" +
  "• USDT Address (TRC20): TJaRxNsDw7qsdQuC6EvyrTo8t9r832oRM8\n" +
  "  শুধুমাত্র TRC20 নেটওয়ার্কে এই ঠিকানায় USDT পাঠান।\n\n" +
  "— NLT Exclusive Mentorship Team";

// ⚠️ Tune this to your team's real payment-review turnaround time — shown
// to the customer right after they submit payment proof so they know what
// to expect instead of wondering if the bot actually received it.
export const PAYMENT_REVIEW_ETA_HOURS = 24;
export const PAYMENT_REVIEW_EXPECTATION_TEXT = `⏳ ধন্যবাদ! আমাদের টিম এখন এটি যাচাই করছে এবং ${PAYMENT_REVIEW_ETA_HOURS} ঘণ্টার মধ্যে এখানে নিশ্চিতকরণ পাঠাবে।\n\n— NLT Exclusive Mentorship Team`;

// ⚠️ Replace with your real website's checkout/pricing URL. Shown to
// anyone who opens the bot directly (not via a site deep-link) and tries
// to buy for the first time — first purchases are website-only (Terms &
// Conditions agreement happens there), so the bot points them back.
export const SITE_CHECKOUT_URL = "https://exclusivementorship.xyz";

// Must match apps/web/src/lib/telegram.js -> ADDON_ORDER exactly. This is
// the fixed bit order [insight, templates, archive] used in the 3-digit
// add-on bitmask inside the /start deep-link payload.
export const SITE_ADDON_BIT_ORDER = ["i", "t", "a"];

export const ACCOUNTABILITY_PROTOCOL_TEXT =
  "💡 <b>ICT Mastery Accountability Protocol</b>\n\n" +
  "আমরা নগদ রিফান্ড অফার করি না — কারণ আমরা এর চেয়ে শক্তিশালী কিছুতে বিশ্বাস করি: মেন্টরশিপ টিমের পক্ষ থেকে সরাসরি, ব্যক্তিগত commitment।\n\n" +
  "আপনি যদি:\n" +
  "1️⃣ কোর্সের ১০০% ভিডিও শেষ করেন\n" +
  "2️⃣ নিয়মিতভাবে Notion trading journal মেইনটেইন করেন\n" +
  "3️⃣ ডেমো অ্যাকাউন্টে ৩০টি লগ করা ট্রেড সম্পন্ন করেন\n\n" +
  "...এবং তারপরও কাঙ্ক্ষিত ফলাফল না পান, তাহলে আমাদের মেন্টরশিপ টিম সরাসরি এক সপ্তাহ ধরে আপনার লাইভ ট্রেডিং পর্যবেক্ষণ করবে এবং সমস্যাটা ঠিক কোথায়, তা বের করতে একটি ফ্রি 1-on-1 Live Breakdown Session করবে।\n\n" +
  "আপনার পরিস্থিতি জানাতে যেকোনো সময় এখানে মেসেজ করুন — আমাদের টিম ব্যক্তিগতভাবে রিভিউ করবে।\n\n" +
  "— NLT Exclusive Mentorship Team";

/** Statuses under which a split T2 order is in its "Installment 2" stage
 *  — i.e. Installment 1 has already been confirmed. Centralized here so
 *  buildOrderSummary() and getOrderDueAmount() can never drift out of
 *  sync with each other about which statuses count as "second stage". */
export const SPLIT_INSTALLMENT2_STATUSES = ["phase1_active", "pending_review_2", "phase1_expired", "pending_review_2_late"];
