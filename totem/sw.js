// Service worker: guarda os arquivos do totem no aparelho para que ele abra
// mesmo sem internet. Ao publicar uma versão nova, aumente VERSAO para o
// tablet baixar os arquivos atualizados.
var VERSAO = "totem-v2";
var ARQUIVOS = [
  "./",
  "index.html",
  "estilo.css",
  "app.js",
  "dados.js",
  "sha256.js",
  "xlsx.js",
  "manifest.webmanifest",
  "icone.svg"
];

self.addEventListener("install", function (evento) {
  evento.waitUntil(
    caches.open(VERSAO).then(function (cache) { return cache.addAll(ARQUIVOS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (evento) {
  evento.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.filter(function (n) { return n !== VERSAO; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Rede primeiro (pega atualizações quando há internet). Sem rede, ou se o
// site responder com erro (fora do ar, removido), usa a cópia guardada: o
// totem instalado continua abrindo mesmo que a hospedagem deixe de existir.
self.addEventListener("fetch", function (evento) {
  if (evento.request.method !== "GET") return;
  var mesmaOrigem = new URL(evento.request.url).origin === self.location.origin;
  function doCache() { return caches.match(evento.request, { ignoreSearch: true }); }
  evento.respondWith(
    fetch(evento.request).then(function (resposta) {
      if (!mesmaOrigem) return resposta;
      if (resposta.ok) {
        var copia = resposta.clone();
        caches.open(VERSAO).then(function (cache) { cache.put(evento.request, copia); });
        return resposta;
      }
      return doCache().then(function (guardada) { return guardada || resposta; });
    }).catch(function () {
      return doCache().then(function (guardada) { return guardada || Response.error(); });
    })
  );
});
