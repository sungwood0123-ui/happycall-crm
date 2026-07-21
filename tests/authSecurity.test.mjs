import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_SCREEN_BASELINE,
  canAccessScreen,
  employeeSessionProfile,
  isAdminLikeRole,
  isSuperAdminRole,
  validatePasswordPolicy
} from '../src/authSecurity.js';

test('비밀번호는 영문 숫자 특수문자를 포함한 8자 이상만 허용한다', () => {
  assert.equal(validatePasswordPolicy('Abc!1234').valid, true);
  assert.equal(validatePasswordPolicy('1054').valid, false);
  assert.equal(validatePasswordPolicy('abcdefgh!').valid, false);
  assert.equal(validatePasswordPolicy('12345678!').valid, false);
  assert.equal(validatePasswordPolicy('Abcd1234').valid, false);
  assert.equal(validatePasswordPolicy('Abcd 123!').valid, false);
  assert.equal(validatePasswordPolicy('Abc!1234', 'Abc!1234').valid, false);
});

test('최고관리자 판정은 이름이나 이메일이 아니라 저장된 권한만 사용한다', () => {
  assert.equal(isSuperAdminRole({ role: '최고관리자' }), true);
  assert.equal(isSuperAdminRole({ role: '직원', name: '심성우', email: 'sungwood0123@gmail.com' }), false);
  assert.equal(isAdminLikeRole({ role: '관리자' }), true);
  assert.equal(isAdminLikeRole({ role: '최고관리자' }), true);
  assert.equal(isAdminLikeRole({ role: '점장' }), false);
});

test('브라우저 세션용 직원 정보에는 업무와 권한 확인에 필요한 값만 남긴다', () => {
  const profile = employeeSessionProfile({
    id: 'employee-id',
    name: '직원',
    store_name: '금촌',
    status: '재직',
    role: '직원',
    password: '절대저장금지',
    password_change_required: true,
    unknown_value: '제외'
  });

  assert.equal(profile.password, undefined);
  assert.equal(profile.unknown_value, undefined);
  assert.equal(profile.password_change_required, true);
});

test('퇴사자는 모든 화면 접근이 차단되고 기존 역할별 화면은 그대로 유지된다', () => {
  const activeManager = { id: '1', status: '재직', role: '점장' };
  const retiredManager = { ...activeManager, status: '퇴사' };
  assert.equal(canAccessScreen(activeManager, '매장 현황'), true);
  assert.equal(canAccessScreen(activeManager, '직원관리'), false);
  assert.equal(canAccessScreen(retiredManager, '매장 현황'), false);
  assert.equal(ROLE_SCREEN_BASELINE.최고관리자.includes('내 해피콜'), false);
});
