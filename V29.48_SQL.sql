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

alter table public.happycall_targets
  drop constraint if exists happycall_targets_call_type_check;

alter table public.happycall_targets
  add constraint happycall_targets_call_type_check
  check (call_type = any (array[
    'MONTHLY_DAY'::text,
    'D_PLUS_1'::text,
    'D_PLUS_7'::text,
    'D_PLUS_13'::text,
    'D_PLUS_93'::text,
    'D_PLUS_183'::text,
    'D_PLUS_95'::text,
    'D_PLUS_185'::text
  ]));

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

with ranked_targets as (
  select
    t.id,
    first_value(t.id) over (
      partition by t.join_no, t.target_date
      order by
        (exists (select 1 from public.happycall_logs l where l.target_id = t.id)) desc,
        t.created_at asc,
        t.id asc
    ) as kept_target_id,
    row_number() over (
      partition by t.join_no, t.target_date
      order by
        (exists (select 1 from public.happycall_logs l where l.target_id = t.id)) desc,
        t.created_at asc,
        t.id asc
    ) as duplicate_rank
  from public.happycall_targets t
  where coalesce(t.is_skipped, false) = false
), duplicate_targets as (
  select r.id, r.kept_target_id
  from ranked_targets r
  where r.duplicate_rank > 1
    and not exists (
      select 1 from public.happycall_logs l where l.target_id = r.id
    )
)
update public.happycall_targets t
set
  is_skipped = true,
  skip_reason = 'V29.48 중복 자동 제외 / 유지 대상 ID: ' || d.kept_target_id::text
from duplicate_targets d
where t.id = d.id;

create unique index if not exists happycall_targets_active_join_date_unique
  on public.happycall_targets (join_no, target_date)
  where coalesce(is_skipped, false) = false;

commit;
