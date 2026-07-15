begin;

alter table public.happycall_targets
  add column if not exists original_target_date date,
  add column if not exists scheduled_date date,
  add column if not exists scheduled_changed_by text,
  add column if not exists scheduled_changed_at timestamptz,
  add column if not exists scheduled_change_reason text;

create index if not exists happycall_targets_scheduled_date_idx
  on public.happycall_targets (scheduled_date)
  where scheduled_date is not null;

with pending_legacy as (
  select
    t.id,
    case
      when t.call_type = 'D_PLUS_95' then (c.open_date + 93)::date
      when t.call_type = 'D_PLUS_185' then (c.open_date + 183)::date
    end as new_target_date,
    case
      when t.call_type = 'D_PLUS_95' then 'D_PLUS_93'
      when t.call_type = 'D_PLUS_185' then 'D_PLUS_183'
    end as new_call_type
  from public.happycall_targets t
  join public.customers c on c.id = t.customer_id
  where t.call_type in ('D_PLUS_95', 'D_PLUS_185')
    and coalesce(t.is_skipped, false) = false
    and not exists (
      select 1 from public.happycall_logs l where l.target_id = t.id
    )
)
update public.happycall_targets t
set
  target_date = p.new_target_date,
  original_target_date = p.new_target_date,
  target_month = to_char(p.new_target_date, 'YYYY-MM'),
  call_type = p.new_call_type
from pending_legacy p
where t.id = p.id;

update public.happycall_targets t
set
  is_skipped = true,
  skip_reason = 'V29.48 운영 제외 매장: ' || t.assigned_store
where regexp_replace(coalesce(t.assigned_store, ''), '\s', '', 'g')
        in ('주주백석', '에스플러스(이성범)')
  and coalesce(t.is_skipped, false) = false
  and not exists (
    select 1 from public.happycall_logs l where l.target_id = t.id
  );

commit;
