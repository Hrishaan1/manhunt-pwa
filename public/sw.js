const CACHE='trail-signal-v2';
const APP=['/','/index.html','/manifest.webmanifest','/icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const request=e.request;
  if(request.method!=='GET')return;
  if(request.mode==='navigate'){
    e.respondWith(fetch(request).then(response=>{const copy=response.clone();caches.open(CACHE).then(c=>c.put('/index.html',copy));return response}).catch(()=>caches.match('/index.html')));
    return;
  }
  if(new URL(request.url).origin!==location.origin)return;
  e.respondWith(caches.match(request).then(hit=>hit||fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(request,copy))}return response})));
});
