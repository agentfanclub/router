CREATE TABLE `usage_daily` (
	`day` text NOT NULL,
	`user_id` text NOT NULL,
	`requests` integer NOT NULL,
	`sessions` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_tokens` integer NOT NULL,
	`club_charge_micro` integer NOT NULL,
	`personal_charge_micro` integer NOT NULL,
	`cost_micro` integer NOT NULL,
	`models` text NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `usage_total` (
	`user_id` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer NOT NULL,
	`sessions` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_tokens` integer NOT NULL,
	`club_charge_micro` integer NOT NULL,
	`personal_charge_micro` integer NOT NULL,
	`cost_micro` integer NOT NULL,
	PRIMARY KEY(`user_id`, `model`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `usage_log` ADD `charge_micro` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Until now one price served both sides, and the user's own key cost the club nothing.
UPDATE `usage_log` SET `charge_micro` = `cost_micro`, `cost_micro` = CASE WHEN `billed` = 'personal' THEN 0 ELSE `cost_micro` END;--> statement-breakpoint
-- Backfill lifetime totals. A session counts on its first request, as live writes do.
INSERT INTO `usage_total` (user_id, model, requests, sessions, input_tokens, output_tokens, cached_tokens, club_charge_micro, personal_charge_micro, cost_micro)
SELECT user_id, model, COUNT(*), SUM(first_of_session),
	COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cached_tokens), 0),
	SUM(CASE WHEN billed = 'club' THEN charge_micro ELSE 0 END),
	SUM(CASE WHEN billed = 'personal' THEN charge_micro ELSE 0 END),
	SUM(cost_micro)
FROM (
	SELECT *, CASE WHEN session_id IS NOT NULL AND ROW_NUMBER() OVER (PARTITION BY user_id, session_id ORDER BY created_at, id) = 1 THEN 1 ELSE 0 END AS first_of_session
	FROM usage_log
)
GROUP BY user_id, model;
