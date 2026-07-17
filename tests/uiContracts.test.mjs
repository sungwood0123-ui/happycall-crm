import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('조회 화면은 로딩 종료 후에만 빈 상태를 표시한다', () => {
  assert.match(main, /if \(loading\) return <InlineLoadingState \/>;/);
  assert.match(main, /!loading && !rows\.length && <EmptyStateText>등록된 재입사\/퇴사 기록이 없습니다\.<\/EmptyStateText>/);
  assert.match(main, /!loading && !filteredLogs\.length && <tr>/);
  assert.match(main, /loading \? \(\s*<div className="sectionCard pageLoadingPanel"><InlineLoadingState \/><\/div>/);
});

test('모바일 목록은 카드형을 사용하고 PC 표와 분리한다', () => {
  for (const className of [
    'reviewMobileList',
    'assignmentMobileRows',
    'storeMobileList',
    'rehireHistoryMobileList',
    'freepassBulkMobileList',
    'freepassResetMobileList',
    'managerEmployeeMobileList',
    'managerCallsMobileList'
  ]) assert.match(main, new RegExp(className));

  assert.match(styles, /\.desktopReviewListCard,/);
  assert.match(styles, /\.assignmentTableWrap,/);
  assert.match(styles, /\.freepassModule table\.desktopFreepassBulkTable,/);
  assert.match(styles, /display:none !important;/);
});

test('적립 신청정보는 불필요한 바깥 박스를 사용하지 않는다', () => {
  assert.match(styles, /\.accrualRequestCard \.accrualCompactFields\{[\s\S]*?background:transparent !important;[\s\S]*?border:0 !important;[\s\S]*?box-shadow:none !important;/);
  assert.match(styles, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\) !important;/);
});

test('감사로그는 한 번에 100건씩 표시한다', () => {
  assert.match(main, /const pageSize = 100;/);
  assert.match(main, /const pageLogs = filteredLogs\.slice/);
  assert.match(main, /pageLogs\.map\(l =>/);
});
