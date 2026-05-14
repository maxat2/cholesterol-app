// sw.js — Service Worker для Web Push уведомлений
// Размести в корне проекта рядом с index.html

const CACHE_NAME = 'cholesterol-app-v1';

// ── Получение push уведомления ────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: '📋 Отчёт готов', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',      // добавь иконку в корень проекта
    badge: '/badge-72.png',     // маленькая иконка в статусбаре Android
    tag: 'daily-report',        // одно уведомление за день (заменяет предыдущее)
    renotify: false,
    data: { url: data.url || '/' },
    // Вибрация только на Android
    vibrate: [200, 100, 200],
    actions: [
      { action: 'open', title: '📊 Открыть отчёт' },
      { action: 'dismiss', title: 'Закрыть' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '📋 Отчёт за день готов', options)
  );
});

// ── Клик по уведомлению ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Если приложение уже открыто — фокусируем его
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          // Сообщаем приложению что нужно показать историю
          client.postMessage({ type: 'OPEN_DAILY_REPORT' });
          return;
        }
      }
      // Иначе открываем новую вкладку
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// ── Установка SW (минимальная — без кэширования) ─────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
