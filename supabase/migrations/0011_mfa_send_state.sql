-- Email-code sends no longer hold a database transaction while Supabase Auth sends the email
-- (re-audit of 0.1.12, W-111). A send reserves its request first (not usable yet), calls Supabase
-- without a database connection, then marks the request delivered (or failed). Verification only
-- accepts delivered requests.
--
-- Existing rows were all delivered or already unusable (the earlier code committed a request only
-- after its email went out), hence the default for them; new requests are inserted with null.
alter table public.mfa_email_requests add column if not exists delivered_at timestamptz default now();
