-- Example: create a First Access invite
-- Run: psql $DATABASE_URL -f scripts/create_invite.sql

INSERT INTO first_access_invites (token, full_name, access_starts_at, access_ends_at)
VALUES (
  'demo-token-abc123',
  'Иван Иванов',
  now() - interval '1 day',
  now() + interval '7 days'
);

-- List invites: SELECT id, token, full_name, access_ends_at FROM first_access_invites;
