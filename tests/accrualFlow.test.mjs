import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accrualHistoryRows,
  findHolidayAccrualDraft,
  holidayAccrualStep,
  normalizeAccrualTypeValue
} from '../src/accrualFlow.js';

test('휴무 고객응대는 저장 상태에 따라 1·2·3단계로 이어진다', () => {
  assert.equal(holidayAccrualStep(null, []), 1);
  assert.equal(holidayAccrualStep({ id: 'draft' }, [{ type: '응대 시작' }]), 2);
  assert.equal(holidayAccrualStep({ id: 'draft' }, [{ type: '응대 시작' }, { type: '응대 종료' }]), 3);
});

test('기존 휴무출근 적립 임시저장도 진행 중 요청으로 이어서 처리한다', () => {
  const draft = findHolidayAccrualDraft([
    { id: 'done', request_type: '고객 추가 응대', status: '승인완료' },
    { id: 'legacy', request_type: '휴무출근 적립', status: '임시저장' }
  ]);
  assert.equal(draft?.id, 'legacy');
  assert.equal(normalizeAccrualTypeValue(draft?.request_type), '휴무 고객응대');
});

test('진행 중 휴무 고객응대는 완료 이력 목록에 중복 표시하지 않는다', () => {
  const history = accrualHistoryRows([
    { id: 'draft', request_type: '휴무 고객응대', status: '임시저장' },
    { id: 'done', request_type: '휴무 고객응대', status: '최종승인대기' },
    { id: 'extra', request_type: '고객 추가 응대', status: '승인완료' }
  ]);
  assert.deepEqual(history.map(row => row.id), ['done', 'extra']);
});
