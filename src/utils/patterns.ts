/**
 * Regex patterns for spam/scam/phishing advertising in Telegram chats.
 *
 * Hardcoded in code (not configurable via Telegram commands in MVP), because
 * they are shared across all chats and require quality control on changes.
 *
 * ---------------------------------------------------------------------------
 * MULTI-LANGUAGE STRATEGY
 * ---------------------------------------------------------------------------
 * Priority right now is RU chats, so the RU pack is the biggest and most
 * tuned. The structure below is built so adding a new language later is just
 * "add a new pattern array + register it in LANGUAGE_PACKS" — no changes to
 * scoring/pipeline code.
 *
 * Language handling has 3 layers:
 *  1. `detectScripts(text)` — cheap, dependency-free heuristic based on
 *     Unicode script ranges (Cyrillic vs Latin vs other). This is NOT a real
 *     language detector (doesn't distinguish RU/UA/BG, or EN/DE), just tells
 *     us which pattern packs are worth running. Good enough for routing.
 *  2. `CATEGORY` enum — every pattern belongs to a category that's shared
 *     across languages (e.g. GAMBLING, FAKE_JOB). When you add a new
 *     language pack, reuse these categories so scoring/logging/analytics
 *     stay comparable across languages instead of fragmenting per-locale.
 *  3. `ANY_LANG_PATTERNS` — language-agnostic signals (brand names, phone
 *     numbers, emoji/caps spam) that fire regardless of detected script.
 *
 * If you need real language detection later (e.g. to separate RU/UA or
 * distinguish English spam from French), swap `detectScripts` for a small
 * library (franc, cld3-asm) — the pack-selection logic downstream doesn't
 * need to change, just what feeds it.
 */

export enum SpamCategory {
    ENGAGEMENT_BAIT = "engagement_bait",
    PASSIVE_INCOME = "passive_income",
    DM_REDIRECT = "dm_redirect",
    EXPERT_TEASER = "expert_teaser",
    CRYPTO = "crypto",
    MULTIPLIER_PROMISE = "multiplier_promise",
    FAKE_JOB = "fake_job",
    GAMBLING = "gambling",
    TELEGRAM_PHISHING = "telegram_phishing",
    URGENCY = "urgency",
    MLM_STRUCTURE = "mlm_structure",
    FAKE_GIVEAWAY = "fake_giveaway",
    DELIVERY_CUSTOMS_SCAM = "delivery_customs_scam",
    BANK_PHISHING = "bank_phishing",
    ADULT_CONTENT = "adult_content",
    FAKE_DOCUMENTS = "fake_documents",
    REAL_ESTATE_SCAM = "real_estate_scam",
    COURIER_RECRUITMENT = "courier_recruitment",
    FAKE_INVESTMENT_PLATFORM = "fake_investment_platform",
}

export interface SpamPattern {
    /** Short identifier for logging */
    name: string;
    /** Shared category, comparable across languages */
    category: SpamCategory;
    /** Compiled regex — case-insensitive, unicode-aware, applied to NORMALIZED text */
    regex: RegExp;
    /** Score contributed when this pattern matches */
    score: number;
}

const r = (src: string, flags = "iu") => new RegExp(src, flags);

/* ------------------------------------------------------------------ *
 *  Text normalization — defeats common evasion tricks:
 *  - zero-width / invisible chars (ZWSP, soft hyphen, combining marks)
 *  - Latin/Cyrillic homoglyph swaps ("рaссивный" with Latin "a")
 *  - letter-spacing evasion ("п.л.ю.с", "п_л_ю_с") — но НЕ пробелы между
 *    словами, иначе ломаются многословные паттерны ("пиши в лс")
 *  - repeated chars used to dodge exact matches ("дооооход")
 *
 *  ВАЖНО про гомоглифы: приводим к кириллице ТОЛЬКО символы, у которых есть
 *  визуально неотличимый кириллический двойник (а↔a, о↔o, р↔p ...). Уникальную
 *  латиницу (w, n, g, s, b, d, f, h, j, l, q, r, t, v, z, m ...) НЕ трогаем —
 *  на ней пишутся EN-паттерны и язык-агностичные сигналы (1win, network
 *  marketing). Раньше код конвертировал всю латиницу в кириллицу, что ломало
 *  все латинские паттерны (они никогда не матчились).
 * ------------------------------------------------------------------ */

const HOMOGLYPH_MAP: Record<string, string> = {
    // латиница → кириллица (только визуально неотличимые пары)
    a: "а",
    e: "е",
    o: "о",
    p: "р",
    c: "с",
    x: "х",
    y: "у",
    i: "і",
    k: "к",
    // заглавные
    A: "А",
    E: "Е",
    O: "О",
    P: "Р",
    C: "С",
    X: "Х",
    Y: "У",
    I: "І",
    K: "К",
    // кириллица → кириллица (нормализация украинской і к единообразию)
    // намеренно НЕ трогаем w/n/g/s/b/d/f/h/j/l/q/r/t/v/z/m — они уникальны
};

const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;
// Разделители ВНУТРИ слова: п.л.ю.с, п_л_ю_с, п-л-ю-с. Пробелы сюда НЕ входят,
// иначе "пиши в лс" схлопывается в "пишивлс" и паттерн "пиши\s+в\s+лс" мимо.
const INTRA_WORD_SEPARATOR_RE = /(?<=\p{L})[._\-*•·]+(?=\p{L})/gu;
const REPEATED_LETTER_RE = /(\p{L})\1{2,}/gu;
// Схлопываем множественные пробелы в один — паттерны используют \s+.
const MULTI_SPACE_RE = /\s+/g;

export function normalizeSpamText(input: string): string {
    let s = input;
    s = s.replace(ZERO_WIDTH_RE, "");
    // применяем гомоглиф-мапу только к символам, которые в ней перечислены;
    // вся остальная латиница остаётся как есть
    s = s.replace(/[aekpcxyiAEKPCXYI]/g, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
    let prevLen: number;
    do {
        prevLen = s.length;
        s = s.replace(INTRA_WORD_SEPARATOR_RE, "");
    } while (s.length !== prevLen);
    s = s.replace(REPEATED_LETTER_RE, "$1");
    s = s.replace(MULTI_SPACE_RE, " ");
    s = s.toLowerCase().trim();
    return s;
}

/* ------------------------------------------------------------------ *
 *  Cheap script detection (no external deps). Returns which scripts
 *  are present and roughly how dominant each is — used to decide which
 *  language pattern packs to run.
 * ------------------------------------------------------------------ */

export type ScriptTag = "cyrillic" | "latin" | "other";

export function detectScripts(text: string): Record<ScriptTag, number> {
    const counts: Record<ScriptTag, number> = {
        cyrillic: 0,
        latin: 0,
        other: 0,
    };
    for (const ch of text) {
        if (/\p{Script=Cyrillic}/u.test(ch)) counts.cyrillic++;
        else if (/\p{Script=Latin}/u.test(ch)) counts.latin++;
        else if (/\p{L}/u.test(ch)) counts.other++;
    }
    return counts;
}

/** Decide which language packs are worth running against this text. */
export function selectLanguagePacks(
    text: string,
): (keyof typeof LANGUAGE_PACKS)[] {
    const { cyrillic, latin } = detectScripts(text);
    const packs: (keyof typeof LANGUAGE_PACKS)[] = ["ru"]; // priority pack always runs
    // Run EN pack too if there's meaningful Latin content — cheap, and
    // catches mixed-language spam ("ЗАРАБОТОК" + "DM me for details").
    if (latin >= 6 && latin >= cyrillic * 0.3) {
        packs.push("en");
    }
    return packs;
}

/* ------------------------------------------------------------------ *
 *  RU pack — priority, most tuned
 * ------------------------------------------------------------------ */

const RU_PATTERNS: SpamPattern[] = [
    {
        name: "ru_plus_in_comments",
        category: SpamCategory.ENGAGEMENT_BAIT,
        regex: r("жду\\s+(плюс|\\+)|ставьте\\s+\\+|плюс\\s+в\\s+коммент"),
        score: 3,
    },
    {
        name: "ru_money_lure",
        category: SpamCategory.PASSIVE_INCOME,
        // Голые слова-приманки про деньги/доход, без необходимости в длинном
        // контексте. Это сильный сигнал в любом случае — спамер почти всегда
        // использует именно такие формулировки.
        regex: r(
            "заработ(ок|ать|аешь|айте)|пассивн(ый|ого|ому|ым)?\\s*доход|легк(ие|их|ая)\\s+деньг[иаи]|быстр(ый|ые|ая)\\s+(доход|заработок|деньг)|дополнительн(ый|ого|ое)\\s+(заработок|доход)|зарабатывай\\s+не\\s+выходя|доход\\s+без\\s+вложени",
        ),
        score: 5,
    },
    {
        name: "ru_passive_income",
        category: SpamCategory.PASSIVE_INCOME,
        regex: r(
            "пассивн(ый|ого|ому|ым)?\\s*доход|дополнительн(ый|ого|ое)\\s+(заработок|доход)|зарабатывай\\s+не\\s+выходя",
        ),
        score: 4,
    },
    {
        name: "ru_write_in_dm",
        category: SpamCategory.DM_REDIRECT,
        regex: r(
            "пиши\\s+(мне\\s+)?в\\s+(лс|личку|личные|лс\\s*\\))|пишите\\s+в\\s+личные\\s+сообщения|стучи\\s+в\\s+лс|в\\s+директ\\s+пиши|напиши\\s+слово|отвечу\\s+в\\s+лс",
        ),
        score: 5,
    },
    {
        name: "ru_expert_teaser",
        category: SpamCategory.EXPERT_TEASER,
        regex: r(
            "разбирали\\s+на\\s+канале|подробности\\s+в\\s+(канале|блоге)|кто\\s+ещё\\s+сталкивался|пишите,?\\s+расскажу|кому\\s+интересно\\s*[-—]?\\s*пиш",
        ),
        score: 2,
    },
    {
        name: "ru_crypto_bait",
        category: SpamCategory.CRYPTO,
        regex: r(
            "трейд(инг|ер)|инвестици[ия]|заработок\\s+на\\s+(крипте|трейдинге)|памп\\s+и\\s+дамп|сигналы\\s+на\\s+(коины|токены)|арбитраж\\s+крипт|крипто\\s?обмен",
        ),
        score: 5,
    },
    {
        name: "ru_multiplier_promise",
        category: SpamCategory.MULTIPLIER_PROMISE,
        regex: r(
            "(удво|увелич).{0,5}(ваш|сво[ей]?)\\s+(депозит|вклад|средства)|\\d{2,4}%\\s+за\\s+(недел|дн|мес|час)|доход(ность)?\\s+от\\s+\\d{2,4}%",
        ),
        score: 5,
    },
    {
        name: "ru_fake_job_offer",
        category: SpamCategory.FAKE_JOB,
        regex: r(
            "удал[её]нн(ая|ую|ой)\\s+работ|работа\\s+без\\s+опыта.{0,15}(в\\s+день|в\\s+неделю)|нужны\\s+(люди|сотрудники)\\s+для\\s+(заработка|подработки)|от\\s+\\d{3,6}\\s*(р|₽|руб)\\.?\\s+в\\s+день|подработка\\s+для\\s+студент",
        ),
        score: 5,
    },
    {
        name: "ru_gambling_bait",
        category: SpamCategory.GAMBLING,
        regex: r(
            "казино|фриспин|бонус\\s+за\\s+регистрац|промокод\\s+на\\s+депозит|1win|1xbet|мостбет|букмекер|ставки\\s+на\\s+спорт.{0,15}(прогноз|выигрыш)",
        ),
        score: 5,
    },
    {
        name: "ru_telegram_gift_phishing",
        category: SpamCategory.TELEGRAM_PHISHING,
        regex: r(
            "telegram\\s*premium\\s+бесплатно|бесплатн(ый|ые)\\s+звезд[ыа]|подтверд(и|ите)\\s+аккаунт|ваш\\s+аккаунт\\s+заблокирован|розыгрыш\\s+(подписки|призов)",
        ),
        score: 5,
    },
    {
        name: "ru_urgency_bait",
        category: SpamCategory.URGENCY,
        regex: r(
            "только\\s+сегодня|осталось\\s+\\d+\\s+мест|успей(те)?\\s+(купить|занять|получить)|количество\\s+ограничено|акция\\s+заканчивается",
        ),
        score: 2,
    },
    {
        name: "ru_mlm_structure",
        category: SpamCategory.MLM_STRUCTURE,
        regex: r(
            "реферальн(ая|ую)\\s+программ|пригласи\\s+друз(ей|ья)\\s+и\\s+получ|команда\\s+единомышленников|финансова[яю]\\s+свобод|network\\s*marketing|млм",
        ),
        score: 5,
    },
    {
        name: "ru_fake_giveaway",
        category: SpamCategory.FAKE_GIVEAWAY,
        regex: r(
            "розыгрыш\\s+(iphone|айфон|техник|денег|призов)|получи(те)?\\s+приз\\s+прямо\\s+сейчас|поздравляем!?\\s*вы\\s+выиграли|активируй(те)?\\s+приз",
        ),
        score: 5,
    },
    {
        name: "ru_delivery_customs_scam",
        category: SpamCategory.DELIVERY_CUSTOMS_SCAM,
        regex: r(
            "посылка\\s+(на\\s+таможне|застряла)|оплатите\\s+(пошлину|растаможку|доставку)\\s+для\\s+получения|ваш\\s+заказ\\s+ожидает\\s+оплаты\\s+пошлины",
        ),
        score: 5,
    },
    {
        name: "ru_bank_phishing",
        category: SpamCategory.BANK_PHISHING,
        regex: r(
            "служба\\s+безопасности\\s+банка|подозрительн(ая|ую)\\s+операц(ия|ию)\\s+по\\s+карте|заблокирован(а|ы)\\s+ваша\\s+карта|подтвердите\\s+данные\\s+карты|госуслуги.{0,15}(заблокирован|подтвердите)",
        ),
        score: 5,
    },
    {
        name: "ru_adult_content",
        category: SpamCategory.ADULT_CONTENT,
        regex: r(
            "интим\\s*услуг|эскорт\\s+услуг|досуг\\s+для\\s+взрослых|знакомств[а]?\\s+для\\s+взрослых.{0,10}(рядом|онлайн)",
        ),
        score: 5,
    },
    {
        name: "ru_fake_documents",
        category: SpamCategory.FAKE_DOCUMENTS,
        regex: r(
            "справк(а|у|и)\\s+без\\s+(анализов|обследования)|диплом\\s+без\\s+(учебы|экзаменов)|документы\\s+любой\\s+сложности|больничный\\s+лист\\s+купить",
        ),
        score: 5,
    },
    {
        name: "ru_real_estate_scam",
        category: SpamCategory.REAL_ESTATE_SCAM,
        regex: r(
            "продам\\s+квартиру\\s+срочно.{0,15}(дешево|ниже\\s+рынка)|сдам\\s+без\\s+залога.{0,10}(звоните|пишите)\\s+сразу|уступлю\\s+ипотеку",
        ),
        score: 3,
    },
    {
        name: "ru_courier_recruitment",
        category: SpamCategory.COURIER_RECRUITMENT,
        regex: r(
            "требуются\\s+курьеры.{0,20}(без\\s+опыта|высокий\\s+доход)|нужен\\s+курьер\\s+для\\s+закладок|работа\\s+курьером.{0,10}от\\s+\\d{3,5}\\s*(р|₽|руб)",
        ),
        score: 5,
    },
    {
        name: "ru_fake_investment_platform",
        category: SpamCategory.FAKE_INVESTMENT_PLATFORM,
        regex: r(
            "гарантированн(ая|ую)\\s+доходность|инвестиционн(ая|ую)\\s+платформ(а|у)\\s+с\\s+выводом|хайп[- ]?проект|заходи,?\\s+пока\\s+не\\s+закрыли\\s+набор",
        ),
        score: 5,
    },
    {
        name: "ru_organ_sale",
        category: SpamCategory.ADULT_CONTENT,
        // Продажа органов — известная спам/скам-схема ("продам почку", "сдаю
        // почку за деньги"). Однозначный сигнал, score 5.
        regex: r(
            "прода?м\\s+(почку|почки|орган[ыа]|печень|сердце|легкое)|сда(м|ю|мся)\\s+(почку|почки|орган[ыа])|прода?м\\s+ребенка|прода?м\\s+младенц",
        ),
        score: 5,
    },
];

/* ------------------------------------------------------------------ *
 *  EN pack — scaffold for the future. Same categories, less tuned,
 *  since there's no EN chat traffic to calibrate against yet. Treat
 *  these as a starting point, not production-hardened.
 * ------------------------------------------------------------------ */

const EN_PATTERNS: SpamPattern[] = [
    {
        name: "en_passive_income",
        category: SpamCategory.PASSIVE_INCOME,
        regex: r(
            "passive\\s+income|make\\s+money\\s+(from|while)\\s+(home|you\\s+sleep)|financial\\s+freedom",
        ),
        score: 4,
    },
    {
        name: "en_write_in_dm",
        category: SpamCategory.DM_REDIRECT,
        regex: r(
            "dm\\s+me\\s+for\\s+(details|info)|message\\s+me\\s+privately|drop\\s+me\\s+a\\s+dm",
        ),
        score: 3,
    },
    {
        name: "en_crypto_bait",
        category: SpamCategory.CRYPTO,
        regex: r(
            "crypto\\s+(signals|trading)|guaranteed\\s+(profit|returns)|pump\\s+and\\s+dump|forex\\s+signals",
        ),
        score: 3,
    },
    {
        name: "en_multiplier_promise",
        category: SpamCategory.MULTIPLIER_PROMISE,
        regex: r(
            "double\\s+your\\s+(deposit|investment|money)|\\d{2,4}%\\s+(return|profit)\\s+in\\s+(a\\s+)?(week|day|month)",
        ),
        score: 4,
    },
    {
        name: "en_fake_job_offer",
        category: SpamCategory.FAKE_JOB,
        regex: r(
            "work\\s+from\\s+home.{0,15}no\\s+experience|earn\\s+\\$\\d+\\s+(a|per)\\s+day|hiring\\s+now.{0,10}remote\\s+job",
        ),
        score: 4,
    },
    {
        name: "en_gambling_bait",
        category: SpamCategory.GAMBLING,
        regex: r(
            "free\\s+spins|casino\\s+bonus|deposit\\s+bonus\\s+code|bet\\s+now\\s+and\\s+win",
        ),
        score: 4,
    },
    {
        name: "en_telegram_gift_phishing",
        category: SpamCategory.TELEGRAM_PHISHING,
        regex: r(
            "free\\s+telegram\\s+premium|your\\s+account\\s+(has\\s+been\\s+)?(suspended|blocked)|verify\\s+your\\s+account\\s+now|claim\\s+your\\s+(prize|gift)",
        ),
        score: 4,
    },
    {
        name: "en_urgency_bait",
        category: SpamCategory.URGENCY,
        regex: r(
            "only\\s+today|limited\\s+spots\\s+left|act\\s+now|offer\\s+ends\\s+soon",
        ),
        score: 2,
    },
    {
        name: "en_mlm_structure",
        category: SpamCategory.MLM_STRUCTURE,
        regex: r(
            "referral\\s+program|invite\\s+friends\\s+and\\s+earn|be\\s+your\\s+own\\s+boss|network\\s+marketing",
        ),
        score: 3,
    },
];

/* ------------------------------------------------------------------ *
 *  Language-agnostic signals — fire regardless of detected script.
 * ------------------------------------------------------------------ */

const ANY_LANG_PATTERNS: SpamPattern[] = [
    {
        name: "any_known_scam_brand",
        category: SpamCategory.GAMBLING,
        regex: r("1win|1xbet|melbet|mostbet|pin-?up\\b", "i"),
        score: 3,
    },
    {
        name: "any_phone_number_bait",
        category: SpamCategory.DM_REDIRECT,
        // international-looking phone number; combine with other signals at the
        // pipeline level rather than treating this alone as high-confidence.
        regex: r("\\+?\\d[\\d\\s\\-()]{8,}\\d"),
        score: 1,
    },
];

/* ------------------------------------------------------------------ *
 *  Language packs registry
 * ------------------------------------------------------------------ */

export const LANGUAGE_PACKS = {
    ru: RU_PATTERNS,
    en: EN_PATTERNS,
} as const;

/* ------------------------------------------------------------------ *
 *  URLs
 * ------------------------------------------------------------------ */

export const URL_REGEX = r(
    "(https?://[\\w\\-.]+(:\\d+)?(/[^\\s]*)?)|(t\\.me/[\\w/]+)|(www\\.[\\w\\-.]+(/[^\\s]*)?)",
);
export const TME_LINK_REGEX = r("t\\.me/[\\w/]+");

export const HIGH_RISK_DOMAINS = new Set([
    "t.me",
    "bit.ly",
    "clck.ru",
    "cutt.ly",
    "tinyurl.com",
    "vk.cc",
]);

/* ------------------------------------------------------------------ *
 *  Scoring
 * ------------------------------------------------------------------ */

export function scoreSpam(text: string): {
    score: number;
    matched: string[];
    normalized: string;
    packsUsed: string[];
} {
    const normalized = normalizeSpamText(text);
    const packs = selectLanguagePacks(text);
    const patterns: SpamPattern[] = [
        ...packs.flatMap((p) => LANGUAGE_PACKS[p]),
        ...ANY_LANG_PATTERNS,
    ];

    let score = 0;
    const matched: string[] = [];

    for (const p of patterns) {
        if (p.regex.test(normalized)) {
            score += p.score;
            matched.push(p.name);
        }
    }

    const urls = extractUrls(text);
    if (matched.length > 0 && urls.length > 0) {
        const hasHighRiskDomain = urls.some((u) => {
            const d = domainOf(u);
            return d !== null && HIGH_RISK_DOMAINS.has(d);
        });
        score += hasHighRiskDomain ? 3 : 1;
        matched.push(
            hasHighRiskDomain ? "bait_plus_high_risk_link" : "bait_plus_link",
        );
    }

    return { score, matched, normalized, packsUsed: packs };
}

export function extractUrls(text: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    URL_REGEX.lastIndex = 0;
    while ((m = URL_REGEX.exec(text)) !== null) {
        out.push(m[0]);
        URL_REGEX.lastIndex = m.index + m[0].length;
    }
    return out;
}

export function domainOf(rawUrl: string): string | null {
    let s = rawUrl.trim().toLowerCase();
    s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (s.startsWith("t.me/")) return "t.me";
    const slash = s.indexOf("/");
    if (slash >= 0) s = s.slice(0, slash);
    const colon = s.indexOf(":");
    if (colon >= 0) s = s.slice(0, colon);
    return s || null;
}

export type ModerationAction = "allow" | "flag" | "delete";

export function moderateText(
    text: string,
    thresholds: { flag: number; delete: number } = { flag: 4, delete: 7 },
): { action: ModerationAction; score: number; matched: string[] } {
    const { score, matched } = scoreSpam(text);
    const action: ModerationAction =
        score >= thresholds.delete
            ? "delete"
            : score >= thresholds.flag
              ? "flag"
              : "allow";
    return { action, score, matched };
}
