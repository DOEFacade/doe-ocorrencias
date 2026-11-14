/* DOE · Telemóvel — Diário de obra: lógica pura (sem DOM). UMD como logica.js: corre no browser
   (self.DoeMovelDiario) e em Node (require), para ser testada sem browser.
   Contrato: docs/analises/Movel-Diario-Contrato.md (rotas 2 a 7b). Regras que esta lógica cumpre:
   - o «hoje» e o «fecha às» vêm do servidor (`dia`, `fechaEm`), nunca do relógio do telemóvel (sem rede estima-se:
     passada a meia-noite que o servidor disse, é o dia seguinte);
   - por (obra, dia) um `id` de registo gerado uma vez e guardado; por cada «Guardar» um `pedidoId` novo, repetido tal e
     qual quando o mesmo envio tem de ser repetido (idempotência);
   - cada foto local fica com o `n` que o servidor lhe deu (`fotos[].nPedido → n`); `n: null` = ficou de fora;
   - com `reler` (ou `fundido`) o registo relê-se antes da correcção seguinte;
   - o que se lê do servidor guarda-se POR CONTA e nunca aparece a outra conta (cacheDaConta);
   - nada se perde: o que não entrou fica na fila, com o motivo;
   - liberdade de corrigir (decisão do Pedro, 13 nov 2026): quem registou corrige e anula até 7 dias depois do dia do registo
     (o GP e o DO da obra, o seu, a qualquer altura). Corrigir e Anular mostram-se só pelo `pode` do servidor (GET
     /movel/diario?obra=&dia=): a página não decide pelo dia. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.DoeMovelDiario = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** A versão do contrato do servidor que esta página precisa para os pedidos com campos omitidos e com textoModo
      (2.ª revisão, 12 nov 2026). O login e GET /movel/diario/hoje devolvem `contrato` (ausente = 0). Abaixo disto a página
      não envia esses pedidos: ficam na fila. Um só sítio: o diagnóstico do servidor lê-o por este nome. */
  var CONTRATO_MINIMO = 3;
  var LIMITES = { fotos: 6, nMax: 12, homens: 99, equipas: 20, texto: 2000, nomeEquipa: 40, localizacoes: 60, msLeitura: 15000, msEscrita: 25000, histDias: 30 };
  // Frases de um toque quando a pessoa ainda não escreveu nada nesta obra (o servidor dá as dela, até 6).
  var FRASES_BASE = ['Continuação da montagem', 'Parado por chuva', 'Descarga de material', 'Selagem das juntas', 'Montagem de vidros'];
  var DIAS_C = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var DIAS_L = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  var INI = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  var MESES_C = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function uuid(novoId) { return String(novoId ? novoId() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); }
  function novoIdRegisto(novoId) { return ('dia-' + uuid(novoId)).slice(0, 64); }
  function novoPedidoId(novoId) { return ('ped-' + uuid(novoId)).slice(0, 64); }

  // ── Datas (texto AAAA-MM-DD; aritmética em UTC, o dia vem do servidor) ──
  function partes(dia) { var p = String(dia).split('-'); return [+p[0], +p[1] - 1, +p[2]]; }
  function emUtc(dia) { var p = partes(dia); return new Date(Date.UTC(p[0], p[1], p[2])); }
  function dois(n) { return ('0' + n).slice(-2); }
  function deUtc(d) { return d.getUTCFullYear() + '-' + dois(d.getUTCMonth() + 1) + '-' + dois(d.getUTCDate()); }
  function somarDias(dia, n) { var d = emUtc(dia); d.setUTCDate(d.getUTCDate() + n); return deUtc(d); }
  function diaDaSemana(dia) { return emUtc(dia).getUTCDay(); }
  function fimDeSemana(dia) { var w = diaDaSemana(dia); return w === 0 || w === 6; }
  function difDias(a, b) { return Math.round((emUtc(b) - emUtc(a)) / 864e5); }
  function textoDiaMes(dia) { var p = partes(dia); return p[2] + ' ' + MESES_C[p[1]]; }
  function textoDiaCurto(dia) { return DIAS_C[diaDaSemana(dia)] + ' ' + textoDiaMes(dia); }
  function textoDiaLongo(dia) { return DIAS_L[diaDaSemana(dia)] + ', ' + textoDiaMes(dia); }
  function inicialDia(dia) { return INI[diaDaSemana(dia)]; }
  function diaCurto(dia) { return DIAS_C[diaDaSemana(dia)]; }
  /** «ontem», «a 9 nov» (relativo ao dia de hoje do servidor). */
  function quandoFoi(dia, hoje) { return difDias(dia, hoje) === 1 ? 'ontem' : 'a ' + textoDiaMes(dia); }
  /** O dia de hoje: o do servidor; sem rede, se a meia-noite que o servidor disse já passou, avança (estimativa). */
  function diaAtual(info, agoraMs) {
    if (!info || !RE_DIA.test(String(info.dia || ''))) return null;
    var dia = info.dia, fecha = Date.parse(info.fechaEm || ''), agora = agoraMs == null ? Date.now() : agoraMs, n = 0;
    while (!isNaN(fecha) && agora >= fecha && n < 400) { dia = somarDias(dia, 1); fecha += 864e5; n++; }
    return { dia: dia, fechaEm: isNaN(fecha) ? '' : new Date(fecha).toISOString(), estimado: n > 0 };
  }
  function diaAberto(fechaEm, agoraMs) { var f = Date.parse(fechaEm || ''); return isNaN(f) || (agoraMs == null ? Date.now() : agoraMs) < f; }
  /** Os 7 dias até hoje (inclusive), do mais antigo para hoje. */
  function seteDias(hoje) { var l = []; for (var k = 6; k >= 0; k--) l.push(somarDias(hoje, -k)); return l; }

  // ── Cache por conta (privacidade no aparelho) ──
  function cacheVazia(contaId) { return { contaId: String(contaId || ''), hoje: null, obras: {}, ids: {}, versoes: {}, versoesMinhas: {}, reler: {}, hist: [], locs: {}, registos: {}, dias: {}, painel: {}, tf: {}, bc: {}, tfUlt: {}, lidoEm: '' }; }   // painel: as leituras do Hoje da fatia 2a (hoje.js); tf, bc: as listas dos trabalhos e dos bloqueios do cliente (trabalhos.js); tfUlt: a última Localização de um trabalho, por obra (trabalhos-ecra.js)
  /** A cache só serve a conta que a escreveu: outra conta recebe uma vazia (e a antiga deita-se fora). */
  function cacheDaConta(cache, contaId) {
    if (!contaId) return cacheVazia('');
    if (cache && typeof cache === 'object' && cache.contaId === String(contaId)) {
      var c = cacheVazia(contaId);
      Object.keys(c).forEach(function (k) { if (cache[k] != null) c[k] = cache[k]; });
      return c;
    }
    return cacheVazia(contaId);
  }
  function chaveDia(obraId, dia) { return String(obraId) + '|' + String(dia); }
  /** O id do registo para (obra, dia): o do servidor se o tem, senão o que este telemóvel já gerou, senão um novo. */
  function idRegistoDe(cache, obraId, dia, meu, novoId) {
    if (meu && meu.id) { cache.ids[chaveDia(obraId, dia)] = meu.id; return meu.id; }
    var k = chaveDia(obraId, dia);
    if (!cache.ids[k]) cache.ids[k] = novoIdRegisto(novoId);
    return cache.ids[k];
  }
  /** Guarda (ou actualiza) um registo meu no histórico local: é daqui que sai o gráfico dos 7 dias. */
  function registarHistorico(cache, r, hoje) {
    if (!r || !r.obraId || !RE_DIA.test(String(r.dia || ''))) return cache;
    var e = { obraId: String(r.obraId), dia: r.dia, equipas: copia(r.equipas || []), texto: String(r.texto || ''), fotos: Number(r.fotos) || 0, versao: Number(r.versao) || 0, alteradoEm: r.alteradoEm || '', soEquipas: !!r.soEquipas };
    var i = -1;
    cache.hist.forEach(function (x, j) { if (x.obraId === e.obraId && x.dia === e.dia) i = j; });
    if (i >= 0) { var ant = cache.hist[i]; if (e.soEquipas && !ant.soEquipas) return cache; if (!e.soEquipas || ant.soEquipas) cache.hist[i] = e; }
    else cache.hist.push(e);
    if (hoje) { var lim = somarDias(hoje, -LIMITES.histDias); cache.hist = cache.hist.filter(function (x) { return x.dia >= lim; }); }
    cache.hist.sort(function (a, b) { return a.dia < b.dia ? 1 : (a.dia > b.dia ? -1 : 0); });
    return cache;
  }
  /** O que o servidor diz das leituras entra na cache: o de hoje (rota 2) e o da obra (rota 3). */
  function guardarHoje(cache, data, agora) {
    cache.hoje = { dia: data.dia, fechaEm: data.fechaEm, obraSugerida: data.obraSugerida || null, meus: Array.isArray(data.meus) ? copia(data.meus) : [], contrato: Number.isInteger(data.contrato) ? data.contrato : 0 };
    cache.lidoEm = (agora || new Date()).toISOString();
    return cache;
  }
  /** O meu registo de um dia passado (GET /movel/diario?obra=&dia=, 13 nov 2026): entra na cópia do registo (com o `pode` e o
      `corrigeAte`), sem mexer no que a obra diz de hoje. Sem registo meu nesse dia (anulado, ou nunca houve), a cópia sai. */
  function guardarDiaLido(cache, obraId, data) {
    var dia = data && data.dia; if (!RE_DIA.test(String(dia || ''))) return cache;
    var k = chaveDia(obraId, dia), m = data.meu || null;
    if (!m) { delete cache.registos[k]; cache.hist = (cache.hist || []).filter(function (x) { return !(x.obraId === String(obraId) && x.dia === dia && !x.soEquipas); }); return cache; }
    cache.registos[k] = Object.assign(copia(m), { conhecido: { texto: true, localizacoes: true, fotos: true } });
    idRegistoDe(cache, obraId, dia, m); cache.versoes[m.id] = m.versao;
    registarHistorico(cache, { obraId: obraId, dia: dia, equipas: m.equipas, texto: m.texto, fotos: (m.fotos || []).length, versao: m.versao, alteradoEm: m.alteradoEm });
    return cache;
  }
  /** Depois de um anular aceite: o registo deixa de contar neste telemóvel (a cópia, o histórico dos 7 dias, o «meu de hoje»).
      O id fica para esse dia: gravar outra vez o mesmo dia repõe-no no servidor. */
  function aoAnulado(cache, obraId, dia, data) {
    var k = chaveDia(obraId, dia), id = (data && data.id) || cache.ids[k];
    delete cache.registos[k];
    if (id && data && data.versao != null) cache.versoes[id] = Number(data.versao) || 0;
    cache.hist = (cache.hist || []).filter(function (x) { return !(x.obraId === String(obraId) && x.dia === dia && !x.soEquipas); });
    if (cache.hoje && cache.hoje.dia === dia) cache.hoje.meus = (cache.hoje.meus || []).filter(function (x) { return !(x.obraId === String(obraId)); });
    var o = cache.obras[obraId]; if (o && o.dia === dia) o.meu = null;
    var d = cache.dias && cache.dias[obraId]; var x = d && d.data && Array.isArray(d.data.dias) ? d.data.dias.filter(function (y) { return y.dia === dia; })[0] : null;
    if (x && x.meu) { x.meu = null; x.registos = Math.max(0, (Number(x.registos) || 1) - 1); x.aproximado = true; }
    return cache;
  }
  /** O Corrigir e o Anular de um registo: só o que o servidor disse (`pode`). Um servidor antigo não o manda: nada. */
  function podeNoRegisto(meu, accao) { return !!(meu && Array.isArray(meu.pode) && meu.pode.indexOf(accao) >= 0); }
  function guardarObra(cache, obraId, data, agora) {
    var o = { dia: data.dia, fechaEm: data.fechaEm, meu: copia(data.meu || null), ultimo: copia(data.ultimo || null), sugestoes: copia(data.sugestoes || { equipas: [], frases: [] }), lidoEm: (agora || new Date()).toISOString() };
    cache.obras[obraId] = o;
    if (o.meu) cache.registos[chaveDia(obraId, o.meu.dia || data.dia)] = Object.assign(copia(o.meu), { conhecido: { texto: true, localizacoes: true, fotos: true } });
    if (o.meu) { idRegistoDe(cache, obraId, o.meu.dia || data.dia, o.meu); cache.versoes[o.meu.id] = o.meu.versao; registarHistorico(cache, { obraId: obraId, dia: o.meu.dia || data.dia, equipas: o.meu.equipas, texto: o.meu.texto, fotos: (o.meu.fotos || []).length, versao: o.meu.versao, alteradoEm: o.meu.alteradoEm }, data.dia); }
    if (o.ultimo && o.ultimo.dia) registarHistorico(cache, { obraId: obraId, dia: o.ultimo.dia, equipas: o.ultimo.equipas, soEquipas: true }, data.dia);
    delete cache.reler[obraId];   // acabou de se reler
    return cache;
  }

  // ── Equipas ──
  function normNome(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function chaveEquipa(e) { return (e.tipo === 'DOE' ? 'DOE' : 'SUB') + '|' + normNome(e.nome).toLowerCase(); }
  function totalHomens(eq) { return (eq || []).reduce(function (a, e) { return a + (Number(e.homens) || 0); }, 0); }
  function doeESub(eq) { var r = { doe: 0, sub: 0 }; (eq || []).forEach(function (e) { if (e.tipo === 'DOE') r.doe += Number(e.homens) || 0; else r.sub += Number(e.homens) || 0; }); return r; }
  function txtHomens(n) { return n === 0 ? 'sem homens' : n + (n === 1 ? ' homem' : ' homens'); }
  /** O que vai ao servidor: só equipas com homens, nomes limpos. */
  function equipasParaEnviar(eq) { return (eq || []).filter(function (e) { return Number(e.homens) > 0; }).map(function (e) { return { tipo: e.tipo === 'DOE' ? 'DOE' : 'SUB', nome: normNome(e.nome).slice(0, LIMITES.nomeEquipa), homens: Math.max(0, Math.min(LIMITES.homens, Math.round(Number(e.homens) || 0))) }; }); }
  function assinaturaEquipas(eq) { return JSON.stringify(equipasParaEnviar(eq).map(function (e) { return [chaveEquipa(e), e.homens]; }).sort()); }
  function mudarHomens(eq, i, delta) { var e = eq[i]; if (!e) return eq; e.homens = Math.max(0, Math.min(LIMITES.homens, (Number(e.homens) || 0) + delta)); return eq; }
  /** Junta (ou renomeia, com `indice`) uma equipa. Recusa nomes vazios, repetidos ou longos, e uma segunda DOE. */
  function porEquipa(eq, equipa, indice) {
    var nome = normNome(equipa && equipa.nome), tipo = equipa && equipa.tipo === 'DOE' ? 'DOE' : 'SUB';
    if (!nome) return { ok: false, motivo: 'Escreve o nome da equipa.' };
    if (nome.length > LIMITES.nomeEquipa) return { ok: false, motivo: 'O nome tem mais de ' + LIMITES.nomeEquipa + ' letras.' };
    if (tipo === 'SUB' && nome.toLowerCase() === 'doe') tipo = 'DOE';
    var k = chaveEquipa({ tipo: tipo, nome: nome });
    var rep = eq.some(function (e, j) { return j !== indice && (chaveEquipa(e) === k || (tipo === 'DOE' && e.tipo === 'DOE')); });
    if (rep) return { ok: false, motivo: tipo === 'DOE' ? 'A equipa DOE já está na lista.' : 'Essa equipa já está na lista.' };
    if (indice == null && eq.length >= LIMITES.equipas) return { ok: false, motivo: 'No máximo ' + LIMITES.equipas + ' equipas.' };
    if (indice != null && eq[indice]) { eq[indice].nome = nome; eq[indice].tipo = tipo; }
    else eq.push({ tipo: tipo, nome: nome, homens: 1 });
    return { ok: true };
  }
  /** As equipas sugeridas que ainda não estão na lista. */
  /** 3.ª revisão (4a): o que a pessoa mexeu nas equipas, UMA A UMA (chave: tipo + nome sem maiúsculas nem espaços nas
      pontas): mudou o número, acrescentou, tirou. Um nome trocado é tirar uma e acrescentar outra. */
  function deltaEquipas(base, atual) {
    var b = {}, a = {}, d = [];
    (base || []).forEach(function (e) { b[chaveEquipa(e)] = e; });
    (atual || []).forEach(function (e) { a[chaveEquipa(e)] = e; });
    Object.keys(a).forEach(function (k) { var e = a[k]; if (!b[k]) d.push({ accao: 'acrescentou', tipo: e.tipo, nome: normNome(e.nome), homens: Number(e.homens) || 0 }); else if ((Number(b[k].homens) || 0) !== (Number(e.homens) || 0)) d.push({ accao: 'mudou', tipo: e.tipo, nome: normNome(e.nome), homens: Number(e.homens) || 0 }); });
    Object.keys(b).forEach(function (k) { if (!a[k]) d.push({ accao: 'tirou', tipo: b[k].tipo, nome: normNome(b[k].nome) }); });
    return d;
  }
  /** Aplica as equipas mexidas por cima da lista de agora; as que a pessoa não tocou ficam como estão. */
  function aplicarDeltaEquipas(lista, delta) {
    var l = copia(lista || []);
    (delta || []).forEach(function (m) {
      var k = chaveEquipa(m), i = -1;
      l.forEach(function (e, j) { if (chaveEquipa(e) === k) i = j; });
      if (m.accao === 'tirou') { if (i >= 0) l.splice(i, 1); return; }
      if (i >= 0) l[i].homens = m.homens;
      else if (!(m.tipo === 'DOE' && l.some(function (e) { return e.tipo === 'DOE'; }))) l.push({ tipo: m.tipo, nome: m.nome, homens: m.homens });
    });
    return l;
  }
  /** Em poucas palavras, o que mudou nas equipas entre o que a pessoa viu e o que está agora no servidor. */
  function resumoDiferencas(antes, agora, exceto) {   // exceto: as equipas que a pessoa mexeu (ficam as dela: não se falam)
    var fora = {}; (exceto || []).forEach(function (m) { fora[chaveEquipa(m)] = true; });
    var d = deltaEquipas(antes || [], agora || []).filter(function (m) { return !fora[chaveEquipa(m)]; }), f = [];
    d.forEach(function (m) {
      if (m.accao === 'acrescentou') f.push('há mais uma equipa: ' + m.nome + ' ' + m.homens);
      else if (m.accao === 'tirou') f.push('saiu a equipa ' + m.nome);
      else { var a = (antes || []).filter(function (e) { return chaveEquipa(e) === chaveEquipa(m); })[0]; f.push(m.nome + ' passou de ' + (a ? a.homens : 0) + ' para ' + m.homens); }
    });
    return f.slice(0, 2).join('; ') + (f.length > 2 ? '; e mais ' + (f.length - 2) : '');
  }
  function sugestoesLivres(eq, sug, indice) {
    var usadas = {}; (eq || []).forEach(function (e, j) { if (j !== indice) usadas[chaveEquipa(e)] = true; });
    var haDoe = (eq || []).some(function (e, j) { return j !== indice && e.tipo === 'DOE'; });
    return (sug || []).filter(function (s) { return normNome(s.nome) && !usadas[chaveEquipa(s)] && !(s.tipo === 'DOE' && haDoe); });
  }
  /** Uma frase de um toque: liga (acrescenta «Frase.») ou desliga (tira-a do texto). */
  function alternarFrase(texto, frase) {
    var t = String(texto || '').trim(), f = normNome(frase);
    if (!f) return t;
    if (t.indexOf(f) >= 0) return t.replace(f + '.', '').replace(f, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return (t ? t.replace(/\.?$/, '. ') : '') + f + '.';
  }
  function frasesPara(sug) {
    var l = [], v = {};
    ((sug && sug.frases) || []).concat(FRASES_BASE).forEach(function (f) { f = normNome(f); var k = f.toLowerCase(); if (f && f.length <= 60 && !v[k]) { v[k] = 1; l.push(f); } });
    return l.slice(0, 6);
  }

  // ── O formulário ──
  /** Abre o formulário: o meu registo de hoje (para corrigir) ou as equipas do último registo («como ontem»). */
  /** Abre o formulário. Revisão de 12 nov 2026 (A1): o formulário NUNCA envia uma lista que não leu. meu.conhecido
      diz o que se leu do servidor (ou da cópia do último registo aceite); o que é desconhecido omite-se no pedido
      (o servidor deixa-o como está). Sem conhecido, o registo do servidor conhece-se todo. */
  function formDiario(o) {
    var meu = o.meu, ult = o.ultimo;
    if (meu) {
      var eq = copia(meu.equipas || []), kn = meu.conhecido || { texto: true, localizacoes: true, fotos: true };
      return { obraId: o.obraId, dia: meu.dia || o.dia, corrigir: true, registoId: meu.id, versaoBase: Number(meu.versao) || 0, pode: Array.isArray(meu.pode) ? meu.pode.slice() : null, corrigeAte: meu.corrigeAte || '', equipas: eq.length ? eq : [{ tipo: 'DOE', nome: 'DOE', homens: 0 }],
        texto: String(meu.texto || ''), localizacoes: (meu.localizacoes || []).slice(), fotos: (meu.fotos || []).map(function (f) { return { n: f.n, estado: 'servidor', estadoServidor: f.estado, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho, pode: Array.isArray(f.pode) ? f.pode.slice() : [] }; }),
        base: assinaturaEquipas(meu.equipas || []), baseDia: '', baseTexto: String(meu.texto || ''), nMax: (meu.fotos || []).reduce(function (a, f) { return Math.max(a, Number(f.n) || 0); }, Number(o.nMax) || 0),
        conhece: { texto: kn.texto !== false, localizacoes: kn.localizacoes !== false, fotos: kn.fotos !== false } };
    }
    var eq2 = ult && Array.isArray(ult.equipas) && ult.equipas.length ? copia(ult.equipas) : [{ tipo: 'DOE', nome: 'DOE', homens: 0 }];
    return { obraId: o.obraId, dia: o.dia, corrigir: false, registoId: o.registoId, versaoBase: 0, equipas: eq2, texto: '', localizacoes: [], fotos: [],
      base: ult ? assinaturaEquipas(ult.equipas || []) : '', baseDia: ult && ult.dia ? ult.dia : '', baseTexto: '', nMax: Number(o.nMax) || 0,
      conhece: { texto: true, localizacoes: true, fotos: true } };
  }
  /** Um registo que já existe no servidor mas cujo conteúdo este telemóvel não tem (sem rede, sem cópia): só as equipas
      se mexem; texto, Localizações e fotos ficam como estão no servidor (omitem-se no pedido). */
  function formDesconhecido(o) {
    return formDiario({ obraId: o.obraId, dia: o.dia, meu: { id: o.registoId, dia: o.dia, versao: o.versao, equipas: o.equipas || [], texto: '', localizacoes: [], fotos: [], conhecido: { texto: false, localizacoes: false, fotos: false } }, nMax: o.nMax });
  }
  /** O que o pedido omite: o que não se leu (o texto, só se a pessoa não escreveu nada). */
  function omissoes(form) {
    var k = form.conhece || {}, escreveu = !!String(form.texto || '').trim();
    // 2.ª revisão (2): sem conhecer o texto actual, o que a pessoa escreve JUNTA-SE ao que lá está (textoModo 'acrescentar')
    return { texto: k.texto === false && !escreveu, textoAcrescentar: k.texto === false && escreveu, localizacoes: k.localizacoes === false, fotos: k.fotos === false };
  }
  /** O pedido precisa da versão nova do contrato (campos omitidos ou textoModo)? */
  function precisaContrato(item) { var om = item.omitir || {}; return !!(om.texto || om.textoAcrescentar || om.localizacoes || om.fotos); }
  function fotosAtivas(form) { return (form.fotos || []).filter(function (f) { return f.estado !== 'sem-lugar' && f.estado !== 'fora-de-prazo' && f.estado !== 'removida'; }); }
  function podeJuntarFoto(form) { return !(form.conhece && form.conhece.fotos === false) && fotosAtivas(form).length < LIMITES.fotos && proximoN(form) <= LIMITES.nMax; }
  /** O `n` da próxima foto: nunca reutilizado (acima de todos os que este registo já usou). */
  function proximoN(form) { var m = Number(form.nMax) || 0; (form.fotos || []).forEach(function (f) { m = Math.max(m, Number(f.n) || 0); }); return m + 1; }
  function juntarFoto(form, f) {
    if (!podeJuntarFoto(form)) return null;
    var n = proximoN(form);
    var nova = { n: n, nPedido: n, estado: 'nova', blob: f.blob, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho };
    form.fotos.push(nova); form.nMax = Math.max(Number(form.nMax) || 0, n);
    return nova;
  }
  function tirarFoto(form, i) { var f = form.fotos[i]; if (f) { form.nMax = Math.max(Number(form.nMax) || 0, Number(f.n) || 0); form.fotos.splice(i, 1); } return form; }
  /** «Como ontem»: as equipas iguais às do último registo, sem texto, Localizações nem fotos novas. */
  function comoAntes(form) { return !form.corrigir && !!form.baseDia && assinaturaEquipas(form.equipas) === form.base; }
  function mudouAlgo(form) {
    if (!form.corrigir) return true;
    return assinaturaEquipas(form.equipas) !== form.base || String(form.texto || '').trim() !== String(form.baseTexto || '').trim() || (form.fotos || []).some(function (f) { return f.estado === 'nova'; }) || !!form.tocouFotosOuLocs;
  }
  function rotuloGuardar(form, hoje) {
    var t = totalHomens(equipasParaEnviar(form.equipas));
    var r = (form.corrigir ? 'Guardar correção · ' : 'Guardar · ') + txtHomens(t);
    if (comoAntes(form)) r += ', como ' + (hoje && difDias(form.baseDia, hoje) === 1 ? 'ontem' : 'a ' + textoDiaMes(form.baseDia));
    return r;
  }
  /** O que falta (null = pode guardar). Só a obra é obrigatória (decisão do Pedro: texto, Localizações e fotos são opcionais). */
  function faltaDiario(form, obraValida) {
    if (!form || !form.obraId || obraValida === false) return { campo: 'obra', texto: 'Falta escolher a obra' };
    if (String(form.texto || '').length > LIMITES.texto) return { campo: 'texto', texto: 'O texto tem mais de ' + LIMITES.texto + ' caracteres' };
    if (form.aPreparar) return { campo: 'fotos', texto: 'A preparar a foto…', espera: true };
    return null;
  }
  /** O corpo do POST /movel/diario (lista fechada do contrato). */
  function corpoDiario(item) {
    var om = item.omitir || {};
    var c = { id: item.registoId, pedidoId: item.pedidoId, obraId: item.obraId, dia: item.dia, versaoBase: Number(item.versaoBase) || 0, equipas: equipasParaEnviar(item.equipas) };
    if (!om.texto) c.texto = String(item.texto || '').trim().slice(0, LIMITES.texto);
    if (om.textoAcrescentar) c.textoModo = 'acrescentar';
    if (!om.localizacoes) c.localizacoes = (item.localizacoes || []).slice(0, LIMITES.localizacoes);
    if (!om.fotos) c.fotos = fotosAtivas(item).map(function (f) { return { n: f.n, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; });
    if (item.capturadoEm) c.capturadoEm = item.capturadoEm;
    return c;
  }
  /** O item da fila a partir do formulário (com as fotos e os seus ficheiros). */
  function itemDaFila(o) {
    var f = o.form, agora = o.agora || new Date();
    return { id: 'q-' + uuid(o.novoId), tipo: 'diario', estado: 'a-enviar', contaId: String(o.contaId || ''), contaNome: String(o.contaNome || ''),
      registoId: f.registoId, pedidoId: novoPedidoId(o.novoId), obraId: f.obraId, dia: f.dia, capturadoEm: agora.toISOString(), criadoEm: agora.toISOString(),
      versaoBase: Number(f.versaoBase) || 0, corrigir: !!f.corrigir, equipas: equipasParaEnviar(f.equipas), texto: String(f.texto || '').trim(), localizacoes: (f.localizacoes || []).slice(),
      fotos: (f.fotos || []).filter(function (x) { return x.estado !== 'sem-lugar'; }).map(function (x) { var g = { n: x.n, nPedido: x.n, sha256: x.sha256, tipo: x.tipo, tamanho: x.tamanho, estado: x.estado === 'servidor' ? 'servidor' : 'por-declarar' }; if (x.blob) g.blob = x.blob; if (x.prev) g.prev = x.prev; return g; }),   // prev: a miniatura em memória (não vai para o disco nem ao servidor)
      tiradas: (f.tiradas || []).slice(), omitir: omissoes(f), tentou: false, resposta: null, erro: '', avisos: [], encadeado: !!o.encadeado };
  }
  /** Um «Guardar» novo para um registo que já está na fila e NUNCA saiu do telemóvel substitui-o (o mesmo lugar);
      se já saiu (a resposta pode ter-se perdido), o novo vai depois, encadeado. Devolve { fila, item, substituiu }. */
  function porNaFila(fila, item) {
    var l = (fila || []).slice(), i = -1;
    l.forEach(function (x, j) { if (x.tipo === 'diario' && x.registoId === item.registoId && x.estado === 'a-enviar' && !x.tentou && !x.resposta) i = j; });
    if (i >= 0) { item.id = l[i].id; item.criadoEm = l[i].criadoEm; item.encadeado = l[i].encadeado; l[i] = item; return { fila: l, item: item, substituiu: true }; }
    item.encadeado = l.some(function (x) { return x.tipo === 'diario' && x.registoId === item.registoId && x.estado === 'a-enviar'; });
    l.push(item);
    return { fila: l, item: item, substituiu: false };
  }

  // ── A resposta do servidor ──
  /** Aplica a resposta de POST /movel/diario ao item: adopta o id (fundido), guarda a versão e põe em cada foto local o
      `n` que o servidor lhe deu (pelo `nPedido`; `renumeradas` é só informação). Devolve o que a página tem de saber. */
  function aplicarRespostaDiario(item, data, minha) {   // minha(id, versao): a versão foi feita por este telemóvel (P1)
    var avisos = (data.avisos || []).filter(function (a) { return a && (a.campo === 'fotos' || (a.campo === 'dia' && a.motivo === 'do-registo')); });
    if (data.id) item.registoId = data.id;
    var porN = {}, foraJa = {};
    (data.fotos || []).forEach(function (fs) { porN[String(fs.nPedido)] = fs; });
    // 7ec72d62 e P4 do servidor: uma foto que já tinha sido tirada (removida) ou retirada pelo DO/GP não volta: não se envia
    (data.avisos || []).forEach(function (a) { if (a && a.campo === 'fotos' && (a.motivo === 'removida' || a.motivo === 'retirada')) foraJa[String(a.valor)] = true; });
    item.fotos.forEach(function (f) {
      var fs = porN[String(f.nPedido != null ? f.nPedido : f.n)];
      if (!fs) return;
      if (fs.n == null && foraJa[String(fs.nPedido)]) { f.estado = 'removida'; f.uploadUrl = ''; delete f.blob; return; }
      if (fs.n == null || fs.estado === 'sem-lugar') { f.estado = 'sem-lugar'; f.uploadUrl = ''; return; }
      f.n = Number(fs.n);
      if (fs.estado === 'por-enviar' && !f.blob) { f.estado = 'servidor'; f.uploadUrl = ''; }   // A4: o ficheiro não está neste telemóvel: fica para quem o tem
      else if (fs.estado === 'por-enviar') { f.estado = 'por-enviar'; f.uploadUrl = fs.uploadUrl || ''; }
      else if (fs.estado === 'por-arquivar' || fs.estado === 'arquivada') { f.estado = 'confirmada'; f.uploadUrl = ''; delete f.blob; }
      else if (fs.estado === 'removida') { f.estado = 'removida'; f.uploadUrl = ''; delete f.blob; }
      else { f.estado = 'desconhecido'; f.uploadUrl = ''; }   // 2.ª revisão (6): um estado que não se conhece não se dá por enviado; o ficheiro fica
    });
    item.resposta = { versao: Number(data.versao) || 0, repetido: !!data.repetido, fundido: !!data.fundido, substituiu: data.substituiu || null, reler: !!(data.reler || data.fundido || data.substituiu), renumeradas: data.renumeradas || [], aplicado: data.aplicado || null };
    item.avisos = avisos.map(textoAviso).filter(Boolean);
    if (item.releuArquivadas) item.avisos.push('Uma foto já estava nos documentos da obra: ficou no diário (só o DO ou o GP a retiram).');
    if (data.substituiu && data.substituiu.alteradoEm) item.avisos.push('Substituíste uma versão de ' + horaDe(data.substituiu.alteradoEm) + (minha && minha(item.registoId, data.substituiu.versao) ? ', feita neste telemóvel (tiraste uma foto).' : ', feita noutro telemóvel.'));
    return { registoId: item.registoId, versao: item.resposta.versao, reler: item.resposta.reler, avisos: item.avisos, semLugar: item.fotos.filter(function (f) { return f.estado === 'sem-lugar'; }).length };
  }
  function horaDe(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : dois(d.getHours()) + ':' + dois(d.getMinutes()); }
  function textoAviso(a) {
    if (a && a.campo === 'dia' && a.motivo === 'do-registo' && RE_DIA.test(String(a.valor || ''))) return 'A correcção foi para o diário de ' + textoDiaCurto(a.valor) + ', o dia em que o registaste.';   // 13 nov 2026: o mesmo registo, com o relógio do telemóvel noutro dia
    if (!a || a.campo !== 'fotos') return '';
    if (a.motivo === 'nao-removida') return 'A foto ' + a.valor + ' não foi tirada do diário (foi mexido noutro telemóvel): abre-o e tira-a outra vez.';
    // revisão de 8bf7d34f (P1): não promete que «ficou no telemóvel»: o item entregue (ou a parada substituída) sai da fila com ela
    if (a.motivo === 'sem-lugar') return 'Uma foto não coube no diário (máximo de 6): ficou de fora e já não está no telemóvel.';
    if (a.motivo === 'reservada') return 'A foto ' + a.valor + ' está a ser arquivada agora: ficou no diário. Tira-a outra vez daqui a pouco.';
    if (a.motivo === 'retirada') return 'Uma foto já tinha sido retirada pelo DO ou pelo GP: não voltou ao diário.';
    if (a.motivo === 'removida') return 'A foto ' + a.valor + ' já tinha sido tirada: não voltou ao diário. Para a voltar a pôr, tira outra.';
    return '';
  }
  /** Terminada PARA ESTE TELEMÓVEL: uma foto sem o ficheiro aqui nunca é «por acabar» deste telemóvel (A4). */
  function fotoTerminada(f) { return !f.blob || f.estado === 'confirmada' || f.estado === 'servidor' || f.estado === 'sem-lugar' || f.estado === 'fora-de-prazo' || f.estado === 'removida'; }
  /** A cópia do registo como ficou no servidor depois de uma gravação aceite (para a correcção seguinte sem rede). Com
      reler (o pedido não conhecia o registo) as fotos do servidor podem ser outras: ficam desconhecidas. */
  function registoDaResposta(item, data, anterior) {
    var om = item.omitir || {}, ant = anterior || {}, ka = ant.conhecido || {}, reler = !!(data.reler || data.fundido || data.substituiu);
    var kTexto = om.texto || om.textoAcrescentar ? !!ka.texto && !om.textoAcrescentar : true, kLocs = om.localizacoes ? !!ka.localizacoes : true, kFotos = om.fotos ? (!!ka.fotos && !reler) : !reler;
    return { id: data.id || item.registoId, obraId: item.obraId, dia: item.dia, versao: Number(data.versao) || 0, equipas: copia(equipasParaEnviar(item.equipas)),
      texto: om.texto ? String(ant.texto || '') : (om.textoAcrescentar ? '' : String(item.texto || '')), localizacoes: om.localizacoes ? (ant.localizacoes || []).slice() : (item.localizacoes || []).slice(),
      fotos: om.fotos ? copia(ant.fotos || []) : item.fotos.filter(function (f) { return f.estado !== 'sem-lugar' && f.estado !== 'fora-de-prazo'; }).map(function (f) { return { n: f.n, estado: f.estado === 'por-enviar' ? 'por-enviar' : 'por-arquivar', sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; }),
      alteradoEm: new Date().toISOString(), conhecido: { texto: kTexto, localizacoes: kLocs, fotos: kFotos } };
  }
  function resumoItem(item) {
    var t = totalHomens(item.equipas), nf = (item.fotos || []).filter(function (f) { return f.estado !== 'servidor'; }).length;
    return txtHomens(t) + (nf ? ' · ' + nf + (nf === 1 ? ' foto' : ' fotos') : '');
  }

  // ── Erros → o que fazer, em linguagem de obra ──
  // accao: 'repetir' (rede/servidor, volta a tentar com espera), 'login' (pede o login sem perder a fila), 'corrigir' (a
  // pessoa muda algo), 'parar' (não adianta repetir: fica com o motivo), 'novo-n' / 'novo-id' (a página resolve sozinha).
  /** Os segundos até `ate` (a reserva de uma foto), entre 1 e 10 minutos. */
  function segAte(ate) { var t = Date.parse(ate || ''); return isNaN(t) ? 600 : Math.max(60, Math.min(600, Math.ceil((t - Date.now()) / 1000) + 1)); }
  function textoEspera(seg) { seg = Number(seg) || 0; if (seg >= 90) return Math.ceil(seg / 60) + ' minutos'; if (seg >= 60) return '1 minuto'; seg = Math.max(1, Math.ceil(seg)); return seg === 1 ? '1 segundo' : seg + ' segundos'; }
  function mensagemDiario(e) {
    var c = (e && e.code) || '', s = (e && e.status) || 0, m = (e && e.message) || '', d = (e && e.details) || {};
    if (e && e.rede) return { accao: 'repetir', rede: true, texto: e.online === false ? 'Sem rede. Fica no telemóvel e segue quando houver rede.' : 'Não consegui falar com o servidor (rede fraca). Fica no telemóvel; tento outra vez.' };
    switch (c) {
      // 13 nov 2026 (liberdade de corrigir): a janela é de 7 dias depois do dia do registo; `fechaEm` = quando fechou
      case 'DIA_FECHADO': return { accao: 'parar', fechado: true, texto: d.motivo === 'foto' ? 'Esta foto já não entra: passaram mais de 7 dias desde que a juntaste.' : (d.motivo === 'prazo' ? 'Este diário já não entra: passaram mais de 7 dias.' : 'Este diário já não se corrige: quem o fez corrige e anula até 7 dias depois do dia. Depois, só o DO ou o GP. Ficou no telemóvel.') };
      case 'NAO_EXISTE': return { accao: 'parar', texto: 'Este diário já não existe no servidor.' };
      case 'REGISTO_ANULADO': return { accao: 'parar', texto: m || 'Este diário foi anulado.' };
      case 'FOTO_ARQUIVADA': return { accao: 'reler-fotos', texto: 'Uma das fotos já está nos documentos da obra: só o DO ou o GP a retiram.' };   // revisão (C2): a correcção relê e segue com ela
      // revisão adversarial (e0f5367e): um posto está a arquivar a foto agora (10 min): repete-se depois, sem perder o pedido
      case 'FOTO_RESERVADA': return { accao: 'repetir', longo: true, reservada: true, texto: m || 'Outro posto está a arquivar esta foto. Tento outra vez daqui a pouco.', retryAfter: segAte(d.ate) };
      // P1: o GP ou o DO anularam este registo: a correcção não o repõe e não se repete
      case 'ANULADO_POR_OUTRO': return { accao: 'parar', anulado: true, texto: 'Anulado' + (d.por ? ' por ' + d.por : '') + ': fala com o GP.' };
      case 'TOKEN_REVOGADO': return { accao: 'login', revogado: true, texto: 'Este telemóvel foi desligado (palavra-passe mudada ou «Desligar os meus telemóveis»). Entra outra vez; o que registaste fica guardado.' };
      case 'PASSWORD_ALTERADA_ENTRA_DE_NOVO': return { accao: 'login', texto: m || 'A palavra-passe foi alterada; entra de novo.' };
      case 'UNAUTHORIZED': return { accao: 'login', texto: d.motivo === 'expirado' ? 'A sessão acabou. Entra outra vez; o que registaste fica guardado.' : 'Entra outra vez; o que registaste fica guardado.' };
      case 'TOKEN_DE_AMBITO': case 'TOKEN_SEM_ESCRITA': return { accao: 'login', texto: 'Há uma versão nova da app: entra outra vez para continuar. O que registaste fica guardado.' };
      case 'CONTA_INEXISTENTE': case 'CONTA_INACTIVA': return { accao: 'login', texto: 'Esta conta já não está ativa. Fala com o escritório.' };
      case 'PAPEL_SEM_ESCRITA': return { accao: 'parar', texto: m || 'A tua conta é só de leitura e não pode fazer o diário.' };
      case 'SEM_PERFIL': return { accao: 'parar', texto: m || 'A tua conta não está ligada a nenhuma pessoa no DOE. Fala com o escritório.' };
      case 'OBRA_INVALIDA': return { accao: 'parar', obra: true, texto: 'Já não estás nesta obra (ou foi arquivada). Fala com o GP ou com o Diretor de Obra.' };
      case 'DEMASIADOS_PEDIDOS': return { accao: 'repetir', texto: 'Demasiados pedidos seguidos. Espero ' + (e.retryAfter ? textoEspera(e.retryAfter) : 'um pouco') + ' e tento outra vez.', retryAfter: e.retryAfter || 0 };
      case 'DB_INDISPONIVEL': return { accao: 'repetir', texto: 'O servidor está ocupado. Fica no telemóvel; tento outra vez.', retryAfter: e.retryAfter || 0 };
      case 'MOVEL_POR_INSTALAR': case 'DIARIO_POR_INSTALAR': return { accao: 'repetir', texto: 'O diário ainda está a ser preparado no servidor. Fica no telemóvel; tento mais tarde.', retryAfter: e.retryAfter || 0, longo: true };
      case 'FOTO_REUTILIZADA': case 'FOTO_CONFIRMADA': return { accao: 'novo-n', n: Number(d.n) || 0, texto: 'Uma foto mudou de número; envio outra vez.' };
      case 'ID_EM_USO': return { accao: 'novo-id', texto: 'Identificador repetido; gero outro.' };
      case 'ID_INVALIDO': return { accao: 'parar', texto: 'Erro interno da página (identificador). Avisa o escritório.' };
      case 'ID_ALHEIO': return { accao: 'parar', texto: 'Este diário é de outra conta: só essa conta o pode enviar.' };
      case 'TEXTO_PERIGOSO': return { accao: 'corrigir', campo: 'texto', texto: m || 'O texto tem uma parte que não posso gravar. Tira-a e guarda outra vez.' };
      case 'VALIDATION_ERROR': return { accao: 'corrigir', campo: String(d.campo || '').split('.')[0], texto: m || 'Há um campo por corrigir.' };
      case 'CORPO_GRANDE': return { accao: 'parar', texto: 'O diário ficou demasiado grande. Encurta o texto.' };
      case 'FOTO_GRANDE': return { accao: 'corrigir', campo: 'fotos', texto: 'Uma das fotos é demasiado grande (máximo 5 MB). Tira-a outra vez.' };
      case 'FOTO_TIPO': return { accao: 'corrigir', campo: 'fotos', texto: 'Uma das fotos tem um formato que o servidor não aceita.' };
      case 'FOTO_NAO_DECLARADA': return { accao: 'repetir', foto: true, texto: 'O servidor ainda não conhece esta foto; envio outra vez.' };
      case 'FOTO_NAO_ENVIADA': return { accao: 'repetir', foto: true, texto: 'A foto ainda não chegou ao servidor; envio outra vez.' };
      case 'FOTO_INVALIDA': return { accao: 'repetir', foto: true, texto: 'A foto chegou danificada; envio outra vez.' };
      case 'PASSWORD_FRACA': return { accao: 'corrigir', campo: 'nova', texto: 'A palavra-passe nova tem de ter pelo menos ' + (Number(d.min) || 8) + ' caracteres.' };
      case 'PASSWORD_IGUAL': return { accao: 'corrigir', campo: 'nova', texto: 'A palavra-passe nova tem de ser diferente da atual.' };
      case 'INVALID_CREDENTIALS': return { accao: 'corrigir', campo: 'actual', texto: m || 'A palavra-passe atual não está certa.' };
    }
    if (s >= 500 || s === 0) return { accao: 'repetir', texto: 'O servidor não respondeu bem. Fica no telemóvel; tento outra vez.' };
    if (s === 429) return { accao: 'repetir', texto: 'Demasiados pedidos seguidos. Espero ' + (e.retryAfter ? textoEspera(e.retryAfter) : 'um pouco') + ' e tento outra vez.', retryAfter: e.retryAfter || 0 };
    if (s === 401) return { accao: 'login', texto: 'Entra outra vez; o que registaste fica guardado.' };
    if (s === 413) return { accao: 'parar', texto: 'O diário ficou demasiado grande. Encurta o texto.' };
    return { accao: 'parar', texto: m || 'Não foi possível concluir (' + (c || s) + ').' };
  }

  // ── Rede ──
  function lerRetryAfter(res, er) {
    var h = 0;
    try { h = Number(res && res.headers && res.headers.get && res.headers.get('Retry-After')) || 0; } catch (e) { h = 0; }
    if (h > 0) return h;
    var d = Number(er && er.details && er.details.retryAfterSeg) || 0;
    return d > 0 ? d : 0;
  }
  /** Um pedido à API com o token (GET sem corpo) e prazo. Devolve { ok, status, data } ou { ok:false, code, … }. */
  async function pedir(deps, metodo, caminho, corpo, ms) {
    var tk = deps.token();
    if (!tk) return { ok: false, status: 401, code: 'UNAUTHORIZED', details: { motivo: 'expirado' } };
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, t = null;
    var op = { method: metodo, headers: { 'Authorization': 'Bearer ' + tk } };
    if (corpo !== undefined) { op.headers['Content-Type'] = 'application/json'; op.body = JSON.stringify(corpo); }
    if (ctl) { op.signal = ctl.signal; t = setTimeout(function () { try { ctl.abort(); } catch (e) { /* já acabou */ } }, ms || (metodo === 'GET' ? LIMITES.msLeitura : LIMITES.msEscrita)); }
    var res;
    try { res = await deps.fetch(deps.base + caminho, op); }
    catch (e) { clearTimeout(t); return { ok: false, status: 0, rede: true, online: deps.online ? deps.online() : true }; }
    clearTimeout(t);
    var j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res.ok && j && j.data) return { ok: true, status: res.status, data: j.data };
    var er = (j && j.error) || {};
    return { ok: false, status: res.status, code: er.code || '', message: er.message || '', details: er.details || {}, retryAfter: lerRetryAfter(res, er) };
  }
  function lerHoje(deps) { return pedir(deps, 'GET', '/movel/diario/hoje'); }
  /** dia (13 nov 2026, opcional): o meu registo de um dia dos últimos 14; omitido = hoje. */
  function lerObra(deps, obraId, dia) { return pedir(deps, 'GET', '/movel/diario?obra=' + encodeURIComponent(obraId) + (dia ? '&dia=' + encodeURIComponent(dia) : '')); }
  /** POST /movel/diario/anular (13 nov 2026). o: { id, pedidoId, versaoBase }. O registo não se apaga: deixa de contar; gravar o
      dia outra vez repõe-no. As fotos ainda não arquivadas saem. */
  function anular(deps, o) { var c = { id: o.id, pedidoId: o.pedidoId }; if (Number.isInteger(o.versaoBase)) c.versaoBase = o.versaoBase; return pedir(deps, 'POST', '/movel/diario/anular', c); }
  function lerLocalizacoes(deps, obraId) { return pedir(deps, 'GET', '/movel/obras/localizacoes?obra=' + encodeURIComponent(obraId)); }
  function lerDias(deps, obraId) { return pedir(deps, 'GET', '/movel/diario/dias?obra=' + encodeURIComponent(obraId)); }
  function mudarPassword(deps, actual, nova) { return pedir(deps, 'POST', '/movel/password', { actual: String(actual || ''), nova: String(nova || '') }); }
  function desligar(deps) { return pedir(deps, 'POST', '/movel/desligar', {}); }

  function estadoDe(m) { return m.accao === 'login' ? 'login' : (m.accao === 'parar' ? 'parar' : (m.accao === 'corrigir' ? 'corrigir' : 'pendente')); }
  /** Leva um diário da fila o mais longe possível: o registo, depois cada foto (PUT + foto-confirmada). Cada passo
      repete-se com segurança. Devolve { estado: 'entregue'|'pendente'|'login'|'parar'|'corrigir'|'alheio', mensagem, … }. */
  async function processarDiario(item, deps) {
    if (deps.contaId && item.contaId && item.contaId !== deps.contaId()) return { estado: 'alheio', mensagem: 'Este diário é de ' + (item.contaNome || 'outra conta') + '; só essa conta o pode enviar.' };
    var guardar = function () { return deps.guardar(item); };
    var gravar = async function () {
      if (item.encadeado && deps.versaoAtual) { var v = deps.versaoAtual(item.registoId); if (v != null && v > item.versaoBase) item.versaoBase = v; }
      item.tentou = true; await guardar();
      return pedir(deps, 'POST', '/movel/diario', corpoDiario(item));
    };
    var ajustes = 0;
    // 2.ª revisão (7): servidor com o contrato antigo: um pedido com campos omitidos ou textoModo não sai (apagava ou substituía)
    if (!item.resposta && precisaContrato(item) && deps.contrato && deps.contrato() < CONTRATO_MINIMO) return { estado: 'pendente', contrato: true, longo: true, mensagem: 'O diário de obra está a ser actualizado no servidor; tenta mais tarde. Fica no telemóvel.' };
    // M4: sem rede o pedido nem sai: não conta como «tentado» (a correcção seguinte substitui-o na fila)
    if (!item.resposta && deps.online && deps.online() === false) return { estado: 'pendente', rede: true, mensagem: mensagemDiario({ rede: true, online: false }).texto };
    while (!item.resposta) {
      var x = await gravar();
      if (!x.ok && x.rede && x.online === false) item.tentou = false;
      if (x.ok) { aplicarRespostaDiario(item, x.data, deps.versaoMinha); item.erro = ''; if (deps.aoGravado) await deps.aoGravado(item, x.data); await guardar(); break; }
      var m = mensagemDiario(x);
      // revisão (C2): uma foto da lista foi arquivada entretanto: relê o registo, junta-lhe as arquivadas e segue (não pára tudo)
      if (m.accao === 'reler-fotos') {
        ajustes++;
        var lr = ajustes > 3 ? { ok: false } : await lerObra(deps, item.obraId, item.dia);
        if (lr.ok && lr.data.meu) {
          (lr.data.meu.fotos || []).filter(function (fs) { return fs.estado !== 'removida' && !item.fotos.some(function (f) { return f.n === fs.n; }) && (item.tiradas || []).indexOf(fs.n) < 0; }).forEach(function (fs) { item.fotos.push({ n: fs.n, nPedido: fs.n, sha256: fs.sha256, tipo: fs.tipo, tamanho: fs.tamanho, estado: 'servidor' }); });
          item.versaoBase = Number(lr.data.meu.versao) || item.versaoBase; item.pedidoId = novoPedidoId(deps.novoId); item.tentou = false;
          item.releuArquivadas = true;   // o aviso junta-se na resposta (aplicarRespostaDiario)
          continue;
        }
        m = { accao: 'parar', texto: m.texto };
      }
      if ((m.accao === 'novo-n' || m.accao === 'novo-id') && ajustes < 3) {
        ajustes++;
        if (m.accao === 'novo-id') item.registoId = novoIdRegisto(deps.novoId);
        else { var nMax = Math.max(m.n || 0, item.fotos.reduce(function (a, f) { return Math.max(a, Number(f.n) || 0); }, 0)); item.fotos.forEach(function (f) { if (f.estado === 'por-declarar' && (f.n === m.n || !m.n)) { nMax++; f.n = nMax; f.nPedido = nMax; } }); }
        item.pedidoId = novoPedidoId(deps.novoId); item.tentou = false;
        continue;
      }
      item.erro = m.texto;
      if (m.accao === 'parar' || m.accao === 'corrigir') { item.estado = 'parado'; item.motivo = m.fechado ? 'dia-fechado' : (m.obra ? 'obra' : (m.anulado ? 'anulado' : m.accao)); item.campo = m.campo || ''; }
      await guardar();
      return { estado: estadoDe(m), mensagem: m.texto, rede: !!m.rede, retryAfter: m.retryAfter || 0, campo: m.campo, longo: !!m.longo, revogado: !!m.revogado };
    }
    for (var i = 0; i < item.fotos.length; i++) {
      var f = item.fotos[i];
      if (fotoTerminada(f)) continue;
      for (var t = 0; t < 3 && !fotoTerminada(f); t++) {
        if (!f.uploadUrl) {   // o mesmo pedidoId outra vez: o servidor devolve a mesma resposta, com um uploadUrl novo
          var y = await pedir(deps, 'POST', '/movel/diario', corpoDiario(Object.assign({}, item, { fotos: item.fotos })));
          if (!y.ok) { var my = mensagemDiario(y); await guardar(); return { estado: estadoDe(my), mensagem: my.texto, rede: !!my.rede, retryAfter: my.retryAfter || 0, revogado: !!my.revogado }; }
          aplicarRespostaDiario(item, y.data); await guardar();
          if (fotoTerminada(f)) break;
          if (!f.uploadUrl) break;
        }
        var put;
        try { put = await deps.fetch(f.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.tipo }, body: f.blob }); }
        catch (e) { await guardar(); return { estado: 'pendente', rede: true, mensagem: mensagemDiario({ rede: true, online: deps.online ? deps.online() : true }).texto }; }
        if (!put.ok) { if (put.status >= 500 || put.status === 429) { await guardar(); return { estado: 'pendente', mensagem: 'O envio da foto falhou; tento outra vez.' }; } f.uploadUrl = ''; continue; }
        var cf = await pedir(deps, 'POST', '/movel/diario/foto-confirmada', { id: item.registoId, n: f.n });
        if (cf.ok) { f.estado = 'confirmada'; f.uploadUrl = ''; delete f.blob; await guardar(); break; }
        if (cf.code === 'FOTO_NAO_ENVIADA') continue;
        if (cf.code === 'FOTO_INVALIDA' || cf.code === 'FOTO_NAO_DECLARADA') { f.uploadUrl = ''; continue; }
        var mc = mensagemDiario(cf);
        if (mc.fechado) { f.estado = 'fora-de-prazo'; f.erro = mc.texto; delete f.blob; item.avisos = (item.avisos || []).concat([mc.texto]); await guardar(); break; }
        await guardar();
        return { estado: estadoDe(mc), mensagem: mc.texto, rede: !!mc.rede, retryAfter: mc.retryAfter || 0, revogado: !!mc.revogado };
      }
    }
    if (item.fotos.every(fotoTerminada)) { item.estado = 'entregue'; item.entregueEm = (deps.agora ? deps.agora() : new Date()).toISOString(); await guardar(); return { estado: 'entregue', avisos: item.avisos || [] }; }
    await guardar();
    return { estado: 'pendente', mensagem: 'Faltam fotos por enviar; tento outra vez.' };
  }

  // ── Os comandos de um registo (13 nov 2026, liberdade de corrigir): anular e tirar uma foto ──
  // Um item da fila (tipo 'diario-cmd'), como os dos trabalhos: com Desfazer (só segue depois do aviso, adiadoAte), sem rede
  // fica na fila, e uma foto que um posto está a arquivar (FOTO_RESERVADA) repete-se mais tarde com o MESMO pedido.
  /** o: { accao: 'anular' | 'foto-tirar', registoId, obraId, dia, n?, versaoBase?, contaId, contaNome, novoId, agora, adiarMs }. */
  function itemComandoDiario(o) {
    var agora = o.agora || new Date();
    return { id: 'q-' + uuid(o.novoId), tipo: 'diario-cmd', accao: o.accao, estado: 'a-enviar', contaId: String(o.contaId || ''), contaNome: String(o.contaNome || ''),
      registoId: String(o.registoId || ''), obraId: String(o.obraId || ''), dia: String(o.dia || ''), n: o.n == null ? null : Number(o.n), versaoBase: Number.isInteger(o.versaoBase) ? o.versaoBase : null,
      pedidoId: novoPedidoId(o.novoId), criadoEm: agora.toISOString(), adiadoAte: o.adiarMs ? new Date(agora.getTime() + o.adiarMs).toISOString() : '',
      equipas: [], fotos: [], tentou: false, resposta: null, erro: '', avisos: [] };
  }
  function corpoComandoDiario(item) {
    if (item.accao === 'foto-tirar') return { id: item.registoId, n: item.n };
    var c = { id: item.registoId, pedidoId: item.pedidoId }; if (Number.isInteger(item.versaoBase)) c.versaoBase = item.versaoBase; return c;
  }
  /** Leva um comando ao servidor. Devolve { estado: 'entregue'|'pendente'|'login'|'parar'|'corrigir'|'alheio', mensagem, data, … }. */
  async function processarComandoDiario(item, deps) {
    if (deps.contaId && item.contaId && item.contaId !== deps.contaId()) return { estado: 'alheio', mensagem: 'Isto é de ' + (item.contaNome || 'outra conta') + '; só essa conta o pode enviar.' };
    if (deps.online && deps.online() === false) return { estado: 'pendente', rede: true, mensagem: mensagemDiario({ rede: true, online: false }).texto };
    var antes = !!item.tentou;   // uma tentativa ANTERIOR (sem resposta) pode ter chegado ao servidor
    item.tentou = true; if (deps.guardar) await deps.guardar(item);
    var x = await pedir(deps, 'POST', item.accao === 'foto-tirar' ? '/movel/diario/foto-tirar' : '/movel/diario/anular', corpoComandoDiario(item));
    if (x.ok) { item.resposta = x.data; item.erro = ''; item.estado = 'entregue'; item.entregueEm = (deps.agora ? deps.agora() : new Date()).toISOString(); if (deps.guardar) await deps.guardar(item); return { estado: 'entregue', data: x.data }; }
    // revisão (C2, e a 2.ª): um 4xx com código prova que ESTA tentativa não se aplicou. De uma ANTERIOR (sem resposta) só o
    // provam os códigos de COMANDO_PROVA_ANTERIOR (lista positiva, revisão de 8bf7d34f: as recusas da conta, da obra e de quem é
    // o registo respondem antes de o SQL procurar o pedido, e podem mudar entre as tentativas)
    if (!x.rede && x.status >= 400 && x.status < 500 && x.code && (!antes || COMANDO_PROVA_ANTERIOR.indexOf(x.code) >= 0)) item.tentou = false;
    var m = mensagemDiario(x);
    if (m.accao === 'reler-fotos') m = { accao: 'parar', texto: x.message || m.texto };   // um tirar de uma arquivada: pára (retira-a o DO ou o GP)
    item.erro = m.texto;
    if (m.accao === 'parar' || m.accao === 'corrigir') { item.estado = 'parado'; item.motivo = m.fechado ? 'dia-fechado' : (m.obra ? 'obra' : (m.anulado ? 'anulado' : 'parar')); }
    if (deps.guardar) await deps.guardar(item);
    return { estado: estadoDe(m), mensagem: m.texto, rede: !!m.rede, retryAfter: m.retryAfter || 0, longo: !!m.longo, reservada: !!m.reservada, revogado: !!m.revogado };
  }
  /** Os códigos que provam que NENHUMA tentativa anterior do comando se aplicou (doe_diario_anular e doe_diario_foto_tirar,
      doe-backend/sql/doe-diario-obra-2026-11-11.sql): o corpo inválido (o mesmo em todas as tentativas), o registo ou a foto
      que não existem, e o que o SQL só responde DEPOIS de procurar o pedido (anular) ou de ler o estado da foto (tirar: uma
      foto já tirada responde ok). Fora daqui (ID_ALHEIO, SEM_PERFIL, OBRA_INVALIDA, NAO_ARQUIVISTA, CONTA_INACTIVA, os do
      token, 401, 429…) uma tentativa anterior pode ter chegado. DIA_FECHADO também fica de fora (verificação de 02b9cc10): o
      registo do pedido não é eterno, e uma repetição muito tardia pode estar a esconder um anular que já se aplicou. */
  var COMANDO_PROVA_ANTERIOR = ['ID_INVALIDO', 'VALIDATION_ERROR', 'NAO_EXISTE', 'FOTO_NAO_DECLARADA', 'ID_EM_USO', 'FOTO_RESERVADA', 'FOTO_ARQUIVADA'];
  function resumoComandoDiario(q) { return q.accao === 'foto-tirar' ? 'Tirar a foto ' + q.n : 'Anular o diário'; }

  // ── Os 7 dias (os meus registos) ──
  /** Uma coluna por dia: total, DOE e subempreiteiros, se há registo, fim de semana, hoje. Lê o histórico local da
      conta (o que este telemóvel gravou e o que o servidor disse de hoje e do último dia). */
  function serie7(cache, obraId, hoje) {
    var porDia = {};
    (cache.hist || []).forEach(function (h) { if (h.obraId === obraId) porDia[h.dia] = h; });
    var meusHoje = cache.hoje && cache.hoje.dia === hoje ? (cache.hoje.meus || []).filter(function (x) { return x.obraId === obraId; })[0] : null;
    return seteDias(hoje).map(function (d) {
      var h = porDia[d], s = h ? doeESub(h.equipas) : { doe: 0, sub: 0 };
      var tem = !!h || (d === hoje && !!meusHoje);
      if (!h && d === hoje && meusHoje) s = { doe: Number(meusHoje.totalHomens) || 0, sub: 0, soTotal: true };
      return { dia: d, doe: s.doe, sub: s.sub, total: s.doe + s.sub, tem: tem, fds: fimDeSemana(d), hoje: d === hoje, texto: h ? h.texto : '', soEquipas: h ? h.soEquipas : false };
    });
  }
  /** M3: os 7 dias da OBRA, pelo servidor (GET /movel/diario/dias): total «o mais alto por equipa», DOE e subempreiteiros,
      quantos registos, e o meu. Nunca afirma «sem diário» sobre um dia que não conhece (fora do que o servidor disse, ou
      antes de primeiroDia). feriados: { 'AAAA-MM-DD': nome }. pend: o total do meu de hoje que está na fila. */
  function serieObra(dias, hoje, feriados, pend) {
    var porDia = {}, fer = feriados || {};
    ((dias && dias.dias) || []).forEach(function (d) { porDia[d.dia] = d; });   // o servidor real dá os 14 dias, também os sem registos
    var de = dias && dias.de, ate = dias && dias.ate, prim = dias && dias.primeiroDia;
    return seteDias(hoje).map(function (d) {
      var x = porDia[d], reg = x ? Number(x.registos) || 0 : 0, tem = reg > 0;
      // conhece-se o dia só dentro do que o servidor leu e a partir do primeiro diário da obra (sem diário nenhum: nada)
      var conhecido = !!dias && !!prim && d >= prim && (!de || d >= de) && (!ate || d <= ate);
      return { dia: d, doe: tem ? Number(x.doe) || 0 : 0, sub: tem ? Number(x.sub) || 0 : 0, total: tem ? Number(x.total) || 0 : 0, tem: tem, registos: reg, meu: x ? x.meu || null : null,
        conhecido: conhecido, fds: fimDeSemana(d), feriado: fer[d] || '', hoje: d === hoje, pend: d === hoje && pend ? pend : 0, antes: !!prim && d < prim };
    });
  }
  /** Depois de uma gravação aceite, o dia de hoje dos 7 dias da obra fica com o meu registo (a releitura acerta o total). */
  function diasComMeu(dias, dia, meu, equipas) {
    if (!dias || !Array.isArray(dias.dias)) return dias;
    var x = dias.dias.filter(function (d) { return d.dia === dia; })[0], s = doeESub(equipas || []);
    if (!x) { x = { dia: dia, doe: 0, sub: 0, total: 0, registos: 0, meu: null }; dias.dias.unshift(x); }
    var correcao = !!x.meu;
    if (!correcao) x.registos = (Number(x.registos) || 0) + 1;
    // uma correcção (que pode baixar os homens) mostra o meu registo novo; um registo novo junta-se ao máximo do dia
    if (correcao) { x.doe = s.doe; x.sub = s.sub; } else { x.doe = Math.max(Number(x.doe) || 0, s.doe); x.sub = Math.max(Number(x.sub) || 0, s.sub); }
    x.meu = meu; x.total = x.doe + x.sub; x.aproximado = true;
    if (!dias.primeiroDia || dia < dias.primeiroDia) dias.primeiroDia = dia;
    if (!dias.ultimoDia || dia > dias.ultimoDia) dias.ultimoDia = dia;
    return dias;
  }
  function diaUtil(dia, feriados) { return !fimDeSemana(dia) && !(feriados && feriados[dia]); }
  /** «das 18:40» (hoje) ou «de ter 10 nov, 18:40» (outro dia), na hora do telemóvel. */
  function textoDados(iso, agora) {
    var d = new Date(iso); if (!iso || isNaN(d.getTime())) return '';
    var a = agora instanceof Date ? agora : new Date(), h = dois(d.getHours()) + ':' + dois(d.getMinutes());
    if (d.getFullYear() === a.getFullYear() && d.getMonth() === a.getMonth() && d.getDate() === a.getDate()) return 'das ' + h;
    return 'de ' + textoDiaCurto(d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate())) + ', ' + h;
  }
  function media(serie) { var c = serie.filter(function (x) { return x.tem; }); return c.length ? c.reduce(function (a, x) { return a + x.total; }, 0) / c.length : 0; }
  /** O último dia com registo antes de hoje (para «ontem: 7 homens»). */
  function ultimoComRegisto(cache, obraId, hoje) {
    return (cache.hist || []).filter(function (h) { return h.obraId === obraId && h.dia < hoje; }).sort(function (a, b) { return a.dia < b.dia ? 1 : -1; })[0] || null;
  }
  /** O meu registo de hoje nesta obra (o que o servidor disse, ou o que este telemóvel já guardou). */
  function meuDeHoje(cache, obraId, hoje) {
    var s = cache.hoje && cache.hoje.dia === hoje ? (cache.hoje.meus || []).filter(function (x) { return x.obraId === obraId; })[0] : null;
    if (s) return { id: s.id, total: Number(s.totalHomens) || 0, versao: s.versao };
    var h = (cache.hist || []).filter(function (x) { return x.obraId === obraId && x.dia === hoje && !x.soEquipas; })[0];
    return h ? { id: cache.ids[chaveDia(obraId, hoje)] || '', total: totalHomens(h.equipas), versao: h.versao } : null;
  }

  return {
    LIMITES: LIMITES, FRASES_BASE: FRASES_BASE, MESES_C: MESES_C, DIAS_C: DIAS_C,
    novoIdRegisto: novoIdRegisto, novoPedidoId: novoPedidoId,
    somarDias: somarDias, diaDaSemana: diaDaSemana, fimDeSemana: fimDeSemana, difDias: difDias, textoDiaMes: textoDiaMes, textoDiaCurto: textoDiaCurto, textoDiaLongo: textoDiaLongo, inicialDia: inicialDia, diaCurto: diaCurto, quandoFoi: quandoFoi,
    diaAtual: diaAtual, diaAberto: diaAberto, seteDias: seteDias, horaDe: horaDe,
    cacheVazia: cacheVazia, cacheDaConta: cacheDaConta, chaveDia: chaveDia, idRegistoDe: idRegistoDe, registarHistorico: registarHistorico, guardarHoje: guardarHoje, guardarObra: guardarObra,
    guardarDiaLido: guardarDiaLido, aoAnulado: aoAnulado, podeNoRegisto: podeNoRegisto, anular: anular,
    itemComandoDiario: itemComandoDiario, corpoComandoDiario: corpoComandoDiario, processarComandoDiario: processarComandoDiario, resumoComandoDiario: resumoComandoDiario, COMANDO_PROVA_ANTERIOR: COMANDO_PROVA_ANTERIOR,
    normNome: normNome, chaveEquipa: chaveEquipa, totalHomens: totalHomens, doeESub: doeESub, txtHomens: txtHomens, equipasParaEnviar: equipasParaEnviar, assinaturaEquipas: assinaturaEquipas,
    mudarHomens: mudarHomens, porEquipa: porEquipa, sugestoesLivres: sugestoesLivres, alternarFrase: alternarFrase, frasesPara: frasesPara,
    CONTRATO_MINIMO: CONTRATO_MINIMO, deltaEquipas: deltaEquipas, aplicarDeltaEquipas: aplicarDeltaEquipas, resumoDiferencas: resumoDiferencas, precisaContrato: precisaContrato, diasComMeu: diasComMeu,
    formDiario: formDiario, formDesconhecido: formDesconhecido, omissoes: omissoes, registoDaResposta: registoDaResposta, serieObra: serieObra, diaUtil: diaUtil, textoDados: textoDados, lerDias: lerDias, fotosAtivas: fotosAtivas, podeJuntarFoto: podeJuntarFoto, proximoN: proximoN, juntarFoto: juntarFoto, tirarFoto: tirarFoto, comoAntes: comoAntes, mudouAlgo: mudouAlgo, rotuloGuardar: rotuloGuardar, faltaDiario: faltaDiario,
    corpoDiario: corpoDiario, itemDaFila: itemDaFila, porNaFila: porNaFila, aplicarRespostaDiario: aplicarRespostaDiario, textoAviso: textoAviso, fotoTerminada: fotoTerminada, resumoItem: resumoItem,
    mensagemDiario: mensagemDiario, textoEspera: textoEspera, pedir: pedir, lerHoje: lerHoje, lerObra: lerObra, lerLocalizacoes: lerLocalizacoes, mudarPassword: mudarPassword, desligar: desligar,
    processarDiario: processarDiario, serie7: serie7, media: media, ultimoComRegisto: ultimoComRegisto, meuDeHoje: meuDeHoje,
  };
}));
