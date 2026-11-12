/* DOE · Telemóvel — a casca da app (1.ª fatia, 12 nov 2026): barra de baixo (Hoje · Tarefas · + · Pessoal · Conta),
   o Hoje (mosaico), o Diário de obra, «Diário · 7 dias», «Por enviar» e a Conta. Desenho: protótipo validado pelo Pedro,
   docs/prototipos/DOEX-Telemovel-App-Prototipo.html. A lógica do diário está em diario.js (testada em Node); a da
   ocorrência continua em logica.js/app.js, igual por dentro: a casca só a abre.
   Regras: tudo o que vem do servidor entra por textContent; os ícones são dados (icones.js); a cache das leituras é da
   conta que a leu e apaga-se ao Sair, ao desligar, com o token revogado e quando entra outra conta.
   Os diários (a fila e os rascunhos) vivem numa base PRÓPRIA (IndexedDB «doeMovelDiario»), à parte da das ocorrências
   («doeMovel»): uma página antiga, que não conhece o diário, nunca os vê nem os apaga (recuo seguro, LEIA-ME).
   Correcções da revisão (12 nov 2026): o formulário nunca envia uma lista que não leu (A1); a fila segue ao reabrir (A2);
   sessão caducada ao guardar (A3); uma foto sem ficheiro neste telemóvel não prende a fila (A4); rascunho do diário (M1);
   o histórico só marca o que o servidor aceitou (M2); os 7 dias da obra pelo servidor e os feriados (M3); o que nunca saiu
   do telemóvel substitui-se (M4); envios de outra conta sem texto e o token revogado limpa as leituras (M5); desligar
   sem Desfazer (M6); Corrigir da ocorrência volta ao formulário (M7); o formulário redesenha-se por zonas (M8).
   Carrega ANTES de app.js; o app.js chama DoeMovelCasca.ligar(ponte) no arranque. Nada aqui mexe no DOM antes disso. */
(function () {
  'use strict';
  var D = self.DoeMovelDiario, M = self.DoeMovel;
  var A = null;                                   // a ponte para app.js
  var LS_CACHE = 'doeMovel.cache', LS_OBRA_HOJE = 'doeMovel.obraHoje', DB_NOME = 'doeMovelDiario', STORE = 'fila';
  var ESPERAS_LER = self.DOE_MOVEL_ESPERAS_LER || [5000, 30000, 120000];   // (os testes encurtam-nas)
  var MS_RELER = 30 * 1000, MS_LOCS = 12 * 3600 * 1000, ESPERAS = [2000, 10000, 60000], MS_RASCUNHO = 300;
  var ROTULO = { 'v-hoje': 'Hoje', 'v-fila': 'Por enviar', 'v-diario7': 'Diário · 7 dias', 'v-diario': 'Diário', 'v-registo': 'Ocorrência', 'v-envio': 'Ocorrência', 'v-dia-envio': 'Diário' };
  var TITULO = { 'v-diario': 'Diário de obra', 'v-dia-envio': 'Diário de obra', 'v-diario7': 'Diário · 7 dias', 'v-fila': 'Por enviar' };
  var c = { cache: null, fila: [], rascunhos: {}, vista: '', pilha: [], form: null, envio: null, lendo: false, lidoMs: 0, aviso: '', timer: null, emCurso: false, tentativas: 0, obraHoje: '', entrou: false, apagar: {}, rotaInicial: '', store: null, memoria: false, antes: '' };
  var $ = function (id) { return document.getElementById(id); };
  function feriados() { return self.DOE_MOVEL_FERIADOS || {}; }

  // ── DOM (sempre textContent) ──
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function bt(cls, txt) { var b = el('button', cls, txt); b.type = 'button'; return b; }
  function ic(n, cls) { return A.icone(n, cls); }
  function junta(pai) { for (var i = 1; i < arguments.length; i++) { var x = arguments[i]; if (x == null || x === false) continue; pai.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); } return pai; }
  function limpar(e) { while (e && e.firstChild) e.removeChild(e.firstChild); return e; }
  function semMov() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  // ── Sessão, conta, funcionalidades ──
  function sessao() { return A.sessao() || null; }
  function contaId() { var s = sessao(); return (s && s.contaId) || ''; }
  function obras() { var s = sessao(); return (s && Array.isArray(s.obras)) ? s.obras : []; }
  function obraDe(id) { return obras().filter(function (o) { return o.id === id; })[0] || null; }
  function funcs() { var s = sessao(); return s && Array.isArray(s.funcionalidades) ? s.funcionalidades : ['ocorrencia']; }
  function tem(f) { return funcs().indexOf(f) >= 0; }
  function online() { return navigator.onLine !== false; }
  function primeiroNome(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

  // ── A base dos diários (IndexedDB própria; memória como reserva) ──
  function armazemMemoria() { var m = new Map(); return { memoria: true, listar: function () { return Promise.resolve(Array.from(m.values())); }, guardar: function (r) { m.set(r.id, r); return Promise.resolve(); }, apagar: function (id) { m.delete(id); return Promise.resolve(); } }; }
  function abrirStore() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') return resolve(armazemMemoria());
      var req; try { req = indexedDB.open(DB_NOME, 1); } catch (e) { return resolve(armazemMemoria()); }
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onerror = req.onblocked = function () { resolve(armazemMemoria()); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = function (modo, fn) { return new Promise(function (res, rej) { try { var t = db.transaction(STORE, modo), q = fn(t.objectStore(STORE)); t.oncomplete = function () { res(q && q.result); }; t.onerror = t.onabort = function () { rej(t.error); }; } catch (e) { rej(e); } }); };
        resolve({ memoria: false, listar: function () { return tx('readonly', function (s) { return s.getAll(); }); }, guardar: function (r) { return tx('readwrite', function (s) { return s.put(r); }); }, apagar: function (id) { return tx('readwrite', function (s) { return s.delete(id); }); } });
      };
    });
  }
  function paraDisco(r) {   // sem as miniaturas (endereços temporários da página)
    var x = Object.assign({}, r);
    if (x.fotos) x.fotos = x.fotos.map(function (f) { var g = Object.assign({}, f); delete g.prev; return g; });
    if (x.form) { x.form = Object.assign({}, x.form); x.form.fotos = (x.form.fotos || []).map(function (f) { var g = Object.assign({}, f); delete g.prev; return g; }); }
    return x;
  }
  async function guardarItem(r) {
    if (!c.store) c.store = armazemMemoria();
    try { await c.store.guardar(paraDisco(r)); }
    catch (e) { if (!c.store.memoria) { var velho = c.store; c.store = armazemMemoria(); c.memoria = true; try { (await velho.listar()).forEach(function (x) { c.store.guardar(x); }); } catch (e2) { /* nada */ } } await c.store.guardar(r); }
  }
  function apagarItem(id) { if (c.store) c.store.apagar(id).catch(function () { /* já não está */ }); }
  function semArmazem() { return A.semArmazem() || c.memoria; }

  // ── Cache por conta (localStorage; nunca de outra conta) ──
  function lsLer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsGravar(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsApagar(k) { try { localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } }
  function cache() {
    var id = contaId();
    if (!c.cache || c.cache.contaId !== id) {
      var lido = null; try { lido = JSON.parse(lsLer(LS_CACHE) || 'null'); } catch (e) { lido = null; }
      c.cache = D.cacheDaConta(lido, id);
      if (lido && lido.contaId !== id) lsApagar(LS_CACHE);   // a de outra conta sai do telemóvel
    }
    return c.cache;
  }
  function gravarCache() { if (c.cache && c.cache.contaId) lsGravar(LS_CACHE, JSON.stringify(c.cache)); }
  function apagarCache() { c.cache = null; lsApagar(LS_CACHE); lsApagar(LS_OBRA_HOJE); c.obraHoje = ''; c.form = null; c.envio = null; c.lidoMs = 0; }

  // ── O dia (o do servidor) e a obra do Hoje ──
  function hojeDia() {
    var d = D.diaAtual(cache().hoje, Date.now());
    if (d) return d;
    var x = new Date(), dia = x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2);
    return { dia: dia, fechaEm: '', estimado: true };
  }
  function obraHoje() {
    var l = obras(), ok = function (id) { return id && l.some(function (o) { return o.id === id; }); };
    if (ok(c.obraHoje)) return c.obraHoje;
    var ch = cache(), cands = [lsLer(LS_OBRA_HOJE), ch.hoje && ch.hoje.obraSugerida, lsLer('doeMovel.obra')];
    for (var i = 0; i < cands.length; i++) if (ok(cands[i])) { c.obraHoje = cands[i]; return c.obraHoje; }
    c.obraHoje = l.length ? l[0].id : '';
    return c.obraHoje;
  }

  // ── Rede (para diario.js) ──
  function deps() {
    var conta = contaId();
    return {
      fetch: function (u, o) { return self.fetch(u, o); }, base: A.api(), token: A.token, online: online,
      agora: function () { return new Date(); }, contaId: contaId, novoId: function () { return M.novoId(); },
      guardar: guardarItem,
      contrato: function () { var ch = cache(); if (!c.leuNestaAbertura) return 0; return ch.hoje && typeof ch.hoje.contrato === 'number' ? ch.hoje.contrato : 0; },   // 3.ª revisão: só o de uma leitura bem-sucedida NESTA abertura (um recuo da Edge não reabre a perda de dados); ausente = 0
      versaoAtual: function (id) { var ch = cache(); return ch.contaId === conta && ch.versoes[id] != null ? ch.versoes[id] : null; },
      aoGravado: function (item, data) {   // só o que o servidor ACEITOU entra no histórico e na cópia do registo (M2, A1)
        if (contaId() !== conta) return;
        var ch = cache(), k = D.chaveDia(item.obraId, item.dia);
        ch.ids[k] = data.id; ch.versoes[data.id] = data.versao;
        ch.registos[k] = D.registoDaResposta(item, data, ch.registos[k]);
        if (item.resposta && item.resposta.reler) ch.reler[item.obraId] = true;
        D.registarHistorico(ch, { obraId: item.obraId, dia: item.dia, equipas: item.equipas, texto: ch.registos[k].texto, fotos: item.fotos.length, versao: data.versao, alteradoEm: new Date().toISOString() }, hojeDia().dia);
        if (ch.hoje && ch.hoje.dia === item.dia) {
          ch.hoje.meus = (ch.hoje.meus || []).filter(function (m) { return m.obraId !== item.obraId; });
          ch.hoje.meus.push({ id: data.id, obraId: item.obraId, versao: data.versao, totalHomens: D.totalHomens(item.equipas), alteradoEm: new Date().toISOString() });
        }
        if (ch.obras[item.obraId]) ch.obras[item.obraId].lidoEm = '';   // relê-se ao abrir (com rede); sem rede vale a cópia
        if (ch.dias[item.obraId] && ch.dias[item.obraId].data) D.diasComMeu(ch.dias[item.obraId].data, item.dia, { id: data.id, versao: data.versao, totalHomens: D.totalHomens(item.equipas) }, item.equipas);   // a releitura acerta o total da obra
        gravarCache();
      },
    };
  }
  /** Um erro que pede o login: com o token revogado sai de vez (a sessão e as leituras); senão pede só o login. A fila fica. */
  function talvezLogin(m) {
    if (!m || m.accao !== 'login') return false;
    if (m.revogado) { apagarCache(); A.sairCom(m.texto); } else A.pedirLogin(m.texto);
    return true;
  }

  // ── Leituras (rotas 2, 3, dias e 4): ao abrir o Hoje e ao voltar ao separador ──
  async function ler(forcar) {
    if (!sessao() || !A.sessaoValida() || !tem('diario') || c.lendo) return;
    if (!forcar && Date.now() - c.lidoMs < MS_RELER) { drenar(false); return; }   // lido há pouco: a fila pode seguir
    if (!online()) { redesenhar(); return; }
    var conta = contaId(), dp = deps();
    c.lendo = true; redesenhar();
    try {
      var r2 = await D.lerHoje(dp);
      if (contaId() !== conta) return;
      if (!r2.ok) {
        var m2 = D.mensagemDiario(r2); if (talvezLogin(m2)) return; c.aviso = r2.code === 'DIARIO_POR_INSTALAR' || r2.code === 'MOVEL_POR_INSTALAR' ? m2.texto : '';
        if (online() && m2.accao === 'repetir') { var ms = ESPERAS_LER[Math.min(c.falhasLer || 0, ESPERAS_LER.length - 1)]; c.falhasLer = (c.falhasLer || 0) + 1; clearTimeout(c.timerLer); c.timerLer = setTimeout(function () { ler(true); }, Math.max(ms, (m2.retryAfter || 0) * 1000)); }   // 3.ª revisão: a leitura falhada com rede volta a tentar (5 s, 30 s, 2 min)
        return;
      }
      c.aviso = ''; c.falhasLer = 0; c.leuNestaAbertura = true;
      D.guardarHoje(cache(), r2.data);
      var ob = obraHoje();
      if (ob) {
        var r3 = await D.lerObra(dp, ob);
        if (contaId() !== conta) return;
        if (r3.ok) D.guardarObra(cache(), ob, r3.data); else if (talvezLogin(D.mensagemDiario(r3))) return;
        await lerDiasDe(ob, dp, conta);
        var lc = cache().locs[ob];
        if (!lc || Date.now() - Date.parse(lc.lidoEm || 0) > MS_LOCS) {
          var r4 = await D.lerLocalizacoes(dp, ob);
          if (contaId() === conta && r4.ok) cache().locs[ob] = { produtos: r4.data.produtos || [], lidoEm: new Date().toISOString() };
        }
      }
      c.lidoMs = Date.now();
      gravarCache();
      if (minhaFila().some(function (q) { return q.estado === 'a-enviar'; })) setTimeout(function () { drenar(false); }, 0);   // depois da leitura (que diz o contrato do servidor), a fila segue
    } finally { c.lendo = false; redesenhar(); }
  }
  async function lerDiasDe(ob, dp, conta) {
    var r = await D.lerDias(dp || deps(), ob);
    if (contaId() !== (conta || contaId())) return false;
    if (r.ok) { cache().dias[ob] = { data: r.data, lidoEm: new Date().toISOString() }; gravarCache(); return true; }
    return false;   // rota ainda por publicar (404) ou sem rede: fica a cópia, se houver
  }
  /** Antes de abrir o formulário: o registo desta obra lido agora (sempre que há rede). */
  async function lerObraAgora(ob) {
    if (!A.sessaoValida() || !online()) return false;
    var conta = contaId(), r3 = await D.lerObra(deps(), ob);
    if (contaId() !== conta) return false;
    if (r3.ok) { D.guardarObra(cache(), ob, r3.data); gravarCache(); return true; }
    var m = D.mensagemDiario(r3);
    if (talvezLogin(m)) return false;
    if (r3.code === 'OBRA_INVALIDA') toast(m.texto);
    return false;
  }
  async function lerLocsAgora(ob) {
    if (!A.sessaoValida() || !online()) return;
    var conta = contaId(), r4 = await D.lerLocalizacoes(deps(), ob);
    if (contaId() === conta && r4.ok) { cache().locs[ob] = { produtos: r4.data.produtos || [], lidoEm: new Date().toISOString() }; gravarCache(); }
  }

  // ── Navegação: uma pilha de ecrãs, com o «voltar» do telemóvel (history) ──
  function ehCasca(v) { return v === 'v-hoje' || v === 'v-diario' || v === 'v-dia-envio' || v === 'v-diario7' || v === 'v-fila'; }
  function mostrar(v) {
    if (v !== c.vista) tirarToast();
    c.vista = v;
    A.ir(v);
    if (v === 'v-hoje') desenharHoje(); else if (v === 'v-diario') desenharDiario(true); else if (v === 'v-dia-envio') desenharDiaEnvio(); else if (v === 'v-diario7') desenharDiario7(); else if (v === 'v-fila') desenharFila();
    desenharNav();
    var t = document.querySelector('#' + v + ' [data-foco-inicial]'); if (t) A.focar(t);
  }
  function abrir(v, substituir, daFolha) {
    if (c.vista === 'v-registo') A.gravarJa();
    if (substituir && c.pilha.length) c.pilha[c.pilha.length - 1] = v; else c.pilha.push(v);
    try { var st = { mvV: v, n: c.pilha.length }; if (substituir || daFolha) history.replaceState(st, ''); else history.pushState(st, ''); } catch (e) { /* sem histórico */ }
    if (v === 'v-registo') { tirarToast(); c.vista = v; A.abrirOcorrencia(); desenharNav(); return; }
    mostrar(v);
  }
  function irHoje() {
    if (c.vista === 'v-registo') A.gravarJa();
    gravarRascunhoJa();
    c.pilha = ['v-hoje'];
    try { history.replaceState({ mvV: 'v-hoje', n: 1 }, ''); } catch (e) { /* nada */ }
    mostrar('v-hoje');
    ler(false);
  }
  function voltar() {
    gravarRascunhoJa();
    if (c.pilha.length > 1) { try { history.back(); return; } catch (e) { /* segue */ } c.pilha.pop(); var v = c.pilha[c.pilha.length - 1]; if (v === 'v-hoje') irHoje(); else mostrar(v); return; }
    irHoje();
  }
  function aoVoltarHist(ev) {
    var st = ev && ev.state;
    if (!st || !st.mvV) return;                           // a entrada de uma folha (app.js trata dela) ou de fora da app: não é navegação
    if (!sessao() || A.vista() === 'v-login') return;
    var v = st.mvV;
    c.pilha = st.n > 1 ? c.pilha.slice(0, st.n - 1).concat([v]) : [v];
    if (c.vista === 'v-registo' && v !== 'v-registo') A.gravarJa();
    if (c.vista === 'v-diario' && v !== 'v-diario') gravarRascunhoJa();
    if (v === A.vista() && v === c.vista) return;
    if (v === 'v-registo' || v === 'v-envio') { c.vista = v; if (v === 'v-registo') A.abrirOcorrencia(); desenharNav(); return; }
    if (v === 'v-dia-envio' && !c.envio) v = 'v-hoje';
    if (v === 'v-diario' && !c.form) v = 'v-hoje';
    mostrar(v);
    if (v === 'v-hoje') ler(false);
  }
  function rotuloVoltar() { var p = c.pilha.length > 1 ? c.pilha[c.pilha.length - 2] : 'v-hoje'; return ROTULO[p] || 'Hoje'; }

  // ── Barra de baixo: Hoje · Tarefas · + · Pessoal · Conta ──
  function desenharNav() {
    var n = $('nav'); if (!n) return;
    limpar(n);
    var dest = function (k, nomeIc, rot, embreve) {
      var b = bt('mv-dest'); b.appendChild(ic(nomeIc)); b.appendChild(el('span', null, rot));
      if (k === 'hoje' && c.vista === 'v-hoje') b.setAttribute('aria-current', 'page');
      if (embreve) { b.setAttribute('aria-disabled', 'true'); b.classList.add('embreve'); b.addEventListener('click', function () { toast(embreve); }); }
      else b.addEventListener('click', function () { A.fecharFolhas(); irHoje(); });
      return b;
    };
    n.appendChild(dest('hoje', 'casa', 'Hoje'));
    n.appendChild(dest('tarefas', 'lista', 'Tarefas', 'Tarefas chega em breve. Por agora vês as tuas tarefas no computador.'));
    var reg = bt('mv-reg'); reg.setAttribute('aria-label', 'Registar'); reg.setAttribute('aria-haspopup', 'dialog'); reg.id = 'b-registar'; reg.appendChild(ic('mais'));
    reg.addEventListener('click', abrirRegistar); n.appendChild(reg);
    n.appendChild(dest('pessoal', 'pessoa', 'Pessoal', 'Pessoal chega em breve: férias e despesas. Por agora, no computador.'));
    var s = sessao(), conta = bt('mv-dest'); conta.id = 'b-conta';
    conta.setAttribute('aria-label', 'Conta' + (s && s.nome ? ': ' + s.nome : '')); conta.setAttribute('aria-haspopup', 'dialog');
    junta(conta, el('span', 'mv-av-n', M.iniciais(s && s.nome) || '·'), el('span', null, 'Conta'));
    conta.firstChild.setAttribute('aria-hidden', 'true');
    conta.addEventListener('click', abrirConta); n.appendChild(conta);
  }

  // ── Folha genérica (o <dialog> #folha-casca, com o mecanismo das folhas de app.js) ──
  function folha(o) {
    var d = $('folha-casca');
    d.className = 'mv-folha' + (o.alta ? ' alta' : '');
    $('fx-t').textContent = o.titulo; var s = $('fx-s'); s.textContent = o.sub || ''; s.hidden = !o.sub;
    var cc = limpar($('fx-c')), p = limpar($('fx-p'));
    if (o.corpo) o.corpo(cc);
    p.hidden = !o.pe; if (o.pe) o.pe(p);
    A.abrirFolha(d, o.foco ? o.foco() : $('fx-t'), o.depois || null);
    return d;
  }
  function fecharFolha(depois) { A.fecharFolha($('folha-casca'), depois); }
  function linhaOp(nomeIc, titulo, desc, extra) {
    var b = bt('mv-op'), i = el('span', 'mv-obra-ic'); i.appendChild(ic(nomeIc)); b.appendChild(i);
    var t = el('span', 'mv-op-t'); t.appendChild(el('span', 'mv-op-l', titulo)); if (desc) t.appendChild(el('span', 'mv-op-d', desc)); b.appendChild(t);
    if (extra) b.appendChild(extra);
    return b;
  }

  // ── Aviso (toast), com Desfazer ou com uma acção ──
  var tToast = null, toastAtual = null;
  function toast(texto, o) {
    o = o || {};
    if (toastAtual) { var ant = toastAtual; toastAtual = null; clearTimeout(tToast); if (ant.aoFim) ant.aoFim(); }
    var t = $('toast'); limpar(t); t.appendChild(el('span', null, texto));
    if (o.desfazer) { var b = bt('', 'Desfazer'); b.addEventListener('click', function () { var a = toastAtual; toastAtual = null; clearTimeout(tToast); esconderToast(); if (a && a.desfazer) a.desfazer(); }); t.appendChild(b); }
    if (o.acao) { var b2 = bt('', o.acao.rot); b2.addEventListener('click', function () { toastAtual = null; clearTimeout(tToast); esconderToast(); o.acao.fn(); }); t.appendChild(b2); }
    t.hidden = false;
    if (semMov()) t.classList.add('on'); else requestAnimationFrame(function () { t.classList.add('on'); });
    toastAtual = o;
    tToast = setTimeout(function () { var a = toastAtual; toastAtual = null; esconderToast(); if (a && a.aoFim) a.aoFim(); }, o.ms || 5000);
  }
  /** Ao mudar de ecrã sai o aviso que só informava (o que tem Desfazer fica até acabar). */
  function tirarToast() { if (toastAtual && toastAtual.desfazer) return; var a = toastAtual; toastAtual = null; clearTimeout(tToast); var t = $('toast'); if (t && !t.hidden) esconderToast(); if (a && a.aoFim) a.aoFim(); }
  function esconderToast() { var t = $('toast'); t.classList.remove('on'); setTimeout(function () { if (!toastAtual) t.hidden = true; }, semMov() ? 0 : 200); }

  // ── Registar (o «+») ──
  function abrirRegistar() {
    var ops = [];
    if (tem('ocorrencia') || !tem('diario')) ops.push(['ocorrencia', 'alerta', 'Ocorrência', 'Algo errado em obra · vai para a triagem']);
    if (tem('diario')) ops.push(['diario', 'diario', 'Diário de obra', 'Homens, trabalhos e fotos do dia']);
    folha({ titulo: 'Registar', corpo: function (cc) {
      ops.forEach(function (o) {
        var extra = null;
        if (o[0] === 'ocorrencia' && A.temRascunho()) extra = el('span', 'mv-rasc', 'Rascunho');
        if (o[0] === 'diario') { var e = estadoDiarioHoje(obraHoje()); if (e.rascunho) extra = el('span', 'mv-rasc', 'Rascunho'); else if (e.pend) extra = el('span', 'mv-rasc', 'Por enviar'); else if (e.meu) extra = el('span', 'mv-rasc neu', 'Feito'); }
        var b = linhaOp(o[1], o[2], o[3], extra); b.setAttribute('data-reg', o[0]);
        b.addEventListener('click', function () { A.fecharFolhas(true); if (o[0] === 'ocorrencia') abrir('v-registo', false, true); else abrirDiario(obraHoje(), false, true); });   // o ecrã fica no lugar da entrada da folha (abrirDeFolha do protótipo)
        cc.appendChild(b);
      });
      cc.appendChild(el('p', 'mv-folha-txt mv-embreve-f', 'Em breve: trabalho em falta, bloqueio do cliente, material, entrega e despesa.'));
    } });
  }

  // ── Hoje ──
  function saudacao() { var h = new Date().getHours(); return h < 13 ? 'Bom dia' : (h < 20 ? 'Boa tarde' : 'Boa noite'); }
  function minhaFila() { return c.fila.filter(function (q) { return q.contaId === contaId() && q.estado !== 'entregue' && !c.apagar[q.id]; }); }
  function porEnviar() {
    var minhas = minhaFila(), oc = A.ocorrenciasPorEnviar();
    return { diarios: minhas, ocorrencias: oc.pend, alheias: oc.alheios, alheiosDia: c.fila.filter(function (q) { return q.contaId && q.contaId !== contaId() && q.estado !== 'entregue'; }), rascunho: oc.rascunho,
      erros: minhas.filter(function (q) { return q.estado === 'parado'; }).length + oc.pend.filter(function (r) { return r.parado; }).length,
      total: minhas.length + oc.pend.length };
  }
  /** O meu diário de hoje nesta obra: aceite pelo servidor (meu), na fila (pend), ou em rascunho. */
  function estadoDiarioHoje(ob) {
    var hd = hojeDia(), ch = cache();
    var pend = minhaFila().filter(function (q) { return q.obraId === ob && q.dia === hd.dia && q.estado === 'a-enviar'; }).pop() || null;
    return { meu: D.meuDeHoje(ch, ob, hd.dia), pend: pend, rascunho: c.rascunhos[idRascunho(ob, hd.dia)] || null };
  }
  function linhaData() {
    var hd = hojeDia(), ch = cache(), p = porEnviar(), d = el('div', 'mv-hdata'), t, ama = false;
    var lido = ch.lidoEm ? Date.parse(ch.lidoEm) : 0, dados = lido ? D.textoDados(ch.lidoEm, new Date()) : '';
    if (c.lendo) t = lido ? 'a atualizar…' : 'a ler pela primeira vez…';
    else if (!online()) { t = lido ? 'sem rede · dados ' + dados : 'sem rede · ainda sem dados'; ama = true; }
    else if (!A.sessaoValida()) { t = lido ? 'sessão acabada · dados ' + dados : 'sessão acabada · ainda sem dados'; ama = true; }
    else if (!lido) t = tem('diario') ? 'ainda sem dados' : 'atualizado agora';
    else if (/^de /.test(dados)) { t = 'dados ' + dados; ama = true; }
    else t = 'atualizado às ' + dados.replace(/^das /, '');
    var txt = D.textoDiaLongo(hd.dia) + ' · ' + t;
    if (ama) d.classList.add('ama');
    var b = bt('', txt); b.setAttribute('aria-label', txt + '. Tocar para atualizar'); b.addEventListener('click', function () { if (!online()) { toast('Sem rede. Ficam os dados que já tinhas.'); return; } ler(true); });
    d.appendChild(b);
    if (p.total && !p.erros && A.sessaoValida()) { var f = bt('', '· ' + p.total + ' por enviar'); f.addEventListener('click', function () { abrir('v-fila'); }); d.appendChild(f); }
    return d;
  }
  function obraLinha() {
    var l = obras(), o = obraDe(obraHoje());
    if (!o) return null;
    var txt = el('span'); junta(txt, el('code', null, o.codigo || ''), ' · ' + o.nome);
    if (l.length < 2) { var p = el('p', 'mv-hobra'); p.appendChild(txt); return p; }
    var b = bt('mv-hobra-chip'); b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-label', 'Obra: ' + (o.codigo ? o.codigo + ' · ' : '') + o.nome + '. Trocar de obra');
    var s = el('span', 'mv-hobra'); s.appendChild(txt); b.appendChild(s); b.appendChild(ic('chevB'));
    b.addEventListener('click', function () { folhaObras('hoje'); });
    return b;
  }
  /** A série dos 7 dias: a da obra pelo servidor (M3) ou, sem ela, os meus registos aceites (sem afirmar «sem diário»). */
  function serieDe(ob) {
    var ch = cache(), hd = hojeDia(), e = estadoDiarioHoje(ob), pendTot = e.pend ? D.totalHomens(e.pend.equipas) : 0, ds = ch.dias[ob];
    if (ds && ds.data) {
      var so = D.serieObra(ds.data, hd.dia, feriados(), pendTot), h6 = so[6];
      if (!h6.tem && e.meu) {   // os dias da obra foram lidos antes de o meu de hoje entrar: o de hoje é o meu, aceite
        var hh = (ch.hist || []).filter(function (x) { return x.obraId === ob && x.dia === hd.dia && !x.soEquipas; })[0], ds2 = hh ? D.doeESub(hh.equipas) : { doe: e.meu.total, sub: 0 };
        Object.assign(h6, { tem: true, doe: ds2.doe, sub: ds2.sub, total: ds2.doe + ds2.sub, registos: 1, meu: { totalHomens: e.meu.total }, conhecido: true, pend: 0 });
      }
      return { s: so, obra: true, lidoEm: ds.lidoEm };
    }
    var loc = D.serie7(ch, ob, hd.dia).map(function (x) { return Object.assign(x, { conhecido: x.tem, feriado: feriados()[x.dia] || '', pend: x.hoje && !x.tem ? pendTot : 0 }); });
    return { s: loc, obra: false };
  }
  function graf7(serie, grande) {
    var max = Math.max(8, Math.max.apply(null, serie.map(function (x) { return Math.max(x.total, x.pend || 0); })));
    var med = D.media(serie), var_ = '--mv-g7-h' + (grande ? 'g' : '');
    var alt = function (v) { return 'calc((var(' + var_ + ') - var(--mv-g7-rot)) * ' + (v / max).toFixed(3) + ')'; };
    var util = function (x) { return !x.fds && !x.feriado; };
    var rot = 'Homens nos últimos 7 dias: ' + serie.map(function (x) { return D.textoDiaCurto(x.dia) + ' ' + (x.tem ? x.total + ' (' + x.doe + ' DOE, ' + x.sub + ' subempreiteiros)' : (x.pend ? x.pend + ' por enviar' : (x.hoje ? 'por fazer' : (x.feriado ? 'feriado' : (x.fds ? 'fim de semana' : (x.conhecido ? 'sem diário' : 'sem dados')))))); }).join(', ') + (med ? '. Média ' + Math.round(med) + '.' : '');
    var w = el('span', 'mv-g7' + (grande ? ' g' : '')); w.setAttribute('role', 'img'); w.setAttribute('aria-label', rot);
    var a = el('span', 'mv-g7-a'), dias = el('span', 'mv-g7-d'); dias.setAttribute('aria-hidden', 'true');
    serie.forEach(function (x, i) {
      var col = el('span', 'mv-g7-c' + (util(x) ? '' : ' fds') + (x.hoje ? ' hoje' : '')); col.style.setProperty('--i', String(i));
      if (x.tem) {
        col.appendChild(el('b', null, String(x.total)));
        if (x.sub) { var s = el('i', 'sub'); s.style.height = alt(x.sub); col.appendChild(s); }
        if (x.doe) { var dd = el('i', 'doe'); dd.style.height = alt(x.doe); col.appendChild(dd); }
      } else if (x.pend) { col.appendChild(el('b', null, String(x.pend))); var pe = el('i', 'por'); pe.style.height = alt(x.pend); col.appendChild(pe); }
      else if (x.hoje && util(x)) { col.appendChild(el('b', null, '?')); var pp = el('i', 'por'); pp.style.height = alt(med || max / 2); col.appendChild(pp); }
      else if (util(x) && x.conhecido) { col.appendChild(el('b', 'sem', '')); col.appendChild(el('i', 'sem')); }
      a.appendChild(col);
      dias.appendChild(el('span', x.hoje ? 'hoje' : (util(x) ? '' : 'fds'), grande ? D.diaCurto(x.dia) : D.inicialDia(x.dia)));
    });
    if (med) { var m = el('span', 'mv-g7-m'); m.setAttribute('aria-hidden', 'true'); m.style.bottom = alt(med); a.appendChild(m); }
    w.appendChild(a); w.appendChild(dias);
    return w;
  }
  function faixaEl(cls, nomeIc, forte, resto, botao, fn, id) {
    var f = botao ? bt('mv-faixa ' + cls + ' mv-faixa-toda') : el('div', 'mv-faixa ' + cls);
    if (!botao) f.setAttribute('role', 'status');
    if (id) f.id = id;
    f.appendChild(ic(nomeIc)); var t = el('span', 'mv-faixa-t'); t.appendChild(el('b', null, forte)); if (resto) t.appendChild(document.createTextNode(' ' + resto)); f.appendChild(t);
    if (botao) { f.appendChild(el('span', 'mv-faixa-b', botao)); f.addEventListener('click', fn); }
    return f;
  }
  function desenharHoje() {
    var v = $('v-hoje'); if (!v) return;
    var entra = !c.entrou; c.entrou = true;
    limpar(v); v.className = 'mv-hoje' + (entra && !semMov() ? ' entra' : '');
    var s = sessao(), hd = hojeDia(), ch = cache();
    var cab = el('div', 'mv-hcab'), l = el('div', 'mv-hcab-l'), h1 = el('h1', 'mv-hola', saudacao() + (s && s.nome ? ', ' + primeiroNome(s.nome) : ''));
    h1.tabIndex = -1; h1.setAttribute('data-foco-inicial', ''); h1.id = 'h-hola';
    l.appendChild(h1); cab.appendChild(l);
    var ol = obraLinha(); if (ol) cab.appendChild(ol);
    cab.appendChild(linhaData());
    v.appendChild(cab);
    var p = porEnviar();
    if (!A.sessaoValida() && p.total) v.appendChild(faixaEl('ama', 'relogio', p.total + ' por enviar', '· a sessão acabou: entra outra vez para seguirem', 'Entrar', function () { A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); }, 'b-faixa-sessao'));
    if (s && !Array.isArray(s.funcionalidades)) v.appendChild(faixaEl('nav', 'atual', 'Há novidades:', 'entra outra vez para veres o diário de obra', 'Entrar', function () { A.pedirLogin('Entra outra vez para veres o diário de obra. O que tens por enviar fica guardado.'); }, 'b-faixa-novidades'));
    if (!obras().length) { v.appendChild(el('p', 'mv-nada', 'Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.')); return; }
    Object.keys(c.rascunhos).map(function (k2) { return c.rascunhos[k2]; }).filter(function (r) { return r.contaId === contaId() && r.dia !== hd.dia; }).slice(0, 1).forEach(function (r) {   // 2.ª revisão (4)
      v.appendChild(faixaEl('neu', 'diario', 'Diário de ' + D.textoDiaCurto(r.dia) + ' por acabar', obraDe(r.obraId) ? '· ' + obraDe(r.obraId).codigo : '', 'Continuar', function () { abrirDiario(r.obraId, false, false, r.dia); }, 'b-rasc-outro'));
    });
    if (c.aviso) v.appendChild(faixaEl('neu', 'relogio', c.aviso, ''));
    var ob = obraHoje(), dia = tem('diario');
    if (dia && !ch.lidoEm && c.lendo) { v.appendChild(esqueleto()); return; }
    var e = dia ? estadoDiarioHoje(ob) : {}, util = D.diaUtil(hd.dia, feriados()), ult = dia ? D.ultimoComRegisto(ch, ob, hd.dia) : null;
    var acao = null;
    if (p.erros) acao = { ic: 'alerta', t: p.erros + (p.erros === 1 ? ' envio com erro' : ' envios com erro'), s: 'Não chegaram: vê e tenta de novo', b: 'Ver', bl: 'Ver os envios', fn: function () { abrir('v-fila'); }, erro: true };
    else if (dia && !e.meu && !e.pend && util) {
      var su = ult ? D.doeESub(ult.equipas) : null;
      acao = { ic: 'diario', t: e.rascunho ? 'Diário por acabar' : 'Diário por fazer', s: ult ? (D.difDias(ult.dia, hd.dia) === 1 ? 'Ontem' : 'A ' + D.textoDiaMes(ult.dia)) + ': ' + D.txtHomens(su.doe + su.sub) + ' · ' + su.doe + ' DOE' : 'Ainda sem registos teus nesta obra', b: e.rascunho ? 'Continuar' : 'Fazer', bl: 'Fazer o diário', fn: function () { abrirDiario(ob); } };
    }
    if (acao) {
      var fa = el('div', 'mv-facao' + (acao.erro ? ' erro' : '')); fa.style.setProperty('--i', '0');
      var fi = el('span', 'mv-facao-ic'); fi.appendChild(ic(acao.ic)); fa.appendChild(fi);
      var ft = el('span', 'mv-facao-t'); ft.appendChild(el('b', null, acao.t)); ft.appendChild(el('small', null, acao.s)); fa.appendChild(ft);
      var fb = bt('mv-facao-b', acao.b); fb.setAttribute('aria-label', acao.bl); fb.id = 'b-acao'; fb.addEventListener('click', acao.fn); fa.appendChild(fb);
      v.appendChild(fa);
    }
    if (dia) {
      var sr = serieDe(ob), hojeS = sr.s[6], g = el('div', 'mv-mosg'), nD, legD = '', nada = false;
      if (e.meu) { nD = String(hojeS.tem ? hojeS.total : e.meu.total); legD = 'homens hoje'; }
      else if (e.pend) { nD = String(D.totalHomens(e.pend.equipas)); legD = 'hoje'; }
      else { var uS = sr.s.slice(0, 6).filter(function (x) { return x.tem; }).pop(); if (uS) { nD = String(uS.total); legD = D.difDias(uS.dia, hd.dia) === 1 ? 'ontem' : D.textoDiaMes(uS.dia); } else if (ult) { nD = String(D.totalHomens(ult.equipas)); legD = D.difDias(ult.dia, hd.dia) === 1 ? 'ontem' : D.textoDiaMes(ult.dia); } else { nD = '–'; nada = true; legD = util ? '' : (hojeS.feriado ? 'feriado' : 'sem registos'); } }
      var b = bt('mv-mos larga'); b.id = 'b-diario7'; b.style.setProperty('--i', '1');
      var top = el('span', 'mv-mos-t'); top.appendChild(ic('diario')); top.appendChild(el('span', 'mv-mos-l', 'Diário'));
      if (!e.meu && util) { var pt = el('i', 'mv-ponto ama'); pt.setAttribute('aria-hidden', 'true'); top.appendChild(pt); }
      b.appendChild(top);
      b.appendChild(el('span', 'mv-mos-n' + (nada ? ' nada' : ''), nD));
      var leg = el('span', 'mv-mos-c'); if (legD) leg.appendChild(document.createTextNode(legD));
      var est = e.meu ? '' : (e.pend ? 'por enviar' : (util ? 'hoje por fazer' : ''));
      if (est) { if (legD) leg.appendChild(document.createTextNode(' · ')); leg.appendChild(el('span', 'ama-t', est)); }
      b.appendChild(leg);
      var zv = el('span', 'mv-mos-v'); zv.appendChild(graf7(sr.s, false)); b.appendChild(zv);
      b.setAttribute('aria-label', 'Diário: ' + nD + ' ' + (legD || 'homens') + (est ? ', ' + est : '') + '. Ver os 7 dias');
      b.addEventListener('click', abrirDiario7);
      g.appendChild(b); v.appendChild(g);
    }
    v.appendChild(el('p', 'mv-embreve', 'Em breve: trabalhos em falta, material e bloqueios do cliente.'));
  }
  function esqueleto() {
    var g = el('div', 'mv-mosg'); g.setAttribute('aria-hidden', 'true');
    var b = el('div', 'mv-mos sk larga'), t = el('span', 'mv-mos-t'); t.appendChild(el('i', 'mv-sk w30')); b.appendChild(t);
    b.appendChild(el('i', 'mv-sk num')); b.appendChild(el('i', 'mv-sk leg w50'));
    var z = el('span', 'mv-mos-v'); z.appendChild(el('i', 'mv-sk graf w100')); b.appendChild(z);
    g.appendChild(b); return g;
  }
  function folhaObras(ctx) {
    var atual = ctx === 'hoje' ? obraHoje() : (c.form && c.form.obraId);
    folha({ titulo: ctx === 'hoje' ? 'Obra' : 'Escolher a obra', alta: obras().length > 6, corpo: function (cc) {
      obras().forEach(function (o) {
        var b = bt('mv-lo'); b.setAttribute('aria-pressed', o.id === atual ? 'true' : 'false');
        junta(b, el('code', null, o.codigo || ''), el('span', 'mv-lo-n', o.nome), ic('ok'));
        b.addEventListener('click', function () {
          fecharFolha();
          if (ctx === 'hoje') { c.obraHoje = o.id; lsGravar(LS_OBRA_HOJE, o.id); desenharHoje(); ler(true); }
          else if (o.id !== atual) { gravarRascunhoJa(); abrirDiario(o.id, true); }
        });
        cc.appendChild(b);
      });
    } });
  }

  // ── Rascunho do diário (M1): por conta, obra e dia, a cada alteração ──
  function idRascunho(ob, dia) { return ('rd-' + contaId() + '-' + ob + '-' + dia).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120); }
  var tRasc = null;
  /** O rascunho guarda (2.ª revisão, 3) a versão do registo em que se baseou e SÓ os campos em que a pessoa mexeu. */
  function mexeu(campo) {
    var f = c.form; if (!f) return;
    f.mexeu = true; f.mexidos = f.mexidos || {}; if (campo) f.mexidos[campo] = true;
    clearTimeout(tRasc); tRasc = setTimeout(gravarRascunhoJa, MS_RASCUNHO);
  }
  function gravarRascunhoJa() {
    clearTimeout(tRasc); tRasc = null;
    var f = c.form; if (!f || !f.mexeu || !contaId()) return;
    var mx = f.mexidos || {};
    var r = { id: idRascunho(f.obraId, f.dia), tipo: 'diario-rascunho', estado: 'rascunho', contaId: contaId(), obraId: f.obraId, dia: f.dia, registoId: f.registoId, baseVersao: Number(f.versaoBase) || 0, guardadoEm: new Date().toISOString(),
      mexidos: { equipasDelta: mx.equipas ? D.deltaEquipas(f.equipasBase || [], f.equipas) : undefined, equipasVistas: f.equipasVistas || f.equipasBase || undefined, texto: mx.texto ? f.texto : undefined, localizacoes: mx.localizacoes && f.conhece && f.conhece.localizacoes !== false ? f.localizacoes : undefined,
        fotosNovas: (f.fotos || []).filter(function (x) { return x.estado === 'nova' && x.blob; }).map(function (x) { return { blob: x.blob, sha256: x.sha256, tipo: x.tipo, tamanho: x.tamanho }; }), fotosTiradas: (f.tiradas || []).slice() } };
    c.rascunhos[r.id] = r; guardarItem(r);
  }
  /** Por cima do registo de agora aplica-se só o que a pessoa mexeu; nunca se passa a «conhecer» uma lista que não se leu. */
  function aplicarRascunho(form, rasc, meu) {
    var mx = rasc.mexidos, mudou = false;
    form.mexidos = {}; form.tiradas = [];
    var vistas = mx.equipasVistas ? JSON.parse(JSON.stringify(mx.equipasVistas)) : null;
    if (vistas && !meu && !form.corrigir) form.equipas = vistas;   // 4c: o dia sem registo no servidor parte do que a pessoa viu quando começou
    if (vistas) form.equipasVistas = vistas;
    if (mx.equipasDelta && mx.equipasDelta.length) { form.equipas = D.aplicarDeltaEquipas(form.equipas, mx.equipasDelta); form.mexidos.equipas = true; mudou = true; }   // 4a: só as equipas mexidas
    else if (mx.equipas) { form.equipas = JSON.parse(JSON.stringify(mx.equipas)); form.mexidos.equipas = true; mudou = true; }   // rascunho do formato anterior
    if (mx.texto != null) { form.texto = mx.texto; form.mexidos.texto = true; mudou = true; }
    if (mx.localizacoes && form.conhece && form.conhece.localizacoes !== false) { form.localizacoes = mx.localizacoes.slice(); form.mexidos.localizacoes = true; form.tocouFotosOuLocs = true; mudou = true; }
    if (form.conhece && form.conhece.fotos !== false) {
      (mx.fotosTiradas || []).forEach(function (n) { var i = -1; form.fotos.forEach(function (f, j) { if (f.n === n && f.estado === 'servidor') i = j; }); if (i >= 0) { D.tirarFoto(form, i); form.tiradas.push(n); form.tocouFotosOuLocs = true; mudou = true; } });
      (mx.fotosNovas || []).forEach(function (x) { if (x.blob && D.juntarFoto(form, x)) mudou = true; });
      if ((mx.fotosNovas || []).length || (mx.fotosTiradas || []).length) form.mexidos.fotos = true;
    } else if ((mx.fotosNovas || []).length) form.fotosEspera = mx.fotosNovas;   // sem saber as fotos do servidor não se juntam: ficam no rascunho
    form.mexeu = mudou;
    var base = Number(rasc.baseVersao) || 0;
    if (meu && Number(meu.versao) !== base) c.avisoRascunho = { hora: D.horaDe(meu.alteradoEm) || '', mudou: vistas ? D.resumoDiferencas(vistas, meu.equipas || [], mx.equipasDelta) : '' };
  }
  function folhaRascunhoFechado(ob, dia) {
    folha({ titulo: 'Diário de ' + D.textoDiaCurto(dia), sub: 'Já foi enviado e o dia fechou', corpo: function (cc) {
      cc.appendChild(el('p', 'mv-folha-txt', 'Já há um diário enviado deste dia, e um dia fechado já não se corrige. O que ficou neste rascunho não pode entrar.'));
    }, pe: function (pp) { var b = bt('mv-btn', 'Deitar fora o rascunho'); b.id = 'b-rasc-fora'; b.addEventListener('click', function () { apagarRascunho(ob, dia); fecharFolha(); redesenhar(); }); pp.appendChild(b); } });
  }
  function apagarRascunho(ob, dia) { var id = idRascunho(ob, dia); clearTimeout(tRasc); tRasc = null; delete c.rascunhos[id]; apagarItem(id); }

  // ── Diário de obra: o formulário ──
  async function abrirDiario(ob, substituir, daFolha, diaPedido, semRascunho) {
    if (!ob) { toast('Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.'); return; }
    var hd0 = hojeDia(), outroDia = !!diaPedido && diaPedido !== hd0.dia;
    if (!outroDia) await lerObraAgora(ob);   // com rede lê sempre o registo: é ele que diz o que se conhece (A1)
    if (!cache().locs[ob]) lerLocsAgora(ob).then(function () { if (c.vista === 'v-diario') zona('locs'); });
    var ch = cache(), hd = outroDia ? { dia: diaPedido } : hojeDia(), k = D.chaveDia(ob, hd.dia), o = ch.obras[ob];
    var rasc = semRascunho ? null : c.rascunhos[idRascunho(ob, hd.dia)];
    if (outroDia) {   // 2.ª revisão (4): o rascunho de um dia que já fechou
      var jaHa = ch.versoes[ch.ids[k]] != null || (ch.hist || []).some(function (x) { return x.obraId === ob && x.dia === hd.dia && !x.soEquipas; });
      if (jaHa) { folhaRascunhoFechado(ob, hd.dia); return; }
    }
    var meu = !outroDia && o && o.dia === hd.dia && o.lidoEm ? o.meu : null;
    var pend = minhaFila().filter(function (q) { return q.obraId === ob && q.dia === hd.dia; }).pop();
    var id = D.idRegistoDe(ch, ob, hd.dia, meu, function () { return M.novoId(); });
    var form;
    if (outroDia) form = D.formDiario({ obraId: ob, dia: hd.dia, ultimo: null, registoId: id });   // entra como registo novo atrasado (até 7 dias)
    else if (meu) form = D.formDiario({ obraId: ob, dia: hd.dia, meu: meu });
    else if (pend) {   // o que está na fila é o mais recente: corrige-se a partir dele (o que ele omitia continua desconhecido)
      var om = pend.omitir || {}, reg = ch.registos[k] || null;
      form = D.formDiario({ obraId: ob, dia: hd.dia, meu: { id: pend.registoId, dia: pend.dia, versao: pend.versaoBase, equipas: pend.equipas, texto: om.texto && reg ? reg.texto : pend.texto, localizacoes: om.localizacoes ? (reg && reg.conhecido.localizacoes ? reg.localizacoes : []) : pend.localizacoes, fotos: [],
        conhecido: { texto: !om.texto || !!(reg && reg.conhecido.texto), localizacoes: !om.localizacoes || !!(reg && reg.conhecido.localizacoes), fotos: !om.fotos } } });
      form.fotos = pend.fotos.filter(function (f) { return f.estado !== 'sem-lugar' && f.estado !== 'fora-de-prazo'; }).map(function (f) { return f.blob ? { n: f.n, nPedido: f.n, estado: 'nova', blob: f.blob, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho } : { n: f.n, estado: 'servidor', estadoServidor: 'por-arquivar', sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; });
      form.nMax = D.proximoN(form) - 1;
      form.versaoBase = ch.versoes[pend.registoId] != null ? ch.versoes[pend.registoId] : pend.versaoBase;
    } else if (ch.registos[k] && ch.registos[k].versao) form = D.formDiario({ obraId: ob, dia: hd.dia, meu: ch.registos[k] });   // a cópia do último aceite (sem rede)
    else if (ch.versoes[id] != null) {   // existe no servidor, mas este telemóvel não tem o conteúdo: só as equipas (A1)
      var h = (ch.hist || []).filter(function (x) { return x.obraId === ob && x.dia === hd.dia; })[0];
      form = D.formDesconhecido({ obraId: ob, dia: hd.dia, registoId: id, versao: ch.versoes[id], equipas: h ? h.equipas : [] });
    } else {
      var ultimo = o && o.ultimo ? o.ultimo : null, uh = D.ultimoComRegisto(ch, ob, hd.dia);
      if (!ultimo && uh) ultimo = { dia: uh.dia, equipas: uh.equipas };
      form = D.formDiario({ obraId: ob, dia: hd.dia, ultimo: ultimo, registoId: id });
    }
    c.avisoRascunho = null;
    form.equipasBase = JSON.parse(JSON.stringify(form.equipas));   // a lista de partida: o rascunho guarda o que se mexeu em relação a ela
    if (rasc && rasc.mexidos) aplicarRascunho(form, rasc, meu);
    if (!form.equipasVistas) form.equipasVistas = JSON.parse(JSON.stringify(form.equipas));
    gravarCache();
    form.registoId = form.registoId || id;
    form.uid = M.novoId();
    c.form = form; c.tentou = false; c.erroFoto = ''; c.erroCampo = c.erroDe && c.erroDe.obraId === ob ? c.erroDe : null; c.erroDe = null;
    lsGravar('doeMovel.obra', ob);
    if (c.vista === 'v-diario') { desenharDiario(true); return; }
    abrir('v-diario', !!substituir, !!daFolha);
  }
  function seccao(titulo, meta, idH, tag) {
    var s = el('section', 'mv-sec'), h = el('div', 'mv-sec-h'), h2 = el(tag || 'h2', tag ? 'mv-h2' : null, titulo); if (idH) { h2.id = idH; s.setAttribute('aria-labelledby', idH); }
    h.appendChild(h2); if (meta != null) h.appendChild(el('span', 'mv-sec-m', meta)); s.appendChild(h); return s;
  }
  var ZONAS = ['obra', 'hom', 'fez', 'locs', 'fotos'];
  /** M8: o formulário monta-se uma vez por abertura; depois só se redesenha a zona que mudou (o foco, a selecção e o cursor
      ficam onde estavam). */
  function desenharDiario(tudo) {
    var v = $('v-diario'); if (!v || !c.form) return;
    if (tudo || v.getAttribute('data-form') !== c.form.uid) {
      limpar(v); v.setAttribute('data-form', c.form.uid);
      ZONAS.forEach(function (z) { var d = el('div'); d.id = 'z-' + z; v.appendChild(d); });
      ZONAS.forEach(function (z) { zona(z); });
    }
    desenharBarraDia();
  }
  function zona(z) {
    var box = $('z-' + z); if (!box || !c.form) return;
    var ae = document.activeElement, chave = ae && box.contains(ae) ? ae.getAttribute('data-k') : null;
    limpar(box);
    ({ obra: zonaObra, hom: zonaHomens, fez: zonaFez, locs: zonaLocs, fotos: zonaFotos })[z](box);
    if (chave) { var x = box.querySelector('[data-k="' + chave + '"]'); if (x && !x.disabled) A.focar(x); }
  }
  function zonaObra(box) {
    var f = c.form, o = obraDe(f.obraId), hd = hojeDia();
    if (c.avisoRascunho) {
      var av = el('div', 'mv-faixa neu mv-rasc-aviso'); av.setAttribute('role', 'status'); av.appendChild(ic('relogio'));
      av.appendChild(el('span', 'mv-faixa-t', 'O diário foi alterado noutro telemóvel' + (c.avisoRascunho.hora ? ' às ' + c.avisoRascunho.hora : '') + (c.avisoRascunho.mudou ? ' (' + c.avisoRascunho.mudou + ')' : '') + '; mantive o que tinhas mudado aqui.'));
      var fora = bt('mv-faixa-b', 'Deitar fora o meu rascunho'); fora.id = 'b-rasc-deitar';
      fora.addEventListener('click', function () { var ob = f.obraId, dia = f.dia; apagarRascunho(ob, dia); c.form = null; abrirDiario(ob, true, false, dia === hd.dia ? null : dia, true); });
      av.appendChild(fora); box.appendChild(av);
    }
    if (f.fotosEspera && f.fotosEspera.length) { var fe = el('p', 'mv-fotos-nota'); fe.textContent = f.fotosEspera.length === 1 ? 'A foto do teu rascunho junta-se quando abrires o diário com rede.' : 'As ' + f.fotosEspera.length + ' fotos do teu rascunho juntam-se quando abrires o diário com rede.'; box.appendChild(fe); }
    var so = el('section', 'mv-sec pri'); so.setAttribute('aria-labelledby', 'h-obra-dia');
    var sh = el('div', 'mv-sec-h'); sh.appendChild(el('h2', null, 'Obra')).id = 'h-obra-dia'; so.appendChild(sh);
    var bo = bt('mv-obra' + (o ? '' : ' vazia')); bo.id = 'c-obra-dia'; bo.setAttribute('data-k', 'obra');
    var oi = el('span', 'mv-obra-ic'); oi.appendChild(ic('obra')); bo.appendChild(oi);
    var ot = el('span', 'mv-obra-t'), oc = el('span', 'mv-obra-cod');
    if (o) { if (o.codigo) oc.appendChild(el('code', null, o.codigo)); oc.appendChild(el('span', null, f.corrigir ? 'o teu diário de hoje' : (f.baseDia ? 'a de ' + D.quandoFoi(f.baseDia, hd.dia).replace(/^a /, '') : 'a última que usaste'))); ot.appendChild(oc); ot.appendChild(el('span', 'mv-obra-n', o.nome)); }
    else ot.appendChild(el('span', 'mv-obra-n', 'Escolher a obra'));
    bo.appendChild(ot);
    var oa = el('span', 'mv-obra-acc', obras().length > 1 ? 'Trocar' : ''); oa.appendChild(ic('chev')); bo.appendChild(oa);
    if (obras().length > 1) bo.addEventListener('click', function () { folhaObras('dia'); }); else { bo.disabled = true; oa.hidden = true; }
    so.appendChild(bo); box.appendChild(so);
  }
  function zonaHomens(box) {
    var f = c.form, hd = hojeDia(), tot = D.totalHomens(D.equipasParaEnviar(f.equipas)), sec = seccao('Homens em obra', null, 'h-hom');
    sec.querySelector('.mv-sec-h').appendChild(el('span', 'mv-sec-m mv-tot', D.txtHomens(tot)));
    if (!f.corrigir && f.baseDia) sec.appendChild(el('p', 'mv-lead mv-como', D.comoAntes(f) ? 'Como ' + D.quandoFoi(f.baseDia, hd.dia) + '. Ajusta só o que mudou.' : 'Mudaste em relação a ' + D.quandoFoi(f.baseDia, hd.dia).replace(/^a /, '') + '.'));
    f.equipas.forEach(function (e, i) {
      var linha = el('div', 'mv-eq' + (e.homens ? '' : ' zero'));
      var nb = bt('mv-eq-n', e.nome); nb.setAttribute('aria-label', 'Equipa ' + e.nome + '. Trocar o nome'); nb.setAttribute('data-k', 'eq-' + i);
      nb.addEventListener('click', function () { folhaEquipa(i); });
      var menos = bt('mv-passo'); menos.appendChild(ic('menos')); menos.setAttribute('aria-label', 'Menos um homem em ' + e.nome); menos.disabled = !e.homens; menos.setAttribute('data-k', 'menos-' + i);
      var val = el('span', 'mv-eq-v', String(e.homens)); val.setAttribute('aria-live', 'polite');
      var mais = bt('mv-passo'); mais.appendChild(ic('mais')); mais.setAttribute('aria-label', 'Mais um homem em ' + e.nome); mais.setAttribute('data-k', 'mais-' + i); mais.disabled = e.homens >= D.LIMITES.homens;
      menos.addEventListener('click', function () { D.mudarHomens(f.equipas, i, -1); mexeu('equipas'); zona('hom'); desenharBarraDia(); });
      mais.addEventListener('click', function () { D.mudarHomens(f.equipas, i, 1); mexeu('equipas'); zona('hom'); desenharBarraDia(); });
      junta(linha, nb, menos, val, mais); sec.appendChild(linha);
    });
    var ne = bt('mv-link'); ne.appendChild(ic('mais')); ne.appendChild(document.createTextNode('Equipa')); ne.setAttribute('data-k', 'eq-nova');
    ne.addEventListener('click', function () { folhaEquipa(null); }); sec.appendChild(ne);
    box.appendChild(sec);
  }
  function zonaFez(box) {
    var f = c.form, ch = cache(), sf = el('section', 'mv-sec'), sfh = el('div', 'mv-sec-h'), lb = el('label', 'mv-h2', 'O que se fez'); lb.htmlFor = 'c-fez';
    junta(sfh, lb, el('span', 'mv-sec-m', 'Opcional')); sf.appendChild(sfh);
    var fr = el('div', 'mv-chips envolve mv-frases'); fr.setAttribute('role', 'group'); fr.setAttribute('aria-label', 'Frases de um toque');
    var sug = ch.obras[f.obraId] && ch.obras[f.obraId].sugestoes;
    var ta = el('textarea', 'mv-campo curto' + (c.erroCampo && c.erroCampo.campo === 'texto' ? ' tentou' : ''));
    var marcar = function () { Array.prototype.forEach.call(fr.children, function (b) { b.setAttribute('aria-pressed', String(f.texto.indexOf(b.textContent) >= 0)); }); };
    D.frasesPara(sug).forEach(function (x, i) {
      var b = bt('mv-chip', x); b.setAttribute('data-k', 'frase-' + i);
      b.addEventListener('click', function () { f.texto = D.alternarFrase(f.texto, x); ta.value = f.texto; marcar(); mexeu('texto'); desenharBarraDia(); });
      fr.appendChild(b);
    });
    sf.appendChild(fr);
    ta.id = 'c-fez'; ta.value = f.texto; ta.maxLength = D.LIMITES.texto; ta.placeholder = 'Ou escreve, ou dita: o microfone do teclado.';
    ta.setAttribute('autocapitalize', 'sentences'); ta.setAttribute('enterkeyhint', 'enter'); ta.spellcheck = true; ta.setAttribute('data-k', 'texto');
    ta.addEventListener('input', function () { f.texto = ta.value; ta.classList.remove('tentou'); marcar(); mexeu('texto'); desenharBarraDia(); });
    marcar();
    sf.appendChild(ta);
    if (f.conhece && f.conhece.texto === false) { var dj = el('p', 'mv-dica mv-junta'); dj.id = 'c-fez-junta'; dj.appendChild(ic('mais')); dj.appendChild(el('span', null, 'Junta-se ao que já está escrito no diário de hoje')); ta.setAttribute('aria-describedby', 'c-fez-junta'); sf.appendChild(dj); }   // 2.ª revisão (2)
    if (c.erroCampo && c.erroCampo.campo === 'texto') { var er = el('p', 'mv-erro'); er.setAttribute('role', 'alert'); er.appendChild(ic('alerta')); er.appendChild(el('span', null, c.erroCampo.texto)); sf.appendChild(er); }
    box.appendChild(sf);
  }
  function notaDesconhecido() { var p = el('p', 'mv-faixa neu mv-desconhecido'); p.setAttribute('role', 'note'); p.appendChild(ic('semrede')); p.appendChild(el('span', 'mv-faixa-t', 'Sem rede: as Localizações e as fotos já enviadas não se vêem aqui, mas ficam como estão.')); return p; }
  function zonaLocs(box) {
    var f = c.form, ch = cache(), nl = f.localizacoes.length, sl = seccao('Localizações trabalhadas', 'Opcional', 'h-locs');
    if (f.conhece && f.conhece.localizacoes === false) { sl.appendChild(notaDesconhecido()); box.appendChild(sl); return; }
    var bl = bt('mv-obra'); bl.id = 'c-locs'; bl.setAttribute('data-k', 'locs');
    var li = el('span', 'mv-obra-ic'); li.appendChild(ic('obra')); bl.appendChild(li);
    var lt = el('span', 'mv-obra-t'), nomes = nomesLocs(f.obraId, f.localizacoes);
    lt.appendChild(el('span', 'mv-obra-n', nl ? nl + (nl === 1 ? ' localização' : ' localizações') : 'Escolher'));
    lt.appendChild(el('span', 'mv-obra-cod', nl ? nomes.join(' · ') : (ch.locs[f.obraId] ? 'Produtos e localizações da obra' : (online() ? 'A ler as localizações…' : 'Sem rede: ainda não as tenho neste telemóvel'))));
    bl.appendChild(lt); var la = el('span', 'mv-obra-acc', nl ? 'Trocar' : ''); la.appendChild(ic('chev')); bl.appendChild(la);
    bl.addEventListener('click', folhaLocs); sl.appendChild(bl); box.appendChild(sl);
  }
  function zonaFotos(box) {
    var f = c.form, ativas = D.fotosAtivas(f), sfo = seccao('Fotos', ativas.length ? ativas.length + ' de ' + D.LIMITES.fotos : 'Opcional · até ' + D.LIMITES.fotos, 'h-fotos-dia');
    if (f.conhece && f.conhece.fotos === false) { if (!(f.conhece.localizacoes === false)) sfo.appendChild(notaDesconhecido()); else sfo.appendChild(el('p', 'mv-fotos-nota', 'Para juntar fotos, abre o diário com rede.')); box.appendChild(sfo); return; }
    sfo.appendChild(fotosDia(f));
    if (c.erroFoto) { var ef = el('p', 'mv-erro'); ef.setAttribute('role', 'alert'); ef.appendChild(ic('alerta')); ef.appendChild(el('span', null, c.erroFoto)); sfo.appendChild(ef); }
    box.appendChild(sfo);
  }
  function nomesLocs(ob, ids) {
    var mapa = {}, lc = cache().locs[ob];
    ((lc && lc.produtos) || []).forEach(function (p) { (p.localizacoes || []).forEach(function (l) { mapa[l.id] = l.nome || l.codigo; }); });
    return ids.map(function (id) { return mapa[id] || id; });
  }
  function fotosDia(f) {
    var box = el('div'), ativas = D.fotosAtivas(f), pode = D.podeJuntarFoto(f), prep = c.aPreparar || 0;
    var add = function (cls, nomeIc, txt, rot, input) { var b = bt('mv-add' + (cls ? ' ' + cls : '')); b.appendChild(ic(nomeIc)); b.appendChild(el('span', null, txt)); if (rot) b.setAttribute('aria-label', rot); b.disabled = prep > 0; b.addEventListener('click', function () { gravarRascunhoJa(); $(input).click(); }); return b; };
    if (!ativas.length && !prep) { var vz = el('div', 'mv-fotos-vazio'); var cam = add('cam', 'cam', 'Tirar foto', '', 'd-cam'); cam.id = 'b-cam-dia'; vz.appendChild(cam); vz.appendChild(add('gal', 'gal', 'Galeria', 'Juntar da galeria', 'd-gal')); box.appendChild(vz); return box; }
    var g = el('div', 'mv-fotos');
    f.fotos.forEach(function (ft, i) {
      if (ft.estado === 'sem-lugar' || ft.estado === 'fora-de-prazo') return;
      var cel = el('div', 'mv-foto' + (ft.blob ? '' : ' srv')), outro = !ft.blob && ft.estadoServidor === 'por-enviar';
      if (ft.blob) { if (!ft.prev && URL.createObjectURL) ft.prev = URL.createObjectURL(ft.blob); var img = el('img'); img.alt = 'Foto ' + (i + 1); img.src = ft.prev || ''; cel.appendChild(img); }
      else { cel.appendChild(ic('gal')); cel.appendChild(el('span', null, 'Foto ' + ft.n)); cel.appendChild(el('small', null, outro ? 'por enviar noutro telemóvel' : 'já enviada')); }
      var x = bt('mv-foto-x'); x.setAttribute('aria-label', outro ? 'Tirar esta foto do diário' : 'Tirar a foto ' + (i + 1)); var sp = el('span'); sp.appendChild(ic('x')); x.appendChild(sp);
      x.addEventListener('click', function () { if (ft.prev && URL.revokeObjectURL) URL.revokeObjectURL(ft.prev); if (ft.estado === 'servidor') { f.tiradas = f.tiradas || []; f.tiradas.push(ft.n); } D.tirarFoto(f, i); f.tocouFotosOuLocs = true; mexeu('fotos'); zona('fotos'); desenharBarraDia(); });
      cel.appendChild(x); g.appendChild(cel);
    });
    for (var k = 0; k < prep; k++) { var p = el('div', 'mv-foto prep'); p.setAttribute('role', 'status'); p.appendChild(el('span', 'pulsa', 'A preparar…')); var pb = el('div', 'mv-pb'); pb.appendChild(el('i')); p.appendChild(pb); g.appendChild(p); }
    var livres = pode ? D.LIMITES.fotos - ativas.length - prep : 0;
    if (livres >= 1) { var c1 = add('cam', 'cam', 'Câmara', 'Tirar outra foto', 'd-cam'); c1.id = 'b-cam-dia'; g.appendChild(c1); }
    if (livres >= 2) g.appendChild(add('', 'gal', 'Galeria', 'Juntar da galeria', 'd-gal'));
    box.appendChild(g);
    if (livres === 1) { var lk = bt('mv-link'); lk.appendChild(ic('gal')); lk.appendChild(document.createTextNode('Ou da galeria')); lk.addEventListener('click', function () { $('d-gal').click(); }); box.appendChild(lk); }
    if (!livres && !prep) box.appendChild(el('p', 'mv-fotos-nota', pode || ativas.length >= D.LIMITES.fotos ? D.LIMITES.fotos + ' de ' + D.LIMITES.fotos + ', o máximo. Tira uma (✕) para juntar outra.' : 'Este diário já usou todas as fotos que pode ter.'));
    return box;
  }
  async function juntarFotos(lista) {
    var files = Array.prototype.slice.call(lista || []); c.erroFoto = '';
    if (!files.length || c.aPreparar || !c.form) return;
    var f = c.form, cabem = Math.max(0, D.LIMITES.fotos - D.fotosAtivas(f).length);
    if (files.length > cabem) c.erroFoto = 'No máximo ' + D.LIMITES.fotos + ' fotos por diário.';
    files = files.slice(0, cabem);
    var redesenhar = function () { if (c.vista === 'v-diario' && c.form === f) { zona('fotos'); desenharBarraDia(); } };
    c.aPreparar = files.length; f.aPreparar = true; redesenhar();
    try {
      for (var i = 0; i < files.length; i++) {
        try { var x = await A.comprimir(files[i]); if (c.form !== f) break; if (!D.juntarFoto(f, x)) { c.erroFoto = 'Este diário já não leva mais fotos.'; break; } mexeu('fotos'); }
        catch (e) { c.erroFoto = (e && e.message) || 'Não consegui abrir esta foto.'; }
        c.aPreparar = files.length - i - 1; redesenhar();
      }
    } finally { c.aPreparar = 0; f.aPreparar = false; redesenhar(); }
  }
  function folhaEquipa(i) {
    var f = c.form, nova = i == null, e = nova ? null : f.equipas[i];
    var sug = D.sugestoesLivres(f.equipas, (cache().obras[f.obraId] && cache().obras[f.obraId].sugestoes.equipas) || [], nova ? undefined : i);
    var usar = function (eq) { var r = D.porEquipa(f.equipas, eq, nova ? undefined : i); if (!r.ok) { var er = $('fx-erro'); if (er) { er.textContent = r.motivo; er.hidden = false; } return; } mexeu('equipas'); fecharFolha(); zona('hom'); desenharBarraDia(); };
    folha({ titulo: nova ? 'Nova equipa' : 'Equipa', sub: 'DOE ou um subempreiteiro · sem nomes de pessoas', foco: function () { return $('fx-t'); }, corpo: function (cc) {
      if (sug.length) { cc.appendChild(el('p', 'mv-lh', 'Já escritas nesta obra')); sug.forEach(function (s) { var b = bt('mv-lo'); b.setAttribute('aria-pressed', String(!!e && D.chaveEquipa(e) === D.chaveEquipa(s))); junta(b, el('span', 'mv-lo-n', s.nome), ic('ok')); b.addEventListener('click', function () { usar(s); }); cc.appendChild(b); }); }
      cc.appendChild(el('p', 'mv-lh', 'Outra equipa'));
      var lin = el('div', 'mv-ml-a'), inp = el('input', 'mv-in'); inp.id = 'c-equipa'; inp.type = 'text'; inp.placeholder = 'Nome da equipa ou do subempreiteiro'; inp.setAttribute('aria-label', 'Nome da equipa'); inp.setAttribute('autocapitalize', 'words'); inp.setAttribute('enterkeyhint', 'done'); inp.maxLength = D.LIMITES.nomeEquipa;
      if (e && e.tipo !== 'DOE') inp.value = e.nome;
      var ok = bt('mv-btn compacto mv-btn-curto', 'Usar'); ok.addEventListener('click', function () { usar({ tipo: 'SUB', nome: inp.value }); });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); } });
      junta(lin, inp, ok); cc.appendChild(lin);
      var er = el('p', 'mv-erro ama'); er.id = 'fx-erro'; er.hidden = true; er.setAttribute('role', 'alert'); cc.appendChild(er);
      if (!nova) { var t = bt('mv-link mv-link-tirar'); t.appendChild(ic('lixo')); t.appendChild(document.createTextNode('Tirar esta equipa')); t.addEventListener('click', function () { f.equipas.splice(i, 1); mexeu('equipas'); fecharFolha(); zona('hom'); desenharBarraDia(); }); cc.appendChild(t); }
    } });
  }
  function folhaLocs() {
    var f = c.form, lc = cache().locs[f.obraId];
    var rotulo = function () { var n = f.localizacoes.length; return n ? 'Feito · ' + n + (n === 1 ? ' localização' : ' localizações') : 'Feito'; };
    folha({ titulo: 'Localizações trabalhadas', alta: true, corpo: function (cc) {
      if (!lc) { cc.appendChild(el('p', 'mv-vazio', online() ? 'A ler as localizações da obra… fecha e abre outra vez daqui a nada.' : 'Sem rede, e ainda não tenho as localizações desta obra neste telemóvel.')); return; }
      var pq = el('div', 'mv-pesq'); pq.appendChild(ic('proc'));
      var q = el('input', 'mv-in'); q.type = 'search'; q.id = 'q-locs'; q.placeholder = 'Procurar produto ou localização'; q.setAttribute('aria-label', 'Procurar produto ou localização'); q.setAttribute('inputmode', 'search'); q.setAttribute('enterkeyhint', 'search'); q.autocomplete = 'off';
      pq.appendChild(q); cc.appendChild(pq);
      var lista = el('div'); cc.appendChild(lista);
      var desenhar = function () {
        limpar(lista); var qq = String(q.value || ''), n = 0;
        var norm = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }, partes = norm(qq).trim().split(/\s+/).filter(Boolean);
        (lc.produtos || []).forEach(function (p) {
          var ls = (p.localizacoes || []).filter(function (l) { var h = norm(p.nome + ' ' + l.codigo + ' ' + l.nome); return partes.every(function (x) { return h.indexOf(x) >= 0; }); });
          if (!ls.length) return;
          lista.appendChild(el('p', 'mv-lh', p.nome));
          ls.forEach(function (l) {
            n++;
            var on = f.localizacoes.indexOf(l.id) >= 0, b = bt('mv-lo mv-lo-v'); b.setAttribute('aria-pressed', String(on));
            var chk = el('span', 'mv-chk'); chk.setAttribute('aria-hidden', 'true'); chk.appendChild(ic('ok'));
            var nm = el('span', 'mv-lo-n', l.nome); if (l.codigo) nm.appendChild(el('small', null, l.codigo));
            junta(b, chk, nm);
            b.addEventListener('click', function () {
              var ix = f.localizacoes.indexOf(l.id);
              if (ix >= 0) f.localizacoes.splice(ix, 1); else if (f.localizacoes.length < D.LIMITES.localizacoes) f.localizacoes.push(l.id);
              f.tocouFotosOuLocs = true; mexeu('localizacoes'); b.setAttribute('aria-pressed', String(ix < 0)); var bf = $('b-locs-feito'); if (bf) bf.textContent = rotulo();
            });
            lista.appendChild(b);
          });
        });
        if (!n) lista.appendChild(el('p', 'mv-vazio', qq.trim() ? 'Nada com «' + qq.trim() + '».' : 'Esta obra ainda não tem localizações.'));
      };
      q.addEventListener('input', desenhar); desenhar();
    }, pe: function (p) { var b = bt('mv-btn pri', rotulo()); b.id = 'b-locs-feito'; b.addEventListener('click', function () { fecharFolha(function () { return $('c-locs'); }); zona('locs'); desenharBarraDia(); }); p.appendChild(b); },
    depois: function () { if (c.vista === 'v-diario') zona('locs'); return $('c-locs'); } });
  }
  function desenharBarraDia() {
    var box = $('barra-dia'); if (!box || !c.form) return;
    limpar(box);
    var f = c.form, fl = D.faltaDiario(f, !!obraDe(f.obraId)), hd = hojeDia(), nota = el('p', 'mv-barra-nota'); nota.id = 'barra-nota-dia';
    var txt, nomeIc;
    if (semArmazem()) { nomeIc = 'alerta'; txt = 'Neste telemóvel não consigo guardar: não feches esta página'; nota.classList.add('falta'); }
    else if (fl && (c.tentou || fl.espera)) { nomeIc = fl.espera ? 'relogio' : 'alerta'; txt = fl.texto; nota.classList.add('falta'); if (c.tentou && !fl.espera) nota.classList.add('tentou'); }
    else if (!online()) { nomeIc = 'semrede'; txt = 'Sem rede: fica guardado e segue sozinho'; }
    else if (!A.sessaoValida()) { nomeIc = 'relogio'; txt = 'Sessão acabada: guarda e entra outra vez'; }
    else if (f.corrigir) { nomeIc = 'relogio'; txt = 'Podes corrigir até à meia-noite'; }
    if (txt) { nota.appendChild(ic(nomeIc)); nota.appendChild(el('span', null, txt)); box.appendChild(nota); }
    var b = bt('mv-btn pri', fl && !fl.espera ? fl.texto : D.rotuloGuardar(f, hd.dia)); b.id = 'b-dia';
    b.setAttribute('aria-disabled', fl ? 'true' : 'false');
    b.addEventListener('click', guardarDiario);
    box.appendChild(b);
    A.medirBarra();
  }
  var aGuardar = false;
  async function guardarDiario() {
    var f = c.form; if (!f || aGuardar) return;
    var fl = D.faltaDiario(f, !!obraDe(f.obraId));
    if (fl) { c.tentou = true; desenharBarraDia(); if (fl.campo === 'obra') { var bo = $('c-obra-dia'); if (bo) bo.click(); } return; }
    if (f.corrigir && !D.mudouAlgo(f)) { apagarRascunho(f.obraId, f.dia); toast('Não mudaste nada: o diário fica como estava.', { ms: 3000 }); voltar(); return; }
    aGuardar = true;
    try {
      var s = sessao(), item = D.itemDaFila({ form: f, contaId: contaId(), contaNome: s && s.nome, novoId: function () { return M.novoId(); } });
      // o que estava parado para este registo (recusado, B4) é substituído por esta correcção: nada dele entrou no servidor
      c.fila.filter(function (q) { return q.contaId === contaId() && q.registoId === item.registoId && q.estado === 'parado'; }).forEach(function (q) { c.fila = c.fila.filter(function (x) { return x !== q; }); apagarItem(q.id); });
      var r = D.porNaFila(c.fila, item); c.fila = r.fila;
      await guardarItem(r.item);
      apagarRascunho(f.obraId, f.dia);
      c.envio = { item: r.item, fase: 'a-enviar' };
      c.form = null;
      if (!A.sessaoValida()) {   // A3: fica na fila e pede o login; depois de entrar volta aqui e segue
        c.envio.fase = 'guardado'; c.envio.mensagem = 'Guardado no telemóvel · entra outra vez para seguir.';   // A3
        abrir('v-dia-envio', true);
        A.pedirLogin('Guardado no telemóvel · entra outra vez para seguir.');
        return;
      }
      abrir('v-dia-envio', true);
      drenar(true);
    } finally { aGuardar = false; }
  }

  // ── Diário guardado (o ecrã de envio) ──
  function rlinha(rot, val) { var d = el('div', 'mv-rl'); d.appendChild(el('span', null, rot)); d.appendChild(typeof val === 'string' ? el('b', null, val) : val); return d; }
  function desenharDiaEnvio() {
    var v = $('v-dia-envio'); if (!v || !c.envio) return;
    limpar(v);
    var e = c.envio, it = e.item, o = obraDe(it.obraId), fase = e.fase, selo = el('div', 'mv-selo'), om = it.omitir || {};
    selo.setAttribute('role', 'img');
    if (fase === 'a-enviar') { selo.className = 'mv-selo nav'; selo.setAttribute('aria-label', 'A enviar'); var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'mv-roda'); s.setAttribute('viewBox', '0 0 72 72'); s.setAttribute('aria-hidden', 'true'); var ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); ci.setAttribute('cx', '36'); ci.setAttribute('cy', '36'); ci.setAttribute('r', '34'); s.appendChild(ci); selo.appendChild(s); selo.appendChild(ic('subir')); }
    else if (fase === 'guardado') { selo.className = 'mv-selo ama'; selo.setAttribute('aria-label', 'Guardado no telemóvel'); selo.appendChild(ic(semArmazem() ? 'alerta' : 'tel')); }
    else if (fase === 'parado') { selo.className = 'mv-selo neg'; selo.setAttribute('aria-label', 'Não entrou'); selo.appendChild(ic('alerta')); }
    else { selo.setAttribute('aria-label', 'Guardado'); selo.appendChild(ic('ok')); }
    v.appendChild(selo);
    var est = el('div', 'mv-env-estado'); est.setAttribute('aria-live', 'polite'); est.setAttribute('aria-atomic', 'true');
    var t = el('h1', 'mv-env-t'); t.id = 'de-titulo'; t.tabIndex = -1; t.setAttribute('data-foco-inicial', '');
    var nf = (it.fotos || []).filter(function (x) { return x.blob || x.prev; }).length, tot = D.totalHomens(it.equipas);
    var sub = el('p', 'mv-env-s');
    if (fase === 'a-enviar') { t.textContent = 'A enviar…'; sub.textContent = 'Não feches a app até chegar a confirmação.'; }
    else if (fase === 'guardado') { t.textContent = semArmazem() ? 'Por enviar' : 'Diário guardado no telemóvel'; sub.textContent = semArmazem() ? 'Neste telemóvel não consigo guardar: não feches esta página. Segue quando houver rede.' : (e.mensagem && !e.rede ? e.mensagem : 'Segue sozinho quando houver rede, com a app aberta.'); }
    else if (fase === 'parado') { t.textContent = 'Não entrou'; sub.textContent = e.mensagem || it.erro || ''; }
    else { t.textContent = 'Diário de ' + D.textoDiaMes(it.dia) + ' guardado'; sub.textContent = (o ? o.codigo + ' · ' : '') + D.txtHomens(tot) + (nf ? ' · ' + nf + (nf === 1 ? ' foto' : ' fotos') : ''); }
    est.appendChild(t); est.appendChild(sub); v.appendChild(est);
    (it.avisos || []).forEach(function (a) { var p = el('p', 'mv-erro ama'); p.appendChild(ic('alerta')); p.appendChild(el('span', null, a)); v.appendChild(p); });
    var semLugar = (it.fotos || []).filter(function (x) { return x.estado === 'sem-lugar'; }).length;
    if (semLugar && !(it.avisos || []).some(function (a) { return /não coube/.test(a); })) { var p2 = el('p', 'mv-erro ama'); p2.appendChild(ic('alerta')); p2.appendChild(el('span', null, semLugar === 1 ? 'Uma foto não coube no diário.' : semLugar + ' fotos não couberam no diário.')); v.appendChild(p2); }
    var lista = el('div', 'mv-lista');
    lista.appendChild(rlinha('Equipas', it.equipas.length ? it.equipas.map(function (q) { return q.nome + ' ' + q.homens; }).join(' · ') : 'Sem homens'));
    if (it.texto && !om.texto) lista.appendChild(rlinha('O que se fez', it.texto));
    if (!om.localizacoes && it.localizacoes.length) lista.appendChild(rlinha('Localizações', nomesLocs(it.obraId, it.localizacoes).join(' · ')));
    if (om.localizacoes || om.fotos) lista.appendChild(rlinha('Localizações e fotos', 'ficam como estavam'));
    if (nf) { var mi = el('b', 'mv-minis'); it.fotos.forEach(function (x, i) { if (!x.blob && !x.prev) return; if (!x.prev && URL.createObjectURL) x.prev = URL.createObjectURL(x.blob); var im = el('img'); im.alt = 'Foto ' + (i + 1); im.src = x.prev; mi.appendChild(im); }); lista.appendChild(rlinha('Fotos', mi)); }
    v.appendChild(lista);
    if (fase === 'feito') { var cm = el('p', 'mv-calmo'); cm.appendChild(ic('ok')); cm.appendChild(document.createTextNode('Podes corrigi-lo até à meia-noite.')); v.appendChild(cm); }
    var bb = limpar($('barra-dia-env'));
    var bf = bt('mv-btn pri', 'Feito'); bf.id = 'b-dia-feito'; bf.addEventListener('click', function () { c.envio = null; irHoje(); });
    if (fase === 'guardado' || fase === 'parado') { var vf = bt('mv-btn ghost compacto', 'Ver por enviar'); vf.addEventListener('click', function () { c.envio = null; abrir('v-fila', true); }); bb.appendChild(vf); }
    bb.appendChild(bf);
    A.medirBarra();
  }

  // ── Diário · 7 dias: os da obra, pelo servidor (M3) ──
  async function abrirDiario7() { abrir('v-diario7'); if (online() && A.sessaoValida()) { var ok = await lerDiasDe(obraHoje()); if (ok && c.vista === 'v-diario7') desenharDiario7(); } }
  function desenharDiario7() {
    var v = $('v-diario7'); if (!v) return; limpar(v);
    var ob = obraHoje(), o = obraDe(ob), hd = hojeDia(), sr = serieDe(ob), e = estadoDiarioHoje(ob);
    var lead = el('p', 'mv-lead'); lead.tabIndex = -1; lead.setAttribute('data-foco-inicial', '');
    if (o) junta(lead, el('code', null, o.codigo || ''), ' · ' + o.nome + (sr.obra ? ' · todos os registos da obra' : ' · os teus registos'));
    if (sr.obra && sr.lidoEm && (!online() || /^de /.test(D.textoDados(sr.lidoEm)))) lead.appendChild(document.createTextNode(' · dados ' + D.textoDados(sr.lidoEm)));
    v.appendChild(lead);
    var g = el('div', 'mv-d7g'); g.appendChild(graf7(sr.s, true)); v.appendChild(g);
    var leg = el('div', 'mv-segleg'), med = D.media(sr.s);
    var it = function (cls, txt) { var s = el('span'); s.appendChild(el('i', cls)); s.appendChild(document.createTextNode(txt)); leg.appendChild(s); };
    it('doe', 'DOE'); it('sub', 'Subempreiteiros'); it('tr', 'Dia sem diário'); if (med) it('med', 'média ' + Math.round(med));
    v.appendChild(leg);
    if (!sr.obra) v.appendChild(el('p', 'mv-lead mv-d7-nota', online() ? 'Ainda não li os dias desta obra.' : 'Sem rede: os dias da obra vêem-se quando houver rede.'));
    var lista = el('div', 'mv-lista mv-d7lista');
    sr.s.slice().reverse().forEach(function (x) {
      var util = !x.fds && !x.feriado;
      if (x.hoje && !x.tem) {
        var d0 = el('div', 'mv-fl mv-d7l sem'), t0 = el('span', 'mv-fl-t'); t0.appendChild(el('b', null, 'Hoje · ' + (e.pend ? 'por enviar' : (util ? 'por fazer' : (x.feriado ? 'feriado' : 'fim de semana'))))); t0.appendChild(el('small', null, e.pend ? D.txtHomens(D.totalHomens(e.pend.equipas)) + ' · segue quando houver rede' : 'Ainda sem o teu registo')); d0.appendChild(t0); lista.appendChild(d0); return;
      }
      if (!x.tem) {
        if (!x.conhecido) return;                                   // nunca se afirma «sem diário» sobre um dia que não se conhece
        if (x.feriado) { var df = el('div', 'mv-fl mv-d7l sem'), tf = el('span', 'mv-fl-t'); tf.appendChild(el('b', null, D.textoDiaCurto(x.dia))); tf.appendChild(el('small', null, 'Feriado · ' + x.feriado)); df.appendChild(tf); lista.appendChild(df); return; }
        if (x.fds) return;
        var ds = el('div', 'mv-fl mv-d7l sem'), ts = el('span', 'mv-fl-t'); ts.appendChild(el('b', null, D.textoDiaCurto(x.dia))); ts.appendChild(el('small', null, 'Sem diário')); ds.appendChild(ts); lista.appendChild(ds); return;
      }
      var b = bt('mv-fl mv-d7l'); b.appendChild(el('span', 'mv-d7n', String(x.total)));
      var t = el('span', 'mv-fl-t'); t.appendChild(el('b', null, x.hoje ? 'Hoje' : D.textoDiaCurto(x.dia)));
      var resumo = sr.obra ? (x.registos === 1 ? '1 registo' : x.registos + ' registos') + (x.meu ? ' · o teu: ' + D.txtHomens(Number(x.meu.totalHomens) || 0) : '') : (String(x.texto || '').split(/[.\n]/)[0] || D.txtHomens(x.total));
      t.appendChild(el('small', null, resumo));
      b.appendChild(t); b.appendChild(ic('chev'));
      b.addEventListener('click', function () { folhaDia(x, sr.obra); });
      lista.appendChild(b);
    });
    v.appendChild(lista);
    var bb = limpar($('barra-d7'));
    if (tem('diario')) { var bd = bt('mv-btn pri', e.meu || e.pend ? 'Corrigir o diário de hoje' : 'Fazer o diário de hoje'); bd.id = 'b-d7'; bd.addEventListener('click', function () { abrirDiario(ob); }); bb.appendChild(bd); }
    A.medirBarra();
  }
  function folhaDia(x, daObra) {
    var ob = obraHoje(), h = (cache().hist || []).filter(function (y) { return y.obraId === ob && y.dia === x.dia; })[0];
    folha({ titulo: D.textoDiaCurto(x.dia), sub: (obraDe(ob) || {}).codigo || '', corpo: function (cc) {
      if (daObra) {
        cc.appendChild(rlinha('Homens na obra', D.txtHomens(x.total)));
        cc.appendChild(rlinha('DOE', String(x.doe))); cc.appendChild(rlinha('Subempreiteiros', String(x.sub)));
        cc.appendChild(rlinha('Registos', String(x.registos)));
        cc.appendChild(el('p', 'mv-folha-txt', 'Quando duas pessoas registam a mesma equipa conta o número mais alto.'));
      }
      if (x.meu || h) {
        cc.appendChild(el('p', 'mv-lh', 'O teu registo'));
        if (h) { h.equipas.forEach(function (e) { cc.appendChild(rlinha(e.nome, String(e.homens))); }); if (h.texto) cc.appendChild(el('p', 'mv-desc', h.texto)); }
        else cc.appendChild(rlinha('Homens', D.txtHomens(Number(x.meu.totalHomens) || 0)));
      }
    } });
  }

  // ── Por enviar (a fila das duas: ocorrências e diários) ──
  function desenharFila() {
    var v = $('v-fila'); if (!v) return; limpar(v);
    var p = porEnviar(), n = p.diarios.length + p.ocorrencias.length + p.alheias.length + p.alheiosDia.length + (p.rascunho ? 1 : 0);
    if (!n) { var nd = el('p', 'mv-nada', 'Nada por enviar.'); nd.tabIndex = -1; nd.setAttribute('data-foco-inicial', ''); v.appendChild(nd); return; }
    var lead = el('p', 'mv-lead', semArmazem() ? 'Isto só está guardado nesta página: não a feches.' : (!A.sessaoValida() ? 'A sessão acabou: entra outra vez para seguirem.' : (online() ? 'Seguem sozinhos com rede, com a app aberta.' : 'Sem rede. Seguem sozinhos quando houver rede.')));
    lead.tabIndex = -1; lead.setAttribute('data-foco-inicial', ''); v.appendChild(lead);
    var lista = el('div', 'mv-lista mv-fila');
    var linha = function (nomeIc, titulo, resumo, estado, cls, acoes, apagar) {
      var d = el('div', 'mv-fl'), i = el('span', 'mv-obra-ic'); i.appendChild(ic(nomeIc)); d.appendChild(i);
      var t = el('span', 'mv-fl-t'); t.appendChild(el('b', null, titulo)); if (resumo) t.appendChild(el('small', null, resumo)); if (estado) t.appendChild(el('small', cls || null, estado));
      if (acoes && acoes.length) { var ac = el('span', 'mv-mr-acc'); acoes.forEach(function (a) { var b = bt('mv-link'); b.appendChild(ic(a[0])); b.appendChild(document.createTextNode(a[1])); b.addEventListener('click', a[2]); ac.appendChild(b); }); t.appendChild(ac); }
      d.appendChild(t);
      if (apagar) { var x = bt('mv-icb'); x.setAttribute('aria-label', 'Apagar este envio'); x.appendChild(ic('lixo')); x.addEventListener('click', apagar); d.appendChild(x); }
      lista.appendChild(d);
    };
    p.ocorrencias.forEach(function (r) {
      var o = obraDe(r.projectId), est = r.parado ? (r.bloqueio || 'Não foi enviada') : (r.numero ? 'Registada · faltam fotos' : (online() ? 'Na fila' : 'À espera de rede'));
      linha('alerta', 'Ocorrência' + (o ? ' · ' + o.codigo : ''), String(r.texto || '').slice(0, 60), est, r.parado ? 'neg' : null, [['chev', 'Ver', function () { c.pilha.push('v-envio'); try { history.pushState({ mvV: 'v-envio', n: c.pilha.length }, ''); } catch (e) { /* nada */ } A.verOcorrencia(r.id); }]]);
    });
    if (p.rascunho) { var ro = obraDe(p.rascunho.projectId); linha('alerta', 'Ocorrência' + (ro ? ' · ' + ro.codigo : ''), String(p.rascunho.texto || '').slice(0, 60), 'Rascunho · por acabar', 'ama', [['lapis', 'Continuar', function () { abrir('v-registo'); }]]); }
    Object.keys(c.rascunhos).map(function (k) { return c.rascunhos[k]; }).filter(function (r) { return r.contaId === contaId(); }).forEach(function (r) {
      var o = obraDe(r.obraId); linha('diario', 'Diário de obra' + (o ? ' · ' + o.codigo : '') + ' · ' + D.textoDiaMes(r.dia), D.txtHomens(D.totalHomens(D.equipasParaEnviar(r.form.equipas))), 'Rascunho · por acabar', 'ama', [['lapis', 'Continuar', function () { abrirDiario(r.obraId, false, false, r.dia); }]]);
    });
    p.diarios.slice().sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      var o = obraDe(q.obraId), parado = q.estado === 'parado', emCurso = c.emCurso && c.atual === q.id;
      var est = parado ? (q.erro || 'Não entrou') : (emCurso ? 'A enviar…' : (!A.sessaoValida() ? 'À espera de entrares' : (!online() ? 'À espera de rede' : (q.erro || 'Na fila'))));
      var acoes;
      if (parado && q.motivo === 'corrigir') acoes = [['lapis', 'Corrigir', function () { c.erroDe = { obraId: q.obraId, campo: q.campo || 'texto', texto: q.erro }; abrirDiario(q.obraId); }]];   // B4
      else if (parado) acoes = q.motivo === 'dia-fechado' || q.motivo === 'obra' ? [] : [['atual', 'Tentar de novo', function () { q.estado = 'a-enviar'; q.erro = ''; guardarItem(q); drenar(true); desenharFila(); }]];
      else acoes = [['atual', 'Tentar agora', function () { if (!A.sessaoValida()) { A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); return; } drenar(true); }]];
      linha('diario', 'Diário de obra' + (o ? ' · ' + o.codigo : '') + ' · ' + D.textoDiaMes(q.dia), D.resumoItem(q), est, parado ? 'neg' : null, acoes, parado ? function () { apagarDaFila(q); } : null);
    });
    // M5: de outra conta, só quantos e de quem (nunca o texto)
    var outras = {};
    p.alheias.concat(p.alheiosDia).forEach(function (r) { var nome = r.contaNome || 'outra conta'; outras[nome] = (outras[nome] || 0) + 1; });
    Object.keys(outras).forEach(function (nome) { var k = outras[nome]; linha('pessoa', k + (k === 1 ? ' envio de ' : ' envios de ') + nome, '', k === 1 ? 'Só essa conta o pode enviar' : 'Só essa conta os pode enviar', null); });
    v.appendChild(lista);
  }
  function apagarDaFila(q) {
    c.fila = c.fila.filter(function (x) { return x !== q; }); c.apagar[q.id] = true; desenharFila(); desenharHojeSeVisivel();
    toast('Apagado · diário de ' + D.textoDiaMes(q.dia), { desfazer: function () { delete c.apagar[q.id]; c.fila.push(q); desenharFila(); }, aoFim: function () { if (c.apagar[q.id]) { delete c.apagar[q.id]; apagarItem(q.id); } } });
  }

  // ── Conta ──
  function abrirConta() {
    var s = sessao(); if (!s) return;
    A.abrirConta(function (box) {
      limpar(box);
      $('fc-papel').textContent = s.soTelemovel ? 'Encarregado · conta só de telemóvel' : '';
      $('fc-papel').hidden = !s.soTelemovel;
      var pw = linhaOp('chave', 'Mudar a palavra-passe', 'Os outros telemóveis têm de entrar outra vez'); pw.id = 'b-mudar-pass'; pw.addEventListener('click', folhaPassword); box.appendChild(pw);
      var dl = linhaOp('desligar', 'Desligar os meus telemóveis', 'Termina a sessão em todos, também neste'); dl.id = 'b-desligar'; dl.addEventListener('click', desligarTelemoveis); box.appendChild(dl);
      box.appendChild(el('p', 'mv-folha-txt mv-conta-perdi', 'Perdeste um telemóvel? Toca em «Desligar os meus telemóveis» (ou muda a palavra-passe): corta o acesso em todos.'));
    });
  }
  function folhaPassword() {
    var erro = function (txt) { var e = $('fx-erro'); e.textContent = ''; if (!txt) { e.hidden = true; return; } e.appendChild(ic('alerta')); e.appendChild(el('span', null, txt)); e.hidden = false; };
    folha({ titulo: 'Mudar a palavra-passe', sub: 'Pelo menos 8 caracteres. Os teus outros telemóveis terão de entrar outra vez.', foco: function () { return $('fx-t'); }, corpo: function (cc) {
      var campo = function (id, rot, auto) {
        var l = el('label', 'mv-rot', rot); l.htmlFor = id; cc.appendChild(l);
        var w = el('div', 'mv-pass'), i = el('input', 'mv-in'); i.id = id; i.type = 'password'; i.autocomplete = auto; i.setAttribute('autocapitalize', 'none'); i.setAttribute('autocorrect', 'off'); i.spellcheck = false; i.setAttribute('enterkeyhint', id === 'p-nova' ? 'done' : 'next');
        var ver = bt('mv-icb'); ver.setAttribute('aria-label', 'Mostrar a palavra-passe'); ver.setAttribute('aria-pressed', 'false'); ver.appendChild(ic('olho'));
        ver.addEventListener('click', function () { var v = i.type === 'password'; i.type = v ? 'text' : 'password'; ver.setAttribute('aria-pressed', String(v)); limpar(ver).appendChild(ic(v ? 'olhoNao' : 'olho')); });
        junta(w, i, ver); cc.appendChild(w); return i;
      };
      campo('p-atual', 'Palavra-passe atual', 'current-password'); campo('p-nova', 'Palavra-passe nova', 'new-password');
      var e = el('p', 'mv-erro'); e.id = 'fx-erro'; e.hidden = true; e.setAttribute('role', 'alert'); cc.appendChild(e);
      cc.firstChild.classList.add('mv-rot-1');
    }, pe: function (p) {
      var b = bt('mv-btn pri', 'Mudar'); b.id = 'b-pass-ok'; p.appendChild(b);
      var a = false, espera = 0;
      b.addEventListener('click', async function () {
        if (a) return;
        if (espera > Date.now()) { erro('Tenta outra vez daqui a ' + D.textoEspera((espera - Date.now()) / 1000) + '.'); return; }
        var at = $('p-atual').value, nv = $('p-nova').value;
        if (!at) { erro('Escreve a palavra-passe atual.'); $('p-atual').focus(); return; }
        if (String(nv).length < 8) { erro('A palavra-passe nova tem de ter pelo menos 8 caracteres.'); $('p-nova').focus(); return; }
        if (!online()) { erro('Para mudar a palavra-passe é preciso rede.'); return; }
        a = true; b.textContent = 'A mudar…'; b.classList.add('ocupado');
        var r;
        try { r = await D.mudarPassword(deps(), at, nv); } finally { a = false; b.textContent = 'Mudar'; b.classList.remove('ocupado'); }
        if (r.ok) { A.trocarToken(r.data.token, r.data.expiraEm); fecharFolha(); toast('Palavra-passe mudada. Os outros telemóveis têm de entrar outra vez.', { ms: 4000 }); drenar(false); return; }
        if (r.rede) { erro(r.online === false ? 'Sem rede. Para mudar a palavra-passe é preciso rede.' : 'Não sei se a palavra-passe mudou (a resposta perdeu-se): experimenta entrar com a nova.'); return; }   // B1
        if (r.code === 'PASSWORD_ALTERADA_ENTRA_DE_NOVO') { A.fecharFolhas(); apagarCache(); A.sairCom(D.mensagemDiario(r).texto); return; }
        if (r.code === 'DEMASIADOS_PEDIDOS' || r.status === 429) { espera = Date.now() + Math.max(1, r.retryAfter || 60) * 1000; erro('Demasiadas tentativas. Tenta outra vez daqui a ' + D.textoEspera(r.retryAfter || 60) + '.'); return; }
        if (r.code === 'MOVEL_POR_INSTALAR') { erro('A mudança de palavra-passe pelo telemóvel ainda está a ser preparada no servidor. Tenta mais tarde, ou muda-a no computador.'); return; }
        var m = D.mensagemDiario(r);
        if (talvezLogin(m)) { A.fecharFolhas(); return; }
        erro(m.texto.replace(/ Fica no telemóvel;?[^.]*\./, '').replace(/; tento outra vez\.?/, '.'));
      });
    } });
  }
  var aDesligar = false;
  /** M6: corre ao tocar (acção deliberada, sem Desfazer: quem fecha a app logo a seguir fica mesmo desligado). */
  async function desligarTelemoveis() {
    if (aDesligar) return;
    if (!online()) { toast('Precisa de rede. Liga-te e volta a tentar.', { ms: 3000 }); return; }
    aDesligar = true;
    var bd = $('b-desligar'), rot = bd && bd.querySelector('.mv-op-l'); if (rot) rot.textContent = 'A desligar…';
    var r;
    try { r = await D.desligar(deps()); } finally { aDesligar = false; if (rot) rot.textContent = 'Desligar os meus telemóveis'; }
    if (r.ok || r.code === 'TOKEN_REVOGADO') { A.fecharFolhas(); apagarCache(); A.sairCom('Desligaste os teus telemóveis. Para voltar, entra outra vez (com rede).'); return; }
    var m = D.mensagemDiario(r);
    if (m.accao === 'login') { A.fecharFolhas(); talvezLogin(m); return; }
    A.fecharFolhas();
    toast(r.rede ? 'Não desliguei: sem rede.' : 'Não desliguei: ' + m.texto, { ms: 8000, acao: { rot: 'Tentar de novo', fn: desligarTelemoveis } });
  }

  // ── A fila dos diários: envia por ordem; um que falha não pára os seguintes (A4) ──
  async function drenar(manual) {
    if (c.emCurso) { c.mais = true; return; }
    if (!sessao() || !A.sessaoValida()) { desenharHojeSeVisivel(); desenharFilaSeVisivel(); return; }
    c.emCurso = true; clearTimeout(c.timer);
    var parou = null, conta = contaId(), feitos = {}, repete = 0, bloqueados = {};   // 2.ª revisão (5): um registo que falhou faz esperar os seguintes dele
    try {
      for (var volta = 0; volta < 60; volta++) {
        c.mais = false;
        var q = c.fila.filter(function (x) { return x.estado === 'a-enviar' && x.contaId === conta && !c.apagar[x.id] && !feitos[x.id] && !bloqueados[x.registoId]
          && !c.fila.some(function (y) { return y !== x && y.registoId === x.registoId && y.estado === 'parado' && String(y.criadoEm) < String(x.criadoEm); }); }).sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); })[0];
        if (!q || contaId() !== conta) break;
        c.atual = q.id; desenharFilaSeVisivel();
        var tk = A.token();
        var res = await D.processarDiario(q, deps());
        c.atual = '';
        if (res.estado === 'login' && res.revogado && A.token() && A.token() !== tk && repete < 2) { repete++; continue; }   // B2: a palavra-passe mudou a meio: repete com o token novo
        if (c.envio && c.envio.item.id === q.id) {
          c.envio.fase = res.estado === 'entregue' ? 'feito' : (res.estado === 'parar' || res.estado === 'corrigir' ? 'parado' : 'guardado');
          c.envio.mensagem = res.mensagem; c.envio.rede = !!res.rede;
          if (c.vista === 'v-dia-envio') desenharDiaEnvio();
        } else if (res.estado === 'entregue') toast('Diário de ' + D.textoDiaMes(q.dia) + (obraDe(q.obraId) ? ' · ' + obraDe(q.obraId).codigo : '') + ': enviado', { ms: 3500 });
        if (res.estado === 'entregue') { c.fila = c.fila.filter(function (x) { return x !== q; }); apagarItem(q.id); c.tentativas = 0; continue; }
        if (res.estado === 'login') { parou = 'login'; talvezLogin({ accao: 'login', texto: res.mensagem, revogado: res.revogado }); break; }
        if (res.estado === 'pendente') { feitos[q.id] = true; bloqueados[q.registoId] = true; q.erro = res.rede ? '' : (res.mensagem || ''); guardarItem(q); if (res.rede || (res.longo && !res.contrato)) { parou = res; break; } parou = parou || res; continue; }   // rede: os outros também falhavam; senão segue para o próximo
        feitos[q.id] = true; bloqueados[q.registoId] = true;   // parado (dia fechado, obra, recusa): fica com o motivo e segue (os outros registos)
      }
    } finally { c.emCurso = false; c.atual = ''; }
    desenharHojeSeVisivel(); desenharFilaSeVisivel();
    if (parou && parou !== 'login') {
      if (manual) c.tentativas = 0;
      var ms = c.tentativas < ESPERAS.length ? Math.max(ESPERAS[c.tentativas], (parou.retryAfter || 0) * 1000) : null;
      if (parou.longo) ms = Math.max(ms || 0, 5 * 60 * 1000);
      c.tentativas++;
      if (ms != null && !(parou.rede && !online())) c.timer = setTimeout(function () { drenar(false); }, ms);
    } else if (c.mais) drenar(false);
  }
  function desenharHojeSeVisivel() { if (c.vista === 'v-hoje' && A.vista() === 'v-hoje') desenharHoje(); }
  function desenharFilaSeVisivel() { if (c.vista === 'v-fila' && A.vista() === 'v-fila') desenharFila(); }
  function redesenhar() { desenharHojeSeVisivel(); desenharFilaSeVisivel(); }

  // ── Ganchos chamados por app.js ──
  function rotaDoEndereco() {
    try { var q = new URLSearchParams(location.search); var ir = q.get('ir'); if (ir === 'ocorrencia' || ir === 'diario') return ir; if (q.get('obra')) return 'ocorrencia'; } catch (e) { /* nada */ }
    return '';
  }
  /** Abre o primeiro ecrã: o do endereço (?ir=ocorrencia, ?ir=diario, ?obra=PHX), senão o Hoje. A fila segue logo (A2). */
  function abrirInicial() {
    var r = c.rotaInicial;
    c.pilha = ['v-hoje'];
    try { history.replaceState({ mvV: 'v-hoje', n: 1 }, ''); } catch (e) { /* nada */ }
    if (r === 'ocorrencia') { abrir('v-registo'); ler(false); }
    else if (r === 'diario' && tem('diario')) { mostrar('v-hoje'); abrirDiario(obraHoje()); ler(false); }
    else { mostrar('v-hoje'); ler(true); }
    if (!tem('diario') || !online() || !A.sessaoValida()) drenar(false);   // com rede, a fila segue depois da 1.ª leitura (o contrato do servidor de agora decide)
  }
  function antesDoLogin() { var v = A.vista(); if (v && v !== 'v-login') c.antes = v; }
  function depoisDoLogin(contaMudou) {
    if (contaMudou) { c.cache = null; c.form = null; c.envio = null; c.lidoMs = 0; c.obraHoje = ''; c.antes = ''; }
    var v = c.antes; c.antes = '';
    if (v === 'v-registo' || v === 'v-envio') { c.pilha = ['v-hoje', 'v-registo']; try { history.replaceState({ mvV: 'v-registo', n: 2 }, ''); } catch (e) { /* nada */ } c.vista = 'v-registo'; A.abrirOcorrencia(); desenharNav(); }   // M7: volta ao formulário da ocorrência
    else if (v && ehCasca(v) && (v !== 'v-diario' || c.form) && (v !== 'v-dia-envio' || c.envio)) mostrar(v);
    else abrirInicial();
    ler(true); drenar(true);
  }
  function aoSair() { clearTimeout(c.timer); gravarRascunhoJa(); apagarCache(); c.pilha = []; c.vista = ''; c.entrou = false; }
  async function ligar(ponte) {
    A = ponte;
    c.store = await abrirStore(); c.memoria = !!c.store.memoria;
    var todos = []; try { todos = await c.store.listar(); } catch (e) { todos = []; }
    c.fila = []; c.rascunhos = {};
    var hj = new Date(); hj.setDate(hj.getDate() - 7); var limiteRasc = hj.getFullYear() + '-' + ('0' + (hj.getMonth() + 1)).slice(-2) + '-' + ('0' + hj.getDate()).slice(-2);
    todos.forEach(function (r) {
      if (!r) return;
      if (r.tipo === 'diario-rascunho') { if (!r.mexidos || String(r.dia) < limiteRasc) { apagarItem(r.id); return; } c.rascunhos[r.id] = r; return; }   // mais de 7 dias (ou do formato antigo): sai, com as fotos
      if (r.tipo !== 'diario') return;   // (numa base partilhada, como a dos testes, há também as ocorrências: não são daqui)
      if (r.estado === 'entregue') { apagarItem(r.id); return; }
      c.fila.push(r);
    });
    c.rotaInicial = rotaDoEndereco();
    window.addEventListener('popstate', aoVoltarHist);
    window.addEventListener('online', function () { c.tentativas = 0; c.falhasLer = 0; redesenhar(); if (c.vista === 'v-diario') desenharBarraDia(); if (tem('diario') && A.sessaoValida()) ler(true); else drenar(false); });   // 3.ª revisão: primeiro LER (o contrato), a fila segue no fim da leitura
    window.addEventListener('offline', function () { redesenhar(); if (c.vista === 'v-diario') desenharBarraDia(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) gravarRascunhoJa(); else if (sessao()) { if (tem('diario') && A.sessaoValida()) ler(false); else drenar(false); } });   // a leitura drena no fim
    window.addEventListener('pagehide', gravarRascunhoJa);
    ['d-cam', 'd-gal'].forEach(function (id) { var i = $(id); if (i) i.addEventListener('change', function (ev) { juntarFotos(ev.target.files).then(function () { ev.target.value = ''; }); }); });
  }
  self.DoeMovelCasca = {
    ligar: ligar, abrirInicial: abrirInicial, antesDoLogin: antesDoLogin, depoisDoLogin: depoisDoLogin, aoSair: aoSair,
    voltar: voltar, irHoje: irHoje, rotuloVoltar: rotuloVoltar, ehCasca: ehCasca,
    titulo: function (v) { if (v === 'v-diario' && c.form && c.form.dia !== hojeDia().dia) return 'Diário de ' + D.textoDiaCurto(c.form.dia); return TITULO[v] || ''; },
    aoMudarFila: function (o) { if (o && o.recebida && ehCasca(c.vista)) toast('Ocorrência ' + o.recebida + ' recebida', { ms: 3500 }); redesenhar(); },
    nDiariosPorEnviar: function () { return minhaFila().length; },
    trabalhoNaPagina: function () { return semArmazem() ? minhaFila().length + Object.keys(c.rascunhos).length : 0; },
    abrirFila: function () { abrir('v-fila'); }, abrirDiario7: abrirDiario7, vista: function () { return c.vista; }, definirVista: function (v) { c.vista = v; },
    _estado: function () { return c; },
  };
}());
