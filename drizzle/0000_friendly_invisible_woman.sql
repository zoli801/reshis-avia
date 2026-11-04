CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_states` (
	`telegram_id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`imported_at` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sha256` text NOT NULL,
	`rows_json` text NOT NULL,
	`routes_json` text NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`raw_key` text,
	`routes_raw_key` text
);
--> statement-breakpoint
CREATE INDEX `datasets_active` ON `datasets` (`active`,`imported_at`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`text` text NOT NULL,
	`scenario_id` text,
	`kind` text DEFAULT 'change' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`claimed_until` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_pending` ON `deliveries` (`sent_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `telegram_link_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL,
	`last_digest_date` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`route` text NOT NULL,
	`date` text NOT NULL,
	`price` real NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`dataset_id` text NOT NULL,
	`result_json` text NOT NULL,
	`alternatives_json` text DEFAULT '[]' NOT NULL,
	`history_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scenarios_owner` ON `scenarios` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scenarios_status` ON `scenarios` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `telegram_updates` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`name` text NOT NULL,
	`role` text DEFAULT 'analyst' NOT NULL,
	`telegram_id` integer,
	`chat_id` integer,
	`openai_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_id_unique` ON `users` (`telegram_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_openai_id_unique` ON `users` (`openai_id`);