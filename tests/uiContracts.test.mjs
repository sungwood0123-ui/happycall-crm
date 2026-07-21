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

test('휴무 고객응대 임시 진행은 2·3단계에서 전체 취소할 수 있다', () => {
  assert.match(main, /async function cancelHolidayDraft\(\)/);
  assert.match(main, /\.eq\('employee_id', user\.id\)/);
  assert.match(main, /\.eq\('status', '임시저장'\)/);
  assert.equal((main.match(/onClick=\{cancelHolidayDraft\}/g) || []).length, 2);
  assert.match(styles, /\.holidayDraftCancelButton\{/);
});

test('all date and time controls use the shared responsive UI contract', () => {
  const controls = main.split(/\r?\n/).filter(line => /type="(?:date|time)"/.test(line));
  assert.ok(controls.length > 0);
  for (const control of controls) assert.match(control, /uiDateTimeInput/);

  assert.match(styles, /\.uiDateTimeInput\{/);
  assert.match(styles, /min-inline-size:0 !important;/);
  assert.match(styles, /max-inline-size:100% !important;/);
  assert.match(styles, /\.uiDateTimeInput::\-webkit-date-and-time-value/);
  assert.match(styles, /\.scheduleEditBox\{[\s\S]*?grid-template-columns:minmax\(0,1fr\) !important;/);
  assert.match(styles, /\.accrualRequestCard \.accrualCompactFields\{[\s\S]*?grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\) !important;/);
});

test('프리패스 일괄 처리 버튼은 직원별 개별 적용 오른쪽의 같은 조작 영역에 있다', () => {
  assert.match(main, /<div className="bulkExecutionControls">[\s\S]*?직원별 개별 적용[\s\S]*?<button[^>]*className="primary bulkApplyButton"[^>]*>일괄 처리 적용<\/button>[\s\S]*?<\/div>/);
  assert.match(styles, /\.bulkExecutionControls\{[\s\S]*?grid-template-columns:minmax\(190px,1fr\) auto !important;/);
  assert.match(styles, /@media\(max-width:768px\)\{[\s\S]*?\.bulkExecutionControls\{[\s\S]*?grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\) !important;/);
});

test('모바일 체크 선택 영역은 문구와 조작 요소가 시각적으로 균형을 이룬다', () => {
  assert.match(main, /className="rememberLoginCopy"/);
  assert.match(main, /className="rememberLoginControl"/);
  assert.match(styles, /\.rememberLoginOption\{[\s\S]*?justify-content:space-between!important;/);
  assert.match(main, /className="minorCheckLabel"[\s\S]*?<span>미성년자<\/span><span className="minorCheckSpacer"/);
  assert.match(styles, /\.minorCheckLabel\{[\s\S]*?grid-template-columns:20px minmax\(0, 1fr\) 20px !important;/);
  assert.equal((styles.match(/(?:^|\n)\.minorCheckLabel\{/g) || []).length, 1);
});
