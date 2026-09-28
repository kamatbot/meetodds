-- The built-in llama.cpp summary model was removed. A saved choice of it moves to
-- on-device Apple Intelligence; API keys and other columns are untouched.
UPDATE settings SET provider = 'apple-intelligence', model = 'system'
WHERE provider IN ('builtin-ai', 'local-llama', 'localllama');
