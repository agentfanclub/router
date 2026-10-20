ALTER TABLE `user` ADD `role` text DEFAULT 'user' NOT NULL CONSTRAINT `user_role_check` CHECK (`role` in ('admin', 'user'));
