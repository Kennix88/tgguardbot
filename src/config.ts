import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const stringToNumber = z.coerce.number().int().positive();
const commaSeparatedNumbers = z
    .string()
    .transform((s) =>
        s
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map((x) => Number(x)),
    )
    .pipe(z.array(z.number().int()).min(1));

const schema = z.object({
    BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),

    SUPER_ADMIN_IDS: commaSeparatedNumbers,

    FREE_TIER_MAX_USERS: stringToNumber.default(300),
    FREE_TIER_MAX_MSGS_PER_HOUR: stringToNumber.default(500),

    LLM_ENABLED: z.coerce.boolean().default(false),
    LLM_PROVIDER: z.string().optional().default(""),
    LLM_API_KEY: z.string().optional().default(""),

    LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("info"),
    LOG_PRETTY: z.coerce.boolean().default(false),

    CAPTCHA_MAX_ATTEMPTS: stringToNumber.default(3),
    CAPTCHA_TIMEOUT_SEC: stringToNumber.default(60),
    CAS_CHECK_ENABLED: z.coerce.boolean().default(true),

    // Optional Telegram API root (mirror/proxy). When set, all bot API calls
    // go through this URL instead of https://api.telegram.org.
    GRASPIL_PROXY_URL: z.string().optional().default(""),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("❌ Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
        // eslint-disable-next-line no-console
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
}

export const config = parsed.data;

export type AppConfig = typeof config;
