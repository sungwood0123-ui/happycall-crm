self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title:'세찬컴퍼니 인트라넷', body:event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || '세찬컴퍼니 인트라넷', {
    body: data.body || '새 알림이 도착했습니다.',
    icon: '/sechan-logo.png',
    badge: '/sechan-logo.png',
    data: data.url || '/'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});
