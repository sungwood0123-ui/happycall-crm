import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncQueryCache } from '../src/asyncQueryCache.js';

test('reuses a loaded value until the ttl expires', async () => {
  let timestamp = 1000;
  let calls = 0;
  const cache = createAsyncQueryCache({ ttlMs: 100, now: () => timestamp });
  const loader = async () => ({ call: ++calls });

  assert.deepEqual(await cache.getOrLoad('targets', loader), { call: 1 });
  assert.deepEqual(await cache.getOrLoad('targets', loader), { call: 1 });
  assert.equal(calls, 1);

  timestamp = 1101;
  assert.deepEqual(await cache.getOrLoad('targets', loader), { call: 2 });
});

test('deduplicates concurrent requests and clears after a mutation', async () => {
  let resolveLoad;
  let calls = 0;
  const cache = createAsyncQueryCache();
  const loader = () => {
    calls += 1;
    return new Promise(resolve => { resolveLoad = resolve; });
  };

  const first = cache.getOrLoad('logs', loader);
  const second = cache.getOrLoad('logs', loader);
  await Promise.resolve();
  assert.equal(calls, 1);

  resolveLoad(['ok']);
  assert.deepEqual(await first, ['ok']);
  assert.deepEqual(await second, ['ok']);

  cache.clear();
  const third = cache.getOrLoad('logs', async () => ['fresh']);
  assert.deepEqual(await third, ['fresh']);
});

test('does not keep failed requests in the cache', async () => {
  const cache = createAsyncQueryCache();
  let calls = 0;

  await assert.rejects(
    cache.getOrLoad('customers', async () => {
      calls += 1;
      throw new Error('temporary failure');
    }),
    /temporary failure/
  );

  assert.deepEqual(await cache.getOrLoad('customers', async () => {
    calls += 1;
    return ['recovered'];
  }), ['recovered']);
  assert.equal(calls, 2);
});
