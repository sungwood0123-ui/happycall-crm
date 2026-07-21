import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function passwordPolicy(password: string) {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9\s]/.test(password) && !/\s/.test(password);
}

function authEmail(employeeId: string) {
  return `${employeeId}@login.sechan.company`;
}

function randomTemporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const body = [...bytes].map(value => (value % 36).toString(36)).join('');
  return `Sc!${body}7`;
}

async function actorFromRequest(req: Request) {
  const authorization = req.headers.get('Authorization') || '';
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  const { data: employee } = await service
    .from('employees')
    .select('id,name,store_name,status,role,auth_user_id')
    .eq('auth_user_id', user.id)
    .eq('status', '재직')
    .maybeSingle();
  return employee || null;
}

function isAdminLike(actor: { role?: string } | null) {
  return actor?.role === '관리자' || actor?.role === '최고관리자';
}

async function markPasswordChanged(actor: { id: string }) {
  const { error } = await service.from('employees').update({
    password_change_required: false,
    password_changed_at: new Date().toISOString()
  }).eq('id', actor.id);
  return error ? json(500, { error: '비밀번호 변경 상태를 저장하지 못했습니다.' }) : json(200, { completed: true });
}

async function createEmployee(actor: { name: string }, payload: Record<string, unknown>) {
  const employeeId = crypto.randomUUID();
  const temporaryPassword = String(payload.temporary_password || '');
  if (!passwordPolicy(temporaryPassword)) {
    return json(400, { error: '초기 비밀번호는 8자 이상이며 영문, 숫자, 특수문자를 각각 포함해야 합니다.' });
  }
  const role = String(payload.role || '직원');
  if (!['직원', '점장', '검수자', '관리자', '최고관리자'].includes(role)) return json(400, { error: '직원 권한을 확인해주세요.' });
  const status = String(payload.status || '재직');
  if (!['재직', '퇴사', '리스트 제외'].includes(status)) return json(400, { error: '직원 상태를 확인해주세요.' });

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: authEmail(employeeId),
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { employee_id: employeeId, employee_name: String(payload.name || '') }
  });
  if (createError || !created.user) return json(500, { error: '직원 로그인 계정을 만들지 못했습니다.' });

  const { data: employee, error: insertError } = await service.from('employees').insert({
    id: employeeId,
    auth_user_id: created.user.id,
    name: String(payload.name || '').trim(),
    store_name: String(payload.store_name || '').trim(),
    status,
    role,
    hire_date: payload.hire_date || null,
    resign_date: status === '퇴사' ? (payload.resign_date || null) : null,
    happycall_enabled: payload.happycall_enabled !== false,
    happycall_assignment_enabled: payload.happycall_assignment_enabled !== false,
    end_time: String(payload.end_time || '20:00'),
    password_change_required: true
  }).select('id,name,store_name,status,role,hire_date,resign_date,happycall_enabled,happycall_assignment_enabled,end_time,password_change_required').single();

  if (insertError) {
    await service.auth.admin.deleteUser(created.user.id);
    return json(500, { error: '직원 정보를 저장하지 못했습니다.' });
  }

  await service.from('audit_logs').insert({
    action: '직원추가', target_type: 'employee', target_id: employeeId, actor_name: actor.name,
    detail: `${employee.name} / ${employee.store_name} / ${employee.role} / 최초 로그인 시 비밀번호 변경 필요`
  });
  return json(200, { employee });
}

async function resetPassword(actor: { name: string }, employeeId: string) {
  const { data: employee } = await service.from('employees').select('id,name,status,auth_user_id').eq('id', employeeId).maybeSingle();
  if (!employee || employee.status !== '재직' || !employee.auth_user_id) return json(400, { error: '재직 중인 로그인 계정을 확인할 수 없습니다.' });
  const temporaryPassword = randomTemporaryPassword();
  const { error } = await service.auth.admin.updateUserById(employee.auth_user_id, { password: temporaryPassword });
  if (error) return json(500, { error: '임시 비밀번호를 설정하지 못했습니다.' });
  await service.from('employees').update({ password_change_required: true }).eq('id', employee.id);
  await service.from('audit_logs').insert({
    action: '비밀번호초기화', target_type: 'employee', target_id: employee.id, actor_name: actor.name,
    detail: `${employee.name} 임시 비밀번호 발급 / 최초 로그인 시 변경 필요`
  });
  return json(200, { temporary_password: temporaryPassword });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: HEADERS });
  if (req.method !== 'POST') return json(405, { error: '허용되지 않은 요청입니다.' });
  try {
    const actor = await actorFromRequest(req);
    if (!actor) return json(401, { error: '로그인이 필요합니다.' });
    const body = await req.json();
    if (body?.action === 'mark-password-changed') return markPasswordChanged(actor);
    if (!isAdminLike(actor)) return json(403, { error: '관리자 권한이 필요합니다.' });
    if (body?.action === 'create-employee') return createEmployee(actor, body.employee || {});
    if (body?.action === 'reset-password') return resetPassword(actor, String(body.employee_id || ''));
    return json(400, { error: '요청 내용을 확인해주세요.' });
  } catch (error) {
    console.error('employee-account failure', error instanceof Error ? error.message : 'unknown');
    return json(500, { error: '직원 계정 처리 중 오류가 발생했습니다.' });
  }
});
