-- Trigger functions are called by their triggers only. Postgres gives EXECUTE on new functions to
-- PUBLIC, which put these three on the API (`/rest/v1/rpc/…`) for anyone, signed in or not. Postgres
-- refuses to run a trigger function outside a trigger, so that did nothing, but nothing else should
-- be able to call them (Supabase's security advisor flags the two security-definer ones). EXECUTE is
-- checked when a trigger is created, not when it fires, so the triggers keep working, as
-- `wren_check_password_change` and `wren_drop_lone_recovery_codes` (0010) already do without it.

revoke all on function public.wren_handle_new_user() from public, anon, authenticated;
revoke all on function public.wren_sync_user_email() from public, anon, authenticated;
revoke all on function public.wren_touch() from public, anon, authenticated;
