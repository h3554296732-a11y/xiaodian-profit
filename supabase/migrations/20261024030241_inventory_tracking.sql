-- Additive only: historical sales/items stay untouched and do not affect stock.
begin;

create table public.inventory_counts (
  id uuid primary key,
  shop_id uuid not null references public.shops(id) on delete restrict,
  product_id uuid not null,
  initial_quantity integer not null check (initial_quantity between 0 and 100000),
  initialized_at timestamptz not null default clock_timestamp(),
  request_id uuid not null,
  expected_quantity bigint check (expected_quantity between 0 and 1000000000000),
  unique (shop_id, request_id),
  foreign key (shop_id, product_id) references public.products(shop_id,id) on delete restrict,
  check (id = request_id)
);
create index inventory_counts_shop_product_idx on public.inventory_counts(shop_id,product_id,initialized_at desc,id desc);
create table public.inventory_receipts (
  id uuid primary key,
  shop_id uuid not null references public.shops(id) on delete restrict,
  product_id uuid not null,
  business_date date not null,
  quantity integer not null check (quantity between 1 and 100000),
  unit_cost_mills bigint not null check (unit_cost_mills between 0 and 1000000000),
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (shop_id, product_id) references public.products(shop_id, id) on delete restrict
);
create index inventory_receipts_shop_product_idx on public.inventory_receipts(shop_id, product_id);
alter table public.sales add column occurred_at timestamptz;
alter table public.sales add column inventory_recorded_at timestamptz;
alter table public.sale_items add column inventory_quantity integer not null default 0 check (inventory_quantity between 0 and 100000);

alter table public.inventory_counts enable row level security;
alter table public.inventory_receipts enable row level security;
create policy inventory_counts_select on public.inventory_counts for select to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy inventory_counts_insert on public.inventory_counts for insert to authenticated with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy inventory_receipts_select on public.inventory_receipts for select to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy inventory_receipts_insert on public.inventory_receipts for insert to authenticated with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
revoke all on public.inventory_counts, public.inventory_receipts from public, anon, authenticated;
grant select, insert on public.inventory_counts, public.inventory_receipts to authenticated;

-- The balance is calculated in PostgreSQL, never accepted from a browser.
-- An absent row means unknown stock, not zero stock.
create view public.inventory_levels with (security_invoker = true) as
select b.product_id as id,b.shop_id,b.product_id,
  (select min(c.initialized_at) from public.inventory_counts c where c.shop_id=b.shop_id and c.product_id=b.product_id) as initialized_at,
  b.initialized_at as counted_at,
  (b.initial_quantity::bigint
   + coalesce((select sum(r.quantity) from public.inventory_receipts r where r.shop_id=b.shop_id and r.product_id=b.product_id and r.created_at > b.initialized_at),0)
   - coalesce((select sum(i.inventory_quantity) from public.sale_items i join public.sales s on s.id=i.sale_id and s.shop_id=i.shop_id where i.shop_id=b.shop_id and i.product_id=b.product_id and s.voided_at is null and s.inventory_recorded_at >= b.initialized_at and s.occurred_at >= b.initialized_at),0))::bigint as quantity
from (select distinct on(shop_id,product_id) * from public.inventory_counts order by shop_id,product_id,initialized_at desc,id desc) b;
revoke all on public.inventory_levels from public, anon, authenticated;
grant select on public.inventory_levels to authenticated;

-- A shop row is the shared transaction lock for counts, receipts and sales.
-- It covers untracked products too, so a count and a sale cannot cross silently.
create function public.guard_inventory_entry() returns trigger language plpgsql security invoker set search_path = '' as $$
declare baseline timestamptz; current_quantity bigint;
begin
  perform 1 from public.shops where id=new.shop_id and owner_id=(select auth.uid()) for update;
  if not found then raise exception using errcode='42501',message='库存记录不属于当前店铺'; end if;
  perform 1 from public.products where id=new.product_id and shop_id=new.shop_id and deleted_at is null;
  if not found then raise exception using errcode='23503',message='商品不存在或已停用'; end if;
  if tg_table_name='inventory_counts' then
    select quantity into current_quantity from public.inventory_levels where shop_id=new.shop_id and product_id=new.product_id;
    if current_quantity is distinct from new.expected_quantity then
      raise exception using errcode='40001',message='库存已被其他操作修改，请刷新后重新核对盘点数量';
    end if;
    -- Keep the cutoff strictly after earlier events, even at equal clock precision
    -- or a small wall-clock correction. This does not use caller timestamps.
    select greatest(clock_timestamp(),max(event_time)+interval '1 microsecond') into new.initialized_at from (
      select initialized_at as event_time from public.inventory_counts where shop_id=new.shop_id
      union all select inventory_recorded_at from public.sales where shop_id=new.shop_id
      union all select created_at from public.inventory_receipts where shop_id=new.shop_id
    ) previous_events;
  else
    select initialized_at into baseline from public.inventory_counts where product_id=new.product_id and shop_id=new.shop_id order by initialized_at desc,id desc limit 1;
    if baseline is null then raise exception using errcode='23514',message='请先盘点当前库存，再登记新进货'; end if;
    if new.business_date < (baseline at time zone 'Asia/Shanghai')::date or new.business_date > (clock_timestamp() at time zone 'Asia/Shanghai')::date then
      raise exception using errcode='23514',message='进货日期须在盘点日与今天之间，只记录盘点后新进货';
    end if;
    new.created_at := greatest(clock_timestamp(),baseline+interval '1 microsecond');
  end if;
  return new;
end;
$$;
create trigger inventory_counts_guard before insert on public.inventory_counts for each row execute function public.guard_inventory_entry();
create trigger inventory_receipts_guard before insert on public.inventory_receipts for each row execute function public.guard_inventory_entry();

create function public.guard_sale_inventory_time() returns trigger language plpgsql security invoker set search_path = '' as $$
declare supplied_time boolean;
begin
  perform 1 from public.shops where id=new.shop_id and owner_id=(select auth.uid()) for update;
  if not found then raise exception using errcode='42501',message='销售记录不属于当前店铺'; end if;
  if tg_op='INSERT' then
    supplied_time := new.occurred_at is not null;
    select greatest(clock_timestamp(),max(initialized_at)+interval '1 microsecond') into new.inventory_recorded_at from public.inventory_counts where shop_id=new.shop_id;
    if new.occurred_at is null then
      new.occurred_at := case when new.business_date=(clock_timestamp() at time zone 'Asia/Shanghai')::date then new.inventory_recorded_at
        else ((new.business_date+1)::timestamp at time zone 'Asia/Shanghai')-interval '1 microsecond' end;
    end if;
    if (supplied_time and new.occurred_at > clock_timestamp()) or (new.occurred_at at time zone 'Asia/Shanghai')::date <> new.business_date then
      raise exception using errcode='22023',message='实际收款时间须与经营日期一致，且不能晚于现在';
    end if;
  elsif new.occurred_at is distinct from old.occurred_at or new.inventory_recorded_at is distinct from old.inventory_recorded_at then
    raise exception using errcode='23514',message='原始收款时间与库存记账边界不可修改';
  end if;
  return new;
end;
$$;
create trigger sales_inventory_time before insert or update on public.sales for each row execute function public.guard_sale_inventory_time();

create function public.stamp_sale_inventory_quantity() returns trigger language plpgsql security invoker set search_path = '' as $$
declare head public.sales%rowtype; baseline timestamptz;
begin
  perform 1 from public.shops where id=coalesce(new.shop_id,old.shop_id) and owner_id=(select auth.uid()) for update;
  if not found then raise exception using errcode='42501',message='销售明细不属于当前店铺'; end if;
  if tg_op='DELETE' then return old; end if;
  select * into head from public.sales where id=new.sale_id and shop_id=new.shop_id;
  select initialized_at into baseline from public.inventory_counts where product_id=new.product_id and shop_id=new.shop_id order by initialized_at desc,id desc limit 1;
  -- Both cutoffs matter: late imports use actual payment time; old existing
  -- orders must not start deducting stock when someone edits them later.
  new.inventory_quantity := case when baseline is not null and head.inventory_recorded_at >= baseline and head.occurred_at >= baseline then new.quantity else 0 end;
  return new;
end;
$$;
create trigger sale_items_inventory before insert or update or delete on public.sale_items for each row execute function public.stamp_sale_inventory_quantity();

create function public.validate_inventory_stock() returns trigger language plpgsql security invoker set search_path = '' as $$
declare own_shop uuid; bad_product text;
begin
  own_shop := coalesce(new.shop_id,old.shop_id);
  select p.name into bad_product from public.inventory_levels l join public.products p on p.id=l.product_id and p.shop_id=l.shop_id
    where l.shop_id=own_shop and (l.quantity < 0 or l.quantity > 1000000000000) limit 1;
  if found then raise exception using errcode='23514',message='库存不足或数量超出上限：'||bad_product||'。请核对进货和实际销售数量'; end if;
  return null;
end;
$$;
-- Deferred checks allow edits which reorder or replace several existing lines.
create constraint trigger sale_items_inventory_complete after insert or update or delete on public.sale_items deferrable initially deferred for each row execute function public.validate_inventory_stock();
create constraint trigger inventory_receipts_complete after insert on public.inventory_receipts deferrable initially deferred for each row execute function public.validate_inventory_stock();

create function public.count_inventory(p_product_id uuid,p_quantity integer,p_request_id uuid,p_expected_quantity bigint) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare own_shop uuid; existing public.inventory_counts%rowtype; current_quantity bigint;
begin
  select id into own_shop from public.shops where owner_id=(select auth.uid()) for update;
  if own_shop is null then raise exception using errcode='42501',message='请先登录并创建店铺'; end if;
  select * into existing from public.inventory_counts where shop_id=own_shop and request_id=p_request_id;
  if found then
    if existing.product_id=p_product_id and existing.initial_quantity=p_quantity and existing.expected_quantity is not distinct from p_expected_quantity then return to_jsonb(existing); end if;
    raise exception using errcode='23505',message='同一盘点请求不能提交不同内容';
  end if;
  select quantity into current_quantity from public.inventory_levels where shop_id=own_shop and product_id=p_product_id;
  if current_quantity is distinct from p_expected_quantity then
    raise exception using errcode='40001',message='库存已被其他操作修改，请刷新后重新核对盘点数量';
  end if;
  insert into public.inventory_counts(id,shop_id,product_id,initial_quantity,request_id,expected_quantity) values(p_request_id,own_shop,p_product_id,p_quantity,p_request_id,p_expected_quantity) returning * into existing;
  return to_jsonb(existing);
end;
$$;
create function public.receive_inventory(p_id uuid,p_product_id uuid,p_business_date date,p_quantity integer,p_unit_cost_mills bigint,p_note text) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare own_shop uuid; existing public.inventory_receipts%rowtype;
begin
  select id into own_shop from public.shops where owner_id=(select auth.uid()) for update;
  if own_shop is null then raise exception using errcode='42501',message='请先登录并创建店铺'; end if;
  select * into existing from public.inventory_receipts where id=p_id and shop_id=own_shop;
  if found then
    if existing.product_id=p_product_id and existing.business_date=p_business_date and existing.quantity=p_quantity and existing.unit_cost_mills=p_unit_cost_mills and existing.note=p_note then return to_jsonb(existing); end if;
    raise exception using errcode='23505',message='同一进货请求不能提交不同内容';
  end if;
  insert into public.inventory_receipts(id,shop_id,product_id,business_date,quantity,unit_cost_mills,note) values(p_id,own_shop,p_product_id,p_business_date,p_quantity,p_unit_cost_mills,p_note) returning * into existing;
  return to_jsonb(existing);
end;
$$;

revoke all on function public.guard_inventory_entry(),public.guard_sale_inventory_time(),public.stamp_sale_inventory_quantity(),public.validate_inventory_stock() from public,anon,authenticated;
revoke all on function public.count_inventory(uuid,integer,uuid,bigint),public.receive_inventory(uuid,uuid,date,integer,bigint,text) from public,anon,authenticated;
grant execute on function public.count_inventory(uuid,integer,uuid,bigint),public.receive_inventory(uuid,uuid,date,integer,bigint,text) to authenticated;

drop function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid);
create function public.save_sale(
  p_id uuid, p_business_date date, p_extra_income_cents bigint, p_note text,
  p_items jsonb, p_expected_version integer, p_request_id uuid, p_occurred_at timestamptz default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  own_shop uuid; sale_row public.sales%rowtype; payload jsonb;
  item jsonb; item_position bigint; item_count integer; new_sale boolean;
  retained_item_ids uuid[] := '{}'::uuid[]; matched_item_id uuid;
  uses_mills boolean; item_cost_mills bigint;
begin
  select id into own_shop from public.shops where owner_id = (select auth.uid());
  if own_shop is null then raise exception using errcode = '42501', message = '请先登录并创建店铺'; end if;
  if p_id is null or p_request_id is null or p_business_date is null or p_extra_income_cents is null
    or p_extra_income_cents < 0 or p_extra_income_cents > 1000000000000
    or char_length(p_note) > 500 or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = '销售日期、金额、备注或明细格式无效';
  end if;
  item_count := jsonb_array_length(p_items);
  if item_count < 1 or item_count > 100 then raise exception using errcode = '22023', message = '每张销售单需要 1 至 100 条明细'; end if;
  uses_mills := (p_items->0) ? 'unitCostMills';
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object' or item->>'productId' is null
      or char_length(btrim(item->>'name')) not between 1 and 120
      or char_length(btrim(item->>'category')) not between 1 and 40
      or item->>'name' is null or item->>'category' is null
      or coalesce(item->>'quantity', '') !~ '^[0-9]+$'
      or coalesce(item->>'unitPriceCents', '') !~ '^[0-9]+$'
      or (item ? 'unitCostMills') <> uses_mills
      or (uses_mills and ((item ? 'unitCostCents') or coalesce(item->>'unitCostMills', '') !~ '^[0-9]+$'))
      or (not uses_mills and coalesce(item->>'unitCostCents', '') !~ '^[0-9]+$') then
      raise exception using errcode = '22023', message = '商品名称、类别、数量或价格格式无效，请刷新页面后重试';
    end if;
  end loop;
  -- Keep the original raw payload: do not rewrite old idempotency identities.
  payload := jsonb_build_object('id', p_id, 'businessDate', p_business_date, 'extraIncomeCents', p_extra_income_cents, 'note', p_note, 'items', p_items);
  if p_occurred_at is not null then payload := payload || jsonb_build_object('occurredAt', p_occurred_at); end if;
  perform 1 from public.shops where id=own_shop for update;
  perform pg_advisory_xact_lock(hashtextextended(own_shop::text || ':' || p_request_id::text, 0));
  new_sale := coalesce(p_expected_version, 0) = 0;
  -- Successful creation retries return before current product precision checks;
  -- the immutable raw payload still distinguishes every changed request.
  if new_sale then
    select * into sale_row from public.sales where shop_id = own_shop and (id = p_id or request_id = p_request_id) for update;
    if found then
      if sale_row.id = p_id and sale_row.request_id = p_request_id and sale_row.request_payload = payload then return to_jsonb(sale_row); end if;
      raise exception using errcode = '23505', message = '同一请求标识不能提交不同的销售内容';
    end if;
  else
    select * into sale_row from public.sales where id = p_id and shop_id = own_shop for update;
    if not found then raise exception using errcode = 'P0002', message = '销售记录不存在'; end if;
    if sale_row.version <> p_expected_version then raise exception using errcode = '40001', message = '销售记录已被其他页面修改，请刷新后重试'; end if;
    if sale_row.request_id <> p_request_id then raise exception using errcode = '22023', message = '编辑时必须保留原销售请求标识'; end if;
  end if;
  if not uses_mills then
    -- Hold the same product locks as item writes before accepting legacy costs;
    -- a concurrent product edit must not introduce precision after this check.
    perform p.id from public.products p join jsonb_array_elements(p_items) j on p.id = (j->>'productId')::uuid
      where p.shop_id = own_shop order by p.id for share of p;
    if exists (select 1 from public.sale_items where sale_id = p_id and shop_id = own_shop and unit_cost_mills % 10 <> 0)
      or exists (select 1 from public.products p join jsonb_array_elements(p_items) j on p.id = (j->>'productId')::uuid
        where p.shop_id = own_shop and p.purchase_unit_cost_mills % 10 <> 0) then
      raise exception using errcode = '22023', message = '商品或历史销售使用三位小数成本，请刷新页面后重试';
    end if;
  end if;
  if new_sale then
    insert into public.sales(id, shop_id, business_date, extra_income_cents, note, request_id, request_payload, occurred_at)
      values (p_id, own_shop, p_business_date, p_extra_income_cents, p_note, p_request_id, payload, p_occurred_at) returning * into sale_row;
  else
    update public.sales set business_date = p_business_date, extra_income_cents = p_extra_income_cents,
      note = p_note, version = version + 1 where id = p_id and shop_id = own_shop returning * into sale_row;
  end if;
  for item, item_position in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
    item_cost_mills := case when uses_mills then (item->>'unitCostMills')::bigint else (item->>'unitCostCents')::bigint * 10 end;
    select id into matched_item_id from public.sale_items
      where sale_id = p_id and shop_id = own_shop and product_id = (item->>'productId')::uuid
        and not (id = any(retained_item_ids))
      order by line_number, id limit 1;
    if found then
      update public.sale_items set line_number = item_position,
        product_name_snapshot = btrim(item->>'name'), category_snapshot = btrim(item->>'category'),
        quantity = (item->>'quantity')::integer, unit_sale_price_cents = (item->>'unitPriceCents')::bigint,
        unit_cost_mills = item_cost_mills
        where id = matched_item_id and shop_id = own_shop;
    else
      insert into public.sale_items(shop_id, sale_id, product_id, line_number, product_name_snapshot, category_snapshot, quantity, unit_sale_price_cents, unit_cost_mills)
      values (own_shop, p_id, (item->>'productId')::uuid, item_position, btrim(item->>'name'), btrim(item->>'category'), (item->>'quantity')::integer, (item->>'unitPriceCents')::bigint, item_cost_mills)
      returning id into matched_item_id;
    end if;
    retained_item_ids := array_append(retained_item_ids, matched_item_id);
  end loop;
  delete from public.sale_items where sale_id = p_id and shop_id = own_shop and not (id = any(retained_item_ids));
  return to_jsonb(sale_row);
end;
$$;


revoke all on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid,timestamptz) to authenticated;

create or replace function public.void_sale(p_id uuid, p_expected_version integer) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare sale_row public.sales%rowtype; own_shop uuid;
begin
  select id into own_shop from public.shops where owner_id=(select auth.uid()) for update;
  if own_shop is null then raise exception using errcode='42501',message='请先登录并创建店铺'; end if;
  select * into sale_row from public.sales where id=p_id and shop_id=own_shop for update;
  if not found then raise exception using errcode='P0002',message='销售记录不存在'; end if;
  if p_expected_version is null or sale_row.version <> p_expected_version then raise exception using errcode='40001',message='销售记录已被修改，请刷新后重试'; end if;
  if sale_row.voided_at is not null then return to_jsonb(sale_row); end if;
  update public.sales set voided_at=clock_timestamp(),version=version+1 where id=p_id returning * into sale_row;
  return to_jsonb(sale_row);
end;
$$;
commit;
