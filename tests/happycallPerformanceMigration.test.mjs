import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260721064225_v29_58_happycall_performance.sql',
  import.meta.url
);

test('happycall select policies keep every existing role path', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const requiredRule of [
    '(select private.is_admin_like())',
    'coalesce(temporary_assignee, assigned_employee) = (select private.current_employee_name())',
    '(select private.is_manager())',
    "(select private.current_employee_role()) = '검수자'",
    'reviewer_store_permissions'
  ]) {
    assert.match(sql, new RegExp(requiredRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('log access reuses the already-filtered target scope', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /target_id in \(select t\.id from public\.happycall_targets t\)/);
  assert.doesNotMatch(
    sql.match(/create policy logs_scope_select[\s\S]*?;/)?.[0] || '',
    /can_access_happycall_target\(target_id\)/
  );
});

test('full-table active employee checks use one statement-level result', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const policy of [
    'customers_active_select',
    'assignment_active_select',
    'employee_history_active_select',
    'stores_active_select',
    'employees_active_select'
  ]) {
    assert.match(sql, new RegExp(`alter policy ${policy}[\\s\\S]*?using \\(\\(select private\\.is_active_employee\\(\\)\\)\\)`));
  }
});
