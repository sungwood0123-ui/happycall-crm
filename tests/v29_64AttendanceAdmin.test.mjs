Exit code: 0
Wall time: 0.9 seconds
Output:
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const attendanceSource = fs.readFileSync(new URL('../src/AttendanceModule.jsx', import.meta.url), 'utf8');
const edgeSource = fs.readFileSync(new URL('../supabase/functions/attendance-api/index.ts', import.meta.url), 'utf8');
const migrationSource = fs.readFileSync(new URL('../supabase/migrations/20260723090000_v29_64_office_attendance_address.sql', import.meta.url), 'utf8');

test('기능 권한 화면은 직원 목록과 일괄 적용을 제공한다', () => {
  assert.match(attendanceSource, /직원별 기능 설정/);
  assert.match(attendanceSource, /선택 직원 일괄 적용/);
  assert.match(attendanceSource, /save-feature-overrides/);
});

test('출근 위치는 주소·지도·현재 위치 선택을 제공한다', () => {
  assert.match(attendanceSource, /매장 주소/);
  assert.match(attendanceSource, /주소 찾기/);
  assert.match(attendanceSource, /현재 위치로 지정/);
  assert.match(attendanceSource, /attendanceMap/);
});

test('사무실 출근 장소와 주소 저장을 위한 서버 변경이 포함된다', () => {
  assert.match(migrationSource, /'사무실', '운영중'/);
  assert.match(migrationSource, /add column if not exists address text/);
  assert.match(edgeSource, /address: String\(payload\.address/);
  assert.match(edgeSource, /saveFeatureOverrides/);
});

