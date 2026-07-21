import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../supabase/migrations/20260721082000_v29_60_happycall_atomic_save.sql', import.meta.url), 'utf8');

test('현재 담당자는 같은 가입번호의 과거 통화불가 기록을 전환할 수 있다', () => {
  assert.match(sql, /can_access_happycall_join_no\(join_no\)/);
  assert.match(sql, /private\.can_access_happycall_target\(t\.id\)/);
  assert.match(sql, /refused_scope_select/);
  assert.match(sql, /refused_scope_update/);
  assert.match(sql, /refused_scope_delete/);
});

test('해피콜 기록과 통화불가·VOC 처리는 하나의 DB 작업으로 저장한다', () => {
  assert.match(sql, /function public\.save_happycall_core/);
  assert.match(sql, /insert into public\.happycall_logs/);
  assert.match(sql, /insert into public\.refused_customers/);
  assert.match(sql, /insert into public\.voc_logs/);
  assert.match(sql, /security invoker/);
});

test('같은 저장 작업을 재시도해도 처리 기록 id가 중복되지 않는다', () => {
  assert.match(sql, /on conflict \(id\) do update/);
  assert.match(sql, /return v_log_id/);
});
