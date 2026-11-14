/* DOE · Telemóvel — Trabalhos em falta (fatia 2a, 12 nov 2026): lógica pura (sem DOM), UMD como diario.js (self.DoeMovelTf
   no browser, require em Node), testada em Node e contra o servidor real. Contrato: docs/analises/Movel-Fatia2-Contrato.md,
   rotas 2, 3, 4 e 6. Desenho: docs/prototipos/DOEX-Telemovel-App-Prototipo.html (validado pelo Pedro). Regras que cumpre:
   - as escritas são COMANDOS (`accao`) com o `id` do trabalho e um `pedidoId` gerados aqui, na fila única; sem rede ficam
     «por enviar» e seguem sozinhos; o mesmo envio repete-se com o MESMO pedidoId (idempotência);
   - a página NÃO tem regra de permissões própria: as acções que se mostram são as do `pode` que o servidor manda em cada
     trabalho (o encarregado e o GP/DO distinguem-se só por aí);
   - o estado deriva-se do registo pela regra do servidor (doe_tf_estado) com o dia do servidor; um comando por enviar
     aplica-se por cima da cópia (para se ver logo), e a resposta do servidor substitui-a;
   - 409 TRANSICAO_INVALIDA: o registo relê-se e diz-se em linguagem de obra o que mudou, sem perder o que se escreveu;
   - o que se lê guarda-se na cache da conta (diario.js cacheDaConta, chave `tf`): sai ao Sair e com o token revogado. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'));
  else raiz.DoeMovelTf = fabrica(raiz.DoeMovelDiario);
}(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';
  var LIMITES = { fotos: 3, nMax: 12, texto: 500, motivo: 300, equipa: 40, mostrar: 300 };
  var QUEM = { CLIENTE: 'Cliente', DOE: 'DOE', SUB: 'Subempreiteiro', FORNECEDOR: 'Fornecedor', OUTRO: 'Outro' };
  var QUEM_ORDEM = ['CLIENTE', 'DOE', 'SUB', 'FORNECEDOR', 'OUTRO'];
  // As frases de um toque do protótipo validado (o que falta; o motivo de um bloqueio; o que se precisa do cliente).
  var FRASES_TF = ['Falta selar junta', 'Falta remate', 'Falta colocar capeamento', 'Vidro riscado a trocar', 'Falta limpeza final'];
  var FRASES_BLOQ = ['Falta material', 'Frente de obra ocupada', 'Aguarda desenho aprovado', 'Aguarda o subempreiteiro'];
  var FRASES_CLI = ['Definir o pormenor do remate', 'Aprovar a amostra', 'Enviar o desenho aprovado', 'Libertar a frente de obra'];
  var ATIVOS_BC = ['POR_CONFIRMAR', 'POR_FORMALIZAR', 'FORMALIZADO'];
  var RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function uuid(novoId) { return String(novoId ? novoId() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); }
  function novoIdTf(novoId) { return ('tf-' + uuid(novoId)).slice(0, 64); }
  function novoPedidoId(novoId) { return ('ped-' + uuid(novoId)).slice(0, 64); }
  function dois(n) { return ('0' + n).slice(-2); }
  /** O dia (do telemóvel, Lisboa) de um instante ISO. */
  function diaDe(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()); }
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  // ── O estado (a regra do servidor, doe_tf_estado, com o dia do servidor) ──
  function estadoDe(t, hoje) {
    if (!t) return 'POR_PLANEAR';
    if (t.anuladoEm) return 'ANULADO';
    if (t.feitoEm) return 'FEITO';
    if (t.bloqueio) return t.bloqueio.porConfirmar ? 'POR_CONFIRMAR' : 'BLOQUEADO';
    if (!t.previsto) return 'POR_PLANEAR';
    return t.previsto < hoje ? 'ATRASADO' : 'POR_FAZER';
  }
  function nomeQuem(q) { return QUEM[q] || 'Outro'; }
  /** A palavra do estado e o facto, como na linha do protótipo: «Por fazer · previsto sex 13 nov», «Atrasado 2 dias»,
      «Bloqueado · Cliente», «Bloqueio por confirmar», «Por planear». c = a classe de cor. */
  function palavra(t, hoje) {
    var e = estadoDe(t, hoje);
    if (e === 'ANULADO') return { e: e, p: 'Anulado', c: 'neu-t', f: '' };
    if (e === 'FEITO') { var d = diaDe(t.feitoEm); return { e: e, p: 'Feito', c: 'pos-t', f: d ? (d === hoje ? 'hoje' : D.textoDiaCurto(d)) : '' }; }
    if (e === 'POR_CONFIRMAR' || e === 'BLOQUEADO') return { e: e, p: e === 'POR_CONFIRMAR' ? 'Bloqueio por confirmar' : 'Bloqueado', c: 'ama-t', f: t.bloqueio.equipa || nomeQuem(t.bloqueio.quem) };
    if (e === 'ATRASADO') { var n = D.difDias(t.previsto, hoje); return { e: e, p: 'Atrasado ' + pl(n, 'dia', 'dias'), c: 'neg-t', f: 'previsto ' + D.textoDiaCurto(t.previsto) }; }
    if (e === 'POR_FAZER') { var k = D.difDias(hoje, t.previsto); return { e: e, p: 'Por fazer', c: 'nav-t', f: 'previsto ' + (k === 0 ? 'hoje' : k === 1 ? 'amanhã' : D.textoDiaCurto(t.previsto)) }; }
    return { e: e, p: 'Por planear', c: 'neu-t', f: '' };
  }
  /** O segmentado da lista: Por fazer (por fazer, atrasados, por planear) · Bloqueados (também os por confirmar) · Feitos.
      Por fazer + Bloqueados = os abertos = o número do bloco Trabalhos do Hoje (a mesma população). */
  function filtroDe(t, hoje) {
    var e = estadoDe(t, hoje);
    if (e === 'FEITO') return 'feito';
    if (e === 'BLOQUEADO' || e === 'POR_CONFIRMAR') return 'bloq';
    if (e === 'ANULADO') return null;
    return 'fazer';
  }
  /** Os números da lista, com os mesmos nomes do bloco Trabalhos do Hoje (contrato, rota 1). */
  function contas(lista, hoje) {
    var s = { abertos: 0, atrasados: 0, bloqueados: 0, bloqueadosCliente: 0, porConfirmar: 0, porFazer: 0, porPlanear: 0, feitos: 0 };
    (lista || []).forEach(function (t) {
      var e = estadoDe(t, hoje);
      if (e === 'ANULADO') return;
      if (e === 'FEITO') { s.feitos++; return; }
      s.abertos++;
      if (e === 'ATRASADO') s.atrasados++; else if (e === 'POR_FAZER') s.porFazer++; else if (e === 'POR_PLANEAR') s.porPlanear++;
      else { s.bloqueados++; if (e === 'POR_CONFIRMAR') s.porConfirmar++; if (t.bloqueio && t.bloqueio.quem === 'CLIENTE') s.bloqueadosCliente++; }
    });
    return s;
  }
  /** O título de um grupo: «Fachada cortina · FC1, Piso 4 Norte» → «Fachada cortina, Piso 4 Norte» (o do protótipo). */
  function locTitulo(l) {
    if (!l || (!l.nome && !l.codigo)) return 'Sem localização';
    var p = String(l.produto || '').split(' · ')[0];
    return (p ? p + ', ' : '') + (l.nome || l.codigo);
  }
  /** Os trabalhos de um filtro agrupados por Localização (ordem alfabética; «Sem localização» no fim) e, em cada grupo, os
      atrasados primeiro e depois pelo dia previsto (os sem dia no fim); nos Feitos, os mais recentes primeiro. */
  function grupos(lista, filtro, hoje) {
    var l = (lista || []).filter(function (t) { return filtroDe(t, hoje) === filtro; });
    l.sort(function (a, b) {
      if (filtro === 'feito') return String(b.feitoEm || '').localeCompare(String(a.feitoEm || ''));
      var ea = estadoDe(a, hoje) === 'ATRASADO' ? 0 : 1, eb = estadoDe(b, hoje) === 'ATRASADO' ? 0 : 1;
      return ea - eb || String(a.previsto || '9').localeCompare(String(b.previsto || '9')) || String(b.criadoEm || '').localeCompare(String(a.criadoEm || ''));
    });
    var por = {}, ordem = [];
    l.forEach(function (t) { var k = t.localizacao ? locTitulo(t.localizacao) : ''; if (!por[k]) { por[k] = []; ordem.push(k); } por[k].push(t); });
    ordem.sort(function (a, b) { if (!a) return 1; if (!b) return -1; return a.localeCompare(b, 'pt'); });
    return ordem.map(function (k) { return { titulo: k || 'Sem localização', itens: por[k] }; });
  }
  function segs(s) {
    return [['neg', s.atrasados, s.atrasados === 1 ? 'atrasado' : 'atrasados'], ['bloq', s.bloqueados, s.bloqueados === 1 ? 'bloqueado' : 'bloqueados'],
      ['nav', s.porFazer, 'por fazer'], ['cin', s.porPlanear, 'por planear']].filter(function (x) { return x[1] > 0; });
  }
  /** As frases de um toque do formulário: até 2 curtas já escritas nesta obra e as do protótipo (4 no total). */
  function frases(lista) {
    var v = {}, l = [];
    (lista || []).forEach(function (t) { var s = String(t.texto || '').trim(); if (s && s.length <= 26 && !v[s.toLowerCase()] && l.length < 2) { v[s.toLowerCase()] = 1; l.push(s); } });
    FRASES_TF.forEach(function (f) { if (!v[f.toLowerCase()]) { v[f.toLowerCase()] = 1; l.push(f); } });
    return l.slice(0, 4);
  }
  function frasesMotivo(sug, cliente) {
    var v = {}, l = [];
    (cliente ? FRASES_CLI : ((sug && sug.motivos) || []).concat(FRASES_BLOQ)).forEach(function (f) { f = D.normNome(f); if (f && f.length <= 60 && !v[f.toLowerCase()]) { v[f.toLowerCase()] = 1; l.push(f); } });
    return l.slice(0, cliente ? 4 : 6);
  }
  /** Uma frase de um toque no «o que falta»: liga (junta-a) ou desliga (tira-a). */
  function alternarFrase(texto, frase) {
    var t = String(texto || '').trim();
    if (t === frase) return '';
    if (t.indexOf(frase) >= 0) return t.replace('. ' + frase, '').replace(frase + '. ', '').replace(frase, '').trim();
    return t ? t.replace(/\.?$/, '. ') + frase : frase;
  }
  /** O dia previsto em um toque: Hoje · Amanhã · Sexta (esta, ou hoje se for sexta) · Próx. semana (a segunda seguinte). */
  function opcoesDia(hoje) {
    var w = D.diaDaSemana(hoje), sex = (5 - w + 7) % 7, seg = (8 - w) % 7 || 7;
    return [['Hoje', hoje], ['Amanhã', D.somarDias(hoje, 1)], ['Sexta', D.somarDias(hoje, sex)], ['Próx. semana', D.somarDias(hoje, seg)]];
  }
  function bcsDaLoc(bcs, loc) {
    var id = loc && loc.issueId ? loc.issueId : null;
    return (bcs || []).filter(function (b) { return ATIVOS_BC.indexOf(b.estado) >= 0 && ((b.localizacao && b.localizacao.issueId) || null) === id; });
  }
  function nomeEstadoBc(b) {
    if (!b) return '';
    if (b.estado === 'POR_CONFIRMAR') return 'Por confirmar';
    if (b.estado === 'POR_FORMALIZAR') return 'Por formalizar';
    if (b.estado === 'FORMALIZADO') return b.semResposta ? 'Sem resposta há ' + pl(Number(b.diasSemResposta) || 0, 'dia', 'dias') : 'Formalizado';
    if (b.estado === 'RESOLVIDO') return 'Resolvido';
    return 'Descartado';
  }
  // As acções do histórico, em linguagem de obra (a folha do trabalho e o aviso de um conflito).
  var ACCAO = { criar: 'Registado', 'editar-texto': 'Texto mudado', localizacao: 'Localização mudada', planear: 'Dia previsto mudado', bloquear: 'Bloqueado',
    'sugerir-bloqueio': 'Bloqueio sugerido', 'confirmar-bloqueio': 'Bloqueio confirmado', 'rejeitar-bloqueio': 'Bloqueio rejeitado', desbloquear: 'Desbloqueado',
    feito: 'Feito', reabrir: 'Reaberto', anular: 'Anulado', 'foto-juntar': 'Foto junta', 'foto-tirada': 'Foto tirada', 'foto-confirmada': 'Foto enviada',
    'foto-tirar': 'Foto tirada', 'foto-retirar': 'Foto retirada', 'foto-retirada': 'Foto retirada', 'foto-arquivada': 'Foto arquivada',
    'bc-desligado': 'Passou a «Outro»', descartar: 'Não era do cliente' };
  function nomeAccao(a) { return ACCAO[a] || a; }
  var FRASE_CONFLITO = { FEITO: 'já foi marcado como feito', ANULADO: 'já foi anulado', BLOQUEADO: 'já está bloqueado', POR_CONFIRMAR: 'já tem um bloqueio por confirmar',
    POR_FAZER: 'já mudou', ATRASADO: 'já mudou', POR_PLANEAR: 'já mudou' };
  // A acção que pôs o trabalho no estado de agora (para dizer QUEM): a última destas no histórico. As das fotos não contam
  // (a confirmação de uma foto vem com o nome da conta, e chega depois do «feito»; ensaio contra o servidor real, 13 nov).
  var ACCAO_DO_ESTADO = { FEITO: ['feito'], ANULADO: ['anular'], BLOQUEADO: ['bloquear', 'confirmar-bloqueio', 'sugerir-bloqueio'], POR_CONFIRMAR: ['sugerir-bloqueio', 'bloquear'] };
  /** «Já foi marcado como feito por Rui Sousa»: o estado de agora e quem fez a acção que o pôs assim (o histórico do servidor). */
  function textoConflito(registo, estado) {
    var e = estado || (registo && registo.estado) || '', hs = (registo && registo.historico) || [], quer = ACCAO_DO_ESTADO[e], h = null;
    for (var i = hs.length - 1; i >= 0 && !h; i--) { var a = hs[i] && hs[i].accao; if (quer ? quer.indexOf(a) >= 0 : !/^foto-/.test(a)) h = hs[i]; }
    var f = FRASE_CONFLITO[e] || 'já mudou';
    var t = f.charAt(0).toUpperCase() + f.slice(1) + (h && h.nome && e !== 'POR_FAZER' && e !== 'ATRASADO' && e !== 'POR_PLANEAR' ? ' por ' + h.nome : (h && h.nome ? ' (' + nomeAccao(h.accao).toLowerCase() + ' por ' + h.nome + ')' : ''));
    return t + '.';
  }

  // ── A cache da conta (cache.tf[obra] = { data, lidoEm }) ──
  var OBRAS_NA_CACHE = 4;
  /** Fica só com as `max` obras lidas mais recentemente (as outras lêem-se outra vez com rede). */
  function aparar(mapa, max) {
    var ks = Object.keys(mapa).sort(function (a, b) { return String((mapa[b] || {}).lidoEm || '').localeCompare(String((mapa[a] || {}).lidoEm || '')); });
    ks.slice(max).forEach(function (k) { delete mapa[k]; });
  }
  function guardarLista(cache, obra, data, agora) {
    if (!cache.tf || typeof cache.tf !== 'object') cache.tf = {};
    cache.tf[String(obra)] = { data: copia(data), lidoEm: (agora || new Date()).toISOString() };
    aparar(cache.tf, OBRAS_NA_CACHE);
    return cache;
  }
  function listaDe(cache, obra) { var x = cache && cache.tf && cache.tf[String(obra)]; return x && x.data ? x : null; }
  /** Um registo que o servidor devolveu (num comando) entra na cópia, no lugar do antigo (ou à frente, se é novo). */
  function porRegisto(cache, registo) {
    if (!registo || !registo.obraId) return cache;
    var x = listaDe(cache, registo.obraId); if (!x) return cache;
    var l = x.data.trabalhos || [], i = -1;
    l.forEach(function (t, j) { if (t.id === registo.id) i = j; });
    if (i >= 0) l[i] = copia(registo); else { l.unshift(copia(registo)); x.data.total = (Number(x.data.total) || 0) + 1; }
    x.data.trabalhos = l;
    return cache;
  }
  function bcsGuardar(cache, obra, data, agora) { if (!cache.bc || typeof cache.bc !== 'object') cache.bc = {}; cache.bc[String(obra)] = { data: copia(data), lidoEm: (agora || new Date()).toISOString() }; aparar(cache.bc, OBRAS_NA_CACHE); return cache; }
  function bcsDe(cache, obra) { var x = cache && cache.bc && cache.bc[String(obra)]; return x && x.data ? x : null; }

  // ── Os comandos (a fila única: itens com tipo 'tf') ──
  var CAMPOS = { criar: ['texto', 'issueId', 'previsto', 'bloqueio'], 'editar-texto': ['texto'], localizacao: ['issueId'], planear: ['previsto'],
    bloquear: ['quem', 'equipa', 'motivo', 'bcId'], 'sugerir-bloqueio': ['quem', 'equipa', 'motivo', 'bcId'], 'foto-juntar': ['papel'], 'foto-tirar': ['n'], 'foto-retirar': ['n', 'motivo'],
    feito: [], 'confirmar-bloqueio': [], 'rejeitar-bloqueio': [], desbloquear: [], reabrir: [], anular: [] };
  /** Um item da fila para um comando. o: { accao, tf (o registo, ou {id, obraId} no criar), campos, fotos?: [{blob, sha256, tipo, tamanho}],
      contaId, contaNome, novoId, agora, adiarMs (o Desfazer: só segue depois), papel }. */
  function itemComando(o) {
    var agora = o.agora || new Date(), t = o.tf || {}, campos = {};
    (CAMPOS[o.accao] || []).forEach(function (k) { if (o.campos && Object.prototype.hasOwnProperty.call(o.campos, k) && o.campos[k] !== undefined) campos[k] = o.campos[k]; });
    var nBase = Number(o.nBase) || 0;
    var fotos = (o.fotos || []).slice(0, LIMITES.fotos).map(function (f, i) { var n = nBase + i + 1; var g = { n: n, nPedido: n, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho, estado: 'por-declarar' }; if (f.blob) g.blob = f.blob; return g; });
    return { id: 'q-' + uuid(o.novoId), tipo: 'tf', estado: 'a-enviar', contaId: String(o.contaId || ''), contaNome: String(o.contaNome || ''),
      registoId: String(t.id || ''), obraId: String(t.obraId || o.obraId || ''), accao: o.accao, campos: campos, pedidoId: novoPedidoId(o.novoId),
      versao: Number(t.versao) || 0, fotos: fotos, papel: o.papel || (o.accao === 'feito' ? 'depois' : 'antes'), resumo: String(o.resumo || t.texto || '').slice(0, 80),
      criadoEm: agora.toISOString(), adiadoAte: o.adiarMs ? new Date(agora.getTime() + o.adiarMs).toISOString() : '', tentou: false, resposta: null, erro: '', avisos: [] };
  }
  /** O corpo do POST /movel/tf (a lista fechada do contrato). */
  function corpoComando(item) {
    var c = { accao: item.accao, pedidoId: item.pedidoId, id: item.registoId };
    if (item.accao === 'criar') c.obraId = item.obraId;
    Object.keys(item.campos || {}).forEach(function (k) { c[k] = item.campos[k]; });
    if (item.accao === 'editar-texto' && item.versao) c.versao = item.versao;
    var fs = (item.fotos || []).filter(function (f) { return f.estado !== 'removida'; }).map(function (f) { return { n: f.n, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; });
    if (item.accao === 'criar' || item.accao === 'feito') { if (fs.length) c.fotos = fs; }
    if (item.accao === 'foto-juntar') { c.papel = item.papel || 'antes'; c.fotos = fs; }
    return c;
  }
  /** O registo como fica com um comando por enviar (para se ver logo; a resposta do servidor substitui-o). eu: {nome};
      locDe: issueId → Localização (a do comando `localizacao`). */
  function aplicarLocal(t, item, hoje, eu, locDe) {
    var r = copia(t) || {}, agora = new Date().toISOString(), c = item.campos || {};
    r.historico = (r.historico || []).concat([{ accao: item.accao, em: agora, nome: (eu && eu.nome) || '' }]);
    if (item.accao === 'planear') r.previsto = c.previsto || null;
    else if (item.accao === 'bloquear' || item.accao === 'sugerir-bloqueio') r.bloqueio = { quem: c.quem, equipa: c.equipa || null, motivo: c.motivo || null, desde: agora, porConfirmar: item.accao === 'sugerir-bloqueio' && (r.pode || []).indexOf('bloquear') < 0, bloqueiosCliente: c.bcId ? [c.bcId] : [] };
    else if (item.accao === 'confirmar-bloqueio') { if (r.bloqueio) r.bloqueio.porConfirmar = false; }
    else if (item.accao === 'rejeitar-bloqueio' || item.accao === 'desbloquear') r.bloqueio = null;
    else if (item.accao === 'feito') { r.feitoEm = agora; r.bloqueio = null; }
    else if (item.accao === 'reabrir') { r.feitoEm = null; r.anuladoEm = null; }
    else if (item.accao === 'anular') r.anuladoEm = agora;
    else if (item.accao === 'editar-texto') r.texto = c.texto;
    else if (item.accao === 'localizacao') r.localizacao = c.issueId ? ((locDe && locDe(c.issueId)) || r.localizacao) : null;
    else if (item.accao === 'foto-tirar' || item.accao === 'foto-retirar') r.fotos = (r.fotos || []).filter(function (f) { return f.n !== c.n; });   // a foto sai logo da vista
    r.estado = estadoDe(r, hoje); r.porEnviar = true; r.pode = [];   // até o servidor responder, nada mais se faz nele
    return r;
  }
  /** O trabalho que nasce no telemóvel (o criar por enviar): o que a pessoa escreveu, sem acções até ao servidor responder. */
  function registoProvisorio(item, eu, loc, hoje) {
    var c = item.campos || {}, agora = item.criadoEm;
    var r = { id: item.registoId, obraId: item.obraId, texto: c.texto || '', localizacao: loc || null, previsto: null, diasAtraso: 0,
      bloqueio: c.bloqueio ? { quem: c.bloqueio.quem, equipa: c.bloqueio.equipa || null, motivo: c.bloqueio.motivo || null, desde: agora, porConfirmar: true, bloqueiosCliente: [] } : null,
      autor: { nome: (eu && eu.nome) || '', eu: true }, dia: hoje, criadoEm: agora, feitoEm: null, anuladoEm: null, fotos: (item.fotos || []).map(function (f) { return { n: f.n, papel: 'antes', estado: 'por-enviar' }; }),
      versao: 0, alteradoEm: agora, pode: [], historico: [{ accao: 'criar', em: agora, nome: (eu && eu.nome) || '' }], porEnviar: true };
    r.estado = estadoDe(r, hoje);
    return r;
  }
  /** Um comando parado nunca prende os seguintes do mesmo registo (2.ª revisão da parte 4): cada comando decide-se no
      servidor pelo estado de agora, por isso um que foi recusado (dia fechado, sem papel, já não existe) não muda o que o
      seguinte pode fazer. O que muda é a linha: um recusado de vez marca o registo «não entrou»; um conflito (a pessoa já viu
      o que mudou) e uma ligação a outro que fechou não o marcam. */
  var PARADO_SOLTO = { conflito: true, 'outro-fechado': true };
  function paradoNaoEntrou(q) { return q.estado === 'parado' && !PARADO_SOLTO[q.motivo]; }
  /** Um comando parado em conflito (ou com a ligação a outro que fechou) que já não tem fotos por enviar: sai da fila quando
      a pessoa decide outra vez (no fim do aviso do comando novo, depois do Desfazer). Um com fotos por enviar fica sempre. */
  function conflitoSemFotos(q) { return q.estado === 'parado' && PARADO_SOLTO[q.motivo] && (q.fotos || []).every(fotoTerminada); }
  /** A lista que se mostra: a cópia do servidor com os comandos por enviar por cima (por ordem). */
  function comPendentes(lista, fila, obra, hoje, eu, locDe) {
    var l = (lista || []).map(copia), porId = {};
    l.forEach(function (t, i) { porId[t.id] = i; });
    (fila || []).filter(function (q) { return q.tipo === 'tf' && q.obraId === obra && q.estado !== 'entregue'; }).sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      if (q.accao === 'criar') { if (porId[q.registoId] == null) { l.unshift(registoProvisorio(q, eu, locDe ? locDe(q.campos.issueId) : null, hoje)); porId = {}; l.forEach(function (t, i) { porId[t.id] = i; }); } return; }
      var i = porId[q.registoId]; if (i == null) return;
      if (q.estado === 'parado') { if (paradoNaoEntrou(q)) l[i].comErro = q.erro || 'Não entrou'; return; }
      l[i] = aplicarLocal(l[i], q, hoje, eu, locDe);
    });
    return l;
  }

  // ── A resposta do servidor ──
  /** Aplica a resposta de POST /movel/tf ao item: cada foto local fica com o seu estado (por-enviar com o uploadUrl). */
  function aplicarResposta(item, data) {
    var porN = {};
    (data.fotos || []).forEach(function (f) { porN[String(f.nPedido)] = f; });
    (item.fotos || []).forEach(function (f) {
      var s = porN[String(f.nPedido != null ? f.nPedido : f.n)]; if (!s) return;
      f.n = Number(s.n);
      if (s.estado === 'por-enviar') { f.estado = f.blob ? 'por-enviar' : 'servidor'; f.uploadUrl = s.uploadUrl || ''; }
      else if (s.estado === 'por-arquivar' || s.estado === 'arquivada') { f.estado = 'confirmada'; f.uploadUrl = ''; delete f.blob; }
      else if (s.estado === 'removida') { f.estado = 'removida'; f.uploadUrl = ''; delete f.blob; }
      else { f.estado = 'desconhecido'; f.uploadUrl = ''; }
    });
    item.resposta = { versao: Number(data.versao) || 0, estado: data.estado || '', repetido: !!data.repetido, substituiu: data.substituiu || null };
    item.registo = data.registo || null;
    item.avisos = (data.avisos || []).map(textoAviso).filter(Boolean);
    if (data.substituiu && item.accao === 'editar-texto') item.avisos.push(textoSubstituiu(data.substituiu));   // a regra do diário: ganha quem grava, e diz-se
    item.bcCriado = (data.avisos || []).some(function (a) { return a && a.motivo === 'bc-criado'; });
    return item;
  }
  /** O «substituiu» de um editar-texto (a regra do diário, com as palavras dele). */
  /** O servidor marca `substituiu` sempre que a versão mudou desde a que a pessoa viu (o dia previsto, uma foto, uma ligação,
      no telemóvel ou no computador): não se diz que foi o texto nem onde (2.ª revisão). qual: «trabalho» ou «bloqueio». */
  function textoSubstituiu(x, qual) { var h = x && x.alteradoEm ? D.horaDe(x.alteradoEm) : '', q = qual || 'trabalho'; return h ? 'Este ' + q + ' tinha mudado às ' + h + '; o texto ficou o teu.' : 'Este ' + q + ' tinha mudado entretanto; o texto ficou o teu.'; }
  function textoAviso(a) {
    if (!a) return '';
    if (a.motivo === 'bc-criado') return 'Ficou também registado nos bloqueios do cliente.';
    if (a.motivo === 'sugestao-descartada') return 'O bloqueio do cliente que vinha com a sugestão saiu.';
    if (a.campo === 'previsto' && a.motivo === 'sem-papel') return 'O dia previsto fica para o DO ou o GP.';
    if (a.campo === 'issueId') return 'A Localização já não é desta obra: ficou sem Localização.';
    return '';
  }
  function fotoTerminada(f) { return !f.blob || f.estado === 'confirmada' || f.estado === 'servidor' || f.estado === 'removida' || f.estado === 'fora-de-prazo'; }

  // ── Erros → o que fazer (em linguagem de obra) ──
  /** item (opcional): o comando que falhou; algumas frases dependem da acção (o dia fechado de uma foto do depois também
      vale para o GP; a ligação a um bloqueio do cliente que já fechou não é culpa do trabalho). */
  function mensagemTf(e, item) {
    var c = (e && e.code) || '', d = (e && e.details) || {}, a = (item && item.accao) || '';
    if (c === 'TRANSICAO_INVALIDA' && (d.campo === 'bcId' || d.campo === 'tfId')) return transicaoDoOutro(d, a);
    if (c === 'TRANSICAO_INVALIDA') return { accao: 'conflito', estado: d.estado || '', versao: d.versao, texto: 'Isto já mudou noutro telemóvel.' };
    if (c === 'SEM_PAPEL') return { accao: 'parar', texto: d.precisa === 'planeador' ? 'Só o GP e o Diretor de Obra planeiam e bloqueiam nesta obra.' : 'Só quem registou (ou o GP e o Diretor de Obra) pode fazer isto.' };
    if (c === 'DIA_FECHADO') return { accao: 'parar', fechado: true, texto: textoDiaFechado(d, item) };
    if (c === 'TOKEN_DE_AMBITO') return { accao: 'repetir', longo: true, recuada: true, texto: 'Os trabalhos em falta estão a ser atualizados no servidor. Fica no telemóvel; tento mais tarde.' };   // a Edge de antes (recuada): não é um login
    if (c === 'CONTA_EXTERNA') return { accao: 'parar', externa: true, texto: 'Os trabalhos em falta são só das contas da DOE.' };
    if (c === 'NAO_EXISTE') return { accao: 'parar', texto: 'Este trabalho já não existe nesta obra.' };
    if (c === 'FOTOS_DEMAIS') return { accao: 'parar', texto: 'No máximo 3 fotos de cada tipo: tira uma antes de juntar outra.' };
    if (c === 'LIMITE_DIARIO') return { accao: 'parar', texto: 'Chegaste ao limite de ' + (d.max || 50) + ' trabalhos por dia. Fala com o GP.' };
    if (c === 'MOVEL_FATIA2_POR_INSTALAR') return { accao: 'repetir', longo: true, texto: 'Os trabalhos em falta ainda estão a ser preparados no servidor. Fica no telemóvel; tento mais tarde.' };
    if (c === 'FOTO_ARQUIVADA') return { accao: 'parar', texto: 'Essa foto já está nos documentos da obra: só o DO ou o GP a retiram.' };
    // liberdade de corrigir (13 nov 2026): o servidor diz porquê; não se repete
    if (c === 'FOTO_RESERVADA') { var ta = Date.parse(d.ate || ''); return { accao: 'repetir', longo: true, reservada: true, texto: (e && e.message) || 'Outro posto está a arquivar esta foto. Tento outra vez daqui a pouco.', retryAfter: isNaN(ta) ? 600 : Math.max(60, Math.min(600, Math.ceil((ta - Date.now()) / 1000) + 1)) }; }   // revisão: um posto arquiva-a agora; repete depois
    if (c === 'SEM_PAPEL' && d.precisa === 'descartar') return { accao: 'parar', texto: (e && e.message) || 'Anular é de quem registou a sugestão. Para o tirar, descarta-o («Não é do cliente»).' };   // P5
    if (c === 'FOTO_NO_DOCUMENTO') return { accao: 'parar', texto: (e && e.message) || 'Esta foto foi no documento enviado ao cliente: fica.' };
    if (c === 'FOTO_NAO_ARQUIVADA') return { accao: 'parar', texto: (e && e.message) || 'Esta foto ainda não foi arquivada: quem a tirou pode tirá-la.' };
    return D.mensagemDiario(e);
  }

  /** O dia fechado pela acção (o SQL, doe_tf_decidir; liberdade de corrigir, 13 nov 2026): quem registou corrige e desfaz
      durante 7 dias (do dia do registo, ou do dia em que marcou o feito ou anulou); depois, só o GP e o Diretor de Obra. A
      foto do depois: 7 dias depois de marcar feito para quem o marcou (o GP e o DO não têm prazo, nunca recebem isto). Uma
      foto já não se tira por prazo (só se já estiver arquivada). */
  function textoDiaFechado(d, item) {
    var a = (item && item.accao) || '';
    if (d.motivo === 'foto') return 'Esta foto já não entra: o prazo acabou.';
    if ((a === 'foto-juntar' && item.papel === 'depois') || a === 'foto-juntar-depois') return 'A foto do depois só entra até 7 dias depois de marcar feito. Depois, só o DO ou o GP.';
    if (a === 'editar-texto' || a === 'localizacao') return 'Já passaram os 7 dias em que quem registou corrige. Agora, só o DO ou o GP.';
    return 'Já passaram os 7 dias em que quem registou corrige e desfaz. Agora, só o DO ou o GP.';
  }
  /** 409 com campo bcId (o bloqueio do cliente a que se queria ligar) ou tfId (o trabalho a ligar): o outro já fechou. Pára,
      sem prender os comandos seguintes do registo (motivo «outro-fechado»), e diz o que fazer. */
  function transicaoDoOutro(d, a) {
    var e = d.estado || '';
    if (d.campo === 'bcId') return { accao: 'parar', outroFechado: true, estado: e, texto: 'O bloqueio do cliente ' + (e === 'DESCARTADO' ? 'já não conta como do cliente' : (e === 'RESOLVIDO' ? 'já foi resolvido' : 'já fechou')) + ': liga a outro ou bloqueia sem ele.' };
    return { accao: 'parar', outroFechado: true, estado: e, texto: 'Esse trabalho já ' + (e === 'ANULADO' ? 'foi anulado' : (e === 'FEITO' ? 'foi feito' : 'mudou')) + ': não ficou ' + (a === 'desligar-tf' ? 'desligado' : 'ligado') + '.' };
  }

  // ── Rede ──
  function lerLista(deps, obra) { return D.pedir(deps, 'GET', '/movel/tf?obra=' + encodeURIComponent(obra)); }
  function lerBcs(deps, obra) { return D.pedir(deps, 'GET', '/movel/bc?obra=' + encodeURIComponent(obra)); }
  function urlFoto(deps, id, n) { return D.pedir(deps, 'GET', '/movel/fotos/url?entidade=TF&id=' + encodeURIComponent(id) + '&n=' + encodeURIComponent(n)); }
  function estadoDo(m) { return m.accao === 'login' ? 'login' : (m.accao === 'conflito' ? 'conflito' : (m.accao === 'parar' || m.accao === 'corrigir' ? 'parar' : 'pendente')); }
  /** Leva um comando da fila o mais longe possível: o comando, depois cada foto (PUT + /movel/fotos/confirmada). Cada passo
      repete-se com segurança (o mesmo pedidoId). → { estado: 'entregue'|'pendente'|'login'|'parar'|'conflito'|'alheio', … }.
      cfg: a rota, a entidade das fotos, o corpo, a resposta, as mensagens e o id novo (os trabalhos por omissão; os
      bloqueios do cliente, bloqueios.js, usam o mesmo motor com os seus). */
  var CFG_TF = { rota: '/movel/tf', entidade: 'TF', corpo: corpoComando, aplicar: aplicarResposta, mensagem: mensagemTf, novoIdRegisto: novoIdTf };
  function processarTf(item, deps) { return processarComando(item, deps, CFG_TF); }
  async function processarComando(item, deps, cfg) {
    cfg = cfg || CFG_TF;
    var corpoComando = cfg.corpo, aplicarResposta = cfg.aplicar, mensagemTf = cfg.mensagem, novoIdTf = cfg.novoIdRegisto;
    if (deps.contaId && item.contaId && item.contaId !== deps.contaId()) return { estado: 'alheio', mensagem: 'Isto é de ' + (item.contaNome || 'outra conta') + '; só essa conta o pode enviar.' };
    var guardar = function () { return deps.guardar(item); };
    if (!item.resposta && deps.online && deps.online() === false) return { estado: 'pendente', rede: true, mensagem: D.mensagemDiario({ rede: true, online: false }).texto };
    var ajustes = 0;
    while (!item.resposta) {
      item.tentou = true; await guardar();
      var x = await D.pedir(deps, 'POST', cfg.rota, corpoComando(item));
      if (!x.ok && x.rede && x.online === false) item.tentou = false;
      if (x.ok) { aplicarResposta(item, x.data); item.erro = ''; if (deps.aoGravado) await deps.aoGravado(item, x.data); await guardar(); break; }
      var m = mensagemTf(x, item);
      if (m.accao === 'novo-id' && item.accao === 'criar' && ajustes < 3) { ajustes++; item.registoId = novoIdTf(deps.novoId); item.pedidoId = novoPedidoId(deps.novoId); continue; }
      if (m.accao === 'novo-n' && ajustes < 3) { ajustes++; var mx = 0; item.fotos.forEach(function (f) { mx = Math.max(mx, f.n); }); item.fotos.forEach(function (f) { mx++; f.n = mx; f.nPedido = mx; }); item.pedidoId = novoPedidoId(deps.novoId); continue; }
      item.erro = m.texto;
      if (m.accao === 'parar' || m.accao === 'corrigir' || m.accao === 'conflito') { item.estado = 'parado'; item.motivo = m.accao === 'conflito' ? 'conflito' : (m.outroFechado ? 'outro-fechado' : (m.fechado ? 'dia-fechado' : (m.externa ? 'externa' : 'parar'))); item.conflito = m.accao === 'conflito' ? { estado: m.estado, versao: m.versao } : null; }
      await guardar();
      return { estado: estadoDo(m), mensagem: m.texto, rede: !!m.rede, retryAfter: m.retryAfter || 0, revogado: !!m.revogado, longo: !!m.longo, recuada: !!m.recuada, externa: !!m.externa, conflito: item.conflito || null };
    }
    for (var i = 0; i < item.fotos.length; i++) {
      var f = item.fotos[i];
      if (fotoTerminada(f)) continue;
      for (var t = 0; t < 3 && !fotoTerminada(f); t++) {
        if (!f.uploadUrl) {   // o mesmo pedidoId outra vez: a mesma resposta, com um endereço de envio novo
          var y = await D.pedir(deps, 'POST', cfg.rota, corpoComando(item));
          if (!y.ok) { var my = mensagemTf(y, item); await guardar(); return { estado: estadoDo(my) === 'conflito' ? 'pendente' : estadoDo(my), mensagem: my.texto, rede: !!my.rede, retryAfter: my.retryAfter || 0, revogado: !!my.revogado }; }
          aplicarResposta(item, y.data); await guardar();
          if (fotoTerminada(f) || !f.uploadUrl) break;
        }
        var put;
        try { put = await deps.fetch(f.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.tipo }, body: f.blob }); }
        catch (e) { await guardar(); return { estado: 'pendente', rede: true, mensagem: D.mensagemDiario({ rede: true, online: deps.online ? deps.online() : true }).texto }; }
        if (!put.ok) { if (put.status >= 500 || put.status === 429) { await guardar(); return { estado: 'pendente', mensagem: 'O envio da foto falhou; tento outra vez.' }; } f.uploadUrl = ''; continue; }
        var cf = await D.pedir(deps, 'POST', '/movel/fotos/confirmada', { entidade: cfg.entidade, id: item.registoId, n: f.n });
        if (cf.ok) { f.estado = 'confirmada'; f.uploadUrl = ''; if (deps.aoFoto) deps.aoFoto(item, f); delete f.blob; await guardar(); break; }
        if (cf.code === 'FOTO_NAO_ENVIADA' || cf.code === 'FOTO_INVALIDA') { f.uploadUrl = ''; continue; }
        var mc = mensagemTf(cf, item);
        if (mc.fechado) { f.estado = 'fora-de-prazo'; delete f.blob; item.avisos = (item.avisos || []).concat([mc.texto]); await guardar(); break; }
        await guardar();
        return { estado: estadoDo(mc) === 'conflito' ? 'pendente' : estadoDo(mc), mensagem: mc.texto, rede: !!mc.rede, retryAfter: mc.retryAfter || 0, revogado: !!mc.revogado };
      }
    }
    if (item.fotos.every(fotoTerminada)) { item.estado = 'entregue'; await guardar(); return { estado: 'entregue', avisos: item.avisos || [], registo: item.registo, bcCriado: !!item.bcCriado }; }
    await guardar();
    return { estado: 'pendente', mensagem: 'Faltam fotos por enviar; tento outra vez.' };
  }
  /** O que diz a fila de um comando (o «Por enviar»). */
  function resumoItem(q) {
    var c = q.campos || {}, r = q.resumo || '';
    if (q.accao === 'criar') return (c.texto || r) + (q.fotos && q.fotos.length ? ' · ' + pl(q.fotos.length, 'foto', 'fotos') : '');
    if (q.accao === 'planear') return r + ' · ' + (c.previsto ? 'previsto ' + D.textoDiaCurto(c.previsto) : 'sem dia');
    if (q.accao === 'bloquear' || q.accao === 'sugerir-bloqueio') return r + ' · ' + (q.accao === 'bloquear' ? 'bloqueado: ' : 'bloqueio sugerido: ') + (c.equipa || nomeQuem(c.quem)) + (c.motivo ? ' (' + c.motivo + ')' : '');
    return r + ' · ' + nomeAccao(q.accao).toLowerCase();
  }
  function tituloItem(q) { return q.accao === 'criar' ? 'Trabalho em falta' : (q.accao === 'feito' ? 'Trabalho feito' : (q.accao === 'foto-juntar' ? 'Foto de um trabalho' : 'Trabalho em falta · ' + nomeAccao(q.accao).toLowerCase())); }

  // ── O formulário (o rascunho é da conta) ──
  function formNovo(o) { return { obraId: o.obraId || '', texto: '', loc: o.loc || null, locAuto: !!o.loc, bloqOn: false, bloqQuem: '', fotos: [] }; }
  function faltaForm(f, obraValida) {
    if (!f || !f.obraId || obraValida === false) return { campo: 'obra', texto: 'Falta escolher a obra' };
    if (!String(f.texto || '').trim()) return { campo: 'texto', texto: 'Falta escrever o que falta' };
    if (String(f.texto).trim().length > LIMITES.texto) return { campo: 'texto', texto: 'O texto tem mais de ' + LIMITES.texto + ' caracteres' };
    if (f.aPreparar) return { campo: 'fotos', texto: 'A preparar a foto…', espera: true };
    return null;
  }
  // ── O rascunho do formulário (fecho da 2a, molde do diário): em disco, por conta, sai ao enviar ──
  var DIAS_RASCUNHO = 7;
  /** Vazio = nada que a pessoa tenha feito: sem texto, sem fotos e sem «está bloqueado». Um rascunho vazio não se guarda. */
  function rascunhoVazio(f) { return !f || (!String(f.texto || '').trim() && !(f.fotos || []).length && !f.bloqOn); }
  function rascunhoDe(f, o) {
    return { id: f.rid, tipo: 'tf-rascunho', estado: 'rascunho', contaId: String(o.contaId || ''), guardadoEm: (o.agora || new Date()).toISOString(),
      form: { obraId: f.obraId || '', texto: String(f.texto || ''), loc: copia(f.loc || null), locAuto: !!f.locAuto, bloqOn: !!f.bloqOn, bloqQuem: String(f.bloqQuem || ''),
        fotos: (f.fotos || []).filter(function (x) { return x && x.blob; }).slice(0, LIMITES.fotos).map(function (x) { return { blob: x.blob, sha256: x.sha256, tipo: x.tipo, tamanho: x.tamanho }; }) } };
  }
  function formDoRascunho(r) {
    var x = (r && r.form) || {}, f = formNovo({ obraId: x.obraId, loc: x.loc || null });
    f.locAuto = !!x.locAuto; f.texto = String(x.texto || ''); f.bloqOn = !!x.bloqOn; f.bloqQuem = f.bloqOn && QUEM[x.bloqQuem] ? x.bloqQuem : ''; f.rid = r.id;
    f.fotos = (Array.isArray(x.fotos) ? x.fotos : []).filter(function (p) { return p && p.blob && typeof p.blob.size === 'number' && p.sha256; }).slice(0, LIMITES.fotos).map(function (p) { return { blob: p.blob, sha256: p.sha256, tipo: p.tipo, tamanho: p.tamanho }; });
    return f;
  }
  function rascunhosDa(lista, contaId, agora) {
    var lim = new Date((agora || new Date()).getTime() - DIAS_RASCUNHO * 864e5).toISOString(), meus = [], velhos = [];
    (lista || []).forEach(function (r) { if (!r || r.tipo !== 'tf-rascunho') return; if (String(r.guardadoEm || '') < lim) velhos.push(r); else if (r.contaId === contaId) meus.push(r); });
    meus.sort(function (a, b) { return String(b.guardadoEm).localeCompare(String(a.guardadoEm)); });
    return { meus: meus, velhos: velhos };
  }
  /** Os campos do criar: o texto, a Localização, e o bloqueio (de um encarregado fica por confirmar no servidor). */
  function camposCriar(f) {
    var c = { texto: String(f.texto || '').trim().slice(0, LIMITES.texto) };
    if (f.loc && f.loc.issueId) c.issueId = f.loc.issueId;
    if (f.bloqOn && f.bloqQuem) c.bloqueio = { quem: f.bloqQuem };
    return c;
  }

  return {
    LIMITES: LIMITES, QUEM: QUEM, QUEM_ORDEM: QUEM_ORDEM, FRASES_TF: FRASES_TF, FRASES_BLOQ: FRASES_BLOQ, FRASES_CLI: FRASES_CLI, ATIVOS_BC: ATIVOS_BC,
    novoIdTf: novoIdTf, novoPedidoId: novoPedidoId, diaDe: diaDe, estadoDe: estadoDe, nomeQuem: nomeQuem, palavra: palavra, filtroDe: filtroDe, contas: contas,
    locTitulo: locTitulo, grupos: grupos, segs: segs, frases: frases, frasesMotivo: frasesMotivo, alternarFrase: alternarFrase, opcoesDia: opcoesDia,
    bcsDaLoc: bcsDaLoc, nomeEstadoBc: nomeEstadoBc, nomeAccao: nomeAccao, textoConflito: textoConflito,
    guardarLista: guardarLista, listaDe: listaDe, porRegisto: porRegisto, bcsGuardar: bcsGuardar, bcsDe: bcsDe,
    itemComando: itemComando, corpoComando: corpoComando, aplicarLocal: aplicarLocal, registoProvisorio: registoProvisorio, comPendentes: comPendentes,
    aplicarResposta: aplicarResposta, textoAviso: textoAviso, paradoNaoEntrou: paradoNaoEntrou, conflitoSemFotos: conflitoSemFotos, OBRAS_NA_CACHE: OBRAS_NA_CACHE, textoSubstituiu: textoSubstituiu, fotoTerminada: fotoTerminada, mensagemTf: mensagemTf,
    lerLista: lerLista, lerBcs: lerBcs, urlFoto: urlFoto, processarTf: processarTf, processarComando: processarComando, resumoItem: resumoItem, tituloItem: tituloItem,
    formNovo: formNovo, faltaForm: faltaForm, camposCriar: camposCriar, RE_DIA: RE_DIA,
    rascunhoVazio: rascunhoVazio, rascunhoDe: rascunhoDe, formDoRascunho: formDoRascunho, rascunhosDa: rascunhosDa, DIAS_RASCUNHO: DIAS_RASCUNHO,
  };
}));
