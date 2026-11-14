/* DOE · Telemóvel — Bloqueios do cliente (fatia 2a, parte 3, 13 nov 2026): lógica pura (sem DOM), UMD como trabalhos.js
   (self.DoeMovelBc no browser, require em Node), testada em Node e contra o servidor real. Contrato: docs/analises/
   Movel-Fatia2-Contrato.md, rotas 4, 5 e 6 (e a «2.ª revisão»: o «Resolvido» desbloqueia os trabalhos ligados, salvo os
   que se desmarcam). Desenho: os ecrãs «Bloqueios do cliente» de docs/prototipos/DOEX-Telemovel-App-Prototipo.html.
   Regras que cumpre (as dos trabalhos em falta, trabalhos.js):
   - as escritas são COMANDOS (`accao`) com o id do bloqueio e um `pedidoId` gerados aqui, na fila única da conta (itens
     com tipo 'bc'); sem rede ficam «por enviar» e seguem sozinhos, com o MESMO pedidoId;
   - a página não tem regra de permissões própria: os botões são os do `pode` que o servidor manda em cada bloqueio;
   - o «Resolvido» manda SEMPRE a lista dos trabalhos que a pessoa viu marcados (`desbloquear: [ids]`; [] = nenhum): um
     trabalho ligado depois de ela ver a folha não se desbloqueia sem ela o ver;
   - 409 TRANSICAO_INVALIDA: o bloqueio relê-se e diz-se em linguagem de obra o que mudou (e quem);
   - o que se lê fica na cache da conta (cache.bc, a mesma dos trabalhos): sai ao Sair e com o token revogado.
   O documento para o cliente e o «Enviado ao cliente» são do computador: não estão aqui. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'), require('./trabalhos.js'));
  else raiz.DoeMovelBc = fabrica(raiz.DoeMovelDiario, raiz.DoeMovelTf);
}(typeof self !== 'undefined' ? self : this, function (D, T) {
  'use strict';
  var LIMITES = { fotos: 3, precisa: 300, tfs: 20 };
  var ATIVOS = ['POR_CONFIRMAR', 'POR_FORMALIZAR', 'FORMALIZADO'];
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function uuid(novoId) { return String(novoId ? novoId() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); }
  function novoIdBc(novoId) { return ('bc-' + uuid(novoId)).slice(0, 64); }
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  function ativo(b) { return !!b && ATIVOS.indexOf(b.estado) >= 0; }
  /** «de hoje», «de ontem», «há 4 dias»: a idade de um bloqueio pelo dia em que nasceu (o dia do servidor). */
  function idade(dia, hoje) { var n = Math.max(0, D.difDias(dia, hoje)); return n === 0 ? 'de hoje' : (n === 1 ? 'de ontem' : 'há ' + n + ' dias'); }

  // ── O estado em linguagem de obra (o do protótipo, estadoBloq): a palavra a cor e o facto ao lado ──
  /** { p: a palavra, c: a classe de cor, f: o facto (a idade, o prazo, o que falta desbloquear); pc e curto: a palavra e o
      facto na coluna estreita da linha da lista (sem o dia da semana; o resto vê-se na folha) }. */
  function palavra(b, hoje) {
    if (!b) return { p: '', c: 'neu-t', f: '' };
    var e = b.estado;
    if (e === 'POR_CONFIRMAR') return { p: 'Por confirmar', c: 'ama-t', f: idade(b.dia, hoje) };
    if (e === 'POR_FORMALIZAR') return { p: 'Por formalizar', c: 'ama-t', f: idade(b.dia, hoje) };
    if (e === 'FORMALIZADO') {
      if (b.semResposta) { var ns = Number(b.diasSemResposta) || 0; return { p: 'Sem resposta há ' + pl(ns, 'dia', 'dias'), c: 'neg-t', f: b.prazoResposta ? 'pedida até ' + D.textoDiaMes(b.prazoResposta) : '', pc: 'Sem resposta', curto: 'há ' + pl(ns, 'dia', 'dias') }; }
      return { p: 'Formalizado', c: 'neu-t', f: b.prazoResposta ? 'resposta até ' + D.textoDiaCurto(b.prazoResposta) : (b.formalizadoEm ? 'a ' + D.textoDiaMes(T.diaDe(b.formalizadoEm)) : ''),
        curto: b.prazoResposta ? 'resposta até ' + D.textoDiaMes(b.prazoResposta) : '' };
    }
    if (e === 'RESOLVIDO') { var n = Number(b.porDesbloquear) || 0; return { p: 'Resolvido', c: 'pos-t', f: n ? pl(n, 'trabalho por desbloquear', 'trabalhos por desbloquear') : (b.resolvidoEm ? D.textoDiaMes(T.diaDe(b.resolvidoEm)) : ''), curto: n ? 'por desbloquear' : '' }; }
    if (e === 'DESCARTADO') return { p: 'Não é do cliente', c: 'neu-t', f: b.descartadoEm ? D.textoDiaMes(T.diaDe(b.descartadoEm)) : '' };
    return { p: e || '', c: 'neu-t', f: '' };
  }
  /** O grupo da lista: conf · form · espera (formalizado, à espera do cliente) · desb (resolvido com trabalhos por
      desbloquear) · fech (resolvido sem trabalhos, ou não era do cliente). */
  function grupoDe(b) {
    if (!b) return 'fech';
    if (b.estado === 'POR_CONFIRMAR') return 'conf';
    if (b.estado === 'POR_FORMALIZAR') return 'form';
    if (b.estado === 'FORMALIZADO') return 'espera';
    if (b.estado === 'RESOLVIDO' && (Number(b.porDesbloquear) || 0) > 0) return 'desb';
    return 'fech';
  }
  var GRUPOS = { ativos: [['conf', 'Por confirmar'], ['form', 'Por formalizar'], ['espera', 'À espera do cliente'], ['desb', 'Por desbloquear']],
    fechados: [['res', 'Resolvidos'], ['desc', 'Não eram do cliente']] };
  /** «Ativos» = os que contam para o bloco Cliente do Hoje (por confirmar, por formalizar, formalizados) e os resolvidos com
      trabalhos ainda por desbloquear (a mesma população do servidor: cliente.pontos, resolvidosComTrabalhos). «Resolvidos»:
      os que fecharam nos últimos 30 dias (a leitura do servidor). */
  function filtroDe(b) { var g = grupoDe(b); return g === 'fech' ? 'fechados' : 'ativos'; }
  /** Os bloqueios de um filtro agrupados por estado; em cada grupo o mais antigo primeiro (e, à espera, os sem resposta
      primeiro); nos fechados, os mais recentes primeiro. */
  function grupos(lista, filtro) {
    var f = filtro === 'fechados' ? 'fechados' : 'ativos', l = (lista || []).filter(function (b) { return filtroDe(b) === f; });
    var chave = function (b) { return f === 'ativos' ? grupoDe(b) : (b.estado === 'DESCARTADO' ? 'desc' : 'res'); };
    return GRUPOS[f].map(function (g) {
      var itens = l.filter(function (b) { return chave(b) === g[0]; });
      itens.sort(function (a, b) {
        if (f === 'fechados') return String(b.resolvidoEm || b.descartadoEm || '').localeCompare(String(a.resolvidoEm || a.descartadoEm || '')) || String(a.id).localeCompare(String(b.id));
        return (b.semResposta ? 1 : 0) - (a.semResposta ? 1 : 0) || String(a.dia || '').localeCompare(String(b.dia || '')) || String(a.criadoEm || '').localeCompare(String(b.criadoEm || '')) || String(a.id).localeCompare(String(b.id));
      });
      return { k: g[0], titulo: g[1], itens: itens };
    }).filter(function (g) { return g.itens.length; });
  }
  /** Os números da lista, com os nomes do bloco Cliente do Hoje (contrato, rota 1): ativos = por confirmar + por formalizar
      + formalizados; resolvidosComTrabalhos à parte. */
  function contas(lista) {
    var s = { ativos: 0, porConfirmar: 0, porFormalizar: 0, formalizados: 0, semResposta: 0, resolvidosComTrabalhos: 0, fechados: 0 };
    (lista || []).forEach(function (b) {
      var g = grupoDe(b);
      if (g === 'conf') { s.ativos++; s.porConfirmar++; } else if (g === 'form') { s.ativos++; s.porFormalizar++; }
      else if (g === 'espera') { s.ativos++; s.formalizados++; if (b.semResposta) s.semResposta++; }
      else if (g === 'desb') s.resolvidosComTrabalhos++; else s.fechados++;
    });
    return s;
  }
  /** «PHX-014 · Piso 4 Norte»: a Localização do bloqueio (o título do protótipo, como nos trabalhos). */
  function locTitulo(l) { return T.locTitulo(l); }
  /** Os trabalhos abertos de uma Localização (o «Trabalhos parados por isto» do formulário): os da lista dos trabalhos da
      obra que não estão feitos nem anulados; sem Localização, os sem Localização. */
  function tfsDaLoc(trabalhos, loc) {
    var id = loc && loc.issueId ? loc.issueId : null;
    return (trabalhos || []).filter(function (t) { return !t.feitoEm && !t.anuladoEm && ((t.localizacao && t.localizacao.issueId) || null) === id; });
  }
  /** Os trabalhos ligados a um bloqueio, pelos ids, com o que a lista dos trabalhos sabe deles (o texto, a Localização). */
  function trabalhosDe(b, trabalhos) {
    var por = {}; (trabalhos || []).forEach(function (t) { por[t.id] = t; });
    return ((b && b.trabalhos) || []).map(function (id) { return por[id] || { id: id, texto: '', localizacao: null, estado: '', desconhecido: true }; });
  }

  // ── O histórico e os conflitos, em linguagem de obra ──
  var ACCAO = { criar: 'Registado', confirmar: 'Confirmado', descartar: 'Não é do cliente', anular: 'Anulado por quem registou', resolver: 'Resolvido', reabrir: 'Reaberto',
    'ligar-tf': 'Trabalho ligado', 'desligar-tf': 'Trabalho desligado', 'editar-texto': 'Texto mudado', localizacao: 'Localização mudada',
    'foto-juntar': 'Foto junta', 'foto-tirada': 'Foto tirada', 'foto-confirmada': 'Foto enviada', enviado: 'Enviado ao cliente', 'documento-arquivado': 'Documento arquivado',
    'foto-tirar': 'Foto tirada', 'foto-retirar': 'Foto retirada', 'foto-retirada': 'Foto retirada', 'foto-arquivada': 'Foto arquivada' };
  function nomeAccao(a) { return ACCAO[a] || a; }
  // a frase pelo que pôs o bloqueio no estado de agora (a última destas acções no histórico; as das fotos e das ligações não contam)
  var FRASE = { confirmar: 'já foi confirmado', enviado: 'já foi enviado ao cliente', resolver: 'já foi resolvido', descartar: 'já foi dado como não sendo do cliente', reabrir: 'já foi reaberto', criar: 'já mudou' };
  /** «Já foi resolvido por Gil Pires.»: o estado de agora e quem o pôs assim (o histórico do servidor). */
  function textoConflito(registo, estado) {
    var hs = (registo && registo.historico) || [], h = null;
    for (var i = hs.length - 1; i >= 0 && !h; i--) if (hs[i] && FRASE[hs[i].accao] && hs[i].accao !== 'criar') h = hs[i];
    if (!h) { var e = estado || (registo && registo.estado) || ''; return e === 'POR_CONFIRMAR' ? 'Já voltou a estar por confirmar.' : 'Já mudou entretanto.'; }
    var f = FRASE[h.accao];
    return f.charAt(0).toUpperCase() + f.slice(1) + (h.nome ? ' por ' + h.nome : '') + '.';
  }

  // ── A cache da conta (cache.bc[obra] = { data, lidoEm }, a mesma dos trabalhos) ──
  function guardarLista(cache, obra, data, agora) { return T.bcsGuardar(cache, obra, data, agora); }
  function listaDe(cache, obra) { return T.bcsDe(cache, obra); }
  /** Um bloqueio que o servidor devolveu entra na cópia, no lugar do antigo (ou à frente, se é novo). */
  function porRegisto(cache, registo) {
    if (!registo || !registo.obraId) return cache;
    var x = listaDe(cache, registo.obraId); if (!x) return cache;
    var l = x.data.bloqueios || [], i = -1;
    l.forEach(function (b, j) { if (b.id === registo.id) i = j; });
    if (i >= 0) l[i] = copia(registo); else { l.unshift(copia(registo)); x.data.total = (Number(x.data.total) || 0) + 1; }
    x.data.bloqueios = l;
    x.data.resolvidosComTrabalhos = l.filter(function (b) { return grupoDe(b) === 'desb'; }).length;
    return cache;
  }

  // ── Os comandos (a fila única: itens com tipo 'bc') ──
  var CAMPOS = { criar: ['precisa', 'issueId', 'tfs'], confirmar: [], descartar: ['motivo'], anular: ['motivo'], resolver: ['desbloquear'], reabrir: [], 'foto-juntar': [], 'foto-tirar': ['n'], 'foto-retirar': ['n', 'motivo'],
    'editar-texto': ['precisa'], localizacao: ['issueId'], 'ligar-tf': ['tfId'], 'desligar-tf': ['tfId'] };   // fecho da 2a: corrigir e ligar/desligar trabalhos
  /** Um item da fila. o: { accao, bc (o registo, ou {id, obraId} no criar), campos, fotos?: [{blob, sha256, tipo, tamanho}],
      contaId, contaNome, novoId, agora, adiarMs (o Desfazer), resumo, nBase, planeia (quem regista planeia: nasce por formalizar) }. */
  function itemComando(o) {
    var it = T.itemComando({ accao: o.accao, tf: o.bc, obraId: o.obraId, campos: {}, fotos: o.fotos, contaId: o.contaId, contaNome: o.contaNome, novoId: o.novoId,
      agora: o.agora, adiarMs: o.adiarMs, papel: 'antes', resumo: o.resumo || (o.bc && o.bc.precisa) || (o.campos && o.campos.precisa) || '', nBase: o.nBase });
    var campos = {};
    (CAMPOS[o.accao] || []).forEach(function (k) { if (o.campos && Object.prototype.hasOwnProperty.call(o.campos, k) && o.campos[k] !== undefined) campos[k] = copia(o.campos[k]); });
    it.tipo = 'bc'; it.campos = campos; it.planeia = !!o.planeia;
    return it;
  }
  /** O corpo do POST /movel/bc (a lista fechada do contrato, rota 5). */
  function corpoComando(item) {
    var c = { accao: item.accao, pedidoId: item.pedidoId, id: item.registoId };
    if (item.accao === 'criar') c.obraId = item.obraId;
    Object.keys(item.campos || {}).forEach(function (k) { c[k] = item.campos[k]; });
    if (item.accao === 'editar-texto' && item.versao) c.versao = item.versao;   // a versão que a pessoa viu: o servidor diz se substituiu outra
    var fs = (item.fotos || []).filter(function (f) { return f.estado !== 'removida'; }).map(function (f) { return { n: f.n, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; });
    if (item.accao === 'criar' && fs.length) c.fotos = fs;
    if (item.accao === 'foto-juntar') c.fotos = fs;
    return c;
  }
  /** O bloqueio como fica com um comando por enviar (para se ver logo; a resposta do servidor substitui-o). locDe: issueId → Localização. */
  function aplicarLocal(b, item, eu, locDe) {
    var r = copia(b) || {}, agora = new Date().toISOString(), c = item.campos || {};
    r.historico = (r.historico || []).concat([{ accao: item.accao, em: agora, nome: (eu && eu.nome) || '' }]);
    if (item.accao === 'confirmar') { r.estado = 'POR_FORMALIZAR'; r.confirmadoEm = agora; }
    else if (item.accao === 'descartar' || item.accao === 'anular') { r.estado = 'DESCARTADO'; r.descartadoEm = agora; r.trabalhos = []; r.porDesbloquear = 0; }
    else if (item.accao === 'foto-tirar' || item.accao === 'foto-retirar') r.fotos = (r.fotos || []).filter(function (f) { return f.n !== c.n; });
    else if (item.accao === 'resolver') {
      var tira = Array.isArray(c.desbloquear) ? c.desbloquear : (r.trabalhos || []);
      r.estado = 'RESOLVIDO'; r.resolvidoEm = agora; r.trabalhos = (r.trabalhos || []).filter(function (id) { return tira.indexOf(id) < 0; }); r.porDesbloquear = r.trabalhos.length;
    } else if (item.accao === 'reabrir') { r.estado = r.documentoId ? 'FORMALIZADO' : (r.confirmadoEm ? 'POR_FORMALIZAR' : 'POR_CONFIRMAR'); r.resolvidoEm = null; r.descartadoEm = null; r.porDesbloquear = 0; }
    else if (item.accao === 'foto-juntar') r.fotos = (r.fotos || []).concat((item.fotos || []).map(function (f) { return { n: f.n, papel: 'antes', estado: 'por-enviar' }; }));
    else if (item.accao === 'editar-texto') r.precisa = c.precisa;
    else if (item.accao === 'localizacao') r.localizacao = c.issueId ? ((locDe && locDe(c.issueId)) || r.localizacao) : null;
    else if (item.accao === 'ligar-tf') { if ((r.trabalhos || []).indexOf(c.tfId) < 0) r.trabalhos = (r.trabalhos || []).concat([c.tfId]); }
    else if (item.accao === 'desligar-tf') r.trabalhos = (r.trabalhos || []).filter(function (id) { return id !== c.tfId; });
    r.semResposta = r.estado === 'FORMALIZADO' && !!r.semResposta;
    r.porEnviar = true; r.pode = [];   // até o servidor responder, nada mais se faz nele
    return r;
  }
  /** O bloqueio que nasce no telemóvel (o criar por enviar): de quem planeia nasce por formalizar, senão por confirmar. */
  function registoProvisorio(item, eu, loc, hoje) {
    var c = item.campos || {}, agora = item.criadoEm;
    return { id: item.registoId, obraId: item.obraId, precisa: c.precisa || '', localizacao: loc || null, estado: item.planeia ? 'POR_FORMALIZAR' : 'POR_CONFIRMAR', dia: hoje, criadoEm: agora,
      autor: { nome: (eu && eu.nome) || '', eu: true }, confirmadoEm: null, formalizadoEm: null, prazoResposta: null, semResposta: false, diasSemResposta: 0, documentoId: null,
      resolvidoEm: null, descartadoEm: null, descartadoMotivo: null, trabalhos: (c.tfs || []).slice(), porDesbloquear: 0,
      fotos: (item.fotos || []).map(function (f) { return { n: f.n, papel: 'antes', estado: 'por-enviar' }; }), versao: 0, alteradoEm: agora, pode: [],
      historico: [{ accao: 'criar', em: agora, nome: (eu && eu.nome) || '' }], porEnviar: true };
  }
  /** A lista que se mostra: a cópia do servidor com os comandos por enviar por cima (por ordem). */
  function comPendentes(lista, fila, obra, hoje, eu, locDe) {
    var l = (lista || []).map(copia), porId = {}, refaz = function () { porId = {}; l.forEach(function (b, i) { porId[b.id] = i; }); };
    refaz();
    (fila || []).filter(function (q) { return q.tipo === 'bc' && q.obraId === obra && q.estado !== 'entregue'; }).sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      if (q.accao === 'criar') { if (porId[q.registoId] == null) { l.unshift(registoProvisorio(q, eu, locDe ? locDe(q.campos.issueId) : null, hoje)); refaz(); } return; }
      var i = porId[q.registoId]; if (i == null) return;
      if (q.estado === 'parado') { if (T.paradoNaoEntrou(q)) l[i].comErro = q.erro || 'Não entrou'; return; }
      l[i] = aplicarLocal(l[i], q, eu, locDe);
    });
    return l;
  }

  // ── A resposta do servidor ──
  function aplicarResposta(item, data) {
    T.aplicarResposta(item, data);
    item.avisos = (data.avisos || []).map(textoAviso).filter(Boolean);
    if (data.substituiu && item.accao === 'editar-texto') item.avisos.push(T.textoSubstituiu(data.substituiu, 'bloqueio'));
    item.tfLigados = Array.isArray(data.tfLigados) ? copia(data.tfLigados) : null;
    return item;
  }
  function textoAviso(a) {
    if (!a) return '';
    if (a.campo === 'tfs' && a.motivo === 'fechado') return 'Um trabalho já estava feito: não ficou ligado.';
    if (a.campo === 'tfs' && a.motivo === 'desconhecido') return 'Um trabalho já não está nesta obra: não ficou ligado.';
    if (a.campo === 'tfs' && a.motivo === 'alterado') return 'Um trabalho já tinha mudado entretanto: não voltou a ficar ligado.';
    if (a.campo === 'desbloquear' && a.motivo === 'outro-bloqueio') return 'Um trabalho continua bloqueado por outro bloqueio do cliente.';
    if (a.campo === 'desbloquear' && a.motivo === 'nao-ligado') return 'Um trabalho já não estava ligado a este bloqueio.';
    if (a.motivo === 'passou-a-outro') return 'O trabalho desligado fica bloqueado por «Outro» até alguém o desbloquear.';
    if (a.motivo === 'ja-ligado') return 'Esse trabalho já estava ligado a este bloqueio.';
    if (a.motivo === 'pede-novo-envio') return 'Acertar isto pede um novo envio ao cliente.';   // P6: o documento enviado (o retrato) não muda
    if (a.motivo === 'rebloqueado') return 'O trabalho voltou a ficar bloqueado pelo cliente.';
    if (a.campo === 'tfId' && a.motivo === 'nao-ligado') return 'Esse trabalho já não estava ligado a este bloqueio.';
    return T.textoAviso(a);
  }
  function mensagemBc(e, item) {
    var c = (e && e.code) || '', d = (e && e.details) || {};
    if (c === 'SEM_PAPEL' && d.precisa === 'descartar') return { accao: 'parar', texto: (e && e.message) || 'Anular é de quem registou a sugestão. Para o tirar, descarta-o («Não é do cliente»).' };   // P5: o do GP é o «Não é do cliente»
    if (c === 'SEM_PAPEL') return { accao: 'parar', texto: d.precisa === 'planeador' ? 'Só o GP e o Diretor de Obra confirmam e resolvem os bloqueios do cliente nesta obra.' : 'Só quem registou (ou o GP e o Diretor de Obra) pode fazer isto.' };
    if (c === 'NAO_EXISTE') return { accao: 'parar', texto: 'Este bloqueio do cliente já não existe nesta obra.' };
    if (c === 'CONTA_EXTERNA') return { accao: 'parar', externa: true, texto: 'Os bloqueios do cliente são só das contas da DOE.' };
    if (c === 'LIMITE_DIARIO') return { accao: 'parar', texto: 'Chegaste ao limite de ' + (d.max || 20) + ' bloqueios do cliente por dia. Fala com o GP.' };
    if (c === 'MOVEL_FATIA2_POR_INSTALAR') return { accao: 'repetir', longo: true, texto: 'Os bloqueios do cliente ainda estão a ser preparados no servidor. Fica no telemóvel; tento mais tarde.' };
    if (c === 'TOKEN_DE_AMBITO') return { accao: 'repetir', longo: true, recuada: true, texto: 'Os bloqueios do cliente estão a ser atualizados no servidor. Fica no telemóvel; tento mais tarde.' };
    return T.mensagemTf(e, item);
  }
  var CFG = { rota: '/movel/bc', entidade: 'BC', corpo: corpoComando, aplicar: aplicarResposta, mensagem: mensagemBc, novoIdRegisto: novoIdBc };
  /** Leva um comando da fila o mais longe possível (o comando, depois cada foto). O mesmo motor dos trabalhos. */
  function processarBc(item, deps) { return T.processarComando(item, deps, CFG); }
  function lerLista(deps, obra) { return T.lerBcs(deps, obra); }
  function urlFoto(deps, id, n) { return D.pedir(deps, 'GET', '/movel/fotos/url?entidade=BC&id=' + encodeURIComponent(id) + '&n=' + encodeURIComponent(n)); }
  /** O que diz a fila de um comando (o «Por enviar»). */
  function resumoItem(q) {
    var c = q.campos || {}, r = q.resumo || '';
    if (q.accao === 'criar') return (c.precisa || r) + (c.tfs && c.tfs.length ? ' · ' + pl(c.tfs.length, 'trabalho parado', 'trabalhos parados') : '') + (q.fotos && q.fotos.length ? ' · ' + pl(q.fotos.length, 'foto', 'fotos') : '');
    if (q.accao === 'resolver') { var n = Array.isArray(c.desbloquear) ? c.desbloquear.length : 0; return r + ' · resolvido' + (n ? ', ' + pl(n, 'trabalho desbloqueado', 'trabalhos desbloqueados') : ''); }
    return r + ' · ' + nomeAccao(q.accao).toLowerCase();
  }
  function tituloItem(q) { return q.accao === 'criar' ? 'Bloqueio do cliente' : (q.accao === 'foto-juntar' ? 'Foto de um bloqueio do cliente' : 'Bloqueio do cliente · ' + nomeAccao(q.accao).toLowerCase()); }
  // ── O rascunho do formulário (fecho da 2a, molde do diário): em disco, por conta, sai ao enviar ──
  var DIAS_RASCUNHO = 7;
  /** Vazio = nada que a pessoa tenha feito: sem texto e sem fotos dela (a foto que veio do trabalho, `daTf`, e os trabalhos
      marcados refazem-se num toque). Um rascunho vazio não se guarda. */
  function rascunhoVazio(f) { return !f || (!String(f.precisa || '').trim() && !(f.fotos || []).some(function (x) { return !x.daTf; })); }
  /** O que se guarda: o formulário sem o que é da página (pré-visualizações, estado do envio). */
  function rascunhoDe(f, o) {
    return { id: f.rid, tipo: 'bc-rascunho', estado: 'rascunho', contaId: String(o.contaId || ''), guardadoEm: (o.agora || new Date()).toISOString(),
      form: { obraId: f.obraId || '', precisa: String(f.precisa || ''), loc: copia(f.loc || null), locAuto: !!f.locAuto, tfs: (f.tfs || []).slice(0, LIMITES.tfs),
        fotos: (f.fotos || []).filter(function (x) { return x && x.blob; }).slice(0, LIMITES.fotos).map(function (x) { return { blob: x.blob, sha256: x.sha256, tipo: x.tipo, tamanho: x.tamanho, daTf: !!x.daTf }; }) } };
  }
  /** O formulário a partir do rascunho (as fotos só se o ficheiro ainda lá está). */
  function formDoRascunho(r) {
    var x = (r && r.form) || {}, f = formNovo({ obraId: x.obraId, loc: x.loc || null, locAuto: !!x.locAuto, tfs: Array.isArray(x.tfs) ? x.tfs : [] });
    f.precisa = String(x.precisa || ''); f.rid = r.id;
    f.fotos = (Array.isArray(x.fotos) ? x.fotos : []).filter(function (p) { return p && p.blob && typeof p.blob.size === 'number' && p.sha256; }).slice(0, LIMITES.fotos).map(function (p) { return { blob: p.blob, sha256: p.sha256, tipo: p.tipo, tamanho: p.tamanho, daTf: !!p.daTf }; });
    return f;
  }
  /** Os rascunhos desta conta (os mais recentes primeiro) e os que já passaram do prazo (para sair do telemóvel). */
  function rascunhosDa(lista, contaId, agora) {
    var lim = new Date((agora || new Date()).getTime() - DIAS_RASCUNHO * 864e5).toISOString(), meus = [], velhos = [];
    (lista || []).forEach(function (r) { if (!r || r.tipo !== 'bc-rascunho') return; if (String(r.guardadoEm || '') < lim) velhos.push(r); else if (r.contaId === contaId) meus.push(r); });
    meus.sort(function (a, b) { return String(b.guardadoEm).localeCompare(String(a.guardadoEm)); });
    return { meus: meus, velhos: velhos };
  }

  // ── O formulário (foto, o que precisamos do cliente, Localização, trabalhos parados) ──
  function formNovo(o) { return { obraId: o.obraId || '', precisa: '', loc: o.loc || null, locAuto: !!o.locAuto, fotos: [], tfs: (o.tfs || []).slice() }; }
  function faltaForm(f, obraValida) {
    if (!f || !f.obraId || obraValida === false) return { campo: 'obra', texto: 'Falta escolher a obra' };
    if (!String(f.precisa || '').trim()) return { campo: 'precisa', texto: 'Falta o que precisamos do cliente' };
    if (String(f.precisa).trim().length > LIMITES.precisa) return { campo: 'precisa', texto: 'O texto tem mais de ' + LIMITES.precisa + ' caracteres' };
    if (f.aPreparar) return { campo: 'fotos', texto: 'A preparar a foto…', espera: true };
    return null;
  }
  function camposCriar(f) {
    var c = { precisa: String(f.precisa || '').trim().slice(0, LIMITES.precisa) };
    if (f.loc && f.loc.issueId) c.issueId = f.loc.issueId;
    if (f.tfs && f.tfs.length) c.tfs = f.tfs.slice(0, LIMITES.tfs);
    return c;
  }
  /** Uma frase de um toque no «o que precisamos do cliente»: escolhe-a ou tira-a (como no protótipo, uma de cada vez). */
  function alternarFrase(texto, frase) { return String(texto || '').trim() === frase ? '' : frase; }

  return {
    LIMITES: LIMITES, ATIVOS: ATIVOS, FRASES: T.FRASES_CLI, GRUPOS: GRUPOS, novoIdBc: novoIdBc, ativo: ativo, idade: idade, palavra: palavra, grupoDe: grupoDe,
    filtroDe: filtroDe, grupos: grupos, contas: contas, locTitulo: locTitulo, tfsDaLoc: tfsDaLoc, trabalhosDe: trabalhosDe, nomeAccao: nomeAccao, textoConflito: textoConflito,
    guardarLista: guardarLista, listaDe: listaDe, porRegisto: porRegisto, itemComando: itemComando, corpoComando: corpoComando, aplicarLocal: aplicarLocal,
    registoProvisorio: registoProvisorio, comPendentes: comPendentes, aplicarResposta: aplicarResposta, textoAviso: textoAviso, mensagemBc: mensagemBc,
    processarBc: processarBc, lerLista: lerLista, urlFoto: urlFoto, resumoItem: resumoItem, tituloItem: tituloItem,
    formNovo: formNovo, faltaForm: faltaForm, camposCriar: camposCriar, alternarFrase: alternarFrase,
    rascunhoVazio: rascunhoVazio, rascunhoDe: rascunhoDe, formDoRascunho: formDoRascunho, rascunhosDa: rascunhosDa, DIAS_RASCUNHO: DIAS_RASCUNHO,
  };
}));
