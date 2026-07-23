Exit code: 0
Wall time: 0.8 seconds
Output:
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SHEET_ID = Deno.env.get('ATTENDANCE_SPREADSHEET_ID') || '';
const GOOGLE_EMAIL = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL') || '';
const GOOGLE_PRIVATE_KEY = (Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

type Employee = { id: string; name: string; store_name: string; status: string; role: string; auth_user_id: string };
type Store = { id: string; name: string; status?: string };

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function kstParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour),
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day)
  };
}

function normalize(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, '').replace(/점$/, '');
}

function isDayOff(value: unknown) {
  const normalized = normalize(value);
  return /^(휴무|후무|유휴\d*|유후\d*|연차\d*|월차\d*|당직휴무|휴가|X)$/i.test(normalized);
}

function clientIp(req: Request) {
  const raw = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0] || '';
  return raw.trim().replace(/^::ffff:/, '');
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function actorFromRequest(req: Request): Promise<Employee | null> {
  const authorization = req.headers.get('Authorization') || '';
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  const { data } = await service.from('employees')
    .select('id,name,store_name,status,role,auth_user_id')
    .eq('auth_user_id', user.id).eq('status', '재직').maybeSingle();
  return data as Employee | null;
}

function isSuperAdmin(actor: Employee) { return actor.role === '최고관리자'; }
function isManager(actor: Employee) { return actor.role === '점장'; }

async function storeByName(name: string): Promise<Store | null> {
  const { data } = await service.from('stores').select('id,name,status').eq('name', name).maybeSingle();
  return data as Store | null;
}

async function canUseFeature(actor: Employee, featureKey: string) {
  const store = await storeByName(actor.store_name);
  const { data: employeeOverride } = await service.from('feature_access_overrides')
    .select('enabled').eq('scope_type', 'employee').eq('employee_id', actor.id).eq('feature_key', featureKey).maybeSingle();
  if (typeof employeeOverride?.enabled === 'boolean') return employeeOverride.enabled;
  if (store) {
    const { data: storeOverride } = await service.from('feature_access_overrides')
      .select('enabled').eq('scope_type', 'store').eq('store_id', store.id).eq('feature_key', featureKey).maybeSingle();
    if (typeof storeOverride?.enabled === 'boolean') return storeOverride.enabled;
  }
  return featureKey !== 'attendance';
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function googleAccessToken() {
  if (!SHEET_ID || !GOOGLE_EMAIL || !GOOGLE_PRIVATE_KEY) throw new Error('근무표 자동 연동 준비가 완료되지 않았습니다.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: GOOGLE_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })));
  const binary = atob(GOOGLE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''));
  const key = await crypto.subtle.importKey(
    'pkcs8', Uint8Array.from(binary, char => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const assertion = `${header}.${claim}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error('근무표 연결 계정을 확인할 수 없습니다.');
  return payload.access_token as string;
}

function sheetCandidates(year: number, month: number) {
  const yy = String(year).slice(-2);
  return [`${yy}년${month}월`, `${yy}년 ${month}월`];
}

function columnForDay(day: number) {
  let number = 7 + day - 1;
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function sheetColumnFromIndex(indexInBToAk: number) {
  let number = indexInBToAk + 2; // B:AK 범위의 index 0은 실제 B열이다.
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function dayFromSheetHeader(value: unknown) {
  const matches = String(value || '').match(/\d+/g);
  if (!matches?.length) return null;
  const day = Number(matches[matches.length - 1]);
  return day >= 1 && day <= 31 ? day : null;
}

async function readSheetRange(token: string, range: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 400 || response.status === 404) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error('근무표를 읽지 못했습니다.');
  return (payload.values || []) as string[][];
}

async function resolveSchedule(actor: Employee, workDate: string) {
  const [year, month, day] = workDate.split('-').map(Number);
  const token = await googleAccessToken();
  for (const sheetName of sheetCandidates(year, month)) {
    const values = await readSheetRange(token, `'${sheetName}'!B:AK`);
    if (!values) continue;
    const { data: saved } = await service.from('attendance_sheet_employee_mappings')
      .select('sheet_row').eq('employee_id', actor.id).eq('sheet_name', sheetName).maybeSingle();
    let sheetRow = Number(saved?.sheet_row || 0);
    if (!sheetRow) {
      const matches: number[] = [];
      values.forEach((row, index) => {
        if (normalize(row[0]) === normalize(actor.store_name) && normalize(row[1]) === normalize(actor.name)) matches.push(index + 1);
      });
      if (matches.length !== 1) throw new Error(matches.length ? '근무표에서 같은 직원이 중복되어 있습니다.' : '근무표에서 본인 이름과 매장을 찾지 못했습니다.');
      sheetRow = matches[0];
      await service.from('attendance_sheet_employee_mappings').upsert({
        employee_id: actor.id, sheet_name: sheetName, sheet_row: sheetRow,
        employee_name_snapshot: actor.name, store_name_snapshot: actor.store_name,
        verified_at: new Date().toISOString()
      }, { onConflict: 'employee_id,sheet_name' });
    }
    const row = values[sheetRow - 1] || [];
    const dateHeader = values[2] || []; // 스프레드시트 3행의 날짜를 실제 기준으로 사용한다.
    const dateColumnIndex = dateHeader.findIndex((value, index) => index >= 5 && dayFromSheetHeader(value) === day);
    if (dateColumnIndex < 0) throw new Error(`근무표 3행에서 ${month}월 ${day}일 열을 찾지 못했습니다.`);
    const sourceCell = `${sheetColumnFromIndex(dateColumnIndex)}${sheetRow}`;
    const value = String(row[dateColumnIndex] || '').trim();
    await service.from('attendance_schedule_entries').upsert({
      employee_id: actor.id, work_date: workDate, sheet_value: value,
      is_day_off: isDayOff(value), source_sheet: sheetName,
      source_cell: sourceCell, synced_at: new Date().toISOString()
    }, { onConflict: 'employee_id,work_date' });
    return { token, sheetName, sheetRow, cell: sourceCell, value, dayOff: isDayOff(value) };
  }
  throw new Error('해당 월의 근무표 탭을 찾지 못했습니다.');
}

async function writeCheckinToSheet(token: string, sheetName: string, cell: string, checkedInAt: string) {
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(checkedInAt));
  const range = `'${sheetName}'!${cell}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const response = await fetch(url, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, majorDimension: 'ROWS', values: [[time]] })
  });
  if (!response.ok) throw new Error('출근 기록은 저장됐지만 근무표 반영이 지연되고 있습니다.');
}

async function effectiveCheckinStores(actor: Employee, workDate: string) {
  const home = await storeByName(actor.store_name);
  if (!home) throw new Error('직원의 현재 매장을 찾지 못했습니다.');
  const { data: approved } = await service.from('attendance_other_store_requests')
    .select('*').eq('employee_id', actor.id).eq('work_date', workDate).eq('status', 'approved').maybeSingle();
  const stores: Store[] = [home];
  if (approved) stores.push({ id: approved.destination_store_id, name: approved.destination_store_name });
  return { home, approved, stores };
}

async function checkVerification(req: Request, stores: Store[], payload: Record<string, unknown>) {
  const ip = clientIp(req);
  const storeIds = stores.map(store => store.id);
  const [{ data: settings }, { data: ips }] = await Promise.all([
    service.from('store_attendance_settings').select('*').in('store_id', storeIds),
    service.from('store_attendance_ips').select('store_id,ip_address').in('store_id', storeIds).eq('active', true)
  ]);
  for (const store of stores) {
    const setting = (settings || []).find(item => item.store_id === store.id);
    if (!setting?.enabled) continue;
    const wifiOk = (ips || []).some(item => item.store_id === store.id && String(item.ip_address) === ip);
    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    const accuracy = Math.round(Number(payload.accuracy || 0));
    const hasGps = Number.isFinite(latitude) && Number.isFinite(longitude) && setting.latitude != null && setting.longitude != null;
    const distance = hasGps ? distanceMeters(latitude, longitude, Number(setting.latitude), Number(setting.longitude)) : null;
    const gpsOk = hasGps && accuracy > 0 && accuracy <= Math.max(200, Number(setting.radius_meters)) && Number(distance) <= Number(setting.radius_meters);
    const accepted = setting.auth_mode === 'wifi' ? wifiOk : setting.auth_mode === 'gps' ? gpsOk : wifiOk || gpsOk;
    if (accepted) return { store, method: wifiOk ? 'wifi' : 'gps', ip: ip || null, distance, accuracy: gpsOk ? accuracy : null };
  }
  throw new Error('현재 연결된 WiFi 또는 위치가 출근 가능한 매장과 일치하지 않습니다.');
}

async function currentStatus(actor: Employee) {
  const today = kstParts().date;
  const enabled = await canUseFeature(actor, 'attendance');
  const [{ data: record }, { data: requests }, { data: history }] = await Promise.all([
    service.from('attendance_records').select('*').eq('employee_id', actor.id).eq('work_date', today).maybeSingle(),
    service.from('attendance_other_store_requests').select('*').eq('employee_id', actor.id).gte('work_date', today).order('work_date'),
    service.from('attendance_records').select('*').eq('employee_id', actor.id).order('work_date', { ascending: false }).limit(31)
  ]);
  let schedule = null;
  let scheduleError = '';
  if (enabled && !record) {
    try { schedule = await resolveSchedule(actor, today); }
    catch (error) { scheduleError = error instanceof Error ? error.message : '근무표를 확인하지 못했습니다.'; }
  }
  const { data: stores } = await service.from('stores').select('id,name,status').neq('status', '폐점').order('name');
  return { enabled, today, record, requests: requests || [], history: history || [], stores: stores || [], schedule: schedule ? { sheetName: schedule.sheetName, cell: schedule.cell, value: schedule.value, dayOff: schedule.dayOff } : null, scheduleError };
}

async function managerPending(actor: Employee) {
  if (!isManager(actor) && !isSuperAdmin(actor)) return json(403, { error: '점장 또는 최고관리자만 확인할 수 있습니다.' });
  let query = service.from('attendance_other_store_requests').select('*').eq('status', 'pending').order('work_date');
  if (!isSuperAdmin(actor)) query = query.eq('home_store_name', actor.store_name).neq('employee_id', actor.id);
  const { data, error } = await query;
  if (error) throw error;
  return json(200, { requests: data || [] });
}

async function checkIn(req: Request, actor: Employee, payload: Record<string, unknown>) {
  if (!await canUseFeature(actor, 'attendance')) return json(403, { error: '근무 기능 사용 권한이 없습니다.' });
  const today = kstParts().date;
  const { data: existing } = await service.from('attendance_records').select('*').eq('employee_id', actor.id).eq('work_date', today).maybeSingle();
  if (existing) return json(409, { error: '오늘 출근 처리가 이미 완료되었습니다.', record: existing });
  const schedule = await resolveSchedule(actor, today);
  if (schedule.dayOff) return json(409, { error: `오늘 근무표가 '${schedule.value}'로 등록되어 있어 출근 처리할 수 없습니다.` });
  if (schedule.value && /^\d{1,2}:\d{2}/.test(schedule.value)) return json(409, { error: '근무표에 이미 출근 시간이 기록되어 있습니다. 관리자에게 확인해주세요.' });
  const allowed = await effectiveCheckinStores(actor, today);
  const verification = await checkVerification(req, allowed.stores, payload);
  const nowIso = new Date().toISOString();
  const request = allowed.approved && verification.store.id === allowed.approved.destination_store_id ? allowed.approved : null;
  const { data: record, error } = await service.from('attendance_records').insert({
    employee_id: actor.id, employee_name: actor.name, work_date: today,
    home_store_id: allowed.home.id, home_store_name: allowed.home.name,
    checkin_store_id: verification.store.id, checkin_store_name: verification.store.name,
    checked_in_at: nowIso, verification_method: verification.method,
    client_ip: verification.ip, distance_meters: verification.distance,
    gps_accuracy_meters: verification.accuracy, other_store_request_id: request?.id || null,
    sheet_sync_status: 'pending', sheet_name: schedule.sheetName, sheet_cell: schedule.cell
  }).select('*').single();
  if (error) {
    if (error.code === '23505') return json(409, { error: '오늘 출근 처리가 이미 완료되었습니다.' });
    throw error;
  }
  if (request) await service.from('attendance_other_store_requests').update({ status: 'used', used_at: nowIso, updated_at: nowIso }).eq('id', request.id).eq('status', 'approved');
  try {
    await writeCheckinToSheet(schedule.token, schedule.sheetName, schedule.cell, nowIso);
    await service.from('attendance_records').update({ sheet_sync_status: 'synced', sheet_sync_attempts: 1, sheet_synced_at: new Date().toISOString(), sheet_sync_error: null }).eq('id', record.id);
  } catch (sheetError) {
    await service.from('attendance_records').update({ sheet_sync_status: 'failed', sheet_sync_attempts: 1, sheet_sync_error: sheetError instanceof Error ? sheetError.message : '근무표 반영 실패' }).eq('id', record.id);
  }
  await service.from('audit_logs').insert({ action: '출근처리', target_type: 'attendance_record', target_id: record.id, actor_name: actor.name, detail: `${today} / ${verification.store.name} / ${verification.method}` });
  return json(200, { completed: true, record });
}

async function retrySheetSync(actor: Employee, payload: Record<string, unknown>) {
  const recordId = String(payload.record_id || '');
  const { data: record } = await service.from('attendance_records').select('*').eq('id', recordId).maybeSingle();
  if (!record) return json(404, { error: '다시 반영할 출근 기록을 찾지 못했습니다.' });
  const allowed = record.employee_id === actor.id || isSuperAdmin(actor);
  if (!allowed) return json(403, { error: '본인의 출근 기록만 다시 반영할 수 있습니다.' });
  if (record.sheet_sync_status === 'synced') return json(200, { completed: true, record });
  if (!record.sheet_name || !record.sheet_cell) return json(409, { error: '근무표 위치 정보가 없어 최고관리자 확인이 필요합니다.' });

  try {
    const token = await googleAccessToken();
    const current = await readSheetRange(token, `'${record.sheet_name}'!${record.sheet_cell}`);
    const currentValue = String(current?.[0]?.[0] || '').trim();
    if (isDayOff(currentValue)) return json(409, { error: `근무표가 '${currentValue}'로 변경되어 자동 반영할 수 없습니다.` });
    if (currentValue && /^\d{1,2}:\d{2}/.test(currentValue)) {
      await service.from('attendance_records').update({
        sheet_sync_status: 'synced', sheet_sync_attempts: Number(record.sheet_sync_attempts || 0) + 1,
        sheet_synced_at: new Date().toISOString(), sheet_sync_error: null
      }).eq('id', record.id);
      return json(200, { completed: true });
    }
    await writeCheckinToSheet(token, record.sheet_name, record.sheet_cell, record.checked_in_at);
    await service.from('attendance_records').update({
      sheet_sync_status: 'synced', sheet_sync_attempts: Number(record.sheet_sync_attempts || 0) + 1,
      sheet_synced_at: new Date().toISOString(), sheet_sync_error: null
    }).eq('id', record.id);
    await service.from('audit_logs').insert({
      action: '출근근무표재반영', target_type: 'attendance_record', target_id: record.id,
      actor_name: actor.name, detail: `${record.work_date} / ${record.employee_name}`
    });
    return json(200, { completed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '근무표 반영에 실패했습니다.';
    await service.from('attendance_records').update({
      sheet_sync_status: 'failed', sheet_sync_attempts: Number(record.sheet_sync_attempts || 0) + 1,
      sheet_sync_error: message
    }).eq('id', record.id);
    return json(502, { error: message });
  }
}

async function requestOtherStore(actor: Employee, payload: Record<string, unknown>) {
  if (!await canUseFeature(actor, 'attendance')) return json(403, { error: '근무 기능 사용 권한이 없습니다.' });
  const workDate = String(payload.work_date || '');
  const reason = String(payload.reason || '').trim();
  const destinationId = String(payload.destination_store_id || '');
  const kst = kstParts();
  if (workDate < kst.date) return json(400, { error: '지난 날짜의 타 매장 출근은 요청할 수 없습니다.' });
  if (workDate === kst.date && kst.hour >= 12) return json(400, { error: '오늘 출근할 타 매장 요청은 낮 12시 이후 승인되지 않습니다. 다음 근무일을 선택해주세요.' });
  if (reason.length < 2) return json(400, { error: '타 매장 출근 사유를 입력해주세요.' });
  const [home, destination] = await Promise.all([storeByName(actor.store_name), service.from('stores').select('id,name,status').eq('id', destinationId).maybeSingle()]);
  if (!home || !destination.data || destination.data.status === '폐점') return json(400, { error: '매장 정보를 확인해주세요.' });
  if (home.id === destination.data.id) return json(400, { error: '현재 소속 매장이 아닌 타 매장을 선택해주세요.' });
  const { data, error } = await service.from('attendance_other_store_requests').insert({
    employee_id: actor.id, employee_name: actor.name, work_date: workDate,
    home_store_id: home.id, home_store_name: home.name,
    destination_store_id: destination.data.id, destination_store_name: destination.data.name,
    reason
  }).select('*').single();
  if (error?.code === '23505') return json(409, { error: '해당 날짜에 이미 진행 중인 타 매장 출근 요청이 있습니다.' });
  if (error) throw error;
  await service.from('audit_logs').insert({ action: '타매장출근요청', target_type: 'attendance_other_store_request', target_id: data.id, actor_name: actor.name, detail: `${workDate} / ${home.name} → ${destination.data.name}` });
  return json(200, { completed: true, request: data });
}

async function cancelRequest(actor: Employee, payload: Record<string, unknown>) {
  const id = String(payload.request_id || '');
  const { data: request } = await service.from('attendance_other_store_requests').select('*').eq('id', id).maybeSingle();
  if (!request || request.employee_id !== actor.id || !['pending', 'approved'].includes(request.status)) return json(403, { error: '취소할 수 있는 요청이 아닙니다.' });
  if (request.work_date < kstParts().date) return json(409, { error: '지난 요청은 취소할 수 없습니다.' });
  await service.from('attendance_other_store_requests').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
  return json(200, { completed: true });
}

async function decideRequest(actor: Employee, payload: Record<string, unknown>) {
  const id = String(payload.request_id || '');
  const decision = String(payload.decision || '');
  if (!['approved', 'rejected'].includes(decision)) return json(400, { error: '승인 또는 반려를 선택해주세요.' });
  const { data: request } = await service.from('attendance_other_store_requests').select('*').eq('id', id).eq('status', 'pending').maybeSingle();
  if (!request) return json(404, { error: '처리할 요청을 찾지 못했습니다.' });
  const ownManagerRequest = request.employee_id === actor.id && isManager(actor);
  const allowed = isSuperAdmin(actor) || (isManager(actor) && !ownManagerRequest && request.home_store_name === actor.store_name);
  if (!allowed) return json(403, { error: ownManagerRequest ? '점장 본인의 요청은 최고관리자만 승인할 수 있습니다.' : '현재 소속 매장 요청만 처리할 수 있습니다.' });
  const nowIso = new Date().toISOString();
  await service.from('attendance_other_store_requests').update({
    status: decision, decided_by: actor.id, decided_by_name: actor.name,
    decided_at: nowIso, decision_note: String(payload.note || '').trim(), updated_at: nowIso
  }).eq('id', id).eq('status', 'pending');
  await service.from('audit_logs').insert({ action: decision === 'approved' ? '타매장출근승인' : '타매장출근반려', target_type: 'attendance_other_store_request', target_id: id, actor_name: actor.name, detail: `${request.employee_name} / ${request.work_date} / ${request.destination_store_name}` });
  return json(200, { completed: true });
}

async function adminData(req: Request, actor: Employee) {
  if (!isSuperAdmin(actor)) return json(403, { error: '최고관리자만 사용할 수 있습니다.' });
  const [{ data: employees }, { data: stores }, { data: overrides }, { data: settings }, { data: ips }, { data: pending }] = await Promise.all([
    service.from('employees').select('id,name,store_name,status,role').eq('status', '재직').order('store_name').order('name'),
    service.from('stores').select('id,name,status').neq('status', '폐점').order('name'),
    service.from('feature_access_overrides').select('*'),
    service.from('store_attendance_settings').select('*'),
    service.from('store_attendance_ips').select('*').order('created_at'),
    service.from('attendance_other_store_requests').select('*').eq('status', 'pending').order('work_date')
  ]);
  return json(200, { employees: employees || [], stores: stores || [], overrides: overrides || [], settings: settings || [], ips: ips || [], pending: pending || [], current_ip: clientIp(req) });
}

async function saveFeatureOverride(actor: Employee, payload: Record<string, unknown>) {
  if (!isSuperAdmin(actor)) return json(403, { error: '최고관리자만 사용할 수 있습니다.' });
  const scopeType = String(payload.scope_type || '');
  const featureKey = String(payload.feature_key || '');
  const targetId = String(payload.target_id || '');
  const mode = String(payload.mode || 'inherit');
  if (!['employee', 'store'].includes(scopeType) || !['happycall', 'freepass', 'accessories', 'attendance'].includes(featureKey)) return json(400, { error: '권한 설정값을 확인해주세요.' });
  const query = service.from('feature_access_overrides').delete().eq('scope_type', scopeType).eq('feature_key', featureKey).eq(scopeType === 'employee' ? 'employee_id' : 'store_id', targetId);
  const { error: deleteError } = await query;
  if (deleteError) throw deleteError;
  if (mode !== 'inherit') {
    const row: Record<string, unknown> = { scope_type: scopeType, feature_key: featureKey, enabled: mode === 'enabled', updated_by: actor.id, updated_at: new Date().toISOString() };
    row[scopeType === 'employee' ? 'employee_id' : 'store_id'] = targetId;
    const { error } = await service.from('feature_access_overrides').insert(row);
    if (error) throw error;
  }
  await service.from('audit_logs').insert({ action: '기능사용권한변경', target_type: scopeType, target_id: targetId, actor_name: actor.name, detail: `${featureKey} / ${mode}` });
  return json(200, { completed: true });
}

async function saveFeatureOverrides(actor: Employee, payload: Record<string, unknown>) {
  if (!isSuperAdmin(actor)) return json(403, { error: '최고관리자만 사용할 수 있습니다.' });
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (!changes.length || changes.length > 200) return json(400, { error: '저장할 권한 변경사항을 확인해주세요.' });
  const featureKeys = ['happycall', 'freepass', 'accessories', 'attendance'];
  const modes = ['inherit', 'enabled', 'disabled'];
  for (const change of changes) {
    const targetId = String(change?.target_id || '');
    const featureKey = String(change?.feature_key || '');
    const mode = String(change?.mode || '');
    if (!targetId || !featureKeys.includes(featureKey) || !modes.includes(mode)) {
      return json(400, { error: '권한 설정값을 확인해주세요.' });
    }
  }
  const targetIds = [...new Set(changes.map(change => String(change.target_id)))];
  const { data: employees, error: employeeError } = await service.from('employees')
    .select('id').in('id', targetIds).eq('status', '재직');
  if (employeeError) throw employeeError;
  if ((employees || []).length !== targetIds.length) return json(400, { error: '재직 중인 직원만 설정할 수 있습니다.' });

  for (const change of changes) {
    const targetId = String(change.target_id);
    const featureKey = String(change.feature_key);
    const mode = String(change.mode);
    const { error: deleteError } = await service.from('feature_access_overrides').delete()
      .eq('scope_type', 'employee').eq('feature_key', featureKey).eq('employee_id', targetId);
    if (deleteError) throw deleteError;
    if (mode !== 'inherit') {
      const { error } = await service.from('feature_access_overrides').insert({
        scope_type: 'employee', employee_id: targetId, feature_key: featureKey,
        enabled: mode === 'enabled', updated_by: actor.id, updated_at: new Date().toISOString()
      });
      if (error) throw error;
    }
  }
  await service.from('audit_logs').insert({
    action: '기능사용권한일괄변경', target_type: 'employee', target_id: actor.id,
    actor_name: actor.name, detail: `${targetIds.length}명 / ${changes.length}개 설정`
  });
  return json(200, { completed: true, changed: changes.length });
}

async function saveStoreSetting(actor: Employee, payload: Record<string, unknown>) {
  if (!isSuperAdmin(actor)) return json(403, { error: '최고관리자만 사용할 수 있습니다.' });
  const storeId = String(payload.store_id || '');
    const row = {
      store_id: storeId, enabled: Boolean(payload.enabled), auth_mode: String(payload.auth_mode || 'either'),
      address: String(payload.address || '').trim() || null,
      latitude: payload.latitude === '' || payload.latitude == null ? null : Number(payload.latitude),
    longitude: payload.longitude === '' || payload.longitude == null ? null : Number(payload.longitude),
    radius_meters: Math.round(Number(payload.radius_meters || 100)),
    default_start_time: payload.default_start_time || null, updated_by: actor.id, updated_at: new Date().toISOString()
  };
  const { error } = await service.from('store_attendance_settings').upsert(row, { onConflict: 'store_id' });
  if (error) throw error;
  await service.from('store_attendance_ips').delete().eq('store_id', storeId);
  const ips = [...new Set((Array.isArray(payload.ips) ? payload.ips : []).map(value => String(value).trim()).filter(Boolean))];
  if (ips.length) {
    const { error: ipError } = await service.from('store_attendance_ips').insert(ips.map(ip => ({ store_id: storeId, ip_address: ip, created_by: actor.id })));
    if (ipError) throw ipError;
  }
  await service.from('audit_logs').insert({ action: '매장출근인증설정', target_type: 'store', target_id: storeId, actor_name: actor.name, detail: `${row.auth_mode} / 반경 ${row.radius_meters}m / IP ${ips.length}개` });
  return json(200, { completed: true });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: HEADERS });
  if (req.method !== 'POST') return json(405, { error: '지원하지 않는 요청입니다.' });
  const actor = await actorFromRequest(req);
  if (!actor) return json(401, { error: '로그인이 만료되었거나 퇴사 처리된 계정입니다.' });
  try {
    const payload = await req.json().catch(() => ({}));
    const action = String(payload.action || '');
    if (action === 'current-status') return json(200, await currentStatus(actor));
    if (action === 'manager-pending') return await managerPending(actor);
    if (action === 'check-in') return await checkIn(req, actor, payload);
    if (action === 'retry-sheet-sync') return await retrySheetSync(actor, payload);
    if (action === 'request-other-store') return await requestOtherStore(actor, payload);
    if (action === 'cancel-request') return await cancelRequest(actor, payload);
    if (action === 'decide-request') return await decideRequest(actor, payload);
      if (action === 'admin-data') return await adminData(req, actor);
      if (action === 'save-feature-override') return await saveFeatureOverride(actor, payload);
      if (action === 'save-feature-overrides') return await saveFeatureOverrides(actor, payload);
      if (action === 'save-store-setting') return await saveStoreSetting(actor, payload);
    return json(400, { error: '요청 내용을 확인해주세요.' });
  } catch (error) {
    console.error('attendance-api failed', error);
    return json(500, { error: error instanceof Error ? error.message : '근무 기능 처리 중 오류가 발생했습니다.' });
  }
});

