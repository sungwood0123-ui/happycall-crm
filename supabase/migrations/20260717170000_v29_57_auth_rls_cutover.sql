-- V29.57 단계 B: 새 인증 화면과 Edge Functions 검증 후에만 적용한다.
-- 적용 즉시 기존 localStorage 기반 인증은 사용할 수 없으므로 배포 순서를 지켜야 한다.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.current_employee_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select e.id from public.employees e
  where e.auth_user_id = (select auth.uid()) and e.status = '재직'
  limit 1
$$;

create or replace function private.current_employee_name()
returns text language sql stable security definer set search_path = ''
as $$
  select e.name from public.employees e
  where e.auth_user_id = (select auth.uid()) and e.status = '재직'
  limit 1
$$;

create or replace function private.current_employee_store()
returns text language sql stable security definer set search_path = ''
as $$
  select e.store_name from public.employees e
  where e.auth_user_id = (select auth.uid()) and e.status = '재직'
  limit 1
$$;

create or replace function private.current_employee_role()
returns text language sql stable security definer set search_path = ''
as $$
  select e.role from public.employees e
  where e.auth_user_id = (select auth.uid()) and e.status = '재직'
  limit 1
$$;

create or replace function private.is_active_employee()
returns boolean language sql stable security definer set search_path = ''
as $$ select private.current_employee_id() is not null $$;

create or replace function private.is_admin_like()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.current_employee_role() in ('관리자', '최고관리자'), false) $$;

create or replace function private.is_super_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.current_employee_role() = '최고관리자', false) $$;

create or replace function private.is_manager()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.current_employee_role() = '점장', false) $$;

create or replace function private.can_review_store(target_store text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case
    when private.is_admin_like() then true
    when private.current_employee_role() <> '검수자' then false
    else exists (
      select 1 from public.reviewer_store_permissions p
      where p.employee_id = private.current_employee_id()
        and p.store_name = target_store
    )
  end
$$;

create or replace function private.can_access_happycall_target(target_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.happycall_targets t
    where t.id = target_id
      and private.is_active_employee()
      and (
        private.is_admin_like()
        or coalesce(t.temporary_assignee, t.assigned_employee) = private.current_employee_name()
        or (private.is_manager() and t.assigned_store = private.current_employee_store())
        or private.can_review_store(t.assigned_store)
      )
  )
$$;

revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;

drop trigger if exists employees_sync_legacy_password on public.employees;
drop function if exists public.sync_employee_legacy_password();
alter table public.employees drop column if exists password;

alter table public.accessory_orders enable row level security;
alter table public.assignment_history enable row level security;
alter table public.audit_logs enable row level security;
alter table public.call_scripts enable row level security;
alter table public.customers enable row level security;
alter table public.duplicate_decisions enable row level security;
alter table public.employee_store_history enable row level security;
alter table public.employees enable row level security;
alter table public.error_reports enable row level security;
alter table public.freepass_ledger enable row level security;
alter table public.freepass_requests enable row level security;
alter table public.happycall_logs enable row level security;
alter table public.happycall_targets enable row level security;
alter table public.notification_requests enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.refused_customers enable row level security;
alter table public.reviewer_store_permissions enable row level security;
alter table public.stores enable row level security;
alter table public.suggestions enable row level security;
alter table public.system_settings enable row level security;
alter table public.voc_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select (id, name, store_name, status, role) on public.employees to anon;
grant select (id, name, store_name, status, created_at, role, hire_date, resign_date, happycall_enabled,
  happycall_assignment_enabled, end_time, auth_user_id, password_change_required, password_changed_at)
  on public.employees to authenticated;
grant update (name, store_name, status, role, hire_date, resign_date, happycall_enabled,
  happycall_assignment_enabled, end_time) on public.employees to authenticated;

grant select on public.accessory_orders, public.assignment_history, public.audit_logs, public.call_scripts,
  public.customers, public.duplicate_decisions, public.employee_store_history, public.error_reports,
  public.freepass_ledger, public.freepass_requests, public.happycall_logs, public.happycall_targets,
  public.notification_requests, public.push_subscriptions, public.refused_customers,
  public.reviewer_store_permissions, public.stores, public.suggestions, public.system_settings,
  public.voc_logs to authenticated;

grant insert, update, delete on public.accessory_orders, public.assignment_history, public.audit_logs,
  public.customers, public.duplicate_decisions, public.employee_store_history, public.error_reports,
  public.freepass_ledger, public.freepass_requests, public.happycall_logs, public.happycall_targets,
  public.notification_requests, public.push_subscriptions, public.refused_customers,
  public.reviewer_store_permissions, public.stores, public.suggestions, public.system_settings,
  public.voc_logs to authenticated;
grant insert, update, delete on public.call_scripts to authenticated;
grant usage, select on all sequences in schema public to authenticated;

drop policy if exists employees_login_directory on public.employees;
create policy employees_login_directory on public.employees for select to anon
using (status = '재직');
drop policy if exists employees_active_select on public.employees;
create policy employees_active_select on public.employees for select to authenticated
using (private.is_active_employee());
drop policy if exists employees_admin_update on public.employees;
create policy employees_admin_update on public.employees for update to authenticated
using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists stores_active_select on public.stores;
create policy stores_active_select on public.stores for select to authenticated using (private.is_active_employee());
drop policy if exists stores_admin_write on public.stores;
create policy stores_admin_write on public.stores for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists scripts_active_select on public.call_scripts;
create policy scripts_active_select on public.call_scripts for select to authenticated using (private.is_active_employee());
drop policy if exists scripts_admin_write on public.call_scripts;
create policy scripts_admin_write on public.call_scripts for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists settings_active_select on public.system_settings;
create policy settings_active_select on public.system_settings for select to authenticated using (private.is_active_employee());
drop policy if exists settings_admin_write on public.system_settings;
create policy settings_admin_write on public.system_settings for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists customers_active_select on public.customers;
create policy customers_active_select on public.customers for select to authenticated using (private.is_active_employee());
drop policy if exists customers_admin_write on public.customers;
create policy customers_admin_write on public.customers for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists assignment_active_select on public.assignment_history;
create policy assignment_active_select on public.assignment_history for select to authenticated using (private.is_active_employee());
drop policy if exists assignment_admin_write on public.assignment_history;
create policy assignment_admin_write on public.assignment_history for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists employee_history_active_select on public.employee_store_history;
create policy employee_history_active_select on public.employee_store_history for select to authenticated using (private.is_active_employee());
drop policy if exists employee_history_admin_write on public.employee_store_history;
create policy employee_history_admin_write on public.employee_store_history for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists duplicate_admin_all on public.duplicate_decisions;
create policy duplicate_admin_all on public.duplicate_decisions for all to authenticated using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists reviewer_permissions_select on public.reviewer_store_permissions;
create policy reviewer_permissions_select on public.reviewer_store_permissions for select to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id());
drop policy if exists reviewer_permissions_admin_write on public.reviewer_store_permissions;
create policy reviewer_permissions_admin_write on public.reviewer_store_permissions for all to authenticated
using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists audit_admin_select on public.audit_logs;
create policy audit_admin_select on public.audit_logs for select to authenticated using (private.is_admin_like());
drop policy if exists audit_actor_insert on public.audit_logs;
create policy audit_actor_insert on public.audit_logs for insert to authenticated
with check (private.is_active_employee() and actor_name = private.current_employee_name());

drop policy if exists errors_admin_select on public.error_reports;
create policy errors_admin_select on public.error_reports for select to authenticated using (private.is_admin_like());
drop policy if exists errors_actor_select on public.error_reports;
create policy errors_actor_select on public.error_reports for select to authenticated
using (private.is_active_employee() and reporter_name = private.current_employee_name());
drop policy if exists errors_actor_insert on public.error_reports;
create policy errors_actor_insert on public.error_reports for insert to authenticated
with check (private.is_active_employee() and reporter_name = private.current_employee_name());
drop policy if exists errors_admin_update on public.error_reports;
create policy errors_admin_update on public.error_reports for update to authenticated
using (private.is_admin_like()) with check (private.is_admin_like());
drop policy if exists errors_actor_update on public.error_reports;
create policy errors_actor_update on public.error_reports for update to authenticated
using (private.is_active_employee() and reporter_name = private.current_employee_name())
with check (private.is_active_employee() and reporter_name = private.current_employee_name());

drop policy if exists suggestions_select on public.suggestions;
create policy suggestions_select on public.suggestions for select to authenticated
using (private.is_admin_like() or requester_name = private.current_employee_name());
drop policy if exists suggestions_actor_insert on public.suggestions;
create policy suggestions_actor_insert on public.suggestions for insert to authenticated
with check (private.is_active_employee() and requester_name = private.current_employee_name());
drop policy if exists suggestions_admin_update on public.suggestions;
create policy suggestions_admin_update on public.suggestions for update to authenticated
using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists push_own_select on public.push_subscriptions;
create policy push_own_select on public.push_subscriptions for select to authenticated
using (employee_id = private.current_employee_id());
drop policy if exists push_own_insert on public.push_subscriptions;
create policy push_own_insert on public.push_subscriptions for insert to authenticated
with check (private.is_active_employee() and employee_id = private.current_employee_id() and employee_name = private.current_employee_name());
drop policy if exists push_own_update on public.push_subscriptions;
create policy push_own_update on public.push_subscriptions for update to authenticated
using (employee_id = private.current_employee_id()) with check (employee_id = private.current_employee_id());

drop policy if exists notifications_select on public.notification_requests;
create policy notifications_select on public.notification_requests for select to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id() or created_by = private.current_employee_name());
drop policy if exists notifications_actor_insert on public.notification_requests;
create policy notifications_actor_insert on public.notification_requests for insert to authenticated
with check (private.is_active_employee() and created_by = private.current_employee_name());
drop policy if exists notifications_admin_update on public.notification_requests;
create policy notifications_admin_update on public.notification_requests for update to authenticated
using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists accessory_scope_select on public.accessory_orders;
create policy accessory_scope_select on public.accessory_orders for select to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id() or store_name = private.current_employee_store());
drop policy if exists accessory_actor_insert on public.accessory_orders;
create policy accessory_actor_insert on public.accessory_orders for insert to authenticated
with check (private.is_active_employee() and employee_id = private.current_employee_id() and employee_name = private.current_employee_name() and store_name = private.current_employee_store());
drop policy if exists accessory_scope_update on public.accessory_orders;
create policy accessory_scope_update on public.accessory_orders for update to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id() or store_name = private.current_employee_store())
with check (private.is_admin_like() or employee_id = private.current_employee_id() or store_name = private.current_employee_store());
drop policy if exists accessory_admin_delete on public.accessory_orders;
create policy accessory_admin_delete on public.accessory_orders for delete to authenticated using (private.is_admin_like());

drop policy if exists freepass_requests_scope_select on public.freepass_requests;
create policy freepass_requests_scope_select on public.freepass_requests for select to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id() or employee_name = private.current_employee_name()
  or (private.is_manager() and employee_store = private.current_employee_store()));
drop policy if exists freepass_requests_own_insert on public.freepass_requests;
create policy freepass_requests_own_insert on public.freepass_requests for insert to authenticated
with check (private.is_active_employee() and employee_id = private.current_employee_id() and employee_name = private.current_employee_name());
drop policy if exists freepass_requests_scope_update on public.freepass_requests;
create policy freepass_requests_scope_update on public.freepass_requests for update to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id() or employee_name = private.current_employee_name()
  or (private.is_manager() and employee_store = private.current_employee_store()))
with check (private.is_admin_like() or employee_id = private.current_employee_id() or employee_name = private.current_employee_name()
  or (private.is_manager() and employee_store = private.current_employee_store()));
drop policy if exists freepass_requests_own_draft_delete on public.freepass_requests;
create policy freepass_requests_own_draft_delete on public.freepass_requests for delete to authenticated
using (private.is_active_employee() and employee_id = private.current_employee_id() and status = '임시저장');

drop policy if exists freepass_ledger_scope_select on public.freepass_ledger;
create policy freepass_ledger_scope_select on public.freepass_ledger for select to authenticated
using (private.is_admin_like() or employee_id = private.current_employee_id() or employee_name = private.current_employee_name()
  or (private.is_manager() and employee_store = private.current_employee_store()));
drop policy if exists freepass_ledger_admin_write on public.freepass_ledger;
create policy freepass_ledger_admin_write on public.freepass_ledger for all to authenticated
using (private.is_admin_like()) with check (private.is_admin_like());

drop policy if exists targets_scope_select on public.happycall_targets;
create policy targets_scope_select on public.happycall_targets for select to authenticated
using (private.can_access_happycall_target(id));
drop policy if exists targets_admin_insert on public.happycall_targets;
create policy targets_admin_insert on public.happycall_targets for insert to authenticated
with check (private.is_admin_like());
drop policy if exists targets_scope_update on public.happycall_targets;
create policy targets_scope_update on public.happycall_targets for update to authenticated
using (private.can_access_happycall_target(id))
with check (private.is_admin_like() or coalesce(temporary_assignee, assigned_employee) = private.current_employee_name()
  or (private.is_manager() and assigned_store = private.current_employee_store()));
drop policy if exists targets_admin_delete on public.happycall_targets;
create policy targets_admin_delete on public.happycall_targets for delete to authenticated
using (private.current_employee_role() = '관리자');

drop policy if exists logs_scope_select on public.happycall_logs;
create policy logs_scope_select on public.happycall_logs for select to authenticated
using (private.can_access_happycall_target(target_id));
drop policy if exists logs_actor_insert on public.happycall_logs;
create policy logs_actor_insert on public.happycall_logs for insert to authenticated
with check (private.can_access_happycall_target(target_id) and employee_name = private.current_employee_name() and checked_by = private.current_employee_name());
drop policy if exists logs_scope_update on public.happycall_logs;
create policy logs_scope_update on public.happycall_logs for update to authenticated
using (private.can_access_happycall_target(target_id))
with check (private.can_access_happycall_target(target_id));

drop policy if exists refused_scope_select on public.refused_customers;
create policy refused_scope_select on public.refused_customers for select to authenticated
using (private.is_admin_like() or refused_by = private.current_employee_name()
  or (target_id is not null and private.can_access_happycall_target(target_id)));
drop policy if exists refused_actor_insert on public.refused_customers;
create policy refused_actor_insert on public.refused_customers for insert to authenticated
with check (private.is_active_employee() and refused_by = private.current_employee_name()
  and (target_id is null or private.can_access_happycall_target(target_id)));
drop policy if exists refused_scope_update on public.refused_customers;
create policy refused_scope_update on public.refused_customers for update to authenticated
using (private.is_admin_like() or refused_by = private.current_employee_name()
  or (target_id is not null and private.can_access_happycall_target(target_id)))
with check (private.is_admin_like() or refused_by = private.current_employee_name());
drop policy if exists refused_scope_delete on public.refused_customers;
create policy refused_scope_delete on public.refused_customers for delete to authenticated
using (private.is_admin_like() or refused_by = private.current_employee_name()
  or (target_id is not null and private.can_access_happycall_target(target_id)));

drop policy if exists voc_scope_select on public.voc_logs;
create policy voc_scope_select on public.voc_logs for select to authenticated
using (private.can_access_happycall_target(target_id));
drop policy if exists voc_scope_insert on public.voc_logs;
create policy voc_scope_insert on public.voc_logs for insert to authenticated
with check (private.can_access_happycall_target(target_id));
drop policy if exists voc_scope_update on public.voc_logs;
create policy voc_scope_update on public.voc_logs for update to authenticated
using (private.can_access_happycall_target(target_id)) with check (private.can_access_happycall_target(target_id));

-- 전환용 비밀번호 표는 모든 재직자 인증 전환 완료 후 별도 정리 migration으로 삭제한다.
