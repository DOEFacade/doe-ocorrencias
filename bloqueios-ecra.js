/* DOE · Telemóvel — os ecrãs dos Bloqueios do cliente (fatia 2a, parte 3, 13 nov 2026): a lista da obra por estado (a
   partir do bloco Cliente do Hoje; com várias obras, primeiro a obra), o bloqueio aberto numa folha (o que precisamos do
   cliente, a Localização, as fotos, os trabalhos parados e o histórico), confirmar ou «Não é do cliente», «Resolvido» com
   a lista dos trabalhos que ficam desbloqueados (todos marcados; desmarca-se o que continua parado), «Desbloquear (N)» dos
   que ficaram, reabrir, juntar foto, e o formulário de registo (foto, o que precisamos do cliente, Localização, trabalhos
   parados). Desenho: os ecrãs «Bloqueios do cliente» do protótipo validado DOEX-Telemovel-App-Prototipo.html. A lógica é a
   de bloqueios.js (pura, testada em Node e contra o servidor real); a casca dá-me o kit (`K`), o mesmo dos trabalhos.
   Regras: tudo o que vem do servidor entra por textContent; os botões são os do `pode` do servidor; cada acção é um
   COMANDO na fila da conta, as que têm Desfazer só seguem depois de o aviso acabar; sem rede ficam «por enviar»; as fotos
   do servidor lêem-se a pedido, em memória. O documento para o cliente e o «Enviado ao cliente» são do computador.
   Fecho da 2a (parte 4, 13 nov 2026): o formulário guarda-se em disco como rascunho (o molde dos trabalhos); «Corrigir» o
   texto e a Localização, e escolher os trabalhos parados (ligar-tf / desligar-tf), na folha e pelo `pode`; a faixa do Hoje
   «Bloqueio do cliente por confirmar · Ver» só para quem o pode confirmar (o `pode` do servidor, nunca uma regra daqui); e
   o bloqueio novo vindo de um trabalho traz a foto dele. */
(function () {
  'use strict';
  var B = self.DoeMovelBc, T = self.DoeMovelTf, D = self.DoeMovelDiario;
  if (!B || !T || !D) return;
  var ADIAR = self.DOE_MOVEL_TF_ADIAR || 5000;   // o Desfazer (o mesmo dos trabalhos; os testes encurtam-no)
  // as acções de um trabalho que mexem nas ligações aos bloqueios do cliente: depois delas, a lista dos bloqueios relê-se
  var MEXEM_BC = ['criar', 'bloquear', 'sugerir-bloqueio', 'confirmar-bloqueio', 'rejeitar-bloqueio', 'desbloquear', 'feito', 'anular', 'reabrir'];
  var MEXEM_TF = ['resolver', 'descartar', 'reabrir', 'ligar-tf', 'desligar-tf'];   // e ao contrário: depois destas, a lista dos trabalhos relê-se
  var TIPOS_FOTO = ['image/jpeg', 'image/png', 'image/webp'];
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  function criar(K) {
    var novo = function () { return { obra: '', filtro: 'ativos', lendo: false, erro: '', fora: '', form: null, envio: null, urls: {}, pedidosUrl: {}, sel: '', marcados: null, fotoMais: null }; };
    var S = novo();
    var R = {}, tRasc = null, lidosFaixa = {};   // os rascunhos em disco (por id; cada um diz a sua conta); as leituras da faixa do Hoje
    var el = K.el, bt = K.bt, ic = K.ic, junta = K.junta, limpar = K.limpar, $ = function (id) { return document.getElementById(id); };
    function hoje() { return K.hojeDia().dia; }
    function eu() { var s = K.sessao(); return { nome: (s && s.nome) || '' }; }
    function minhaFila() { return K.fila().filter(function (q) { return q.contaId === K.contaId() && q.estado !== 'entregue' && !K.apagar[q.id]; }); }
    function deps() {
      var dp = K.deps(), conta = K.contaId();
      dp.aoGravado = function (item, data) { if (K.contaId() !== conta || !data.registo) return; B.porRegisto(K.cache(), data.registo); K.gravarCache(); };
      return dp;
    }
    /** Pode entrar? A funcionalidade no servidor (Edge ∩ SQL), o Hoje novo a responder (a conta é interna) e o servidor sem
        ter dito «não» nesta abertura. A conta externa nunca chega aqui (o servidor não lhe manda o bloco Cliente). */
    function disponivel() { return K.tem('cliente') && K.temHojeMv() && !S.fora; }

    // ── Localizações (as do diário) e os trabalhos da obra (a lista dos trabalhos, na mesma cache) ──
    function locsDe(ob) { var lc = K.cache().locs[ob], l = []; ((lc && lc.produtos) || []).forEach(function (p) { (p.localizacoes || []).forEach(function (x) { l.push({ issueId: x.id, codigo: x.codigo || '', nome: x.nome || '', produto: p.nome || '' }); }); }); return l; }
    function locDe(ob) { return function (id) { return locsDe(ob).filter(function (x) { return x.issueId === id; })[0] || null; }; }
    function ultimaLoc(ob) { var u = K.cache().tfUlt && K.cache().tfUlt[ob]; return u && locsDe(ob).some(function (x) { return x.issueId === u.issueId; }) ? u : null; }
    function guardarUltima(ob, loc) { var ch = K.cache(); if (!ch.tfUlt || typeof ch.tfUlt !== 'object') ch.tfUlt = {}; if (loc) ch.tfUlt[ob] = loc; else delete ch.tfUlt[ob]; K.gravarCache(); }
    function tfLista(ob) { var x = T.listaDe(K.cache(), ob); return x ? (x.data.trabalhos || []) : null; }
    function podePlanearObra(ob) { var x = B.listaDe(K.cache(), ob), y = T.listaDe(K.cache(), ob); return !!((x && x.data.podePlanear) || (y && y.data.podePlanear)); }

    // ── Leitura ──
    async function lerLista(ob) {
      if (!ob || !K.A.sessaoValida() || !K.online()) { redesenharLista(); return false; }
      var conta = K.contaId();
      S.lendo = true; redesenharLista();
      try {
        var r = await B.lerLista(deps(), ob);
        if (K.contaId() !== conta) return false;
        if (r.ok) { B.guardarLista(K.cache(), ob, r.data); K.gravarCache(); S.erro = ''; return true; }
        return falhou(r);
      } finally { S.lendo = false; redesenharLista(); redesenharFolha(); }
    }
    async function lerTfs(ob) {
      if (!ob || !K.A.sessaoValida() || !K.online()) return false;
      var conta = K.contaId(), r = await T.lerLista(deps(), ob);
      if (K.contaId() !== conta || !r.ok) return false;
      T.guardarLista(K.cache(), ob, r.data); K.gravarCache();
      var te = K.tf(); if (te) te.redesenhar();
      return true;
    }
    function falhou(r) {
      var m = B.mensagemBc(r);
      if (r.code === 'TOKEN_DE_AMBITO') { S.fora = m.texto; S.erro = ''; return false; }   // a Edge de antes (recuada): a entrada sai, sem pedir o login
      if (K.talvezLogin(D.mensagemDiario(r))) return false;
      if (r.code === 'CONTA_EXTERNA' || r.code === 'MOVEL_FATIA2_POR_INSTALAR' || (r.status === 403 && r.code !== 'PAPEL_SEM_ESCRITA')) S.fora = m.texto;   // a entrada sai nesta abertura
      S.erro = r.rede ? '' : m.texto;
      return false;
    }

    // ── A lista (v-bc) ──
    function abrirLista(ob, substituir) {
      if (!ob) return;
      S.obra = ob; S.filtro = 'ativos';
      if (!K.cache().locs[ob]) K.lerLocsAgora(ob);
      K.abrir('v-bc', !!substituir);
      lerLista(ob);
      if (!tfLista(ob)) lerTfs(ob).then(redesenharLista);
    }
    /** Os trabalhos que um comando por enviar vai desbloquear (o «Desbloquear (N)») saem já da lista do bloqueio. */
    function semDesbloqueados(l) {
      var ids = minhaFila().filter(function (q) { return q.tipo === 'tf' && q.accao === 'desbloquear' && q.obraId === S.obra; }).map(function (q) { return q.registoId; });
      if (!ids.length) return l;
      return l.map(function (b) {
        if (!(b.trabalhos || []).some(function (id) { return ids.indexOf(id) >= 0; })) return b;
        var r = JSON.parse(JSON.stringify(b)); r.trabalhos = r.trabalhos.filter(function (id) { return ids.indexOf(id) < 0; });
        if (r.estado === 'RESOLVIDO') r.porDesbloquear = r.trabalhos.length;
        return r;
      });
    }
    function bloqueios() {
      var x = B.listaDe(K.cache(), S.obra), l = x ? (x.data.bloqueios || []) : [];
      return semDesbloqueados(B.comPendentes(l, minhaFila(), S.obra, hoje(), eu(), locDe(S.obra)));
    }
    function bcDe(id) { return bloqueios().filter(function (b) { return b.id === id; })[0] || null; }
    function redesenharLista() { if (K.vista() === 'v-bc' && K.A.vista() === 'v-bc') desenharLista(); }
    function desenharLista() {
      var v = $('v-bc'); if (!v) return;
      var ae = document.activeElement, k = ae && v.contains(ae) ? ae.getAttribute('data-k') : null;
      limpar(v);
      var o = K.obraDe(S.obra), x = B.listaDe(K.cache(), S.obra);
      var lead = el('p', 'mv-lead'); lead.tabIndex = -1; lead.setAttribute('data-foco-inicial', '');
      if (o) junta(lead, el('code', null, o.codigo || ''), ' · ' + o.nome);
      var est = S.lendo ? (x ? ' · a atualizar…' : ' · a ler…') : (x && (!K.online() || /^de /.test(D.textoDados(x.lidoEm, new Date()))) ? ' · dados ' + D.textoDados(x.lidoEm, new Date()) : '');
      if (est) lead.appendChild(document.createTextNode(est));
      v.appendChild(lead);
      if (S.erro) { var fe = el('div', 'mv-faixa ama'); fe.setAttribute('role', 'status'); fe.appendChild(ic('alerta')); fe.appendChild(el('span', 'mv-faixa-t', S.erro)); v.appendChild(fe); }
      if (!x) { v.appendChild(el('p', 'mv-nada', S.lendo || (K.online() && K.A.sessaoValida()) ? 'A ler os bloqueios do cliente desta obra…' : 'Ainda não tenho os bloqueios do cliente desta obra neste telemóvel: aparecem quando houver rede.')); return; }
      var lst = bloqueios(), s = B.contas(lst);
      var sec = el('section', 'mv-sec pri mv-tf-segm'), seg = el('div', 'mv-segm'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Estado');
      [['ativos', 'Ativos', s.ativos + s.resolvidosComTrabalhos], ['fechados', 'Resolvidos', s.fechados]].forEach(function (f) {
        var b = bt('', f[1] + (f[2] ? ' · ' + f[2] : '')); b.setAttribute('aria-pressed', String(S.filtro === f[0])); b.setAttribute('data-k', 'f-' + f[0]);
        b.addEventListener('click', function () { S.filtro = f[0]; desenharLista(); }); seg.appendChild(b);
      });
      sec.appendChild(seg); v.appendChild(sec);
      var gl = B.grupos(lst, S.filtro);
      if (!gl.length) v.appendChild(el('p', 'mv-nada', S.filtro === 'fechados' ? 'Nenhum resolvido nos últimos 30 dias.' : 'Sem bloqueios do cliente nesta obra.'));
      gl.forEach(function (g) {
        var gs = el('section', 'mv-sec mv-lista-t'), gh = el('div', 'mv-sec-h'); gh.appendChild(el('h2', null, g.titulo)); gh.appendChild(el('span', 'mv-sec-m', String(g.itens.length))); gs.appendChild(gh);
        g.itens.forEach(function (b) { gs.appendChild(linha(b)); });
        v.appendChild(gs);
      });
      if (S.filtro === 'ativos' && gl.length) v.appendChild(el('p', 'mv-lead mv-bc-nota', 'Formalizar ao cliente faz-se no computador, pelo GP.'));
      if (x.data.cortado) v.appendChild(el('p', 'mv-folha-txt', 'A mostrar ' + (x.data.bloqueios || []).length + ' de ' + x.data.total + '. Os outros vêem-se no computador.'));
      if (k) { var y = v.querySelector('[data-k="' + k + '"]'); if (y) K.A.focar(y); }
      carregarMinis(v);
    }
    function linha(b) {
      var p = B.palavra(b, hoje()), n = (b.trabalhos || []).length;
      var d = bt('mv-bcl'); d.setAttribute('data-k', 'b-' + b.id);
      d.appendChild(mini(b));
      var t = el('span', 'mv-bcl-t'); t.appendChild(el('b', null, b.precisa));
      t.appendChild(el('small', null, (n ? pl(n, 'parado', 'parados') + ' · ' : '') + B.locTitulo(b.localizacao)));   // o impacto primeiro: a 360 px corta-se a Localização, não o número
      d.appendChild(t);
      var e = el('span', 'mv-bcl-e'); e.appendChild(el('span', p.c, p.pc || p.p));
      if (b.comErro) e.appendChild(el('small', 'mv-tf-erro', 'não entrou'));
      else e.appendChild(el('small', null, b.porEnviar ? 'por enviar' : (p.curto || p.f)));
      d.appendChild(e);
      d.setAttribute('aria-label', b.precisa + '. ' + p.p + (p.f ? ', ' + p.f : '') + '. ' + B.locTitulo(b.localizacao) + ', ' + (n ? pl(n, 'trabalho parado', 'trabalhos parados') : 'nenhum trabalho parado'));
      d.addEventListener('click', function () { abrirBc(b.id); });
      return d;
    }

    // ── As fotos: as deste telemóvel (a fila) e as do servidor, lidas a pedido, em memória ──
    function blobLocal(id, n) { var f = null; minhaFila().forEach(function (q) { if (q.registoId === id) (q.fotos || []).forEach(function (x) { if (x.n === n && x.blob) f = x; }); }); return f; }
    function urlLocal(f) { if (!f.prev && URL.createObjectURL) f.prev = URL.createObjectURL(f.blob); return f.prev || ''; }
    async function urlFoto(id, n) {
      var k = id + '|' + n; if (S.urls[k]) return S.urls[k];
      if (S.pedidosUrl[k]) return S.pedidosUrl[k];
      S.pedidosUrl[k] = (async function () {
        if (!K.online() || !K.A.sessaoValida()) return '';
        var r = await B.urlFoto(deps(), id, n);
        if (!r.ok) { if (r.status === 410) S.urls[k] = 'arquivada'; return S.urls[k] || ''; }
        try { var res = await fetch(r.data.url); if (!res.ok) return ''; var bl = await res.blob(); S.urls[k] = URL.createObjectURL(bl); return S.urls[k]; } catch (e) { return ''; }
      }());
      try { return await S.pedidosUrl[k]; } finally { delete S.pedidosUrl[k]; }
    }
    function mini(b) {
      var f = (b.fotos || [])[0], m = el('span', 'mv-bcl-f'); m.setAttribute('aria-hidden', 'true');
      if (!f) { m.appendChild(ic('obra')); return m; }
      var lb = blobLocal(b.id, f.n), u = lb ? urlLocal(lb) : S.urls[b.id + '|' + f.n];
      if (u && u !== 'arquivada') { var img = el('img', 'mv-bcl-f'); img.alt = ''; img.src = u; return img; }
      m.appendChild(ic('gal')); if (!u && f.estado === 'por-arquivar') m.setAttribute('data-foto', b.id + '|' + f.n);
      return m;
    }
    /** As miniaturas da lista: no máximo 8 por desenho, uma a uma (o limite de leituras é partilhado com o diário). */
    async function carregarMinis(v) {
      var ps = Array.prototype.slice.call(v.querySelectorAll('[data-foto]'), 0, 8);
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i].getAttribute('data-foto').split('|'), u = await urlFoto(p[0], Number(p[1]));
        if (u && u !== 'arquivada' && ps[i].isConnected) { var img = el('img', 'mv-bcl-f'); img.alt = ''; img.src = u; ps[i].replaceWith(img); }
      }
    }

    // ── O bloqueio aberto (folha) ──
    /** ob: abrir um bloqueio de outra obra (a folha de um trabalho): só se a lista dos bloqueios não estiver à vista. */
    function abrirBc(id, ob) {
      if (ob && ob !== S.obra) { if (K.vista() === 'v-bc') return; S.obra = ob; }
      var b = bcDe(id); if (!b) return;
      S.sel = id;
      var d = K.folha({ alta: true, titulo: b.precisa, sub: ((K.obraDe(b.obraId) || {}).codigo || '') + ' · ' + B.locTitulo(b.localizacao), corpo: function (cc) { corpoBc(cc, b); }, pe: function (p) { peBc(p, b); } });
      if (d) d.setAttribute('data-dono', 'bc:' + id);
      if (K.online()) lerTfs(b.obraId).then(function (ok) { if (ok) redesenharFolha(); });   // o texto dos trabalhos parados
    }
    /** A folha aberta acerta-se depois de uma leitura (só a dela: a folha é partilhada com os trabalhos). */
    function redesenharFolha() {
      var d = $('folha-casca'); if (!d || !d.open || d.getAttribute('data-dono') !== 'bc:' + S.sel) return;
      var b = bcDe(S.sel), c = $('fx-c'), p = $('fx-p'); if (!b || !c || !p) return;
      $('fx-t').textContent = b.precisa;
      limpar(c); corpoBc(c, b); limpar(p); peBc(p, b);
    }
    function rl(rot, val, cls, resto) { var d = el('div', 'mv-rl'); d.appendChild(el('span', null, rot)); var bb = el('b'); if (cls) { bb.appendChild(el('i', cls, val)); if (resto) bb.appendChild(document.createTextNode(' · ' + resto)); } else bb.textContent = val; d.appendChild(bb); return d; }
    function fotosHtml(cc, b) {
      var fs = el('div', 'mv-tf-fotos'), te = K.tf(), tira = false;
      (b.fotos || []).forEach(function (f, i) {
        var alt = 'Foto ' + (i + 1) + ' do bloqueio', lb = blobLocal(b.id, f.n), cel = el('div', 'mv-tf-fcel'); fs.appendChild(cel);
        var acc = function () { if (te && te.accoesFoto) tira = te.accoesFoto(cel, b, f, function (accao, campos, txt) { comando(b, accao, campos, txt); }) || tira; };   // Tirar / Retirar, só pelo `pode` da foto
        if (lb) { var im = el('img', 'mv-tf-foto'); im.alt = alt; im.src = urlLocal(lb); cel.appendChild(im); acc(); return; }
        var ph = el('span', 'mv-tf-foto', f.estado === 'arquivada' ? 'Nos documentos da obra' : (f.estado === 'por-enviar' ? 'Por enviar noutro telemóvel' : 'A carregar a foto…'));
        cel.appendChild(ph); acc();
        if (f.estado === 'por-arquivar') urlFoto(b.id, f.n).then(function (u) { if (!ph.isConnected) return; if (u && u !== 'arquivada') { var im2 = el('img', 'mv-tf-foto'); im2.alt = alt; im2.src = u; ph.replaceWith(im2); } else ph.textContent = u === 'arquivada' ? 'Nos documentos da obra' : (K.online() ? 'Não consegui ler a foto' : 'A foto vê-se com rede'); });
      });
      if (fs.firstChild) { cc.appendChild(fs); if (te && te.notaFotos) te.notaFotos(cc, tira); }
    }
    function corpoBc(cc, b) {
      var p = B.palavra(b, hoje()), h = hoje();
      fotosHtml(cc, b);   // o que precisamos do cliente é o título da folha (não se repete)
      cc.appendChild(rl('Estado', p.p, p.c, b.estado === 'POR_CONFIRMAR' || b.estado === 'POR_FORMALIZAR' ? '' : p.f));   // a idade está em «Desde»
      cc.appendChild(rl('Localização', B.locTitulo(b.localizacao)));
      if (b.dia) cc.appendChild(rl('Desde', D.textoDiaCurto(b.dia) + ' · ' + B.idade(b.dia, h)));
      if (b.autor && b.autor.nome) cc.appendChild(rl('Registado por', b.autor.nome));
      if (b.estado === 'POR_CONFIRMAR') cc.appendChild(rl('Quem confirma', 'O DO ou o GP da obra'));
      if (b.formalizadoEm) cc.appendChild(rl('Formalizado', 'a ' + D.textoDiaMes(T.diaDe(b.formalizadoEm))));
      if (b.prazoResposta) cc.appendChild(rl('Resposta até', D.textoDiaCurto(b.prazoResposta)));
      if (b.estado === 'DESCARTADO' && b.descartadoMotivo) cc.appendChild(rl('Motivo', b.descartadoMotivo));
      var te0 = K.tf();
      if (!b.porEnviar && te0 && (pode(b, 'editar-texto') || pode(b, 'localizacao'))) cc.appendChild(te0.linkCorrigir(pode(b, 'editar-texto'), pode(b, 'localizacao'), function () { folhaCorrigirBc(b); }));
      var ts = B.trabalhosDe(b, tfLista(b.obraId));
      cc.appendChild(el('p', 'mv-lh', b.estado === 'RESOLVIDO' && ts.length ? 'Trabalhos por desbloquear' : 'Trabalhos parados por isto'));
      if (!ts.length) cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', 'Nenhum por agora.'));
      ts.forEach(function (t) {
        var bb = bt('mv-lo mv-lo-ir'), n = el('span', 'mv-lo-n', t.desconhecido ? 'Um trabalho parado' : t.texto), mesma = ((t.localizacao && t.localizacao.issueId) || null) === ((b.localizacao && b.localizacao.issueId) || null);
        n.appendChild(el('small', null, t.desconhecido ? (K.online() ? 'A ler…' : 'Vê-se com rede') : T.palavra(t, h).p + (mesma ? '' : ' · ' + B.locTitulo(t.localizacao))));   // a Localização só se for outra
        junta(bb, n, ic('chev')); bb.setAttribute('data-k', 'tf-' + t.id);
        var te = K.tf();
        if (t.desconhecido || !te) bb.disabled = true;
        else bb.addEventListener('click', function () { te.abrirTrabalhoDe(b.obraId, t.id); });
        cc.appendChild(bb);
      });
      if (!b.porEnviar && (pode(b, 'ligar-tf') || pode(b, 'desligar-tf'))) { var lg = link(ts.length ? 'Mudar os trabalhos parados' : 'Escolher os trabalhos parados', 'lapis', function () { folhaLigar(b); }); lg.setAttribute('data-k', 'ligar'); cc.appendChild(lg); }
      var hs = (b.historico || []).slice().reverse();
      if (hs.length) {
        cc.appendChild(el('p', 'mv-lh', 'Histórico'));
        var ul = el('ul', 'mv-hist');
        hs.forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, B.nomeAccao(x.accao) + (x.nome ? ' · ' + x.nome : ''))); li.appendChild(el('small', null, T.diaDe(x.em) === h ? 'hoje' : D.textoDiaMes(T.diaDe(x.em) || h))); ul.appendChild(li); });
        cc.appendChild(ul);
      }
    }
    function pode(b, a) { return (b.pode || []).indexOf(a) >= 0; }
    function botao(cls, txt, fn, nomeIc) { var b = bt('mv-btn' + (cls ? ' ' + cls : '')); if (nomeIc) b.appendChild(ic(nomeIc)); b.appendChild(document.createTextNode(txt)); b.addEventListener('click', fn); return b; }
    function link(txt, nomeIc, fn) { var b = bt('mv-link'); b.appendChild(ic(nomeIc)); b.appendChild(document.createTextNode(txt)); b.addEventListener('click', fn); return b; }
    function peBc(p, b) {
      if (b.porEnviar) { p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', K.online() ? 'A enviar: as acções voltam quando o servidor responder.' : 'Por enviar: segue quando houver rede. As acções voltam depois.')); return; }
      var dois = el('div', 'mv-pe2'), algum = false, nDes = b.estado === 'RESOLVIDO' ? desbloqueaveis(b).length : 0;
      var nao = pode(b, 'descartar') ? botao('', 'Não é do cliente', function () { K.fecharFolha(); comando(b, 'descartar', {}, 'Já não conta como do cliente'); }) : null;
      var par = function (pri) { if (nao) { dois.appendChild(pri); dois.appendChild(nao); p.appendChild(dois); } else p.appendChild(pri); algum = true; };
      if (pode(b, 'confirmar')) par(botao('pri', 'Confirmar', function () { K.fecharFolha(); comando(b, 'confirmar', {}, 'Confirmado · por formalizar'); }));
      else if (pode(b, 'resolver')) par(botao('pri', 'Resolvido', function () { folhaResolver(b); }));
      else if (nao) { p.appendChild(nao); algum = true; }
      if (!pode(b, 'confirmar') && !pode(b, 'resolver') && nDes) {   // os que ficaram parados depois do «Resolvido»: os que ESTA conta pode desbloquear
        p.appendChild(botao('pri', 'Desbloquear (' + nDes + ')', function () { folhaDesbloquear(b); })); algum = true;
      }
      // 13 nov 2026: quem registou anula a SUA sugestão ainda não enviada ao cliente (o `anular` do pode; o DO e o GP têm o
      // «Não é do cliente»), com confirmação, e desfaz a anulação (o `reabrir` do pode dele, num bloqueio que ele anulou)
      var desfazAnul = b.estado === 'DESCARTADO' && ((b.historico || []).slice(-1)[0] || {}).accao === 'anular' && !pode(b, 'descartar') && !pode(b, 'confirmar');
      var rotR = desfazAnul ? 'Desfazer a anulação' : 'Reabrir', txtR = desfazAnul ? 'Anulação desfeita' : 'Reaberto';
      if (pode(b, 'reabrir')) { p.appendChild(algum ? link(rotR, 'atual', function () { K.fecharFolha(); comando(b, 'reabrir', {}, txtR); }) : botao('', rotR, function () { K.fecharFolha(); comando(b, 'reabrir', {}, txtR); }, 'atual')); algum = true; }
      if (pode(b, 'foto-juntar') && (b.fotos || []).length < B.LIMITES.fotos) {
        var fj = function () { S.fotoMais = { id: b.id }; $('b-mais').click(); };
        if (!algum) p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', b.estado === 'POR_CONFIRMAR' ? 'Fica por confirmar até o DO ou o GP o confirmar.' : 'O DO e o GP resolvem; o documento para o cliente faz-se no computador.'));
        p.appendChild(algum ? link('Acrescentar foto', 'cam', fj) : botao('', 'Acrescentar foto', fj, 'cam')); algum = true;
      }
      if (pode(b, 'anular') && !nao) { var an = link('Anular a minha sugestão', 'lixo', function () { var te = K.tf(); if (!te) return; te.folhaConfirmar({ titulo: 'Anular a tua sugestão?', sub: b.precisa, texto: 'Deixa de contar como bloqueio do cliente; os trabalhos parados por isto passam a «Outro». Podes desfazer durante 7 dias.', botao: 'Anular a sugestão', fazer: function () { comando(b, 'anular', {}, 'Sugestão anulada'); } }); }); an.classList.add('mv-link-anular'); an.id = 'b-bc-anular'; p.appendChild(an); algum = true; }
      if (!algum) p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', B.ativo(b) ? 'O DO e o GP confirmam e resolvem os bloqueios do cliente.' : 'Fechado. Só o DO ou o GP o reabrem.'));
    }
    /** A lista com caixas (todas marcadas) do «Resolvido» e do «Desbloquear (N)». */
    function listaMarcar(cc, ts, aoMudar, comEstado) {
      ts.forEach(function (t) {
        var b = bt('mv-lo mv-lo-v'); b.setAttribute('aria-pressed', String(S.marcados.indexOf(t.id) >= 0)); b.setAttribute('data-k', 'm-' + t.id);
        var c = el('span', 'mv-chk'); c.setAttribute('aria-hidden', 'true'); c.appendChild(ic('ok'));
        var n = el('span', 'mv-lo-n', t.desconhecido ? 'Um trabalho parado' : t.texto); n.appendChild(el('small', null, t.desconhecido ? 'Vê-se com rede' : (comEstado ? T.palavra(t, hoje()).p + ' · ' : '') + B.locTitulo(t.localizacao)));
        junta(b, c, n);
        b.addEventListener('click', function () { var i = S.marcados.indexOf(t.id); if (i >= 0) S.marcados.splice(i, 1); else S.marcados.push(t.id); b.setAttribute('aria-pressed', String(i < 0)); aoMudar(); });
        cc.appendChild(b);
      });
    }
    function folhaResolver(b) {
      var ts = B.trabalhosDe(b, tfLista(b.obraId));
      if (!ts.length) { K.fecharFolha(); comando(b, 'resolver', { desbloquear: [] }, 'Resolvido'); return; }
      S.marcados = ts.filter(function (t) { return !t.desconhecido; }).map(function (t) { return t.id; });   // um que não se vê (sem rede) não se desbloqueia sem a pessoa o ver
      var pe = function (p) {
        var n = S.marcados.length, bb = bt('mv-btn pri', n ? 'Resolvido · desbloquear ' + n : 'Resolvido · sem desbloquear'); bb.id = 'b-bc-res';
        bb.addEventListener('click', function () { var ids = S.marcados.slice(); K.fecharFolha(); comando(b, 'resolver', { desbloquear: ids }, ids.length ? 'Resolvido · ' + pl(ids.length, 'trabalho desbloqueado', 'trabalhos desbloqueados') : 'Resolvido'); });
        p.appendChild(bb);
      };
      K.folha({ titulo: 'Resolvido', sub: b.precisa, alta: ts.length > 4, corpo: function (cc) {
        cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', ts.length === 1 ? 'O trabalho parado por isto fica desbloqueado. Desmarca-o se continua parado.' : 'Os trabalhos parados por isto ficam desbloqueados. Desmarca os que continuam parados.'));
        listaMarcar(cc, ts, function () { var p = $('fx-p'); limpar(p); pe(p); });
      }, pe: pe });
    }
    /** «Desbloquear (N)»: os trabalhos que ficaram ligados ao resolvido; cada um é o comando «desbloquear» do trabalho. */
    /** Os trabalhos ligados a um resolvido que ESTA conta pode desbloquear (o `pode` de cada trabalho, da lista dos trabalhos). */
    function desbloqueaveis(b) { return B.trabalhosDe(b, tfLista(b.obraId)).filter(function (t) { return !t.desconhecido && (t.pode || []).indexOf('desbloquear') >= 0; }); }
    function folhaDesbloquear(b) {
      var ts = desbloqueaveis(b);
      S.marcados = ts.map(function (t) { return t.id; });
      var pe = function (p) {
        var n = S.marcados.length, bb = bt('mv-btn pri', n ? 'Desbloquear ' + n : 'Escolhe os que já podem avançar'); bb.id = 'b-bc-desb'; bb.setAttribute('aria-disabled', String(!n));
        bb.addEventListener('click', function () { if (!S.marcados.length) return; var ids = S.marcados.slice(); K.fecharFolha(); desbloquearTrabalhos(b, ids); });
        p.appendChild(bb);
      };
      K.folha({ titulo: 'Desbloquear', sub: b.precisa, alta: ts.length > 4, corpo: function (cc) {
        cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', 'O cliente já respondeu. Marca os trabalhos que já podem avançar.'));
        listaMarcar(cc, ts, function () { var p = $('fx-p'); limpar(p); pe(p); });
      }, pe: pe });
    }
    /** «Corrigir» o que precisamos do cliente e a Localização (a folha dos trabalhos, trabalhos-ecra.js). */
    function folhaCorrigirBc(b) {
      var te = K.tf(); if (!te) return;
      te.folhaCorrigir({ titulo: 'Corrigir', sub: b.precisa, rotulo: 'O que precisamos do cliente', texto: b.precisa, max: B.LIMITES.precisa, podeTexto: pode(b, 'editar-texto'), podeLoc: pode(b, 'localizacao'), loc: b.localizacao, obraId: b.obraId,
        // P6 (revisão, 13 nov 2026): um bloqueio já enviado ao cliente; o retrato enviado não muda
        nota: b.pedeNovoEnvio ? 'Acertar isto pede um novo envio ao cliente.' : (b.autor && b.autor.eu && !pode(b, 'confirmar') && !pode(b, 'resolver') ? 'Corriges e anulas até 7 dias depois do dia em que registaste. Depois, só o DO ou o GP.' : ''),
        aoGuardar: function (x) {
          var its = [];
          if (x.texto != null) its.push(itemDe(b, 'editar-texto', { precisa: x.texto }, { adiarMs: ADIAR }));
          if (x.loc !== undefined) its.push(itemDe(b, 'localizacao', { issueId: (x.loc && x.loc.issueId) || null }, { adiarMs: ADIAR }));
          comandos(its, x.texto != null && x.loc !== undefined ? 'Corrigido' : (x.texto != null ? 'Texto corrigido' : 'Localização mudada'));
        } });
    }
    /** Escolher os trabalhos parados por isto (ligar-tf / desligar-tf, um comando por trabalho): os ligados vêm marcados; por
        baixo, os abertos da mesma Localização e, a pedido, os das outras. Desligar o último deixa o trabalho por «Outro». */
    function folhaLigar(b) {
      var ligados = (b.trabalhos || []).slice(), outras = false;
      S.marcados = ligados.slice();
      var listas = function () {
        var l = tfLista(b.obraId); if (!l) return null;
        var abertos = l.filter(function (t) { return !t.feitoEm && !t.anuladoEm; }), por = {};
        abertos.forEach(function (t) { por[t.id] = t; });
        var lig = B.trabalhosDe(b, l), mesma = B.tfsDaLoc(abertos, b.localizacao).filter(function (t) { return ligados.indexOf(t.id) < 0; });
        var resto = abertos.filter(function (t) { return ligados.indexOf(t.id) < 0 && mesma.indexOf(t) < 0; });
        return { lig: lig, mesma: mesma, resto: resto };
      };
      var muda = function () { return { liga: S.marcados.filter(function (id) { return ligados.indexOf(id) < 0; }), tira: ligados.filter(function (id) { return S.marcados.indexOf(id) < 0; }) }; };
      var pe = function (p) {
        limpar(p);
        var m = muda(), n = m.liga.length + m.tira.length, partes = [];
        if (m.liga.length) partes.push('ligar ' + m.liga.length); if (m.tira.length) partes.push('desligar ' + m.tira.length);
        var bb = bt('mv-btn pri', n ? 'Guardar · ' + partes.join(', ') : 'Nada mudou'); bb.id = 'b-bc-lig'; bb.setAttribute('aria-disabled', String(!n));
        bb.addEventListener('click', function () { var y = muda(); if (!y.liga.length && !y.tira.length) return; K.fecharFolha(); ligarTrabalhos(b, y.liga, y.tira); });
        p.appendChild(bb);
      };
      var corpo = function (cc) {
        limpar(cc);
        cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', 'Marca os trabalhos parados por isto. Um trabalho que desligares fica bloqueado por «Outro» até alguém o desbloquear.'));
        var x = listas();
        if (!x) { cc.appendChild(el('p', 'mv-folha-txt', K.online() ? 'A ler os trabalhos desta obra…' : 'Sem rede: os trabalhos desta obra vêem-se com rede.')); return; }
        if (!x.lig.length && !x.mesma.length) outras = true;   // nada ligado nem nesta Localização: os das outras à vista (ensaio de 13 nov: a folha abria vazia)
        var grupo = function (tit, ts) { if (!ts.length) return; cc.appendChild(el('p', 'mv-lh', tit)); listaMarcar(cc, ts, function () { pe($('fx-p')); }, true); };
        grupo('Ligados a este bloqueio', x.lig);
        grupo(b.localizacao ? 'Nesta Localização' : 'Sem Localização', x.mesma);
        if (x.resto.length && !outras) { var vo = link('Ver os de outras Localizações (' + x.resto.length + ')', 'chev', function () { outras = true; corpo($('fx-c')); }); vo.setAttribute('data-k', 'outras'); cc.appendChild(vo); }
        if (outras) grupo('Outras Localizações', x.resto);
        if (!x.lig.length && !x.mesma.length && !x.resto.length) cc.appendChild(el('p', 'mv-folha-txt', 'Não há trabalhos em falta abertos nesta obra.'));
      };
      K.folha({ alta: true, titulo: 'Trabalhos parados', sub: b.precisa, corpo: corpo, pe: pe });
      if (!tfLista(b.obraId) || K.online()) lerTfs(b.obraId).then(function (ok) { var d = $('folha-casca'); if (ok && d && d.open && $('b-bc-lig')) { corpo($('fx-c')); pe($('fx-p')); } });
    }
    function ligarTrabalhos(b, liga, tira) {
      var its = liga.map(function (id) { return itemDe(b, 'ligar-tf', { tfId: id }, { adiarMs: ADIAR }); }).concat(tira.map(function (id) { return itemDe(b, 'desligar-tf', { tfId: id }, { adiarMs: ADIAR }); }));
      var partes = []; if (liga.length) partes.push(pl(liga.length, 'trabalho ligado', 'trabalhos ligados')); if (tira.length) partes.push(pl(tira.length, 'desligado', 'desligados'));
      comandos(its, partes.join(' · ').replace(/^./, function (c) { return c.toUpperCase(); }));
    }
    function desbloquearTrabalhos(b, ids) {
      var s = K.sessao(), its = ids.map(function (id) {
        var t = (tfLista(b.obraId) || []).filter(function (x) { return x.id === id; })[0] || { id: id, obraId: b.obraId, texto: '' };
        return T.itemComando({ accao: 'desbloquear', tf: { id: id, obraId: b.obraId, versao: t.versao }, campos: {}, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId, resumo: t.texto, adiarMs: ADIAR });
      });
      its.forEach(function (it) { K.porNaFila(it); K.guardarItem(it); });
      redesenharLista();
      K.toast(pl(its.length, 'trabalho desbloqueado', 'trabalhos desbloqueados') + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR,
        desfazer: function () { its.forEach(function (it) { K.tirarDaFila(it); K.apagarItem(it.id); }); redesenharLista(); },
        aoFim: function () { var vivos = its.filter(function (it) { return K.fila().indexOf(it) >= 0; }); if (!vivos.length) return; vivos.forEach(function (it) { it.adiadoAte = ''; K.guardarItem(it); }); K.soltarConflitos(vivos); K.drenar(false); },   // decidido de vez: o conflito antigo sai (sem fotos por enviar)
      });
    }

    // ── Os comandos: um item na fila da conta; com Desfazer, só segue depois de o aviso acabar ──
    function nBase(b) { var mx = 0; (b.fotos || []).forEach(function (f) { mx = Math.max(mx, Number(f.n) || 0); }); minhaFila().forEach(function (q) { if (q.registoId === b.id) (q.fotos || []).forEach(function (f) { mx = Math.max(mx, Number(f.n) || 0); }); }); return mx; }
    function base(id) { var x = B.listaDe(K.cache(), S.obra); return x ? (x.data.bloqueios || []).filter(function (b) { return b.id === id; })[0] || null : null; }
    function itemDe(b, accao, campos, o) {
      var s = K.sessao();
      return B.itemComando(Object.assign({ accao: accao, bc: base(b.id) || b, campos: campos, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId, resumo: b.precisa, nBase: nBase(b) }, o || {}));
    }
    async function porNaFila(item) { K.porNaFila(item); await K.guardarItem(item); }
    function tirarDaFila(item) { K.tirarDaFila(item); K.apagarItem(item.id); }
    function comando(b, accao, campos, texto) { comandos([itemDe(b, accao, campos, { adiarMs: ADIAR })], texto); }
    /** Um ou mais comandos com um só Desfazer; o Hoje acerta-se logo (a faixa «por confirmar» sai enquanto dura o Desfazer). */
    function comandos(its, texto) {
      its.forEach(function (it) { porNaFila(it); }); redesenharLista(); K.redesenharHoje();
      K.toast(texto + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR,
        desfazer: function () { its.forEach(tirarDaFila); redesenharLista(); K.redesenharHoje(); },
        aoFim: function () { var vivos = its.filter(function (it) { return K.fila().indexOf(it) >= 0; }); if (!vivos.length) return; vivos.forEach(function (it) { it.adiadoAte = ''; K.guardarItem(it); }); K.soltarConflitos(vivos); K.drenar(false); },   // decidido de vez: o conflito antigo sai (sem fotos por enviar)
      });
    }
    /** «Acrescentar foto» num bloqueio que já existe: o comando foto-juntar, sem Desfazer (tira-se no computador). */
    async function fotoMais(files) {
      var alvo = S.fotoMais; S.fotoMais = null;
      var f = files && files[0]; if (!alvo || !f) return;
      var b = bcDe(alvo.id); if (!b) return;
      var x; try { x = await K.A.comprimir(f); } catch (e) { K.toast((e && e.message) || 'Não consegui abrir esta foto.'); return; }
      await porNaFila(itemDe(b, 'foto-juntar', {}, { fotos: [x] }));
      K.toast('Foto acrescentada' + (K.online() ? '' : ' · segue quando houver rede'), { ms: 2500 }); redesenharLista(); K.drenar(false);
    }

    // ── O formulário (v-bc-form): foto, o que precisamos do cliente, Localização, trabalhos parados ──
    /** o: { loc (undefined = a última que usaste), tfs (os trabalhos já marcados: vem da folha de um trabalho), substituir, daFolha }. */
    /** Fecho da 2a: sem loc, sem trabalhos e sem rascunho pedido (o «+»), continua o rascunho mais recente desta conta;
        rascunho: o id de um rascunho a continuar (o «Por enviar»); fotoTf: { id, n, estado }, a foto do trabalho de onde veio. */
    function abrirForm(ob, o) {
      o = o || {};
      var r = o.rascunho ? R[o.rascunho] : (o.loc === undefined && !o.tfs ? meusRascunhos()[0] : null);
      if (r && r.contaId !== K.contaId()) r = null;
      if (!ob && !r) { K.toast('Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.'); return; }
      gravarRascunhoJa();
      if (r) { S.form = B.formDoRascunho(r); S.form.doRascunho = r.guardadoEm; ob = S.form.obraId; }
      else { var auto = o.loc === undefined, loc = auto ? ultimaLoc(ob) : o.loc; S.form = B.formNovo({ obraId: ob, loc: loc, locAuto: auto && !!loc, tfs: o.tfs }); S.form.rid = idRascunho(); }
      S.form.uid = K.novoId(); S.form.tentou = false; S.form.erroFoto = ''; S.form.conta = K.contaId();
      if (!r && o.fotoTf) fotoDoTrabalho(S.form, o.fotoTf);
      if (!K.cache().locs[ob]) K.lerLocsAgora(ob).then(function () { if (K.vista() === 'v-bc-form') zona('loc'); });
      if (!tfLista(ob) || K.online()) lerTfs(ob).then(function () { if (K.vista() === 'v-bc-form') zona('tfs'); });
      if (!B.listaDe(K.cache(), ob)) lerLista(ob).then(function () { if (K.vista() === 'v-bc-form') desenharBarraForm(); });   // o «podePlanear» da obra
      K.abrir('v-bc-form', !!o.substituir, !!o.daFolha);
    }
    /** A foto do trabalho de onde se veio entra no formulário (protótipo, «bloq-novo»), marcada daTf; se não puder vir, diz-se
        porquê e a pessoa tira outra. Os bytes são os do trabalho (os deste telemóvel, ou os do servidor lidos agora). */
    async function fotoDoTrabalho(f, x) {
      var te = K.tf(); if (!te) return;
      f.aPreparar = 1;
      var re = function () { if (K.vista() === 'v-bc-form' && S.form === f) { zona('fotos'); desenharBarraForm(); } };
      var MSG = { arquivada: 'A foto do trabalho já está nos documentos da obra: tira outra, se quiseres.', rede: 'Sem rede, a foto do trabalho não veio: tira outra, se quiseres.',
        'outro-telemovel': 'A foto do trabalho ainda não chegou ao servidor: tira outra, se quiseres.', falhou: 'Não consegui trazer a foto do trabalho: tira outra, se quiseres.' };
      try {
        var b = await te.blobFoto(x.id, x.n, x.estado);
        if (S.form !== f) return;
        if (b.erro) { f.erroFoto = MSG[b.erro] || MSG.falhou; return; }
        var foto = b.sha256 ? { blob: b.blob, sha256: b.sha256, tipo: b.tipo, tamanho: b.tamanho } : null;
        if (!foto && TIPOS_FOTO.indexOf(b.blob.type) >= 0 && b.blob.size <= 5 * 1024 * 1024) foto = { blob: b.blob, tipo: b.blob.type, tamanho: b.blob.size, sha256: await self.DoeMovel.sha256Hex(await bytesDe(b.blob)) };
        if (!foto) foto = await K.A.comprimir(b.blob);   // outro formato: reduz-se como as fotos tiradas aqui
        if (S.form !== f || f.fotos.length >= B.LIMITES.fotos) return;
        foto.daTf = true; f.fotos.unshift(foto);
      } catch (e) { if (S.form === f) f.erroFoto = MSG.falhou; }
      finally { if (S.form === f) { f.aPreparar = 0; re(); } }
    }
    function bytesDe(blob) {
      if (blob.arrayBuffer) return blob.arrayBuffer();
      return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsArrayBuffer(blob); });
    }

    // ── O rascunho (o molde dos trabalhos, trabalhos-ecra.js) ──
    function idRascunho() { return ('rb-' + K.novoId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80); }
    function meusRascunhos() { return B.rascunhosDa(Object.keys(R).map(function (k) { return R[k]; }), K.contaId(), new Date()).meus; }
    function carregarRascunhos(lista) {
      var x = B.rascunhosDa(lista, '', new Date());
      x.velhos.forEach(function (r) { K.apagarItem(r.id); });
      (lista || []).forEach(function (r) { if (r && r.tipo === 'bc-rascunho' && x.velhos.indexOf(r) < 0) R[r.id] = r; });
    }
    function mexeu() { if (!S.form) return; clearTimeout(tRasc); tRasc = setTimeout(gravarRascunhoJa, 300); }
    function gravarRascunhoJa() {
      clearTimeout(tRasc); tRasc = null;
      var f = S.form; if (!f || !f.rid || !f.conta || f.conta !== K.contaId()) return;
      if (B.rascunhoVazio(f)) { if (R[f.rid]) { delete R[f.rid]; K.apagarItem(f.rid); } return; }
      var r = B.rascunhoDe(f, { contaId: f.conta }); R[r.id] = r; K.guardarItem(r);
    }
    function apagarRascunho(id) { if (!id) return; delete R[id]; K.apagarItem(id); }
    function linhasRascunho() {
      return meusRascunhos().map(function (r) {
        var o = K.obraDe(r.form.obraId), fs = (r.form.fotos || []).length;
        return { id: r.id, ic: 'obra', titulo: 'Bloqueio do cliente' + (o ? ' · ' + o.codigo : ''), resumo: (String(r.form.precisa || '').trim().slice(0, 60) || 'Sem texto') + (fs ? ' · ' + pl(fs, 'foto', 'fotos') : ''),
          continuar: function () { abrirForm(r.form.obraId, { rascunho: r.id }); },
          apagar: function (aoMudar) { delete R[r.id]; aoMudar(); K.toast('Rascunho deitado fora', { desfazer: function () { R[r.id] = r; aoMudar(); }, aoFim: function () { if (!R[r.id]) K.apagarItem(r.id); } }); } };
      });
    }
    function faixaRascunho(box) {
      var f = S.form; if (!f.doRascunho) return;
      var d = el('div', 'mv-faixa neu'); d.setAttribute('role', 'status'); d.appendChild(ic('lapis'));
      var dia = T.diaDe(f.doRascunho), h = D.horaDe(f.doRascunho);
      d.appendChild(el('span', 'mv-faixa-t', 'O teu rascunho de ' + (dia === hoje() ? 'hoje' : D.textoDiaMes(dia)) + (h ? ' às ' + h : '')));
      var b = bt('mv-faixa-b', 'Começar de novo'); b.id = 'b-bc-rasc-novo';
      b.addEventListener('click', function () { var ob = f.obraId; apagarRascunho(f.rid); S.form = null; abrirForm(ob, { loc: ultimaLoc(ob), substituir: true }); });
      d.appendChild(b); box.appendChild(d);
    }

    // ── A faixa do Hoje: «Bloqueio do cliente por confirmar · Ver» (protótipo, acoesHoje), só para quem o pode confirmar ──
    /** O bloqueio por confirmar mais antigo desta obra que ESTA conta pode confirmar (o `pode` do servidor; com os comandos
        por enviar por cima: um «Confirmar» ainda no Desfazer já o tira). nHoje: o porConfirmar do Hoje; sem a lista, ou com
        ela desacertada do Hoje, lê-a em segundo plano (uma vez por minuto e por obra) e o Hoje redesenha-se. */
    function porConfirmarParaMim(ob, nHoje, podeLer) {
      if (!disponivel() || !ob || !(Number(nHoje) > 0)) return null;
      var x = B.listaDe(K.cache(), ob), n = x ? (x.data.bloqueios || []).filter(function (b) { return b.estado === 'POR_CONFIRMAR'; }).length : -1;
      if (podeLer && n !== Number(nHoje) && K.online() && K.A.sessaoValida() && !(lidosFaixa[ob] > Date.now() - 60000)) { lidosFaixa[ob] = Date.now(); lerEmFundo(ob); }
      if (!x) return null;
      var l = B.comPendentes(x.data.bloqueios, minhaFila(), ob, hoje(), eu(), locDe(ob)).filter(function (b) { return b.estado === 'POR_CONFIRMAR' && pode(b, 'confirmar'); });
      l.sort(function (a, b) { return String(a.dia || '').localeCompare(String(b.dia || '')) || String(a.id).localeCompare(String(b.id)); });
      return l[0] || null;
    }
    async function lerEmFundo(ob) {
      var conta = K.contaId(), r = await B.lerLista(deps(), ob);
      if (K.contaId() !== conta) return;
      if (r.ok) { B.guardarLista(K.cache(), ob, r.data); K.gravarCache(); K.redesenharHoje(); return; }
      falhou(r);
    }
    var ZONAS = ['obra', 'fotos', 'loc', 'texto', 'tfs'];
    function desenharForm() {
      var v = $('v-bc-form'); if (!v || !S.form) return;
      if (v.getAttribute('data-form') !== S.form.uid) { limpar(v); v.setAttribute('data-form', S.form.uid); ZONAS.forEach(function (z) { var d = el('div'); d.id = 'bz-' + z; v.appendChild(d); }); }
      ZONAS.forEach(zona);
      desenharBarraForm();
    }
    function zona(z) {
      var box = $('bz-' + z); if (!box || !S.form) return;
      var ae = document.activeElement, k = ae && box.contains(ae) ? ae.getAttribute('data-k') : null;
      if (z === 'texto' && ae && ae.id === 'c-bc-txt') { marcarFrases(); return; }   // a escrever: o campo não se refaz
      limpar(box); ({ obra: zObra, fotos: zFotos, loc: zLoc, texto: zTexto, tfs: zTfs })[z](box);
      if (k) { var y = box.querySelector('[data-k="' + k + '"]'); if (y) K.A.focar(y); }
      mexeu();
    }
    function zObra(box) {
      faixaRascunho(box);
      var f = S.form, o = K.obraDe(f.obraId), s = el('section', 'mv-sec pri'); s.setAttribute('aria-labelledby', 'h-obra-bc');
      var sh = el('div', 'mv-sec-h'); sh.appendChild(el('h2', null, 'Obra')).id = 'h-obra-bc'; s.appendChild(sh);
      var b = bt('mv-obra' + (o ? '' : ' vazia')); b.id = 'c-obra-bc'; b.setAttribute('data-k', 'obra');
      var i = el('span', 'mv-obra-ic'); i.appendChild(ic('obra')); b.appendChild(i);
      var tt = el('span', 'mv-obra-t');
      if (o) { var oc = el('span', 'mv-obra-cod'); if (o.codigo) oc.appendChild(el('code', null, o.codigo)); oc.appendChild(el('span', null, 'a última que usaste')); tt.appendChild(oc); tt.appendChild(el('span', 'mv-obra-n', o.nome)); }
      else tt.appendChild(el('span', 'mv-obra-n', 'Escolher a obra'));
      b.appendChild(tt);
      var ac = el('span', 'mv-obra-acc', K.obras().length > 1 ? 'Trocar' : ''); ac.appendChild(ic('chev')); b.appendChild(ac);
      if (K.obras().length > 1) b.addEventListener('click', folhaObraForm); else { b.disabled = true; ac.hidden = true; }
      s.appendChild(b); box.appendChild(s);
    }
    function folhaObraForm() {
      var f = S.form;
      K.folha({ titulo: 'Escolher a obra', alta: K.obras().length > 6, corpo: function (cc) {
        K.obras().forEach(function (o) {
          var b = bt('mv-lo'); b.setAttribute('aria-pressed', String(o.id === f.obraId)); junta(b, el('code', null, o.codigo || ''), el('span', 'mv-lo-n', o.nome), ic('ok'));
          b.addEventListener('click', function () {
            K.fecharFolha(); if (o.id === f.obraId) return;
            f.obraId = o.id; f.loc = ultimaLoc(o.id); f.locAuto = !!f.loc; f.tfs = [];
            if (!K.cache().locs[o.id]) K.lerLocsAgora(o.id).then(function () { zona('loc'); });
            lerTfs(o.id).then(function () { zona('tfs'); });
            if (!B.listaDe(K.cache(), o.id)) lerLista(o.id).then(desenharBarraForm);
            desenharForm();
          });
          cc.appendChild(b);
        });
      } });
    }
    function zFotos(box) {
      var f = S.form, n = f.fotos.length, s = K.seccao('Foto', n ? n + ' de ' + B.LIMITES.fotos : 'Recomendada · vai para o documento', 'h-fotos-bc'), prep = f.aPreparar || 0;
      var add = function (cls, nomeIc, txt, rot, input) { var b = bt('mv-add' + (cls ? ' ' + cls : '')); b.appendChild(ic(nomeIc)); b.appendChild(el('span', null, txt)); if (rot) b.setAttribute('aria-label', rot); b.disabled = prep > 0; b.addEventListener('click', function () { $(input).click(); }); return b; };
      if (!n && !prep) { var vz = el('div', 'mv-fotos-vazio'), cam = add('cam', 'cam', 'Tirar foto', '', 'b-cam'); cam.id = 'b-cam-bc'; vz.appendChild(cam); vz.appendChild(add('gal', 'gal', 'Galeria', 'Juntar da galeria', 'b-gal')); s.appendChild(vz); }
      else {
        var g = el('div', 'mv-fotos');
        f.fotos.forEach(function (ft, i) {
          var cel = el('div', 'mv-foto'), img = el('img'); img.alt = ft.daTf ? 'Foto do trabalho' : 'Foto ' + (i + 1); img.src = urlLocal(ft); cel.appendChild(img);
          if (ft.daTf) cel.appendChild(el('span', 'mv-foto-rot', 'Do trabalho'));
          var x = bt('mv-foto-x'); x.setAttribute('aria-label', ft.daTf ? 'Tirar a foto do trabalho' : 'Tirar a foto ' + (i + 1)); var sp = el('span'); sp.appendChild(ic('x')); x.appendChild(sp);
          x.addEventListener('click', function () { if (ft.prev && URL.revokeObjectURL) URL.revokeObjectURL(ft.prev); f.fotos.splice(i, 1); zona('fotos'); desenharBarraForm(); });
          cel.appendChild(x); g.appendChild(cel);
        });
        for (var k = 0; k < prep; k++) { var pp = el('div', 'mv-foto prep'); pp.setAttribute('role', 'status'); pp.appendChild(el('span', 'pulsa', 'A preparar…')); var pb = el('div', 'mv-pb'); pb.appendChild(el('i')); pp.appendChild(pb); g.appendChild(pp); }
        var livres = B.LIMITES.fotos - n - prep;
        if (livres >= 1) { var c1 = add('cam', 'cam', 'Câmara', 'Tirar outra foto', 'b-cam'); c1.id = 'b-cam-bc'; g.appendChild(c1); }
        if (livres >= 2) g.appendChild(add('', 'gal', 'Galeria', 'Juntar da galeria', 'b-gal'));
        s.appendChild(g);
        if (livres <= 0 && !prep) s.appendChild(el('p', 'mv-fotos-nota', B.LIMITES.fotos + ' de ' + B.LIMITES.fotos + ', o máximo. Tira uma (✕) para juntar outra.'));
      }
      if (f.erroFoto) { var ef = el('p', 'mv-erro'); ef.setAttribute('role', 'alert'); ef.appendChild(ic('alerta')); ef.appendChild(el('span', null, f.erroFoto)); s.appendChild(ef); }
      box.appendChild(s);
    }
    async function juntarFotos(lista) {
      var f = S.form, files = Array.prototype.slice.call(lista || []); if (!f || !files.length || f.aPreparar) return;
      f.erroFoto = '';
      var cabem = Math.max(0, B.LIMITES.fotos - f.fotos.length);
      if (files.length > cabem) f.erroFoto = 'No máximo ' + B.LIMITES.fotos + ' fotos por bloqueio.';
      files = files.slice(0, cabem);
      var re = function () { if (K.vista() === 'v-bc-form' && S.form === f) { zona('fotos'); desenharBarraForm(); } };
      f.aPreparar = files.length; re();
      try {
        for (var i = 0; i < files.length; i++) {
          try { var x = await K.A.comprimir(files[i]); if (S.form !== f) break; f.fotos.push(x); } catch (e) { f.erroFoto = (e && e.message) || 'Não consegui abrir esta foto.'; }
          f.aPreparar = files.length - i - 1; re();
        }
      } finally { f.aPreparar = 0; re(); }
    }
    function zLoc(box) {
      var f = S.form, s = K.seccao('Localização', 'Opcional', 'h-loc-bc'), b = bt('mv-obra'); b.id = 'c-loc-bc'; b.setAttribute('data-k', 'loc');
      var i = el('span', 'mv-obra-ic'); i.appendChild(ic('obra')); b.appendChild(i);
      var tt = el('span', 'mv-obra-t');
      if (f.loc) { tt.appendChild(el('span', 'mv-obra-cod', f.locAuto ? 'a última que usaste' : (f.loc.produto || f.loc.codigo || ''))); tt.appendChild(el('span', 'mv-obra-n', f.locAuto || !f.loc.produto ? B.locTitulo(f.loc) : (f.loc.nome || f.loc.codigo))); }
      else { tt.appendChild(el('span', 'mv-obra-n', 'Escolher')); tt.appendChild(el('span', 'mv-obra-cod', K.cache().locs[f.obraId] ? 'Mostra os trabalhos parados dali' : (K.online() ? 'A ler as localizações…' : 'Sem rede: ainda não as tenho neste telemóvel'))); }
      b.appendChild(tt); var ac = el('span', 'mv-obra-acc', f.loc ? 'Trocar' : ''); ac.appendChild(ic('chev')); b.appendChild(ac);
      b.addEventListener('click', folhaLoc); s.appendChild(b); box.appendChild(s);
    }
    function folhaLoc() {
      var f = S.form, lc = K.cache().locs[f.obraId], ult = ultimaLoc(f.obraId);
      var escolher = function (l) { var mudou = ((f.loc && f.loc.issueId) || null) !== ((l && l.issueId) || null); f.loc = l; f.locAuto = false; if (mudou) f.tfs = []; K.fecharFolha(function () { return $('c-loc-bc'); }); zona('loc'); zona('tfs'); };
      var op = function (cc, l, rot) { var b = bt('mv-lo'); b.setAttribute('aria-pressed', String(l ? !!(f.loc && f.loc.issueId === l.issueId) : !f.loc)); var nm = el('span', 'mv-lo-n', rot); if (l && l.codigo) nm.appendChild(el('small', null, l.codigo)); junta(b, nm, ic('ok')); b.addEventListener('click', function () { escolher(l); }); cc.appendChild(b); };
      K.folha({ titulo: 'Localização', alta: true, sub: 'Produtos e localizações da ' + ((K.obraDe(f.obraId) || {}).codigo || 'obra'), corpo: function (cc) {
        op(cc, null, 'Sem localização');
        if (!lc) { cc.appendChild(el('p', 'mv-vazio', K.online() ? 'A ler as localizações da obra… fecha e abre outra vez daqui a nada.' : 'Sem rede, e ainda não tenho as localizações desta obra neste telemóvel.')); return; }
        if (ult) { cc.appendChild(el('p', 'mv-lh', 'A última que usaste')); op(cc, ult, B.locTitulo(ult)); }
        (lc.produtos || []).forEach(function (p) {
          if (!(p.localizacoes || []).length) return;
          cc.appendChild(el('p', 'mv-lh', p.nome));
          p.localizacoes.forEach(function (x) { op(cc, { issueId: x.id, codigo: x.codigo || '', nome: x.nome || '', produto: p.nome || '' }, x.nome || x.codigo); });
        });
      } });
    }
    function marcarFrases() { var fr = $('bz-frases'); if (!fr || !S.form) return; Array.prototype.forEach.call(fr.children, function (b) { b.setAttribute('aria-pressed', String(String(S.form.precisa).trim() === b.textContent)); }); }
    function zTexto(box) {
      var f = S.form, s = el('section', 'mv-sec'), h = el('div', 'mv-sec-h'), lb = el('label', 'mv-h2', 'O que precisamos do cliente'); lb.htmlFor = 'c-bc-txt'; h.appendChild(lb); s.appendChild(h);
      var fr = el('div', 'mv-chips envolve mv-frases'); fr.id = 'bz-frases'; fr.setAttribute('role', 'group'); fr.setAttribute('aria-label', 'Frases de um toque');
      var ta = el('textarea', 'mv-campo curto' + (f.tentou && !String(f.precisa).trim() ? ' tentou' : ''));
      B.FRASES.forEach(function (frase, i) { var b = bt('mv-chip', frase); b.setAttribute('data-k', 'frase-' + i); b.addEventListener('click', function () { f.precisa = B.alternarFrase(f.precisa, frase); ta.value = f.precisa; ta.classList.remove('tentou'); marcarFrases(); desenharBarraForm(); }); fr.appendChild(b); });
      s.appendChild(fr);
      ta.id = 'c-bc-txt'; ta.value = f.precisa; ta.maxLength = B.LIMITES.precisa; ta.placeholder = 'Ou escreve, ou dita.'; ta.setAttribute('autocapitalize', 'sentences'); ta.spellcheck = true; ta.setAttribute('data-k', 'texto');
      ta.addEventListener('input', function () { f.precisa = ta.value; ta.classList.remove('tentou'); marcarFrases(); desenharBarraForm(); });
      s.appendChild(ta); box.appendChild(s); marcarFrases();
    }
    function zTfs(box) {
      var f = S.form, s = K.seccao('Trabalhos parados por isto', f.tfs.length ? String(f.tfs.length) : 'Opcional', 'h-tfs-bc'), l = tfLista(f.obraId);
      if (!l) { s.appendChild(el('p', 'mv-lead mv-bc-lead', K.online() ? 'A ler os trabalhos desta obra…' : 'Sem rede: os trabalhos desta obra vêem-se com rede.')); box.appendChild(s); return; }
      var ts = B.tfsDaLoc(l, f.loc);
      f.tfs.forEach(function (id) { if (!ts.some(function (t) { return t.id === id; })) { var t = l.filter(function (x) { return x.id === id; })[0]; if (t) ts.unshift(t); } });   // o que veio marcado de fora fica à vista
      if (!ts.length) s.appendChild(el('p', 'mv-lead mv-bc-lead', 'Nenhum por agora' + (f.loc ? ' nesta localização' : ' sem localização') + '.'));
      ts.forEach(function (t) {
        var on = f.tfs.indexOf(t.id) >= 0, b = bt('mv-lo mv-lo-v'); b.setAttribute('aria-pressed', String(on)); b.setAttribute('data-k', 'tf-' + t.id);
        var c = el('span', 'mv-chk'); c.setAttribute('aria-hidden', 'true'); c.appendChild(ic('ok'));
        var n = el('span', 'mv-lo-n', t.texto); var p = T.palavra(t, hoje()); n.appendChild(el('small', null, p.p + (p.f ? ' · ' + p.f : '')));
        junta(b, c, n);
        b.addEventListener('click', function () { var i = f.tfs.indexOf(t.id); if (i >= 0) f.tfs.splice(i, 1); else f.tfs.push(t.id); zona('tfs'); });
        s.appendChild(b);
      });
      box.appendChild(s);
    }
    function desenharBarraForm() {
      var box = $('barra-bc'); if (!box || !S.form) return;
      limpar(box);
      var f = S.form, fl = B.faltaForm(Object.assign({}, f, { aPreparar: !!f.aPreparar }), !!K.obraDe(f.obraId)), nota = el('p', 'mv-barra-nota'), txt, nomeIc;
      if (K.semArmazem()) { nomeIc = 'alerta'; txt = 'Neste telemóvel não consigo guardar: não feches esta página'; nota.classList.add('falta'); }
      else if (fl && (f.tentou || fl.espera)) { nomeIc = fl.espera ? 'relogio' : 'alerta'; txt = fl.texto; nota.classList.add('falta'); if (f.tentou && !fl.espera) nota.classList.add('tentou'); }
      else if (!K.online()) { nomeIc = 'semrede'; txt = 'Sem rede: fica guardado e segue sozinho'; }
      else if (!K.A.sessaoValida()) { nomeIc = 'relogio'; txt = 'Sessão acabada: guarda e entra outra vez'; }
      if (txt) { nota.appendChild(ic(nomeIc)); nota.appendChild(el('span', null, txt)); box.appendChild(nota); }
      var b = bt('mv-btn pri', fl && !fl.espera ? fl.texto : (podePlanearObra(f.obraId) ? 'Registar bloqueio do cliente' : 'Sugerir bloqueio do cliente')); b.id = 'b-bc';
      b.setAttribute('aria-disabled', fl ? 'true' : 'false'); b.addEventListener('click', registar); box.appendChild(b);
      K.A.medirBarra();
      mexeu();
    }
    var aRegistar = false;
    async function registar() {
      var f = S.form; if (!f || aRegistar) return;
      var fl = B.faltaForm(Object.assign({}, f, { aPreparar: !!f.aPreparar }), !!K.obraDe(f.obraId));
      if (fl) { f.tentou = true; desenharBarraForm(); zona('texto'); if (fl.campo === 'obra') folhaObraForm(); else if (fl.campo === 'precisa') { var ta = $('c-bc-txt'); if (ta) ta.focus(); } return; }
      aRegistar = true;
      try {
        var s = K.sessao(), textos = (tfLista(f.obraId) || []).filter(function (t) { return f.tfs.indexOf(t.id) >= 0; }).map(function (t) { return t.texto; });
        var item = B.itemComando({ accao: 'criar', bc: { id: B.novoIdBc(K.novoId), obraId: f.obraId }, obraId: f.obraId, campos: B.camposCriar(f), fotos: f.fotos, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId, planeia: podePlanearObra(f.obraId) });
        item.fotos.forEach(function (x, i) { if (f.fotos[i] && f.fotos[i].prev) x.prev = f.fotos[i].prev; });
        await porNaFila(item);
        clearTimeout(tRasc); tRasc = null; apagarRascunho(f.rid);   // já está na fila: o rascunho sai
        guardarUltima(f.obraId, f.loc);
        S.envio = { item: item, fase: 'a-enviar', loc: f.loc, nTfs: f.tfs.length, textos: textos };
        S.form = null;
        if (!K.A.sessaoValida()) { S.envio.fase = 'guardado'; S.envio.mensagem = 'Guardado no telemóvel · entra outra vez para seguir.'; K.abrir('v-bc-envio', true); K.A.pedirLogin('Guardado no telemóvel · entra outra vez para seguir.'); return; }
        K.abrir('v-bc-envio', true);
        K.drenar(true);
      } finally { aRegistar = false; }
    }

    // ── Registado (v-bc-envio) ──
    function desenharEnvio() {
      var v = $('v-bc-envio'); if (!v || !S.envio) return;
      limpar(v);
      var e = S.envio, it = e.item, o = K.obraDe(it.obraId), fase = e.fase, selo = el('div', 'mv-selo'), planeia = e.registo ? e.registo.estado !== 'POR_CONFIRMAR' : !!it.planeia;
      selo.setAttribute('role', 'img');
      if (fase === 'a-enviar') { selo.className = 'mv-selo nav'; selo.setAttribute('aria-label', 'A enviar'); var sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sv.setAttribute('class', 'mv-roda'); sv.setAttribute('viewBox', '0 0 72 72'); sv.setAttribute('aria-hidden', 'true'); var ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); ci.setAttribute('cx', '36'); ci.setAttribute('cy', '36'); ci.setAttribute('r', '34'); sv.appendChild(ci); selo.appendChild(sv); selo.appendChild(ic('subir')); }
      else if (fase === 'guardado') { selo.className = 'mv-selo ama'; selo.setAttribute('aria-label', 'Guardado no telemóvel'); selo.appendChild(ic(K.semArmazem() ? 'alerta' : 'tel')); }
      else if (fase === 'parado') { selo.className = 'mv-selo neg'; selo.setAttribute('aria-label', 'Não entrou'); selo.appendChild(ic('alerta')); }
      else { selo.setAttribute('aria-label', planeia ? 'Registado' : 'Sugerido'); selo.appendChild(ic('ok')); }
      v.appendChild(selo);
      var est = el('div', 'mv-env-estado'); est.setAttribute('aria-live', 'polite'); est.setAttribute('aria-atomic', 'true');
      var t = el('h1', 'mv-env-t'); t.id = 'bc-e-titulo'; t.tabIndex = -1; t.setAttribute('data-foco-inicial', '');
      var sub = el('p', 'mv-env-s');
      if (fase === 'a-enviar') { t.textContent = 'A enviar…'; sub.textContent = 'Não feches a app até chegar a confirmação.'; }
      else if (fase === 'guardado') { t.textContent = K.semArmazem() ? 'Por enviar' : 'Guardado no telemóvel'; sub.textContent = K.semArmazem() ? 'Neste telemóvel não consigo guardar: não feches esta página. Segue quando houver rede.' : (e.mensagem && !e.rede ? e.mensagem : 'Segue sozinho quando houver rede, com a app aberta.'); }
      else if (fase === 'parado') { t.textContent = 'Não entrou'; sub.textContent = e.mensagem || it.erro || ''; }
      else { t.textContent = planeia ? 'Registado' : 'Sugerido'; sub.textContent = planeia ? 'Por formalizar · o GP formaliza no computador' : 'Por confirmar · o DO ou o GP confirma'; }
      est.appendChild(t); est.appendChild(sub); v.appendChild(est);
      (it.avisos || []).forEach(function (a) { var p = el('p', 'mv-erro ama'); p.appendChild(ic('alerta')); p.appendChild(el('span', null, a)); v.appendChild(p); });
      var lista = el('div', 'mv-lista'), nT = e.registo ? (e.registo.trabalhos || []).length : e.nTfs;
      lista.appendChild(K.rlinha('Precisamos do cliente', (it.campos && it.campos.precisa) || ''));
      lista.appendChild(K.rlinha('Onde', (o ? o.codigo + ' · ' : '') + B.locTitulo(e.loc)));
      lista.appendChild(K.rlinha('Trabalhos parados', nT ? String(nT) : 'Nenhum por agora'));
      var fs = (it.fotos || []).filter(function (x) { return x.blob || x.prev; });
      if (fs.length) { var mi = el('b', 'mv-minis'); fs.forEach(function (x, i) { var im = el('img'); im.alt = 'Foto ' + (i + 1); im.src = x.prev || urlLocal(x); mi.appendChild(im); }); lista.appendChild(K.rlinha('Foto', mi)); }
      v.appendChild(lista);
      var bb = limpar($('barra-bc-env'));
      var bv = bt('mv-btn pri', 'Ver os bloqueios'); bv.id = 'b-bc-ver'; bv.addEventListener('click', function () { var ob = it.obraId; S.envio = null; abrirLista(ob, true); });
      var bf = bt('mv-btn ghost', 'Feito'); bf.id = 'b-bc-feito'; bf.addEventListener('click', function () { S.envio = null; K.irHoje(true); });
      bb.appendChild(bv); bb.appendChild(bf);
      K.A.medirBarra();
    }

    // ── O envio (chamado pelo drenar da casca, item a item) ──
    function processar(q) { return B.processarBc(q, deps()); }
    async function aoResultado(q, res) {
      var ch = K.cache();
      if (res.estado === 'entregue' && q.registo) {
        var r = JSON.parse(JSON.stringify(q.registo));
        (r.fotos || []).forEach(function (f) { var l = (q.fotos || []).filter(function (x) { return x.n === f.n; })[0]; if (l && l.estado === 'confirmada' && f.estado === 'por-enviar') f.estado = 'por-arquivar'; });
        B.porRegisto(ch, r); K.gravarCache(); K.marcarReler();
        if ((q.tfLigados && q.tfLigados.length) || MEXEM_TF.indexOf(q.accao) >= 0) lerTfs(q.obraId);   // os trabalhos ligados mudaram
        if (q.accao !== 'criar' && q.avisos && q.avisos.length) K.toast(q.avisos[0], { ms: 4000 });
      }
      if (res.estado === 'parar' && q.motivo === 'outro-fechado') { K.toast((q.resumo ? q.resumo + ': ' : '') + q.erro, { ms: 6000 }); lerTfs(q.obraId); }   // o trabalho a ligar já fechou
      if (res.estado === 'conflito') {   // o bloqueio relê-se; diz-se o que mudou e quem (o que se escreveu fica na fila)
        await lerLista(q.obraId);
        var x = B.listaDe(K.cache(), q.obraId), reg = x ? (x.data.bloqueios || []).filter(function (b) { return b.id === q.registoId; })[0] : null;
        q.erro = B.textoConflito(reg, res.conflito && res.conflito.estado); K.guardarItem(q);
        K.toast((q.resumo ? q.resumo + ': ' : '') + q.erro, { ms: 6000 });
      }
      if (S.envio && S.envio.item.id === q.id) {
        S.envio.fase = res.estado === 'entregue' ? 'feito' : (res.estado === 'parar' || res.estado === 'conflito' ? 'parado' : 'guardado');
        S.envio.mensagem = res.mensagem; S.envio.rede = !!res.rede; if (q.registo) S.envio.registo = q.registo;
        if (K.vista() === 'v-bc-envio') desenharEnvio();
      }
      redesenharLista(); redesenharFolha();
    }
    /** Um comando de um TRABALHO que mexe nas ligações (o «Desbloquear (N)», um bloqueio pelo cliente): a lista relê-se. */
    function aoTrabalho(q, res) {
      var x = B.listaDe(K.cache(), q.obraId);
      if (res.estado !== 'entregue' || MEXEM_BC.indexOf(q.accao) < 0 || !x) return;
      // a cópia acerta-se já com o que o servidor respondeu ao trabalho (sem ligação ao cliente, sai dos bloqueios): sem isto,
      // entre a entrega e a releitura o resolvido voltava a «por desbloquear» por um instante (revisão da parte 4)
      var reg = q.registo, ids = reg && reg.bloqueio ? (reg.bloqueio.bloqueiosCliente || []) : [];
      if (reg) (x.data.bloqueios || []).forEach(function (b) {
        var i = (b.trabalhos || []).indexOf(reg.id); if (i < 0 || ids.indexOf(b.id) >= 0) return;
        b.trabalhos.splice(i, 1); if (b.estado === 'RESOLVIDO') b.porDesbloquear = b.trabalhos.length;
      });
      lerLista(q.obraId);
    }
    /** A linha do «Por enviar». */
    function linhaFila(q, emCurso) {
      var o = K.obraDe(q.obraId), parado = q.estado === 'parado', adiado = q.adiadoAte && q.adiadoAte > new Date().toISOString();
      var est = parado ? (q.erro || 'Não entrou') : (emCurso ? 'A enviar…' : (adiado ? 'Segue daqui a nada' : (!K.A.sessaoValida() ? 'À espera de entrares' : (!K.online() ? 'À espera de rede' : (q.erro || 'Na fila')))));
      var acoes = [];
      if (parado && (q.motivo === 'conflito' || q.motivo === 'outro-fechado')) acoes.push(['chev', 'Ver o bloqueio', function () { abrirLista(q.obraId); }]);
      else if (parado && q.motivo !== 'dia-fechado' && q.motivo !== 'externa') acoes.push(['atual', 'Tentar de novo', function () { q.estado = 'a-enviar'; q.erro = ''; K.guardarItem(q); K.drenar(true); }]);
      else if (!parado) acoes.push(['atual', 'Tentar agora', function () { if (!K.A.sessaoValida()) { K.A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); return; } q.adiadoAte = ''; K.drenar(true); }]);
      return { ic: 'obra', titulo: B.tituloItem(q) + (o ? ' · ' + o.codigo : ''), resumo: B.resumoItem(q), estado: est, cls: parado ? 'neg' : null, acoes: acoes, apagar: parado };
    }

    // ── Hoje: o bloco Cliente abre a lista (várias obras: primeiro a obra) ──
    function folhaObras(ms) {
      var l = (ms || []).filter(function (m) { return m.cliente; });
      K.folha({ titulo: 'Bloqueios do cliente', sub: 'Escolhe a obra', corpo: function (cc) {
        l.forEach(function (m) {
          var b = bt('mv-lo mv-lo-ir'); b.setAttribute('data-obra', m.id);
          var n = el('span', 'mv-lo-n', m.nome), c = m.cliente, pc = [];
          pc.push(pl((Number(c.ativos) || 0) + (Number(c.resolvidosComTrabalhos) || 0), 'ativo', 'ativos'));   // a população do bloco e do «Ativos» da lista
          if (c.semResposta) pc.push(c.semResposta + ' sem resposta'); if (c.porConfirmar) pc.push(c.porConfirmar + ' por confirmar'); if (c.resolvidosComTrabalhos) pc.push(c.resolvidosComTrabalhos + ' por desbloquear');
          n.appendChild(el('small', null, pc.join(' · ')));
          junta(b, el('code', null, m.codigo), n, ic('chev'));
          b.addEventListener('click', function () { K.A.fecharFolhas(true); abrirLista(m.id); });
          cc.appendChild(b);
        });
      } });
    }

    function ligar() {
      var on = function (id, fn) { var i = $(id); if (i) i.addEventListener('change', function (ev) { Promise.resolve(fn(ev.target.files)).then(function () { ev.target.value = ''; }); }); };
      on('b-cam', juntarFotos); on('b-gal', juntarFotos); on('b-mais', fotoMais);
    }
    function aoSair() { gravarRascunhoJa(); lidosFaixa = {}; Object.keys(S.urls).forEach(function (k) { if (S.urls[k] && S.urls[k] !== 'arquivada' && URL.revokeObjectURL) URL.revokeObjectURL(S.urls[k]); }); S = novo(); }

    return {
      VISTAS: ['v-bc', 'v-bc-form', 'v-bc-envio'], ROTULO: { 'v-bc': 'Bloqueios', 'v-bc-form': 'Bloqueio', 'v-bc-envio': 'Bloqueio' },
      TITULO: { 'v-bc': 'Bloqueios do cliente', 'v-bc-form': 'Bloqueio do cliente', 'v-bc-envio': 'Bloqueio do cliente' },
      disponivel: disponivel, motivoFora: function () { return S.fora; }, abrirLista: abrirLista, abrirForm: abrirForm, abrirBc: abrirBc, folhaObras: folhaObras,
      carregarRascunhos: carregarRascunhos, gravarRascunhoJa: gravarRascunhoJa, temRascunho: function () { return meusRascunhos().length > 0; }, linhasRascunho: linhasRascunho,
      porConfirmarParaMim: porConfirmarParaMim,
      desenhar: function (v) { if (v === 'v-bc') desenharLista(); else if (v === 'v-bc-form') desenharForm(); else if (v === 'v-bc-envio') desenharEnvio(); },
      temForm: function () { return !!S.form; }, temEnvio: function () { return !!S.envio; },
      processar: processar, aoResultado: aoResultado, aoTrabalho: aoTrabalho, linhaFila: linhaFila, redesenhar: function () { redesenharLista(); },
      ligar: ligar, aoSair: aoSair, _estado: function () { return S; },
    };
  }
  self.DoeMovelBcEcra = { criar: criar };
}());
