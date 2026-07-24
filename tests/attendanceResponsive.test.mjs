import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/AttendanceModule.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('근무 이력은 PC 표와 모바일 카드가 분리된다', () => {
  assert.match(source, /attendanceDesktopTable/);
  assert.match(source, /attendanceMobileList/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.attendanceDesktopTable \{ display: none; \}[\s\S]*\.attendanceMobileList \{ display: grid/);
});

test('근무 입력칸과 카드는 좁은 화면에서도 화면 밖으로 나가지 않는다', () => {
  assert.match(styles, /\.attendancePage,\s*\.attendancePage \* \{ box-sizing: border-box; \}/);
  assert.match(styles, /\.attendanceForm input,[\s\S]*width: 100%; min-width: 0;/);
  assert.match(styles, /@media \(max-width: 430px\)/);
  assert.match(styles, /@media \(max-width: 340px\)/);
});

test('근무 조회는 로딩 후 데이터 또는 빈 상태를 표시한다', () => {
  assert.match(source, /if \(loading\) return[\s\S]*<LoadingState/);
  assert.match(source, /<EmptyState>/);
  assert.match(source, /attendanceState/);
});

test('근무표 반영 실패는 PC와 모바일 모두 다시 시도할 수 있다', () => {
  const buttons = source.match(/retrySheetSync\(record\.id\)/g) || [];
  assert.equal(buttons.length, 4);
  assert.match(styles, /\.attendanceRetry[\s\S]*white-space: nowrap/);
});
