import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freepassBulkEmployeeKey,
  prepareFreepassBulkAdjustment
} from '../src/freepassBulkAdjustment.js';

const employees = [
  { id: 'geumchon-1', name: '금촌직원', store_name: '금촌' },
  { id: 'bongilcheon-1', name: '봉일천직원', store_name: '봉일천' }
];

function individualRows(rows) {
  return Object.fromEntries(rows.map(({ employee, hours }) => [
    freepassBulkEmployeeKey(employee),
    { checked: true, type: '적립', hours }
  ]));
}

test('금촌과 봉일천 직원을 함께 선택하면 두 매장 모두 저장 대상에 포함한다', () => {
  const prepared = prepareFreepassBulkAdjustment({
    employees,
    bulkRows: individualRows([
      { employee: employees[0], hours: 2 },
      { employee: employees[1], hours: 1 }
    ]),
    individual: true,
    reason: '복지 지급',
    effectiveDate: '2026-07-21',
    createdBy: '최고관리자'
  });

  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.rows.map(row => [row.employee_store, row.employee_name, row.hours]), [
    ['금촌', '금촌직원', 2],
    ['봉일천', '봉일천직원', 1]
  ]);
});

test('체크된 직원의 개별 시간이 비어 있으면 일부만 저장하지 않고 전체를 중단한다', () => {
  const prepared = prepareFreepassBulkAdjustment({
    employees,
    bulkRows: individualRows([
      { employee: employees[0], hours: '' },
      { employee: employees[1], hours: 1 }
    ]),
    individual: true,
    reason: '복지 지급',
    effectiveDate: '2026-07-21',
    createdBy: '최고관리자'
  });

  assert.equal(prepared.ok, false);
  assert.equal(prepared.error, 'invalid_hours');
  assert.deepEqual(prepared.invalidEmployees.map(employee => employee.name), ['금촌직원']);
  assert.deepEqual(prepared.rows, []);
});

test('금촌 직원만 다시 선택해도 직원 선택 상태를 정상 인식한다', () => {
  const key = freepassBulkEmployeeKey(employees[0]);
  const prepared = prepareFreepassBulkAdjustment({
    employees,
    bulkRows: { [key]: { checked: true, type: '적립', hours: 3 } },
    individual: true,
    reason: '추가 지급',
    effectiveDate: '2026-07-21',
    createdBy: '최고관리자'
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.selected.length, 1);
  assert.equal(prepared.rows[0].employee_store, '금촌');
  assert.equal(prepared.rows[0].hours, 3);
});

test('직원 ID가 없더라도 매장과 이름을 함께 사용해 같은 이름의 직원을 구분한다', () => {
  assert.notEqual(
    freepassBulkEmployeeKey({ name: '동명이인', store_name: '금촌' }),
    freepassBulkEmployeeKey({ name: '동명이인', store_name: '봉일천' })
  );
});
