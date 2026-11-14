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
  var D = self.DoeMovelDiario, M = self.DoeMovel, H = self.DoeMovelHoje || null;   // H: o Hoje da fatia 2a (hoje.js); sem ele, o Hoje da fatia 1
  var A = null;                                   // a ponte para app.js
  var TE = null;                                  // os ecrãs dos trabalhos em falta (trabalhos-ecra.js, fatia 2a); sem eles, o bloco Trabalhos abre os números
  var BE = null;                                  // os ecrãs dos bloqueios do cliente (bloqueios-ecra.js, fatia 2a, parte 3)
  var LS_CACHE = 'doeMovel.cache', LS_OBRA_HOJE = 'doeMovel.obraHoje', DB_NOME = 'doeMovelDiario', STORE = 'fila';
  var ESPERAS_LER = self.DOE_MOVEL_ESPERAS_LER || [5000, 30000, 120000];   // (os testes encurtam-nas)
  var MS_RELER = 30 * 1000, MS_LOCS = 12 * 3600 * 1000, ESPERAS = [2000, 10000, 60000], MS_RASCUNHO = 300;
  var ROTULO = { 'v-hoje': 'Hoje', 'v-fila': 'Por enviar', 'v-diario7': 'Diário · 7 dias', 'v-diario': 'Diário', 'v-registo': 'Ocorrência', 'v-envio': 'Ocorrência', 'v-dia-envio': 'Diário' };
  var TITULO = { 'v-diario': 'Diário de obra', 'v-dia-envio': 'Diário de obra', 'v-diario7': 'Diário · 7 dias', 'v-fila': 'Por enviar' };
  var c = { cache: null, fila: [], rascunhos: {}, vista: '', pilha: [], form: null, envio: null, lendo: false, lidoMs: 0, aviso: '', timer: null, emCurso: false, tentativas: 0, obraHoje: '', entrou: false, apagar: {}, rotaInicial: '', store: null, memoria: false, antes: '',
    semHojeMv: false, hx: { pag: 0, obra: '', visto: false, y: 0 } };   // fatia 2a: o servidor sem o Hoje novo (nesta abertura); a página Geral/Obras e a obra aberta
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
    var ch = cache(), cands = [lsLer(LS_OBRA_HOJE), minhaUnica(), ch.hoje && ch.hoje.obraSugerida, lsLer('doeMovel.obra')];
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
      versaoMinha: function (id, v) { var ch = cache(); return !!(ch.versoesMinhas && ch.versoesMinhas[id + '|' + v]); },
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
      // Fatia 2a: o Hoje numa só leitura (GET /movel/hoje). Sem ela no servidor (SQL por aplicar, Edge antiga, 403 da
      // conta), volta à leitura da fatia 1 nesta abertura, sem pedir o login.
      var usouHoje = false;
      if (temHojeMv()) {
        var chave = H.chaveDe(obras()), rh = await H.lerHoje(dp, chave);
        if (contaId() !== conta) return;
        if (rh.ok) {
          H.guardar(cache(), chave, rh.data); usouHoje = true;
          var fora = chave === 'todas' && modoHoje() === 'uma' ? obraHoje() : '';   // a obra escolhida fora das minhas: lê-se ela
          if (fora && !(rh.data.obras || []).some(function (o) { return o.id === fora; })) {
            var rf = await H.lerHoje(dp, fora);
            if (contaId() !== conta) return;
            if (rf.ok) H.guardar(cache(), fora, rf.data); else if (talvezLogin(D.mensagemDiario(rf))) return;
          }
        } else if (H.semHoje(rh)) { c.semHojeMv = true; c.externa = rh.code === 'CONTA_EXTERNA'; }   // a externa não tem esta fatia: nem «Em breve»
        else { falhaLeitura(rh); return; }
      }
      if (!usouHoje) {
        var r2 = await D.lerHoje(dp);
        if (contaId() !== conta) return;
        if (!r2.ok) { falhaLeitura(r2); return; }
        D.guardarHoje(cache(), r2.data);
      }
      c.aviso = ''; c.falhasLer = 0; c.leuNestaAbertura = true;
      var ob = obraHoje();
      if (ob) {   // para o formulário abrir sem rede (o registo de hoje, «como ontem», as sugestões, as Localizações)
        var r3 = await D.lerObra(dp, ob);
        if (contaId() !== conta) return;
        if (r3.ok) D.guardarObra(cache(), ob, r3.data); else if (talvezLogin(D.mensagemDiario(r3))) return;
        if (!usouHoje) await lerDiasDe(ob, dp, conta);   // com o Hoje novo os 7 dias vêm na leitura; o ecrã «Diário · 7 dias» lê os 14 ao abrir
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
  /** Uma leitura do Hoje que falhou: o login (token revogado: sai de vez), o aviso do servidor por preparar, e com rede
      volta a tentar (5 s, 30 s, 2 min; 3.ª revisão). */
  function falhaLeitura(r) {
    var m = D.mensagemDiario(r); if (talvezLogin(m)) return;
    c.aviso = r.code === 'DIARIO_POR_INSTALAR' || r.code === 'MOVEL_POR_INSTALAR' ? m.texto : '';
    if (online() && m.accao === 'repetir') { var ms = ESPERAS_LER[Math.min(c.falhasLer || 0, ESPERAS_LER.length - 1)]; c.falhasLer = (c.falhasLer || 0) + 1; clearTimeout(c.timerLer); c.timerLer = setTimeout(function () { ler(true); }, Math.max(ms, (m.retryAfter || 0) * 1000)); }
  }
  /** A obra escolhida no Hoje (fora das minhas): só a leitura dela. */
  async function lerPainelObra(ob) {
    if (!temHojeMv() || !online() || !A.sessaoValida()) return;
    var conta = contaId(), r = await H.lerHoje(deps(), ob);
    if (contaId() !== conta) return;
    if (r.ok) { H.guardar(cache(), ob, r.data); gravarCache(); } else if (H.semHoje(r)) { c.semHojeMv = true; c.externa = r.code === 'CONTA_EXTERNA'; } else if (talvezLogin(D.mensagemDiario(r))) return;
    redesenhar();
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
  /** O meu registo de um dia passado (até 14 dias), com o `pode` do servidor (13 nov 2026). → data | null (sem rede, falhou). */
  async function lerDiaAgora(ob, dia) {
    if (!A.sessaoValida() || !online()) return null;
    var conta = contaId(), r = await D.lerObra(deps(), ob, dia);
    if (contaId() !== conta) return null;
    if (r.ok) { D.guardarDiaLido(cache(), ob, r.data); gravarCache(); return r.data; }
    talvezLogin(D.mensagemDiario(r));
    return null;
  }
  async function lerLocsAgora(ob) {
    if (!A.sessaoValida() || !online()) return;
    var conta = contaId(), r4 = await D.lerLocalizacoes(deps(), ob);
    if (contaId() === conta && r4.ok) { cache().locs[ob] = { produtos: r4.data.produtos || [], lidoEm: new Date().toISOString() }; gravarCache(); }
  }

  // ── Navegação: uma pilha de ecrãs, com o «voltar» do telemóvel (history) ──
  function ehCasca(v) { return v === 'v-hoje' || v === 'v-diario' || v === 'v-dia-envio' || v === 'v-diario7' || v === 'v-fila' || !!(TE && TE.VISTAS.indexOf(v) >= 0) || !!(BE && BE.VISTAS.indexOf(v) >= 0); }
  /** Um ecrã de formulário ou de «Registado» só volta (voltar, entrar outra vez) se ainda houver o que mostrar. */
  function vistaViva(v) { return (v !== 'v-tf-form' || !!(TE && TE.temForm())) && (v !== 'v-tf-envio' || !!(TE && TE.temEnvio())) && (v !== 'v-bc-form' || !!(BE && BE.temForm())) && (v !== 'v-bc-envio' || !!(BE && BE.temEnvio())); }
  function mostrar(v) {
    if (v !== c.vista) tirarToast();
    c.vista = v;
    A.ir(v);
    if (v === 'v-hoje') desenharHoje(); else if (v === 'v-diario') desenharDiario(true); else if (v === 'v-dia-envio') desenharDiaEnvio(); else if (v === 'v-diario7') desenharDiario7(); else if (v === 'v-fila') desenharFila(); else if (TE && TE.VISTAS.indexOf(v) >= 0) TE.desenhar(v); else if (BE && BE.VISTAS.indexOf(v) >= 0) BE.desenhar(v);
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
  /** manterObra: volta à obra aberta (o «Feito» do diário); sem ele (o «Hoje» da barra), à página onde se estava. */
  function irHoje(manterObra) {
    if (c.vista === 'v-registo') A.gravarJa();
    gravarRascunhoJa();
    if (manterObra !== true) c.hx.obra = '';
    c.pilha = ['v-hoje'];
    try { history.replaceState(c.hx.obra ? { mvV: 'v-hoje', n: 1, hxObra: c.hx.obra } : { mvV: 'v-hoje', n: 1 }, ''); } catch (e) { /* nada */ }
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
    if (v === 'v-hoje') {   // várias obras: entrar e sair de uma obra é uma entrada do histórico do Hoje
      var alvo = st.hxObra || '';
      if (c.vista === 'v-hoje' && A.vista() === 'v-hoje') { if (alvo !== c.hx.obra) { if (alvo) { c.hx.obra = alvo; c.obraHoje = alvo; desenharHoje(); } else sairObraJa(); } return; }
      c.hx.obra = alvo;
    }
    if (v === A.vista() && v === c.vista) return;
    if (v === 'v-registo' || v === 'v-envio') { c.vista = v; if (v === 'v-registo') A.abrirOcorrencia(); desenharNav(); return; }
    if (v === 'v-dia-envio' && !c.envio) v = 'v-hoje';
    if (v === 'v-diario' && !c.form) v = 'v-hoje';
    if (!vistaViva(v)) v = 'v-hoje';
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
    d.className = 'mv-folha' + (o.alta ? ' alta' : ''); d.removeAttribute('data-dono'); d.removeAttribute('data-dia');   // quem a abre marca-a de novo (bloqueios-ecra.js redesenha só a sua)
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
  var tToast = null, toastAtual = null, toastEspera = null;
  /** Revisão (C1): um aviso só informativo (sem Desfazer nem acção) não tira o lugar a um com Desfazer: espera que ele
      acabe (fica só o último). Um aviso com Desfazer novo continua a fechar o anterior (que segue, pelo aoFim). */
  function toast(texto, o) {
    o = o || {};
    if (!o.desfazer && !o.acao && toastAtual && toastAtual.desfazer) { toastEspera = { texto: texto, o: o }; return; }
    if (toastAtual) { var ant = toastAtual; toastAtual = null; clearTimeout(tToast); if (ant.aoFim) ant.aoFim(); }
    var t = $('toast'); limpar(t); t.appendChild(el('span', null, texto));
    if (o.acao) { var b2 = bt('', o.acao.rot); b2.addEventListener('click', function () { toastAtual = null; clearTimeout(tToast); esconderToast(); o.acao.fn(); }); t.appendChild(b2); }   // a acção antes do Desfazer (protótipo: «Feito · Foto do depois · Desfazer»)
    if (o.desfazer) { var b = bt('', 'Desfazer'); b.addEventListener('click', function () { var a = toastAtual; toastAtual = null; clearTimeout(tToast); esconderToast(); if (a && a.desfazer) a.desfazer(); toastSeguinte(); }); t.appendChild(b); }
    t.hidden = false;
    if (semMov()) t.classList.add('on'); else requestAnimationFrame(function () { t.classList.add('on'); });
    toastAtual = o;
    tToast = setTimeout(function () { var a = toastAtual; toastAtual = null; esconderToast(); if (a && a.aoFim) a.aoFim(); toastSeguinte(); }, o.ms || 5000);
  }
  function toastSeguinte() { var x = toastEspera; toastEspera = null; if (x) toast(x.texto, x.o); }
  /** Revisão (A1): larga o aviso de um comando (sem correr o aoFim dele, que voltava a pôr o comando a seguir). */
  function largarToastDe(itemId) { if (toastAtual && toastAtual.itemId === itemId) { toastAtual = null; clearTimeout(tToast); esconderToast(); } }
  /** Ao mudar de ecrã sai o aviso que só informava (o que tem Desfazer fica até acabar). */
  function tirarToast() { toastEspera = null; if (toastAtual && toastAtual.desfazer) return; var a = toastAtual; toastAtual = null; clearTimeout(tToast); var t = $('toast'); if (t && !t.hidden) esconderToast(); if (a && a.aoFim) a.aoFim(); }
  function esconderToast() { var t = $('toast'); t.classList.remove('on'); setTimeout(function () { if (!toastAtual) t.hidden = true; }, semMov() ? 0 : 200); }

  // ── Registar (o «+») ──
  function abrirRegistar() {
    var ops = [];
    if (tem('ocorrencia') || !tem('diario')) ops.push(['ocorrencia', 'alerta', 'Ocorrência', 'Algo errado em obra · vai para a triagem']);
    if (tem('diario')) ops.push(['diario', 'diario', 'Diário de obra', 'Homens, trabalhos e fotos do dia']);
    if (TE && TE.disponivel()) ops.push(['tf', 'falta', 'Trabalho em falta', 'Foto, o que falta e onde']);
    if (BE && BE.disponivel()) ops.push(['bc', 'obra', 'Bloqueio do cliente', 'O que precisamos do cliente, foto e onde']);
    folha({ titulo: 'Registar', corpo: function (cc) {
      ops.forEach(function (o) {
        var extra = null;
        if (o[0] === 'ocorrencia' && A.temRascunho()) extra = el('span', 'mv-rasc', 'Rascunho');
        if (o[0] === 'diario') { var e = estadoDiarioHoje(obraHoje()); if (e.anulando) extra = el('span', 'mv-rasc', 'Anulado, por enviar'); else if (e.rascunho) extra = el('span', 'mv-rasc', 'Rascunho'); else if (e.pend) extra = el('span', 'mv-rasc', 'Por enviar'); else if (e.meu) extra = el('span', 'mv-rasc neu', 'Feito'); }
        if ((o[0] === 'tf' && TE.temRascunho()) || (o[0] === 'bc' && BE.temRascunho())) extra = el('span', 'mv-rasc', 'Rascunho');   // fecho da 2a: o «+» continua-o
        var b = linhaOp(o[1], o[2], o[3], extra); b.setAttribute('data-reg', o[0]);
        b.addEventListener('click', function () { A.fecharFolhas(true); if (o[0] === 'ocorrencia') abrir('v-registo', false, true); else if (o[0] === 'tf') TE.abrirForm(obraHoje(), { daFolha: true }); else if (o[0] === 'bc') BE.abrirForm(obraHoje(), { daFolha: true }); else abrirDiario(obraHoje(), false, true); });   // o ecrã fica no lugar da entrada da folha (abrirDeFolha do protótipo)
        cc.appendChild(b);
      });
      var emb = (TE && TE.disponivel() ? [] : ['trabalho em falta']).concat(BE && BE.disponivel() ? [] : ['bloqueio do cliente'], ['material', 'entrega e despesa']);
      if (c.externa) emb = [];   // revisão da parte 4: uma conta externa não chega a nada da fatia 2 (contrato): não se lhe promete
      if (emb.length) cc.appendChild(el('p', 'mv-folha-txt mv-embreve-f', 'Em breve: ' + emb.slice(0, -1).join(', ') + ', ' + emb[emb.length - 1] + '.'));
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
    var pend = minhaFila().filter(function (q) { return q.tipo !== 'diario-cmd' && q.obraId === ob && q.dia === hd.dia && q.estado === 'a-enviar'; }).pop() || null;
    var anul = anularPorEnviar(ob, hd.dia);   // revisão (C3): um anular por enviar: o de hoje conta como «anulado, por enviar»
    if (anul) return { meu: null, pend: null, anulando: anul, rascunho: c.rascunhos[idRascunho(ob, hd.dia)] || null };
    return { meu: D.meuDeHoje(ch, ob, hd.dia), pend: pend, rascunho: c.rascunhos[idRascunho(ob, hd.dia)] || null };
  }
  /** O anular deste dia que ainda não saiu (revisão C3). */
  function anularPorEnviar(ob, dia) { return minhaFila().filter(function (q) { return q.tipo === 'diario-cmd' && q.accao === 'anular' && q.obraId === ob && q.dia === dia && q.estado === 'a-enviar'; })[0] || null; }
  function linhaData(pre) {   // pre: o código da obra (dentro de uma obra, várias obras)
    var hd = hojeDia(), ch = cache(), p = porEnviar(), d = el('div', 'mv-hdata'), t, ama = false;
    var lido = ch.lidoEm ? Date.parse(ch.lidoEm) : 0, dados = lido ? D.textoDados(ch.lidoEm, new Date()) : '';
    if (c.lendo) t = lido ? 'a atualizar…' : 'a ler pela primeira vez…';
    else if (!online()) { t = lido ? 'sem rede · dados ' + dados : 'sem rede · ainda sem dados'; ama = true; }
    else if (!A.sessaoValida()) { t = lido ? 'sessão acabada · dados ' + dados : 'sessão acabada · ainda sem dados'; ama = true; }
    else if (!lido) t = tem('diario') ? 'ainda sem dados' : 'atualizado agora';
    else if (/^de /.test(dados)) { t = 'dados ' + dados; ama = true; }
    else t = 'atualizado às ' + dados.replace(/^das /, '');
    var txt = (pre ? pre + ' · ' : '') + D.textoDiaLongo(hd.dia) + ' · ' + t;
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
    var pn = temHojeMv() ? H.obraNaCopia(ch, ob) : null;   // fatia 2a: sem os 14 dias, os 7 da leitura do Hoje (os da obra)
    if (pn) return { s: modeloDe(pn.o).serie, obra: true, lidoEm: pn.lidoEm };
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
  /** O Hoje: o da fatia 2a (uma obra ou várias, pela leitura única) ou, sem ele no servidor, o da fatia 1. O foco fica
      onde estava (cada elemento que o pode ter leva data-k). */
  function desenharHoje() {
    var v = $('v-hoje'); if (!v) return;
    var ae = document.activeElement, k = ae && v.contains(ae) ? ae.getAttribute('data-k') : null, modo = modoHoje();
    if (modo === 'f1') desenharHojeF1(v); else desenharHojeMv(v, modo);
    if (k) { var x = v.querySelector('[data-k="' + k + '"]'); if (x) A.focar(x); }
  }
  function cabHola(v, comObra) {
    var s = sessao(), cab = el('div', 'mv-hcab'), l = el('div', 'mv-hcab-l'), h1 = el('h1', 'mv-hola', saudacao() + (s && s.nome ? ', ' + primeiroNome(s.nome) : ''));
    h1.tabIndex = -1; h1.setAttribute('data-foco-inicial', ''); h1.id = 'h-hola';
    l.appendChild(h1); cab.appendChild(l);
    if (comObra) { var ol = obraLinha(); if (ol) cab.appendChild(ol); }
    v.appendChild(cab);
    return cab;
  }
  /** As faixas do sistema (sessão acabada, sessão antiga, rascunho de outro dia, servidor por preparar). false = sem
      obras (o Hoje fica por aqui). */
  function faixasSistema(v) {
    var s = sessao(), hd = hojeDia(), p = porEnviar();
    if (!A.sessaoValida() && p.total) v.appendChild(faixaEl('ama', 'relogio', p.total + ' por enviar', '· a sessão acabou: entra outra vez para seguirem', 'Entrar', function () { A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); }, 'b-faixa-sessao'));
    if (s && !Array.isArray(s.funcionalidades)) v.appendChild(faixaEl('nav', 'atual', 'Há novidades:', 'entra outra vez para veres o diário de obra', 'Entrar', function () { A.pedirLogin('Entra outra vez para veres o diário de obra. O que tens por enviar fica guardado.'); }, 'b-faixa-novidades'));
    if (!obras().length) { v.appendChild(el('p', 'mv-nada', 'Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.')); return false; }
    Object.keys(c.rascunhos).map(function (k2) { return c.rascunhos[k2]; }).filter(function (r) { return r.contaId === contaId() && r.dia !== hd.dia; }).slice(0, 1).forEach(function (r) {   // 2.ª revisão (4)
      v.appendChild(faixaEl('neu', 'diario', 'Diário de ' + D.textoDiaCurto(r.dia) + ' por acabar', obraDe(r.obraId) ? '· ' + obraDe(r.obraId).codigo : '', 'Continuar', function () { abrirDiario(r.obraId, false, false, r.dia); }, 'b-rasc-outro'));
    });
    if (c.aviso) v.appendChild(faixaEl('neu', 'relogio', c.aviso, ''));
    return true;
  }
  function desenharHojeF1(v) {
    var entra = !c.entrou; c.entrou = true;
    limpar(v); v.removeAttribute('data-sig'); v.className = 'mv-hoje' + (entra && !semMov() ? ' entra' : '');
    var hd = hojeDia(), ch = cache();
    cabHola(v, true).appendChild(linhaData());
    var p = porEnviar();
    if (!faixasSistema(v)) return;
    var ob = obraHoje(), dia = tem('diario');
    if (dia && !ch.lidoEm && c.lendo) { v.appendChild(esqueleto()); return; }
    var e = dia ? estadoDiarioHoje(ob) : {}, util = D.diaUtil(hd.dia, feriados()), ult = dia ? D.ultimoComRegisto(ch, ob, hd.dia) : null;
    var acao = null;
    if (p.erros) acao = { ic: 'alerta', t: p.erros + (p.erros === 1 ? ' envio com erro' : ' envios com erro'), s: 'Não chegaram: vê e tenta de novo', b: 'Ver', bl: 'Ver os envios', fn: function () { abrir('v-fila'); }, erro: true };
    else if (dia && !e.meu && !e.pend && !e.anulando && util) {
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
      var est = e.anulando ? 'anulado, por enviar' : (e.meu ? '' : (e.pend ? 'por enviar' : (util ? 'hoje por fazer' : '')));
      if (est) { if (legD) leg.appendChild(document.createTextNode(' · ')); leg.appendChild(el('span', 'ama-t', est)); }
      b.appendChild(leg);
      var zv = el('span', 'mv-mos-v'); zv.appendChild(graf7(sr.s, false)); b.appendChild(zv);
      b.setAttribute('aria-label', 'Diário: ' + nD + ' ' + (legD || 'homens') + (est ? ', ' + est : '') + '. Ver os 7 dias');
      b.addEventListener('click', abrirDiario7);
      g.appendChild(b); v.appendChild(g);
    }
    if (!c.externa) v.appendChild(el('p', 'mv-embreve', 'Em breve: trabalhos em falta, material e bloqueios do cliente.'));   // a conta externa nunca os terá
  }
  // ── O Hoje da fatia 2a (hoje.js): a leitura única GET /movel/hoje ──
  // Protótipos validados: DOEX-Telemovel-App-Prototipo.html (o Hoje em Mosaico) e DOEX-Telemovel-Hoje-Todas-as-Obras-
  // Prototipo.html (variante D). Um bloco que o servidor manda a null nunca mostra números: fica «Em breve».
  function temHojeMv() { return !!H && tem('hoje') && !c.semHojeMv; }
  function obrasTodas() { var p = H ? H.copiaDe(cache(), 'todas') : null; return p ? (p.data.obras || []) : null; }
  /** 'f1' (o Hoje da fatia 1), 'uma' (uma obra) ou 'varias' (Geral · Obras: quem tem duas ou mais das suas obras). */
  function modoHoje() { if (!temHojeMv()) return 'f1'; if (obras().length > 1) { var l = obrasTodas(); if (l && l.length >= 2) return 'varias'; } return 'uma'; }
  /** A única das minhas obras (quem tem várias permitidas e só uma sua abre nela). */
  function minhaUnica() { if (!H || obras().length < 2) return ''; var l = obrasTodas(); return l && l.length === 1 && obraDe(l[0].id) ? l[0].id : ''; }
  function encarregado() { var s = sessao(); return !!(s && s.soTelemovel); }
  /** O que este telemóvel sabe do meu diário de hoje nessa obra (aceite ou na fila), para o modelo da obra. */
  function ctxObra(id) {
    var hd = hojeDia(), e = estadoDiarioHoje(id), ch = cache(), meu = null;
    if (e.meu) { var hh = (ch.hist || []).filter(function (x) { return x.obraId === id && x.dia === hd.dia && !x.soEquipas; })[0], ds = hh ? D.doeESub(hh.equipas) : { doe: e.meu.total, sub: 0 }; meu = { doe: ds.doe, sub: ds.sub }; }
    return { hoje: hd.dia, feriados: feriados(), meu: meu, pend: e.pend ? D.totalHomens(e.pend.equipas) : 0 };
  }
  function modeloDe(o) { return H.modeloObra(o, ctxObra(o.id)); }
  function desenharHojeMv(v, modo) {
    var entra = !c.entrou; c.entrou = true;
    if (modo === 'varias') desenharVarias(v, entra); else desenharUma(v, entra);
  }
  // ── Várias obras (variante D): duas páginas lado a lado, «Geral» e «Obras», com deslize com encaixe E o selector de dois
  // lugares; tocar numa obra entra nela (o mosaico só dela, «‹ Obras»), e lá dentro deslizar passa à obra seguinte. A
  // estrutura das páginas monta-se uma vez (o deslize fica onde estava); cada redesenho só enche as zonas.
  function zonaDe(v, id) { var z = $(id); if (!z) { z = el('div'); z.id = id; v.appendChild(z); } return limpar(z); }
  function desenharVarias(v, entra) {
    var copia = H.copiaDe(cache(), 'todas'), ms = (copia.data.obras || []).map(modeloDe), ord = H.ordenar(ms);
    if (c.hx.obra && !ms.some(function (m) { return m.id === c.hx.obra; })) c.hx.obra = '';
    var dentro = c.hx.obra, sig = (dentro ? 'obra|' : 'geral|') + ord.map(function (m) { return m.id; }).join(','), mesmo = v.getAttribute('data-sig') === sig && !!$('hx-pags');
    if (!mesmo) { limpar(v); v.setAttribute('data-sig', sig); v.className = 'mv-hoje hx-d' + (entra && !semMov() ? ' entra' : ''); }
    if (dentro) desenharDentro(v, ord, mesmo); else desenharGeral(v, ms, ord, copia.data.soma || {}, mesmo);
  }
  function desenharGeral(v, ms, ord, soma, mesmo) {
    var cab = zonaDe(v, 'hx-cab'), fx = zonaDe(v, 'hx-fx'), sg = zonaDe(v, 'hx-segm');
    cabHola(cab, false).appendChild(el('p', 'mv-hobra')).appendChild(el('span', null, 'Todas as obras · ' + ms.length));
    cab.firstChild.appendChild(linhaData());
    faixasSistema(fx);
    var segl = el('div', 'hx-segm-l'), seg = el('div', 'mv-segm hx-segm'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Página do Hoje');
    [['Geral', 0], ['Obras · ' + ms.length, 1]].forEach(function (x) { var b = bt('', x[0]); b.setAttribute('data-v', String(x[1])); b.setAttribute('data-k', 'seg-' + x[1]); b.addEventListener('click', function () { irPagina(x[1], true); }); seg.appendChild(b); });
    segl.appendChild(seg); segl.appendChild(pontos(2, c.hx.pag)); sg.appendChild(segl);
    var pags = $('hx-pags');
    if (!mesmo) {
      pags = el('div', 'hx-pags' + (c.hx.visto ? '' : ' espreita')); pags.id = 'hx-pags'; pags.setAttribute('data-modo', 'geral');
      ['Geral', 'Obras'].forEach(function (n, i) { var s = el('section', 'hx-pag'); s.id = 'hx-p' + i; s.setAttribute('aria-label', n); pags.appendChild(s); });
      v.appendChild(pags); ligarPags(pags);
    }
    var p0 = limpar($('hx-p0')), p1 = limpar($('hx-p1'));
    var fa = faixaAcaoMv(ms, true); if (fa) p0.appendChild(fa);
    p0.appendChild(mosaicoMv({ trabalhos: soma.trabalhos || null, cliente: soma.cliente || null }, true, ms));
    var gr = el('div', 'mv-grupo hx-grupo-d'), h = el('div', 'hx-sec-h'); h.appendChild(el('h2', null, 'Por atenção')); h.appendChild(el('span', null, 'homens hoje')); gr.appendChild(h);
    ord.forEach(function (m) { gr.appendChild(linhaObraD(m)); });
    p1.appendChild(gr);
    aplicarPag(pags, c.hx.pag);
    if (!mesmo) irPag(pags, c.hx.pag, false);
  }
  /** Uma linha por obra: código a negrito, nome, a palavra (só o mais grave), os 7 dias em miniatura, os homens de hoje. */
  function linhaObraD(m) {
    var w = H.palavra(m), b = bt('hx-ob hx-rica'); b.setAttribute('data-k', 'ob-' + m.id); b.setAttribute('data-obra', m.id);
    b.setAttribute('aria-label', m.codigo + ' ' + m.nome + ': ' + (m.tem ? m.homensHoje + ' homens hoje' : 'sem diário hoje') + ', ' + w.t + (m.problema === 'semResposta' ? ' do cliente' : '') + '. Entrar na obra');
    var t = el('span', 'hx-ob-t'), nb = el('b'); nb.appendChild(el('code', null, m.codigo)); nb.appendChild(document.createTextNode(m.nome)); t.appendChild(nb); t.appendChild(el('small', w.cls, w.t)); b.appendChild(t);
    var mini = el('span', 'hx-mini'); mini.setAttribute('aria-hidden', 'true');
    var max = Math.max(8, Math.max.apply(null, m.serie.map(function (x) { return x.total; })));
    m.serie.forEach(function (x) {
      var col = el('i', x.fds || x.feriado ? 'fds' : null);
      if (x.tem) { var d = el('i', 'doe'); d.style.height = (x.doe / max * 100).toFixed(1) + '%'; var s = el('i', 'sub'); s.style.height = (x.sub / max * 100).toFixed(1) + '%'; col.appendChild(d); col.appendChild(s); }
      else if (x.hoje && (m.porFazer || m.pend)) { var p = el('i', 'por'); p.style.height = '45%'; col.appendChild(p); }
      mini.appendChild(col);
    });
    b.appendChild(mini);
    var n = el('span', 'hx-num' + (m.tem ? '' : ' nada')); n.appendChild(el('b', null, m.tem ? String(m.homensHoje) : '–')); n.appendChild(el('small', null, 'hoje')); b.appendChild(n);
    b.appendChild(ic('chev'));
    b.addEventListener('click', function () { entrarObra(m.id); });
    return b;
  }
  function pontos(n, at) { var s = el('span', 'hx-pontos'); s.setAttribute('aria-hidden', 'true'); for (var i = 0; i < n; i++) s.appendChild(el('i', i === at ? 'on' : null)); return s; }
  /** Dentro de uma obra: uma página por obra (pela ordem da página Obras), lado a lado; «1 de 3» por baixo. */
  function desenharDentro(v, ord, mesmo) {
    var fx = zonaDe(v, 'hx-fx'); faixasSistema(fx);
    var pags = $('hx-pags');
    if (!mesmo) {
      pags = el('div', 'hx-pags'); pags.id = 'hx-pags'; pags.setAttribute('data-modo', 'obra'); pags.setAttribute('aria-roledescription', 'carrossel'); pags.setAttribute('aria-label', 'Obras');
      ord.forEach(function (m, i) { var s = el('section', 'hx-pag'); s.setAttribute('data-id', m.id); s.setAttribute('aria-label', m.codigo + ', ' + (i + 1) + ' de ' + ord.length); pags.appendChild(s); });
      v.appendChild(pags); ligarPags(pags);
      var pb = el('div', 'hx-pontos-b'); pb.id = 'hx-pontos-b'; v.appendChild(pb);
    }
    var at = 0;
    Array.prototype.forEach.call(pags.children, function (s, i) {
      var m = ord[i]; if (m.id === c.hx.obra) at = i;
      limpar(s);
      var cab = el('div', 'mv-hcab'), vb = bt('hx-volta'); vb.appendChild(ic('chevE')); vb.appendChild(document.createTextNode('Obras')); vb.setAttribute('data-k', 'volta-' + m.id); vb.setAttribute('aria-label', 'Voltar às obras');
      vb.addEventListener('click', sairObra); cab.appendChild(vb);
      var l = el('div', 'mv-hcab-l'), h1 = el('h1', 'mv-hola', m.nome); h1.tabIndex = -1; h1.id = 'h-hola-' + i; l.appendChild(h1); cab.appendChild(l);
      cab.appendChild(linhaData(m.codigo)); s.appendChild(cab);
      var fa = faixaAcaoMv([m], false, m.id === c.hx.obra); if (fa) s.appendChild(fa);
      s.appendChild(mosaicoMv(m, false));
      s.querySelectorAll('[data-k]').forEach(function (x) { if (!/^volta-/.test(x.getAttribute('data-k'))) x.setAttribute('data-k', x.getAttribute('data-k') + '@' + m.id); });   // um por página (o foco volta ao mesmo)
    });
    aplicarPag(pags, at);
    if (!mesmo) irPag(pags, at, false);
  }
  /** A página que se vê: as outras ficam inert (nem o leitor de ecrã nem o Tab lá chegam); o selector e os pontos. */
  function aplicarPag(pags, i) {
    var ss = pags.children, obra = pags.getAttribute('data-modo') === 'obra';
    Array.prototype.forEach.call(ss, function (s, k) { if (k === i) s.removeAttribute('inert'); else s.setAttribute('inert', ''); var h = s.querySelector('.mv-hola'); if (h) { if (k === i) h.setAttribute('data-foco-inicial', ''); else h.removeAttribute('data-foco-inicial'); } });
    if (obra) {
      var h1 = ss[i] && ss[i].querySelector('.mv-hola'); if (h1) $('v-hoje').setAttribute('aria-labelledby', h1.id);
      var pb = $('hx-pontos-b'); if (pb) { limpar(pb); if (ss.length <= 10) pb.appendChild(pontos(ss.length, i)); pb.appendChild(el('span', 'hx-pontos-t', (i + 1) + ' de ' + ss.length + ' · desliza para a obra ao lado')); }
    } else {
      $('v-hoje').setAttribute('aria-labelledby', 'h-hola');
      Array.prototype.forEach.call(document.querySelectorAll('.hx-segm button'), function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-v')) === i)); });
      Array.prototype.forEach.call(document.querySelectorAll('.hx-segm-l .hx-pontos i'), function (d, k) { d.className = k === i ? 'on' : ''; });
    }
  }
  function irPag(pags, i, suave) {
    var alvo = pags.children[i]; if (!alvo) return;
    var x = alvo.offsetLeft - pags.firstElementChild.offsetLeft;
    if (typeof pags.scrollTo === 'function') pags.scrollTo({ left: x, behavior: suave && !semMov() ? 'smooth' : 'auto' }); else pags.scrollLeft = x;
  }
  function indicePag(pags) {
    var x = pags.scrollLeft, i = 0, melhor = 1e9, o0 = pags.firstElementChild ? pags.firstElementChild.offsetLeft : 0;
    Array.prototype.forEach.call(pags.children, function (s, k) { var d = Math.abs(s.offsetLeft - o0 - x); if (d < melhor) { melhor = d; i = k; } });
    return i;
  }
  /** O deslize: quando pára (o encaixe acabou), a página que se vê passa a ser a actual. */
  function ligarPags(pags) {
    var t = null;
    pags.addEventListener('scroll', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        if (!pags.isConnected) return;
        var i = indicePag(pags);
        if (pags.getAttribute('data-modo') === 'geral') { if (i !== c.hx.pag) { c.hx.pag = i; if (i === 1) c.hx.visto = true; } aplicarPag(pags, i); return; }
        var s = pags.children[i], id = s && s.getAttribute('data-id');
        if (id && id !== c.hx.obra) { c.hx.obra = id; c.obraHoje = id; try { history.replaceState(Object.assign({}, history.state || {}, { hxObra: id }), ''); } catch (e) { /* nada */ } }
        aplicarPag(pags, i);
      }, 90);
    }, { passive: true });
  }
  /** Geral ou Obras (o selector, o bloco Diário do Geral): o deslize nunca é a única maneira. */
  function irPagina(i, suave) {
    c.hx.pag = i; if (i === 1) c.hx.visto = true;
    var pags = $('hx-pags'); if (!pags || pags.getAttribute('data-modo') !== 'geral') return;
    aplicarPag(pags, i); irPag(pags, i, suave);
  }
  function entrarObra(id) {
    c.hx.y = window.scrollY || 0; c.hx.obra = id; c.obraHoje = id;
    c.pilha.push('v-hoje');
    try { history.pushState({ mvV: 'v-hoje', n: c.pilha.length, hxObra: id }, ''); } catch (e) { /* sem histórico */ }
    desenharHoje(); window.scrollTo(0, 0);
    var h = document.querySelector('#hx-pags > .hx-pag:not([inert]) .mv-hola'); if (h) A.focar(h);
  }
  /** «‹ Obras» e o gesto voltar: a página Obras, na mesma posição, com o foco na obra de onde se veio. */
  function sairObra() { if (history.state && history.state.hxObra && c.pilha.length > 1) { try { history.back(); return; } catch (e) { /* segue */ } } sairObraJa(); }
  function sairObraJa() {
    var id = c.hx.obra; c.hx.obra = ''; c.hx.pag = 1; c.hx.visto = true;
    if (c.pilha.length > 1 && c.pilha[c.pilha.length - 1] === 'v-hoje' && c.pilha[c.pilha.length - 2] === 'v-hoje') c.pilha.pop();
    try { if (history.state && history.state.hxObra) history.replaceState({ mvV: 'v-hoje', n: c.pilha.length }, ''); } catch (e) { /* nada */ }
    desenharHoje(); window.scrollTo(0, c.hx.y || 0);
    var b = document.querySelector('#hx-p1 [data-obra="' + id + '"]'); if (b) A.focar(b);
  }
  /** O Hoje de uma obra (quem tem só uma, ou a escolhida no selector). */
  function desenharUma(v, entra) {
    limpar(v); v.removeAttribute('data-sig'); v.className = 'mv-hoje' + (entra && !semMov() ? ' entra' : '');
    cabHola(v, true).appendChild(linhaData());
    if (!faixasSistema(v)) return;
    var ob = obraHoje(), x = ob ? H.obraNaCopia(cache(), ob) : null;
    if (!x) { v.appendChild(c.lendo || (online() && A.sessaoValida()) ? esqueletoMv() : el('p', 'mv-nada', 'Ainda não tenho o Hoje desta obra neste telemóvel: aparece quando houver rede.')); return; }
    var m = modeloDe(x.o), fa = faixaAcaoMv([m], false); if (fa) v.appendChild(fa);
    v.appendChild(mosaicoMv(m, false));
    var ba = v.querySelector('[data-k="acao"]'), bd = v.querySelector('[data-k="mos-diario"]');   // uma página só: os ids de sempre
    if (ba) ba.id = 'b-acao'; if (bd) bd.id = 'b-diario7';
  }
  /** A faixa de acção, pela precedência do protótipo: envios com erro; diário por fazer (de uma obra, ou quantas faltam);
      dentro de uma obra, o bloqueio do cliente por confirmar (só quem o pode confirmar, pelo `pode` do servidor: bloqueios-ecra.js).
      visivel: a obra que está à vista (só essa lê a lista dos bloqueios em segundo plano). */
  function faixaAcaoMv(ms, geral, visivel) {
    var p = porEnviar(), hd = hojeDia(), acao = null;
    if (p.erros) acao = { ic: 'alerta', t: p.erros + (p.erros === 1 ? ' envio com erro' : ' envios com erro'), s: 'Não chegaram: vê e tenta de novo', b: 'Ver', bl: 'Ver os envios', fn: function () { abrir('v-fila'); }, erro: true };
    else if (geral) {
      var pf = H.porFazer(ms);
      if (pf.length) acao = { ic: 'diario', t: pf.length + (pf.length === 1 ? ' diário por fazer' : ' diários por fazer'), s: pf.map(function (m) { return m.codigo; }).join(' · '), b: 'Fazer', bl: 'Escolher a obra do diário por fazer', fn: function () { folhaPorFazer(pf.map(function (m) { return m.id; })); } };
    } else if (ms[0].porFazer && !estadoDiarioHoje(ms[0].id).anulando) {
      var m = ms[0], e = estadoDiarioHoje(m.id), u = H.ultimoDia(m.serie), uh = u ? null : D.ultimoComRegisto(cache(), m.id, hd.dia);
      if (!u && uh) { var su = D.doeESub(uh.equipas); u = { dia: uh.dia, total: su.doe + su.sub, doe: su.doe }; }
      acao = { ic: 'diario', t: e.rascunho ? 'Diário por acabar' : 'Diário por fazer', s: u ? (D.difDias(u.dia, hd.dia) === 1 ? 'Ontem' : 'A ' + D.textoDiaMes(u.dia)) + ': ' + D.txtHomens(u.total) + ' · ' + u.doe + ' DOE' : 'Sem diário nos últimos 7 dias', b: e.rascunho ? 'Continuar' : 'Fazer', bl: 'Fazer o diário', fn: function () { abrirDiario(m.id); } };
    }
    if (!acao && !geral && BE && !encarregado()) {   // uma conta só de telemóvel nunca confirma (não é GP nem DO): nem se lê a lista
      var m1 = ms[0], pc = BE.porConfirmarParaMim(m1.id, m1.cliente && m1.cliente.porConfirmar, visivel !== false);
      // o título do protótipo («Bloqueio do cliente por confirmar») encurtado: a 390 px cortava
      if (pc) acao = { ic: 'falta', t: 'Bloqueio por confirmar', s: 'Do cliente: ' + pc.precisa, b: 'Ver', bl: 'Ver e confirmar o bloqueio do cliente', fn: function () { BE.abrirBc(pc.id, m1.id); } };
    }
    if (!acao) return null;
    var fa = el('div', 'mv-facao' + (acao.erro ? ' erro' : '')); fa.style.setProperty('--i', '0');
    var fi = el('span', 'mv-facao-ic'); fi.appendChild(ic(acao.ic)); fa.appendChild(fi);
    var ft = el('span', 'mv-facao-t'); ft.appendChild(el('b', null, acao.t)); ft.appendChild(el('small', null, acao.s)); fa.appendChild(ft);
    var fb = bt('mv-facao-b', acao.b); fb.setAttribute('aria-label', acao.bl); fb.setAttribute('data-k', 'acao'); fb.addEventListener('click', acao.fn); fa.appendChild(fb);
    return fa;
  }
  function pecas(box, l) { (l || []).forEach(function (x, i) { if (i) box.appendChild(document.createTextNode(' · ')); if (x.cls) box.appendChild(el('span', x.cls, x.t)); else box.appendChild(document.createTextNode(x.t)); }); return box; }
  function blocoBase(k, nomeIc, rot, est, i) {
    var b = bt('mv-mos'); b.style.setProperty('--i', String(i)); b.setAttribute('data-k', 'mos-' + k);
    var top = el('span', 'mv-mos-t'); top.appendChild(ic(nomeIc)); top.appendChild(el('span', 'mv-mos-l', rot));
    if (est) { var pt = el('i', 'mv-ponto ' + est); pt.setAttribute('aria-hidden', 'true'); top.appendChild(pt); }
    b.appendChild(top); return b;
  }
  /** O mosaico: Diário, Trabalhos, Cliente e Material (2b) por vir. Os blocos por vir ficam no fim, na ordem do protótipo;
      o arranjo é a grelha 2 × 2 validada (o que está vivo ocupa os primeiros lugares, na ordem de leitura). */
  function mosaicoMv(m, geral, ms) {
    var g = el('div', 'mv-mosg'), i = 1, emb = [], hd = hojeDia();
    var bd = geral ? H.blocoDiarioGeral(ms, hd.dia, feriados()) : H.blocoDiario(m, null), serie = geral ? bd.serie : m.serie;
    var b = blocoBase('diario', 'diario', 'Diário', bd.est, i++);
    b.appendChild(el('span', 'mv-mos-n' + (bd.nada ? ' nada' : ''), bd.n));
    b.appendChild(pecas(el('span', 'mv-mos-c'), bd.leg));
    var zv = el('span', 'mv-mos-v'); zv.appendChild(graf7(serie, false)); b.appendChild(zv);
    b.setAttribute('aria-label', 'Diário' + (geral ? ' de todas as obras' : '') + ': ' + bd.n + ' ' + bd.leg.map(function (x) { return x.t; }).join(', ') + (geral ? '. Ver as obras' : '. Ver os 7 dias'));
    b.addEventListener('click', geral ? function () { irPagina(1, true); } : abrirDiario7);
    g.appendChild(b);
    var t = H.blocoTrabalhos(geral ? (m && m.trabalhos) : m.trabalhos), cl = H.blocoCliente(geral ? (m && m.cliente) : m.cliente, hd.dia, encarregado());
    var sub = geral ? 'Todas as obras · ' + ms.length : (m.codigo ? m.codigo + ' · ' : '') + m.nome;
    if (t) {
      var bt2 = blocoBase('trabalhos', 'falta', 'Trabalhos', t.est, i++);
      bt2.appendChild(el('span', 'mv-mos-n', t.n)); bt2.appendChild(el('span', 'mv-mos-c', t.leg));
      var zt = el('span', 'mv-mos-v'); if (t.segs.length) zt.appendChild(barra20(t.segs));
      t.caps.forEach(function (l) { zt.appendChild(pecas(el('span', 'mv-mos-cap'), l)); }); bt2.appendChild(zt);
      bt2.setAttribute('aria-label', TE && TE.disponivel() ? t.aria.replace(/\. Ver por estado$/, '. Ver a lista') : t.aria);
      bt2.addEventListener('click', function () { if (TE && TE.disponivel()) { if (geral) TE.folhaObras(ms); else TE.abrirLista(m.id); return; } folhaTrabalhos(geral ? m.trabalhos : m.trabalhos, sub, geral ? ms : null); });   // a lista por Localização (parte 2); sem ela, os números
      g.appendChild(bt2);
    } else emb.push(['trabalhos', 'falta', 'Trabalhos', 'Os trabalhos em falta']);
    emb.push(['material', 'caixa', 'Material', 'O material pedido e as entregas em obra']);
    if (cl) {
      var bc = blocoBase('cliente', 'obra', 'Cliente', cl.est, i++);
      bc.appendChild(el('span', 'mv-mos-n', cl.n)); bc.appendChild(el('span', 'mv-mos-c', cl.leg));
      var zc = el('span', 'mv-mos-v'); if (cl.tl) zc.appendChild(linhaTempo(cl.tl)); zc.appendChild(pecas(el('span', 'mv-mos-cap'), [cl.cap])); bc.appendChild(zc);
      bc.setAttribute('aria-label', cl.aria.replace(/\. Ver por estado$/, '. Ver a lista'));
      bc.addEventListener('click', function () {   // a lista dos bloqueios da obra (parte 3); com várias obras, primeiro a obra
        if (BE && BE.disponivel()) { if (geral) BE.folhaObras(ms); else BE.abrirLista(m.id); return; }
        toast((BE && BE.motivoFora()) || 'Os bloqueios do cliente vêem-se com ligação ao servidor.', { ms: 4000 });
      });
      g.appendChild(bc);
    } else emb.push(['cliente', 'obra', 'Cliente', 'Os bloqueios do cliente']);
    emb.forEach(function (e) {
      var be = blocoBase(e[0], e[1], e[2], '', i++); be.classList.add('embreve'); be.setAttribute('aria-disabled', 'true');
      be.appendChild(el('span', 'mv-mos-c', 'Em breve')); be.setAttribute('aria-label', e[2] + ': em breve');
      be.addEventListener('click', function () { toast(e[3] + ' chegam em breve a este telemóvel.'); });
      g.appendChild(be);
    });
    return g;
  }
  /** Barra alta com os números dentro: atrasados, bloqueados (com trama), por fazer, por planear. */
  function barra20(segs) {
    var w = el('span', 'mv-b20'); w.setAttribute('role', 'img'); w.setAttribute('aria-label', segs.map(function (x) { return x[1] + ' ' + x[2]; }).join(', '));
    segs.forEach(function (x) { var i = el('i', x[0]); i.style.flex = String(x[1]); i.appendChild(el('b', null, String(x[1]))); w.appendChild(i); });
    return w;
  }
  /** A linha de tempo do cliente (2 semanas até hoje): um ponto por bloqueio (hoje.js linhaTempo), com a idade do mais
      antigo por cima dele. */
  function linhaTempo(tl) {
    var w = el('span', 'mv-tl7'); w.setAttribute('role', 'img'); w.setAttribute('aria-label', tl.aria || ('O bloqueio do cliente mais antigo tem ' + tl.dias + (tl.dias === 1 ? ' dia' : ' dias')));
    var a = el('span', 'mv-tl7-a'), at = function (x) { return 'calc((100% - var(--mv-tl7-p)) * ' + x.toFixed(3) + ')'; };
    (tl.pontos || [{ x: tl.x, c: 'cin', r: 0 }]).forEach(function (p, i) { var q = el('i', p.c); q.style.left = at(p.x); q.style.bottom = 'calc(var(--mv-tl7-p) * 1.25 * ' + (p.r || 0) + ' + var(--e2))'; q.style.setProperty('--i', String(i)); a.appendChild(q); });
    var vv = el('span', 'mv-tl7-v', tl.rot); vv.style.left = at(tl.x); a.appendChild(vv); w.appendChild(a);
    var d = el('span', 'mv-tl7-d'); d.setAttribute('aria-hidden', 'true'); ['2 sem.', '1 sem.', 'hoje'].forEach(function (t) { d.appendChild(el('span', null, t)); }); w.appendChild(d);
    return w;
  }
  /** A folha dos números de Trabalhos (só sem os ecrãs dos trabalhos): os números por estado (somam o do bloco) e, no
      Geral, por obra. O bloco Cliente abre sempre a lista dos bloqueios (bloqueios-ecra.js); a folha dele saiu (parte 3). */
  function linhaN(rot, n, cls, sub) {
    var d = el('div', 'mv-rl'), s = el('span', null, rot); if (sub) s.appendChild(el('small', null, sub)); d.appendChild(s);
    d.appendChild(el('b', cls || null, String(n))); return d;
  }
  function folhaNumeros(o) {
    folha({ titulo: o.titulo, sub: o.sub, corpo: function (cc) {
      cc.appendChild(linhaN(o.rotTotal, o.total, 'mv-rl-tot'));
      o.linhas.forEach(function (l) { cc.appendChild(linhaN(l.rot, l.n, l.n ? l.cls : '', l.sub)); });
      (o.extra || []).forEach(function (x) { cc.appendChild(x); });
      if (o.porObra && o.porObra.length > 1) { cc.appendChild(el('p', 'mv-lh', 'Por obra')); o.porObra.forEach(function (x) { cc.appendChild(linhaN(x.rot, x.n)); }); }
      cc.appendChild(el('p', 'mv-folha-txt', 'A lista chega na próxima versão.'));
    } });
  }
  function folhaTrabalhos(t, sub, ms) {
    var L = H.linhasTrabalhos(t);
    folhaNumeros({ titulo: 'Trabalhos em falta', sub: sub, rotTotal: 'Em falta', total: L.total, linhas: L.linhas,
      extra: [el('p', 'mv-lh', 'Esta semana'), linhaN('Feitos desde segunda', L.feitosSemana)],
      porObra: ms ? ms.map(function (m) { return { rot: m.codigo + ' · ' + m.nome, n: m.trabalhos ? m.trabalhos.abertos : 0 }; }) : null });
  }
  /** «Diário por fazer»: um toque em cada obra abre o diário dela (as mesmas obras que o número da faixa). */
  function folhaPorFazer(ids) {
    var ms = (obrasTodas() || []).filter(function (o) { return ids.indexOf(o.id) >= 0; }).map(modeloDe).filter(function (m) { return m.porFazer; });
    folha({ titulo: 'Diário por fazer', sub: 'Um toque em cada obra', corpo: function (cc) {
      ms.forEach(function (m) {
        var b = bt('mv-lo mv-lo-ir'); b.setAttribute('data-obra', m.id);
        var n = el('span', 'mv-lo-n', m.nome); n.appendChild(el('small', null, H.ultimoTexto(m)));
        junta(b, el('code', null, m.codigo), n, ic('chev'));
        b.addEventListener('click', function () { A.fecharFolhas(true); abrirDiario(m.id, false, true); });
        cc.appendChild(b);
      });
    } });
  }
  /** A primeira leitura: a forma dos quatro blocos, parada. */
  function esqueletoMv() {
    var g = el('div', 'mv-mosg'); g.setAttribute('aria-hidden', 'true');
    for (var k = 0; k < 4; k++) {
      var b = el('div', 'mv-mos sk'), t = el('span', 'mv-mos-t'); t.appendChild(el('i', 'mv-sk w50')); b.appendChild(t);
      b.appendChild(el('i', 'mv-sk num')); b.appendChild(el('i', 'mv-sk leg w70'));
      var z = el('span', 'mv-mos-v'); z.appendChild(el('i', 'mv-sk graf w100')); z.appendChild(el('i', 'mv-sk w60')); b.appendChild(z);
      g.appendChild(b);
    }
    return g;
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
          if (ctx === 'hoje' && temHojeMv()) { c.obraHoje = o.id; lsGravar(LS_OBRA_HOJE, o.id); desenharHoje(); if (!H.obraNaCopia(cache(), o.id) || online()) lerPainelObra(o.id); lerObraAgora(o.id); }   // só a leitura dessa obra
          else if (ctx === 'hoje') { c.obraHoje = o.id; lsGravar(LS_OBRA_HOJE, o.id); desenharHoje(); ler(true); }
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
    if (TE) TE.gravarRascunhoJa(); if (BE) BE.gravarRascunhoJa();   // fecho da 2a: os do trabalho em falta e do bloqueio do cliente, nos mesmos momentos
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
    folha({ titulo: 'Diário de ' + D.textoDiaCurto(dia), sub: 'Já foi enviado e já não se corrige', corpo: function (cc) {
      cc.appendChild(el('p', 'mv-folha-txt', 'Já há um diário enviado deste dia, e já não se corrige: quem o fez corrige e anula até 7 dias depois do dia. Depois, só o DO ou o GP. O que ficou neste rascunho não pode entrar.'));
    }, pe: function (pp) { var b = bt('mv-btn', 'Deitar fora o rascunho'); b.id = 'b-rasc-fora'; b.addEventListener('click', function () { apagarRascunho(ob, dia); fecharFolha(); redesenhar(); }); pp.appendChild(b); } });
  }
  /** Revisão (C3): o diário deste dia tem um anular por enviar: não se abre por cima (seria um registo novo, sem as fotos do
      servidor). Desfaz-se o anular primeiro, se ainda não saiu. */
  function folhaAnulando(q) {
    var saiu = !!(q.tentou || (c.emCurso && c.atual === q.id));
    folha({ titulo: 'Diário de ' + D.textoDiaCurto(q.dia), sub: 'Anulado, por enviar', corpo: function (cc) {
      cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', saiu ? 'O anular deste diário pode já ter seguido. Quando o servidor responder, voltas a poder fazer o diário deste dia.' : 'O anular deste diário ainda não saiu do telemóvel. Para o corrigir, desfaz primeiro o anular.'));
    }, pe: saiu ? null : function (p) { var b = bt('mv-btn', 'Desfazer o anular'); b.id = 'b-desf-anular'; b.addEventListener('click', function () {
      if (q.tentou || (c.emCurso && c.atual === q.id) || c.fila.indexOf(q) < 0) { fecharFolha(); toast('O anular pode já ter seguido: vê o «Por enviar».', { ms: 4000 }); return; }   // revisão (A1): decide-se no clique
      largarToastDe(q.id); c.fila = c.fila.filter(function (x) { return x !== q; }); apagarItem(q.id); fecharFolha(); toast('O anular saiu da fila: o diário fica como estava', { ms: 3000 }); redesenhar(); }); p.appendChild(b); } });
  }
  /** Revisão (P4): um dia passado aberto sem rede: o que este telemóvel leu (a cópia), sem acções. */
  function folhaDiaSemRede(ob, dia, cop, motivo) {
    folha({ titulo: 'Diário de ' + D.textoDiaCurto(dia), sub: (obraDe(ob) || {}).codigo || '', corpo: function (cc) {
      if (cop && Array.isArray(cop.equipas)) { cop.equipas.forEach(function (e) { cc.appendChild(rlinha(e.nome, String(e.homens))); }); if (cop.texto) cc.appendChild(el('p', 'mv-desc', cop.texto)); }
      cc.appendChild(el('p', 'mv-folha-txt', motivo || 'Sem rede: as acções voltam com rede.'));
    } });
  }
  function apagarRascunho(ob, dia) { var id = idRascunho(ob, dia); clearTimeout(tRasc); tRasc = null; delete c.rascunhos[id]; apagarItem(id); }

  // ── Diário de obra: o formulário ──
  async function abrirDiario(ob, substituir, daFolha, diaPedido, semRascunho) {
    if (!ob) { toast('Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.'); return; }
    var hd0 = hojeDia(), outroDia = !!diaPedido && diaPedido !== hd0.dia;
    if (!outroDia) await lerObraAgora(ob);   // com rede lê sempre o registo: é ele que diz o que se conhece (A1)
    if (!cache().locs[ob]) lerLocsAgora(ob).then(function () { if (c.vista === 'v-diario') zona('locs'); });
    // 13 nov 2026 (liberdade de corrigir): um dia passado lê-se com rede (o meu registo desse dia, com o `pode`)
    var lido = outroDia ? await lerDiaAgora(ob, diaPedido) : null;
    var ch = cache(), hd = outroDia ? { dia: diaPedido } : hojeDia(), k = D.chaveDia(ob, hd.dia), o = ch.obras[ob];
    var rasc = semRascunho ? null : c.rascunhos[idRascunho(ob, hd.dia)];
    var anul = anularPorEnviar(ob, hd.dia);
    if (anul) { folhaAnulando(anul); return; }   // revisão (C3): por cima de um anular por enviar não se abre um registo novo
    // revisão (P5): conta a por enviar e a parada por corrigir (a pessoa muda e guarda); nunca a parada por dia fechado ou
    // anulado (não se corrige). Revisão (C7): uma com fotos com ficheiro abre-se sempre a partir dela (senão perdiam-se).
    var pend = minhaFila().filter(function (q) { return q.tipo === 'diario' && q.obraId === ob && q.dia === hd.dia && (q.estado === 'a-enviar' || (q.estado === 'parado' && q.motivo === 'corrigir')); }).pop();
    var pendComFicheiro = !!(pend && (pend.fotos || []).some(function (f) { return !!f.blob; }));
    var meuDia = null;   // o meu registo de um dia passado que ainda se corrige (o `pode` do servidor, ou da cópia sem rede)
    if (outroDia && !pend) {   // revisão (P5): com uma correcção na fila, abre-se a partir dela (como hoje), nunca do servidor
      var cop = ch.registos[k] || null;
      var jaHa = lido ? !!lido.meu : (!!cop || ch.versoes[ch.ids[k]] != null || (ch.hist || []).some(function (x) { return x.obraId === ob && x.dia === hd.dia && !x.soEquipas; }));
      var reg = lido ? lido.meu : cop;
      if (jaHa && !lido) { folhaDiaSemRede(ob, hd.dia, cop, !online() ? 'Sem rede: as acções voltam com rede.' : (!A.sessaoValida() ? 'A sessão acabou: entra outra vez para corrigir ou anular.' : 'Não consegui ler este dia agora: tenta daqui a pouco.')); return; }   // revisão (P4): sem rede, a leitura da cópia, sem acções
      if (jaHa && !(reg && D.podeNoRegisto(reg, 'corrigir'))) { folhaRascunhoFechado(ob, hd.dia); return; }
      if (jaHa) meuDia = Object.assign({}, reg, { dia: reg.dia || hd.dia });
    }
    var meu = outroDia ? meuDia : (o && o.dia === hd.dia && o.lidoEm ? o.meu : null);
    var id = D.idRegistoDe(ch, ob, hd.dia, meu, function () { return M.novoId(); });
    var form;
    if (outroDia && pend) form = null;   // revisão (P5): o ramo da fila, abaixo
    else if (outroDia && meuDia) form = D.formDiario({ obraId: ob, dia: hd.dia, meu: meuDia });   // corrigir um dia passado (dentro da janela, ou o GP/DO)
    else if (outroDia && !pend) form = D.formDiario({ obraId: ob, dia: hd.dia, ultimo: null, registoId: id });   // entra como registo novo atrasado (até 7 dias); com o id de um anulado, repõe-no
    else if (meu && !outroDia && !pendComFicheiro) form = D.formDiario({ obraId: ob, dia: hd.dia, meu: meu });
    if (!form && pend) {   // o que está na fila é o mais recente: corrige-se a partir dele (o que ele omitia continua desconhecido)
      var om = pend.omitir || {}, reg = ch.registos[k] || null;
      form = D.formDiario({ obraId: ob, dia: hd.dia, meu: { id: pend.registoId, dia: pend.dia, versao: pend.versaoBase, equipas: pend.equipas, texto: om.texto && reg ? reg.texto : pend.texto, localizacoes: om.localizacoes ? (reg && reg.conhecido.localizacoes ? reg.localizacoes : []) : pend.localizacoes, fotos: [],
        conhecido: { texto: !om.texto || !!(reg && reg.conhecido.texto), localizacoes: !om.localizacoes || !!(reg && reg.conhecido.localizacoes), fotos: !om.fotos } } });
      form.fotos = pend.fotos.filter(function (f) { return f.estado !== 'sem-lugar' && f.estado !== 'fora-de-prazo'; }).map(function (f) { return f.blob ? { n: f.n, nPedido: f.n, estado: 'nova', blob: f.blob, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho } : { n: f.n, estado: 'servidor', estadoServidor: 'por-arquivar', sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; });
      form.nMax = D.proximoN(form) - 1;
      form.versaoBase = ch.versoes[pend.registoId] != null ? ch.versoes[pend.registoId] : pend.versaoBase;
      if (meu && meu.fotos && !outroDia) (meu.fotos || []).forEach(function (sf) { var x = form.fotos.filter(function (f) { return f.n === sf.n && f.estado === 'servidor'; })[0]; if (x) x.pode = Array.isArray(sf.pode) ? sf.pode.slice() : []; });   // o `pode` de cada foto, do servidor
    } else if (form) { /* já escolhido acima */ } else if (ch.registos[k] && ch.registos[k].versao) form = D.formDiario({ obraId: ob, dia: hd.dia, meu: ch.registos[k] });   // a cópia do último aceite (sem rede)
    else if (ch.versoes[id] != null) {   // existe no servidor, mas este telemóvel não tem o conteúdo: só as equipas (A1)
      var h = (ch.hist || []).filter(function (x) { return x.obraId === ob && x.dia === hd.dia; })[0];
      form = D.formDesconhecido({ obraId: ob, dia: hd.dia, registoId: id, versao: ch.versoes[id], equipas: h ? h.equipas : [] });
    } else {
      var ultimo = o && o.ultimo ? o.ultimo : null, uh = D.ultimoComRegisto(ch, ob, hd.dia);
      if (!ultimo && uh) ultimo = { dia: uh.dia, equipas: uh.equipas };
      form = D.formDiario({ obraId: ob, dia: hd.dia, ultimo: ultimo, registoId: id });
    }
    c.avisoRascunho = null;
    // revisão (C6): as fotos com um tirar desta conta por enviar continuam «a tirar…»
    minhaFila().filter(function (q) { return q.tipo === 'diario-cmd' && q.accao === 'foto-tirar' && q.registoId === (form.registoId || id) && q.estado === 'a-enviar'; }).forEach(function (q) { (form.fotos || []).forEach(function (f) { if (f.n === q.n && f.estado === 'servidor') f.aTirar = true; }); });
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
  var ZONAS = ['obra', 'hom', 'fez', 'locs', 'fotos', 'anular'];
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
    ({ obra: zonaObra, hom: zonaHomens, fez: zonaFez, locs: zonaLocs, fotos: zonaFotos, anular: zonaAnular })[z](box);
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
    if (o) { if (o.codigo) oc.appendChild(el('code', null, o.codigo)); oc.appendChild(el('span', null, f.corrigir ? (f.dia === hd.dia ? 'o teu diário de hoje' : 'o teu diário de ' + D.textoDiaCurto(f.dia)) : (f.baseDia ? 'a de ' + D.quandoFoi(f.baseDia, hd.dia).replace(/^a /, '') : 'a última que usaste'))); ot.appendChild(oc); ot.appendChild(el('span', 'mv-obra-n', o.nome)); }
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
  /** «Anular este diário» no fundo do formulário de um registo que já está no servidor: só com o `pode` dele. */
  function zonaAnular(box) {
    var f = c.form; if (!f || !f.corrigir || !D.podeNoRegisto(f, 'anular')) return;
    var b = bt('mv-link mv-link-tirar mv-link-anular'); b.id = 'b-dia-anular'; b.setAttribute('data-k', 'anular'); b.appendChild(ic('lixo')); b.appendChild(document.createTextNode('Anular este diário'));
    b.addEventListener('click', function () { folhaAnularDiario({ obraId: f.obraId, dia: f.dia, id: f.registoId, versao: f.versaoBase }); });
    box.appendChild(b);
  }
  /** Anular pede confirmação; depois vai à fila como comando, com Desfazer de 5 s (nada sai se a pessoa desfizer); sem rede
      segue quando houver rede. */
  function folhaAnularDiario(r) {
    folha({ titulo: 'Anular o diário de ' + D.textoDiaCurto(r.dia) + '?', sub: (obraDe(r.obraId) || {}).codigo || '', corpo: function (cc) {
      cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', 'Deixa de contar nos homens da obra. As fotos que ainda não estão nos documentos da obra saem.'));
      cc.appendChild(el('p', 'mv-folha-txt', 'Enquanto o puderes corrigir, voltas a fazer o diário deste dia.' + (online() ? '' : ' Sem rede: segue quando houver rede.')));
    }, pe: function (p) {
      var b = bt('mv-btn neg', 'Anular o diário'); b.id = 'b-dia-anular-ok';
      b.addEventListener('click', function () { fecharFolha(); anularDiario(r); });
      p.appendChild(b);
    } });
  }
  /** Anular e tirar uma foto (13 nov 2026): um comando na fila (D.itemComandoDiario), com o Desfazer de sempre (o pedido só
      sai depois do aviso); sem rede fica no «Por enviar»; uma foto que um posto está a arquivar repete-se mais tarde. */
  var ADIAR_CMD = self.DOE_MOVEL_TF_ADIAR || 5000;   // o mesmo Desfazer dos trabalhos (os testes encurtam-no)
  function comandoDiario(o, texto, desfeito) {
    var s = sessao(), it = D.itemComandoDiario(Object.assign({ contaId: contaId(), contaNome: s && s.nome, novoId: function () { return M.novoId(); }, adiarMs: ADIAR_CMD }, o));
    c.fila.push(it); guardarItem(it); redesenhar();
    toast(texto + (online() ? '' : ' · segue quando houver rede'), { ms: ADIAR_CMD, itemId: it.id,
      desfazer: function () { c.fila = c.fila.filter(function (x) { return x !== it; }); apagarItem(it.id); if (desfeito) desfeito(); redesenhar(); },
      aoFim: function () { if (c.fila.indexOf(it) < 0) return; it.adiadoAte = ''; guardarItem(it); drenar(false); } });   // revisão (A1): um comando que já saiu da fila não volta
    return it;
  }
  function anularDiario(r) {
    if (c.form && c.form.registoId === r.id) { c.form = null; if (c.vista === 'v-diario') voltar(); }
    comandoDiario({ accao: 'anular', registoId: r.id, obraId: r.obraId, dia: r.dia, versaoBase: Number.isInteger(r.versao) ? r.versao : null }, 'Diário de ' + D.textoDiaCurto(r.dia) + ' anulado');
  }
  /** Tirar uma foto já enviada (o `pode` dela), sem prazo, enquanto não está arquivada. desfeito: o que volta se a pessoa desfizer. */
  function tirarFotoDiario(r, n, desfeito) {
    comandoDiario({ accao: 'foto-tirar', registoId: r.id, obraId: r.obraId, dia: r.dia, n: n }, 'Foto ' + n + ' tirada', desfeito);
  }
  /** O que um comando aceite muda neste telemóvel (a cópia do registo, a versão de base dos que esperam, o formulário aberto). */
  async function aoComandoDiario(q, res) {
    if (contaId() !== q.contaId) return;   // revisão (C5): como o aoGravado
    // revisão (P3): o aviso da reserva diz-se uma vez e nunca tira o lugar a um aviso com Desfazer
    if (res.estado !== 'entregue') { if (res.reservada && res.mensagem && !q.avisouReserva && !(toastAtual && toastAtual.desfazer)) { q.avisouReserva = true; guardarItem(q); toast(res.mensagem, { ms: 6000 }); } if (q.estado === 'parado' && q.accao === 'foto-tirar') aoTirarParado(q); return; }
    var ch = cache(), data = res.data || {}, k = D.chaveDia(q.obraId, q.dia), v = Number(data.versao) || 0;
    if (q.accao === 'anular') {
      D.aoAnulado(ch, q.obraId, q.dia, data); if (v) marcarVersaoMinha(ch, q.registoId, v);
      toast('Diário de ' + D.textoDiaCurto(q.dia) + ' anulado' + (data.removidas && data.removidas.length ? (data.removidas.length === 1 ? ' · 1 foto saiu' : ' · ' + data.removidas.length + ' fotos saíram') : ''), { ms: 3000 });
    } else {
      if (ch.registos[k]) { ch.registos[k].fotos = (ch.registos[k].fotos || []).filter(function (f) { return f.n !== q.n; }); ch.registos[k].versao = v; }
      if (v) { ch.versoes[q.registoId] = v; marcarVersaoMinha(ch, q.registoId, v); }
      // o que espera na fila deste registo (e o formulário aberto) parte da versão que este telemóvel conhecia: segue com a nova
      // revisão (C2): a foto sai também dos que esperam e do formulário (já não existe no servidor); P1: a versão sobe só se não é repetido
      c.fila.forEach(function (x) { if (x.tipo === 'diario' && x.registoId === q.registoId && !x.resposta) { x.fotos = (x.fotos || []).filter(function (f) { return !(f.n === q.n && f.estado === 'servidor'); }); if (!data.repetido && x.versaoBase === v - 1) x.versaoBase = v; guardarItem(x); } });
      if (c.form && c.form.registoId === q.registoId) { c.form.fotos = c.form.fotos.filter(function (f) { return !(f.n === q.n && f.estado === 'servidor'); }); if (!data.repetido && c.form.versaoBase === v - 1) c.form.versaoBase = v; if (c.vista === 'v-diario') zona('fotos'); }
    }
    gravarCache(); redesenhar();
    if (c.vista === 'v-diario7') { await lerDiasDe(q.obraId); if (c.vista === 'v-diario7') desenharDiario7(); }
  }
  /** Revisão (C2): um tirar que ficou parado (a foto já foi arquivada, ou já não existe): a foto continua no registo, por isso
      volta ao formulário e aos que esperam com o `n` dela, e deixa de estar «a tirar». */
  /** Uma versão que este telemóvel fez (um comando aceite): na cache da conta, as 200 mais recentes. */
  function marcarVersaoMinha(ch, id, v) { if (!ch.versoesMinhas || typeof ch.versoesMinhas !== 'object') ch.versoesMinhas = {}; ch.versoesMinhas[id + '|' + v] = true; var ks = Object.keys(ch.versoesMinhas); if (ks.length > 200) ks.slice(0, ks.length - 200).forEach(function (x) { delete ch.versoesMinhas[x]; }); }
  function aoTirarParado(q) {
    var reg = cache().registos[D.chaveDia(q.obraId, q.dia)], f0 = reg && (reg.fotos || []).filter(function (f) { return f.n === q.n; })[0];
    c.fila.forEach(function (x) { if (x.tipo !== 'diario' || x.registoId !== q.registoId || x.resposta || (x.omitir && x.omitir.fotos)) return; if (!(x.fotos || []).some(function (f) { return f.n === q.n; }) && f0) { x.fotos.push({ n: f0.n, nPedido: f0.n, sha256: f0.sha256, tipo: f0.tipo, tamanho: f0.tamanho, estado: 'servidor' }); guardarItem(x); } });
    if (c.form && c.form.registoId === q.registoId) { c.form.fotos.forEach(function (f) { if (f.n === q.n) { f.aTirar = false; f.pode = (f.pode || []).filter(function (a) { return a !== 'tirar'; }); } }); c.erroFoto = 'A foto ' + q.n + ' não saiu: ' + (q.erro || 'o servidor não a deixou tirar.'); if (c.vista === 'v-diario') zona('fotos'); }
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
      // 13 nov 2026: uma foto já enviada só se tira com o `pode` dela (enquanto não está arquivada), pelo comando foto-tirar; uma
      // deste telemóvel ainda por enviar sai só daqui
      var servidor = ft.estado === 'servidor', podeTirar = !ft.aTirar && (!servidor || (ft.pode || []).indexOf('tirar') >= 0);
      if (ft.aTirar) { cel.classList.add('a-tirar'); cel.appendChild(el('small', 'mv-foto-atirar', 'a tirar…')); }
      if (podeTirar) {
        var x = bt('mv-foto-x'); x.setAttribute('aria-label', outro ? 'Tirar esta foto do diário' : 'Tirar a foto ' + (i + 1)); var sp = el('span'); sp.appendChild(ic('x')); x.appendChild(sp);
        x.addEventListener('click', function () {
          // revisão (C2): sai SÓ pelo comando foto-tirar; até lá fica na lista do formulário (marcada «a tirar») e numa correcção
          if (servidor) { ft.aTirar = true; zona('fotos'); tirarFotoDiario({ id: f.registoId, obraId: f.obraId, dia: f.dia }, ft.n, function () { ft.aTirar = false; if (c.form === f) zona('fotos'); }); return; }
          if (ft.prev && URL.revokeObjectURL) URL.revokeObjectURL(ft.prev); if (ft.sha256) { f.tiradasSha = f.tiradasSha || []; f.tiradasSha.push(ft.sha256); } D.tirarFoto(f, i); f.tocouFotosOuLocs = true; mexeu('fotos'); zona('fotos'); desenharBarraDia();
        });
        cel.appendChild(x);
      }
      g.appendChild(cel);
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
    else if (f.corrigir) { nomeIc = 'relogio'; txt = 'Corriges e anulas até 7 dias depois do dia; depois, só o DO ou o GP'; }
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
    if (f.corrigir && !D.mudouAlgo(f) && (f.fotos || []).some(function (x) { return x.aTirar; })) { apagarRascunho(f.obraId, f.dia); c.form = null; voltar(); return; }   // revisão (A2)
    if (f.corrigir && !D.mudouAlgo(f)) { apagarRascunho(f.obraId, f.dia); toast('Não mudaste nada: o diário fica como estava.', { ms: 3000 }); voltar(); return; }
    aGuardar = true;
    try {
      var s = sessao(), item = D.itemDaFila({ form: f, contaId: contaId(), contaNome: s && s.nome, novoId: function () { return M.novoId(); } });
      // o que estava parado para este registo (recusado, B4) é substituído por esta correcção: nada dele entrou no servidor
      c.fila.filter(function (q) { return q.tipo === 'diario' && q.contaId === contaId() && q.registoId === item.registoId && q.estado === 'parado' && (q.fotos || []).every(function (fp) { return !fp.blob || ['sem-lugar', 'removida', 'fora-de-prazo'].indexOf(fp.estado) >= 0 || (f.tiradasSha || []).indexOf(fp.sha256) >= 0 || item.fotos.some(function (fn) { return fn.blob && fn.sha256 === fp.sha256; }); }); }).forEach(function (q) { c.fila = c.fila.filter(function (x) { return x !== q; }); apagarItem(q.id); });
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
    if (fase === 'feito') { var cm = el('p', 'mv-calmo'); cm.appendChild(ic('ok')); cm.appendChild(document.createTextNode('Corriges e anulas até 7 dias depois do dia em que registaste. Depois, só o DO ou o GP.')); v.appendChild(cm); }
    var bb = limpar($('barra-dia-env'));
    var bf = bt('mv-btn pri', 'Feito'); bf.id = 'b-dia-feito'; bf.addEventListener('click', function () { c.envio = null; irHoje(true); });
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
      var anx = anularPorEnviar(ob, x.dia);   // revisão (C3): o dia com um anular por enviar
      if (anx) { var da = el('div', 'mv-fl mv-d7l sem'), ta = el('span', 'mv-fl-t'); ta.appendChild(el('b', null, (x.hoje ? 'Hoje' : D.textoDiaCurto(x.dia)) + ' · anulado, por enviar')); ta.appendChild(el('small', null, anx.tentou || (c.emCurso && c.atual === anx.id) ? 'Pode já ter seguido' : (online() ? 'Ainda dá para desfazer no «Por enviar»' : 'Segue quando houver rede'))); da.appendChild(ta); lista.appendChild(da); return; }
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
    // 13 nov 2026: os meus registos de antes dos 7 dias (o servidor dá 14): quem os fez corrige-os até 7 dias depois do dia
    var dd = (cache().dias[ob] && cache().dias[ob].data && cache().dias[ob].data.dias) || [], antes = dd.filter(function (x) { return x.meu && D.difDias(x.dia, hd.dia) >= 7; }).sort(function (a, b) { return a.dia < b.dia ? 1 : -1; });
    if (antes.length && tem('diario')) {
      v.appendChild(el('p', 'mv-lh', 'Os teus de antes'));
      var la = el('div', 'mv-lista mv-d7lista');
      antes.forEach(function (x) {
        var b = bt('mv-fl mv-d7l'); b.appendChild(el('span', 'mv-d7n', String(Number(x.meu.totalHomens) || 0)));
        var t = el('span', 'mv-fl-t'); t.appendChild(el('b', null, D.textoDiaCurto(x.dia))); t.appendChild(el('small', null, 'o teu: ' + D.txtHomens(Number(x.meu.totalHomens) || 0)));
        b.appendChild(t); b.appendChild(ic('chev'));
        b.addEventListener('click', function () { folhaDia({ dia: x.dia, total: x.total, doe: x.doe, sub: x.sub, registos: x.registos, meu: x.meu, hoje: false }, true); });
        la.appendChild(b);
      });
      v.appendChild(la);
    }
    var bb = limpar($('barra-d7'));
    if (tem('diario')) { var bd = bt('mv-btn pri', e.meu || e.pend ? 'Corrigir o diário de hoje' : 'Fazer o diário de hoje'); bd.id = 'b-d7'; bd.addEventListener('click', function () { abrirDiario(ob); }); bb.appendChild(bd); }
    A.medirBarra();
  }
  function folhaDia(x, daObra) {
    var ob = obraHoje(), h = (cache().hist || []).filter(function (y) { return y.obraId === ob && y.dia === x.dia; })[0], hd = hojeDia().dia;
    // 13 nov 2026: o meu registo deste dia, para Corrigir e Anular. O `pode` vem do servidor (lido ao abrir, com rede).
    var meuDele = !!(x.meu || (h && !h.soEquipas)) && tem('diario');
    var pe = function (p, est) {
      limpar(p);
      if (est.lendo) { p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0 pulsa', 'A ver o teu registo…')); return; }
      var reg = est.reg;
      if (!reg) { p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', est.semRede ? 'Para corrigir ou anular, abre com rede.' : 'Já não tens registo neste dia.')); return; }
      if (!D.podeNoRegisto(reg, 'corrigir') && !D.podeNoRegisto(reg, 'anular')) { p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', 'Já passaram os 7 dias: agora, só o DO ou o GP o corrigem.')); peFotos(p, reg); return; }
      if (D.podeNoRegisto(reg, 'corrigir')) { var bc = bt('mv-btn pri'); bc.id = 'b-dia-cor'; bc.appendChild(ic('lapis')); bc.appendChild(document.createTextNode('Corrigir')); bc.addEventListener('click', function () { A.fecharFolhas(true); abrirDiario(ob, false, true, x.dia === hd ? null : x.dia); }); p.appendChild(bc); }
      if (D.podeNoRegisto(reg, 'anular')) { var ba = bt('mv-link mv-link-anular'); ba.id = 'b-dia7-anular'; ba.appendChild(ic('lixo')); ba.appendChild(document.createTextNode('Anular este diário')); ba.addEventListener('click', function () { folhaAnularDiario({ obraId: ob, dia: x.dia, id: reg.id, versao: reg.versao }); }); p.appendChild(ba); }
      p.appendChild(el('p', 'mv-folha-txt', 'Corriges e anulas até 7 dias depois do dia em que registaste. Depois, só o DO ou o GP.'));
      if (!D.podeNoRegisto(reg, 'corrigir')) peFotos(p, reg);   // com Corrigir, as fotos tiram-se no formulário
    };
    var peFotos = function (p, reg) {   // as fotos que ainda se tiram (o `pode` de cada uma; sem prazo, enquanto não estão arquivadas)
      var ts = ((reg && reg.fotos) || []).filter(function (f) { return (f.pode || []).indexOf('tirar') >= 0; });
      ts.forEach(function (f) { var b = bt('mv-link mv-foto-acc'); b.setAttribute('data-k', 'dia-foto-tirar-' + f.n); b.appendChild(ic('x')); b.appendChild(document.createTextNode('Tirar a foto ' + f.n)); b.addEventListener('click', function () { fecharFolha(); tirarFotoDiario({ id: reg.id, obraId: ob, dia: x.dia }, f.n); }); p.appendChild(b); });
      if (ts.length) p.appendChild(el('p', 'mv-folha-txt', 'Uma foto sai enquanto não estiver arquivada; depois, só o DO ou o GP a retiram.'));
    };
    if (meuDele) {
      var est = { lendo: online() && A.sessaoValida(), reg: null, semRede: !online() };
      (est.lendo ? lerDiaAgora(ob, x.dia) : Promise.resolve(null)).then(function (dt) {
        est.lendo = false;
        if (dt) est.reg = dt.meu || null; else { est.semRede = true; }
        var p = $('fx-p'), d = $('folha-casca'); if (p && d && d.open && d.getAttribute('data-dia') === x.dia) pe(p, est);
      });
    }
    var fd = folha({ titulo: D.textoDiaCurto(x.dia), sub: (obraDe(ob) || {}).codigo || '', pe: meuDele ? function (p) { pe(p, est); } : null, corpo: function (cc) {
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
    fd.setAttribute('data-dia', x.dia);
  }

  // ── Por enviar (a fila das duas: ocorrências e diários) ──
  function desenharFila() {
    var v = $('v-fila'); if (!v) return; limpar(v);
    var p = porEnviar(), rf = (TE ? TE.linhasRascunho() : []).concat(BE ? BE.linhasRascunho() : []);   // fecho da 2a: os rascunhos dos formulários
    var n = p.diarios.length + p.ocorrencias.length + p.alheias.length + p.alheiosDia.length + (p.rascunho ? 1 : 0) + rf.length;
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
    rf.forEach(function (r) { linha(r.ic, r.titulo, r.resumo, 'Rascunho · por acabar', 'ama', [['lapis', 'Continuar', r.continuar]], function () { r.apagar(function () { desenharFila(); }); }); });
    p.diarios.slice().sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      if (q.tipo === 'diario-cmd') {   // anular e tirar uma foto do diário (13 nov 2026)
        var oc = obraDe(q.obraId), par = q.estado === 'parado', emC = c.emCurso && c.atual === q.id;
        var saiu = !par && (emC || !!q.tentou);   // revisão (C6): já saiu (ou está a sair): não se apaga, pode já ter seguido
        var estc = par ? (q.erro || 'Não entrou') : (emC ? 'A enviar…' : (q.adiadoAte ? 'Ainda dá para desfazer' : (!online() ? 'À espera de rede' : (q.erro || 'Na fila')))) + (saiu && !emC ? ' · pode já ter seguido' : '');
        linha('diario', 'Diário de obra' + (oc ? ' · ' + oc.codigo : '') + ' · ' + D.textoDiaMes(q.dia), D.resumoComandoDiario(q), estc, par ? 'neg' : null,
          par ? [] : [['atual', 'Tentar agora', function () { if (!A.sessaoValida()) { A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); return; } drenar(true); }]], saiu ? null : function () { apagarDaFila(q); });
        return;
      }
      if (q.tipo === 'tf' || q.tipo === 'bc') { var E = q.tipo === 'tf' ? TE : BE; if (!E) return; var L = E.linhaFila(q, c.emCurso && c.atual === q.id); linha(L.ic, L.titulo, L.resumo, L.estado, L.cls, L.acoes, L.apagar ? function () { apagarDaFila(q); } : null); return; }   // os trabalhos em falta e os bloqueios do cliente (trabalhos-ecra.js, bloqueios-ecra.js)
      var o = obraDe(q.obraId), parado = q.estado === 'parado', emCurso = c.emCurso && c.atual === q.id;
      var est = parado ? (q.erro || 'Não entrou') : (emCurso ? 'A enviar…' : (!A.sessaoValida() ? 'À espera de entrares' : (!online() ? 'À espera de rede' : (q.erro || 'Na fila'))));
      var acoes;
      if (parado && q.motivo === 'corrigir') acoes = [['lapis', 'Corrigir', function () { c.erroDe = { obraId: q.obraId, campo: q.campo || 'texto', texto: q.erro }; abrirDiario(q.obraId); }]];   // B4
      else if (parado) acoes = q.motivo === 'dia-fechado' || q.motivo === 'obra' || q.motivo === 'anulado' ? [] : [['atual', 'Tentar de novo', function () { q.estado = 'a-enviar'; q.erro = ''; guardarItem(q); drenar(true); desenharFila(); }]];
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
    toast(q.tipo === 'tf' ? 'Apagado · ' + (self.DoeMovelTf ? self.DoeMovelTf.tituloItem(q).toLowerCase() : 'trabalho em falta') : (q.tipo === 'bc' ? 'Apagado · ' + (self.DoeMovelBc ? self.DoeMovelBc.tituloItem(q).toLowerCase() : 'bloqueio do cliente') : (q.tipo === 'diario-cmd' ? 'Apagado · ' + D.resumoComandoDiario(q).toLowerCase() : 'Apagado · diário de ' + D.textoDiaMes(q.dia))), { desfazer: function () { delete c.apagar[q.id]; c.fila.push(q); desenharFila(); }, aoFim: function () { if (c.apagar[q.id]) { delete c.apagar[q.id]; apagarItem(q.id); } } });
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
        var agoraIso = new Date().toISOString();
        // um trabalho ou bloqueio não espera por um parado do mesmo registo (2.ª revisão: cada comando decide-se no servidor pelo estado de agora); um diário sim
        var q = c.fila.filter(function (x) { return x.estado === 'a-enviar' && x.contaId === conta && !c.apagar[x.id] && !feitos[x.id] && !bloqueados[x.registoId] && !(x.adiadoAte && x.adiadoAte > agoraIso)   // adiadoAte: o comando com Desfazer só segue depois do aviso
          && !(x.tipo === 'tf' && !(TE && TE.disponivel())) && !(x.tipo === 'bc' && !(BE && BE.disponivel()))   // revisão da parte 4: sem a funcionalidade (Edge recuada), ficam; os diários seguem
          // revisão (C1): só um DIÁRIO parado faz esperar o diário seguinte do mesmo registo; um comando decide-se pelo estado de agora
          && (x.tipo !== 'diario' || !c.fila.some(function (y) { return y !== x && y.tipo === 'diario' && y.registoId === x.registoId && y.estado === 'parado' && String(y.criadoEm) < String(x.criadoEm); }))
          // revisão (C2): no diário, nada passa à frente de um item adiado (com Desfazer) mais antigo do mesmo registo
          && !((x.tipo === 'diario' || x.tipo === 'diario-cmd') && c.fila.some(function (y) { return y !== x && (y.tipo === 'diario' || y.tipo === 'diario-cmd') && y.registoId === x.registoId && y.estado === 'a-enviar' && y.adiadoAte && y.adiadoAte > agoraIso && String(y.criadoEm) < String(x.criadoEm); })); }).sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); })[0];
        if (!q || contaId() !== conta) break;
        c.atual = q.id; desenharFilaSeVisivel();
        var tk = A.token();
        var res = q.tipo === 'tf' ? (TE ? await TE.processar(q) : { estado: 'pendente', mensagem: '' }) : (q.tipo === 'bc' ? (BE ? await BE.processar(q) : { estado: 'pendente', mensagem: '' }) : (q.tipo === 'diario-cmd' ? await D.processarComandoDiario(q, deps()) : await D.processarDiario(q, deps())));
        c.atual = '';
        if (res.estado === 'login' && res.revogado && A.token() && A.token() !== tk && repete < 2) { repete++; continue; }   // B2: a palavra-passe mudou a meio: repete com o token novo
        if (q.tipo === 'tf') { if (TE) await TE.aoResultado(q, res); if (BE) BE.aoTrabalho(q, res); }   // um trabalho desbloqueado sai do bloqueio do cliente
        else if (q.tipo === 'bc') { if (BE) await BE.aoResultado(q, res); }
        else if (q.tipo === 'diario-cmd') await aoComandoDiario(q, res);   // anular e tirar uma foto (13 nov 2026)
        else if (c.envio && c.envio.item.id === q.id) {
          c.envio.fase = res.estado === 'entregue' ? 'feito' : (res.estado === 'parar' || res.estado === 'corrigir' ? 'parado' : 'guardado');
          c.envio.mensagem = res.mensagem; c.envio.rede = !!res.rede;
          if (c.vista === 'v-dia-envio') desenharDiaEnvio();
        } else if (res.estado === 'entregue') toast('Diário de ' + D.textoDiaMes(q.dia) + (obraDe(q.obraId) ? ' · ' + obraDe(q.obraId).codigo : '') + ': enviado', { ms: 3500 });
        if (res.estado === 'entregue') { c.fila = c.fila.filter(function (x) { return x !== q; }); apagarItem(q.id); c.tentativas = 0; continue; }
        if (res.estado === 'login') { parou = 'login'; talvezLogin({ accao: 'login', texto: res.mensagem, revogado: res.revogado }); break; }
        if (res.estado === 'pendente') { feitos[q.id] = true; if (q.tipo !== 'diario-cmd') bloqueados[q.registoId] = true; q.erro = res.rede ? '' : (res.mensagem || ''); guardarItem(q); if (res.rede || (res.longo && !res.contrato && q.tipo !== 'tf' && q.tipo !== 'bc' && q.tipo !== 'diario-cmd')) { parou = res; break; } parou = parou || res; continue; }   // rede: os outros também falhavam; senão segue para o próximo (um trabalho ou bloqueio com o servidor por preparar ou recuado não prende os diários)
        feitos[q.id] = true; if (q.tipo === 'diario') bloqueados[q.registoId] = true;   // parado (dia fechado, obra, recusa): fica com o motivo e segue (os outros registos; num trabalho ou bloqueio, também os seguintes dele)
      }
    } finally { c.emCurso = false; c.atual = ''; }
    desenharHojeSeVisivel(); desenharFilaSeVisivel();
    var agoraMs = Date.now(), prox = c.fila.filter(function (x) { return x.estado === 'a-enviar' && x.contaId === conta && x.adiadoAte && Date.parse(x.adiadoAte) > agoraMs; }).map(function (x) { return Date.parse(x.adiadoAte); }).sort()[0];
    clearTimeout(c.timerAdiado); if (prox) c.timerAdiado = setTimeout(function () { drenar(false); }, prox - agoraMs + 50);   // o próximo comando com Desfazer, quando o aviso acabar
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
  function redesenhar() { desenharHojeSeVisivel(); desenharFilaSeVisivel(); if (TE) TE.redesenhar(); if (BE) BE.redesenhar(); }

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
  function antesDoLogin() { var v = A.vista(); if (v && v !== 'v-login') c.antes = v; gravarRascunhoJa(); }   // o rascunho a meio grava-se já (com a conta de agora)
  function depoisDoLogin(contaMudou) {
    c.semHojeMv = false; c.externa = false;   // a sessão nova traz as funcionalidades do servidor de agora
    if (contaMudou) { toastEspera = null; if (TE) TE.aoSair(); if (BE) BE.aoSair(); c.cache = null; c.form = null; c.envio = null; c.lidoMs = 0; c.obraHoje = ''; c.antes = ''; c.hx = { pag: 0, obra: '', visto: false, y: 0 }; }   // 2.ª revisão: também o formulário, o envio e o «fora» dos trabalhos e bloqueios
    var v = c.antes; c.antes = '';
    if (v === 'v-registo' || v === 'v-envio') { c.pilha = ['v-hoje', 'v-registo']; try { history.replaceState({ mvV: 'v-registo', n: 2 }, ''); } catch (e) { /* nada */ } c.vista = 'v-registo'; A.abrirOcorrencia(); desenharNav(); }   // M7: volta ao formulário da ocorrência
    else if (v && ehCasca(v) && (v !== 'v-diario' || c.form) && (v !== 'v-dia-envio' || c.envio) && vistaViva(v)) mostrar(v);
    else abrirInicial();
    ler(true); drenar(true);
  }
  function aoSair() { toastEspera = null; if (TE) TE.aoSair(); if (BE) BE.aoSair(); clearTimeout(c.timer); clearTimeout(c.timerAdiado); gravarRascunhoJa(); apagarCache(); c.pilha = []; c.vista = ''; c.entrou = false; c.semHojeMv = false; c.hx = { pag: 0, obra: '', visto: false, y: 0 }; }
  async function ligar(ponte) {
    A = ponte;
    c.store = await abrirStore(); c.memoria = !!c.store.memoria;
    var todos = []; try { todos = await c.store.listar(); } catch (e) { todos = []; }
    c.fila = []; c.rascunhos = {}; var rascF = [];
    var hj = new Date(); hj.setDate(hj.getDate() - 7); var limiteRasc = hj.getFullYear() + '-' + ('0' + (hj.getMonth() + 1)).slice(-2) + '-' + ('0' + hj.getDate()).slice(-2);
    todos.forEach(function (r) {
      if (!r) return;
      if (r.tipo === 'diario-rascunho') { if (!r.mexidos || String(r.dia) < limiteRasc) { apagarItem(r.id); return; } c.rascunhos[r.id] = r; return; }   // mais de 7 dias (ou do formato antigo): sai, com as fotos
      if (r.tipo === 'tf-rascunho' || r.tipo === 'bc-rascunho') { rascF.push(r); return; }   // os dos formulários (fecho da 2a): ficam com os ecrãs deles
      if (r.tipo !== 'diario' && r.tipo !== 'diario-cmd' && r.tipo !== 'tf' && r.tipo !== 'bc') return;   // 'diario-cmd': anular e tirar uma foto do diário (13 nov 2026)   // (numa base partilhada, como a dos testes, há também as ocorrências: não são daqui; 'tf' = os trabalhos em falta, 'bc' = os bloqueios do cliente)
      if (r.estado === 'entregue') { apagarItem(r.id); return; }
      c.fila.push(r);
    });
    c.rotaInicial = rotaDoEndereco();
    if (self.DoeMovelTfEcra) { TE = self.DoeMovelTfEcra.criar(kitTf()); TE.ligar(); TE.carregarRascunhos(rascF); Object.assign(ROTULO, TE.ROTULO); Object.assign(TITULO, TE.TITULO); }
    if (self.DoeMovelBcEcra) { BE = self.DoeMovelBcEcra.criar(kitTf()); BE.ligar(); BE.carregarRascunhos(rascF); Object.assign(ROTULO, BE.ROTULO); Object.assign(TITULO, BE.TITULO); }
    window.addEventListener('popstate', aoVoltarHist);
    window.addEventListener('online', function () { c.tentativas = 0; c.falhasLer = 0; redesenhar(); if (c.vista === 'v-diario') desenharBarraDia(); if (tem('diario') && A.sessaoValida()) ler(true); else drenar(false); });   // 3.ª revisão: primeiro LER (o contrato), a fila segue no fim da leitura
    window.addEventListener('offline', function () { redesenhar(); if (c.vista === 'v-diario') desenharBarraDia(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) gravarRascunhoJa(); else if (sessao()) { if (tem('diario') && A.sessaoValida()) ler(false); else drenar(false); } });   // a leitura drena no fim
    window.addEventListener('pagehide', gravarRascunhoJa);
    ['d-cam', 'd-gal'].forEach(function (id) { var i = $(id); if (i) i.addEventListener('change', function (ev) { juntarFotos(ev.target.files).then(function () { ev.target.value = ''; }); }); });
  }
  /** Os comandos novos de um trabalho ou bloqueio decididos de vez (chama-se no FIM do aviso, depois do Desfazer): o que estava
      parado no mesmo registo em conflito (ou com a ligação a outro que fechou) sai da fila, porque a pessoa já viu o que mudou
      e decidiu outra vez; nunca um que ainda tenha fotos por enviar (fica no «Por enviar», com o ✕). 2.ª revisão: antes saía
      logo ao pôr na fila, e uma foto do depois perdia-se, também com Desfazer. */
  function soltarConflitos(its) {
    (its || []).forEach(function (q) {
      c.fila = c.fila.filter(function (x) {
        var sai = x !== q && x.registoId === q.registoId && x.tipo === q.tipo && x.contaId === q.contaId && self.DoeMovelTf.conflitoSemFotos(x);
        if (sai) apagarItem(x.id);
        return !sai;
      });
    });
  }
  /** O kit que os ecrãs dos trabalhos em falta e dos bloqueios do cliente usam (trabalhos-ecra.js, bloqueios-ecra.js): o que a
      casca já tem, sem lhe dar o estado inteiro; tf() e bc() dão um ao outro (a folha de um trabalho abre o bloqueio dele). */
  function kitTf() {
    return { A: A, el: el, bt: bt, ic: ic, junta: junta, limpar: limpar, folha: folha, fecharFolha: fecharFolha, toast: toast, abrir: abrir, irHoje: irHoje,
      cache: cache, gravarCache: gravarCache, deps: deps, contaId: contaId, sessao: sessao, obras: obras, obraDe: obraDe, online: online, hojeDia: hojeDia, tem: tem, temHojeMv: temHojeMv,
      novoId: function () { return M.novoId(); }, guardarItem: guardarItem, apagarItem: apagarItem, semArmazem: semArmazem,
      fila: function () { return c.fila; }, porNaFila: function (q) { c.fila.push(q); }, soltarConflitos: soltarConflitos, tirarDaFila: function (q) { c.fila = c.fila.filter(function (x) { return x !== q; }); }, apagar: c.apagar,
      drenar: drenar, talvezLogin: talvezLogin, largarToastDe: largarToastDe, vista: function () { return c.vista; }, lerLocsAgora: lerLocsAgora, seccao: seccao, rlinha: rlinha, barra20: barra20,
      marcarReler: function () { c.lidoMs = 0; }, tf: function () { return TE; }, bc: function () { return BE; }, redesenharHoje: desenharHojeSeVisivel };
  }
  self.DoeMovelCasca = {
    ligar: ligar, abrirInicial: abrirInicial, antesDoLogin: antesDoLogin, depoisDoLogin: depoisDoLogin, aoSair: aoSair,
    voltar: voltar, irHoje: irHoje, rotuloVoltar: rotuloVoltar, ehCasca: ehCasca,
    titulo: function (v) { if (v === 'v-diario' && c.form && c.form.dia !== hojeDia().dia) return 'Diário de ' + D.textoDiaCurto(c.form.dia); return TITULO[v] || ''; },
    aoMudarFila: function (o) { if (o && o.recebida && ehCasca(c.vista)) toast('Ocorrência ' + o.recebida + ' recebida', { ms: 3500 }); redesenhar(); },
    nDiariosPorEnviar: function () { return minhaFila().length; },
    trabalhoNaPagina: function () { return semArmazem() ? minhaFila().length + Object.keys(c.rascunhos).length + (TE ? TE.linhasRascunho().length : 0) + (BE ? BE.linhasRascunho().length : 0) : 0; },
    abrirFila: function () { abrir('v-fila'); }, abrirDiario7: abrirDiario7, vista: function () { return c.vista; }, definirVista: function (v) { c.vista = v; },
    _estado: function () { return c; },
  };
}());
