CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`category` text NOT NULL,
	`category_score` integer,
	`model` text NOT NULL,
	`diagnosis` text NOT NULL,
	`fixes` text NOT NULL,
	`sources` text NOT NULL,
	`cost_usd` real,
	`turns` integer,
	`warnings` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_run_category_uq` ON `analyses` (`run_id`,`category`);