CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cadence` text NOT NULL,
	`time` text NOT NULL,
	`urls` text,
	`crawl_spec` text,
	`options` text NOT NULL,
	`concurrency` integer NOT NULL,
	`device` text NOT NULL,
	`accuracy_mode` integer DEFAULT false NOT NULL,
	`last_fired_at` text,
	`last_batch_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `batches` ADD `schedule_id` text;