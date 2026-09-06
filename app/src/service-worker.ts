/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
import { APP_CACHE_PREFIX, staleAppCacheKeys } from '$lib/pwa/cache-policy';

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `${APP_CACHE_PREFIX}${version}`;
const ASSETS = [...build, ...files];

worker.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

worker.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			await Promise.all(staleAppCacheKeys(keys, CACHE).map((key) => caches.delete(key)));
			await worker.clients.claim();
		})
	);
});

worker.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET' || url.pathname.includes('/api/')) return;
	if (!ASSETS.some((asset) => url.pathname.endsWith(asset))) return;
	event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
