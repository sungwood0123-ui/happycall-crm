const ALLOWED_ADJUSTMENT_TYPES = new Set(['적립', '차감', '사용처리']);

function normalizedText(value) {
  return String(value ?? '').trim();
}

export function freepassBulkEmployeeKey(employee) {
  const id = normalizedText(employee?.id);
  if (id) return `id:${id}`;

  return `employee:${normalizedText(employee?.store_name)}:${normalizedText(employee?.name)}`;
}

export function prepareFreepassBulkAdjustment({
  employees = [],
  bulkRows = {},
  individual = false,
  commonType = '적립',
  commonHours = 0,
  reason = '',
  effectiveDate,
  createdBy = ''
}) {
  const selected = employees
    .map(employee => ({
      employee,
      row: bulkRows[freepassBulkEmployeeKey(employee)] || {}
    }))
    .filter(({ row }) => row.checked);

  if (!selected.length) {
    return { ok: false, error: 'no_selection', selected, invalidEmployees: [], rows: [] };
  }

  const invalidEmployees = [];
  const rows = [];

  selected.forEach(({ employee, row }) => {
    const rawHours = individual ? row.hours : commonHours;
    const numericHours = Number(rawHours);

    if (!Number.isFinite(numericHours) || numericHours <= 0) {
      invalidEmployees.push(employee);
      return;
    }

    const requestedType = individual ? (row.type || commonType) : commonType;
    const adjustmentType = ALLOWED_ADJUSTMENT_TYPES.has(requestedType) ? requestedType : '적립';
    const absoluteHours = Math.abs(numericHours);

    rows.push({
      employee_id: employee?.id || null,
      employee_name: employee?.name || '',
      employee_store: employee?.store_name || '',
      type: adjustmentType,
      hours: adjustmentType === '차감' || adjustmentType === '사용처리' ? -absoluteHours : absoluteHours,
      reason: normalizedText(reason),
      effective_date: effectiveDate,
      created_by: createdBy
    });
  });

  if (invalidEmployees.length) {
    return { ok: false, error: 'invalid_hours', selected, invalidEmployees, rows: [] };
  }

  return { ok: true, error: null, selected, invalidEmployees: [], rows };
}
