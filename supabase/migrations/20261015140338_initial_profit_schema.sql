-- 小店利润本 MVP. Apply once to an empty Supabase project's public schema.
-- No service_role key or SECURITY DEFINER code is used by this application.
begin;

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  currency text not null default 'CNY' check (currency = 'CNY'),
  timezone text not null default 'Asia/Shanghai' check (timezone = 'Asia/Shanghai'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  category text not null default '未分类' check (char_length(btrim(category)) between 1 and 40),
  purchase_unit_cost_cents bigint not null check (purchase_unit_cost_cents between 0 and 100000000),
  sale_unit_price_cents bigint not null check (sale_unit_price_cents between 0 and 100000000),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  business_date date not null default (now() at time zone 'Asia/Shanghai')::date,
  extra_income_cents bigint not null default 0 check (extra_income_cents between 0 and 1000000000000),
  extra_income_note text check (char_length(extra_income_note) <= 200),
  note text check (char_length(note) <= 500),
  request_id uuid not null,
  -- Immutable canonical creation payload makes retries distinguishable from changed requests.
  request_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(request_payload) = 'object'),
  version integer not null default 1 check (version > 0),
  -- Internal transaction stamp: item writes bump the header once per transaction.
  -- A trigger always replaces caller input, so this cannot be forged to skip bumps.
  version_transaction_id xid8 not null default pg_current_xact_id(),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, request_id)
);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  sale_id uuid not null,
  product_id uuid not null,
  line_number integer not null check (line_number between 1 and 100),
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 1 and 120),
  category_snapshot text not null check (char_length(btrim(category_snapshot)) between 1 and 40),
  quantity integer not null check (quantity between 1 and 100000),
  unit_sale_price_cents bigint not null check (unit_sale_price_cents between 0 and 100000000),
  unit_cost_cents bigint not null check (unit_cost_cents between 0 and 100000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sale_id, line_number),
  foreign key (shop_id, sale_id) references public.sales(shop_id, id) on delete restrict,
  foreign key (shop_id, product_id) references public.products(shop_id, id) on delete restrict
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  business_date date not null default (now() at time zone 'Asia/Shanghai')::date,
  category text not null check (category in ('transport', 'packaging', 'loss', 'utilities', 'rent', 'other')),
  amount_cents bigint not null check (amount_cents between 1 and 1000000000000),
  note text check (char_length(note) <= 500),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_shop_active_idx on public.products(shop_id, deleted_at);
create index sales_shop_date_idx on public.sales(shop_id, business_date);
create index expenses_shop_date_idx on public.expenses(shop_id, business_date);
create index sale_items_shop_sale_idx on public.sale_items(shop_id, sale_id);
create index sale_items_shop_product_idx on public.sale_items(shop_id, product_id);

alter table public.shops enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.expenses enable row level security;

create policy shops_select on public.shops for select to authenticated using (owner_id = (select auth.uid()));
create policy shops_insert on public.shops for insert to authenticated with check (owner_id = (select auth.uid()));
create policy shops_update on public.shops for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy products_select on public.products for select to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy products_insert on public.products for insert to authenticated with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy products_update on public.products for update to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid()))) with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));

create policy sales_select on public.sales for select to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy sales_insert on public.sales for insert to authenticated with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy sales_update on public.sales for update to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid()))) with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));

create policy sale_items_select on public.sale_items for select to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy sale_items_insert on public.sale_items for insert to authenticated with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy sale_items_update on public.sale_items for update to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid()))) with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy sale_items_delete on public.sale_items for delete to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));

create policy expenses_select on public.expenses for select to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy expenses_insert on public.expenses for insert to authenticated with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));
create policy expenses_update on public.expenses for update to authenticated using (shop_id in (select id from public.shops where owner_id = (select auth.uid()))) with check (shop_id in (select id from public.shops where owner_id = (select auth.uid())));

-- Revoke old project defaults too: table grants and RLS solve different problems.
revoke all on public.shops, public.products, public.sales, public.sale_items, public.expenses from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update on public.shops, public.products, public.sales, public.sale_items, public.expenses to authenticated;
grant delete on public.sale_items to authenticated;

create function public.guard_immutable_fields() returns trigger language plpgsql security invoker set search_path = '' as $$
declare field_name text;
begin
  foreach field_name in array tg_argv loop
    if (to_jsonb(new) -> field_name) is distinct from (to_jsonb(old) -> field_name) then
      raise exception using errcode = '23514', message = '不可修改记录标识、所属店铺或创建信息：' || field_name;
    end if;
  end loop;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger shops_immutable before update on public.shops for each row execute function public.guard_immutable_fields('id', 'owner_id', 'created_at');
create trigger products_immutable before update on public.products for each row execute function public.guard_immutable_fields('id', 'shop_id', 'created_at');
create trigger sales_immutable before update on public.sales for each row execute function public.guard_immutable_fields('id', 'shop_id', 'request_id', 'request_payload', 'created_at');
create trigger sale_items_immutable before update on public.sale_items for each row execute function public.guard_immutable_fields('id', 'shop_id', 'sale_id', 'line_number', 'created_at');
create trigger expenses_immutable before update on public.expenses for each row execute function public.guard_immutable_fields('id', 'shop_id', 'created_at');

create function public.guard_business_date() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.business_date > (clock_timestamp() at time zone 'Asia/Shanghai')::date then
    raise exception using errcode = '23514', message = '经营日期不能晚于上海时区的今天';
  end if;
  return new;
end;
$$;
create trigger sales_business_date before insert or update on public.sales for each row execute function public.guard_business_date();
create trigger expenses_business_date before insert or update on public.expenses for each row execute function public.guard_business_date();

create function public.stamp_sale_transaction() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.version_transaction_id := pg_current_xact_id();
  return new;
end;
$$;
create trigger sales_transaction_stamp before insert or update on public.sales for each row execute function public.stamp_sale_transaction();

create function public.guard_sale_update() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.voided_at is not null then
    raise exception using errcode = '23514', message = '已作废的销售记录不可修改';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '40001', message = '销售版本必须递增，请刷新后重试';
  end if;
  return new;
end;
$$;
create trigger sales_update_guard before update on public.sales for each row execute function public.guard_sale_update();

-- Lock the header before each item change. This serializes direct Data API writes
-- as well as RPC calls and prevents two transactions defeating the total limit.
create function public.guard_sale_item() returns trigger language plpgsql security invoker set search_path = '' as $$
declare sale_row public.sales%rowtype; product_row public.products%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into sale_row from public.sales where id = old.sale_id and shop_id = old.shop_id for update;
  else
    select * into sale_row from public.sales where id = new.sale_id and shop_id = new.shop_id for update;
  end if;
  if not found then
    raise exception using errcode = '23503', message = '销售单不存在或不属于当前店铺';
  end if;
  if sale_row.voided_at is not null then
    raise exception using errcode = '23514', message = '已作废的销售明细不可修改';
  end if;
  -- RPC edits already update the header, so they still increment exactly once.
  -- Direct item writes must also invalidate any previously opened editor.
  if sale_row.version_transaction_id is distinct from pg_current_xact_id() then
    update public.sales set version = version + 1 where id = sale_row.id and shop_id = sale_row.shop_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select * into product_row from public.products where id = new.product_id and shop_id = new.shop_id for share;
  if not found then
    raise exception using errcode = '23503', message = '商品不存在或不属于当前店铺';
  end if;
  if product_row.deleted_at is not null then
    if tg_op = 'INSERT' then
      raise exception using errcode = '23514', message = '停用商品不能新增销售';
    elsif new.product_id is distinct from old.product_id then
      raise exception using errcode = '23514', message = '不能把历史明细替换为其他停用商品';
    end if;
  end if;
  return new;
end;
$$;
create trigger sale_items_guard before insert or update or delete on public.sale_items for each row execute function public.guard_sale_item();

-- Constraint triggers run at COMMIT, not after each individual line. A complete
-- atomic sale may temporarily have no items while it is being replaced.
create function public.validate_complete_sale() returns trigger language plpgsql security invoker set search_path = '' as $$
declare sale_uuid uuid; sale_row public.sales%rowtype; item_count bigint; revenue numeric; cost numeric;
begin
  if tg_table_name = 'sales' then
    sale_uuid := new.id;
  elsif tg_op = 'DELETE' then
    sale_uuid := old.sale_id;
  else
    sale_uuid := new.sale_id;
  end if;
  select * into sale_row from public.sales where id = sale_uuid;
  if not found then return null; end if;
  select count(*), coalesce(sum(quantity::numeric * unit_sale_price_cents), 0), coalesce(sum(quantity::numeric * unit_cost_cents), 0)
    into item_count, revenue, cost from public.sale_items where sale_id = sale_uuid and shop_id = sale_row.shop_id;
  if sale_row.voided_at is null and item_count = 0 then
    raise exception using errcode = '23514', message = '有效销售单必须包含至少一条商品明细';
  end if;
  if item_count > 100 or revenue + sale_row.extra_income_cents > 1000000000000 or cost > 1000000000000 then
    raise exception using errcode = '23514', message = '销售单超过 100 行或金额上限';
  end if;
  return null;
end;
$$;
create constraint trigger sales_complete after insert or update on public.sales deferrable initially deferred for each row execute function public.validate_complete_sale();
create constraint trigger sale_items_complete after insert or update or delete on public.sale_items deferrable initially deferred for each row execute function public.validate_complete_sale();

create function public.save_sale(
  p_id uuid, p_business_date date, p_extra_income_cents bigint, p_note text,
  p_items jsonb, p_expected_version integer, p_request_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  own_shop uuid; sale_row public.sales%rowtype; payload jsonb;
  item jsonb; item_position bigint; item_count integer; new_sale boolean;
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
  payload := jsonb_build_object('id', p_id, 'businessDate', p_business_date, 'extraIncomeCents', p_extra_income_cents, 'note', p_note, 'items', p_items);
  -- The lock is per tenant + creation request and protects simultaneous retries.
  perform pg_advisory_xact_lock(hashtextextended(own_shop::text || ':' || p_request_id::text, 0));
  new_sale := coalesce(p_expected_version, 0) = 0;
  if new_sale then
    select * into sale_row from public.sales where shop_id = own_shop and (id = p_id or request_id = p_request_id) for update;
    if found then
      if sale_row.id = p_id and sale_row.request_id = p_request_id and sale_row.request_payload = payload then return to_jsonb(sale_row); end if;
      raise exception using errcode = '23505', message = '同一请求标识不能提交不同的销售内容';
    end if;
    insert into public.sales(id, shop_id, business_date, extra_income_cents, note, request_id, request_payload)
      values (p_id, own_shop, p_business_date, p_extra_income_cents, p_note, p_request_id, payload) returning * into sale_row;
  else
    select * into sale_row from public.sales where id = p_id and shop_id = own_shop for update;
    if not found then raise exception using errcode = 'P0002', message = '销售记录不存在'; end if;
    if sale_row.version <> p_expected_version then raise exception using errcode = '40001', message = '销售记录已被其他页面修改，请刷新后重试'; end if;
    if sale_row.request_id <> p_request_id then raise exception using errcode = '22023', message = '编辑时必须保留原销售请求标识'; end if;
    update public.sales set business_date = p_business_date, extra_income_cents = p_extra_income_cents,
      note = p_note, version = version + 1 where id = p_id and shop_id = own_shop returning * into sale_row;
  end if;
  for item, item_position in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
    if jsonb_typeof(item) <> 'object' or item->>'productId' is null
      or char_length(btrim(item->>'name')) not between 1 and 120
      or char_length(btrim(item->>'category')) not between 1 and 40
      or item->>'name' is null or item->>'category' is null
      or coalesce(item->>'quantity', '') !~ '^[0-9]+$'
      or coalesce(item->>'unitPriceCents', '') !~ '^[0-9]+$'
      or coalesce(item->>'unitCostCents', '') !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = '商品名称、类别、数量或价格格式无效';
    end if;
    -- UPDATE existing positions first so historical inactive products remain
    -- linked to their original line rather than being reintroduced by INSERT.
    update public.sale_items set product_id = (item->>'productId')::uuid,
      product_name_snapshot = btrim(item->>'name'), category_snapshot = btrim(item->>'category'),
      quantity = (item->>'quantity')::integer, unit_sale_price_cents = (item->>'unitPriceCents')::bigint,
      unit_cost_cents = (item->>'unitCostCents')::bigint
      where sale_id = p_id and shop_id = own_shop and line_number = item_position;
    if not found then
      insert into public.sale_items(shop_id, sale_id, product_id, line_number, product_name_snapshot, category_snapshot, quantity, unit_sale_price_cents, unit_cost_cents)
      values (own_shop, p_id, (item->>'productId')::uuid, item_position, btrim(item->>'name'), btrim(item->>'category'), (item->>'quantity')::integer, (item->>'unitPriceCents')::bigint, (item->>'unitCostCents')::bigint);
    end if;
  end loop;
  delete from public.sale_items where sale_id = p_id and shop_id = own_shop and line_number > item_count;
  return to_jsonb(sale_row);
end;
$$;

create function public.void_sale(p_id uuid, p_expected_version integer) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare sale_row public.sales%rowtype;
begin
  select * into sale_row from public.sales where id = p_id for update;
  if not found then raise exception using errcode = 'P0002', message = '销售记录不存在'; end if;
  if p_expected_version is null or sale_row.version <> p_expected_version then raise exception using errcode = '40001', message = '销售记录已被修改，请刷新后重试'; end if;
  if sale_row.voided_at is not null then return to_jsonb(sale_row); end if;
  update public.sales set voided_at = clock_timestamp(), version = version + 1 where id = p_id returning * into sale_row;
  return to_jsonb(sale_row);
end;
$$;

revoke all on function public.guard_immutable_fields(), public.guard_business_date(), public.stamp_sale_transaction(), public.guard_sale_update(), public.guard_sale_item(), public.validate_complete_sale() from public, anon, authenticated;
revoke all on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid), public.void_sale(uuid,integer) from public, anon, authenticated;
grant execute on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid), public.void_sale(uuid,integer) to authenticated;

commit;
