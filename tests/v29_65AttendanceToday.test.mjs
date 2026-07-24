import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const attendance = await readFile(new URL('../src/AttendanceModule.jsx', import.meta.url), 'utf8');
const edge = await readFile(new URL('../supabase/functions/attendance-api/index.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260724190000_v29_65_attendance_today_retention.sql', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('?뱀씪 異쒓렐 ?댁뿭? 愿由ъ옄? 理쒓퀬愿由ъ옄?먭쾶留??쒓났?쒕떎', () => {
  assert.match(attendance, /canViewTodayAttendance = user\.role === '愿由ъ옄' \|\| superAdmin/);
  assert.match(edge, /if \(!isAdminLike\(actor\)\) return json\(403/);
  assert.match(edge, /actor\.role === '愿由ъ옄' \|\| isSuperAdmin\(actor\)/);
});

test('?뱀씪 ?댁뿭? ?쒓뎅 ?좎쭨 湲곗??쇰줈 ?ㅻ뒛 湲곕줉留?議고쉶?쒕떎', () => {
  assert.match(edge, /async function todayAttendance/);
  assert.match(edge, /\.eq\('work_date', today\)/);
  assert.match(edge, /\.order\('checked_in_at', \{ ascending: true \}\)/);
  assert.match(attendance, /?ㅻ뒛 異쒓렐/);
  assert.match(attendance, /諛섏쁺 ?꾨즺/);
  assert.match(attendance, /諛섏쁺 以?);
  assert.match(attendance, /諛섏쁺 ?ㅽ뙣/);
});

test('愿由ъ옄???ㅽ뙣??援ш? 洹쇰Т??諛섏쁺???ㅼ떆 ?쒕룄?????덈떎', () => {
  assert.match(edge, /record\.employee_id === actor\.id \|\| isAdminLike\(actor\)/);
  assert.match(attendance, /retry-sheet-sync/);
  assert.match(attendance, /?ㅼ떆 諛섏쁺/);
});

test('?꾩씪 ?뺣━??諛섏쁺 ?꾨즺 湲곕줉留?留ㅼ씪 ?쒓뎅 ?먯젙 ?댄썑 ??젣?쒕떎', () => {
  assert.match(migration, /cron\.schedule/);
  assert.match(migration, /'10 15 \* \* \*'/);
  assert.match(migration, /work_date < \(now\(\) at time zone 'Asia\/Seoul'\)::date/);
  assert.match(migration, /sheet_sync_status = 'synced'/);
  assert.doesNotMatch(migration, /sheet_sync_status\s+in\s*\([^)]*failed/i);
});

test('PC ?쒖? 紐⑤컮??移대뱶???뱀씪 異쒓렐 ?댁뿭??媛곴컖 ?쒓났?쒕떎', () => {
  assert.match(attendance, /attendanceDesktopTable/);
  assert.match(attendance, /attendanceTodayMobile/);
  assert.match(styles, /\.attendanceTodaySummary/);
  assert.match(styles, /\.attendanceSyncBadge\.synced/);
  assert.match(styles, /\.attendanceSyncBadge\.failed/);
});

test('異쒓렐? WiFi瑜?癒쇱? ?뺤씤?섍퀬 ?꾩슂???뚮쭔 GPS瑜??붿껌?쒕떎', () => {
  const checkIn = attendance.match(/async function checkIn\(\)[\s\S]*?async function submitOtherStore/)?.[0] || '';
  assert.match(checkIn, /invokeAttendance\(supabase, \{ action: 'check-in' \}\)/);
  assert.match(checkIn, /const location = await getLocation\(\)/);
  assert.ok(checkIn.indexOf("action: 'check-in'") < checkIn.indexOf('getLocation()'));
  assert.match(checkIn, /alert\('異쒓렐 泥섎━媛 ?꾨즺?섏뿀?듬땲??.'\)/);
});

test('? 留ㅼ옣 ?뱀씤? 異쒓렐 ?꾪솴怨?遺꾨━????쑝濡??쒖떆?쒕떎', () => {
  assert.match(attendance, /\{ key: 'approvals', label: '? 留ㅼ옣 異쒓렐 ?뱀씤', show: canApprove \}/);
  assert.match(attendance, /view === 'approvals' && canApprove/);
});

