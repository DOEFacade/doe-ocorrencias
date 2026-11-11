/* DOE · Ocorrências pelo telemóvel — service worker (a página abre sem rede). Sem bibliotecas.
   Estratégia: PRÉ-CACHE com versão. Ao instalar guarda os ficheiros da página (todos da própria origem) numa cache
   com o nome da versão; ao abrir serve sempre dessa cache (abre em modo de avião). NÃO se actualiza ficheiro a
   ficheiro em segundo plano — isso misturava um app.js novo com um logica.js velho. A «revalidação» é o próprio
   service worker: o browser volta a pedir sw.js (e a página pede reg.update() ao abrir); se mudou, instala a versão
   nova numa cache nova, à parte, e a página mostra «Há uma versão nova, toca para atualizar». Nada se prende para
   sempre: ao tocar (ou ao reabrir a página com todas as janelas fechadas) a versão nova assume e a velha apaga-se.
   Nunca guarda pedidos à API nem ao Storage (outra origem: nem sequer os intercepta) e nunca guarda uma resposta
   que não seja 200.
   VERSAO = resumo dos 13 ficheiros acima (movel/versao.js). Mudar um ficheiro da página SEM subir a versão faz o
   teste falhar: sem isso os telemóveis ficavam com a página velha. Sobe-se com: node movel/versao.js --escrever */
'use strict';
var VERSAO = '0f73742446fb';
var PREFIXO = 'doe-movel-';
var CACHE = PREFIXO + VERSAO;
var FICHEIROS = ['./', 'index.html', 'app.js', 'logica.js', 'config.js', 'classificacao.js', 'icones.js', 'estilo.css', 'manifest.webmanifest', 'logo-doex.png', 'logo-doex-escuro.png', 'icone-180.png', 'icone-192.png', 'icone-512.png'];

function urlDe(f) { return new URL(f, self.location.href).href; }
function semPesquisa(u) { var x = new URL(u); x.search = ''; x.hash = ''; return x.href; }

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FICHEIROS.map(function (f) {
      // cache:'reload' ignora a cache HTTP do browser (o GitHub Pages serve com 10 min de cache)
      return fetch(new Request(urlDe(f), { cache: 'reload' })).then(function (r) {
        if (!r || r.status !== 200) throw new Error('Não consegui guardar ' + f + ' (' + (r && r.status) + ')');
        return c.put(urlDe(f), r);
      });
    })).catch(function (erro) {
      // instalação falhada (um ficheiro não veio): não deixa uma cache a meio; a versão anterior continua a servir
      return caches.delete(CACHE).then(function () { throw erro; });
    });
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (nomes) {
    return Promise.all(nomes.filter(function (n) { return n.indexOf(PREFIXO) === 0 && n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

// 'ativar': a versão nova assume (só quando a pessoa toca no aviso). 'versao': diz a VERSAO à página (o rodapé da
// entrada mostra-a, para quem dá apoio saber que versão está instalada).
self.addEventListener('message', function (e) {
  if (e.data === 'ativar') self.skipWaiting();
  else if (e.data === 'versao' && e.source && typeof e.source.postMessage === 'function') e.source.postMessage({ versao: VERSAO });
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  if (u.origin !== self.location.origin) return;            // API e Storage: nunca interceptados nem guardados
  var chave = semPesquisa(req.url);
  var conhecido = FICHEIROS.some(function (f) { return urlDe(f) === chave; });
  if (!conhecido) return;                                    // só os ficheiros da página (?obra=PHX, #… ignoram-se)
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(chave).then(function (guardada) {
      if (guardada) return guardada;
      return fetch(req);                                     // fora da cache (não devia): rede, sem guardar
    });
  }));
});
