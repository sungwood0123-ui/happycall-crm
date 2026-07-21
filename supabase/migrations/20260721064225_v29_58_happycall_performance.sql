-- V29.58: keep the existing happycall access rules while avoiding repeated
-- employee and target lookups for every returned row.

create or replace function private.can_access_happycall_target(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.happycall_targets t
    where t.id = target_id
      and (select private.is_active_employee())
      and (
        (select private.is_admin_like())
        or coalesce(t.temporary_assignee, t.assigned_employee) = (select private.current_employee_name())
        or (
          (select private.is_manager())
          and t.assigned_store = (select private.current_employee_store())
        )
        or (
          (select private.current_employee_role()) = '검수자'
          and exists (
            select 1
            from public.reviewer_store_permissions p
            where p.employee_id = (select private.current_employee_id())
              and p.store_name = t.assigned_store
          )
        )
      )
  )
$$;

revoke all on function private.can_access_happycall_target(uuid) from public, anon;
grant execute on function private.can_access_happycall_target(uuid) to authenticated;

drop policy if exists targets_scope_select on public.happycall_targets;
create policy targets_scope_select
on public.happycall_targets
for select
to authenticated
using (
  (select private.is_active_employee())
  and (
    (select private.is_admin_like())
    or coalesce(temporary_assignee, assigned_employee) = (select private.current_employee_name())
    or (
      (select private.is_manager())
      and assigned_store = (select private.current_employee_store())
    )
    or (
      (select private.current_employee_role()) = '검수자'
      and exists (
        select 1
        from public.reviewer_store_permissions p
        where p.employee_id = (select private.current_employee_id())
          and p.store_name = happycall_targets.assigned_store
      )
    )
  )
);

drop policy if exists targets_scope_update on public.happycall_targets;
create policy targets_scope_update
on public.happycall_targets
for update
to authenticated
using (
  (select private.is_active_employee())
  and (
    (select private.is_admin_like())
    or coalesce(temporary_assignee, assigned_employee) = (select private.current_employee_name())
    or (
      (select private.is_manager())
      and assigned_store = (select private.current_employee_store())
    )
    or (
      (select private.current_employee_role()) = '검수자'
      and exists (
        select 1
        from public.reviewer_store_permissions p
        where p.employee_id = (select private.current_employee_id())
          and p.store_name = happycall_targets.assigned_store
      )
    )
  )
)
with check (
  (select private.is_active_employee())
  and (
    (select private.is_admin_like())
    or coalesce(temporary_assignee, assigned_employee) = (select private.current_employee_name())
    or (
      (select private.is_manager())
      and assigned_store = (select private.current_employee_store())
    )
  )
);

drop policy if exists logs_scope_select on public.happycall_logs;
create policy logs_scope_select
on public.happycall_logs
for select
to authenticated
using (
  target_id in (select t.id from public.happycall_targets t)
);

drop policy if exists logs_actor_insert on public.happycall_logs;
create policy logs_actor_insert
on public.happycall_logs
for insert
to authenticated
with check (
  private.can_access_happycall_target(target_id)
  and employee_name = (select private.current_employee_name())
  and checked_by = (select private.current_employee_name())
);

drop policy if exists logs_scope_update on public.happycall_logs;
create policy logs_scope_update
on public.happycall_logs
for update
to authenticated
using (private.can_access_happycall_target(target_id))
with check (private.can_access_happycall_target(target_id));

drop policy if exists refused_scope_select on public.refused_customers;
create policy refused_scope_select
on public.refused_customers
for select
to authenticated
using (
  (select private.is_admin_like())
  or refused_by = (select private.current_employee_name())
  or (
    target_id is not null
    and target_id in (select t.id from public.happycall_targets t)
  )
);

drop policy if exists voc_scope_select on public.voc_logs;
create policy voc_scope_select
on public.voc_logs
for select
to authenticated
using (
  target_id in (select t.id from public.happycall_targets t)
);

alter policy customers_active_select
on public.customers
using ((select private.is_active_employee()));

alter policy assignment_active_select
on public.assignment_history
using ((select private.is_active_employee()));

alter policy employee_history_active_select
on public.employee_store_history
using ((select private.is_active_employee()));

alter policy stores_active_select
on public.stores
using ((select private.is_active_employee()));

alter policy employees_active_select
on public.employees
using ((select private.is_active_employee()));

create index if not exists happycall_targets_customer_id_idx
on public.happycall_targets (customer_id);
