/* DOE · Telemóvel — o Hoje da fatia 2a (12 nov 2026): lógica pura (sem DOM), UMD como diario.js (self.DoeMovelHoje no
   browser, require em Node), para ser testada sem browser e contra o servidor real.
   Uma só leitura, GET /movel/hoje?obra=<id>|todas (contrato: docs/analises/Movel-Fatia2-Contrato.md, rota 1), e as contas
   do mosaico dos protótipos validados pelo Pedro: DOEX-Telemovel-App-Prototipo.html (o Hoje em Mosaico) e
   DOEX-Telemovel-Hoje-Todas-as-Obras-Prototipo.html (variante D: Geral · Obras). Regras que esta lógica cumpre:
   - um bloco que o servidor manda a null (funcionalidade fora de «Edge ∩ SQL») nunca mostra números: fica «Em breve»;
   - «diário por fazer» numa obra = dia útil, a obra sem registos hoje (serie7[6].registos, a regra do contrato) e sem o
     meu (aceite ou por enviar neste telemóvel). É a MESMA função para a faixa, o ponto, a palavra da obra, o número do
     Geral e a folha «Diário por fazer»: um número e o que o toque abre cobrem a mesma população;
   - a palavra de uma obra é só o mais grave: o `problema` do servidor, depois o diário por fazer, depois os bloqueios;
   - um dia que a cópia não traz (lida noutro dia) não se afirma: fica «sem dados», nunca «sem diário»;
   - o que se lê guarda-se na cache da conta (diario.js cacheDaConta, chave `painel`): sai ao Sair e com o token revogado. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'));
  else raiz.DoeMovelHoje = fabrica(raiz.DoeMovelDiario);
}(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';
  var ROTA = '/movel/hoje?obra=';
  var RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function num(v) { return Number(v) || 0; }
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  // ── Rede ──
  function lerHoje(deps, obra) { return D.pedir(deps, 'GET', ROTA + encodeURIComponent(obra)); }
  /** O servidor não tem o Hoje da 2a: o SQL por aplicar (503), a Edge antiga (o portão do âmbito recusa a rota que não
      conhece: 403 TOKEN_DE_AMBITO) ou a rota inexistente. A página volta à leitura da fatia 1 (/movel/diario/hoje),
      sem pedir o login. Qualquer 403 conta como «sem acesso a esta parte» (a conta externa, recusada nas rotas da fatia 2
      desde a revisão do servidor de 12 nov 2026; um papel que não lê): os blocos ficam «Em breve» e o diário e a
      ocorrência continuam. Um 403 que valha também para o diário (TOKEN_DE_AMBITO de um token que não é do telemóvel,
      SEM_PERFIL) repete-se na leitura da fatia 1, que diz então o que fazer. Um 404 OBRA_INVALIDA também volta: a
      leitura da fatia 1 não depende da obra. */
  function semHoje(r) {
    if (!r || r.ok || r.rede) return false;
    if (r.status === 403) return true;
    return r.code === 'MOVEL_FATIA2_POR_INSTALAR' || r.code === 'ROUTE_NOT_FOUND' || r.code === 'NOT_FOUND' || r.code === 'OBRA_INVALIDA';
  }
  /** Quem tem uma só obra lê-a pelo id; quem tem várias lê «todas» (as minhas: GP, DO ou encarregado). */
  function chaveDe(obrasPermitidas) { var l = obrasPermitidas || []; return l.length === 1 ? String(l[0].id) : 'todas'; }

  // ── Cópia por conta ──
  /** Guarda a leitura na cache da conta (cache.painel[chave]) e acerta o «hoje» que o diário usa (dia, fecha às,
      contrato e os meus registos de hoje), como diario.js guardarHoje. */
  function guardar(cache, chave, data, agora) {
    var lidoEm = (agora || new Date()).toISOString(), obras = Array.isArray(data.obras) ? data.obras : [];
    if (!cache.painel || typeof cache.painel !== 'object') cache.painel = {};
    cache.painel[String(chave)] = { data: copia(data), lidoEm: lidoEm };
    var ant = cache.hoje && cache.hoje.dia === data.dia ? (cache.hoje.meus || []) : [], ids = obras.map(function (o) { return o.id; });
    var meus = ant.filter(function (m) { return ids.indexOf(m.obraId) < 0; });
    obras.forEach(function (o) { var m = o.diario && o.diario.meu; if (m && m.id) meus.push({ id: m.id, obraId: o.id, versao: m.versao, totalHomens: num(m.totalHomens) }); });
    cache.hoje = { dia: data.dia, fechaEm: data.fechaEm, obraSugerida: (cache.hoje && cache.hoje.obraSugerida) || null, meus: meus,
      contrato: Number.isInteger(data.contrato) ? data.contrato : 0, funcionalidades: Array.isArray(data.funcionalidades) ? data.funcionalidades.slice() : [] };
    cache.lidoEm = lidoEm;
    return cache;
  }
  function copiaDe(cache, chave) { var p = cache && cache.painel && cache.painel[String(chave)]; return p && p.data ? p : null; }
  /** Uma obra na cópia: a da leitura dela ou a de «todas», a mais recente. { o, lidoEm } ou null. */
  function obraNaCopia(cache, id) {
    var cands = [];
    [String(id), 'todas'].forEach(function (k) { var p = copiaDe(cache, k); if (!p) return; var o = (p.data.obras || []).filter(function (x) { return x.id === id; })[0]; if (o) cands.push({ o: o, lidoEm: p.lidoEm, dia: p.data.dia }); });
    cands.sort(function (a, b) { return String(b.lidoEm).localeCompare(String(a.lidoEm)); });
    return cands[0] || null;
  }

  // ── Os 7 dias de uma obra (os do servidor; um dia que a cópia não traz fica por conhecer) ──
  function serie(serie7, hoje, feriados) {
    var por = {}, fer = feriados || {};
    (Array.isArray(serie7) ? serie7 : []).forEach(function (x) { if (x && RE_DIA.test(String(x.dia || ''))) por[x.dia] = x; });
    return D.seteDias(hoje).map(function (d) {
      var x = por[d], reg = x ? num(x.registos) : 0, tem = reg > 0;
      return { dia: d, doe: tem ? num(x.doe) : 0, sub: tem ? num(x.sub) : 0, total: tem ? num(x.total) : 0, tem: tem, registos: reg, meu: null,
        conhecido: !!x, fds: D.fimDeSemana(d), feriado: fer[d] || '', hoje: d === hoje, pend: 0, antes: false };
    });
  }
  /** O último dia antes de hoje com diário na série: { dia, total, doe } ou null. */
  function ultimoDia(s) { for (var k = s.length - 2; k >= 0; k--) if (s[k].tem) return { dia: s[k].dia, total: s[k].total, doe: s[k].doe }; return null; }

  /** O modelo de uma obra. ctx: { hoje, feriados, meu: {doe, sub} | null (o meu de hoje aceite, neste telemóvel),
      pend: homens do meu de hoje que está na fila (0 = nenhum) }. */
  function modeloObra(o, ctx) {
    var s = serie(o && o.diario && o.diario.serie7, ctx.hoje, ctx.feriados), h = s[6];
    if (!h.tem && ctx.meu) Object.assign(h, { tem: true, doe: num(ctx.meu.doe), sub: num(ctx.meu.sub), total: num(ctx.meu.doe) + num(ctx.meu.sub), registos: 1, conhecido: true, meu: { totalHomens: num(ctx.meu.doe) + num(ctx.meu.sub) } });   // o meu entrou depois da leitura: é dele
    var pend = h.tem ? 0 : num(ctx.pend);
    if (pend) h.pend = pend;
    var util = D.diaUtil(ctx.hoje, ctx.feriados);
    return { id: String(o.id), codigo: String(o.codigo || ''), nome: String(o.nome || ''), serie: s, util: util, tem: h.tem, homensHoje: h.tem ? h.total : null,
      pend: pend, porFazer: util && !h.tem && !pend, trabalhos: o.trabalhos || null, cliente: o.cliente || null, material: o.material || null,
      problema: o.problema === 'semResposta' || o.problema === 'atrasados' ? o.problema : null };
  }
  /** Uma palavra com cor: só o mais grave. rank 0 pede atenção primeiro (é a ordem da página Obras). */
  function palavra(m) {
    var t = m.trabalhos, c = m.cliente;
    if (m.problema === 'semResposta' && c && num(c.semResposta)) return { t: num(c.semResposta) + ' sem resposta', cls: 'neg-t', rank: 0 };   // («do cliente» diz-o o rótulo para o leitor de ecrã; a 360 px cortava-se)
    if (m.problema === 'atrasados' && t && num(t.atrasados)) return { t: pl(num(t.atrasados), 'atrasado', 'atrasados'), cls: 'neg-t', rank: 0 };
    if (m.porFazer) return { t: 'diário por fazer', cls: 'ama-t', rank: 1 };
    if (m.pend) return { t: 'diário por enviar', cls: 'ama-t', rank: 1 };
    if (c && num(c.ativos)) return { t: pl(num(c.ativos), 'bloqueio do cliente', 'bloqueios do cliente'), cls: 'ama-t', rank: 2 };
    if (!t && !c) return m.tem ? { t: 'diário feito', cls: 'pos-t', rank: 3 } : { t: 'sem diário hoje', cls: 'neu-t', rank: 3 };   // sem as outras funcionalidades não se diz «em dia»
    return { t: 'em dia', cls: 'pos-t', rank: 3 };
  }
  /** Pelo que pede atenção (estável: dentro do mesmo grau, a ordem do servidor, por código). */
  function ordenar(ms) { return ms.map(function (m, i) { return { m: m, i: i, r: palavra(m).rank }; }).sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.m; }); }
  function porFazer(ms) { return ms.filter(function (m) { return m.porFazer; }); }

  // ── Os blocos do mosaico (o que cada um mostra; o desenho é da casca) ──
  /** Diário de uma obra: com o de hoje, os homens de hoje; sem ele, os do último dia e «hoje por fazer» a âmbar.
      ultimoMeu: { dia, total } (o meu último registo, quando a série não tem nenhum). */
  function blocoDiario(m, ultimoMeu) {
    var h = m.serie[6], ult = ultimoDia(m.serie) || ultimoMeu || null, r = { n: '', nada: false, leg: [], est: m.porFazer ? 'ama' : '' };
    if (h.tem) { r.n = String(h.total); r.leg.push({ t: 'homens hoje' }); return r; }
    if (m.pend) { r.n = String(m.pend); r.leg.push({ t: 'hoje' }, { t: 'por enviar', cls: 'ama-t' }); return r; }
    if (ult) { r.n = String(ult.total); r.leg.push({ t: D.difDias(ult.dia, h.dia) === 1 ? 'ontem' : D.textoDiaMes(ult.dia) }); }
    else { r.n = '–'; r.nada = true; if (!m.util) r.leg.push({ t: h.feriado ? 'feriado' : 'sem registos' }); }
    if (m.porFazer) r.leg.push({ t: 'hoje por fazer', cls: 'ama-t' });
    return r;
  }
  /** Os 7 dias de várias obras somados (os dias que alguma conhece). */
  function serieSomada(ms) {
    if (!ms.length) return [];
    return ms[0].serie.map(function (x0, i) {
      var r = { dia: x0.dia, doe: 0, sub: 0, total: 0, tem: false, registos: 0, meu: null, conhecido: false, fds: x0.fds, feriado: x0.feriado, hoje: x0.hoje, pend: 0, antes: false };
      ms.forEach(function (m) { var x = m.serie[i]; if (x.conhecido) r.conhecido = true; if (x.tem) { r.tem = true; r.doe += x.doe; r.sub += x.sub; r.total += x.total; r.registos += x.registos; } else if (x.pend) r.pend += x.pend; });
      if (r.tem) r.pend = 0;
      return r;
    });
  }
  /** Diário de todas as obras (Geral): os homens de hoje dos diários já feitos e quantos faltam («6 hoje · 2 por fazer»). */
  function blocoDiarioGeral(ms, hoje, feriados) {
    var com = ms.filter(function (m) { return m.tem; }), pf = porFazer(ms), pe = ms.filter(function (m) { return m.pend; }), util = D.diaUtil(hoje, feriados);
    var r = { n: com.length ? String(com.reduce(function (a, m) { return a + m.homensHoje; }, 0)) : '–', nada: !com.length, leg: [{ t: 'hoje' }], est: pf.length ? 'ama' : '', com: com.length, porFazer: pf.length, serie: serieSomada(ms) };
    if (pf.length) r.leg.push({ t: pf.length + ' por fazer', cls: 'ama-t' });
    else if (pe.length) r.leg.push({ t: pe.length + ' por enviar', cls: 'ama-t' });
    else if (com.length && com.length === ms.length) r.leg.push({ t: 'em todas' });
    else if (!com.length && !util) r.leg = [{ t: (feriados || {})[hoje] ? 'feriado' : 'fim de semana' }];
    return r;
  }
  function segsTrabalhos(t) {
    return [['neg', num(t.atrasados), num(t.atrasados) === 1 ? 'atrasado' : 'atrasados'], ['bloq', num(t.bloqueados), num(t.bloqueados) === 1 ? 'bloqueado' : 'bloqueados'],
      ['nav', num(t.porFazer), 'por fazer'], ['cin', num(t.porPlanear), 'por planear']].filter(function (x) { return x[1] > 0; });
  }
  /** Trabalhos: os abertos, a barra (atrasados, bloqueados com trama, por fazer, por planear) e a legenda com os graves a cor. */
  function blocoTrabalhos(t) {
    if (!t) return null;
    var atr = num(t.atrasados), bl = num(t.bloqueados), pf = num(t.porFazer), pp = num(t.porPlanear), ab = num(t.abertos), fs = num(t.feitosSemana), l1 = [], l2 = [];
    if (atr) l1.push({ t: pl(atr, 'atrasado', 'atrasados'), cls: 'neg-t' });
    if (bl) l1.push({ t: bl + ' bloq.', cls: 'ama-t' });
    if (pf) l2.push({ t: pf + ' por fazer' });
    if (pp) l2.push({ t: pp + ' sem dia' });
    var caps = !ab ? [[{ t: fs ? pl(fs, 'feito', 'feitos') + ' esta semana' : 'Em dia' }]] : (l1.length && l2.length ? [l1, l2] : [l1.length ? l1 : l2]);
    var segs = segsTrabalhos(t);
    return { n: String(ab), leg: 'em falta', est: atr ? 'neg' : (bl ? 'ama' : ''), segs: segs, caps: caps,
      aria: 'Trabalhos: ' + pl(ab, 'em falta', 'em falta') + (segs.length ? ' (' + segs.map(function (x) { return x[1] + ' ' + x[2]; }).join(', ') + ')' : '') + '. Ver por estado' };
  }
  /** Cliente: os bloqueios activos E os resolvidos com trabalhos ainda por desbloquear (a mesma população dos pontos, do
      «Ativos» da lista e da folha das obras: revisão da parte 4), a idade do mais antigo e a palavra do estado («2 por
      formalizar», «1 sem resposta», «1 por desbloquear»). O encarregado vê o que é dele (por confirmar); a formalização é do GP. */
  function blocoCliente(c, hoje, encarregado) {
    if (!c) return null;
    var at = num(c.ativos), rct = num(c.resolvidosComTrabalhos), n = at + rct, conf = num(c.porConfirmar), form = num(c.porFormalizar), sr = num(c.semResposta), cap;
    var desb = rct ? { t: rct + ' por desbloquear' } : null;
    if (encarregado) cap = conf ? { t: conf + ' por confirmar', cls: 'ama-t' } : (at ? { t: 'à espera do cliente' } : (desb || { t: 'Sem bloqueios' }));
    else cap = sr ? { t: sr + ' sem resposta', cls: 'neg-t' } : (form ? { t: form + ' por formalizar', cls: 'ama-t' } : (conf ? { t: conf + ' por confirmar', cls: 'ama-t' } : (at ? { t: 'formalizados, à espera' } : (desb || { t: 'Sem bloqueios' }))));
    var tl = linhaTempo(c, hoje);
    return { n: String(n), leg: n === 1 ? 'bloqueio' : 'bloqueios', est: sr ? 'neg' : ((encarregado ? conf : (conf || form)) ? 'ama' : ''), cap: cap, tl: tl,
      aria: 'Cliente: ' + pl(n, 'bloqueio', 'bloqueios') + (tl ? ', o mais antigo há ' + pl(tl.dias, 'dia', 'dias') : '') + (cap.cls ? ', ' + cap.t : '') + '. Ver por estado' };
  }
  var COR_PONTO = { POR_CONFIRMAR: 'conf', POR_FORMALIZAR: 'ama', FORMALIZADO: 'cin', RESOLVIDO: 'cin' };
  var NOME_PONTO = { POR_CONFIRMAR: 'por confirmar', POR_FORMALIZAR: 'por formalizar', FORMALIZADO: 'formalizado', RESOLVIDO: 'resolvido, com trabalhos por desbloquear' };
  /** A linha de tempo do bloco Cliente (protótipo validado, linhaTempoCli): um ponto por bloqueio, à distância de hoje
      (até 14 dias ou mais), com a cor do estado (sem resposta a vermelho, por confirmar só o anel, por formalizar âmbar,
      o resto neutro); os que caem perto uns dos outros empilham-se. Os pontos vêm do servidor (cliente.pontos, 2.ª revisão);
      um servidor que ainda não os mande dá um ponto só, neutro, no mais antigo. null = sem bloqueios. */
  function linhaTempo(c, hoje) {
    var lst = Array.isArray(c.pontos) ? c.pontos.filter(function (p) { return p && RE_DIA.test(String(p.dia || '')); }) : null;
    if (!lst || !lst.length) {
      if (!(num(c.ativos) + num(c.resolvidosComTrabalhos)) || !RE_DIA.test(String(c.maisAntigo || ''))) return null;
      lst = [{ dia: c.maisAntigo, estado: '', semResposta: false }];
    }
    var pos = lst.map(function (p) { var d = Math.max(0, D.difDias(p.dia, hoje)); return { d: d, x: 1 - Math.min(d, 14) / 14, c: p.semResposta ? 'neg' : (COR_PONTO[p.estado] || 'cin'), nome: p.semResposta ? 'sem resposta' : (NOME_PONTO[p.estado] || 'bloqueio') }; })
      .sort(function (a, b) { return a.x - b.x; });
    var filas = [];
    pos.forEach(function (p) { var r = 0; while ((filas[r] || []).some(function (q) { return Math.abs(q.x - p.x) < 0.1; })) r++; (filas[r] = filas[r] || []).push(p); p.r = Math.min(r, 2); });
    var v = pos[0], mais = num(c.maisPontos);
    return { dias: v.d, x: v.x, rot: v.d >= 14 ? '14+ d' : v.d + ' d', pontos: pos, mais: mais,
      aria: pl(pos.length + mais, 'bloqueio do cliente', 'bloqueios do cliente') + ': ' + pos.map(function (p) { return p.nome + ' há ' + pl(p.d, 'dia', 'dias'); }).join(', ') + (mais ? ' e mais ' + mais : '') };
  }

  // ── As folhas dos blocos (os números por estado; a lista chega na próxima versão) ──
  /** As linhas somam o número do bloco (a mesma população): atrasados + bloqueados + por fazer + por planear = abertos. */
  function linhasTrabalhos(t) {
    if (!t) return null;
    var bl = num(t.bloqueados), sub = [];
    if (num(t.porConfirmar)) sub.push(num(t.porConfirmar) + ' por confirmar');
    if (num(t.bloqueadosCliente)) sub.push(num(t.bloqueadosCliente) + ' pelo cliente');
    return { total: num(t.abertos), feitosSemana: num(t.feitosSemana), linhas: [
      { k: 'atrasados', rot: 'Atrasados', n: num(t.atrasados), cls: num(t.atrasados) ? 'neg-t' : '' },
      { k: 'bloqueados', rot: 'Bloqueados', n: bl, cls: bl ? 'ama-t' : '', sub: sub.join(' · ') },
      { k: 'porFazer', rot: 'Por fazer', n: num(t.porFazer) },
      { k: 'porPlanear', rot: 'Por planear (sem dia)', n: num(t.porPlanear) }] };
  }
  /** Por confirmar + por formalizar + formalizados = activos; «sem resposta» é uma parte dos formalizados. */
  function linhasCliente(c, hoje) {
    if (!c) return null;
    var n = num(c.ativos), conf = num(c.porConfirmar), form = num(c.porFormalizar), sr = num(c.semResposta), fz = Math.max(0, n - conf - form);
    var antigo = n && RE_DIA.test(String(c.maisAntigo || '')) ? { dia: c.maisAntigo, dias: Math.max(0, D.difDias(c.maisAntigo, hoje)) } : null;
    return { total: n, antigo: antigo, linhas: [
      { k: 'porConfirmar', rot: 'Por confirmar', n: conf, cls: conf ? 'ama-t' : '' },
      { k: 'porFormalizar', rot: 'Por formalizar', n: form, cls: form ? 'ama-t' : '' },
      { k: 'formalizados', rot: 'Formalizados, à espera do cliente', n: fz, cls: sr ? 'neg-t' : '', sub: sr ? sr + ' sem resposta' : '' }] };
  }
  /** A frase de uma obra na folha «Diário por fazer»: o último dia com diário (da obra) nos 7 dias. */
  function ultimoTexto(m) {
    var u = ultimoDia(m.serie);
    if (!u) return 'sem diário nos últimos 7 dias';
    return (D.difDias(u.dia, m.serie[6].dia) === 1 ? 'ontem' : 'a ' + D.textoDiaMes(u.dia)) + ' ' + D.txtHomens(u.total);
  }

  return {
    ROTA: ROTA, lerHoje: lerHoje, semHoje: semHoje, chaveDe: chaveDe, guardar: guardar, copiaDe: copiaDe, obraNaCopia: obraNaCopia,
    serie: serie, ultimoDia: ultimoDia, modeloObra: modeloObra, palavra: palavra, ordenar: ordenar, porFazer: porFazer,
    blocoDiario: blocoDiario, serieSomada: serieSomada, blocoDiarioGeral: blocoDiarioGeral, segsTrabalhos: segsTrabalhos,
    blocoTrabalhos: blocoTrabalhos, blocoCliente: blocoCliente, linhaTempo: linhaTempo, linhasTrabalhos: linhasTrabalhos, linhasCliente: linhasCliente, ultimoTexto: ultimoTexto,
  };
}));
