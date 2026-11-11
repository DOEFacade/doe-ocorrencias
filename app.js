/* DOE · Ocorrências pelo telemóvel — ecrãs e armazenamento. A lógica está em logica.js (testada em Node).
   Desenho: arranjo A do protótipo validado pelo Pedro a 10 nov 2026 (docs/prototipos/DOEX-Ocorrencia-Movel-Premium-
   Prototipo.html): um ecrã que se percorre (obra → o que aconteceu → descrição → fotos) e o botão de enviar fixo no
   fundo, que diz o que falta. As opções do produto, a obra e a conta abrem em folhas que sobem do fundo (<dialog>).
   Regras: tudo o que vem do servidor entra no DOM por textContent (os ícones são dados de icones.js, criados com
   createElementNS); a palavra-passe nunca é guardada (só o token); o que não foi entregue fica no rascunho
   (IndexedDB, ou memória se falhar).
   Cada rascunho é da conta que o criou: quem entra a seguir no mesmo telemóvel só envia os seus, e os de outra
   conta ficam guardados e visíveis («só ele pode enviar»), nunca reenviados sob outra identidade.
   A página abre sem rede (sw.js): o registo abre com as obras do último login, mesmo com o token caducado. */
(function () {
  'use strict';
  var M = self.DoeMovel;
  if (self.DOE_MOVEL_CLASSIF) M.definirClassificacao(self.DOE_MOVEL_CLASSIF);   // listas geradas a partir da app (classificacao.js)
  var IC = self.DOE_MOVEL_ICONES || { ui: {}, produto: {} };
  var API = (self.DOE_MOVEL_CONFIG && self.DOE_MOVEL_CONFIG.api) || '';
  var LS_SESSAO = 'doeMovel.sessao', LS_OBRA = 'doeMovel.obra';
  var LIMITE_AVISO_TEXTO = 3600;     // o contador só aparece perto do limite (4 000)
  var MS_FECHAR_ESCOLHA = 220;       // a folha das opções fecha-se sozinha, depois de se ver a escolha

  var $ = function (id) { return document.getElementById(id); };
  var est = { sessao: null, rasc: null, pend: [], alheios: [], vistaId: '', recarregar: false, store: null, emCurso: false, timer: null, avisoNotaLogin: '', semArmazem: false,
    vista: '', aPreparar: 0, obraOrigem: '', verGrade: false, tentou: false, envioObra: '', rolou: false };

  // ── localStorage com try/catch ──
  function lsLer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsGravar(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsApagar(k) { try { localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } }
  function lerSessao() { try { return JSON.parse(lsLer(LS_SESSAO) || 'null'); } catch (e) { return null; } }

  // ── Armazém de rascunhos: IndexedDB, com a memória como reserva ──
  function armazemMemoria() {
    var m = new Map();
    return {
      memoria: true,
      listar: function () { return Promise.resolve(Array.from(m.values())); },
      guardar: function (r) { m.set(r.id, r); return Promise.resolve(); },
      apagar: function (id) { m.delete(id); return Promise.resolve(); },
    };
  }
  function limpar(r) {   // o que vai para o disco: sem o endereço temporário da miniatura
    var c = Object.assign({}, r);
    c.fotos = (r.fotos || []).map(function (f) { var g = Object.assign({}, f); delete g.prev; return g; });
    return c;
  }
  function abrirArmazem() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') return resolve(armazemMemoria());
      var req;
      try { req = indexedDB.open('doeMovel', 1); } catch (e) { return resolve(armazemMemoria()); }
      req.onupgradeneeded = function () { req.result.createObjectStore('rascunhos', { keyPath: 'id' }); };
      req.onerror = function () { resolve(armazemMemoria()); };
      req.onblocked = function () { resolve(armazemMemoria()); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = function (modo, fn) {
          return new Promise(function (res, rej) {
            try {
              var t = db.transaction('rascunhos', modo), s = t.objectStore('rascunhos'), q = fn(s);
              t.oncomplete = function () { res(q && q.result); };
              t.onerror = t.onabort = function () { rej(t.error); };
            } catch (e) { rej(e); }
          });
        };
        resolve({
          memoria: false,
          listar: function () { return tx('readonly', function (s) { return s.getAll(); }); },
          guardar: function (r) { return tx('readwrite', function (s) { return s.put(limpar(r)); }); },
          apagar: function (id) { return tx('readwrite', function (s) { return s.delete(id); }); },
        });
      };
    });
  }
  // Guardar nunca deita a página abaixo: se o disco falhar, passa para a memória e avisa uma vez.
  function contaAtual() { return (est.sessao && est.sessao.contaId) || ''; }
  async function guardar(r) {
    if (!r.contaId && contaAtual()) { r.contaId = contaAtual(); r.contaNome = (est.sessao && est.sessao.nome) || ''; }   // o dono do rascunho
    try { await est.store.guardar(r); }
    catch (e) {
      if (!est.store.memoria) { var antigo = est.store; est.store = armazemMemoria(); desenharSemArmazem(); try { (await antigo.listar()).forEach(function (x) { est.store.guardar(x); }); } catch (e2) { /* nada */ } }
      await est.store.guardar(r);
    }
  }
  // Sem IndexedDB (ou se o disco falhar) o rascunho só vive na memória da página: a barra e uma faixa dizem-no e
  // nada diz «Guardado» nem «Guardada no telemóvel» (quem fechasse o separador confiante perdia tudo).
  // As mensagens da lógica dizem «Guardada no telemóvel» (e o login «o que escreveste está guardado»): sem armazém
  // persistente isso é mentira, e diz-se a verdade.
  var SO_NA_PAGINA = 'Isto só está guardado nesta página: não a feches.';
  function mensagemHonesta(txt, accao) {
    if (!est.semArmazem || !txt) return txt;
    var s = String(txt);
    if (/Guardada no telemóvel/.test(s) || accao === 'repetir') {
      var base = s.replace(/\s*Guardada no telemóvel[^.]*\./g, '').replace(/[;:,]\s*tento outra vez\.?$/, '.').trim();
      return (base || 'Não consegui enviar.') + ' ' + SO_NA_PAGINA;
    }
    return s.replace(/o que escreveste está guardado( neste telemóvel)?\.?/, 'o que escreveste só está nesta página: não a feches.');
  }
  // A versão nova recarrega a página: sem armazém persistente isso apagava o rascunho e a fila. Aí a faixa diz-o, e o
  // «Atualizar» espera até não haver nada só nesta página (ou que a pessoa confirme «Atualizar na mesma»).
  function trabalhoSoNaPagina() { return est.pend.length + est.alheios.length + (est.rasc && !M.rascunhoVazio(est.rasc) ? 1 : 0); }
  function desenharNovaVersao() {
    var t = $('nova-versao') && $('nova-versao').querySelector('.mv-faixa-t'); if (!t) return;
    t.textContent = '';
    textoEm(t, 'Há uma versão nova.', est.semArmazem ? ' Neste telemóvel o que escreveste só está nesta página: atualiza quando não houver nada por enviar.' : ' O que escreveste fica guardado.');
  }
  function avisoNovaVersao(n) {
    var a = $('nova-versao-aviso'); if (!a) return;
    if (!n) { a.hidden = true; return; }
    $('nova-versao-aviso-t').textContent = n === 1 ? 'Tens 1 ocorrência por enviar que só está nesta página: se atualizares, perde-se.' : 'Tens ' + n + ' ocorrências por enviar que só estão nesta página: se atualizares, perdem-se.';
    a.hidden = false;
  }
  function desenharSemArmazem() {
    est.semArmazem = !!(est.store && est.store.memoria);
    var f = $('faixa-armazem'); if (f) f.hidden = !est.semArmazem;
    desenharNovaVersao();
    desenharBarra();
  }
  async function apagar(id) { try { await est.store.apagar(id); } catch (e) { /* já não está */ } }

  // ── DOM auxiliar (sempre textContent; os ícones por createElementNS) ──
  function el(tag, cls, texto) { var e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
  function botao(cls, texto) { var b = el('button', cls, texto); b.type = 'button'; return b; }
  var SVG = 'http://www.w3.org/2000/svg';
  function desenhoDe(mapa, nome) { return Object.prototype.hasOwnProperty.call(mapa, nome) ? mapa[nome] : null; }
  function svgDe(desenho, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('class', 'mv-ic' + (cls ? ' ' + cls : '')); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    (desenho || []).forEach(function (d) {
      var e = document.createElementNS(SVG, d[0]);
      Object.keys(d[1]).forEach(function (k) { e.setAttribute(k, d[1][k]); });
      s.appendChild(e);
    });
    return s;
  }
  function icone(nome, cls) { return svgDe(desenhoDe(IC.ui || {}, nome), cls); }
  function iconeProduto(p) { var m = IC.produto || {}; return svgDe(desenhoDe(m, p) || desenhoDe(m, 'Outros')); }
  function preencherIcones(raiz) {
    Array.prototype.forEach.call(raiz.querySelectorAll('[data-ic]'), function (s) { if (!s.firstChild) s.appendChild(icone(s.getAttribute('data-ic'))); });
  }
  function textoEm(alvo, forte, resto) {   // «<b>forte</b> resto», sem HTML
    if (forte) alvo.appendChild(el('b', null, forte));
    if (resto) alvo.appendChild(document.createTextNode(resto));
  }
  function primeiraFrase(t) { var s = String(t || ''), i = s.indexOf('. '); return i > 0 ? [s.slice(0, i + 1), s.slice(i + 1)] : [s, '']; }
  function mostrarErro(id, texto) {
    var e = $(id); if (!e) return;
    e.textContent = '';
    if (!texto) { e.hidden = true; return; }
    e.appendChild(icone('alerta')); e.appendChild(el('span', null, texto)); e.hidden = false;
  }
  function semMovimento() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
  function focar(alvo) { if (alvo && alvo.isConnected && !alvo.closest('[inert],[hidden]')) { try { alvo.focus({ preventScroll: true }); } catch (e) { alvo.focus(); } } }

  // ── Faixas: a da fila (e avisos), a de sem rede, a da versão nova, as dos rascunhos de outra conta ──
  function faixa(o, ok) {
    var f = $('faixa');
    if (typeof o === 'string') o = o ? { texto: o, tipo: ok ? 'pos' : 'ama', ic: ok ? 'ok' : 'alerta' } : null;
    clearTimeout(faixa.t);
    f.textContent = '';
    if (!o) { f.hidden = true; f.className = 'mv-faixa ama'; return; }
    f.className = 'mv-faixa ' + (o.tipo || 'ama') + (o.botao ? ' mv-faixa-toda' : '');
    f.appendChild(icone(o.ic || 'alerta'));
    var t = el('span', 'mv-faixa-t'); textoEm(t, o.forte, o.texto); f.appendChild(t);
    if (o.botao) f.appendChild(botao('mv-faixa-b', o.botao));
    f.hidden = false;
    if (o.tipo === 'pos') faixa.t = setTimeout(function () { faixa(''); desenharFaixaFila(); }, 8000);
  }
  function desenharFaixaRede() { $('faixa-rede').hidden = navigator.onLine !== false; }
  function desenharAlheios() {
    var box = $('alheios'); if (!box) return;
    box.textContent = '';
    est.alheios.forEach(function (r) {
      var d = el('div', 'mv-faixa neu'); d.setAttribute('role', 'status');
      d.appendChild(icone('pessoa'));
      var t = el('span', 'mv-faixa-t');
      t.appendChild(document.createTextNode('Há um rascunho de '));
      t.appendChild(el('b', null, r.contaNome || 'outra conta'));
      t.appendChild(document.createTextNode(' neste telemóvel. Só essa conta o pode enviar.' + (r.numero ? ' Já registada como ' + r.numero + '.' : '')));
      d.appendChild(t); box.appendChild(d);
    });
    box.hidden = !est.alheios.length;
  }

  // ── Vistas, cabeçalho e progresso ──
  function ir(vista) {
    var mudou = est.vista !== vista;
    est.vista = vista;
    ['v-login', 'v-registo', 'v-envio'].forEach(function (v) { $(v).hidden = v !== vista; });
    $('cab').hidden = vista === 'v-login';
    $('prog').hidden = vista !== 'v-registo';
    $('barra').hidden = vista === 'v-login';
    $('barra-reg').hidden = vista !== 'v-registo';
    $('barra-env').hidden = vista !== 'v-envio';
    $('barra').classList.toggle('sem-fio', vista === 'v-envio');
    desenharCabecalho();
    medirBarra();
    if (mudou) { est.rolou = false; window.scrollTo(0, 0); }
    if (mudou && vista === 'v-envio') focar($('e-titulo'));   // o foco vai para o estado (visível), não fica num botão que desapareceu
  }
  function obrasDaSessao() { return (est.sessao && Array.isArray(est.sessao.obras)) ? est.sessao.obras : []; }
  function obraDe(id) { return id ? obrasDaSessao().filter(function (o) { return o.id === id; })[0] || null : null; }
  function obraTexto(id) { var o = obraDe(id); return o ? (o.codigo ? o.codigo + ' · ' + o.nome : o.nome) : ''; }
  function desenharCabecalho() {
    var s = est.sessao, nome = (s && s.nome) || '';
    $('conta').hidden = !s;
    $('conta-ini').textContent = M.iniciais(nome) || '·';
    $('conta').setAttribute('aria-label', 'Conta' + (nome ? ': ' + nome : ''));
    if (est.vista === 'v-envio') { $('cab-t').textContent = 'Ocorrência'; $('quem').textContent = obraTexto(est.envioObra); return; }
    $('cab-t').textContent = 'Nova ocorrência';
    $('quem').textContent = est.rolou && est.rasc ? (obraTexto(est.rasc.projectId) || 'Obra por escolher') : 'DOE Facade' + (nome ? ' · ' + nome : '');
  }
  function aoRolar() {
    if (est.vista !== 'v-registo') return;
    var s = $('sec-obra'), c = $('prog').hidden ? $('cab') : $('prog');
    var rolou = !!(s && c && s.getBoundingClientRect().bottom < c.getBoundingClientRect().bottom);
    if (rolou !== est.rolou) { est.rolou = rolou; desenharCabecalho(); }
  }
  function desenharProgresso() {
    var r = est.rasc; if (!r) return;
    var segs = [!!r.projectId, M.temClassificacao(r), !!String(r.texto || '').trim(), r.fotos.length > 0];
    Array.prototype.forEach.call($('prog').children, function (i, k) { i.className = segs[k] ? 'on' : ''; });
    $('prog').setAttribute('aria-label', segs.filter(Boolean).length + ' de 4 partes preenchidas');
  }

  // ── Sessão ──
  function sessaoValida() { return M.validadeToken(est.sessao, new Date()).valida; }
  function deps() {
    return {
      fetch: function (u, o) { return self.fetch(u, o); }, base: API,
      token: function () { return sessaoValida() ? est.sessao.token : ''; },
      contaId: contaAtual,
      agora: function () { return new Date(); }, online: function () { return navigator.onLine !== false; },
      guardar: async function (r) { await guardar(r); if (est.vistaId === r.id && !$('v-envio').hidden && r.estado !== 'entregue') desenharEnvio(r, null); }, novoId: function () { return M.novoId(); },
      substituir: async function (antigo, r) { await apagar(antigo); await guardar(r); },
    };
  }
  var NOTA_LOGIN = 'Entra com a tua conta do DOE. É só uma vez: a sessão fica 10 dias neste telemóvel.';
  function desenharNotaLogin(nota) {
    var n = $('login-nota'); n.textContent = '';
    if (!nota) { n.className = 'mv-lead'; n.removeAttribute('role'); n.textContent = NOTA_LOGIN; return; }
    n.className = 'mv-faixa ama'; n.setAttribute('role', 'status');
    n.appendChild(icone(/expirou/i.test(nota) ? 'relogio' : 'alerta'));
    var t = el('span', 'mv-faixa-t'), p = primeiraFrase(mensagemHonesta(nota)); textoEm(t, p[0], p[1]); n.appendChild(t);
  }
  function pedirLogin(nota) {
    faixa('');
    fecharFolhas();
    est.avisoNotaLogin = nota || '';
    desenharNotaLogin(nota);
    mostrarErro('login-erro', '');
    $('l-pass').value = ''; $('l-pass').type = 'password'; $('l-ver').setAttribute('aria-pressed', 'false');
    ir('v-login');
  }
  function sair() {
    gravarJa();
    var tinha = est.pend.length || (est.rasc && !M.rascunhoVazio(est.rasc));
    if (est.rasc && !M.rascunhoVazio(est.rasc) && !est.rasc.contaId && contaAtual()) { est.rasc.contaId = contaAtual(); est.rasc.contaNome = (est.sessao && est.sessao.nome) || ''; guardar(est.rasc); }
    lsApagar(LS_SESSAO); est.sessao = null; faixa('');
    reatribuir();
    pedirLogin(tinha ? 'Saíste. O que ficou por enviar continua guardado neste telemóvel, na tua conta.' : '');
  }

  // ── A fila é de cada conta ──
  // Reparte os rascunhos pelo dono: os da conta actual (ou sem dono, que ela adopta) ficam à mão; os das outras ficam
  // guardados e à vista em `alheios`, sem se enviarem. Corre ao arrancar, ao entrar e ao sair.
  function reatribuir() {
    var c = contaAtual(), vistos = {}, todos = [];
    est.pend.concat(est.alheios, est.rasc ? [est.rasc] : []).forEach(function (r) { if (!vistos[r.id]) { vistos[r.id] = true; todos.push(r); } });
    est.pend = []; est.alheios = []; var rasc = null;
    todos.forEach(function (r) {
      if (!M.ehDaConta(r, c)) { if (!M.rascunhoVazio(r)) est.alheios.push(r); else apagar(r.id); return; }
      if (!r.contaId && c) { r.contaId = c; r.contaNome = (est.sessao && est.sessao.nome) || ''; if (!M.rascunhoVazio(r)) guardar(r); }
      if (r.estado === 'a-enviar') est.pend.push(r);
      else if (r.estado === 'rascunho' && !rasc && !M.rascunhoVazio(r)) rasc = r;
    });
    if (est.vistaId && !est.pend.some(function (r) { return r.id === est.vistaId; })) est.vistaId = '';
    // (o rascunho de outra conta já foi para `alheios` ou, vazio, apagado acima: aqui não se apaga nada — antes de
    //  10 nov 2026 apagava-se do telemóvel o rascunho por acabar de quem saía, que só ficava na memória da página)
    if (rasc) est.rasc = rasc; else novoForm();
    desenharAlheios();
  }

  // ── Obra: a linha grande e a folha com a pesquisa ──
  function linkObra() { try { return new URLSearchParams(location.search).get('obra') || ''; } catch (e) { return ''; } }
  function preencherObras() {
    var obras = obrasDaSessao(), r = est.rasc, link = linkObra(), ult = lsLer(LS_OBRA);
    var doLink = link ? M.escolherObra(obras, link, '') : '';
    if (!(r.projectId && obraDe(r.projectId))) {
      r.projectId = M.escolherObra(obras, link, ult);
      est.obraOrigem = !r.projectId ? '' : (r.projectId === doLink ? 'link' : (r.projectId === ult ? 'memoria' : (obras.length === 1 ? 'unica' : 'escolhida')));
    } else if (!est.obraOrigem) {
      est.obraOrigem = r.projectId === doLink ? 'link' : (r.projectId === ult ? 'memoria' : 'escolhida');
    }
  }
  function linhaObra(o, comAccao) {
    var b = comAccao ? botao('mv-obra') : el('div', 'mv-obra');
    var ic = el('span', 'mv-obra-ic'); ic.appendChild(icone('obra')); b.appendChild(ic);
    var t = el('span', 'mv-obra-t'), cod = el('span', 'mv-obra-cod');
    t.appendChild(cod); b.appendChild(t);
    return { linha: b, t: t, cod: cod };
  }
  function desenharObra() {
    var box = $('obra-linha'); box.textContent = '';
    var obras = obrasDaSessao(), o = obraDe(est.rasc.projectId), x;
    if (!obras.length) {
      x = linhaObra(null, false);
      x.t.insertBefore(el('span', 'mv-obra-n', 'Sem obras ativas'), x.cod);
      x.cod.textContent = 'Entra outra vez para atualizar a lista.';
    } else if (obras.length === 1 && o) {
      x = linhaObra(o, false);
      if (o.codigo) x.cod.appendChild(el('code', null, o.codigo));
      x.cod.appendChild(el('span', null, 'a tua única obra ativa'));
      x.t.appendChild(el('span', 'mv-obra-n', o.nome));
    } else if (!o) {
      x = linhaObra(null, true);
      x.linha.classList.add('vazia'); x.linha.id = 'b-obra';
      x.t.insertBefore(el('span', 'mv-obra-n', 'Escolher a obra'), x.cod);
      x.cod.textContent = obras.length + ' obras ativas';
      var a = el('span', 'mv-obra-acc'); a.appendChild(icone('chev')); x.linha.appendChild(a);
    } else {
      x = linhaObra(o, true);
      x.linha.id = 'b-obra'; x.linha.setAttribute('aria-label', 'Obra ' + (o.codigo ? o.codigo + ' ' : '') + o.nome + '. Trocar');
      if (o.codigo) x.cod.appendChild(el('code', null, o.codigo));
      if (est.obraOrigem === 'link') x.cod.appendChild(el('span', 'mv-tag', 'Do link'));
      else if (est.obraOrigem === 'memoria') x.cod.appendChild(el('span', null, 'a última que usaste'));
      x.t.appendChild(el('span', 'mv-obra-n', o.nome));
      var acc = el('span', 'mv-obra-acc', 'Trocar'); acc.appendChild(icone('chev')); x.linha.appendChild(acc);
    }
    x.linha.setAttribute('data-obra', o ? o.id : '');
    if (x.linha.tagName === 'BUTTON') x.linha.addEventListener('click', abrirFolhaObra);
    box.appendChild(x.linha);
  }
  function desenharListaObras() {
    var lista = $('lista-obras'); lista.textContent = '';
    var obras = obrasDaSessao(), q = $('q-obra').value, ult = obraDe(lsLer(LS_OBRA)), f = M.filtrarObras(obras, q), atual = est.rasc.projectId;
    var linha = function (o) {
      var b = botao('mv-lo'); b.setAttribute('data-id', o.id); b.setAttribute('aria-pressed', o.id === atual ? 'true' : 'false');
      b.appendChild(el('code', null, o.codigo)); b.appendChild(el('span', 'mv-lo-n', o.nome)); b.appendChild(icone('ok'));
      b.addEventListener('click', function () { escolherObraDaFolha(o.id); });
      lista.appendChild(b);
    };
    var comQ = !!q.trim();
    if (!comQ && ult && obras.length > 1) { lista.appendChild(el('p', 'mv-lh', 'A última que usaste')); linha(ult); }
    var resto = f.filter(function (o) { return comQ || !ult || obras.length < 2 || o.id !== ult.id; });
    if (resto.length || comQ) lista.appendChild(el('p', 'mv-lh', comQ ? f.length + ' de ' + obras.length + (obras.length === 1 ? ' obra' : ' obras') : 'Todas as obras · ' + obras.length));
    resto.forEach(linha);
    if (!resto.length && comQ) lista.appendChild(el('p', 'mv-vazio', 'Nenhuma obra com «' + q.trim() + '». Procura pelo código ou por outra palavra do nome.'));
  }
  function abrirFolhaObra() {
    $('q-obra').value = '';
    $('fo-pesq').hidden = obrasDaSessao().length <= 5;
    desenharListaObras();
    var marcada = $('lista-obras').querySelector('[aria-pressed="true"]');
    abrirFolha($('folha-obra'), marcada || (!$('fo-pesq').hidden ? $('q-obra') : $('lista-obras').querySelector('.mv-lo')));
  }
  function escolherObraDaFolha(id) {
    est.rasc.projectId = id; est.rasc.obraEscolhida = true; est.obraOrigem = id === lsLer(LS_OBRA) ? 'memoria' : 'escolhida';   // escolhida à mão: o rascunho guarda-se mesmo sem texto
    mostrarErro('e-obra', ''); mudou();
    desenharObra(); desenharProgresso(); desenharBarra();
    fecharFolha($('folha-obra'), function () { return $('b-obra'); });
  }

  // ── Rascunho ──
  function novoForm() { est.rasc = M.novoRascunho({ id: M.novoId(), projectId: '', contaId: contaAtual(), contaNome: (est.sessao && est.sessao.nome) || '' }); est.obraOrigem = ''; est.verGrade = false; est.tentou = false; }
  var tDebounce = null, rDebounce = null;
  function mudou() {
    if (!est.rasc || est.rasc.estado !== 'rascunho') return;
    if (!M.rascunhoVazio(est.rasc)) M.marcarCaptura(est.rasc, new Date());
    clearTimeout(tDebounce);
    var r = est.rasc;   // o rascunho de AGORA: se entretanto sair ou trocar de conta, grava-se este e não o formulário novo
    rDebounce = r;
    tDebounce = setTimeout(function () { tDebounce = null; rDebounce = null; if (r.estado !== 'rascunho') return; if (M.rascunhoVazio(r)) apagar(r.id); else guardar(r); }, 300);
  }
  // O que está à espera da pausa grava-se já (ao sair, ao esconder a página, antes de atualizar): o rascunho que a pausa
  // tinha guardado para gravar, não o `est.rasc` de agora (no «Corrigir» com novo login o est.rasc já é outro).
  function gravarJa() {
    if (!tDebounce) return Promise.resolve();
    clearTimeout(tDebounce); tDebounce = null;
    var r = rDebounce; rDebounce = null;
    if (!r || r.estado !== 'rascunho') return Promise.resolve();
    return M.rascunhoVazio(r) ? apagar(r.id) : guardar(r);   // ficou vazio (apagou o texto todo): apaga-se, como a pausa faria
  }
  function desenharRegisto() {
    var r = est.rasc;
    preencherObras();
    if ($('texto').value !== (r.texto || '')) $('texto').value = r.texto || '';
    desenharContador();
    desenharObra(); desenharClassif(); desenharFotos();
    ['e-obra', 'e-fotos', 'e-texto'].forEach(function (i) { mostrarErro(i, ''); });
    ir('v-registo');
    desenharProgresso(); desenharBarra();
  }
  function desenharContador() {
    var n = ($('texto').value || '').length, c = $('cont');
    c.textContent = n > LIMITE_AVISO_TEXTO ? n.toLocaleString('pt-PT') + ' / ' + M.LIMITES.descricao.toLocaleString('pt-PT') : '';
    c.className = 'mv-cont' + (n > M.LIMITES.descricao - 100 ? ' ama' : '');
  }

  // ── O que aconteceu (opcional): 6 caixas; um toque abre a folha com as opções; depois fica um resumo ──
  // Tudo entra no DOM por textContent. Nada aqui bloqueia o envio.
  var folhaProd = '', tEscolha = null;
  function resumoDe(p) { return Array.prototype.filter.call($('c-resumo').querySelectorAll('.mv-res-b'), function (b) { return b.getAttribute('data-p') === p; })[0] || null; }
  function desenharClassif() {
    var box = $('classif');
    if (!M.classificacaoDisponivel()) { box.hidden = true; return; }
    box.hidden = false;
    var c = M.classificacaoDe(est.rasc), grade = !c.tipoProduto.length || est.verGrade;
    var res = $('c-resumo'); res.textContent = ''; res.hidden = grade;
    if (!grade) c.tipoProduto.forEach(function (p) {
      var k = c.defeitos[p], d = k ? M.defeitosDe(p).filter(function (x) { return x.key === k; })[0] : null;
      var linha = el('div', 'mv-res'), b = botao('mv-res-b');
      b.setAttribute('data-p', p);
      b.setAttribute('aria-label', p + ': ' + (d ? d.label : 'o que aconteceu por escolher') + '. Trocar');
      var ic = el('span', 'mv-res-ic'); ic.appendChild(iconeProduto(p)); b.appendChild(ic);
      var t = el('span', 'mv-res-t'); t.appendChild(el('span', 'mv-res-p', p)); t.appendChild(el('span', 'mv-res-d' + (d ? '' : ' por'), d ? d.label : 'O que aconteceu: por escolher'));
      b.appendChild(t);
      b.addEventListener('click', function () { abrirFolhaProduto(p); });
      var x = botao('mv-res-x'); x.setAttribute('aria-label', 'Tirar ' + p); x.appendChild(icone('x'));
      x.addEventListener('click', function () {
        M.tirarProduto(est.rasc, p); mudou(); desenharClassif(); desenharProgresso();
        focar($('c-resumo').querySelector('.mv-res-b') || $('c-produtos').querySelector('.mv-tile'));
      });
      linha.appendChild(b); linha.appendChild(x); res.appendChild(linha);
    });
    var g = $('c-produtos'); g.textContent = ''; g.hidden = !grade;
    if (grade) self.DOE_MOVEL_CLASSIF.produtos.forEach(function (p) {
      var on = c.tipoProduto.indexOf(p) >= 0, b = botao('mv-tile');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.appendChild(iconeProduto(p)); b.appendChild(el('span', 'mv-tile-l', p));
      if (on) { var ok = el('span', 'mv-tile-ok'); ok.appendChild(icone('ok')); b.appendChild(ok); }
      b.addEventListener('click', function () {
        if (est.verGrade) M.juntarProduto(est.rasc, p); else M.escolherProduto(est.rasc, p);   // tocar = este produto; «+ Outro produto» = juntar
        est.verGrade = false; mudou(); desenharClassif(); desenharProgresso();
        abrirFolhaProduto(p);
      });
      g.appendChild(b);
    });
    $('c-outro').hidden = grade;
    $('c-feito').hidden = !(grade && est.verGrade && c.tipoProduto.length);
  }
  function abrirFolhaProduto(p) {
    folhaProd = p; clearTimeout(tEscolha);
    var ic = $('fp-ic'); ic.textContent = ''; ic.appendChild(iconeProduto(p));
    $('fp-t').textContent = p;
    $('fp-nao').textContent = 'Não sei, fica só «' + p + '»';
    desenharOpcoes();
    var box = $('c-defeitos');
    abrirFolha($('folha-prod'), box.querySelector('[aria-checked="true"]') || box.querySelector('.mv-op'), function () { return resumoDe(p); });
  }
  function desenharOpcoes() {
    var box = $('c-defeitos'), p = folhaProd; box.textContent = '';
    var c = M.classificacaoDe(est.rasc), algum = !!c.defeitos[p];
    M.defeitosDe(p).forEach(function (d, i) {
      var on = c.defeitos[p] === d.key, b = botao('mv-op'); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on || (!algum && i === 0) ? 0 : -1;   // um só ponto de Tab no grupo; as setas andam entre as opções
      var t = el('span', 'mv-op-t'); t.appendChild(el('span', 'mv-op-l', d.label)); t.appendChild(el('span', 'mv-op-d', d.hint)); b.appendChild(t);
      var rad = el('span', 'mv-radio'); rad.appendChild(icone('ok')); b.appendChild(rad);
      b.addEventListener('click', function () {
        clearTimeout(tEscolha);
        M.escolherDefeito(est.rasc, p, d.key); mudou(); desenharOpcoes(); desenharClassif(); desenharProgresso();
        focar($('c-defeitos').querySelectorAll('.mv-op')[i]);
        if (M.classificacaoDe(est.rasc).defeitos[p]) tEscolha = setTimeout(function () { fecharFolha($('folha-prod')); }, MS_FECHAR_ESCOLHA);   // tocar de novo desfaz e a folha fica
      });
      box.appendChild(b);
    });
  }

  // ── Folhas que sobem do fundo (<dialog>): showModal dá o foco preso, o Esc e o resto inerte; sem ele, faz-se aqui ──
  var folhaAberta = null, folhaHist = false;
  // O «voltar» (gesto do Android, botão do browser, deslizar no iPhone) com uma folha aberta fecha a folha e não sai da
  // página: ao abrir empurra-se uma entrada no histórico; ao fechar por outro caminho, tira-se essa entrada.
  function aoVoltar(ev) {
    var st = ev && ev.state;
    if (folhaAberta && !(st && st.mvFolha)) { folhaHist = false; fecharFolha(folhaAberta); }   // saiu da entrada da folha: fecha-a
  }
  function abrirFolha(dlg, foco, depois) {
    if (folhaAberta && folhaAberta !== dlg) fecharFolha(folhaAberta, null, true);
    clearTimeout(dlg._t);
    if (!dlg.hasAttribute('open')) dlg._origem = document.activeElement;
    dlg._depois = depois || null;
    folhaAberta = dlg;
    if (!folhaHist) { try { history.pushState({ mvFolha: true }, ''); folhaHist = true; } catch (e) { folhaHist = false; } }
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
    dlg.setAttribute('aria-modal', 'true');
    $('app').setAttribute('inert', '');
    document.documentElement.classList.add('mv-com-folha');
    if (foco) focar(foco);
    var on = function () { if (folhaAberta === dlg) dlg.classList.add('on'); };
    if (semMovimento() || typeof requestAnimationFrame !== 'function') on(); else requestAnimationFrame(function () { requestAnimationFrame(on); });
  }
  function aoFecharFolha(dlg) {   // a folha fechou mesmo (pelo nosso fecho, pelo Esc ou pelo gesto «voltar» do Android)
    clearTimeout(dlg._t); dlg.classList.remove('on');
    if (folhaAberta === dlg) folhaAberta = null;
    if (!folhaAberta) {
      $('app').removeAttribute('inert'); document.documentElement.classList.remove('mv-com-folha');
      if (folhaHist) { folhaHist = false; try { if (history.state && history.state.mvFolha) history.back(); } catch (e) { /* sem histórico */ } }
    }
    var alvo = dlg._depois ? dlg._depois() : null; dlg._depois = null;
    if (!dlg._semFoco) focar(alvo || dlg._origem);
    dlg._semFoco = false;
  }
  function fecharFolha(dlg, depois, ja) {
    if (!dlg || !dlg.hasAttribute('open')) return;
    if (depois) dlg._depois = depois;
    if (folhaAberta === dlg) folhaAberta = null;
    dlg.classList.remove('on');
    clearTimeout(dlg._t);
    var fim = function () {
      if (typeof dlg.close === 'function' && typeof dlg.showModal === 'function') { if (dlg.open) dlg.close(); else aoFecharFolha(dlg); }
      else { dlg.removeAttribute('open'); aoFecharFolha(dlg); }
    };
    if (ja || semMovimento()) fim(); else dlg._t = setTimeout(fim, 200);
  }
  function fecharFolhas() { ['folha-obra', 'folha-prod', 'folha-conta'].forEach(function (id) { var d = $(id); if (!d.hasAttribute('open')) return; d._semFoco = true; fecharFolha(d, null, true); }); }
  function ligarFolhas() {
    ['folha-obra', 'folha-prod', 'folha-conta'].forEach(function (id) {
      var d = $(id);
      d.addEventListener('close', function () { aoFecharFolha(d); });
      d.addEventListener('cancel', function (ev) { ev.preventDefault(); fecharFolha(d); });   // Esc (e o «voltar» do Android): com animação
      d.addEventListener('click', function (ev) { if (ev.target === d) fecharFolha(d); });     // tocar no véu, fora da folha
      Array.prototype.forEach.call(d.querySelectorAll('[data-fechar]'), function (b) { b.addEventListener('click', function () { fecharFolha(d); }); });
    });
    window.addEventListener('popstate', aoVoltar);
    document.addEventListener('keydown', function (ev) {   // sem showModal (browsers antigos): o Esc faz-se aqui
      if (ev.key === 'Escape' && folhaAberta && typeof folhaAberta.showModal !== 'function') { ev.preventDefault(); fecharFolha(folhaAberta); }
    });
  }
  function abrirConta() {
    var s = est.sessao; if (!s) return;
    $('fc-ini').textContent = M.iniciais(s.nome) || '·';
    $('fc-nome').textContent = s.nome || 'A tua conta';
    $('fc-sessao').textContent = sessaoValida() ? 'Sessão neste telemóvel até ' + M.textoDia(s.expiraEm) : 'A sessão expirou: ao enviar, entra outra vez';
    abrirFolha($('folha-conta'), $('folha-conta').querySelector('[data-fechar]'));
  }

  // ── Fotos: compressão no telemóvel (o canvas retira o EXIF/GPS) ──
  function previa(f) { if (!f.prev && f.blob && typeof URL !== 'undefined' && URL.createObjectURL) f.prev = URL.createObjectURL(f.blob); return f.prev || ''; }
  function celulaAdd(cls, nomeIc, texto, rotulo, input) {
    var b = botao('mv-add' + (cls ? ' ' + cls : '')); b.appendChild(icone(nomeIc)); b.appendChild(el('span', null, texto));
    if (rotulo) b.setAttribute('aria-label', rotulo);
    b.disabled = est.aPreparar > 0;
    b.addEventListener('click', function () { $(input).click(); });
    return b;
  }
  function desenharFotos() {
    var box = $('fotos'); box.textContent = '';
    var r = est.rasc, max = M.LIMITES.fotos, n = r.fotos.length, prep = Math.max(0, Math.min(est.aPreparar, max - n)), livres = max - n - prep;
    $('fotos-meta').textContent = n ? n + ' de ' + max : 'Até ' + max;
    if (!n && !prep) {
      var v = el('div', 'mv-fotos-vazio');
      var cam = celulaAdd('cam', 'cam', 'Tirar foto', '', 'i-cam'); cam.id = 'b-cam';
      var gal = celulaAdd('gal', 'gal', 'Galeria', 'Juntar da galeria', 'i-gal'); gal.id = 'b-gal';
      v.appendChild(cam); v.appendChild(gal); box.appendChild(v);
      return;
    }
    var g = el('div', 'mv-fotos');
    r.fotos.forEach(function (f, i) {
      var c = el('div', 'mv-foto'), img = el('img'); img.alt = 'Foto ' + (i + 1); img.src = previa(f);
      var x = botao('mv-foto-x'); x.setAttribute('aria-label', 'Tirar a foto ' + (i + 1));
      var s = el('span'); s.appendChild(icone('x')); x.appendChild(s);
      x.addEventListener('click', function () {
        var alvo = est.rasc.fotos[i]; if (!alvo) return;
        if (alvo.prev && URL.revokeObjectURL) URL.revokeObjectURL(alvo.prev);
        est.rasc.fotos.splice(i, 1); mudou(); desenharFotos(); desenharProgresso(); desenharBarra();
        var xs = $('fotos').querySelectorAll('.mv-foto-x');
        focar(xs[Math.min(i, xs.length - 1)] || $('b-cam'));
      });
      c.appendChild(img); c.appendChild(x); g.appendChild(c);
    });
    for (var k = 0; k < prep; k++) {
      var p = el('div', 'mv-foto prep'); p.setAttribute('role', 'status');
      p.appendChild(el('span', 'pulsa', 'A preparar…'));
      var pb = el('div', 'mv-pb'); pb.appendChild(el('i')); p.appendChild(pb);
      g.appendChild(p);
    }
    if (livres >= 1) { var c1 = celulaAdd('cam', 'cam', 'Câmara', 'Tirar outra foto', 'i-cam'); c1.id = 'b-cam'; g.appendChild(c1); }
    if (livres >= 2) { var c2 = celulaAdd('', 'gal', 'Galeria', 'Juntar da galeria', 'i-gal'); c2.id = 'b-gal'; g.appendChild(c2); }
    box.appendChild(g);
    if (livres === 1) { var l = botao('mv-link'); l.id = 'b-gal'; l.appendChild(icone('gal')); l.appendChild(document.createTextNode('Ou da galeria')); l.disabled = est.aPreparar > 0; l.addEventListener('click', function () { $('i-gal').click(); }); box.appendChild(l); }
    if (!livres && !prep) box.appendChild(el('p', 'mv-fotos-nota', max + ' de ' + max + ', o máximo. Tira uma (✕) para juntar outra.'));
  }
  async function decodificar(file) {
    try { var b = await createImageBitmap(file, { imageOrientation: 'from-image' }); return { fonte: b, w: b.width, h: b.height, fechar: function () { if (b.close) b.close(); } }; } catch (e) { /* tenta sem opções */ }
    try { var b2 = await createImageBitmap(file); return { fonte: b2, w: b2.width, h: b2.height, fechar: function () { if (b2.close) b2.close(); } }; } catch (e) { /* tenta com <img> */ }
    var url = URL.createObjectURL(file), img = new Image();
    img.src = url;
    await img.decode();
    return { fonte: img, w: img.naturalWidth, h: img.naturalHeight, fechar: function () { URL.revokeObjectURL(url); } };
  }
  async function sha256(blob) { return M.sha256Hex(await blob.arrayBuffer()); }   // reserva em JS quando não há crypto.subtle (http)
  async function comprimir(file) {
    var dec;
    try { dec = await decodificar(file); } catch (e) { throw new Error(M.MSG_FOTO_ILEGIVEL); }
    try {
      for (var i = 0; i < M.PASSOS_COMPRESSAO.length; i++) {
        var p = M.PASSOS_COMPRESSAO[i], d = M.tamanhoImagem(dec.w, dec.h, p.lado);
        var cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
        var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, d.w, d.h); cx.drawImage(dec.fonte, 0, 0, d.w, d.h);
        var blob = await new Promise(function (res) { cv.toBlob(res, 'image/jpeg', p.qualidade); });
        if (!blob) throw new Error(M.MSG_FOTO_ILEGIVEL);
        var dec2 = M.decidirCompressao(blob.size, i);
        if (dec2 === 'rejeitar') throw new Error(M.MSG_FOTO_GRANDE);
        if (dec2 === 'aceitar') return { blob: blob, tipo: 'image/jpeg', tamanho: blob.size, sha256: await sha256(blob) };
      }
    } finally { dec.fechar(); }
    throw new Error(M.MSG_FOTO_GRANDE);
  }
  // Uma foto «A preparar» que não acaba (um HEIC enorme, um telemóvel sem memória) não pode prender o envio para sempre:
  // passado o prazo falha com uma mensagem e o envio desbloqueia (a compressão que ainda corra é ignorada).
  var MSG_FOTO_DEMORA = 'Esta foto está a demorar demasiado a preparar. Tenta outra vez (ou tira outra).';
  function comPrazo(promessa, ms) {
    var t, resta = ms, passo = Math.max(1, Math.min(250, ms));
    var prazo = new Promise(function (res, rej) {
      t = setInterval(function () { if (!document.hidden) resta -= passo; if (resta <= 0) { clearInterval(t); rej(new Error(MSG_FOTO_DEMORA)); } }, passo);
    });
    return Promise.race([promessa, prazo]).finally(function () { clearInterval(t); });
  }
  function desenharDepoisDeFoto() { if (est.vista === 'v-registo') { desenharFotos(); desenharProgresso(); desenharBarra(); } }
  async function adicionarFotos(lista) {
    var files = Array.prototype.slice.call(lista || []);
    mostrarErro('e-fotos', '');
    if (!files.length || est.aPreparar) return;
    var id = est.rasc.id, erros = [];
    var cabem = Math.max(0, M.LIMITES.fotos - est.rasc.fotos.length);
    if (files.length > cabem) erros.push('No máximo ' + M.LIMITES.fotos + ' fotos por ocorrência.');
    files = files.slice(0, cabem);
    est.aPreparar = files.length; desenharDepoisDeFoto();
    try {
      for (var i = 0; i < files.length; i++) {
        try {
          var c = await comPrazo(comprimir(files[i]), M.LIMITES.msPrepararFoto);
          // depois do await relê-se o rascunho: se entretanto mudou (saiu, outra conta), a foto não vai para outro
          if (!est.rasc || est.rasc.id !== id || est.rasc.estado !== 'rascunho') break;
          if (!M.podeAcrescentarFoto(est.rasc)) { erros.push('No máximo ' + M.LIMITES.fotos + ' fotos por ocorrência.'); break; }
          est.rasc.fotos.push({ blob: c.blob, tipo: c.tipo, tamanho: c.tamanho, sha256: c.sha256, estado: 'espera', n: 0 });
          mudou();
        } catch (e) { erros.push((e && e.message) || M.MSG_FOTO_ILEGIVEL); }
        est.aPreparar = Math.max(0, files.length - i - 1); desenharDepoisDeFoto();
      }
    } finally { est.aPreparar = 0; desenharDepoisDeFoto(); }
    if (erros.length) mostrarErro('e-fotos', erros[0]);
  }

  // ── Barra fixa: o que falta, ou a garantia de que nada se perde ──
  function desenharBarra() {
    if (!est.rasc) return;
    var fl = M.faltaParaEnviar(est.rasc, est.aPreparar), nota = $('barra-nota'), b = $('b-enviar');
    if (!fl) est.tentou = false;
    nota.textContent = ''; nota.className = 'mv-barra-nota';
    var ic, txt, ref = '';
    if (fl) { ic = fl.espera ? 'relogio' : 'alerta'; txt = fl.texto; nota.classList.add('falta'); if (est.tentou && !fl.espera) nota.classList.add('tentou'); }
    else if (est.semArmazem) { ic = 'alerta'; txt = 'Neste telemóvel não consigo guardar o rascunho: não feches esta página'; nota.classList.add('falta'); }
    else if (!sessaoValida()) { ic = 'relogio'; txt = 'Sessão expirada: ao enviar, entra outra vez'; }
    else if (navigator.onLine === false) { ic = 'tel'; txt = 'Sem rede: fica guardada e segue sozinha'; }
    else { ic = 'tel'; txt = 'Guardado no telemóvel · Ref. '; ref = M.referencia(est.rasc.id); }
    nota.appendChild(icone(ic)); var s = el('span', null, txt); if (ref) s.appendChild(el('code', null, ref)); nota.appendChild(s);
    b.setAttribute('aria-disabled', fl ? 'true' : 'false');
    if (fl) b.setAttribute('aria-describedby', 'barra-nota'); else b.removeAttribute('aria-describedby');
    medirBarra();
  }
  function medirBarra() {
    var c = $('cab'), hc = c && !c.hidden ? c.offsetHeight : 0;
    if (hc > 0) document.documentElement.style.setProperty('--mv-cab-h', hc + 'px');   // com a letra aumentada o cabeçalho cresce: o progresso cola-se por baixo dele
    var b = $('barra'); if (!b || b.hidden) return;
    var h = b.offsetHeight; if (h > 0) document.documentElement.style.setProperty('--mv-barra-h', h + 'px');
  }
  // Teclado aberto: no iPhone o teclado não encolhe a página e a barra fixa ficava por baixo dele; sobe-se pelo
  // visualViewport (--mv-tecl). No Android, o meta viewport (interactive-widget=resizes-content) encolhe a página.
  function ligarTeclado() {
    var vv = window.visualViewport, raiz = document.documentElement, alturaMax = window.innerHeight || 0, tAj = null;
    var campoComFoco = function () { var a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|password|email)$/.test(a.type))); };
    var ajustar = function () {
      var tapado = vv ? Math.max(0, Math.round((window.innerHeight || 0) - vv.height - vv.offsetTop)) : 0;
      if (!campoComFoco() && (window.innerHeight || 0) > alturaMax) alturaMax = window.innerHeight;
      var aberto = campoComFoco() && (tapado > 80 || (alturaMax - (window.innerHeight || 0)) > 120);
      raiz.style.setProperty('--mv-tecl', (aberto ? tapado : 0) + 'px');
      raiz.classList.toggle('mv-teclado', aberto);
      medirBarra();
      if (aberto) garantirCampoVisivel(vv);
    };
    var depois = function () { clearTimeout(tAj); tAj = setTimeout(ajustar, 60); };
    if (vv) { vv.addEventListener('resize', ajustar); vv.addEventListener('scroll', ajustar); }
    window.addEventListener('resize', depois);
    document.addEventListener('focusin', depois);
    document.addEventListener('focusout', depois);
  }
  function garantirCampoVisivel(vv) {   // o campo da descrição nunca fica tapado pela barra nem pelo cabeçalho
    var a = document.activeElement; if (!a || a.id !== 'texto' || est.vista !== 'v-registo') return;
    var r = a.getBoundingClientRect(), topo = $('prog').getBoundingClientRect().bottom + 8;
    var fundo = (vv ? vv.offsetTop + vv.height : window.innerHeight) - $('barra').offsetHeight - 8;
    var precisa = Math.min(r.height, Math.max(0, fundo - topo));
    if (r.top < topo) window.scrollBy(0, r.top - topo);
    else if (r.top + precisa > fundo) window.scrollBy(0, r.top + precisa - fundo);
  }

  // ── Envio ──
  function listaPendentes() { return est.pend.filter(function (r) { return r.estado === 'a-enviar'; }); }
  function desenharFaixaFila() {
    var n = est.pend.filter(function (r) { return r.estado === 'a-enviar' && r.id !== est.vistaId; }).length;
    var forte = n === 1 ? '1 por enviar' : n + ' por enviar';
    var onde = est.semArmazem ? (n === 1 ? ', só nesta página (não a feches)' : ', só nesta página (não a feches)') : (n === 1 ? ', guardada no telemóvel' : ', guardadas no telemóvel');
    if (n && !sessaoValida()) faixa({ forte: forte, texto: onde + (n === 1 ? '. A sessão expirou: entra outra vez (com rede) para a enviar.' : '. A sessão expirou: entra outra vez (com rede) para as enviar.'), ic: 'relogio', botao: 'Entrar' });
    else if (n) faixa({ forte: forte, texto: onde + (n === 1 ? '. Segue com rede, com a página aberta.' : '. Seguem com rede, com a página aberta.'), ic: 'tel', botao: 'Ver' });
    else if (!$('faixa').classList.contains('pos')) faixa('');
  }
  function linhaFoto(r, f, i, res) {
    var li = el('div', 'mv-fl');
    if (previa(f)) { var img = el('img'); img.alt = ''; img.src = f.prev; li.appendChild(img); } else li.appendChild(el('span', 'mv-fl-sem'));
    var t = el('span', 'mv-fl-t'); t.appendChild(el('b', null, 'Foto ' + (i + 1)));
    var fim = null;
    if (f.estado === 'confirmada') { t.appendChild(el('small', 'pos', 'Enviada')); fim = icone('ok'); }
    else if (f.estado === 'a-enviar') { t.appendChild(el('small', null, 'A enviar…')); var pb = el('div', 'mv-pb'); pb.appendChild(el('i')); t.appendChild(pb); }
    else if (f.estado === 'erro' && r.repete) t.appendChild(el('small', null, (!est.semArmazem && f.erro) || 'Não chegou; tento outra vez.'));   // a página repete sozinha: diz porquê, sem botão
    else if (f.estado === 'erro') {
      t.appendChild(el('small', 'neg', 'Falhou'));
      fim = botao('mv-btn'); fim.appendChild(icone('atual')); fim.appendChild(document.createTextNode('Tentar de novo'));
      fim.addEventListener('click', function () { tentarDeNovo(r); });
    } else t.appendChild(el('small', null, res && res.estado === 'pendente' && res.rede ? 'À espera de rede' : (r.numero ? 'À espera' : 'Depois do texto')));
    li.appendChild(t); if (fim) li.appendChild(fim);
    return li;
  }
  function linhaRecibo(rotulo, valor) { var d = el('div', 'mv-rl'); d.appendChild(el('span', null, rotulo)); if (typeof valor === 'string') d.appendChild(el('b', null, valor)); else d.appendChild(valor); return d; }
  function desenharRecibo(r) {
    var box = $('e-recibo'); box.textContent = '';
    var c = M.classificacaoDe(r);
    var tipo = c.tipoProduto.map(function (p) { var k = c.defeitos[p], d = k ? M.defeitosDe(p).filter(function (x) { return x.key === k; })[0] : null; return p + (d ? ' · ' + d.label : ''); }).join('; ');
    if (tipo) box.appendChild(linhaRecibo('O que aconteceu', tipo));
    if (r.fotos.length) {
      var m = el('b', 'mv-minis');
      r.fotos.forEach(function (f, i) { if (previa(f)) { var img = el('img'); img.alt = 'Foto ' + (i + 1); img.src = f.prev; m.appendChild(img); } });
      if (!m.children.length) m.textContent = r.fotos.length === 1 ? '1 foto' : r.fotos.length + ' fotos';
      box.appendChild(linhaRecibo('Fotos', m));
    } else box.appendChild(linhaRecibo('Fotos', 'Sem fotos'));
    var por = r.contaNome || (est.sessao && est.sessao.nome) || '';
    if (por) box.appendChild(linhaRecibo('Por', por));
    box.hidden = false;
  }
  function desenharEnvio(r, res) {
    var c = M.contarFotos(r), selo = $('e-selo'), num = $('e-num'), sub = $('e-sub');
    var retry = $('e-retry'), corr = $('e-corrigir'), nova = $('e-nova'), box = $('ev-fotos');
    est.vistaId = r.id; est.envioObra = r.projectId;
    selo.textContent = ''; num.hidden = true; $('e-ref-r').hidden = $('e-ref').hidden = true; $('e-recibo').hidden = true; $('e-calmo').hidden = true;
    mostrarErro('e-erro', '');
    retry.hidden = corr.hidden = true; [retry, corr, nova].forEach(function (b) { b.className = 'mv-btn'; });
    var marcarSelo = function (cls, nomeIc, rotulo, roda) {
      selo.className = 'mv-selo' + (cls ? ' ' + cls : ''); selo.setAttribute('aria-label', rotulo);
      if (roda) { var s = document.createElementNS(SVG, 'svg'); s.setAttribute('class', 'mv-roda'); s.setAttribute('viewBox', '0 0 72 72'); s.setAttribute('aria-hidden', 'true'); var ci = document.createElementNS(SVG, 'circle'); ci.setAttribute('cx', '36'); ci.setAttribute('cy', '36'); ci.setAttribute('r', '34'); s.appendChild(ci); selo.appendChild(s); }
      selo.appendChild(icone(nomeIc));
    };
    var verRef = function () { $('e-ref-r').hidden = false; $('e-ref').hidden = false; $('e-ref').textContent = M.referencia(r.id); };
    var verNum = function () { num.textContent = r.numero; num.hidden = false; };
    var pendRede = res && res.estado === 'pendente' && res.rede;
    var fotoComErro = r.fotos.some(function (f) { return f.estado === 'erro'; }), semAvisoGeral = false;
    var titulo;
    if (r.estado === 'entregue') {
      marcarSelo('', 'ok', 'Recebida'); titulo = 'Recebida'; verNum();
      var o = obraDe(r.projectId);
      sub.textContent = [o ? o.nome : '', M.textoHora(r.recebidaEm || r.entregueEm, new Date())].filter(Boolean).join(' · ');
      desenharRecibo(r); $('e-calmo').hidden = false;
      nova.className = 'mv-btn pri';
    } else if (r.numero) {
      marcarSelo('nav', 'subir', 'Registada'); titulo = 'Registada'; verNum();
      // uma foto que falhou e a página repete sozinha: a linha da foto diz porquê, sem aviso a vermelho nem «Tentar de novo»;
      // quando a página PÁRA de repetir, o «Tentar de novo» aparece na própria foto
      if (fotoComErro && r.repete) { semAvisoGeral = true; }
      if (fotoComErro) sub.textContent = (c.faltam === 1 ? 'Falta uma foto.' : 'Faltam ' + c.faltam + ' fotos.') + (c.confirmadas ? (c.confirmadas === 1 ? ' A outra já chegou.' : ' As outras já chegaram.') : '');
      else if (pendRede) sub.textContent = 'Sem rede. As fotos que faltam seguem sozinhas quando houver rede, com esta página aberta.';
      else sub.textContent = 'A enviar as fotos (' + Math.min(c.confirmadas + 1, c.total) + ' de ' + c.total + '). Não feches esta página.';
      if (res && (res.estado === 'parar' || res.estado === 'pendente') && !(fotoComErro && !r.repete)) { retry.hidden = false; retry.classList.add('ghost', 'compacto'); }
    } else if (res && (res.estado === 'corrigir' || res.estado === 'parar')) {
      marcarSelo('neg', 'alerta', 'Não foi enviada'); titulo = 'Não foi enviada'; verRef();
      sub.textContent = 'O que escreveste' + (r.fotos.length ? ' e as fotos continuam guardados.' : ' continua guardado.');
      if (res.estado === 'corrigir') { corr.hidden = false; corr.className = 'mv-btn pri'; }
      else { retry.hidden = false; retry.className = 'mv-btn pri'; }
      nova.classList.add('ghost', 'compacto');
    } else if (res && res.estado === 'pendente') {
      if (est.semArmazem) {   // só na memória da página: nunca «Guardada no telemóvel»
        marcarSelo('ama', 'alerta', 'Por enviar'); titulo = 'Por enviar'; verRef();
        sub.textContent = 'Neste telemóvel não consigo guardar: não feches esta página. Envia-se quando houver rede.';
      } else {
        marcarSelo('ama', 'tel', 'Guardada no telemóvel'); titulo = 'Guardada no telemóvel'; verRef();
      }
      if (!est.semArmazem) sub.textContent = res.rede ? 'Envia-se sozinha quando houver rede, com esta página aberta. O número chega depois.' : 'Vai tentar outra vez sozinha. O número chega depois.';
      nova.className = 'mv-btn pri'; retry.hidden = false; retry.classList.add('ghost', 'compacto');
    } else {
      marcarSelo('nav', 'subir', 'A enviar', true); titulo = 'A enviar…'; verRef();
      sub.textContent = 'Não feches esta página até chegar o número.';
    }
    $('e-titulo').textContent = titulo;
    box.textContent = '';
    if (r.estado !== 'entregue' && r.fotos.length) { r.fotos.forEach(function (f, i) { box.appendChild(linhaFoto(r, f, i, res)); }); box.hidden = false; }
    else box.hidden = true;
    // a página parou de repetir: a mensagem «…tento outra vez» já não é verdade; diz-se o que a pessoa faz
    var parouFoto = fotoComErro && !r.repete && res && res.accao === 'repetir';
    if (res && res.mensagem && r.estado !== 'entregue') mostrarErro('e-erro', (pendRede && !parouFoto) || semAvisoGeral ? '' : (parouFoto ? 'Não consegui enviar ' + (c.faltam === 1 ? 'esta foto' : 'estas fotos') + '. Toca em «Tentar de novo» (com rede).' : mensagemHonesta(res.mensagem, res.accao)));
    ir('v-envio');
    desenharCabecalho();
  }
  var emEnvio = {};
  async function enviarUm(r) {
    if (emEnvio[r.id]) return null;
    emEnvio[r.id] = true;
    try {
      var d = deps();
      var antigo = r.id;
      var res = await M.processar(r, d);
      if (r.id !== antigo && est.vistaId === antigo) est.vistaId = r.id;
      r.ultimo = res;
      if (res.estado === 'entregue') {
        if (est.vistaId === r.id) desenharEnvio(r, res);
        else faixa({ forte: 'Ocorrência ' + r.numero + ' recebida.', texto: '', tipo: 'pos', ic: 'ok' });
        est.pend = est.pend.filter(function (x) { return x.id !== r.id; });
        if (est.alheios.some(function (x) { return x.id === r.id; })) { est.alheios = est.alheios.filter(function (x) { return x.id !== r.id; }); desenharAlheios(); }   // acabou de seguir depois de a conta mudar
        setTimeout(function () { apagar(r.id); }, 0);
      } else if (res.estado === 'login') {
        pedirLogin(res.mensagem);
      } else {
        r.tentativas = (r.tentativas || 0) + 1;
        if (res.estado === 'corrigir' || res.estado === 'parar') r.parado = true;
        // «a página repete sozinha»: há uma tentativa marcada, ou está sem rede e segue quando a rede voltar
        var agendado = res.estado === 'pendente' ? agendar(res.retryAfter) : false;
        r.repete = res.estado === 'pendente' && (agendado || (!!res.rede && navigator.onLine === false));
        if (est.vistaId === r.id) desenharEnvio(r, res);
      }
      desenharFaixaFila();
      return res;
    } finally { delete emEnvio[r.id]; }
  }
  function agendar(retryAfter) {
    clearTimeout(est.timer);
    var maxT = Math.max.apply(null, [0].concat(est.pend.map(function (r) { return r.tentativas || 0; })));
    var ms = M.esperaRetry(Math.max(0, maxT - 1), retryAfter);
    if (ms == null) return false;
    est.timer = setTimeout(drenar, ms);
    return true;
  }
  // Envia a fila. Se já está a correr, quem chega marca que há mais trabalho e o que está a correr volta a ler a fila no
  // fim (uma ocorrência enviada enquanto outra ainda segue não fica parada em «A enviar…»). Cada uma confirma, mesmo
  // antes de seguir, que é da conta que está agora na sessão (a conta pode mudar a meio).
  async function drenar(manual) {
    if (est.emCurso) { if (manual === true) est.drenarManual = true; else est.drenarMais = true; return; }
    // Sem sessão válida a página não se fecha ao registo (pode estar sem rede): só um envio pedido pela pessoa pede o login.
    if (!sessaoValida()) { if (manual === true && est.pend.some(function (r) { return !r.parado; })) pedirLogin('A sessão expirou. Entra outra vez; o que escreveste está guardado.'); else desenharFaixaFila(); return; }
    est.emCurso = true; est.drenarManual = false; est.drenarMais = false;
    var parou = false;
    try {
      var manualAgora = manual === true, feitos = {};
      for (var volta = 0; volta < 50 && !parou; volta++) {
        var lista = listaPendentes().filter(function (r) { return !feitos[r.id] && M.ehDaConta(r, contaAtual()) && (manualAgora || !r.parado); });
        if (!lista.length) {
          if (est.drenarManual) { est.drenarManual = false; est.drenarMais = false; manualAgora = true; feitos = {}; continue; }   // «Tentar» pedido a meio: mais uma volta
          break;
        }
        est.drenarMais = false;
        for (var i = 0; i < lista.length; i++) {
          var r = lista[i];
          if (!M.ehDaConta(r, contaAtual()) || r.estado !== 'a-enviar') continue;   // a conta mudou a meio: o de outra conta não segue
          feitos[r.id] = true;
          if (manualAgora) r.parado = false;
          var res = await enviarUm(r);
          if (res && (res.estado === 'login' || (res.estado === 'pendente' && res.rede))) { parou = true; break; }
        }
      }
    } finally { est.emCurso = false; }
    // Um «Tentar» pedido a meio corre logo a seguir; um pedido automático (temporizador, rede, visibilidade) não: a
    // releitura da fila já apanhou as novas, e as que falharam esperam o recuo (agendar, Retry-After).
    var manualPendente = est.drenarManual && !parou;
    est.drenarManual = false; est.drenarMais = false;
    if (manualPendente) drenar(true);
  }
  function tentarDeNovo(r) { r.parado = false; r.tentativas = 0; r.fotos.forEach(function (f) { if (f.estado === 'erro') f.estado = 'espera'; }); desenharEnvio(r, null); drenar(true); }

  function irParaFalta(fl) {
    if (fl.campo === 'obra') { var b = $('b-obra'); if (b) b.click(); else mostrarErro('e-obra', 'Não há obras ativas na tua conta. Entra outra vez para atualizar a lista.'); return; }
    if (fl.campo === 'texto') {
      var t = $('texto');
      if (String(t.value || '').trim()) mostrarErro('e-texto', fl.texto + '.');
      if (t.scrollIntoView) t.scrollIntoView({ block: 'center' });
      t.focus();
      return;
    }
    if (fl.campo === 'fotos' && !fl.espera) mostrarErro('e-fotos', fl.texto + '.');
  }
  var aoEnviar = M.umaVez(async function () {
    var r = est.rasc;
    r.texto = $('texto').value;
    ['e-obra', 'e-fotos', 'e-texto'].forEach(function (i) { mostrarErro(i, ''); });
    var fl = M.faltaParaEnviar(r, est.aPreparar);
    if (fl) { est.tentou = true; desenharBarra(); irParaFalta(fl); return; }   // o botão não fica mudo: diz o que falta e leva lá
    lsGravar(LS_OBRA, r.projectId);
    var dono = contaAtual();
    $('b-enviar').disabled = true;   // clique duplo: enquanto guarda, a segunda vez é ignorada (umaVez) e o botão fica parado
    M.congelar(r, new Date());
    clearTimeout(tDebounce);
    try { await guardar(r); } finally { $('b-enviar').disabled = false; }
    if (contaAtual() !== dono) { est.alheios.push(r); desenharAlheios(); return; }   // a conta mudou enquanto guardava: este rascunho já não é de quem está agora
    est.pend.push(r);
    novoForm();   // já pronto para a próxima; o rascunho em envio fica na fila
    desenharEnvio(r, null);
    if (!sessaoValida()) { pedirLogin('A sessão expirou. Entra outra vez; o que escreveste está guardado.'); return; }
    drenar(true);
  });
  async function aoCorrigir() {
    var r = est.pend.filter(function (x) { return x.id === est.vistaId; })[0];
    if (!r) return novaOcorrencia();
    if (r.ultimo && r.ultimo.relogin) { r.parado = true; est.pend = est.pend.filter(function (x) { return x !== r; }); reabrirComoForm(r); sair(); return; }
    est.pend = est.pend.filter(function (x) { return x !== r; });
    reabrirComoForm(r);
    est.vistaId = '';
    desenharRegisto();
    var u = r.ultimo;
    if (u && u.mensagem && u.campo) mostrarErro(u.campo === 'obra' ? 'e-obra' : (u.campo === 'fotos' ? 'e-fotos' : 'e-texto'), u.mensagem);   // o que o servidor recusou, ao pé do campo
  }
  function reabrirComoForm(r) {
    M.reabrir(r); r.parado = false;
    if (est.rasc && M.rascunhoVazio(est.rasc)) { apagar(est.rasc.id); }
    est.rasc = r; est.obraOrigem = ''; est.verGrade = false; guardar(r);
  }
  function novaOcorrencia() {
    est.vistaId = ''; faixa('');
    if (!est.rasc || est.rasc.estado !== 'rascunho') novoForm();
    desenharRegisto(); desenharFaixaFila();
  }

  // ── Arranque ──
  async function entrarComForm() {
    var u = $('l-user').value, p = $('l-pass').value;
    mostrarErro('login-erro', ''); $('l-ok').disabled = true;
    var r = await M.login(deps(), u, p);
    $('l-ok').disabled = false; $('l-pass').value = '';
    if (!r.ok) { mostrarErro('login-erro', r.msg); return; }
    est.sessao = r.sessao;
    lsGravar(LS_SESSAO, JSON.stringify(r.sessao));     // só token, validade, conta, nome e obras; nunca a palavra-passe
    faixa('');
    reatribuir();                                      // os rascunhos de outra conta ficam de fora
    if (est.vistaId) { var rr = est.pend.filter(function (x) { return x.id === est.vistaId; })[0]; if (rr) { desenharEnvio(rr, null); } else novaOcorrencia(); }
    else desenharRegisto();
    desenharFaixaFila();
    est.pend.forEach(function (x) { if (x.ultimo && x.ultimo.relogin) x.parado = false; });
    drenar(false);
  }
  function verPalavraPasse() {
    var i = $('l-pass'), b = $('l-ver'), ver = i.type === 'password';
    i.type = ver ? 'text' : 'password';
    b.setAttribute('aria-pressed', ver ? 'true' : 'false');   // o rótulo fica «Mostrar a palavra-passe»: o estado diz-o o aria-pressed
  }
  async function iniciar() {
    try { if (history.state && history.state.mvFolha) history.replaceState(null, ''); } catch (e) { /* sem histórico */ }   // recarregou com uma folha aberta
    preencherIcones(document);
    ligarFolhas();
    est.store = await abrirArmazem();
    est.sessao = lerSessao();
    var todos = [];
    try { todos = await est.store.listar(); } catch (e) { todos = []; }
    todos.sort(function (a, b) { return String(a.criadoEm || a.capturadoEm).localeCompare(String(b.criadoEm || b.capturadoEm)); });
    var todosVivos = [];
    todos.forEach(function (r) {
      if (r.estado === 'entregue') { apagar(r.id); return; }
      todosVivos.push(r);
    });
    est.rasc = null; est.pend = []; est.alheios = [];
    // reparte pelo dono: com a sessão (mesmo caducada) é a conta dela; sem sessão nenhuma, só os sem dono são «seus»
    est.pend = todosVivos.filter(function (r) { return r.estado === 'a-enviar'; });
    est.alheios = todosVivos.filter(function (r) { return r.estado !== 'a-enviar'; });
    reatribuir();
    est.pend.forEach(function (r) { r.tentativas = 0; r.parado = false; });
    $('faixa').addEventListener('click', function () {
      if (!sessaoValida() && est.pend.length) { pedirLogin('A sessão expirou. Entra outra vez; o que escreveste está guardado.'); return; }
      var r = est.pend.filter(function (x) { return x.id !== est.vistaId; })[0]; if (r) desenharEnvio(r, r.ultimo || null);
    });
    ['i-cam', 'i-gal'].forEach(function (id) { $(id).addEventListener('change', function (ev) { var fs = ev.target.files; adicionarFotos(fs).then(function () { ev.target.value = ''; }); }); });
    $('texto').addEventListener('input', function () { est.rasc.texto = $('texto').value; mostrarErro('e-texto', ''); desenharContador(); mudou(); desenharProgresso(); desenharBarra(); });
    $('q-obra').addEventListener('input', desenharListaObras);
    $('q-obra').addEventListener('keydown', function (ev) {   // «Procurar» no teclado: com uma só obra encontrada, escolhe-a
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var l = $('lista-obras').querySelectorAll('.mv-lo'); if (l.length === 1) l[0].click(); else $('q-obra').blur();
    });
    $('fp-nao').addEventListener('click', function () {   // «Não sei, fica só <Produto>»: fica o produto, sai o que estava escolhido
      var p = folhaProd; clearTimeout(tEscolha);
      M.semDefeito(est.rasc, p); mudou(); desenharClassif(); desenharProgresso();
      fecharFolha($('folha-prod'), function () { return resumoDe(p); });
    });
    $('c-defeitos').addEventListener('keydown', function (ev) {
      var ops = Array.prototype.slice.call($('c-defeitos').querySelectorAll('.mv-op')), i = ops.indexOf(document.activeElement), j = -1;
      if (i < 0 || !ops.length) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') j = (i + 1) % ops.length;
      else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') j = (i - 1 + ops.length) % ops.length;
      else if (ev.key === 'Home') j = 0; else if (ev.key === 'End') j = ops.length - 1;
      if (j < 0) return;
      ev.preventDefault(); ops.forEach(function (o, k) { o.tabIndex = k === j ? 0 : -1; }); ops[j].focus();
    });
    $('c-outro').addEventListener('click', function () { est.verGrade = true; desenharClassif(); focar($('c-produtos').querySelector('.mv-tile[aria-pressed="false"]')); });
    $('c-feito').addEventListener('click', function () { est.verGrade = false; desenharClassif(); focar($('c-outro')); });
    $('b-enviar').addEventListener('click', aoEnviar);
    $('f-login').addEventListener('submit', function (ev) { ev.preventDefault(); entrarComForm(); });
    $('l-ver').addEventListener('click', verPalavraPasse);
    $('conta').addEventListener('click', abrirConta);
    $('sair').addEventListener('click', sair);
    $('e-nova').addEventListener('click', novaOcorrencia);
    $('e-retry').addEventListener('click', function () { var r = est.pend.filter(function (x) { return x.id === est.vistaId; })[0]; if (r) tentarDeNovo(r); });
    $('e-corrigir').addEventListener('click', aoCorrigir);
    window.addEventListener('online', function () { desenharFaixaRede(); desenharBarra(); est.pend.forEach(function (r) { r.tentativas = 0; r.fotos.forEach(function (f) { if (f.estado === 'erro') f.estado = 'espera'; }); }); drenar(false); });
    window.addEventListener('offline', function () { desenharFaixaRede(); desenharBarra(); });
    window.addEventListener('scroll', aoRolar, { passive: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) gravarJa(); else drenar(false); });
    window.addEventListener('pagehide', gravarJa);   // fechar o separador ou mudar de app: o que está à espera da pausa grava-se já
    if (typeof ResizeObserver === 'function') { var ro = new ResizeObserver(function () { medirBarra(); }); ro.observe($('cab')); ro.observe($('barra')); }
    ligarTeclado();
    desenharFaixaRede();
    registarSW();
    if (!est.sessao) { pedirLogin(est.pend.length || est.alheios.length || !M.rascunhoVazio(est.rasc) ? 'Entra. O que escreveste está guardado neste telemóvel.' : ''); }
    else { desenharRegisto(); desenharFaixaFila(); drenar(false); }   // sessão caducada: abre na mesma (sem rede); o envio pede o login
    desenharSemArmazem();   // sem IndexedDB: diz-se já, antes de a pessoa escrever
  }

  // ── Service worker: a página abre sem rede (sw.js) ──
  // Só em https ou localhost (num http://IP o browser nem expõe navigator.serviceWorker). A versão nova instala-se à
  // parte e só entra quando a pessoa toca no aviso (ou ao reabrir): nunca a meio de um registo.
  function registarSW() {
    if (!('serviceWorker' in navigator) || !self.isSecureContext) return;
    var nav = navigator.serviceWorker;
    var ativar = function (reg) { if (!reg.waiting) return; est.recarregar = true; reg.waiting.postMessage('ativar'); };
    var avisar = function (reg) {
      var b = $('nova-versao'); if (!b || !reg.waiting) return;
      desenharNovaVersao(); b.hidden = false;
      b.onclick = function () {
        Promise.resolve(gravarJa()).then(function () {   // grava o que está à espera; se a gravação falhar, passa a memória e o teste abaixo vê-o
          var n = est.semArmazem ? trabalhoSoNaPagina() : 0;
          if (n) { avisoNovaVersao(n); return; }   // recarregar apagava-o: espera, salvo «Atualizar na mesma»
          ativar(reg);
        });
      };
      $('nova-versao-esperar').onclick = function () { avisoNovaVersao(0); };
      $('nova-versao-mesmo').onclick = function () { avisoNovaVersao(0); ativar(reg); };
    };
    nav.addEventListener('controllerchange', function () { if (est.recarregar) location.reload(); });
    nav.register('sw.js').then(function (reg) {
      if (reg.waiting && nav.controller) avisar(reg);
      reg.addEventListener('updatefound', function () {
        var n = reg.installing; if (!n) return;
        n.addEventListener('statechange', function () { if (n.state === 'installed' && nav.controller) avisar(reg); });
      });
      var procurar = function () { try { reg.update().catch(function () { /* sem rede */ }); } catch (e) { /* nada */ } };
      procurar();
      document.addEventListener('visibilitychange', function () { if (!document.hidden) procurar(); });
    }).catch(function () { /* a página funciona na mesma, só não abre sem rede */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
}());
