-- Explicit sales-only receipt imports. Existing sales and stock are untouched.
begin;

create or replace function public.stamp_sale_inventory_quantity() returns trigger language plpgsql security invoker set search_path = '' as $$
declare head public.sales%rowtype; baseline timestamptz;
begin
  perform 1 from public.shops where id=coalesce(new.shop_id,old.shop_id) and owner_id=(select auth.uid()) for update;
  if not found then raise exception using errcode='42501',message='销售明细不属于当前店铺'; end if;
  if tg_op='DELETE' then return old; end if;
  select * into head from public.sales where id=new.sale_id and shop_id=new.shop_id;
  -- This immutable request flag records an explicit sales-only import.
  -- It survives later edits and voids without touching stock balances.
  if head.request_payload->'salesOnly' = 'true'::jsonb then
    new.inventory_quantity := 0;
    return new;
  end if;
  select initialized_at into baseline from public.inventory_counts where product_id=new.product_id and shop_id=new.shop_id order by initialized_at desc,id desc limit 1;
  -- Both cutoffs matter: late imports use actual payment time; old existing
  -- orders must not start deducting stock when someone edits them later.
  new.inventory_quantity := case when baseline is not null and head.inventory_recorded_at >= baseline and head.occurred_at >= baseline then new.quantity else 0 end;
  return new;
end;
$$;

-- Keep one RPC signature; omitted trailing arguments retain the former behavior.
drop function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid,timestamptz);
create function public.save_sale(
  p_id uuid, p_business_date date, p_extra_income_cents bigint, p_note text,
  p_items jsonb, p_expected_version integer, p_request_id uuid, p_occurred_at timestamptz default null, p_sales_only boolean default false
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  own_shop uuid; sale_row public.sales%rowtype; payload jsonb;
  item jsonb; item_position bigint; item_count integer; new_sale boolean;
  retained_item_ids uuid[] := '{}'::uuid[]; matched_item_id uuid;
  uses_mills boolean; item_cost_mills bigint;
begin
  select id into own_shop from public.shops where owner_id = (select auth.uid());
  if own_shop is null then raise exception using errcode = '42501', message = '请先登录并创建店铺'; end if;
  if p_sales_only is null or p_id is null or p_request_id is null or p_business_date is null or p_extra_income_cents is null
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
  if p_sales_only then payload := payload || jsonb_build_object('salesOnly', true); end if;
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

revoke all on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid,timestamptz,boolean) to authenticated;
commit;
