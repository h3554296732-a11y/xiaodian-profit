-- A short durable lease covers Auth's automatic retries, whose webhook IDs
-- change while the signed body stays identical. It is not a five-minute replay
-- ledger: a normal resend may acquire another lease after 45 seconds.
begin;

create schema auth_sms_private;
revoke all on schema auth_sms_private from public, anon, authenticated;
grant usage on schema auth_sms_private to service_role;

create table auth_sms_private.sms_deliveries (
  digest text primary key check (digest ~ '^[0-9a-f]{64}$'),
  claim_id uuid not null,
  state text not null check (state in ('pending', 'sent', 'unknown')),
  lease_until timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index sms_deliveries_expiry_idx
  on auth_sms_private.sms_deliveries (lease_until, digest);
alter table auth_sms_private.sms_deliveries enable row level security;
create policy sms_delivery_service_only on auth_sms_private.sms_deliveries
  for all to service_role using (true) with check (true);
revoke all on auth_sms_private.sms_deliveries from public, anon, authenticated, service_role;
grant select, insert, update, delete on auth_sms_private.sms_deliveries to service_role;

create function public.claim_auth_sms(p_digest text, p_claim_id uuid)
returns text language plpgsql security invoker
set search_path = ''
-- PostgREST hoists statement_timeout before its RPC statement. lock_timeout
-- also bounds waits inside the function; aborting fetch alone cannot cancel SQL.
set statement_timeout = '450ms'
set lock_timeout = '100ms'
as $$
declare
  acquired uuid;
  delivery_state text;
  cleanup_before timestamptz := clock_timestamp() - interval '1 hour';
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_claim_id is null then
    raise exception using errcode = '22023', message = 'Invalid SMS delivery identity';
  end if;

  -- Indexed, bounded cleanup avoids scanning or locking all past deliveries.
  delete from auth_sms_private.sms_deliveries
  where digest in (
    select digest from auth_sms_private.sms_deliveries
    where lease_until < cleanup_before
    order by lease_until, digest limit 100 for update skip locked
  );

  insert into auth_sms_private.sms_deliveries as delivery
    (digest, claim_id, state, lease_until, updated_at)
  values (p_digest, p_claim_id, 'pending', clock_timestamp() + interval '45 seconds', clock_timestamp())
  on conflict (digest) do update
    set claim_id = excluded.claim_id, state = 'pending',
      -- Compute after the conflict lock, not from the pre-wait EXCLUDED tuple.
      lease_until = clock_timestamp() + interval '45 seconds', updated_at = clock_timestamp()
    where delivery.lease_until <= clock_timestamp()
  returning claim_id into acquired;

  if found then return 'claimed'; end if;
  -- A separate statement sees the winning transaction after conflict waiting;
  -- a same-statement CTE could retain a snapshot from before that commit.
  select state into delivery_state from auth_sms_private.sms_deliveries
    where digest = p_digest and lease_until > clock_timestamp();
  if delivery_state = 'sent' then return 'sent'; end if;
  return 'blocked';
end;
$$;

create function public.finish_auth_sms(p_digest text, p_claim_id uuid, p_sent boolean)
returns boolean language plpgsql security invoker
set search_path = ''
set statement_timeout = '450ms'
set lock_timeout = '100ms'
as $$
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_claim_id is null or p_sent is null then
    raise exception using errcode = '22023', message = 'Invalid SMS delivery identity';
  end if;
  -- A former or expired owner cannot overwrite the result of a newer lease.
  update auth_sms_private.sms_deliveries
    set state = case when p_sent then 'sent' else 'unknown' end,
      updated_at = clock_timestamp()
    where digest = p_digest and claim_id = p_claim_id
      and state = 'pending' and lease_until > clock_timestamp();
  return found;
end;
$$;

revoke all on function public.claim_auth_sms(text,uuid), public.finish_auth_sms(text,uuid,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_auth_sms(text,uuid), public.finish_auth_sms(text,uuid,boolean)
  to service_role;

commit;
