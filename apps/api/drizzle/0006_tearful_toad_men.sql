CREATE TABLE `usage_limit` (
	`user_id` text PRIMARY KEY NOT NULL,
	`five_hour_micro` integer,
	`weekly_micro` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`api_key_id` text,
	`session_id` text,
	`model` text NOT NULL,
	`upstream` text NOT NULL,
	`billed` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`cost_micro` integer NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_log_user_created_idx` ON `usage_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_log_session_idx` ON `usage_log` (`session_id`);--> statement-breakpoint
CREATE INDEX `usage_log_created_idx` ON `usage_log` (`created_at`);