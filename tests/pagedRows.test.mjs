import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPagedRows } from '../src/pagedRows.js';

test('loads remaining pages in bounded parallel groups and keeps page order', async () => {
  const rows = Array.from({ length: 3500 }, (_, index) => ({ id: index + 1 }));
  let active = 0;
  let maxActive = 0;
  const calls = [];

  const result = await loadPagedRows({
    pageSize: 1000,
    concurrency: 2,
    loadPage: async (from, to, { includeCount }) => {
      calls.push({ from, to, includeCount });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { data: rows.slice(from, to + 1), count: includeCount ? rows.length : null };
    }
  });

  assert.equal(result.length, 3500);
  assert.deepEqual(result.map(row => row.id), rows.map(row => row.id));
  assert.equal(calls.length, 4);
  assert.equal(maxActive, 2);
  assert.deepEqual(calls[0], { from: 0, to: 999, includeCount: true });
});

test('finishes after the first page when the table fits in one request', async () => {
  let calls = 0;
  const result = await loadPagedRows({
    loadPage: async () => {
      calls += 1;
      return { data: [{ id: 1 }], count: 1 };
    }
  });

  assert.deepEqual(result, [{ id: 1 }]);
  assert.equal(calls, 1);
});
