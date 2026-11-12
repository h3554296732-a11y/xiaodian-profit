-- Preserve historical item identity when removing or reordering sale lines.
-- Upgrade an existing initial_profit_schema database; do not replay the initial migration.
begin;

alter table public.sale_items drop constraint sale_items_sale_id_line_number_key;
alter table public.sale_items add constraint sale_items_sale_id_line_number_key
  unique (sale_id, line_number) deferrable initially deferred;

drop trigger sale_items_immutable on public.sale_items;
create trigger sale_items_immutable before update on public.sale_items for each row
  execute function public.guard_immutable_fields('id', 'shop_id', 'sale_id', 'created_at');

create or replace function public.save_sale(
  p_id uuid, p_business_date date, p_extra_income_cents bigint, p_note text,
  p_items jsonb, p_expected_version integer, p_request_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  own_shop uuid; sale_row public.sales%rowtype; payload jsonb;
  item jsonb; item_position bigint; item_count integer; new_sale boolean;
  retained_item_ids uuid[] := '{}'::uuid[]; matched_item_id uuid;
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
    -- Match each historical row at most once by product identity, not its old
    -- array position. Removing/reordering earlier rows must preserve the id of
    -- a retained inactive item. Unmatched rows still go through INSERT guards.
    select id into matched_item_id from public.sale_items
      where sale_id = p_id and shop_id = own_shop and product_id = (item->>'productId')::uuid
        and not (id = any(retained_item_ids))
      order by line_number, id limit 1;
    if found then
      update public.sale_items set line_number = item_position,
        product_name_snapshot = btrim(item->>'name'), category_snapshot = btrim(item->>'category'),
        quantity = (item->>'quantity')::integer, unit_sale_price_cents = (item->>'unitPriceCents')::bigint,
        unit_cost_cents = (item->>'unitCostCents')::bigint
        where id = matched_item_id and shop_id = own_shop;
    else
      insert into public.sale_items(shop_id, sale_id, product_id, line_number, product_name_snapshot, category_snapshot, quantity, unit_sale_price_cents, unit_cost_cents)
      values (own_shop, p_id, (item->>'productId')::uuid, item_position, btrim(item->>'name'), btrim(item->>'category'), (item->>'quantity')::integer, (item->>'unitPriceCents')::bigint, (item->>'unitCostCents')::bigint)
      returning id into matched_item_id;
    end if;
    retained_item_ids := array_append(retained_item_ids, matched_item_id);
  end loop;
  delete from public.sale_items where sale_id = p_id and shop_id = own_shop and not (id = any(retained_item_ids));
  return to_jsonb(sale_row);
end;
$$;

-- CREATE OR REPLACE preserves existing ACL; reaffirm the intended RPC access.
revoke all on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid) from public, anon, authenticated;
grant execute on function public.save_sale(uuid,date,bigint,text,jsonb,integer,uuid) to authenticated;

commit;
