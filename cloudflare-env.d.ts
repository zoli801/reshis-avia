declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    BOT_TOKEN?: string;
    BOT_ID?: string;
    BOT_USERNAME?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    PUBLIC_URL?: string;
    WEBAPP_URL?: string;
    BOT_INTERNAL_SECRET?: string;
    ADMIN_EMAIL?: string;
    ADMIN_SETUP_SECRET?: string;
    SITE_OWNER_EMAIL?: string;
    PRIVATE_OWNER_BOOTSTRAP?: string;
    TELEGRAM_AUTH_TTL_SECONDS?: string;
  }
}
