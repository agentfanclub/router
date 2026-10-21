CREATE TABLE `device_authorization` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`next_poll_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorization_user_code_unique` ON `device_authorization` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_authorization_expires_at_idx` ON `device_authorization` (`expires_at`);