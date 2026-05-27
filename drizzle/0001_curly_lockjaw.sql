ALTER TABLE `runs` ADD `benchmark_index` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `host_user_agent` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `throttling_method` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `cpu_slowdown_multiplier` real;