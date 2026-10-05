UPDATE repositories
SET verification_commands = '[]'::jsonb,
    updated_at = now()
WHERE jsonb_typeof(verification_commands) <> 'array';
