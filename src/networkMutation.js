export function isTransientNetworkError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('load failed')
    || message.includes('failed to fetch')
    || message.includes('network request failed')
    || message.includes('networkerror')
    || message.includes('network error');
}

const mutationSuccessListeners = new Set();

export function subscribeNetworkMutationSuccess(listener) {
  if (typeof listener !== 'function') return () => {};
  mutationSuccessListeners.add(listener);
  return () => mutationSuccessListeners.delete(listener);
}

function notifyMutationSuccess(result) {
  mutationSuccessListeners.forEach(listener => {
    try {
      listener(result);
    } catch {
      // Cache invalidation or other observers must never break the saved operation.
    }
  });
}

function waitForRetry(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runNetworkMutation(operation, attempts = 3, retryDelays = [700, 1600]) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await operation();
      if (result?.error) throw result.error;
      notifyMutationSuccess(result);
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === attempts - 1) throw error;
      await waitForRetry(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 0);
    }
  }
  throw lastError;
}

export async function runNetworkRead(operation, attempts = 3, retryDelays = [700, 1600]) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await operation();
      if (result?.error) throw result.error;
      return result;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.statusCode || 0);
      const retryable = isTransientNetworkError(error) || status === 503 || status === 520;
      if (!retryable || attempt === attempts - 1) throw error;
      await waitForRetry(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 0);
    }
  }
  throw lastError;
}

export function createClientUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
    (Number(c) ^ (globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)
  );
}
