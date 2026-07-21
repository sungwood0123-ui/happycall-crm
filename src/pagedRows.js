export async function loadPagedRows({
  loadPage,
  pageSize = 1000,
  concurrency = 4
}) {
  const firstPage = await loadPage(0, pageSize - 1, { includeCount: true });
  const firstRows = firstPage?.data || [];
  const totalCount = Number(firstPage?.count);

  if (!Number.isFinite(totalCount) || totalCount <= firstRows.length) return firstRows;

  const pages = [];
  for (let from = pageSize; from < totalCount; from += pageSize) {
    pages.push({ from, to: Math.min(from + pageSize - 1, totalCount - 1) });
  }

  const rows = [...firstRows];
  const safeConcurrency = Math.max(1, concurrency);
  for (let index = 0; index < pages.length; index += safeConcurrency) {
    const group = pages.slice(index, index + safeConcurrency);
    const results = await Promise.all(group.map(({ from, to }) => loadPage(from, to, { includeCount: false })));
    results.forEach(result => rows.push(...(result?.data || [])));
  }

  return rows;
}
