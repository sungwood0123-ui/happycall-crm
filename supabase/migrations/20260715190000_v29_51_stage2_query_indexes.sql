create index if not exists customers_open_date_idx
  on public.customers (open_date);

create index if not exists happycall_targets_store_target_date_idx
  on public.happycall_targets (assigned_store, target_date);

create index if not exists happycall_targets_employee_target_date_idx
  on public.happycall_targets (assigned_employee, target_date);

create index if not exists happycall_targets_temporary_employee_target_date_idx
  on public.happycall_targets (temporary_assignee, target_date)
  where temporary_assignee is not null;

create index if not exists happycall_targets_target_date_idx
  on public.happycall_targets (target_date);

create index if not exists happycall_logs_target_checked_idx
  on public.happycall_logs (target_id, checked_at desc);

create index if not exists happycall_logs_join_checked_idx
  on public.happycall_logs (join_no, checked_at desc);

create index if not exists happycall_logs_review_checked_idx
  on public.happycall_logs (review_status, checked_at desc);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);

create index if not exists freepass_ledger_created_at_idx
  on public.freepass_ledger (created_at desc);

create index if not exists freepass_requests_requested_at_idx
  on public.freepass_requests (requested_at desc);

analyze public.customers;
analyze public.happycall_targets;
analyze public.happycall_logs;
analyze public.audit_logs;
analyze public.freepass_ledger;
analyze public.freepass_requests;
