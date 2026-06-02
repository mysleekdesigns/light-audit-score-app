ALTER TABLE `batches` ADD `source` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `source` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `field` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `source` text DEFAULT 'local' NOT NULL;