export function normalizeAccrualTypeValue(value) {
  if (value === '야근 적립') return '고객 추가 응대';
  if (value === '휴무출근 적립' || value === '휴무 출근 적립') return '휴무 고객응대';
  return value || '';
}

export function isHolidayAccrualDraft(row) {
  return normalizeAccrualTypeValue(row?.request_type) === '휴무 고객응대' && row?.status === '임시저장';
}

export function findHolidayAccrualDraft(rows = []) {
  return rows.find(isHolidayAccrualDraft) || null;
}

export function accrualHistoryRows(rows = []) {
  return rows.filter(row => !isHolidayAccrualDraft(row));
}

export function holidayAccrualStep(draft, photos = []) {
  if (!draft) return 1;
  const hasEndPhoto = photos.some(photo => photo?.type === '응대 종료' || photo?.type === '퇴근');
  return hasEndPhoto ? 3 : 2;
}
