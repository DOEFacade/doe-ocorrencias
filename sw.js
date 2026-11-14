/* DOEX · app do telemóvel (ocorrências e diário de obra) — service worker (a página abre sem rede). Sem bibliotecas.
   Estratégia: PRÉ-CACHE com versão. Ao instalar guarda os ficheiros da página (todos da própria origem) numa cache
   com o nome da versão; ao abrir serve sempre dessa cache (abre em modo de avião). NÃO se actualiza ficheiro a
   ficheiro em segundo plano — isso misturava um app.js novo com um logica.js velho. A «revalidação» é o próprio
   service worker: o browser volta a pedir sw.js (e a página pede reg.update() ao abrir); se mudou, instala a versão
   nova numa cache nova, à parte, e a página mostra «Há uma versão nova, toca para atualizar». Nada se prende para
   sempre: ao tocar (ou ao reabrir a página com todas as janelas fechadas) a versão nova assume e a velha apaga-se.
   Nunca guarda pedidos à API nem ao Storage (outra origem: nem sequer os intercepta) e nunca guarda uma resposta
   que não seja 200.
   VERSAO = resumo dos 21 ficheiros acima (movel/versao.js). Mudar um ficheiro da página SEM subir a versão faz o
   teste falhar: sem isso os telemóveis ficavam com a página velha. Sobe-se com: node movel/versao.js --escrever */
'use strict';
var VERSAO = 'b0d634ce15d3';
var PREFIXO = 'doe-movel-';
// 14 nov 2026 (o repositório passa a `doex`): a app antiga (/doe-ocorrencias/) e a doex (/doex/) vivem na MESMA origem e,
// com a mesma versão, partilhavam a cache. Agora o nome leva o âmbito; as caches antigas sem âmbito (`doe-movel-<versão>`)
// não se apagam inteiras: tira-se delas só o que é deste âmbito (a outra app continua a abrir pela sua).
var AMBITO = new URL('./', self.location.href).href;
var CACHE = PREFIXO + VERSAO + '@' + new URL(AMBITO).pathname;
var FICHEIROS = ['./', 'index.html', 'app.js', 'logica.js', 'diario.js', 'hoje.js', 'trabalhos.js', 'trabalhos-ecra.js', 'bloqueios.js', 'bloqueios-ecra.js', 'casca.js', 'config.js', 'classificacao.js', 'feriados.js', 'icones.js', 'estilo.css', 'manifest.webmanifest', 'logo-doex.png', 'logo-doex-escuro.png', 'icone-180.png', 'icone-192.png', 'icone-512.png'];

function urlDe(f) { return new URL(f, self.location.href).href; }
function semPesquisa(u) { var x = new URL(u); x.search = ''; x.hash = ''; return x.href; }

// A marca de «cache completa»: entra só depois de TODOS os ficheiros estarem guardados. A página de saída do endereço
// antigo (movel/redireccao/sw.js) só leva para aqui, e só limpa a cópia antiga, quando a vê (revisão de 8bf7d34f: uma
// instalação a meio não pode passar por completa). Não é um ficheiro da página: o fetch abaixo nunca a serve.
var MARCA = 'cache-completa';

self.addEventListener('install', function (e) {
  // O nome da cache é o da VERSAO, e a VERSAO não conta o sw.js: um sw.js novo com os mesmos ficheiros instala-se na
  // MESMA cache que a versão activa está a servir. Se a instalação falhar, só se apaga a cache que ESTA instalação criou;
  // uma que já existia (a da versão activa) fica, senão a página deixava de abrir sem rede (revisão de 8bf7d34f).
  e.waitUntil(caches.has(CACHE).then(function (jaHavia) {
    return caches.open(CACHE).then(function (c) {
      return Promise.all(FICHEIROS.map(function (f) {
        // cache:'reload' ignora a cache HTTP do browser (o GitHub Pages serve com 10 min de cache)
        return fetch(new Request(urlDe(f), { cache: 'reload' })).then(function (r) {
          if (!r || r.status !== 200) throw new Error('Não consegui guardar ' + f + ' (' + (r && r.status) + ')');
          return c.put(urlDe(f), r);
        });
      })).then(function () {
        return c.put(urlDe(MARCA), new Response(VERSAO, { status: 200 }));
      }).catch(function (erro) {
        // instalação falhada (um ficheiro não veio): não deixa uma cache a meio; a versão anterior continua a servir
        if (jaHavia) throw erro;
        return caches.delete(CACHE).then(function () { throw erro; });
      });
    });
  }));
});

self.addEventListener('activate', function (e) {
  var sufixo = '@' + new URL(AMBITO).pathname;
  e.waitUntil(caches.keys().then(function (nomes) {
    return Promise.all(nomes.filter(function (n) { return n.indexOf(PREFIXO) === 0 && n !== CACHE; }).map(function (n) {
      if (n.slice(-sufixo.length) === sufixo) return caches.delete(n);   // uma versão antiga DESTE âmbito
      if (n.indexOf('@') >= 0) return null;                              // a de outro âmbito (a outra app): não se toca
      return caches.open(n).then(function (c) {                          // a antiga, sem âmbito: só os pedidos deste
        return c.keys().then(function (pedidos) {
          var meus = pedidos.filter(function (r) { return r.url.indexOf(AMBITO) === 0; });
          return Promise.all(meus.map(function (r) { return c.delete(r); })).then(function () { if (meus.length === pedidos.length) return caches.delete(n); });
        });
      });
    }));
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
