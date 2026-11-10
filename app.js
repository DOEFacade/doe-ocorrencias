/* DOE · Ocorrências pelo telemóvel — ecrãs e armazenamento. A lógica está em logica.js (testada em Node).
   Regras: tudo o que vem do servidor entra no DOM por textContent; a palavra-passe nunca é guardada
   (só o token); o que não foi entregue fica no rascunho (IndexedDB, ou memória se falhar).
   Cada rascunho é da conta que o criou: quem entra a seguir no mesmo telemóvel só envia os seus, e os de outra
   conta ficam guardados e visíveis («só ele pode enviar»), nunca reenviados sob outra identidade.
   A página abre sem rede (sw.js): o registo abre com as obras do último login, mesmo com o token caducado. */
(function () {
  'use strict';
  var M = self.DoeMovel;
  if (self.DOE_MOVEL_CLASSIF) M.definirClassificacao(self.DOE_MOVEL_CLASSIF);   // listas geradas a partir da app (classificacao.js)
  var API = (self.DOE_MOVEL_CONFIG && self.DOE_MOVEL_CONFIG.api) || '';
  var LS_SESSAO = 'doeMovel.sessao', LS_OBRA = 'doeMovel.obra';

  var $ = function (id) { return document.getElementById(id); };
  var est = { sessao: null, rasc: null, pend: [], alheios: [], vistaId: '', recarregar: false, store: null, emCurso: false, timer: null, avisoNotaLogin: '', semArmazem: false };

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
      if (!est.store.memoria) { var antigo = est.store; est.store = armazemMemoria(); est.semArmazem = true; faixa('Não consegui guardar no telemóvel: o que escreveste só fica enquanto esta página estiver aberta.'); try { (await antigo.listar()).forEach(function (x) { est.store.guardar(x); }); } catch (e2) { /* nada */ } }
      await est.store.guardar(r);
    }
  }
  async function apagar(id) { try { await est.store.apagar(id); } catch (e) { /* já não está */ } }

  // ── DOM auxiliar (sempre textContent) ──
  function el(tag, cls, texto) { var e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
  function mostrarTexto(id, texto) { var e = $(id); if (!e) return; if (texto) { e.textContent = texto; e.hidden = false; } else { e.textContent = ''; e.hidden = true; } }
  function faixa(texto, ok) { var f = $('faixa'); if (!texto) { f.hidden = true; f.textContent = ''; return; } f.textContent = texto; f.className = 'faixa' + (ok ? ' ok' : ''); f.hidden = false; clearTimeout(faixa.t); if (ok) faixa.t = setTimeout(function () { faixa(''); desenharFaixaFila(); }, 8000); }
  function ir(vista) {
    ['v-login', 'v-registo', 'v-envio'].forEach(function (v) { $(v).hidden = v !== vista; });
    $('sair').hidden = !est.sessao || vista === 'v-login';
    $('quem').textContent = est.sessao && est.sessao.nome ? est.sessao.nome : 'Registar ocorrência';
    window.scrollTo(0, 0);
  }
  function hora(iso) { try { return new Date(iso).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

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
  function pedirLogin(nota) {
    faixa('');
    est.avisoNotaLogin = nota || '';
    $('login-nota').textContent = nota || 'Usa a tua conta do DOE. Só é preciso uma vez; a sessão fica neste telemóvel durante 10 dias.';
    mostrarTexto('login-erro', '');
    $('l-pass').value = '';
    ir('v-login');
  }
  function sair() {
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
    if (rasc) est.rasc = rasc; else { if (est.rasc && !M.ehDaConta(est.rasc, c)) apagar(est.rasc.id); novoForm(); }
    desenharAlheios();
  }
  function desenharAlheios() {
    var box = $('alheios'); if (!box) return;
    box.textContent = '';
    est.alheios.forEach(function (r) {
      var nome = r.contaNome || 'outra conta', p = el('p', 'suave');
      p.textContent = 'Rascunho de ' + nome + ', só essa conta pode enviar' + (r.numero ? ' (já registada como ' + r.numero + ')' : '') + '.';
      box.appendChild(p);
    });
    box.hidden = !est.alheios.length;
  }

  // ── Obras ──
  function preencherObras() {
    var s = $('obra'); s.textContent = '';
    var obras = (est.sessao && est.sessao.obras) || [];
    var p = el('option', null, obras.length ? 'Escolhe a obra' : 'Sem obras ativas'); p.value = ''; s.appendChild(p);
    obras.forEach(function (o) { var op = el('option', null, o.codigo ? o.codigo + ' · ' + o.nome : o.nome); op.value = o.id; s.appendChild(op); });
    var link = ''; try { link = new URLSearchParams(location.search).get('obra') || ''; } catch (e) { link = ''; }
    var escolhida = est.rasc && est.rasc.projectId && obras.some(function (o) { return o.id === est.rasc.projectId; })
      ? est.rasc.projectId : M.escolherObra(obras, link, lsLer(LS_OBRA));
    s.value = escolhida; if (est.rasc && !est.rasc.projectId) est.rasc.projectId = escolhida;
  }

  // ── Rascunho ──
  function novoForm() { est.rasc = M.novoRascunho({ id: M.novoId(), projectId: '', contaId: contaAtual(), contaNome: (est.sessao && est.sessao.nome) || '' }); }
  var tDebounce = null;
  function mudou() {
    if (!est.rasc || est.rasc.estado !== 'rascunho') return;
    if (!M.rascunhoVazio(est.rasc)) M.marcarCaptura(est.rasc, new Date());
    clearTimeout(tDebounce);
    tDebounce = setTimeout(function () { if (M.rascunhoVazio(est.rasc)) apagar(est.rasc.id); else guardar(est.rasc); }, 300);
  }
  function desenharRegisto() {
    var r = est.rasc;
    preencherObras();
    $('texto').value = r.texto || '';
    desenharMiniaturas();
    desenharClassif();
    if (M.temClassificacao(r)) $('classif').open = true;
    ['e-obra', 'e-fotos', 'e-texto'].forEach(function (i) { mostrarTexto(i, ''); });
    $('rasc-nota').textContent = !sessaoValida() ? 'A sessão expirou: ao enviar vais precisar de entrar (com rede). O que escreveres fica guardado neste telemóvel.' : est.semArmazem ? 'Atenção: este telemóvel não deixa guardar. Não feches a página.' : (r.fotos.length || r.texto ? 'Referência ' + M.referencia(r.id) + ' · guardado neste telemóvel' : '');
    $('b-cam').disabled = $('b-gal').disabled = !M.podeAcrescentarFoto(r);
    ir('v-registo');
  }
  // ── Classificação opcional (Produto + o que aconteceu): fechada por omissão, abre com um toque ──
  // Tudo entra no DOM por textContent. Nada aqui bloqueia o envio.
  function desenharClassif() {
    var box = $('classif');
    if (!M.classificacaoDisponivel()) { box.hidden = true; return; }
    box.hidden = false;
    var r = est.rasc, c = M.classificacaoDe(r);
    var res = M.resumoClassificacao(r);
    $('classif-res').textContent = res || 'opcional';
    $('classif-res').className = 'classif-res' + (res ? ' feito' : '');
    var prods = $('c-produtos'); prods.textContent = '';
    self.DOE_MOVEL_CLASSIF.produtos.forEach(function (p) {
      var on = c.tipoProduto.indexOf(p) >= 0, b = el('button', 'chip', p);
      b.type = 'button'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () { M.alternarProduto(est.rasc, p); mudou(); desenharClassif(); });
      prods.appendChild(b);
    });
    var defs = $('c-defeitos'); defs.textContent = '';
    c.tipoProduto.forEach(function (p) {
      var g = el('div', 'opcoes'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', p + ': o que aconteceu?');
      g.appendChild(el('div', 'rotulo', p + ': o que aconteceu?'));
      M.defeitosDe(p).forEach(function (d) {
        var on = c.defeitos[p] === d.key, b = el('button', 'opcao');
        b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.appendChild(el('span', 'opcao-t', d.label)); b.appendChild(el('span', 'opcao-d', d.hint));
        b.addEventListener('click', function () { M.escolherDefeito(est.rasc, p, d.key); mudou(); desenharClassif(); });
        g.appendChild(b);
      });
      defs.appendChild(g);
    });
  }
  function desenharMiniaturas() {
    var box = $('minis'); box.textContent = '';
    est.rasc.fotos.forEach(function (f, i) {
      if (!f.prev && f.blob) f.prev = URL.createObjectURL(f.blob);
      var m = el('div', 'mini'), img = el('img'); img.alt = 'Foto ' + (i + 1); img.src = f.prev || '';
      var b = el('button'); b.type = 'button'; b.setAttribute('aria-label', 'Tirar a foto ' + (i + 1));
      b.appendChild(el('span', null, '✕'));
      b.addEventListener('click', function () { if (f.prev) URL.revokeObjectURL(f.prev); est.rasc.fotos.splice(i, 1); mudou(); desenharRegisto(); });
      m.appendChild(img); m.appendChild(b); box.appendChild(m);
    });
    $('b-cam').disabled = $('b-gal').disabled = !M.podeAcrescentarFoto(est.rasc);
  }

  // ── Fotos: compressão no telemóvel (o canvas retira o EXIF/GPS) ──
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
  async function adicionarFotos(lista) {
    var files = Array.prototype.slice.call(lista || []);
    mostrarTexto('e-fotos', '');
    if (!files.length) return;
    $('foto-prep').hidden = false;
    var erros = [];
    for (var i = 0; i < files.length; i++) {
      if (!M.podeAcrescentarFoto(est.rasc)) { erros.push('No máximo ' + M.LIMITES.fotos + ' fotos por ocorrência.'); break; }
      try {
        var c = await comprimir(files[i]);
        est.rasc.fotos.push({ blob: c.blob, tipo: c.tipo, tamanho: c.tamanho, sha256: c.sha256, estado: 'espera', n: 0 });
        mudou(); desenharMiniaturas();
      } catch (e) { erros.push((e && e.message) || M.MSG_FOTO_ILEGIVEL); }
    }
    $('foto-prep').hidden = true;
    if (erros.length) mostrarTexto('e-fotos', erros[0]);
    desenharRegisto();
  }

  // ── Envio ──
  function listaPendentes() { return est.pend.filter(function (r) { return r.estado === 'a-enviar'; }); }
  function desenharFaixaFila() {
    var n = est.pend.filter(function (r) { return r.estado === 'a-enviar' && r.id !== est.vistaId; }).length;
    if (n && !sessaoValida()) faixa(n === 1 ? '1 ocorrência guardada no telemóvel, por enviar. Toca para entrar e enviar (precisa de rede).' : n + ' ocorrências guardadas no telemóvel, por enviar. Toca para entrar e enviar (precisa de rede).');
    else if (n) faixa(n === 1 ? '1 ocorrência guardada no telemóvel, por enviar. Toca para ver; envia-se quando houver rede (com a página aberta).' : n + ' ocorrências guardadas no telemóvel, por enviar. Tocam para ver; enviam-se quando houver rede (com a página aberta).');
    else if (!$('faixa').classList.contains('ok')) faixa('');
  }
  function desenharEnvio(r, res) {
    var c = M.contarFotos(r);
    var selo = $('e-selo'), titulo = $('e-titulo'), num = $('e-num'), sub = $('e-sub');
    var retry = $('e-retry'), corr = $('e-corrigir'), box = $('ev-fotos');
    selo.className = 'selo'; num.hidden = true; retry.hidden = corr.hidden = true; mostrarTexto('e-erro', '');
    est.vistaId = r.id;
    if (r.estado === 'entregue') {
      selo.textContent = '✓'; titulo.textContent = 'Recebida'; num.textContent = r.numero; num.hidden = false;
      sub.textContent = 'Ocorrência ' + r.numero + ' registada' + (r.recebidaEm ? ' às ' + hora(r.recebidaEm) : '') + '.';
      box.hidden = true;
    } else if (r.numero) {
      selo.className = 'selo ama'; selo.textContent = '…'; titulo.textContent = 'Registada'; num.textContent = r.numero; num.hidden = false;
      sub.textContent = M.textoEstado(r) + (c.faltam ? ' Faltam ' + c.faltam + (c.faltam === 1 ? ' foto.' : ' fotos.') : '');
    } else if (res && (res.estado === 'corrigir' || res.estado === 'parar')) {
      selo.className = 'selo neg'; selo.textContent = '!'; titulo.textContent = 'Não foi enviada';
      sub.textContent = 'Referência ' + M.referencia(r.id) + '. O que escreveste continua guardado.';
    } else if (res && res.estado === 'pendente' && res.rede) {
      selo.className = 'selo ama'; selo.textContent = '↻'; titulo.textContent = 'Guardada no telemóvel';
      sub.textContent = 'Referência ' + M.referencia(r.id) + '. Envia-se quando houver rede. A página tem de estar aberta.';
    } else if (res && res.estado === 'pendente') {
      selo.className = 'selo ama'; selo.textContent = '↻'; titulo.textContent = 'Guardada no telemóvel';
      sub.textContent = 'Referência ' + M.referencia(r.id) + '. Vai tentar outra vez.';
    } else {
      selo.className = 'selo ama'; selo.textContent = '…'; titulo.textContent = 'A enviar'; sub.textContent = 'Referência ' + M.referencia(r.id) + '. Não feches a página.';
      selo.classList.add('pulsa');
    }
    // fotos: uma linha por foto
    box.textContent = '';
    if (r.estado !== 'entregue' && r.fotos.length) {
      box.hidden = false;
      r.fotos.forEach(function (f, i) {
        var li = el('div', 'linha-foto'), nome = el('div', null, 'Foto ' + (i + 1)), d = el('div', 'estado');
        if (f.estado === 'confirmada') { d.textContent = 'Enviada'; d.classList.add('bom'); }
        else if (f.estado === 'a-enviar') { d.textContent = 'A enviar…'; d.classList.add('pulsa'); }
        else if (f.estado === 'erro') { d.textContent = f.erro || 'Falhou'; d.classList.add('mau'); }
        else d.textContent = r.numero ? 'À espera' : 'Depois do texto';
        li.appendChild(nome); li.appendChild(d);
        if (f.estado === 'erro') { var b = el('button', 'btn peq', 'Tentar de novo'); b.type = 'button'; b.addEventListener('click', function () { tentarDeNovo(r); }); li.appendChild(b); }
        box.appendChild(li);
      });
    } else box.hidden = true;
    if (res && res.mensagem && r.estado !== 'entregue') mostrarTexto('e-erro', res.estado === 'pendente' && res.rede ? '' : res.mensagem);
    if (r.estado !== 'entregue') {
      if (res && res.estado === 'corrigir' && !r.numero) corr.hidden = false;
      else if (res && (res.estado === 'parar' || res.estado === 'pendente')) retry.hidden = false;
    }
    ir('v-envio');
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
        else faixa('Ocorrência ' + r.numero + ' recebida.', true);
        est.pend = est.pend.filter(function (x) { return x.id !== r.id; });
        if (est.alheios.some(function (x) { return x.id === r.id; })) { est.alheios = est.alheios.filter(function (x) { return x.id !== r.id; }); desenharAlheios(); }   // acabou de seguir depois de a conta mudar
        setTimeout(function () { apagar(r.id); }, 0);
      } else if (res.estado === 'login') {
        pedirLogin(res.mensagem);
      } else {
        r.tentativas = (r.tentativas || 0) + 1;
        if (res.estado === 'corrigir' || res.estado === 'parar') r.parado = true;
        if (est.vistaId === r.id) desenharEnvio(r, res);
        if (res.estado === 'pendente') agendar(res.retryAfter);
      }
      desenharFaixaFila();
      return res;
    } finally { delete emEnvio[r.id]; }
  }
  function agendar(retryAfter) {
    clearTimeout(est.timer);
    var maxT = Math.max.apply(null, [0].concat(est.pend.map(function (r) { return r.tentativas || 0; })));
    var ms = M.esperaRetry(Math.max(0, maxT - 1), retryAfter);
    if (ms == null) return;
    est.timer = setTimeout(drenar, ms);
  }
  async function drenar(manual) {
    if (est.emCurso) return;
    // Sem sessão válida a página não se fecha ao registo (pode estar sem rede): só um envio pedido pela pessoa pede o login.
    if (!sessaoValida()) { if (manual === true && est.pend.some(function (r) { return !r.parado; })) pedirLogin('A sessão expirou. Entra outra vez; o que escreveste está guardado.'); else desenharFaixaFila(); return; }
    est.emCurso = true;
    try {
      var lista = listaPendentes().filter(function (r) { return M.ehDaConta(r, contaAtual()) && (manual === true || !r.parado); });
      for (var i = 0; i < lista.length; i++) {
        if (manual === true) lista[i].parado = false;
        var res = await enviarUm(lista[i]);
        if (res && (res.estado === 'login' || (res.estado === 'pendente' && res.rede))) break;
      }
    } finally { est.emCurso = false; }
  }
  function tentarDeNovo(r) { r.parado = false; r.tentativas = 0; r.fotos.forEach(function (f) { if (f.estado === 'erro') f.estado = 'espera'; }); desenharEnvio(r, null); drenar(true); }

  var aoEnviar = M.umaVez(async function () {
    var r = est.rasc;
    r.texto = $('texto').value;
    ['e-obra', 'e-fotos', 'e-texto'].forEach(function (i) { mostrarTexto(i, ''); });
    var ok = M.podeEnviar(r);
    if (!ok.ok) { mostrarTexto(ok.campo === 'obra' ? 'e-obra' : (ok.campo === 'fotos' ? 'e-fotos' : 'e-texto'), ok.motivo); return; }
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
    desenharRegisto();
  }
  function reabrirComoForm(r) {
    M.reabrir(r); r.parado = false;
    if (est.rasc && M.rascunhoVazio(est.rasc)) { apagar(est.rasc.id); }
    est.rasc = r; guardar(r);
  }
  function novaOcorrencia() {
    est.vistaId = ''; faixa('');
    if (!est.rasc || est.rasc.estado !== 'rascunho') novoForm();
    desenharRegisto(); desenharFaixaFila();
  }

  // ── Arranque ──
  async function entrarComForm() {
    var u = $('l-user').value, p = $('l-pass').value;
    mostrarTexto('login-erro', ''); $('l-ok').disabled = true;
    var r = await M.login(deps(), u, p);
    $('l-ok').disabled = false; $('l-pass').value = '';
    if (!r.ok) { mostrarTexto('login-erro', r.msg); return; }
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
  async function iniciar() {
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
    $('b-cam').addEventListener('click', function () { $('i-cam').click(); });
    $('b-gal').addEventListener('click', function () { $('i-gal').click(); });
    ['i-cam', 'i-gal'].forEach(function (id) { $(id).addEventListener('change', function (ev) { var fs = ev.target.files; adicionarFotos(fs).then(function () { ev.target.value = ''; }); }); });
    $('texto').addEventListener('input', function () { est.rasc.texto = $('texto').value; mostrarTexto('e-texto', ''); mudou(); });
    $('obra').addEventListener('change', function () { est.rasc.projectId = $('obra').value; mostrarTexto('e-obra', ''); mudou(); });
    $('b-enviar').addEventListener('click', aoEnviar);
    $('f-login').addEventListener('submit', function (ev) { ev.preventDefault(); entrarComForm(); });
    $('sair').addEventListener('click', sair);
    $('e-nova').addEventListener('click', novaOcorrencia);
    $('e-retry').addEventListener('click', function () { var r = est.pend.filter(function (x) { return x.id === est.vistaId; })[0]; if (r) tentarDeNovo(r); });
    $('e-corrigir').addEventListener('click', aoCorrigir);
    window.addEventListener('online', function () { est.pend.forEach(function (r) { r.tentativas = 0; r.fotos.forEach(function (f) { if (f.estado === 'erro') f.estado = 'espera'; }); }); drenar(false); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) drenar(false); });
    registarSW();
    if (!est.sessao) { pedirLogin(est.pend.length || est.alheios.length || !M.rascunhoVazio(est.rasc) ? 'Entra. O que escreveste está guardado neste telemóvel.' : ''); }
    else { desenharRegisto(); desenharFaixaFila(); drenar(false); }   // sessão caducada: abre na mesma (sem rede); o envio pede o login
  }

  // ── Service worker: a página abre sem rede (sw.js) ──
  // Só em https ou localhost (num http://IP o browser nem expõe navigator.serviceWorker). A versão nova instala-se à
  // parte e só entra quando a pessoa toca no aviso (ou ao reabrir): nunca a meio de um registo.
  function registarSW() {
    if (!('serviceWorker' in navigator) || !self.isSecureContext) return;
    var nav = navigator.serviceWorker;
    var avisar = function (reg) { var b = $('nova-versao'); if (!b || !reg.waiting) return; b.hidden = false; b.onclick = function () { est.recarregar = true; reg.waiting.postMessage('ativar'); }; };
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
