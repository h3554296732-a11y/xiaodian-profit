-- Costs use integer mills (0.001 yuan); revenue and final line costs remain fen.
-- Additive upgrade: keep cents compatibility columns and immutable raw requests.
begin;

lock table public.products, public.sales, public.sale_items in access exclusive mode;

alter table public.products add column purchase_unit_cost_mills bigint;
alter table public.sale_items add column unit_cost_mills bigint;

-- Backfill even voided history without changing any old fields or versions.
-- These named triggers are restored in this same atomic transaction.
alter table public.products disable trigger products_immutable;
alter table public.sale_items disable trigger sale_items_guard;
alter table public.sale_items disable trigger sale_items_immutable;
update public.products set purchase_unit_cost_mills = purchase_unit_cost_cents * 10;
update public.sale_items set unit_cost_mills = unit_cost_cents * 10;
-- Drain deferred integrity checks before ALTER TRIGGER / NOT NULL DDL.
set constraints all immediate;
set constraints all deferred;
alter table public.products enable trigger products_immutable;
alter table public.sale_items enable trigger sale_items_guard;
alter table public.sale_items enable trigger sale_items_immutable;

alter table public.products alter column purchase_unit_cost_mills set not null;
alter table public.products add constraint products_purchase_unit_cost_mills_check
  check (purchase_unit_cost_mills between 0 and 1000000000);
alter table public.products add constraint products_cost_precision_consistent
  check (purchase_unit_cost_cents = (purchase_unit_cost_mills + 5) / 10);
alter table public.sale_items alter column unit_cost_mills set not null;
alter table public.sale_items add constraint sale_items_unit_cost_mills_check
  check (unit_cost_mills between 0 and 1000000000);
alter table public.sale_items add constraint sale_items_cost_precision_consistent
  check (unit_cost_cents = (unit_cost_mills + 5) / 10);

create function public.sync_product_cost_mills() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.purchase_unit_cost_mills is null then
      new.purchase_unit_cost_mills := new.purchase_unit_cost_cents * 10;
    end if;
  else
    if new.purchase_unit_cost_mills is null then
      raise exception using errcode = '22023', message = '成本精度缺失，请刷新页面后重试';
    end if;
    if new.purchase_unit_cost_mills is not distinct from old.purchase_unit_cost_mills
      and new.purchase_unit_cost_cents is distinct from old.purchase_unit_cost_cents then
      if old.purchase_unit_cost_mills % 10 <> 0 then
        raise exception using errcode = '22023', message = '旧版页面不能修改三位小数成本，请刷新页面后重试';
      end if;
      new.purchase_unit_cost_mills := new.purchase_unit_cost_cents * 10;
    end if;
  end if;
  if new.purchase_unit_cost_mills is null or new.purchase_unit_cost_mills not between 0 and 1000000000 then
    raise exception using errcode = '23514', message = '商品单位成本超出允许范围';
  end if;
  new.purchase_unit_cost_cents := (new.purchase_unit_cost_mills + 5) / 10;
  return new;
end;
$$;
create trigger products_cost_precision before insert or update on public.products
  for each row execute function public.sync_product_cost_mills();

create or replace function public.guard_sale_item() returns trigger language plpgsql security invoker set search_path = '' as $$
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
  if tg_op = 'INSERT' then
    if new.unit_cost_mills is null then
      if product_row.purchase_unit_cost_mills % 10 <> 0 then
        raise exception using errcode = '22023', message = '商品使用三位小数成本，请刷新页面后记账';
      end if;
      new.unit_cost_mills := new.unit_cost_cents * 10;
    end if;
  else
    if new.unit_cost_mills is null then
      raise exception using errcode = '22023', message = '成本精度缺失，请刷新页面后重试';
    end if;
    if new.unit_cost_mills is not distinct from old.unit_cost_mills
      and new.unit_cost_cents is distinct from old.unit_cost_cents then
      if old.unit_cost_mills % 10 <> 0 then
        raise exception using errcode = '22023', message = '旧版页面不能修改三位小数成本，请刷新页面后重试';
      end if;
      new.unit_cost_mills := new.unit_cost_cents * 10;
    end if;
  end if;
  if new.unit_cost_mills is null or new.unit_cost_mills not between 0 and 1000000000 then
    raise exception using errcode = '23514', message = '销售单位成本超出允许范围';
  end if;
  new.unit_cost_cents := (new.unit_cost_mills + 5) / 10;
  return new;
end;
$$;

create or replace function public.validate_complete_sale() returns trigger language plpgsql security invoker set search_path = '' as $$
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
  select count(*), coalesce(sum(quantity::numeric * unit_sale_price_cents), 0),
    coalesce(sum(floor((quantity::numeric * unit_cost_mills + 5) / 10)), 0)
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

create or replace function public.save_sale(
  p_id uuid, p_business_date date, p_extra_income_cents bigint, p_note text,
  p_items jsonb, p_expected_version integer, p_request_id uuid
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
    insert into public.sales(id, shop_id, business_date, extra_income_cents, note, request_id, request_payload)
      values (p_id, own_shop, p_business_date, p_extra_income_cents, p_note, p_request_id, payload) returning * into sale_row;
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

revoke all on function public.sync_product_cost_mills(), public.guard_sale_item(), public.validate_complete_sale() from public, anon, authenticated;
revoke all on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid) from public, anon, authenticated;
grant execute on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid) to authenticated;

-- Rollback is additive: retain mills columns and guards when reverting the UI.
-- Never drop these columns while any mills value is not divisible by ten.
commit;
