CREATE TABLE `schedule_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`prior_batch_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`form_factor` text NOT NULL,
	`category` text NOT NULL,
	`previous` integer NOT NULL,
	`current` integer NOT NULL,
	`delta` integer NOT NULL,
	`threshold` integer,
	`delivered` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedule_alerts_schedule_created_idx` ON `schedule_alerts` (`schedule_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `schedules` ADD `notify` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `alerts_evaluated_batch_id` text;