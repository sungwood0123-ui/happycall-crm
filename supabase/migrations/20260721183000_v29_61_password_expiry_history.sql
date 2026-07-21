create table if not exists public.employee_password_history (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  password_hash text not null,
  password_salt text not null,
  hash_iterations integer not null default 210000,
  changed_at timestamptz not null default now()
);

alter table public.employee_password_history enable row level security;

revoke all on table public.employee_password_history from public, anon, authenticated;
grant all on table public.employee_password_history to service_role;

comment on table public.employee_password_history is
  '직전 사용자 비밀번호 재사용 방지용 PBKDF2 확인값. 비밀번호 원문은 저장하지 않는다.';
