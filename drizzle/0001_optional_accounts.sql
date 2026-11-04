ALTER TABLE `sessions` ADD `auth_provider` text DEFAULT 'guest' NOT NULL;
--> statement-breakpoint
CREATE TABLE `auth_accounts` (
  `user_id` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_username_unique` ON `auth_accounts` (`username`);
--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `attempts` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_expiry` ON `auth_rate_limits` (`expires_at`);
