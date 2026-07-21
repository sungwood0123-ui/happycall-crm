export const PASSWORD_POLICY_MESSAGE = '비밀번호는 8자 이상이며 영문, 숫자, 특수문자를 각각 1개 이상 포함해야 합니다.';
export const PASSWORD_MAX_AGE_DAYS = 90;
export const PASSWORD_MAX_AGE_MS = PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export function validatePasswordPolicy(value, previousValue = '') {
  const password = String(value || '');
  const previous = String(previousValue || '');
  const failures = [];

  if (password.length < 8) failures.push('8자 이상');
  if (!/[A-Za-z]/.test(password)) failures.push('영문 포함');
  if (!/[0-9]/.test(password)) failures.push('숫자 포함');
  if (!/[^A-Za-z0-9\s]/.test(password)) failures.push('특수문자 포함');
  if (/\s/.test(password)) failures.push('공백 제외');
  if (previous && password === previous) failures.push('기존 비밀번호와 다르게');

  return {
    valid: failures.length === 0,
    failures,
    message: failures.length === 0 ? '' : `${PASSWORD_POLICY_MESSAGE} (${failures.join(', ')})`
  };
}

export function isPasswordExpired(passwordChangedAt, now = Date.now()) {
  if (!passwordChangedAt) return true;
  const changedAt = new Date(passwordChangedAt).getTime();
  if (!Number.isFinite(changedAt)) return true;
  return now - changedAt >= PASSWORD_MAX_AGE_MS;
}

export function requiresPasswordChange(employee, now = Date.now()) {
  return Boolean(employee?.password_change_required) || isPasswordExpired(employee?.password_changed_at, now);
}

export function isSuperAdminRole(user) {
  return user?.role === '최고관리자';
}

export function isAdminRole(user) {
  return user?.role === '관리자';
}

export function isAdminLikeRole(user) {
  return isSuperAdminRole(user) || isAdminRole(user);
}

export function isManagerRole(user) {
  return user?.role === '점장';
}

export function isCheckerRole(user) {
  return user?.role === '검수자' || isAdminLikeRole(user);
}

export function isActiveEmployee(user) {
  return Boolean(user?.id && user?.status === '재직');
}

export function employeeSessionProfile(employee) {
  if (!employee || typeof employee !== 'object') return null;
  const {
    id,
    name,
    store_name,
    status,
    role,
    hire_date,
    resign_date,
    happycall_enabled,
    happycall_assignment_enabled,
    end_time,
    password_change_required,
    password_changed_at,
    auth_user_id
  } = employee;

  return {
    id,
    name,
    store_name,
    status,
    role,
    hire_date,
    resign_date,
    happycall_enabled,
    happycall_assignment_enabled,
    end_time,
    password_change_required: Boolean(password_change_required),
    password_changed_at: password_changed_at || null,
    auth_user_id: auth_user_id || null
  };
}

export const ROLE_SCREEN_BASELINE = Object.freeze({
  직원: [
    '홈', '내 해피콜', '프리패스', '악세사리 주문', '알림 설정', '건의/문의', '사용방법', '비밀번호 변경', '로그아웃'
  ],
  점장: [
    '홈', '내 해피콜', '매장 현황', '매장 리스트', '직원별 현황', '프리패스', '악세사리 주문', '알림 설정', '건의/문의', '사용방법', '비밀번호 변경', '로그아웃'
  ],
  검수자: [
    '홈', '내 해피콜', '검수', '전체 해피콜', '전체 직원 현황', '프리패스', '악세사리 주문', '알림 설정', '건의/문의', '사용방법', '비밀번호 변경', '로그아웃'
  ],
  관리자: [
    '홈', '내 해피콜', '검수', '전체 해피콜', '배정 현황', '전체 직원 현황', '통화 불가 고객', 'RAW 업로드', '해피콜 생성',
    '직원관리', '매장관리', '감사로그', '오류보고', '프리패스', '악세사리 주문', '알림 설정', '건의/문의', '사용방법', '비밀번호 변경', '로그아웃'
  ],
  최고관리자: [
    '홈', '검수', '전체 해피콜', '배정 현황', '전체 직원 현황', '통화 불가 고객', 'RAW 업로드', '해피콜 생성',
    '직원관리', '매장관리', '감사로그', '오류보고', '프리패스', '악세사리 주문', '알림 설정', '건의/문의', '사용방법', '비밀번호 변경', '로그아웃'
  ]
});

export function canAccessScreen(user, screen) {
  if (!isActiveEmployee(user)) return false;
  return (ROLE_SCREEN_BASELINE[user.role || '직원'] || ROLE_SCREEN_BASELINE.직원).includes(screen);
}
