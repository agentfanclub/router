-- The club's Lumen upstream is now named "lumen".
UPDATE usage_log SET upstream = 'lumen' WHERE upstream = 'club-lumen';
