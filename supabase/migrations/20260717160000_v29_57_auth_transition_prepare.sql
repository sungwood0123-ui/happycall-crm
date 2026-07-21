-- V29.57 단계 A: 기존 직원 비밀번호를 안전한 인증 시스템으로 옮길 준비.
-- 이 단계만 적용해도 기존 V29.56 화면은 계속 동작한다.

alter table public.employees
  add column if not exists auth_user_id uuid null references auth.users(id) on delete set null,
  add column if not exists password_change_required boolean not null default true,
  add column if not exists password_changed_at timestamptz null;

create unique index if not exists employees_auth_user_id_unique
  on public.employees(auth_user_id)
  where auth_user_id is not null;

create table if not exists public.employee_legacy_credentials (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  legacy_password text not null,
  copied_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.employee_auth_migration_challenges (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists employee_auth_migration_challenges_employee_idx
  on public.employee_auth_migration_challenges(employee_id, created_at desc);

create table if not exists public.employee_auth_attempts (
  id bigint generated always as identity primary key,
  employee_id uuid null references public.employees(id) on delete cascade,
  client_key text not null,
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists employee_auth_attempts_limit_idx
  on public.employee_auth_attempts(client_key, attempted_at desc);

insert into public.employee_legacy_credentials(employee_id, legacy_password)
select id, password
from public.employees
where password is not null and password <> ''
on conflict (employee_id) do update
set legacy_password = excluded.legacy_password,
    updated_at = now();

create or replace function public.sync_employee_legacy_password()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.password is not null and new.password <> '' then
    insert into public.employee_legacy_credentials(employee_id, legacy_password)
    values (new.id, new.password)
    on conflict (employee_id) do update
    set legacy_password = excluded.legacy_password,
        updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists employees_sync_legacy_password on public.employees;
create trigger employees_sync_legacy_password
after insert or update of password on public.employees
for each row execute function public.sync_employee_legacy_password();

alter table public.employee_legacy_credentials enable row level security;
alter table public.employee_auth_migration_challenges enable row level security;
alter table public.employee_auth_attempts enable row level security;

revoke all on table public.employee_legacy_credentials from public, anon, authenticated;
revoke all on table public.employee_auth_migration_challenges from public, anon, authenticated;
revoke all on table public.employee_auth_attempts from public, anon, authenticated;
revoke all on sequence public.employee_auth_attempts_id_seq from public, anon, authenticated;
revoke all on function public.sync_employee_legacy_password() from public, anon, authenticated;

comment on table public.employee_legacy_credentials is 'V29.57 전환 전용. 브라우저 접근 금지. 모든 직원 전환 후 삭제한다.';
comment on table public.employee_auth_migration_challenges is '일회용 비밀번호 전환 확인 토큰. 브라우저 직접 접근 금지.';
comment on table public.employee_auth_attempts is '로그인 시도 제한용 해시 기록. 원본 IP 및 비밀번호는 저장하지 않는다.';
