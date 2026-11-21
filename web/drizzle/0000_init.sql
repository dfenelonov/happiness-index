CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`anon_id` text,
	`session_id` text,
	`price_variant` integer,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`utm_content` text,
	`utm_term` text,
	`referrer` text,
	`props` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_name_idx` ON `events` (`name`);--> statement-breakpoint
CREATE INDEX `events_anon_idx` ON `events` (`anon_id`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`consent` integer NOT NULL,
	`source` text NOT NULL,
	`anon_id` text,
	`result_id` text,
	`price_variant` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`result_id` text NOT NULL,
	`anon_id` text,
	`session_id` text,
	`price_variant` integer NOT NULL,
	`amount_rub` integer NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text NOT NULL,
	`provider_payment_id` text,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`utm_content` text,
	`utm_term` text,
	`referrer` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`paid_at` text,
	CONSTRAINT "orders_status_check" CHECK("orders"."status" in ('pending', 'paid', 'failed')),
	CONSTRAINT "orders_amount_check" CHECK("orders"."amount_rub" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_payment_uidx` ON `orders` (`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `orders_result_idx` ON `orders` (`result_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`order_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text,
	`is_fallback` integer DEFAULT false NOT NULL,
	`content` text,
	`emailed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text,
	CONSTRAINT "reports_status_check" CHECK("reports"."status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `results` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text,
	`anon_id` text,
	`index_score` integer NOT NULL,
	`level` text NOT NULL,
	`axes` text NOT NULL,
	`archetype` text NOT NULL,
	`zones` text NOT NULL,
	`leaks` text NOT NULL,
	`direct_answer` text NOT NULL,
	`is_seed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `results_seed_idx` ON `results` (`is_seed`);--> statement-breakpoint
CREATE TABLE `tests` (
	`id` text PRIMARY KEY NOT NULL,
	`anon_id` text NOT NULL,
	`session_id` text,
	`answers` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	`result_id` text
);
--> statement-breakpoint
CREATE INDEX `tests_anon_idx` ON `tests` (`anon_id`);