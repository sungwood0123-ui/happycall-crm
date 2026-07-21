export function createAsyncQueryCache({ ttlMs = 60000, now = () => Date.now() } = {}) {
  const entries = new Map();

  function clear() {
    entries.clear();
  }

  async function getOrLoad(key, loader, { force = false } = {}) {
    const currentTime = now();
    const cached = entries.get(key);

    if (!force && cached) {
      if (cached.promise) return cached.promise;
      if (currentTime - cached.loadedAt < ttlMs) return cached.value;
    }

    const promise = Promise.resolve().then(loader);
    entries.set(key, { promise, loadedAt: currentTime, value: null });

    try {
      const value = await promise;
      entries.set(key, { promise: null, loadedAt: now(), value });
      return value;
    } catch (error) {
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw error;
    }
  }

  return { clear, getOrLoad };
}
