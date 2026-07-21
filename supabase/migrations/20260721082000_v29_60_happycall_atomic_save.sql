create or replace function private.can_access_happycall_join_no(p_join_no text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.happycall_targets t
    where t.join_no = p_join_no
      and private.can_access_happycall_target(t.id)
  )
$$;

revoke all on function private.can_access_happycall_join_no(text) from public, anon;
grant execute on function private.can_access_happycall_join_no(text) to authenticated;

drop policy if exists refused_scope_select on public.refused_customers;
create policy refused_scope_select
on public.refused_customers
for select
to authenticated
using (
  (select private.is_admin_like())
  or refused_by = (select private.current_employee_name())
  or private.can_access_happycall_join_no(join_no)
);

drop policy if exists refused_scope_update on public.refused_customers;
create policy refused_scope_update
on public.refused_customers
for update
to authenticated
using (
  (select private.is_admin_like())
  or refused_by = (select private.current_employee_name())
  or private.can_access_happycall_join_no(join_no)
)
with check (
  (select private.is_admin_like())
  or (
    refused_by = (select private.current_employee_name())
    and private.can_access_happycall_join_no(join_no)
    and (target_id is null or private.can_access_happycall_target(target_id))
  )
);

drop policy if exists refused_scope_delete on public.refused_customers;
create policy refused_scope_delete
on public.refused_customers
for delete
to authenticated
using (
  (select private.is_admin_like())
  or refused_by = (select private.current_employee_name())
  or private.can_access_happycall_join_no(join_no)
);

create or replace function public.save_happycall_core(
  p_log_id uuid,
  p_existing_log_id uuid,
  p_target_id uuid,
  p_join_no text,
  p_employee_name text,
  p_call_result text,
  p_call_detail text,
  p_memo text,
  p_legal_rep_join_no text,
  p_is_minor boolean,
  p_minor_birth_date date,
  p_parent_log_id uuid,
  p_review_round integer,
  p_should_refuse boolean,
  p_refused_at timestamptz,
  p_skip_reason text,
  p_rejected_log_id uuid,
  p_voc_id uuid,
  p_voc_issue text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_log_id uuid;
begin
  if p_existing_log_id is not null then
    update public.happycall_logs
    set target_id = p_target_id,
        join_no = p_join_no,
        employee_name = p_employee_name,
        call_result = p_call_result,
        call_detail = p_call_detail,
        memo = p_memo,
        checked_by = p_employee_name,
        checked_at = p_refused_at,
        review_status = '검수대기',
        legal_rep_join_no = p_legal_rep_join_no,
        is_minor = p_is_minor,
        minor_birth_date = p_minor_birth_date
    where id = p_existing_log_id
      and target_id = p_target_id
    returning id into v_log_id;

    if v_log_id is null then
      raise exception '수정할 해피콜 처리 기록을 찾을 수 없습니다.';
    end if;
  else
    insert into public.happycall_logs (
      id, target_id, join_no, employee_name, call_result, call_detail, memo,
      checked_by, checked_at, review_status, legal_rep_join_no, is_minor,
      minor_birth_date, parent_log_id, review_round
    ) values (
      p_log_id, p_target_id, p_join_no, p_employee_name, p_call_result,
      p_call_detail, p_memo, p_employee_name, p_refused_at, '검수대기',
      p_legal_rep_join_no, p_is_minor, p_minor_birth_date,
      p_parent_log_id, coalesce(p_review_round, 1)
    )
    on conflict (id) do update
    set call_result = excluded.call_result,
        call_detail = excluded.call_detail,
        memo = excluded.memo,
        checked_at = excluded.checked_at,
        legal_rep_join_no = excluded.legal_rep_join_no,
        is_minor = excluded.is_minor,
        minor_birth_date = excluded.minor_birth_date
    returning id into v_log_id;
  end if;

  if p_should_refuse then
    insert into public.refused_customers (
      join_no, target_id, refused_by, refused_at, memo, legal_rep_join_no
    ) values (
      p_join_no, p_target_id, p_employee_name, p_refused_at,
      coalesce(nullif(p_memo, ''), nullif(p_call_detail, ''), '통화 불가'), null
    )
    on conflict (join_no) do update
    set target_id = excluded.target_id,
        refused_by = excluded.refused_by,
        refused_at = excluded.refused_at,
        memo = excluded.memo,
        legal_rep_join_no = null;

    update public.happycall_targets
    set is_skipped = true,
        skip_reason = p_skip_reason
    where join_no = p_join_no
      and id <> p_target_id
      and coalesce(is_skipped, false) = false
      and call_type not in ('D_PLUS_93', 'D_PLUS_183', 'D_PLUS_95', 'D_PLUS_185');
  else
    delete from public.refused_customers where join_no = p_join_no;
  end if;

  if p_rejected_log_id is not null then
    update public.happycall_logs
    set review_status = '재처리완료'
    where id = p_rejected_log_id;
  end if;

  if p_voc_id is not null then
    insert into public.voc_logs (id, target_id, join_no, customer_issue, status)
    values (p_voc_id, p_target_id, p_join_no, p_voc_issue, '미처리')
    on conflict (id) do update
    set customer_issue = excluded.customer_issue;
  end if;

  return v_log_id;
end;
$$;

revoke all on function public.save_happycall_core(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean, date,
  uuid, integer, boolean, timestamptz, text, uuid, uuid, text
) from public, anon;
grant execute on function public.save_happycall_core(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean, date,
  uuid, integer, boolean, timestamptz, text, uuid, uuid, text
) to authenticated;

-- 2026-07-21 부분 저장 오류로 같은 내용이 두 번 남은 건은 최신 기록만 유지한다.
delete from public.happycall_logs older
where older.id = 'ce557f43-7821-4743-8cdb-92dd0e8aca10'::uuid
  and exists (
    select 1
    from public.happycall_logs newer
    where newer.id = 'd0b44c1f-83de-476a-9471-22b36c024e18'::uuid
      and newer.target_id = older.target_id
      and newer.join_no = older.join_no
      and newer.employee_name = older.employee_name
      and newer.call_result = older.call_result
      and newer.call_detail = older.call_detail
  );

-- 새 개통 담당자의 실제 저장 결과에 맞춰 과거 통화불가 고객 기록을 현재 대상으로 전환한다.
update public.refused_customers refused
set target_id = latest.target_id,
    refused_by = latest.employee_name,
    refused_at = latest.checked_at,
    memo = coalesce(nullif(latest.memo, ''), latest.call_detail, refused.memo),
    legal_rep_join_no = null
from public.happycall_logs latest
where refused.join_no = '500289727061'
  and latest.id = 'd0b44c1f-83de-476a-9471-22b36c024e18'::uuid
  and latest.join_no = refused.join_no;
