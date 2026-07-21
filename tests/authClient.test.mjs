import test from 'node:test';
import assert from 'node:assert/strict';
import { beginLegacyPasswordMigration, employeeAuthEmail } from '../src/authClient.js';

test('직원 인증 이메일은 직원 id로만 결정되어 화면 권한과 섞이지 않는다', () => {
  assert.equal(employeeAuthEmail('00000000-0000-0000-0000-000000000001'), '00000000-0000-0000-0000-000000000001@login.sechan.company');
});

test('기존 비밀번호가 새 보안 조건을 만족하면 강제 변경 없이 전환한다', async () => {
  const supabase = {
    functions: {
      invoke: async () => ({ data: { migrated: true }, error: null })
    }
  };
  const result = await beginLegacyPasswordMigration(supabase, 'employee-id', 'Already!123');
  assert.equal(result.migrated, true);
});
