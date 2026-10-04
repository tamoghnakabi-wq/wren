-- Local development only: production creates `wren_api` out of band from a
-- SCRAM verifier, so this block is a no-op there.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wren_api') then
    create role wren_api with login password 'wren-local-dev' noinherit;
  end if;
end $$;
