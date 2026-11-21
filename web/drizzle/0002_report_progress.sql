ALTER TABLE `reports` ADD `attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `duration_ms` integer;