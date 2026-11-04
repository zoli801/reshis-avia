import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").unique(), name: text("name").notNull(),
  role: text("role").notNull().default("analyst"), telegramId: integer("telegram_id").unique(),
  chatId: integer("chat_id"), openaiId: text("openai_id").unique(), createdAt: integer("created_at").notNull(),
});
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}),
  expiresAt: integer("expires_at").notNull(), createdAt: integer("created_at").notNull(),
  authProvider: text("auth_provider").notNull().default("guest"),
  credentialVersion: text("credential_version"),
}, table=>[index("sessions_expiry").on(table.expiresAt)]);
export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(), filename: text("filename").notNull(), importedAt: integer("imported_at").notNull(),
  active: integer("active").notNull().default(1), sha256: text("sha256").notNull(), rowsJson: text("rows_json").notNull(),
  routesJson: text("routes_json").notNull(), warningsJson: text("warnings_json").notNull().default("[]"),
  rawKey: text("raw_key"), routesRawKey: text("routes_raw_key"),
},table=>[index("datasets_active").on(table.active,table.importedAt)]);
export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(()=>users.id), title: text("title").notNull(),
  note: text("note").notNull().default(""), route: text("route").notNull(), date: text("date").notNull(), price: real("price").notNull(),
  status: text("status").notNull().default("draft"), datasetId: text("dataset_id").notNull().references(()=>datasets.id),
  resultJson: text("result_json").notNull(), alternativesJson: text("alternatives_json").notNull().default("[]"), historyJson: text("history_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
},table=>[index("scenarios_owner").on(table.ownerId,table.createdAt),index("scenarios_status").on(table.status)]);
export const notificationPreferences = sqliteTable("notification_preferences", {
  userId: text("user_id").primaryKey().references(()=>users.id,{onDelete:"cascade"}), settingsJson: text("settings_json").notNull(), lastDigestDate: text("last_digest_date"),
});
export const linkCodes = sqliteTable("telegram_link_codes", {
  codeHash: text("code_hash").primaryKey(), userId: text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}), expiresAt: integer("expires_at").notNull(),
});
export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(()=>users.id), chatId: integer("chat_id").notNull(), text: text("text").notNull(),
  scenarioId: text("scenario_id"), kind: text("kind").notNull().default("change"), createdAt: integer("created_at").notNull(), sentAt: integer("sent_at"),
  claimedUntil: integer("claimed_until").notNull().default(0), attempts: integer("attempts").notNull().default(0), lastError: text("last_error"),
},table=>[index("deliveries_pending").on(table.sentAt,table.createdAt)]);
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), userId: text("user_id"), action: text("action").notNull(), detailsJson: text("details_json").notNull().default("{}"), createdAt: integer("created_at").notNull(),
});
export const botStates = sqliteTable("bot_states", {
  telegramId: integer("telegram_id").primaryKey(), state: text("state").notNull(), data: text("data").notNull().default("{}"), updatedAt: integer("updated_at").notNull(),
});
export const telegramUpdates = sqliteTable("telegram_updates", {
  updateId: integer("update_id").primaryKey(), createdAt: integer("created_at").notNull(), status: text("status").notNull().default("processing"),
  leaseUntil: integer("lease_until").notNull().default(0), attempts: integer("attempts").notNull().default(0),
});
export const authAccounts = sqliteTable("auth_accounts", {
  userId: text("user_id").primaryKey().references(()=>users.id,{onDelete:"cascade"}),
  username: text("username").notNull().unique(), passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(), attempts: integer("attempts").notNull(), expiresAt: integer("expires_at").notNull(),
},table=>[index("auth_rate_limits_expiry").on(table.expiresAt)]);
export const telegramLoginChallenges = sqliteTable("telegram_login_challenges", {
  codeHash: text("code_hash").primaryKey(), browserHash: text("browser_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(), createdAt: integer("created_at").notNull(),
  telegramId: integer("telegram_id"), confirmedAt: integer("confirmed_at"), cancelledAt: integer("cancelled_at"), consumedAt: integer("consumed_at"),
  verificationCode: text("verification_code").notNull(),
},table=>[index("telegram_login_challenges_expiry").on(table.expiresAt)]);
