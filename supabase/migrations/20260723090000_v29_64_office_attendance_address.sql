-- V29.64: add office as a valid attendance location and keep its display address.

insert into public.stores (name, status)
select '사무실', '운영중'
where not exists (
  select 1 from public.stores where name = '사무실'
);

alter table public.store_attendance_settings
  add column if not exists address text;

comment on column public.store_attendance_settings.address
  is 'Human-readable address selected by the super administrator for attendance verification.';
