import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientUuid, isTransientNetworkError, runNetworkMutation, runNetworkRead } from '../src/networkMutation.js';

test('Load failed는 잠시 기다린 뒤 성공할 때까지 재시도한다', async () => {
  let calls = 0;
  const result = await runNetworkMutation(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('Load failed');
    return { data: { saved: true }, error: null };
  }, 3, [0, 0]);

  assert.equal(calls, 3);
  assert.equal(result.data.saved, true);
});

test('권한·검증 오류는 재시도하지 않는다', async () => {
  let calls = 0;
  await assert.rejects(() => runNetworkMutation(async () => {
    calls += 1;
    return { data: null, error: new Error('permission denied') };
  }, 3, [0, 0]), /permission denied/);

  assert.equal(calls, 1);
});

test('조회 중 Load failed와 일시적인 503 오류는 자동 재시도한다', async () => {
  let calls = 0;
  const result = await runNetworkRead(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Load failed');
    if (calls === 2) return { data: null, error: { message: 'temporarily unavailable', status: 503 } };
    return { data: [{ id: 1 }], error: null };
  }, 3, [0, 0]);

  assert.equal(calls, 3);
  assert.deepEqual(result.data, [{ id: 1 }]);
});

test('저장 작업마다 유효하고 서로 다른 UUID를 만든다', () => {
  const first = createClientUuid();
  const second = createClientUuid();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first, second);
});

test('대표적인 iPhone 네트워크 오류만 일시 오류로 분류한다', () => {
  assert.equal(isTransientNetworkError(new TypeError('Load failed')), true);
  assert.equal(isTransientNetworkError(new Error('Failed to fetch')), true);
  assert.equal(isTransientNetworkError(new Error('duplicate key')), false);
});
