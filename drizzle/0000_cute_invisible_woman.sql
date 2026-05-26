CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`options` text NOT NULL,
	`concurrency` integer NOT NULL,
	`total` integer NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`idx` integer NOT NULL,
	`url` text NOT NULL,
	`final_url` text,
	`status` text NOT NULL,
	`error_message` text,
	`form_factor` text NOT NULL,
	`throttling` text,
	`runs` integer,
	`lighthouse_version` text,
	`score_performance` integer,
	`score_accessibility` integer,
	`score_best_practices` integer,
	`score_seo` integer,
	`options` text NOT NULL,
	`metrics` text,
	`report_json` text,
	`report_html` text,
	`fetch_time` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
