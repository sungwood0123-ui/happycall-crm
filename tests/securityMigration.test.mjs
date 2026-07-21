import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prepare = readFileSync(new URL('../supabase/migrations/20260717160000_v29_57_auth_transition_prepare.sql', import.meta.url), 'utf8');
const cutover = readFileSync(new URL('../supabase/migrations/20260717170000_v29_57_auth_rls_cutover.sql', import.meta.url), 'utf8');

test('보호된 비밀번호 전환 표는 브라우저 역할에 권한을 주지 않는다', () => {
  assert.match(prepare, /revoke all on table public\.employee_legacy_credentials from public, anon, authenticated/i);
  assert.match(prepare, /enable row level security/i);
});

test('보안 전환 시 모든 운영 테이블에 RLS를 적용한다', () => {
  const requiredTables = [
    'accessory_orders','assignment_history','audit_logs','call_scripts','customers','duplicate_decisions',
    'employee_store_history','employees','error_reports','freepass_ledger','freepass_requests','happycall_logs',
    'happycall_targets','notification_requests','push_subscriptions','refused_customers',
    'reviewer_store_permissions','stores','suggestions','system_settings','voc_logs'
  ];
  requiredTables.forEach(table => assert.match(cutover, new RegExp(`alter table public\\.${table} enable row level security`, 'i')));
});

test('퇴사자 차단과 역할 기반 정책이 화면 권한 기준과 함께 존재한다', () => {
  assert.match(cutover, /e\.status = '재직'/);
  assert.match(cutover, /private\.is_admin_like\(\)/);
  assert.match(cutover, /private\.is_manager\(\)/);
  assert.match(cutover, /private\.can_review_store/);
  assert.match(cutover, /private\.current_employee_role\(\) = '관리자'/);
});

test('공개 로그인 목록에는 비밀번호와 인증 id를 노출하지 않는다', () => {
  assert.match(cutover, /grant select \(id, name, store_name, status, role\) on public\.employees to anon/i);
  assert.doesNotMatch(cutover, /grant select \([^;]*password[^;]*\) on public\.employees to anon/i);
});

test('직원 오류보고 중복 처리와 휴무 고객응대 임시취소 권한을 유지한다', () => {
  assert.match(cutover, /create policy errors_actor_select[\s\S]*reporter_name = private\.current_employee_name\(\)/i);
  assert.match(cutover, /create policy errors_actor_update[\s\S]*reporter_name = private\.current_employee_name\(\)/i);
  assert.match(cutover, /create policy freepass_requests_own_draft_delete[\s\S]*status = '임시저장'/i);
});
