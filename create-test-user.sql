-- Create test user and API key for BatchSender

-- First, create a test user
INSERT INTO users (id, email, username, password_hash, created_at, updated_at)
VALUES (
  'test-user-123',
  'test@example.com',
  'testuser',
  '$2a$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNu/1u', -- password: 'test123'
  NOW(),
  NOW()
) ON CONFLICT (email) DO NOTHING;

-- Create an API key for the test user
INSERT INTO api_keys (id, user_id, name, key_hash, created_at)
VALUES (
  'test-key-123',
  'test-user-123',
  'Test API Key',
  '$2a$10$rBi7b2JzI6wSQiVoM7Zte.kuXIMmRbQAZZ4v5X1NfqZ7kfCiMG1Ey', -- hashed 'test-api-key-123'
  NOW()
) ON CONFLICT DO NOTHING;

-- Show the created data
SELECT u.email, u.username, ak.name as api_key_name, 'test-api-key-123' as api_key_plain
FROM users u
JOIN api_keys ak ON u.id = ak.user_id
WHERE u.email = 'test@example.com';