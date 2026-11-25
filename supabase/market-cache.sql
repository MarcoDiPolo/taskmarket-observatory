-- Replace __PROJECT_REF__ below with the dedicated Supabase project's public reference.
-- Run as postgres, then deploy the public market-cache function with JWT verification off.
-- To seed immediately after deployment: select market_private.dispatch();
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists market_private;
revoke all on schema market_private from public, anon, authenticated, service_role;
grant usage on schema market_private to service_role;

create table if not exists market_private.cache (
  singleton boolean primary key default true check (singleton),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  payload jsonb,
  revision uuid,
  published_at timestamptz,
  pending_ticket uuid,
  pending_until timestamptz,
  lease_ticket uuid,
  lease_until timestamptz,
  last_started timestamptz
);
alter table market_private.cache enable row level security;
revoke all on market_private.cache from public, anon, authenticated, service_role;
grant select, update on market_private.cache to service_role;
insert into market_private.cache (singleton, project_ref) values (true, '__PROJECT_REF__')
on conflict (singleton) do update set project_ref = excluded.project_ref;

-- The standard API exposes only these RPCs to service_role. The browser calls the Edge Function.
create or replace function public.market_cache_read(p_known uuid[], p_metadata_only boolean)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'revision', revision, 'published_at', published_at,
    'payload', case when p_metadata_only or revision = any(p_known) then null else payload end
  )
  from market_private.cache where singleton and revision is not null;
$$;

-- The ticket was minted by the database, expires in two minutes and can only be exchanged once.
create or replace function public.market_cache_acquire(p_ticket uuid)
returns boolean language sql volatile security invoker set search_path = '' as $$
  with acquired as (
    update market_private.cache
    set pending_ticket = null, pending_until = null, lease_ticket = p_ticket,
        lease_until = now() + interval '4 minutes', last_started = now()
    where singleton and pending_ticket = p_ticket and pending_until > now()
      and (lease_until is null or lease_until <= now())
    returning 1
  ) select exists(select 1 from acquired);
$$;

-- Publish the whole result in one write. A failed/expired worker cannot replace a good snapshot.
create or replace function public.market_cache_finish(p_ticket uuid, p_payload jsonb)
returns boolean language sql volatile security invoker set search_path = '' as $$
  with finished as (
    update market_private.cache
    set payload = coalesce(p_payload, payload),
        revision = case when p_payload is null then revision else gen_random_uuid() end,
        published_at = case when p_payload is null then published_at else now() end,
        lease_ticket = null, lease_until = null
    where singleton and lease_ticket = p_ticket and lease_until > now()
      and (p_payload is null or (
        jsonb_typeof(p_payload->'asOf') = 'string'
        and jsonb_typeof(p_payload#>'{chains,tempo}') = 'object'
        and jsonb_typeof(p_payload#>'{chains,base}') = 'object'
      ))
    returning 1
  ) select exists(select 1 from finished);
$$;

revoke all on function public.market_cache_read(uuid[], boolean),
  public.market_cache_acquire(uuid), public.market_cache_finish(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.market_cache_read(uuid[], boolean),
  public.market_cache_acquire(uuid), public.market_cache_finish(uuid, jsonb) to service_role;

-- Only the database owner and its cron job can mint a ticket. The only possible destination
-- is this project's fixed function. pg_net starts its HTTP request after the transaction commits.
create or replace function market_private.dispatch()
returns bigint language plpgsql volatile security invoker set search_path = '' as $$
declare
  ticket uuid := gen_random_uuid();
  ref text;
  request_id bigint;
begin
  update market_private.cache
  set pending_ticket = ticket, pending_until = now() + interval '2 minutes'
  where singleton and (pending_until is null or pending_until <= now())
    and (lease_until is null or lease_until <= now())
    and (last_started is null or last_started <= now() - interval '25 minutes')
  returning project_ref into ref;
  if ref is null then return null; end if;

  select net.http_post(
    url := 'https://' || ref || '.supabase.co/functions/v1/market-cache',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-market-refresh-token', ticket::text),
    timeout_milliseconds := 145000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function market_private.dispatch() from public, anon, authenticated, service_role;

-- Check every five minutes. The 25-minute guard above bounds actual collection after a start.
select cron.schedule('market-cache-refresh', '*/5 * * * *', 'select market_private.dispatch()');
notify pgrst, 'reload schema';
commit;
