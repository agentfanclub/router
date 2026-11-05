-- Keep earlier router sessions grouped with new requests using the ses_ prefix.
-- OpenCode session IDs are already prefixed and remain unchanged.
UPDATE usage_log
SET session_id = 'ses_' || session_id
WHERE length(session_id) = 16 AND session_id NOT GLOB '*[^0-9a-f]*';
