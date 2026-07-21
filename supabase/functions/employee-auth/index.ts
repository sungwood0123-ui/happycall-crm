import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function passwordPolicy(password: string) {
  return password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9\s]/.test(password) &&
    !/\s/.test(password);
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function authEmail(employeeId: string) {
  return `${employeeId}@login.sechan.company`;
}

const PASSWORD_HASH_ITERATIONS = 210000;

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

async function saveLastUserPassword(employeeId: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_HASH_ITERATIONS },
    key,
    256
  );
  return service.from('employee_password_history').upsert({
    employee_id: employeeId,
    password_hash: bytesToBase64(new Uint8Array(bits)),
    password_salt: bytesToBase64(salt),
    hash_iterations: PASSWORD_HASH_ITERATIONS,
    changed_at: new Date().toISOString()
  }, { onConflict: 'employee_id' });
}

async function constantTimeTextEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = leftHash.length ^ rightHash.length;
  const length = Math.max(leftHash.length, rightHash.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftHash.charCodeAt(index) || 0) ^ (rightHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function clientKey(req: Request, employeeId: string) {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const agent = req.headers.get('user-agent') || 'unknown';
  return sha256(`${employeeId}|${forwarded}|${agent.slice(0, 160)}`);
}

async function createEmployeeAuth(employee: { id: string; name: string }, password: string, passwordChangeRequired: boolean) {
  const email = authEmail(employee.id);
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { employee_id: employee.id, employee_name: employee.name }
  });
  if (createError || !created.user) return { error: createError || new Error('auth user creation failed') };

  const { error: employeeError } = await service.from('employees').update({
    auth_user_id: created.user.id,
    password_change_required: passwordChangeRequired,
    password_changed_at: passwordChangeRequired ? null : new Date().toISOString()
  }).eq('id', employee.id).is('auth_user_id', null);

  if (employeeError) {
    await service.auth.admin.deleteUser(created.user.id);
    return { error: employeeError };
  }

  const { error: historyError } = await saveLastUserPassword(employee.id, password);
  if (historyError) {
    await service.from('employees').update({
      auth_user_id: null,
      password_change_required: true,
      password_changed_at: null
    }).eq('id', employee.id).eq('auth_user_id', created.user.id);
    await service.auth.admin.deleteUser(created.user.id);
    return { error: historyError };
  }

  await service.from('employee_legacy_credentials').delete().eq('employee_id', employee.id);
  return { email, userId: created.user.id };
}

async function beginMigration(req: Request, employeeId: string, password: string) {
  if (!employeeId || !password) return json(400, { error: '직원과 비밀번호를 확인해주세요.' });

  const key = await clientKey(req, employeeId);
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count } = await service
    .from('employee_auth_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('client_key', key)
    .gte('attempted_at', since)
    .eq('succeeded', false);

  if ((count || 0) >= 8) {
    return json(429, { error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' });
  }

  const { data: employee } = await service
    .from('employees')
    .select('id,name,status,auth_user_id')
    .eq('id', employeeId)
    .maybeSingle();

  if (!employee || employee.status !== '재직' || employee.auth_user_id) {
    await service.from('employee_auth_attempts').insert({ employee_id: employee?.id || null, client_key: key, succeeded: false });
    return json(401, { error: '직원 또는 비밀번호가 맞지 않습니다.' });
  }

  const { data: credential } = await service
    .from('employee_legacy_credentials')
    .select('legacy_password')
    .eq('employee_id', employeeId)
    .maybeSingle();

  const matches = credential?.legacy_password
    ? await constantTimeTextEqual(password, credential.legacy_password)
    : false;

  await service.from('employee_auth_attempts').insert({ employee_id: employeeId, client_key: key, succeeded: matches });
  if (!matches) return json(401, { error: '직원 또는 비밀번호가 맞지 않습니다.' });

  if (passwordPolicy(password)) {
    const migrated = await createEmployeeAuth(employee, password, false);
    if (migrated.error) return json(500, { error: '안전한 로그인 계정으로 전환하지 못했습니다. 관리자에게 문의해주세요.' });
    return json(200, { migrated: true, email: migrated.email });
  }

  await service.from('employee_auth_migration_challenges')
    .delete()
    .eq('employee_id', employeeId)
    .is('used_at', null);

  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error } = await service.from('employee_auth_migration_challenges').insert({
    employee_id: employeeId,
    token_hash: tokenHash,
    expires_at: expiresAt
  });
  if (error) return json(500, { error: '비밀번호 변경 준비 중 오류가 발생했습니다.' });

  return json(200, { requires_password_change: true, challenge: token, expires_at: expiresAt });
}

async function completeMigration(challenge: string, newPassword: string) {
  if (!challenge || !passwordPolicy(newPassword)) {
    return json(400, { error: '비밀번호는 8자 이상이며 영문, 숫자, 특수문자를 각각 포함해야 합니다.' });
  }

  const tokenHash = await sha256(challenge);
  const { data: tokenRow } = await service
    .from('employee_auth_migration_challenges')
    .select('id,employee_id,expires_at,used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!tokenRow || tokenRow.used_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
    return json(401, { error: '비밀번호 변경 시간이 만료되었습니다. 다시 로그인해주세요.' });
  }

  const { data: employee } = await service
    .from('employees')
    .select('id,name,status,auth_user_id')
    .eq('id', tokenRow.employee_id)
    .maybeSingle();
  if (!employee || employee.status !== '재직' || employee.auth_user_id) {
    return json(401, { error: '비밀번호 변경 권한을 확인할 수 없습니다.' });
  }

  const created = await createEmployeeAuth(employee, newPassword, false);
  if (created.error) {
    return json(500, { error: '새 로그인 계정을 만들지 못했습니다. 관리자에게 문의해주세요.' });
  }

  await service.from('employee_auth_migration_challenges').update({ used_at: new Date().toISOString() }).eq('id', tokenRow.id);

  return json(200, { completed: true, email: created.email });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json(405, { error: '허용되지 않은 요청입니다.' });

  try {
    const body = await req.json();
    if (body?.action === 'begin-migration') {
      return beginMigration(req, String(body.employee_id || ''), String(body.password || ''));
    }
    if (body?.action === 'complete-migration') {
      return completeMigration(String(body.challenge || ''), String(body.new_password || ''));
    }
    return json(400, { error: '요청 내용을 확인해주세요.' });
  } catch (error) {
    console.error('employee-auth failure', error instanceof Error ? error.message : 'unknown');
    return json(500, { error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});
