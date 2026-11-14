/* DOE · Telemóvel — os ecrãs dos Trabalhos em falta (fatia 2a, parte 2, 13 nov 2026): a lista por Localização (a partir
   do bloco Trabalhos do Hoje), o trabalho aberto numa folha, o dia previsto, o bloqueio (por quem bloqueia; o do cliente
   liga-se a um que já existe ou nasce no servidor), o «feito» com Desfazer e a foto do depois, e o formulário de registo
   (foto, o que falta, Localização, «está bloqueado»), com «Outro» igual ao da última vez.
   Desenho: os ecrãs «Trabalhos em falta» do protótipo validado DOEX-Telemovel-App-Prototipo.html. A lógica é a de
   trabalhos.js (pura, testada em Node e contra o servidor real); a casca (casca.js) dá-me o kit (`K`: DOM, folhas,
   avisos, navegação, a cache da conta, a fila única e o envio). Regras:
   - tudo o que vem do servidor entra por textContent; os botões que se mostram são os do `pode` do servidor (nenhuma
     regra de permissões aqui); a página do ecrã mostra a cópia do servidor com os comandos por enviar por cima;
   - cada acção é um COMANDO na fila da conta; as que têm Desfazer só seguem depois de o aviso acabar (adiadoAte);
     sem rede ficam «por enviar» e seguem sozinhas;
   - as fotos do servidor lêem-se a pedido (GET /movel/fotos/url → bytes → endereço local), em memória: nunca no disco;
   - uma conta externa e um servidor sem a 2a não chegam aqui (o Hoje novo é a porta); se o servidor o disser depois,
     diz-se em linguagem de obra e a entrada sai.
   Fecho da 2a (parte 4, 13 nov 2026): o formulário guarda-se em disco como rascunho (molde do diário: por conta, a cada
   alteração, sai ao enviar; mais de 7 dias sai do telemóvel); «Corrigir» o texto e a Localização na folha, pelo `pode`; o
   «Novo bloqueio do cliente» de um trabalho leva a foto dele para o formulário do bloqueio (blobFoto). */
(function () {
  'use strict';
  var T = self.DoeMovelTf, D = self.DoeMovelDiario;
  if (!T || !D) return;
  var ADIAR = self.DOE_MOVEL_TF_ADIAR || 5000, ADIAR_FOTO = 60000;   // o Desfazer: o aviso e o comando esperam o mesmo (os testes encurtam-no)
  var QUEM_ROT = ['Cliente', 'DOE', 'Subempreiteiro', 'Fornecedor', 'Outro'], QUEM_COD = { Cliente: 'CLIENTE', DOE: 'DOE', Subempreiteiro: 'SUB', Fornecedor: 'FORNECEDOR', Outro: 'OUTRO' };

  function criar(K) {
    var S = { obra: '', filtro: 'fazer', lendo: false, erro: '', fora: '', form: null, envio: null, feitoTmp: {}, urls: {}, pedidosUrl: {}, bq: null, sel: '' };
    var el = K.el, bt = K.bt, ic = K.ic, junta = K.junta, limpar = K.limpar, $ = function (id) { return document.getElementById(id); };
    var R = {}, tRasc = null;   // os rascunhos em disco (de todas as contas deste telemóvel; cada um diz a sua), por id
    function hoje() { return K.hojeDia().dia; }
    function eu() { var s = K.sessao(); return { nome: (s && s.nome) || '' }; }
    function minhaFila() { return K.fila().filter(function (q) { return q.contaId === K.contaId() && q.estado !== 'entregue' && !K.apagar[q.id]; }); }
    function deps() {
      var dp = K.deps(), conta = K.contaId();
      dp.aoGravado = function (item, data) { if (K.contaId() !== conta || !data.registo) return; T.porRegisto(K.cache(), data.registo); K.gravarCache(); };
      return dp;
    }
    /** Pode entrar? A funcionalidade no servidor (Edge ∩ SQL), o Hoje novo a responder (a conta é interna) e o servidor
        sem ter dito «não» nesta abertura. */
    function disponivel() { return K.tem('trabalhos') && K.temHojeMv() && !S.fora; }

    // ── Localizações da obra (as do diário: GET /movel/obras/localizacoes, na cache da conta) ──
    function locsDe(ob) {
      var lc = K.cache().locs[ob], l = [];
      ((lc && lc.produtos) || []).forEach(function (p) { (p.localizacoes || []).forEach(function (x) { l.push({ issueId: x.id, codigo: x.codigo || '', nome: x.nome || '', produto: p.nome || '' }); }); });
      return l;
    }
    function locDe(ob) { return function (id) { return locsDe(ob).filter(function (x) { return x.issueId === id; })[0] || null; }; }
    function ultimaLoc(ob) { var u = K.cache().tfUlt && K.cache().tfUlt[ob]; return u && locsDe(ob).some(function (x) { return x.issueId === u.issueId; }) ? u : null; }
    function guardarUltima(ob, loc) { var ch = K.cache(); if (!ch.tfUlt || typeof ch.tfUlt !== 'object') ch.tfUlt = {}; if (loc) ch.tfUlt[ob] = loc; else delete ch.tfUlt[ob]; K.gravarCache(); }

    // ── Leitura ──
    async function lerLista(ob) {
      if (!ob || !K.A.sessaoValida() || !K.online()) { redesenharLista(); return false; }
      var conta = K.contaId();
      S.lendo = true; redesenharLista();
      try {
        var r = await T.lerLista(deps(), ob);
        if (K.contaId() !== conta) return false;
        if (r.ok) { T.guardarLista(K.cache(), ob, r.data); K.gravarCache(); S.erro = ''; return true; }
        return falhou(r);
      } finally { S.lendo = false; redesenharLista(); }
    }
    async function lerBcs(ob) {
      if (!K.A.sessaoValida() || !K.online()) return false;
      var conta = K.contaId(), r = await T.lerBcs(deps(), ob);
      if (K.contaId() !== conta) return false;
      if (r.ok) { T.bcsGuardar(K.cache(), ob, r.data); K.gravarCache(); return true; }
      falhou(r); return false;
    }
    function falhou(r) {
      var m = T.mensagemTf(r);
      if (r.code === 'TOKEN_DE_AMBITO') { S.fora = m.texto; S.erro = ''; return false; }   // a Edge de antes (recuada): a entrada sai, sem pedir o login
      if (K.talvezLogin(D.mensagemDiario(r))) return false;
      if (r.code === 'CONTA_EXTERNA' || r.code === 'MOVEL_FATIA2_POR_INSTALAR' || (r.status === 403 && r.code !== 'PAPEL_SEM_ESCRITA')) S.fora = m.texto;   // a entrada sai nesta abertura
      S.erro = r.rede ? '' : m.texto;
      return false;
    }

    // ── A lista (v-tf) ──
    function abrirLista(ob, substituir) {
      if (!ob) return;
      S.obra = ob; S.filtro = 'fazer';
      if (!K.cache().locs[ob]) K.lerLocsAgora(ob).then(redesenharLista);
      K.abrir('v-tf', !!substituir);
      lerLista(ob);
    }
    function trabalhos() {
      var x = T.listaDe(K.cache(), S.obra), l = x ? (x.data.trabalhos || []) : [];
      var fila = minhaFila().filter(function (q) { return !(q.accao === 'feito' && S.feitoTmp[q.registoId]); });   // o feito com Desfazer ainda à vista fica no sítio, riscado
      return T.comPendentes(l, fila, S.obra, hoje(), eu(), locDe(S.obra));
    }
    function redesenharLista() { if (K.vista() === 'v-tf' && K.A.vista() === 'v-tf') desenharLista(); }
    function desenharLista() {
      var v = $('v-tf'); if (!v) return;
      var ae = document.activeElement, k = ae && v.contains(ae) ? ae.getAttribute('data-k') : null;
      limpar(v);
      var o = K.obraDe(S.obra), x = T.listaDe(K.cache(), S.obra), h = hoje();
      var lead = el('p', 'mv-lead'); lead.tabIndex = -1; lead.setAttribute('data-foco-inicial', '');
      if (o) junta(lead, el('code', null, o.codigo || ''), ' · ' + o.nome);
      var est = S.lendo ? (x ? ' · a atualizar…' : ' · a ler…') : (x && (!K.online() || /^de /.test(D.textoDados(x.lidoEm, new Date()))) ? ' · dados ' + D.textoDados(x.lidoEm, new Date()) : '');
      if (est) lead.appendChild(document.createTextNode(est));
      v.appendChild(lead);
      if (S.erro) { var fe = el('div', 'mv-faixa ama'); fe.setAttribute('role', 'status'); fe.appendChild(ic('alerta')); fe.appendChild(el('span', 'mv-faixa-t', S.erro)); v.appendChild(fe); }
      if (!x) { v.appendChild(el('p', 'mv-nada', S.lendo || (K.online() && K.A.sessaoValida()) ? 'A ler os trabalhos desta obra…' : 'Ainda não tenho os trabalhos desta obra neste telemóvel: aparecem quando houver rede.')); return; }
      var lst = trabalhos(), s = T.contas(lst, h), sg = T.segs(s);
      if (s.abertos) { var sv = el('div', 'mv-sumv'); sv.appendChild(K.barra20(sg)); var lg = el('span', 'mv-leg linha'); sg.forEach(function (z) { var it = el('span'); it.appendChild(el('i', z[0])); it.appendChild(el('b', null, String(z[1]))); it.appendChild(document.createTextNode(' ' + z[2])); lg.appendChild(it); }); sv.appendChild(lg); v.appendChild(sv); }
      var sec = el('section', 'mv-sec pri mv-tf-segm'), seg = el('div', 'mv-segm'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Estado');
      [['fazer', 'Por fazer'], ['bloq', 'Bloqueados'], ['feito', 'Feitos']].forEach(function (f) { var b = bt('', f[1]); b.setAttribute('aria-pressed', String(S.filtro === f[0])); b.setAttribute('data-k', 'f-' + f[0]); b.addEventListener('click', function () { S.filtro = f[0]; desenharLista(); }); seg.appendChild(b); });
      sec.appendChild(seg); v.appendChild(sec);
      var gl = T.grupos(lst, S.filtro, h);   // o feito com Desfazer ainda à vista fica no grupo de onde saiu (riscado)
      if (!gl.length) { v.appendChild(el('p', 'mv-nada', S.filtro === 'feito' ? 'Ainda nada feito.' : (S.filtro === 'bloq' ? 'Nada bloqueado.' : 'Nada por fazer nesta obra.'))); }
      gl.forEach(function (g) {
        var gs = el('section', 'mv-sec mv-lista-t'), gh = el('div', 'mv-sec-h'); gh.appendChild(el('h2', null, g.titulo)); gh.appendChild(el('span', 'mv-sec-m', String(g.itens.length))); gs.appendChild(gh);
        g.itens.forEach(function (t) { gs.appendChild(linha(t)); });
        v.appendChild(gs);
      });
      if (x.data.cortado) v.appendChild(el('p', 'mv-folha-txt', 'A mostrar ' + (x.data.trabalhos || []).length + ' de ' + x.data.total + '. Os outros vêem-se no computador.'));
      if (k) { var y = v.querySelector('[data-k="' + k + '"]'); if (y) K.A.focar(y); }
      carregarMinis(v);
    }
    function linha(t) {
      var orig = t, p = T.palavra(orig, hoje()), tmp = !!S.feitoTmp[t.id], feito = !!orig.feitoEm && !tmp;
      var d = el('div', 'mv-tl' + (tmp ? ' feita' : '') + (feito ? ' val' : ''));
      if (feito || (orig.porEnviar && !tmp)) { var e = el('span', 'mv-tl-esp'); e.setAttribute('aria-hidden', 'true'); e.appendChild(ic(feito ? 'ok' : 'relogio')); d.appendChild(e); }
      else if ((orig.pode || []).indexOf('feito') >= 0 || tmp) {
        var ok = bt('mv-tl-ok'); ok.setAttribute('aria-pressed', String(tmp)); ok.setAttribute('aria-label', 'Feito: ' + t.texto); ok.setAttribute('data-k', 'ok-' + t.id);
        var c = el('span', 'mv-circ'); c.appendChild(ic('ok')); ok.appendChild(c); ok.addEventListener('click', function () { marcarFeito(t.id); }); d.appendChild(ok);
      } else { var e2 = el('span', 'mv-tl-esp'); e2.setAttribute('aria-hidden', 'true'); d.appendChild(e2); }
      var b = bt('mv-tl-t'); b.setAttribute('data-k', 't-' + t.id);
      b.appendChild(mini(orig));
      var tx = el('span', 'mv-tf-tx'); tx.appendChild(el('b', null, t.texto));
      var sm = el('small'); sm.appendChild(el('span', p.c, p.p)); if (p.f) sm.appendChild(document.createTextNode(' · ' + p.f));
      if (orig.porEnviar) sm.appendChild(document.createTextNode(' · por enviar'));
      if (orig.comErro) { sm.appendChild(document.createTextNode(' · ')); sm.appendChild(el('span', 'mv-tf-erro', 'não entrou')); }
      tx.appendChild(sm); b.appendChild(tx);
      b.addEventListener('click', function () { abrirTrabalho(t.id); });
      d.appendChild(b);
      return d;
    }
    function trabalhoDe(id) { return trabalhos().filter(function (t) { return t.id === id; })[0] || null; }

    // ── As fotos: as que ainda estão neste telemóvel (a fila) e as do servidor, lidas a pedido, em memória ──
    function blobLocal(id, n) { var f = null; minhaFila().forEach(function (q) { if (q.registoId === id) (q.fotos || []).forEach(function (x) { if (x.n === n && x.blob) f = x; }); }); return f; }
    function urlLocal(f) { if (!f.prev && URL.createObjectURL) f.prev = URL.createObjectURL(f.blob); return f.prev || ''; }
    async function urlFoto(id, n) {
      var k = id + '|' + n; if (S.urls[k]) return S.urls[k];
      if (S.pedidosUrl[k]) return S.pedidosUrl[k];
      S.pedidosUrl[k] = (async function () {
        if (!K.online() || !K.A.sessaoValida()) return '';
        var r = await T.urlFoto(deps(), id, n);
        if (!r.ok) { if (r.status === 410) S.urls[k] = 'arquivada'; return S.urls[k] || ''; }
        try { var res = await fetch(r.data.url); if (!res.ok) return ''; var b = await res.blob(); S.urls[k] = URL.createObjectURL(b); return S.urls[k]; } catch (e) { return ''; }
      }());
      try { return await S.pedidosUrl[k]; } finally { delete S.pedidosUrl[k]; }
    }
    /** Os bytes de uma foto de um trabalho (para o bloqueio do cliente novo): a deste telemóvel, ou a do servidor lida agora.
        → { blob, (sha256, tipo, tamanho: só a deste telemóvel) } ou { erro: 'arquivada' | 'rede' | 'outro-telemovel' | 'falhou' }. */
    async function blobFoto(id, n, estado) {
      var lb = blobLocal(id, n); if (lb && lb.blob) return { blob: lb.blob, sha256: lb.sha256, tipo: lb.tipo, tamanho: lb.tamanho };
      if (estado === 'arquivada') return { erro: 'arquivada' };
      if (estado === 'por-enviar') return { erro: 'outro-telemovel' };
      if (!K.online() || !K.A.sessaoValida()) return { erro: 'rede' };
      var r = await T.urlFoto(deps(), id, n);
      if (!r.ok) return { erro: r.status === 410 ? 'arquivada' : (r.rede ? 'rede' : 'falhou') };
      try { var res = await fetch(r.data.url); if (!res.ok) return { erro: 'falhou' }; return { blob: await res.blob() }; } catch (e) { return { erro: 'rede' }; }
    }
    function primeiraFoto(t, papel) { return (t.fotos || []).filter(function (f) { return (f.papel || 'antes') === (papel || 'antes'); })[0] || null; }
    function mini(t) {
      var f = primeiraFoto(t) || primeiraFoto(t, 'depois'), m = el('span', 'mv-tf-mini'); m.setAttribute('aria-hidden', 'true');
      if (!f) { m.appendChild(ic('falta')); return m; }
      var lb = blobLocal(t.id, f.n), u = lb ? urlLocal(lb) : S.urls[t.id + '|' + f.n];
      if (u && u !== 'arquivada') { var img = el('img', 'mv-tf-mini'); img.alt = ''; img.src = u; return img; }
      m.appendChild(ic('gal')); if (!u && f.estado === 'por-arquivar') { m.setAttribute('data-foto', t.id + '|' + f.n); }
      return m;
    }
    /** As miniaturas da lista: no máximo 8 por desenho, uma a uma (o limite de leituras é partilhado com o diário). */
    async function carregarMinis(v) {
      var ps = Array.prototype.slice.call(v.querySelectorAll('[data-foto]'), 0, 8);
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i].getAttribute('data-foto').split('|'), u = await urlFoto(p[0], Number(p[1]));
        if (u && u !== 'arquivada' && ps[i].isConnected) { var img = el('img', 'mv-tf-mini'); img.alt = ''; img.src = u; ps[i].replaceWith(img); }
      }
    }

    // ── O trabalho aberto (folha) ──
    /** A folha de um trabalho a partir de outro ecrã (a folha de um bloqueio do cliente): só se a lista dos trabalhos de
        outra obra não estiver à vista. */
    function abrirTrabalhoDe(ob, id) { if (ob !== S.obra) { if (K.vista() === 'v-tf') return; S.obra = ob; } abrirTrabalho(id); }
    function abrirTrabalho(id) {
      var t = trabalhoDe(id); if (!t) return;
      S.sel = id;
      K.folha({ alta: true, titulo: t.texto, sub: ((K.obraDe(t.obraId) || {}).codigo || '') + ' · ' + T.locTitulo(t.localizacao), corpo: function (cc) { corpoTrabalho(cc, t); }, pe: function (p) { peTrabalho(p, t); } });
      // o estado do bloqueio do cliente ligado lê-se a pedido (a lista dos bloqueios da obra), e a folha acerta-se
      if (t.bloqueio && (t.bloqueio.bloqueiosCliente || []).length && !T.bcsDe(K.cache(), t.obraId)) lerBcs(t.obraId).then(function (ok) { var c = $('fx-c'); if (ok && c && S.sel === id && $('folha-casca').open) { limpar(c); corpoTrabalho(c, t); } });
    }
    /** Uma linha rótulo · valor; com cls, só a palavra do estado leva a cor e o resto (o facto) fica a tinta, como no protótipo. */
    function rl(rot, val, cls, resto) { var d = el('div', 'mv-rl'); d.appendChild(el('span', null, rot)); var b = el('b'); if (cls) { b.appendChild(el('i', cls, val)); if (resto) b.appendChild(document.createTextNode(' · ' + resto)); } else b.textContent = val; d.appendChild(b); return d; }
    /** As acções de uma foto (13 nov 2026, liberdade de corrigir): Tirar (quem a tirou, antes do arquivo) e Retirar (o DO ou o
        GP, já arquivada), SÓ pelo `pode` da foto. Um comando na fila, com o Desfazer de sempre. Serve também os bloqueios. */
    function accoesFoto(cel, reg, f, fazer) {
      var pf = f.pode || [], a = pf.indexOf('tirar') >= 0 ? 'tirar' : (pf.indexOf('retirar') >= 0 ? 'retirar' : '');
      if (!a || reg.porEnviar) return false;
      var b = bt('mv-link mv-foto-acc'); b.setAttribute('data-k', 'foto-' + a + '-' + f.n); b.appendChild(ic(a === 'tirar' ? 'x' : 'lixo'));
      b.appendChild(document.createTextNode(a === 'tirar' ? 'Tirar esta foto' : 'Retirar esta foto'));
      b.addEventListener('click', function () { K.fecharFolha(); fazer('foto-' + a, { n: f.n }, a === 'tirar' ? 'Foto tirada' : 'Foto retirada · fica nos documentos da obra'); });
      cel.appendChild(b);
      return a === 'tirar';
    }
    function notaFotos(cc, tira) { if (tira) cc.appendChild(el('p', 'mv-folha-txt mv-foto-nota', 'Uma foto sai enquanto não estiver arquivada; depois, só o DO ou o GP a retiram.')); }
    /** Anular pede confirmação (13 nov 2026); depois, o comando segue com o Desfazer de sempre. o: { titulo, texto, botao, fazer }. */
    function folhaConfirmar(o) {
      K.folha({ titulo: o.titulo, sub: o.sub || '', corpo: function (cc) { cc.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', o.texto)); },
        pe: function (p) { var b = bt('mv-btn neg', o.botao); b.id = 'b-confirmar'; b.addEventListener('click', function () { K.fecharFolha(); o.fazer(); }); p.appendChild(b); } });
    }
    function corpoTrabalho(cc, t) {
      var p = T.palavra(t, hoje()), fs = el('div', 'mv-tf-fotos'), tira = false;
      (t.fotos || []).forEach(function (f) {
        var lb = blobLocal(t.id, f.n), cel = el('div', 'mv-tf-fcel'); fs.appendChild(cel);
        var acc = function () { tira = accoesFoto(cel, t, f, function (accao, campos, txt) { comando(t, accao, campos, txt); }) || tira; };
        if (lb) { var im = el('img', 'mv-tf-foto'); im.alt = f.papel === 'depois' ? 'Foto do depois' : 'Foto do que falta'; im.src = urlLocal(lb); cel.appendChild(im); acc(); return; }
        var ph = el('span', 'mv-tf-foto', f.estado === 'arquivada' ? 'Nos documentos da obra' : (f.estado === 'por-enviar' ? 'Por enviar noutro telemóvel' : 'A carregar a foto…'));
        cel.appendChild(ph); acc();
        if (f.estado === 'por-arquivar') urlFoto(t.id, f.n).then(function (u) { if (!ph.isConnected) return; if (u && u !== 'arquivada') { var im2 = el('img', 'mv-tf-foto'); im2.alt = f.papel === 'depois' ? 'Foto do depois' : 'Foto do que falta'; im2.src = u; ph.replaceWith(im2); } else ph.textContent = u === 'arquivada' ? 'Nos documentos da obra' : (K.online() ? 'Não consegui ler a foto' : 'A foto vê-se com rede'); });
      });
      if (fs.firstChild) { cc.appendChild(fs); notaFotos(cc, tira); }
      var ds = el('p', 'mv-desc', t.texto); ds.style.marginTop = 'var(--e3)'; cc.appendChild(ds);
      cc.appendChild(rl('Localização', T.locTitulo(t.localizacao)));
      cc.appendChild(rl('Estado', p.p, p.c, p.f && !t.bloqueio ? p.f : ''));
      if (t.bloqueio) {
        cc.appendChild(rl('Quem bloqueia', T.nomeQuem(t.bloqueio.quem) + (t.bloqueio.equipa ? ' · ' + t.bloqueio.equipa : '')));
        if (t.bloqueio.motivo) cc.appendChild(rl('Motivo', t.bloqueio.motivo));
        if (t.bloqueio.desde) cc.appendChild(rl('Desde', D.textoDiaCurto(T.diaDe(t.bloqueio.desde))));
        var ids = t.bloqueio.bloqueiosCliente || [], bx = T.bcsDe(K.cache(), t.obraId), bc = ids.length && bx ? (bx.data.bloqueios || []).filter(function (b) { return b.id === ids[0]; })[0] : null;
        if (bc) cc.appendChild(rl('Bloqueio do cliente', T.nomeEstadoBc(bc), bc.semResposta ? 'neg-t' : 'ama-t')); else if (ids.length) cc.appendChild(rl('Bloqueio do cliente', 'Registado'));
        var be = K.bc ? K.bc() : null;   // a folha do bloqueio do cliente (bloqueios-ecra.js, parte 3)
        if (bc && be && be.disponivel()) { var vb = bt('mv-link'); vb.appendChild(ic('obra')); vb.appendChild(document.createTextNode('Ver o bloqueio do cliente')); vb.addEventListener('click', function () { be.abrirBc(bc.id, t.obraId); }); cc.appendChild(vb); }
      }
      if (t.autor) cc.appendChild(rl('Registado', (t.autor.nome || '') + (t.dia ? ' · ' + D.textoDiaCurto(t.dia) : '')));
      if (!t.porEnviar && (pode(t, 'editar-texto') || pode(t, 'localizacao'))) cc.appendChild(linkCorrigir(pode(t, 'editar-texto'), pode(t, 'localizacao'), function () { folhaCorrigirTf(t); }));
      var hs = (t.historico || []).slice().reverse();
      if (hs.length) {
        cc.appendChild(el('p', 'mv-lh', 'Histórico'));
        var ul = el('ul', 'mv-hist');
        hs.forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, T.nomeAccao(x.accao) + (x.nome ? ' · ' + x.nome : ''))); li.appendChild(el('small', null, T.diaDe(x.em) === hoje() ? 'hoje' : D.textoDiaMes(T.diaDe(x.em) || hoje()))); ul.appendChild(li); });
        cc.appendChild(ul);
      }
    }
    function pode(t, a) { return (t.pode || []).indexOf(a) >= 0; }
    function botao(cls, txt, fn, nomeIc) { var b = bt('mv-btn' + (cls ? ' ' + cls : '')); if (nomeIc) b.appendChild(ic(nomeIc)); b.appendChild(document.createTextNode(txt)); b.addEventListener('click', fn); return b; }
    function peTrabalho(p, t) {
      if (t.porEnviar) { p.appendChild(el('p', 'mv-folha-txt', K.online() ? 'A enviar: as acções voltam quando o servidor responder.' : 'Por enviar: segue quando houver rede. As acções voltam depois.')); return; }
      var dois = el('div', 'mv-pe2'), um = null;
      if (t.feitoEm) {
        if (pode(t, 'reabrir')) um = botao('', 'Reabrir', function () { K.fecharFolha(); comando(t, 'reabrir', {}, 'Reaberto'); });
        if (um) p.appendChild(um);
        if (pode(t, 'foto-juntar-depois')) { var fd = bt('mv-link'); fd.appendChild(ic('cam')); fd.appendChild(document.createTextNode('Foto do depois')); fd.addEventListener('click', function () { S.fotoDepois = { id: t.id }; $('t-dep').click(); }); p.appendChild(fd);
          if (!pode(t, 'planear')) p.appendChild(el('p', 'mv-folha-txt', 'Juntas a foto do depois até 7 dias depois de marcar feito.')); }   // o DO e o GP não têm prazo (o `pode` deles di-lo)
        return;
      }
      if (t.bloqueio && t.bloqueio.porConfirmar && pode(t, 'confirmar-bloqueio')) {
        dois.appendChild(botao('pri', 'Confirmar bloqueio', function () { K.fecharFolha(); comando(t, 'confirmar-bloqueio', {}, 'Bloqueio confirmado'); }));
        var tira = pode(t, 'desbloquear') ? 'desbloquear' : (pode(t, 'rejeitar-bloqueio') ? 'rejeitar-bloqueio' : '');   // cada botão sai do seu `pode`
        if (tira) { dois.appendChild(botao('', tira === 'desbloquear' ? 'Desbloquear' : 'Rejeitar', function () { K.fecharFolha(); comando(t, tira, {}, tira === 'desbloquear' ? 'Desbloqueado' : 'Bloqueio rejeitado'); })); p.appendChild(dois); }
        else p.appendChild(dois.firstChild);
      } else if (t.bloqueio && pode(t, 'desbloquear')) {
        p.appendChild(botao('pri', 'Desbloquear', function () { K.fecharFolha(); comando(t, 'desbloquear', {}, 'Desbloqueado'); }));
      } else if (pode(t, 'planear')) {
        dois.appendChild(botao('pri', 'Dia previsto', function () { folhaDia(t); }));
        if (pode(t, 'bloquear')) dois.appendChild(botao('', 'Bloquear', function () { folhaBloquear(t); }));
        p.appendChild(dois);
      } else {
        // quem não planeia (o encarregado), como no protótipo: a nota e «Marcar como feito»; sugerir um bloqueio fica num link
        p.appendChild(el('p', 'mv-folha-txt', t.bloqueio && t.bloqueio.porConfirmar ? 'O bloqueio fica por confirmar até o DO ou o GP o confirmar.' : 'O dia previsto e os bloqueios planeiam-nos o DO e o GP.'));
        if (pode(t, 'feito')) p.appendChild(botao('', 'Marcar como feito', function () { K.fecharFolha(); marcarFeito(t.id); }, 'ok'));
        if (pode(t, 'sugerir-bloqueio')) { var sb = bt('mv-link'); sb.appendChild(ic('alerta')); sb.appendChild(document.createTextNode('Está bloqueado? Avisa o DO e o GP')); sb.addEventListener('click', function () { folhaBloquear(t); }); p.appendChild(sb); }
      }
      if (pode(t, 'planear') && pode(t, 'feito')) { var lf = bt('mv-link'); lf.appendChild(ic('ok')); lf.appendChild(document.createTextNode('Marcar como feito')); lf.addEventListener('click', function () { K.fecharFolha(); marcarFeito(t.id); }); p.appendChild(lf); }
      if (pode(t, 'anular')) { var la = bt('mv-link mv-link-anular'); la.appendChild(ic('lixo')); la.appendChild(document.createTextNode('Registado por engano: anular')); la.addEventListener('click', function () { folhaConfirmar({ titulo: 'Anular este trabalho?', sub: t.texto, texto: 'Sai da lista dos trabalhos em falta. Tens uns segundos para desfazer.', botao: 'Anular o trabalho', fazer: function () { comando(t, 'anular', {}, 'Anulado'); } }); }); p.appendChild(la); }
    }

    // ── Os comandos: um item na fila da conta; com Desfazer, só segue depois de o aviso acabar ──
    function nBase(t) { var mx = 0; (t.fotos || []).forEach(function (f) { mx = Math.max(mx, Number(f.n) || 0); }); minhaFila().forEach(function (q) { if (q.registoId === t.id) (q.fotos || []).forEach(function (f) { mx = Math.max(mx, Number(f.n) || 0); }); }); return mx; }
    function itemDe(t, accao, campos, o) {
      var s = K.sessao();
      return T.itemComando(Object.assign({ accao: accao, tf: trabalhoBase(t.id) || t, campos: campos, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId, resumo: t.texto, nBase: nBase(t) }, o || {}));
    }
    function trabalhoBase(id) { var x = T.listaDe(K.cache(), S.obra); return x ? (x.data.trabalhos || []).filter(function (t) { return t.id === id; })[0] || null : null; }
    async function porNaFila(item) { K.porNaFila(item); await K.guardarItem(item); }
    function tirarDaFila(item) { K.tirarDaFila(item); K.apagarItem(item.id); }
    function comando(t, accao, campos, texto) { comandos([itemDe(t, accao, campos, { adiarMs: ADIAR })], texto); }
    /** Vários comandos de uma vez (o «Corrigir»: o texto e a Localização), com um só Desfazer. */
    function comandos(its, texto) {
      its.forEach(function (it) { porNaFila(it); }); redesenharLista();
      K.toast(texto + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR,
        desfazer: function () { its.forEach(tirarDaFila); redesenharLista(); },
        aoFim: function () { var vivos = its.filter(function (it) { return K.fila().indexOf(it) >= 0; }); if (!vivos.length) return; vivos.forEach(function (it) { it.adiadoAte = ''; K.guardarItem(it); }); K.soltarConflitos(vivos); K.drenar(false); },   // decidido de vez: o conflito antigo sai (sem fotos por enviar)
      });
    }

    // ── «Corrigir» o texto e a Localização (folha), só com o `pode` do servidor; serve também os bloqueios do cliente ──
    function linkCorrigir(txt, loc, fn) {
      var b = bt('mv-link mv-link-cor'); b.setAttribute('data-k', 'corrigir'); b.appendChild(ic('lapis'));
      b.appendChild(document.createTextNode(txt && loc ? 'Corrigir o texto ou a Localização' : (txt ? 'Corrigir o texto' : 'Mudar a Localização')));
      b.addEventListener('click', fn); return b;
    }
    function locId(l) { return (l && l.issueId) || null; }
    /** o: { titulo, sub, rotulo (do texto), texto, max, podeTexto, podeLoc, loc, obraId, nota, aoGuardar({ texto?, loc? }: só o que mudou) }. */
    function folhaCorrigir(o) {
      var ed = { texto: o.texto || '', loc: o.loc || null, aberta: false };
      var mudou = function () { var x = {}; if (o.podeTexto && String(ed.texto).trim() && String(ed.texto).trim() !== String(o.texto || '').trim()) x.texto = String(ed.texto).trim().slice(0, o.max); if (o.podeLoc && locId(ed.loc) !== locId(o.loc)) x.loc = ed.loc; return x; };
      var pe = function (p) {
        limpar(p);
        var x = mudou(), n = Object.keys(x).length, vazio = o.podeTexto && !String(ed.texto).trim();
        var b = bt('mv-btn pri', vazio ? 'Escreve ' + o.rotulo.toLowerCase() : (n ? 'Guardar' : 'Nada mudou')); b.id = 'b-cor-ok'; b.setAttribute('aria-disabled', String(!n || vazio));
        b.addEventListener('click', function () { var y = mudou(); if (!Object.keys(y).length || (o.podeTexto && !String(ed.texto).trim())) return; K.fecharFolha(); o.aoGuardar(y); });
        p.appendChild(b);
      };
      var zonaLoc = function (box) {
        limpar(box);
        var lc = K.cache().locs[o.obraId];
        var b = bt('mv-obra'); b.id = 'c-cor-loc'; b.setAttribute('aria-expanded', String(ed.aberta));
        var i = el('span', 'mv-obra-ic'); i.appendChild(ic('obra')); b.appendChild(i);
        var tt = el('span', 'mv-obra-t'); if (ed.loc && ed.loc.produto) tt.appendChild(el('span', 'mv-obra-cod', ed.loc.produto)); tt.appendChild(el('span', 'mv-obra-n', ed.loc ? (ed.loc.produto ? (ed.loc.nome || ed.loc.codigo) : T.locTitulo(ed.loc)) : 'Sem localização')); b.appendChild(tt);
        var ac = el('span', 'mv-obra-acc', ed.aberta ? 'Fechar' : 'Trocar'); if (!ed.aberta) ac.appendChild(ic('chev')); b.appendChild(ac);
        b.addEventListener('click', function () { ed.aberta = !ed.aberta; zonaLoc(box); K.A.focar($('c-cor-loc')); if (ed.aberta && !lc) K.lerLocsAgora(o.obraId).then(function () { if (box.isConnected) zonaLoc(box); }); });
        box.appendChild(b);
        if (!ed.aberta) return;
        var op = function (l, rot) { var x = bt('mv-lo'); x.setAttribute('aria-pressed', String(locId(l) === locId(ed.loc))); var nm = el('span', 'mv-lo-n', rot); if (l && l.codigo) nm.appendChild(el('small', null, l.codigo)); junta(x, nm, ic('ok')); x.addEventListener('click', function () { ed.loc = l; ed.aberta = false; zonaLoc(box); pe($('fx-p')); K.A.focar($('c-cor-loc')); }); box.appendChild(x); };
        op(null, 'Sem localização');
        if (!lc) { box.appendChild(el('p', 'mv-folha-txt', K.online() ? 'A ler as localizações da obra…' : 'Sem rede, e ainda não tenho as localizações desta obra neste telemóvel.')); return; }
        (lc.produtos || []).forEach(function (p) {
          if (!(p.localizacoes || []).length) return;
          box.appendChild(el('p', 'mv-lh', p.nome));
          p.localizacoes.forEach(function (x) { op({ issueId: x.id, codigo: x.codigo || '', nome: x.nome || '', produto: p.nome || '' }, x.nome || x.codigo); });
        });
      };
      K.folha({ alta: true, titulo: o.titulo, sub: o.sub || '', corpo: function (cc) {
        if (o.podeTexto) {
          var lb = el('label', 'mv-lh mv-rot-1', o.rotulo); lb.htmlFor = 'c-cor-txt'; cc.appendChild(lb);
          var ta = el('textarea', 'mv-campo curto'); ta.id = 'c-cor-txt'; ta.value = ed.texto; ta.maxLength = o.max; ta.setAttribute('autocapitalize', 'sentences'); ta.spellcheck = true;
          ta.addEventListener('input', function () { ed.texto = ta.value; pe($('fx-p')); });
          cc.appendChild(ta);
        }
        if (o.podeLoc) { cc.appendChild(el('p', 'mv-lh' + (o.podeTexto ? '' : ' mv-rot-1'), 'Localização')); var box = el('div', 'mv-cor-loc'); cc.appendChild(box); zonaLoc(box); }
        if (o.nota) cc.appendChild(el('p', 'mv-folha-txt', o.nota));
      }, pe: pe });
    }
    function folhaCorrigirTf(t) {
      folhaCorrigir({ titulo: 'Corrigir', sub: t.texto, rotulo: 'O que falta', texto: t.texto, max: T.LIMITES.texto, podeTexto: pode(t, 'editar-texto'), podeLoc: pode(t, 'localizacao'), loc: t.localizacao, obraId: t.obraId,
        nota: t.autor && t.autor.eu && !pode(t, 'planear') ? 'Corriges e anulas até 7 dias depois do dia em que registaste. Depois, só o DO ou o GP.' : '',
        aoGuardar: function (x) {
          var its = [];
          if (x.texto != null) its.push(itemDe(t, 'editar-texto', { texto: x.texto }, { adiarMs: ADIAR }));
          if (x.loc !== undefined) its.push(itemDe(t, 'localizacao', { issueId: locId(x.loc) }, { adiarMs: ADIAR }));
          comandos(its, x.texto != null && x.loc !== undefined ? 'Corrigido' : (x.texto != null ? 'Texto corrigido' : 'Localização mudada'));
        } });
    }
    function marcarFeito(id) {
      var t = trabalhoDe(id); if (!t) return;
      // Revisão de 8bf7d34f (P2): o «feito» deste trabalho reconhece-se pelo item na fila, não pelo adiadoAte (o aviso de OUTRO
      // trabalho, ao entrar, corre o aoFim deste e tira-lho). Ainda não saiu (nem uma tentativa): tocar outra vez é o Desfazer.
      var ja = minhaFila().filter(function (q) { return q.tipo === 'tf' && q.registoId === id && q.accao === 'feito' && q.estado === 'a-enviar' && !q.resposta; })[0];
      if (ja && !ja.tentou) { K.largarToastDe(ja.id); tirarDaFila(ja); delete S.feitoTmp[id]; K.toast('Desfeito', { ms: 2000 }); redesenharLista(); return; }   // tocar outra vez no círculo é o Desfazer (revisão: o aviso velho sai sem o aoFim, que o voltava a gravar)
      // Já saiu (ou está a sair): nunca um 2.º «feito». O toque é um «reabrir» explícito, se o servidor o deixa (o `pode`).
      if (ja || t.feitoEm) {
        if (!ja && pode(t, 'reabrir')) { comando(t, 'reabrir', {}, 'Reaberto'); return; }
        K.toast(ja ? 'Já segue como feito. Para o reabrir, abre o trabalho depois de chegar.' : 'Este trabalho já está feito.', { ms: 3000 }); redesenharLista(); return;
      }
      if (!pode(t, 'feito')) { redesenharLista(); return; }   // o servidor não o deixa marcar (um botão que ficou de um desenho antigo)
      var item = itemDe(t, 'feito', {}, { adiarMs: ADIAR, papel: 'depois' });
      S.feitoTmp[id] = T.filtroDe(t, hoje()) || 'fazer';
      porNaFila(item); redesenharLista();
      var fim = function () { delete S.feitoTmp[id]; redesenharLista(); };
      K.toast('Feito' + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR, itemId: item.id,
        desfazer: function () { tirarDaFila(item); delete S.feitoTmp[id]; redesenharLista(); },
        acao: pode(t, 'feito') ? { rot: 'Foto do depois', fn: function () { fim(); item.adiadoAte = new Date(Date.now() + ADIAR_FOTO).toISOString(); K.guardarItem(item); S.fotoDepois = { id: id, item: item }; $('t-dep').click(); } } : null,
        aoFim: function () { fim(); if (K.fila().indexOf(item) < 0) return; item.adiadoAte = ''; K.guardarItem(item); K.soltarConflitos([item]); K.drenar(false); },   // um desfeito não volta
      });
    }
    /** A foto do depois: entra no «feito» que ainda não saiu; senão um foto-juntar {papel: depois}. */
    async function fotoDepois(files) {
      var alvo = S.fotoDepois; S.fotoDepois = null;
      var f = files && files[0]; if (!alvo || !f) { if (alvo && alvo.item) { alvo.item.adiadoAte = ''; K.guardarItem(alvo.item); K.drenar(false); } return; }
      var x; try { x = await K.A.comprimir(f); } catch (e) { K.toast((e && e.message) || 'Não consegui abrir esta foto.'); if (alvo.item) { alvo.item.adiadoAte = ''; K.drenar(false); } return; }
      var q = alvo.item;
      if (q && K.fila().indexOf(q) >= 0 && !q.tentou && !q.resposta && q.estado === 'a-enviar') {
        var n = nBase(trabalhoDe(alvo.id) || { id: alvo.id, fotos: [] }) + 1;
        q.fotos.push({ n: n, nPedido: n, sha256: x.sha256, tipo: x.tipo, tamanho: x.tamanho, estado: 'por-declarar', blob: x.blob });
        q.adiadoAte = ''; await K.guardarItem(q);
      } else {
        var t = trabalhoDe(alvo.id); if (!t) return;
        await porNaFila(itemDe(t, 'foto-juntar', {}, { fotos: [x], papel: 'depois' }));
      }
      K.toast('Foto do depois junta', { ms: 2500 }); redesenharLista(); K.drenar(false);
    }

    // ── O dia previsto (folha) ──
    function folhaDia(t) {
      var planear = function (dia) { K.fecharFolha(); comando(t, 'planear', { previsto: dia || null }, dia ? 'Previsto ' + D.textoDiaCurto(dia) : 'Sem dia previsto'); };
      K.folha({ titulo: 'Dia previsto', sub: t.texto, corpo: function (cc) {
        var ch = el('div', 'mv-chips envolve'); ch.setAttribute('role', 'group'); ch.setAttribute('aria-label', 'Dia previsto');
        T.opcoesDia(hoje()).forEach(function (o) { var b = bt('mv-chip', o[0]); b.setAttribute('aria-pressed', String(t.previsto === o[1])); b.setAttribute('aria-label', o[0] + ', ' + D.textoDiaCurto(o[1])); b.addEventListener('click', function () { planear(o[1]); }); ch.appendChild(b); });
        var inp = el('input', 'mv-in mv-data-in'); inp.type = 'date'; inp.min = hoje(); inp.hidden = true; inp.setAttribute('aria-label', 'Dia previsto'); if (t.previsto) inp.value = t.previsto;
        inp.addEventListener('change', function () { if (T.RE_DIA.test(inp.value)) planear(inp.value); });
        var es = bt('mv-chip', 'Escolher data'); es.addEventListener('click', function () { inp.hidden = false; inp.focus(); try { inp.showPicker(); } catch (e) { /* fica o campo */ } });
        ch.appendChild(es); cc.appendChild(ch); cc.appendChild(inp);
        if (t.previsto) { var ti = bt('mv-link', 'Tirar o dia previsto'); ti.style.marginTop = 'var(--e3)'; ti.addEventListener('click', function () { planear(null); }); cc.appendChild(ti); }
      } });
    }

    // ── Bloquear (folha): por quem bloqueia; o cliente liga a um bloqueio dele ou cria um no servidor ──
    function folhaBloquear(t) {
      var accao = pode(t, 'bloquear') ? 'bloquear' : 'sugerir-bloqueio', x = T.listaDe(K.cache(), t.obraId), sug = (x && x.data.sugestoes) || { equipas: [], motivos: [] };
      S.bq = { quem: '', equipa: '', motivo: '', novo: false };
      var redesenhar = function () { var c = $('fx-c'), p = $('fx-p'); if (!c || !S.bq) return; var ta = $('c-bq-mot'), foco = document.activeElement === ta; limpar(c); corpo(c); limpar(p); pe(p); if (foco && $('c-bq-mot')) $('c-bq-mot').focus(); };
      var corpo = function (cc) {
        var f = S.bq;
        cc.appendChild(el('p', 'mv-lh mv-rot-1', 'Quem bloqueia'));
        var qc = el('div', 'mv-chips envolve'); qc.setAttribute('role', 'group'); qc.setAttribute('aria-label', 'Quem bloqueia');
        QUEM_ROT.forEach(function (q) { var b = bt('mv-chip', q); b.setAttribute('aria-pressed', String(f.quem === q)); b.addEventListener('click', function () { f.quem = q; f.novo = false; if (q !== 'Subempreiteiro') f.equipa = ''; f.motivo = ''; redesenhar(); }); qc.appendChild(b); });
        cc.appendChild(qc);
        if (f.quem === 'Subempreiteiro' && sug.equipas.length) {
          cc.appendChild(el('p', 'mv-lh', 'Equipa'));
          var ec = el('div', 'mv-chips envolve'); ec.setAttribute('role', 'group'); ec.setAttribute('aria-label', 'Equipa');
          sug.equipas.forEach(function (n) { var b = bt('mv-chip', n); b.setAttribute('aria-pressed', String(f.equipa === n)); b.addEventListener('click', function () { f.equipa = f.equipa === n ? '' : n; redesenhar(); }); ec.appendChild(b); });
          cc.appendChild(ec);
        }
        if (f.quem === 'Cliente' && !f.novo) {
          var bx = T.bcsDe(K.cache(), t.obraId), bl = bx ? T.bcsDaLoc(bx.data.bloqueios, t.localizacao) : null;
          cc.appendChild(el('p', 'mv-lh', t.localizacao ? 'Bloqueios do cliente nesta localização' : 'Bloqueios do cliente sem localização'));
          if (!bl) cc.appendChild(el('p', 'mv-folha-txt', K.online() ? 'A ler os bloqueios do cliente…' : 'Sem rede: os bloqueios do cliente vêem-se com rede.'));
          else if (!bl.length) cc.appendChild(el('p', 'mv-folha-txt', 'Nenhum nesta localização.'));
          else bl.forEach(function (b) {
            var d = el('div', 'mv-tf-bc'), tt = el('span', 'mv-fl-t'); tt.appendChild(el('b', null, b.precisa));
            var dd = D.difDias(b.dia, hoje()); tt.appendChild(el('small', null, T.nomeEstadoBc(b) + ' · ' + (dd <= 0 ? 'de hoje' : 'há ' + dd + (dd === 1 ? ' dia' : ' dias'))));
            var lg = bt('mv-btn compacto', 'Ligar a este'); lg.addEventListener('click', function () { K.fecharFolha(); comando(t, accao, { quem: 'CLIENTE', bcId: b.id }, 'Ligado ao bloqueio do cliente'); });
            junta(d, tt, lg); cc.appendChild(d);
          });
          var nv = bt('mv-btn'); nv.appendChild(ic('mais')); nv.appendChild(document.createTextNode('Novo bloqueio do cliente')); nv.style.marginTop = 'var(--e3)';
          nv.addEventListener('click', function () {   // o formulário do bloqueio do cliente (parte 3), com este trabalho já marcado; sem ele, só o texto
            var be = K.bc ? K.bc() : null;
            if (be && be.disponivel()) { var ft = primeiraFoto(t) || primeiraFoto(t, 'depois'); S.bq = null; K.A.fecharFolhas(true); be.abrirForm(t.obraId, { loc: t.localizacao || null, tfs: [t.id], daFolha: true, fotoTf: ft ? { id: t.id, n: ft.n, estado: ft.estado } : null }); return; }
            f.novo = true; redesenhar();
          }); cc.appendChild(nv);
          return;
        }
        if (!f.quem) return;
        var cli = f.quem === 'Cliente';
        cc.appendChild(el('p', 'mv-lh', cli ? 'O que se precisa do cliente' : 'Motivo'));
        var mc = el('div', 'mv-chips envolve mv-frases'); mc.setAttribute('role', 'group'); mc.setAttribute('aria-label', 'Frases sugeridas');
        T.frasesMotivo(sug, cli).forEach(function (m) { var b = bt('mv-chip', m); b.setAttribute('aria-pressed', String(f.motivo === m)); b.addEventListener('click', function () { f.motivo = f.motivo === m ? '' : m; redesenhar(); }); mc.appendChild(b); });
        cc.appendChild(mc);
        var ta = el('textarea', 'mv-campo curto'); ta.id = 'c-bq-mot'; ta.value = f.motivo; ta.maxLength = T.LIMITES.motivo; ta.placeholder = cli ? 'Ou escreve o que se precisa do cliente.' : 'Ou escreve o motivo.'; ta.setAttribute('autocapitalize', 'sentences'); ta.setAttribute('aria-label', cli ? 'O que se precisa do cliente' : 'Motivo');
        ta.addEventListener('input', function () { f.motivo = ta.value; var p = $('fx-p'); limpar(p); pe(p); });
        cc.appendChild(ta);
      };
      var pe = function (p) {
        var f = S.bq;
        if (f.quem === 'Cliente' && !f.novo) { p.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', 'Liga a um bloqueio que já existe ou cria um novo.')); return; }
        var falta = !f.quem ? 'Escolhe quem bloqueia' : (accao === 'bloquear' && !String(f.motivo).trim() ? (f.quem === 'Cliente' ? 'Escreve o que se precisa do cliente' : 'Escreve o motivo') : '');
        var rot = falta || ((accao === 'bloquear' ? 'Bloquear · ' : 'Sugerir bloqueio · ') + (f.equipa || f.quem));
        var b = bt('mv-btn pri', rot); b.id = 'b-bq-ok'; b.setAttribute('aria-disabled', String(!!falta));
        b.addEventListener('click', function () {
          if (falta) return;
          var campos = { quem: QUEM_COD[f.quem] }; if (f.equipa) campos.equipa = f.equipa; if (String(f.motivo).trim()) campos.motivo = String(f.motivo).trim().slice(0, T.LIMITES.motivo);
          K.fecharFolha(); S.bq = null;
          comando(t, accao, campos, (accao === 'bloquear' ? 'Bloqueado · ' : 'Bloqueio sugerido · ') + (campos.equipa || f.quem));
        });
        p.appendChild(b);
      };
      K.folha({ alta: true, titulo: accao === 'bloquear' ? 'Bloquear' : 'Está bloqueado', sub: t.texto, corpo: corpo, pe: pe });
      if (!T.bcsDe(K.cache(), t.obraId) || K.online()) lerBcs(t.obraId).then(function () { if (S.bq && S.bq.quem === 'Cliente') redesenhar(); });
    }

    // ── O formulário (v-tf-form): foto, o que falta, Localização, «está bloqueado» ──
    /** o: { loc (definida = um formulário novo, sem o rascunho), rascunho (o id de um rascunho a continuar), substituir, daFolha }.
        Sem loc nem rascunho (o «+»): continua o rascunho mais recente desta conta, se houver. */
    function abrirForm(ob, o) {
      o = o || {};
      var r = o.rascunho ? R[o.rascunho] : (o.loc === undefined ? meusRascunhos()[0] : null);
      if (r && r.contaId !== K.contaId()) r = null;
      if (!ob && !r) { K.toast('Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.'); return; }
      gravarRascunhoJa();
      if (r) { S.form = T.formDoRascunho(r); S.form.doRascunho = r.guardadoEm; ob = S.form.obraId; }
      else { S.form = T.formNovo({ obraId: ob, loc: o.loc !== undefined ? o.loc : ultimaLoc(ob) }); S.form.rid = idRascunho(); }
      S.form.uid = K.novoId(); S.form.tentou = false; S.form.erroFoto = ''; S.form.conta = K.contaId();
      if (!K.cache().locs[ob]) K.lerLocsAgora(ob).then(function () { if (K.vista() === 'v-tf-form') zona('loc'); });
      if (!T.listaDe(K.cache(), ob)) lerLista(ob);   // as frases e o «podePlanear» da obra
      K.abrir('v-tf-form', !!o.substituir, !!o.daFolha);
    }

    // ── O rascunho (molde do diário, casca.js): por conta, a cada alteração (300 ms), já ao sair do ecrã ──
    function idRascunho() { return ('rt-' + K.novoId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80); }
    function meusRascunhos() { return T.rascunhosDa(Object.keys(R).map(function (k) { return R[k]; }), K.contaId(), new Date()).meus; }
    function carregarRascunhos(lista) {
      var x = T.rascunhosDa(lista, '', new Date());
      x.velhos.forEach(function (r) { K.apagarItem(r.id); });   // mais de 7 dias: sai do telemóvel, com as fotos
      (lista || []).forEach(function (r) { if (r && r.tipo === 'tf-rascunho' && x.velhos.indexOf(r) < 0) R[r.id] = r; });
    }
    function mexeu() { if (!S.form) return; clearTimeout(tRasc); tRasc = setTimeout(gravarRascunhoJa, 300); }
    function gravarRascunhoJa() {
      clearTimeout(tRasc); tRasc = null;
      var f = S.form; if (!f || !f.rid || !f.conta || f.conta !== K.contaId()) return;
      if (T.rascunhoVazio(f)) { if (R[f.rid]) { delete R[f.rid]; K.apagarItem(f.rid); } return; }
      var r = T.rascunhoDe(f, { contaId: f.conta }); R[r.id] = r; K.guardarItem(r);
    }
    function apagarRascunho(id) { if (!id) return; delete R[id]; K.apagarItem(id); }
    /** Os rascunhos desta conta para o «Por enviar»: continuar, ou deitar fora (com Desfazer). */
    function linhasRascunho() {
      return meusRascunhos().map(function (r) {
        var o = K.obraDe(r.form.obraId), fs = (r.form.fotos || []).length;
        return { id: r.id, ic: 'falta', titulo: 'Trabalho em falta' + (o ? ' · ' + o.codigo : ''), resumo: (String(r.form.texto || '').trim().slice(0, 60) || 'Sem texto') + (fs ? ' · ' + fs + (fs === 1 ? ' foto' : ' fotos') : ''),
          continuar: function () { abrirForm(r.form.obraId, { rascunho: r.id }); },
          apagar: function (aoMudar) { delete R[r.id]; aoMudar(); K.toast('Rascunho deitado fora', { desfazer: function () { R[r.id] = r; aoMudar(); }, aoFim: function () { if (!R[r.id]) K.apagarItem(r.id); } }); } };
      });
    }
    function faixaRascunho(box) {
      var f = S.form; if (!f.doRascunho) return;
      var d = el('div', 'mv-faixa neu'); d.setAttribute('role', 'status'); d.appendChild(ic('lapis'));
      var dia = T.diaDe(f.doRascunho), h = D.horaDe ? D.horaDe(f.doRascunho) : '';
      d.appendChild(el('span', 'mv-faixa-t', 'O teu rascunho de ' + (dia === hoje() ? 'hoje' : D.textoDiaMes(dia)) + (h ? ' às ' + h : '')));
      var b = bt('mv-faixa-b', 'Começar de novo'); b.id = 'b-tf-rasc-novo';
      b.addEventListener('click', function () { var ob = f.obraId; apagarRascunho(f.rid); S.form = null; abrirForm(ob, { loc: ultimaLoc(ob), substituir: true }); });
      d.appendChild(b); box.appendChild(d);
    }
    var ZONAS = ['obra', 'fotos', 'texto', 'loc', 'bloq'];
    function desenharForm() {
      var v = $('v-tf-form'); if (!v || !S.form) return;
      if (v.getAttribute('data-form') !== S.form.uid) { limpar(v); v.setAttribute('data-form', S.form.uid); ZONAS.forEach(function (z) { var d = el('div'); d.id = 'tz-' + z; v.appendChild(d); }); }
      ZONAS.forEach(zona);
      desenharBarraForm();
    }
    function zona(z) {
      var box = $('tz-' + z); if (!box || !S.form) return;
      var ae = document.activeElement, k = ae && box.contains(ae) ? ae.getAttribute('data-k') : null;
      if (z === 'texto' && ae && ae.id === 'c-tf-txt') { marcarFrases(); return; }   // a escrever: o campo não se refaz
      limpar(box); ({ obra: zObra, fotos: zFotos, texto: zTexto, loc: zLoc, bloq: zBloq })[z](box);
      if (k) { var y = box.querySelector('[data-k="' + k + '"]'); if (y) K.A.focar(y); }
      mexeu();
    }
    function secao(titulo, meta, idH, tag) { return K.seccao(titulo, meta, idH, tag); }
    function zObra(box) {
      faixaRascunho(box);
      var f = S.form, o = K.obraDe(f.obraId), s = el('section', 'mv-sec pri'); s.setAttribute('aria-labelledby', 'h-obra-tf');
      var sh = el('div', 'mv-sec-h'); sh.appendChild(el('h2', null, 'Obra')).id = 'h-obra-tf'; s.appendChild(sh);
      var b = bt('mv-obra' + (o ? '' : ' vazia')); b.id = 'c-obra-tf'; b.setAttribute('data-k', 'obra');
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
          b.addEventListener('click', function () { K.fecharFolha(); if (o.id !== f.obraId) { f.obraId = o.id; f.loc = ultimaLoc(o.id); f.locAuto = !!f.loc; if (!K.cache().locs[o.id]) K.lerLocsAgora(o.id).then(function () { zona('loc'); }); if (!T.listaDe(K.cache(), o.id)) lerLista(o.id).then(function () { zona('texto'); zona('bloq'); }); desenharForm(); } });
          cc.appendChild(b);
        });
      } });
    }
    function zFotos(box) {
      var f = S.form, n = f.fotos.length, s = secao('Foto', n ? n + ' de ' + T.LIMITES.fotos : 'Até ' + T.LIMITES.fotos, 'h-fotos-tf'), prep = f.aPreparar || 0;
      var add = function (cls, nomeIc, txt, rot, input) { var b = bt('mv-add' + (cls ? ' ' + cls : '')); b.appendChild(ic(nomeIc)); b.appendChild(el('span', null, txt)); if (rot) b.setAttribute('aria-label', rot); b.disabled = prep > 0; b.addEventListener('click', function () { $(input).click(); }); return b; };
      if (!n && !prep) { var vz = el('div', 'mv-fotos-vazio'), cam = add('cam', 'cam', 'Tirar foto', '', 't-cam'); cam.id = 'b-cam-tf'; vz.appendChild(cam); vz.appendChild(add('gal', 'gal', 'Galeria', 'Juntar da galeria', 't-gal')); s.appendChild(vz); }
      else {
        var g = el('div', 'mv-fotos');
        f.fotos.forEach(function (ft, i) {
          var cel = el('div', 'mv-foto'), img = el('img'); img.alt = 'Foto ' + (i + 1); img.src = urlLocal(ft); cel.appendChild(img);
          var x = bt('mv-foto-x'); x.setAttribute('aria-label', 'Tirar a foto ' + (i + 1)); var sp = el('span'); sp.appendChild(ic('x')); x.appendChild(sp);
          x.addEventListener('click', function () { if (ft.prev && URL.revokeObjectURL) URL.revokeObjectURL(ft.prev); f.fotos.splice(i, 1); zona('fotos'); desenharBarraForm(); });
          cel.appendChild(x); g.appendChild(cel);
        });
        for (var k = 0; k < prep; k++) { var pp = el('div', 'mv-foto prep'); pp.setAttribute('role', 'status'); pp.appendChild(el('span', 'pulsa', 'A preparar…')); var pb = el('div', 'mv-pb'); pb.appendChild(el('i')); pp.appendChild(pb); g.appendChild(pp); }
        var livres = T.LIMITES.fotos - n - prep;
        if (livres >= 1) { var c1 = add('cam', 'cam', 'Câmara', 'Tirar outra foto', 't-cam'); c1.id = 'b-cam-tf'; g.appendChild(c1); }
        if (livres >= 2) g.appendChild(add('', 'gal', 'Galeria', 'Juntar da galeria', 't-gal'));
        s.appendChild(g);
        if (livres <= 0 && !prep) s.appendChild(el('p', 'mv-fotos-nota', T.LIMITES.fotos + ' de ' + T.LIMITES.fotos + ', o máximo. Tira uma (✕) para juntar outra.'));
      }
      if (f.erroFoto) { var ef = el('p', 'mv-erro'); ef.setAttribute('role', 'alert'); ef.appendChild(ic('alerta')); ef.appendChild(el('span', null, f.erroFoto)); s.appendChild(ef); }
      box.appendChild(s);
    }
    async function juntarFotos(lista) {
      var f = S.form, files = Array.prototype.slice.call(lista || []); if (!f || !files.length || f.aPreparar) return;
      f.erroFoto = '';
      var cabem = Math.max(0, T.LIMITES.fotos - f.fotos.length);
      if (files.length > cabem) f.erroFoto = 'No máximo ' + T.LIMITES.fotos + ' fotos por trabalho.';
      files = files.slice(0, cabem);
      var re = function () { if (K.vista() === 'v-tf-form' && S.form === f) { zona('fotos'); desenharBarraForm(); } };
      f.aPreparar = files.length; re();
      try {
        for (var i = 0; i < files.length; i++) {
          try { var x = await K.A.comprimir(files[i]); if (S.form !== f) break; f.fotos.push(x); } catch (e) { f.erroFoto = (e && e.message) || 'Não consegui abrir esta foto.'; }
          f.aPreparar = files.length - i - 1; re();
        }
      } finally { f.aPreparar = 0; re(); }
    }
    function marcarFrases() { var fr = $('tz-frases'); if (!fr || !S.form) return; Array.prototype.forEach.call(fr.children, function (b) { b.setAttribute('aria-pressed', String(S.form.texto.indexOf(b.textContent) >= 0)); }); }
    function zTexto(box) {
      var f = S.form, s = el('section', 'mv-sec'), h = el('div', 'mv-sec-h'), lb = el('label', 'mv-h2', 'O que falta'); lb.htmlFor = 'c-tf-txt'; h.appendChild(lb); s.appendChild(h);
      var x = T.listaDe(K.cache(), f.obraId), fr = el('div', 'mv-chips envolve mv-frases'); fr.id = 'tz-frases'; fr.setAttribute('role', 'group'); fr.setAttribute('aria-label', 'Frases de um toque');
      var ta = el('textarea', 'mv-campo curto' + (f.tentou && !String(f.texto).trim() ? ' tentou' : ''));
      T.frases(x ? x.data.trabalhos : []).forEach(function (frase, i) { var b = bt('mv-chip', frase); b.setAttribute('data-k', 'frase-' + i); b.addEventListener('click', function () { f.texto = T.alternarFrase(f.texto, frase); ta.value = f.texto; marcarFrases(); desenharBarraForm(); }); fr.appendChild(b); });
      s.appendChild(fr);
      ta.id = 'c-tf-txt'; ta.value = f.texto; ta.maxLength = T.LIMITES.texto; ta.placeholder = 'Ou escreve, ou dita: o microfone do teclado.'; ta.setAttribute('autocapitalize', 'sentences'); ta.spellcheck = true; ta.setAttribute('data-k', 'texto');
      ta.addEventListener('input', function () { f.texto = ta.value; ta.classList.remove('tentou'); marcarFrases(); desenharBarraForm(); });
      s.appendChild(ta); box.appendChild(s); marcarFrases();
    }
    function zLoc(box) {
      var f = S.form, s = secao('Localização', 'Opcional', 'h-loc-tf'), b = bt('mv-obra'); b.id = 'c-loc-tf'; b.setAttribute('data-k', 'loc');
      var i = el('span', 'mv-obra-ic'); i.appendChild(ic('obra')); b.appendChild(i);
      var tt = el('span', 'mv-obra-t');
      if (f.loc) { tt.appendChild(el('span', 'mv-obra-cod', f.locAuto ? 'a última que usaste' : (f.loc.produto || f.loc.codigo || ''))); tt.appendChild(el('span', 'mv-obra-n', f.locAuto || !f.loc.produto ? T.locTitulo(f.loc) : (f.loc.nome || f.loc.codigo))); }   // com o produto na linha de cima, o nome só (a 360 px não se corta)
      else { tt.appendChild(el('span', 'mv-obra-n', 'Escolher')); tt.appendChild(el('span', 'mv-obra-cod', K.cache().locs[f.obraId] ? 'Ajuda a encontrar o sítio' : (K.online() ? 'A ler as localizações…' : 'Sem rede: ainda não as tenho neste telemóvel'))); }
      b.appendChild(tt); var ac = el('span', 'mv-obra-acc', f.loc ? 'Trocar' : ''); ac.appendChild(ic('chev')); b.appendChild(ac);
      b.addEventListener('click', folhaLoc); s.appendChild(b); box.appendChild(s);
    }
    function folhaLoc() {
      var f = S.form, lc = K.cache().locs[f.obraId], ult = ultimaLoc(f.obraId);
      var escolher = function (l) { f.loc = l; f.locAuto = false; K.fecharFolha(function () { return $('c-loc-tf'); }); zona('loc'); };
      var op = function (cc, l, rot) { var b = bt('mv-lo'); b.setAttribute('aria-pressed', String(l ? !!(f.loc && f.loc.issueId === l.issueId) : !f.loc)); var nm = el('span', 'mv-lo-n', rot); if (l && l.codigo) nm.appendChild(el('small', null, l.codigo)); junta(b, nm, ic('ok')); b.addEventListener('click', function () { escolher(l); }); cc.appendChild(b); };
      K.folha({ titulo: 'Localização', alta: true, sub: 'Produtos e localizações da ' + ((K.obraDe(f.obraId) || {}).codigo || 'obra'), corpo: function (cc) {
        op(cc, null, 'Sem localização');
        if (!lc) { cc.appendChild(el('p', 'mv-vazio', K.online() ? 'A ler as localizações da obra… fecha e abre outra vez daqui a nada.' : 'Sem rede, e ainda não tenho as localizações desta obra neste telemóvel.')); return; }
        if (ult) { cc.appendChild(el('p', 'mv-lh', 'A última que usaste')); op(cc, ult, T.locTitulo(ult)); }
        (lc.produtos || []).forEach(function (p) {
          if (!(p.localizacoes || []).length) return;
          cc.appendChild(el('p', 'mv-lh', p.nome));
          p.localizacoes.forEach(function (x) { op(cc, { issueId: x.id, codigo: x.codigo || '', nome: x.nome || '', produto: p.nome || '' }, x.nome || x.codigo); });
        });
      } });
    }
    function podePlanearObra(ob) { var x = T.listaDe(K.cache(), ob); return !!(x && x.data.podePlanear); }
    function zBloq(box) {
      var f = S.form, s = el('section', 'mv-sec'), b = bt('mv-intl'); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!f.bloqOn)); b.setAttribute('data-k', 'bloq');
      var t = el('span', null, 'Está bloqueado'); t.appendChild(el('small', null, f.bloqOn ? (podePlanearObra(f.obraId) ? 'Escolhe quem bloqueia' : 'Fica «bloqueio por confirmar» até o DO ou o GP confirmar') : 'Não dá para fazer por causa de alguém'));
      b.appendChild(t); var sw = el('span', 'mv-int'); sw.setAttribute('aria-hidden', 'true'); b.appendChild(sw);
      b.addEventListener('click', function () { f.bloqOn = !f.bloqOn; if (!f.bloqOn) f.bloqQuem = ''; zona('bloq'); desenharBarraForm(); });
      s.appendChild(b);
      if (f.bloqOn) {
        var qc = el('div', 'mv-chips envolve mv-tf-quem'); qc.setAttribute('role', 'group'); qc.setAttribute('aria-label', 'Quem bloqueia');
        QUEM_ROT.forEach(function (q, i) { var c = bt('mv-chip', q); c.setAttribute('aria-pressed', String(f.bloqQuem === QUEM_COD[q])); c.setAttribute('data-k', 'quem-' + i); c.addEventListener('click', function () { f.bloqQuem = f.bloqQuem === QUEM_COD[q] ? '' : QUEM_COD[q]; zona('bloq'); }); qc.appendChild(c); });
        s.appendChild(qc);
      }
      box.appendChild(s);
    }
    function desenharBarraForm() {
      var box = $('barra-tf'); if (!box || !S.form) return;
      limpar(box);
      var f = S.form, fl = T.faltaForm(Object.assign({}, f, { aPreparar: !!f.aPreparar }), !!K.obraDe(f.obraId)), nota = el('p', 'mv-barra-nota'), txt, nomeIc;
      if (K.semArmazem()) { nomeIc = 'alerta'; txt = 'Neste telemóvel não consigo guardar: não feches esta página'; nota.classList.add('falta'); }
      else if (fl && (f.tentou || fl.espera)) { nomeIc = fl.espera ? 'relogio' : 'alerta'; txt = fl.texto; nota.classList.add('falta'); if (f.tentou && !fl.espera) nota.classList.add('tentou'); }
      else if (!K.online()) { nomeIc = 'semrede'; txt = 'Sem rede: fica guardado e segue sozinho'; }
      else if (!K.A.sessaoValida()) { nomeIc = 'relogio'; txt = 'Sessão acabada: guarda e entra outra vez'; }
      if (txt) { nota.appendChild(ic(nomeIc)); nota.appendChild(el('span', null, txt)); box.appendChild(nota); }
      var b = bt('mv-btn pri', fl && !fl.espera ? fl.texto : 'Registar trabalho em falta'); b.id = 'b-tf';
      b.setAttribute('aria-disabled', fl ? 'true' : 'false'); b.addEventListener('click', registar); box.appendChild(b);
      K.A.medirBarra();
      mexeu();
    }
    var aRegistar = false;
    async function registar() {
      var f = S.form; if (!f || aRegistar) return;
      var fl = T.faltaForm(Object.assign({}, f, { aPreparar: !!f.aPreparar }), !!K.obraDe(f.obraId));
      if (fl) { f.tentou = true; desenharBarraForm(); zona('texto'); if (fl.campo === 'obra') folhaObraForm(); else if (fl.campo === 'texto') { var ta = $('c-tf-txt'); if (ta) ta.focus(); } return; }
      aRegistar = true;
      try {
        var s = K.sessao(), item = T.itemComando({ accao: 'criar', tf: { id: T.novoIdTf(K.novoId), obraId: f.obraId }, obraId: f.obraId, campos: T.camposCriar(f), fotos: f.fotos, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId });
        item.fotos.forEach(function (x, i) { if (f.fotos[i] && f.fotos[i].prev) x.prev = f.fotos[i].prev; });
        await porNaFila(item);
        clearTimeout(tRasc); tRasc = null; apagarRascunho(f.rid);   // já está na fila: o rascunho sai
        guardarUltima(f.obraId, f.loc);
        S.envio = { item: item, fase: 'a-enviar', loc: f.loc, bloqueio: f.bloqOn && f.bloqQuem ? f.bloqQuem : '' };
        S.form = null;
        if (!K.A.sessaoValida()) { S.envio.fase = 'guardado'; S.envio.mensagem = 'Guardado no telemóvel · entra outra vez para seguir.'; K.abrir('v-tf-envio', true); K.A.pedirLogin('Guardado no telemóvel · entra outra vez para seguir.'); return; }
        K.abrir('v-tf-envio', true);
        K.drenar(true);
      } finally { aRegistar = false; }
    }

    // ── Registado (v-tf-envio) ──
    function desenharEnvio() {
      var v = $('v-tf-envio'); if (!v || !S.envio) return;
      limpar(v);
      var e = S.envio, it = e.item, o = K.obraDe(it.obraId), fase = e.fase, selo = el('div', 'mv-selo');
      selo.setAttribute('role', 'img');
      if (fase === 'a-enviar') { selo.className = 'mv-selo nav'; selo.setAttribute('aria-label', 'A enviar'); var sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sv.setAttribute('class', 'mv-roda'); sv.setAttribute('viewBox', '0 0 72 72'); sv.setAttribute('aria-hidden', 'true'); var ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); ci.setAttribute('cx', '36'); ci.setAttribute('cy', '36'); ci.setAttribute('r', '34'); sv.appendChild(ci); selo.appendChild(sv); selo.appendChild(ic('subir')); }
      else if (fase === 'guardado') { selo.className = 'mv-selo ama'; selo.setAttribute('aria-label', 'Guardado no telemóvel'); selo.appendChild(ic(K.semArmazem() ? 'alerta' : 'tel')); }
      else if (fase === 'parado') { selo.className = 'mv-selo neg'; selo.setAttribute('aria-label', 'Não entrou'); selo.appendChild(ic('alerta')); }
      else { selo.setAttribute('aria-label', 'Registado'); selo.appendChild(ic('ok')); }
      v.appendChild(selo);
      var est = el('div', 'mv-env-estado'); est.setAttribute('aria-live', 'polite'); est.setAttribute('aria-atomic', 'true');
      var t = el('h1', 'mv-env-t'); t.id = 'tf-e-titulo'; t.tabIndex = -1; t.setAttribute('data-foco-inicial', '');
      var sub = el('p', 'mv-env-s'), onde = (o ? o.codigo + ' · ' : '') + T.locTitulo(e.loc);
      if (fase === 'a-enviar') { t.textContent = 'A enviar…'; sub.textContent = 'Não feches a app até chegar a confirmação.'; }
      else if (fase === 'guardado') { t.textContent = K.semArmazem() ? 'Por enviar' : 'Guardado no telemóvel'; sub.textContent = K.semArmazem() ? 'Neste telemóvel não consigo guardar: não feches esta página. Segue quando houver rede.' : (e.mensagem && !e.rede ? e.mensagem : 'Segue sozinho quando houver rede, com a app aberta.'); }
      else if (fase === 'parado') { t.textContent = 'Não entrou'; sub.textContent = e.mensagem || it.erro || ''; }
      else { t.textContent = 'Registado'; sub.textContent = onde; }
      est.appendChild(t); est.appendChild(sub); v.appendChild(est);
      (it.avisos || []).filter(function (a) { return a !== T.textoAviso({ motivo: 'bc-criado' }); }).forEach(function (a) { var p = el('p', 'mv-erro ama'); p.appendChild(ic('alerta')); p.appendChild(el('span', null, a)); v.appendChild(p); });   // o bloqueio do cliente que nasceu diz-se no recibo, sem alarme
      var lista = el('div', 'mv-lista');
      lista.appendChild(K.rlinha('O que falta', (it.campos && it.campos.texto) || ''));
      if (fase !== 'feito') lista.appendChild(K.rlinha('Onde', onde));
      if (e.bloqueio) lista.appendChild(K.rlinha('Está bloqueado', T.nomeQuem(e.bloqueio) + (e.registo && e.registo.bloqueio && !e.registo.bloqueio.porConfirmar ? '' : ' · por confirmar')));
      if (it.bcCriado) lista.appendChild(K.rlinha('Bloqueio do cliente', 'registado também'));
      var fs = (it.fotos || []).filter(function (x) { return x.blob || x.prev; });
      if (fs.length) { var mi = el('b', 'mv-minis'); fs.forEach(function (x, i) { var im = el('img'); im.alt = 'Foto ' + (i + 1); im.src = x.prev || urlLocal(x); mi.appendChild(im); }); lista.appendChild(K.rlinha('Foto', mi)); }
      v.appendChild(lista);
      if (fase === 'feito') { var cm = el('p', 'mv-calmo'); cm.appendChild(ic('ok')); cm.appendChild(document.createTextNode(e.registo && (e.registo.pode || []).indexOf('planear') >= 0 ? 'Planeias o dia ou o bloqueio na lista dos trabalhos.' : 'O DO e o GP planeiam o dia ou o bloqueio.')); v.appendChild(cm); }
      var bb = limpar($('barra-tf-env'));
      var bo = bt('mv-btn pri', 'Outro'); bo.id = 'b-tf-outro'; bo.addEventListener('click', function () { var ob = it.obraId, loc = e.loc; S.envio = null; abrirForm(ob, { loc: loc || null, substituir: true }); if (S.form && loc) S.form.locAuto = true; });
      var bf = bt('mv-btn ghost', 'Feito'); bf.id = 'b-tf-feito'; bf.addEventListener('click', function () { S.envio = null; K.irHoje(true); });
      bb.appendChild(bo); bb.appendChild(bf);
      K.A.medirBarra();
    }

    // ── O envio (chamado pelo drenar da casca, item a item) ──
    function processar(q) { return T.processarTf(q, deps()); }
    async function aoResultado(q, res) {
      var ch = K.cache();
      if (res.estado === 'entregue' && q.registo) {
        var r = JSON.parse(JSON.stringify(q.registo));
        (r.fotos || []).forEach(function (f) { var l = (q.fotos || []).filter(function (x) { return x.n === f.n; })[0]; if (l && l.estado === 'confirmada' && f.estado === 'por-enviar') f.estado = 'por-arquivar'; });
        T.porRegisto(ch, r); K.gravarCache(); K.marcarReler();
        if (q.bcCriado && ch.bc) delete ch.bc[q.obraId];   // o bloqueio do cliente que nasceu: relê-se ao abrir a folha
        if (q.accao !== 'criar' && (!S.envio || S.envio.item.id !== q.id) && q.avisos && q.avisos.length) K.toast(q.avisos[0], { ms: 4000 });
      }
      if (res.estado === 'parar' && q.motivo === 'outro-fechado') {   // o bloqueio do cliente a que se ligava já fechou: diz-se, e relê-se a lista dele
        if (ch.bc) delete ch.bc[q.obraId];
        K.toast((q.resumo ? q.resumo + ': ' : '') + q.erro, { ms: 6000 });
      }
      if (res.estado === 'conflito') {   // o registo relê-se; diz-se o que mudou, em linguagem de obra (o que se escreveu fica na fila)
        await lerLista(q.obraId);
        var x = T.listaDe(K.cache(), q.obraId), reg = x ? (x.data.trabalhos || []).filter(function (t) { return t.id === q.registoId; })[0] : null;
        q.erro = T.textoConflito(reg, res.conflito && res.conflito.estado); K.guardarItem(q);
        K.toast((q.resumo ? q.resumo + ': ' : '') + q.erro, { ms: 6000 });
      }
      if (S.envio && S.envio.item.id === q.id) {
        S.envio.fase = res.estado === 'entregue' ? 'feito' : (res.estado === 'parar' || res.estado === 'conflito' ? 'parado' : 'guardado');
        S.envio.mensagem = res.mensagem; S.envio.rede = !!res.rede; if (q.registo) S.envio.registo = q.registo;
        if (K.vista() === 'v-tf-envio') desenharEnvio();
      }
      redesenharLista();
    }
    /** A linha do «Por enviar». */
    function linhaFila(q, emCurso) {
      var o = K.obraDe(q.obraId), parado = q.estado === 'parado', adiado = q.adiadoAte && q.adiadoAte > new Date().toISOString();
      var est = parado ? (q.erro || 'Não entrou') : (emCurso ? 'A enviar…' : (adiado ? 'Segue daqui a nada' : (!K.A.sessaoValida() ? 'À espera de entrares' : (!K.online() ? 'À espera de rede' : (q.erro || 'Na fila')))));
      var acoes = [];
      if (parado && (q.motivo === 'conflito' || q.motivo === 'outro-fechado')) acoes.push(['chev', 'Ver o trabalho', function () { abrirLista(q.obraId); }]);
      else if (parado && q.motivo !== 'dia-fechado' && q.motivo !== 'externa') acoes.push(['atual', 'Tentar de novo', function () { q.estado = 'a-enviar'; q.erro = ''; K.guardarItem(q); K.drenar(true); }]);
      else if (!parado) acoes.push(['atual', 'Tentar agora', function () { if (!K.A.sessaoValida()) { K.A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); return; } q.adiadoAte = ''; K.drenar(true); }]);
      return { ic: q.accao === 'feito' ? 'ok' : (q.accao === 'planear' ? 'relogio' : 'falta'), titulo: T.tituloItem(q) + (o ? ' · ' + o.codigo : ''), resumo: T.resumoItem(q), estado: est, cls: parado ? 'neg' : null, acoes: acoes, apagar: parado };
    }

    // ── Hoje: o bloco Trabalhos abre a lista (várias obras: primeiro a obra) ──
    function folhaObras(ms) {
      var l = (ms || []).filter(function (m) { return m.trabalhos; });
      K.folha({ titulo: 'Trabalhos em falta', sub: 'Escolhe a obra', corpo: function (cc) {
        l.forEach(function (m) {
          var b = bt('mv-lo mv-lo-ir'); b.setAttribute('data-obra', m.id);
          var n = el('span', 'mv-lo-n', m.nome), tr = m.trabalhos, pc = [];
          pc.push(tr.abertos + ' em falta'); if (tr.atrasados) pc.push(tr.atrasados + (tr.atrasados === 1 ? ' atrasado' : ' atrasados')); if (tr.bloqueados) pc.push(tr.bloqueados + ' bloq.');
          n.appendChild(el('small', null, pc.join(' · ')));
          junta(b, el('code', null, m.codigo), n, ic('chev'));
          b.addEventListener('click', function () { K.A.fecharFolhas(true); abrirLista(m.id); });
          cc.appendChild(b);
        });
      } });
    }

    function ligar() {
      var on = function (id, fn) { var i = $(id); if (i) i.addEventListener('change', function (ev) { Promise.resolve(fn(ev.target.files)).then(function () { ev.target.value = ''; }); }); };
      on('t-cam', juntarFotos); on('t-gal', juntarFotos); on('t-dep', fotoDepois);
    }
    function aoSair() { gravarRascunhoJa(); Object.keys(S.urls).forEach(function (k) { if (S.urls[k] && S.urls[k] !== 'arquivada' && URL.revokeObjectURL) URL.revokeObjectURL(S.urls[k]); }); S = { obra: '', filtro: 'fazer', lendo: false, erro: '', fora: '', form: null, envio: null, feitoTmp: {}, urls: {}, pedidosUrl: {}, bq: null, sel: '' }; }

    return {
      VISTAS: ['v-tf', 'v-tf-form', 'v-tf-envio'], ROTULO: { 'v-tf': 'Trabalhos', 'v-tf-form': 'Trabalho', 'v-tf-envio': 'Trabalho' },
      TITULO: { 'v-tf': 'Trabalhos em falta', 'v-tf-form': 'Trabalho em falta', 'v-tf-envio': 'Trabalho em falta' },
      disponivel: disponivel, abrirLista: abrirLista, abrirForm: abrirForm, folhaObras: folhaObras, abrirTrabalhoDe: abrirTrabalhoDe,
      carregarRascunhos: carregarRascunhos, gravarRascunhoJa: gravarRascunhoJa, temRascunho: function () { return meusRascunhos().length > 0; }, linhasRascunho: linhasRascunho,
      folhaCorrigir: folhaCorrigir, linkCorrigir: linkCorrigir, accoesFoto: accoesFoto, notaFotos: notaFotos, folhaConfirmar: folhaConfirmar, blobFoto: blobFoto,
      desenhar: function (v) { if (v === 'v-tf') desenharLista(); else if (v === 'v-tf-form') desenharForm(); else if (v === 'v-tf-envio') desenharEnvio(); },
      temForm: function () { return !!S.form; }, temEnvio: function () { return !!S.envio; },
      processar: processar, aoResultado: aoResultado, linhaFila: linhaFila, redesenhar: redesenharLista,
      ligar: ligar, aoSair: aoSair, _estado: function () { return S; },
    };
  }
  self.DoeMovelTfEcra = { criar: criar };
}());
