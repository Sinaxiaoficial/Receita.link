// Service worker mínimo: só existe para o navegador permitir "Instalar app".
// Não guarda nada em cache; toda requisição vai direto para a rede.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
