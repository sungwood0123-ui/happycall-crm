-- V29.65: keep the intranet attendance list focused on today without losing
-- records that have not yet reached the Google attendance sheet.

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Keep this migration safe to re-run in local or preview environments.
select cron.unschedule(jobid)
from cron.job
where jobname = 'sechan-delete-synced-past-attendance';

-- Supabase Cron schedules use UTC. 15:10 UTC is 00:10 on the next day in Korea.
select cron.schedule(
  'sechan-delete-synced-past-attendance',
  '10 15 * * *',
  $cleanup$
    delete from public.attendance_records
    where work_date < (now() at time zone 'Asia/Seoul')::date
      and sheet_sync_status = 'synced';
  $cleanup$
);

comment on table public.attendance_records is
  'Server-verified attendance records. Synced records older than the current Korea date are removed daily; pending and failed Google Sheet sync records are preserved.';

