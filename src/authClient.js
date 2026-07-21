import { employeeSessionProfile, isActiveEmployee, validatePasswordPolicy } from './authSecurity.js';

export function employeeAuthEmail(employeeId) {
  return `${String(employeeId || '').trim()}@login.sechan.company`;
}

export async function loadActiveLoginDirectory(supabase) {
  const { data, error } = await supabase
    .from('employees')
    .select('id,name,store_name,status,role')
    .eq('status', '재직')
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function loadAuthenticatedEmployee(supabase, authUserId) {
  if (!authUserId) return null;
  const { data, error } = await supabase
    .from('employees')
    .select('id,name,store_name,status,role,hire_date,resign_date,happycall_enabled,happycall_assignment_enabled,end_time,password_change_required,password_changed_at,auth_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (error) throw error;
  return isActiveEmployee(data) ? employeeSessionProfile(data) : null;
}

export async function signInEmployee(supabase, employeeId, password) {
  return supabase.auth.signInWithPassword({ email: employeeAuthEmail(employeeId), password });
}

export async function resetEmployeeTemporaryPassword(supabase, employeeId) {
  const { data, error } = await supabase.functions.invoke('employee-account', {
    body: { action: 'reset-password', employee_id: employeeId }
  });

  if (error || !data?.temporary_password) {
    let serverMessage = data?.error || '';
    if (!serverMessage && error?.context instanceof Response) {
      try {
        const body = await error.context.clone().json();
        serverMessage = body?.error || '';
      } catch {}
    }
    throw new Error(serverMessage || error?.message || '임시 비밀번호를 발급하지 못했습니다.');
  }
  return data;
}

export async function beginLegacyPasswordMigration(supabase, employeeId, password) {
  const { data, error } = await supabase.functions.invoke('employee-auth', {
    body: { action: 'begin-migration', employee_id: employeeId, password }
  });
  if (error) throw new Error(data?.error || error.message || '기존 로그인 확인 중 오류가 발생했습니다.');
  if (!data?.challenge && !data?.migrated) throw new Error(data?.error || '안전한 로그인 전환에 실패했습니다.');
  return data;
}

export async function completeLegacyPasswordMigration(supabase, challenge, newPassword) {
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) throw new Error(policy.message);
  const { data, error } = await supabase.functions.invoke('employee-auth', {
    body: { action: 'complete-migration', challenge, new_password: newPassword }
  });
  if (error || !data?.completed) throw new Error(data?.error || error?.message || '비밀번호 변경을 완료하지 못했습니다.');
  return data;
}

export async function markPasswordChanged(supabase) {
  const { data, error } = await supabase.functions.invoke('employee-account', {
    body: { action: 'mark-password-changed' }
  });
  if (error || !data?.completed) throw new Error(data?.error || error?.message || '비밀번호 변경 상태를 저장하지 못했습니다.');
  return data;
}

export async function changeAuthenticatedPassword(supabase, employeeId, currentPassword, nextPassword) {
  const policy = validatePasswordPolicy(nextPassword, currentPassword);
  if (!policy.valid) throw new Error(policy.message);

  const { error: loginError } = await signInEmployee(supabase, employeeId, currentPassword);
  if (loginError) throw new Error('현재 비밀번호가 맞지 않습니다.');

  const { error: updateError } = await supabase.auth.updateUser({ password: nextPassword });
  if (updateError) throw updateError;
  await markPasswordChanged(supabase);
}
