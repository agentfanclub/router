-- usage_daily was empty: the rollup had not yet run.
DROP TABLE `usage_daily`;--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer NOT NULL,
	`sessions` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_tokens` integer NOT NULL,
	`club_charge_micro` integer NOT NULL,
	`personal_charge_micro` integer NOT NULL,
	`cost_micro` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `model`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_daily_day_idx` ON `usage_daily` (`day`);