/* DOE · Ocorrências pelo telemóvel — lógica pura (sem DOM).
   UMD simples: corre no browser (window.DoeMovel) e em Node (require), para ser testada
   sem browser. O contrato do servidor está em docs/analises/Ocorrencias-Movel-Contrato.md.
   Regras que esta lógica cumpre:
   - o servidor numera: nunca se inventa um número; só há «Referência» (4 caracteres do id);
   - o id é gerado uma vez e não muda em nenhuma repetição (idempotência);
   - texto primeiro, depois cada foto (PUT + foto-confirmada), uma de cada vez;
   - nada se perde: o que não foi entregue fica no rascunho/fila. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.DoeMovel = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITES = {
    fotos: 6,            // limite do servidor
    descricao: 4000,
    ladoMax: 1600,       // px do lado maior
    alvoBytes: 400 * 1024,
    maxBytes: 1024 * 1024,   // acima disto, depois de comprimir, recusa-se
    servidorBytes: 5 * 1024 * 1024,
    margemTokenMs: 60 * 1000,
  };
  var ESPERAS_MS = [2000, 10000, 60000];   // 2 s, 10 s, 1 min; depois só quando voltar a rede
  var PASSOS_COMPRESSAO = [
    { lado: 1600, qualidade: 0.7 },
    { lado: 1400, qualidade: 0.6 },
    { lado: 1200, qualidade: 0.5 },
  ];

  // ── Identificadores ──
  function novoId(cripto) {
    var c = cripto || (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  /** Os 4 primeiros caracteres do id, em maiúsculas: comprovativo provisório, NUNCA um número oficial. */
  function referencia(id) { return String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase(); }

  // ── Sessão (token) ──
  function validadeToken(sessao, agora) {
    if (!sessao || typeof sessao.token !== 'string' || !sessao.token || !sessao.expiraEm) return { valida: false, motivo: 'sem-sessao' };
    var t = Date.parse(sessao.expiraEm);
    if (isNaN(t)) return { valida: false, motivo: 'sem-sessao' };
    var ms = t - (agora instanceof Date ? agora.getTime() : (agora == null ? Date.now() : agora));
    if (ms <= LIMITES.margemTokenMs) return { valida: false, motivo: 'expirada' };
    return { valida: true, restanteMs: ms };
  }
  /** Do que o login devolve guarda-se só o necessário; a palavra-passe nunca entra aqui. */
  function sessaoDeLogin(data) {
    var obras = Array.isArray(data && data.obras) ? data.obras.map(function (o) {
      return { id: String(o.id), codigo: String(o.codigo || ''), nome: String(o.nome || '') };
    }) : [];
    return { token: String(data.token), expiraEm: String(data.expiraEm), contaId: String(data.contaId || contaDoToken(data.token)), nome: String(data.nome || ''), obras: obras };
  }
  /** O `sub` do token (a conta). Só serve de etiqueta para prender a fila ao utilizador: quem decide é o servidor. */
  function contaDoToken(token) {
    try {
      var p = String(token || '').split('.')[1];
      if (!p) return '';
      p = p.replace(/-/g, '+').replace(/_/g, '/');
      var txt = typeof atob === 'function' ? atob(p) : Buffer.from(p, 'base64').toString('binary');
      return String((JSON.parse(txt) || {}).sub || '');
    } catch (e) { return ''; }
  }
  /** O rascunho pode ser enviado por esta conta? Sem dono (feito antes de haver sessão) qualquer conta o adopta. */
  function ehDaConta(r, contaId) { return !r || !r.contaId || r.contaId === (contaId || ''); }
  /** Só uma execução de cada vez: uma segunda chamada enquanto a primeira não acaba é ignorada (clique duplo em Enviar). */
  function umaVez(fn) {
    var ocupado = false;
    return async function () {
      if (ocupado) return undefined;
      ocupado = true;
      try { return await fn.apply(this, arguments); } finally { ocupado = false; }
    };
  }
  /** "30 segundos", "1 minuto", "5 minutos": a mesma regra do servidor (ocorrenciaEntrada.js textoEspera). */
  function textoEspera(seg) {
    seg = Number(seg) || 0;
    if (seg >= 90) return Math.ceil(seg / 60) + ' minutos';
    if (seg >= 60) return '1 minuto';
    seg = Math.max(1, Math.ceil(seg));
    return seg === 1 ? '1 segundo' : seg + ' segundos';
  }
  /** Segundos de espera: o cabeçalho Retry-After (se o browser o deixar ler: entre origens só com Expose-Headers) ou, senão,
      o `details.retryAfterSeg` do corpo do erro. */
  function lerRetryAfter(res, er) {
    var h = 0;
    try { h = Number(res && res.headers && res.headers.get && res.headers.get('Retry-After')) || 0; } catch (e) { h = 0; }
    if (h > 0) return h;
    var d = Number(er && er.details && er.details.retryAfterSeg) || 0;
    return d > 0 ? d : 0;
  }
  /** Obra pré-seleccionada: ?obra=CÓDIGO ganha, depois a última usada, senão nenhuma (a pessoa escolhe). */
  function escolherObra(obras, codigoLink, ultimaId) {
    var lista = obras || [];
    var cod = String(codigoLink || '').trim().toUpperCase();
    if (cod) { var a = lista.filter(function (o) { return String(o.codigo).toUpperCase() === cod; })[0]; if (a) return a.id; }
    if (ultimaId) { var b = lista.filter(function (o) { return o.id === ultimaId; })[0]; if (b) return b.id; }
    return lista.length === 1 ? lista[0].id : '';
  }

  // ── Imagem ──
  function tamanhoImagem(largura, altura, ladoMax) {
    var max = ladoMax || LIMITES.ladoMax;
    var w = Math.max(1, Math.round(largura)), h = Math.max(1, Math.round(altura));
    var maior = Math.max(w, h);
    if (maior <= max) return { w: w, h: h, reduzida: false };
    var f = max / maior;
    return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)), reduzida: true };
  }
  /** Depois de comprimir com o passo `passo` (0,1,2): aceitar, tentar o passo seguinte ou rejeitar. */
  function decidirCompressao(bytes, passo) {
    if (bytes <= LIMITES.alvoBytes) return 'aceitar';
    if (passo < PASSOS_COMPRESSAO.length - 1) return 'tentar';
    return bytes <= LIMITES.maxBytes ? 'aceitar' : 'rejeitar';
  }
  var MSG_FOTO_GRANDE = 'Esta foto continua demasiado grande depois de comprimida. Tira outra, com menos zoom ou em melhor luz.';
  var MSG_FOTO_ILEGIVEL = 'Não consegui abrir esta foto. Tira-a no formato mais compatível (JPEG, nas definições da câmara) e tenta de novo.';

  // ── SHA-256 ──
  // O caminho normal é o crypto.subtle do browser (https). Numa página http://IP (teste na rede local) o
  // crypto.subtle NÃO existe: só então se usa esta implementação em JavaScript puro, validada contra o node:crypto.
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  /** SHA-256 em JavaScript puro. `dados`: Uint8Array (ou ArrayBuffer). Devolve 64 hexadecimais minúsculos. */
  function sha256Js(dados) {
    var d = dados instanceof Uint8Array ? dados : new Uint8Array(dados);
    var n = d.length, total = ((n + 9 + 63) >> 6) << 6;
    var b = new Uint8Array(total); b.set(d); b[n] = 0x80;
    var dv = new DataView(b.buffer);
    dv.setUint32(total - 8, Math.floor(n / 0x20000000), false);   // bits altos (n * 8 / 2^32)
    dv.setUint32(total - 4, (n << 3) >>> 0, false);               // bits baixos
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Uint32Array(64);
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], bb = h[1], c = h[2], dd = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var mj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + mj) | 0;
        hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + dd) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return h.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
  }
  /** SHA-256 dos bytes (ArrayBuffer/Uint8Array) em hexadecimal. Usa o crypto.subtle quando existe; senão (http, sem
      contexto seguro) a reserva em JavaScript. `opcoes.forcarJs` obriga à reserva (testes). */
  async function sha256Hex(bytes, opcoes) {
    var c = (opcoes && opcoes.cripto) || (typeof self !== 'undefined' ? self.crypto : (typeof crypto !== 'undefined' ? crypto : null));
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!(opcoes && opcoes.forcarJs) && c && c.subtle && typeof c.subtle.digest === 'function') {
      var d = await c.subtle.digest('SHA-256', u8);
      return Array.prototype.map.call(new Uint8Array(d), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }
    return sha256Js(u8);
  }

  // ── Classificação opcional: Produto + «o que aconteceu» (9 nov 2026) ──
  // As listas vêm de classificacao.js (GERADO a partir da app: movel/gerar-classificacao.js). Nada disto é obrigatório:
  // sem escolher, o corpo do pedido é igual ao de antes e a classificação fica para a triagem. O servidor volta a validar.
  var CLASSIF = null;
  function definirClassificacao(c) { CLASSIF = c && Array.isArray(c.produtos) && c.defeitos && typeof c.defeitos === 'object' ? c : null; return CLASSIF; }
  function classificacaoDisponivel() { return !!CLASSIF; }
  function defeitosDe(produto) { return CLASSIF && Object.prototype.hasOwnProperty.call(CLASSIF.defeitos, produto) ? CLASSIF.defeitos[produto] : []; }
  /** O que está escolhido no rascunho, limpo: só produtos conhecidos (pela ordem da lista), só defeitos conhecidos desse produto. */
  function classificacaoDe(r) {
    var brutos = r && Array.isArray(r.tipoProduto) ? r.tipoProduto : [];
    var tipos = CLASSIF ? CLASSIF.produtos.filter(function (p) { return brutos.indexOf(p) >= 0; }) : brutos.filter(function (p, i) { return typeof p === 'string' && brutos.indexOf(p) === i; });
    var def = {};
    var d = r && r.defeitos && typeof r.defeitos === 'object' ? r.defeitos : {};
    tipos.forEach(function (p) {
      var k = Object.prototype.hasOwnProperty.call(d, p) ? d[p] : null;
      if (typeof k !== 'string') return;
      if (CLASSIF && !defeitosDe(p).some(function (x) { return x.key === k; })) return;
      def[p] = k;
    });
    return { tipoProduto: tipos, defeitos: def };
  }
  function temClassificacao(r) { return classificacaoDe(r).tipoProduto.length > 0; }
  /** Liga/desliga um produto. Ao tirar o produto cai o «o que aconteceu» dele (como na ficha da app). */
  function alternarProduto(r, produto) {
    if (CLASSIF && CLASSIF.produtos.indexOf(produto) < 0) return r;
    var l = classificacaoDe(r).tipoProduto, i = l.indexOf(produto);
    if (i >= 0) { l.splice(i, 1); if (r.defeitos) delete r.defeitos[produto]; } else l.push(produto);
    r.tipoProduto = CLASSIF ? CLASSIF.produtos.filter(function (p) { return l.indexOf(p) >= 0; }) : l;
    return r;
  }
  /** Escolhe «o que aconteceu» de um produto já escolhido; tocar na mesma opção outra vez desfaz (é opcional). */
  function escolherDefeito(r, produto, chave) {
    if ((r.tipoProduto || []).indexOf(produto) < 0) return r;
    if (CLASSIF && !defeitosDe(produto).some(function (x) { return x.key === chave; })) return r;
    if (!r.defeitos || typeof r.defeitos !== 'object') r.defeitos = {};
    if (r.defeitos[produto] === chave) delete r.defeitos[produto]; else r.defeitos[produto] = chave;
    return r;
  }
  /** Frase curta para o título fechado: «Vidro · Quebra espontânea (HST)». Vazia sem escolhas. */
  function resumoClassificacao(r) {
    var c = classificacaoDe(r);
    return c.tipoProduto.map(function (p) {
      var k = c.defeitos[p], d = k ? defeitosDe(p).filter(function (x) { return x.key === k; })[0] : null;
      return p + (d ? ' · ' + d.label : '');
    }).join(' · ');
  }

  // ── Rascunho ──
  function novoRascunho(o) {
    return { id: o.id, projectId: o.projectId || '', texto: '', capturadoEm: '', fotos: [], estado: 'rascunho', numero: '', criadoEm: o.agora || '', contaId: o.contaId || '', contaNome: o.contaNome || '', tipoProduto: [], defeitos: {} };
  }
  function rascunhoVazio(r) { return !String(r.texto || '').trim() && !(r.fotos || []).length; }
  function marcarCaptura(r, agora) { if (!r.capturadoEm) r.capturadoEm = (agora instanceof Date ? agora : new Date()).toISOString(); return r; }
  function podeEnviar(r) {
    if (!r.projectId) return { ok: false, campo: 'obra', motivo: 'Escolhe a obra.' };
    var t = String(r.texto || '').trim();
    if (!t) return { ok: false, campo: 'texto', motivo: 'Escreve o que se passa.' };
    if (t.length > LIMITES.descricao) return { ok: false, campo: 'texto', motivo: 'O texto tem mais de ' + LIMITES.descricao + ' caracteres.' };
    if ((r.fotos || []).length > LIMITES.fotos) return { ok: false, campo: 'fotos', motivo: 'No máximo ' + LIMITES.fotos + ' fotos.' };
    return { ok: true };
  }
  function podeAcrescentarFoto(r) { return (r.fotos || []).length < LIMITES.fotos; }
  /** Fecha o rascunho para envio: numera as fotos e fixa o que vai ao servidor (depois do texto enviado o servidor ignora alterações). */
  function congelar(r, agora) {
    marcarCaptura(r, agora);
    r.fotos.forEach(function (f, i) { f.n = i + 1; f.estado = 'espera'; f.uploadUrl = ''; f.erro = ''; });
    r.estado = 'a-enviar'; r.tentativas = 0;
    return r;
  }
  function reabrir(r) {
    // Só possível enquanto o servidor ainda não criou nada (sem número).
    if (r.numero) return r;
    r.estado = 'rascunho'; r.tentativas = 0; r.bloqueio = '';
    r.fotos.forEach(function (f) { f.estado = 'espera'; f.erro = ''; f.uploadUrl = ''; });
    return r;
  }
  function corpoEntrada(r) {
    var corpo = {
      id: r.id, projectId: r.projectId, descricao: String(r.texto || '').trim(), capturadoEm: r.capturadoEm,
      fotos: r.fotos.map(function (f) { return { n: f.n, sha256: f.sha256, tipo: f.tipo, tamanho: f.tamanho }; }),
    };
    // Só vai o que a pessoa escolheu (e é válido). Sem escolha, o corpo é o de sempre.
    var c = classificacaoDe(r);
    if (c.tipoProduto.length) { corpo.tipoProduto = c.tipoProduto; if (Object.keys(c.defeitos).length) corpo.defeitos = c.defeitos; }
    return corpo;
  }
  function contarFotos(r) {
    var total = r.fotos.length, ok = r.fotos.filter(function (f) { return f.estado === 'confirmada'; }).length;
    return { total: total, confirmadas: ok, faltam: total - ok };
  }
  function textoEstado(r) {
    var c = contarFotos(r);
    if (r.estado === 'entregue') return 'Ocorrência ' + r.numero + ' registada.';
    if (r.numero) {
      if (c.faltam > 0) return 'Ocorrência ' + r.numero + ' registada. A enviar fotos (' + (c.confirmadas + 1 > c.total ? c.total : c.confirmadas + 1) + ' de ' + c.total + ').';
      return 'Ocorrência ' + r.numero + ' registada.';
    }
    return 'A enviar…';
  }

  // ── Erros do contrato → mensagem e o que fazer ──
  // accao: 'repetir' (rede/servidor; volta a tentar com espera), 'login' (pede só o login, sem perder nada),
  //        'corrigir' (a pessoa muda algo), 'parar' (não adianta repetir), 'novo-id'.
  function mensagemErro(e) {
    var c = e && e.code || '', s = e && e.status || 0, m = e && e.message || '', d = e && e.details || {};
    if (e && e.rede) return { accao: 'repetir', rede: true, texto: e.online === false ? 'Sem rede. Guardada no telemóvel: envia-se quando houver rede (a página tem de estar aberta).' : 'Não consegui falar com o servidor (rede fraca ou página sem autorização). Guardada no telemóvel; tento outra vez.' };
    switch (c) {
      case 'INVALID_CREDENTIALS': return { accao: 'corrigir', texto: 'Utilizador ou palavra-passe errados.' };
      case 'UNAUTHORIZED': return { accao: 'login', texto: d.motivo === 'expirado' ? 'A sessão expirou. Entra outra vez; o que escreveste está guardado.' : 'Entra outra vez; o que escreveste está guardado.' };
      case 'CONTA_INACTIVA': return { accao: 'login', texto: 'Esta conta está inativa. Fala com a administração.' };
      case 'TOKEN_DE_AMBITO': case 'TOKEN_SEM_ESCRITA': return { accao: 'login', texto: 'Entra outra vez para continuar; o que escreveste está guardado.' };
      case 'PAPEL_SEM_ESCRITA': return { accao: 'parar', texto: m || 'A tua conta é só de leitura e não pode registar ocorrências.' };
      case 'SEM_PERFIL': return { accao: 'parar', texto: m || 'A tua conta não está ligada a nenhuma pessoa no DOE. Pede à administração.' };
      case 'DEMASIADOS_PEDIDOS': return { accao: 'repetir', texto: 'Demasiados pedidos seguidos. Espera ' + (e.retryAfter ? textoEspera(e.retryAfter) : 'um pouco') + '; tento outra vez.', retryAfter: e.retryAfter || 0 };
      case 'LIMITE_DIARIO': return { accao: 'parar', texto: 'Atingiste o limite de hoje. Fala com o gabinete.' };
      case 'DB_INDISPONIVEL': return { accao: 'repetir', texto: 'O servidor está ocupado. Guardada no telemóvel; tento outra vez.', retryAfter: e.retryAfter || 0 };
      case 'OBRA_INVALIDA': return { accao: 'corrigir', relogin: true, texto: 'Essa obra já não está ativa. Entra outra vez para actualizar a lista de obras.' };
      case 'ID_EM_USO': return { accao: 'novo-id', texto: 'Identificador repetido; gero outro.' };
      case 'ID_INVALIDO': return { accao: 'parar', texto: 'Erro interno da página (identificador). Avisa o gabinete.' };
      case 'ID_ALHEIO': return { accao: 'parar', texto: 'Esta ocorrência foi iniciada por outra conta. Entra com essa conta para a terminar.' };
      case 'TEXTO_PERIGOSO': return { accao: 'corrigir', campo: 'texto', texto: m || 'O texto tem uma parte que não posso gravar. Tira-a e tenta de novo.' };
      case 'VALIDATION_ERROR': return { accao: 'corrigir', campo: d.campo === 'projectId' ? 'obra' : (d.campo === 'descricao' ? 'texto' : d.campo), texto: m || 'Há um campo por corrigir.' };
      case 'CORPO_GRANDE': return { accao: 'parar', texto: 'O pedido ficou demasiado grande. Avisa o gabinete.' };
      case 'FOTO_GRANDE': return { accao: 'corrigir', campo: 'fotos', texto: 'Uma das fotos é demasiado grande (máximo 5 MB). Tira-a outra vez.' };
      case 'FOTO_TIPO': return { accao: 'corrigir', campo: 'fotos', texto: 'Uma das fotos tem um formato que o servidor não aceita. Tira-a no formato mais compatível (JPEG).' };
      case 'FOTO_NAO_DECLARADA': return { accao: 'parar', texto: 'O servidor não conhece esta foto. Avisa o gabinete.' };
      case 'FOTO_NAO_ENVIADA': return { accao: 'repetir', foto: true, texto: 'A foto ainda não chegou ao servidor; envio outra vez.' };
      case 'FOTO_INVALIDA': return { accao: 'repetir', foto: true, texto: 'A foto chegou danificada; envio outra vez.' };
    }
    if (s >= 500 || s === 0) return { accao: 'repetir', texto: 'O servidor não respondeu bem. Guardada no telemóvel; tento outra vez.' };
    if (s === 413) return { accao: 'parar', texto: 'O pedido ficou demasiado grande. Avisa o gabinete.' };
    if (s === 429) return { accao: 'repetir', texto: 'Demasiados pedidos seguidos. Espera ' + (e.retryAfter ? textoEspera(e.retryAfter) : 'um pouco') + '; tento outra vez.', retryAfter: e.retryAfter || 0 };
    if (s === 401) return { accao: 'login', texto: 'Entra outra vez; o que escreveste está guardado.' };
    return { accao: 'parar', texto: m || 'Não foi possível concluir (' + (c || s) + ').' };
  }
  /** Espera até à próxima tentativa; null = só quando voltar a rede / a página for reaberta. */
  function esperaRetry(tentativa, retryAfterSeg) {
    var base = tentativa < ESPERAS_MS.length ? ESPERAS_MS[tentativa] : null;
    if (base == null) return null;
    return Math.max(base, (retryAfterSeg || 0) * 1000);
  }

  // ── Envio ──
  async function chamar(deps, metodo, caminho, corpo) {
    var tk = deps.token();
    if (!tk) return { ok: false, status: 401, code: 'UNAUTHORIZED', details: { motivo: 'expirado' } };
    var res;
    try {
      res = await deps.fetch(deps.base + caminho, {
        method: metodo,
        headers: { 'Authorization': 'Bearer ' + tk, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
    } catch (e) { return { ok: false, status: 0, rede: true, online: deps.online ? deps.online() : true }; }
    var j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res.ok && j && j.data) return { ok: true, status: res.status, data: j.data };
    var er = (j && j.error) || {};
    return { ok: false, status: res.status, code: er.code || '', message: er.message || '', details: er.details || {}, retryAfter: lerRetryAfter(res, er) };
  }
  /** POST /auth/login-movel. A palavra-passe só viaja neste pedido; devolve { ok, sessao } ou { ok:false, msg }. */
  async function login(deps, username, password) {
    var res;
    try {
      res = await deps.fetch(deps.base + '/auth/login-movel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: String(username || '').trim(), password: String(password || '') }) });
    } catch (e) { return { ok: false, rede: true, msg: (deps.online && deps.online() === false) ? 'Para entrar é preciso rede. Verifica a ligação e tenta outra vez.' : 'Não consegui falar com o servidor (rede fraca ou página sem autorização). Tenta outra vez.' }; }
    var j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res.ok && j && j.data && j.data.token) return { ok: true, sessao: sessaoDeLogin(j.data) };
    var er = (j && j.error) || {};
    var ra = lerRetryAfter(res, er);
    var m = mensagemErro({ status: res.status, code: er.code, message: er.message, details: er.details, retryAfter: ra });
    var txt = m.texto;
    if (er.code === 'DEMASIADOS_PEDIDOS') txt = 'Demasiadas tentativas seguidas. Espera ' + (ra ? textoEspera(ra) : 'um pouco') + ' e tenta outra vez.';
    return { ok: false, msg: txt, codigo: er.code || '', retryAfter: ra };
  }
  function aplicarResposta(r, data) {
    r.numero = data.numero; r.repetido = !!data.repetido; r.recebidaEm = r.recebidaEm || '';
    (data.fotos || []).forEach(function (fs) {
      var f = r.fotos.filter(function (x) { return x.n === fs.n; })[0];
      if (!f) return;
      f.caminho = fs.caminho;
      if (fs.confirmada) { f.estado = 'confirmada'; f.uploadUrl = ''; f.erro = ''; }
      else { f.uploadUrl = fs.uploadUrl || ''; if (f.estado === 'confirmada') f.estado = 'espera'; }
    });
  }
  async function enviarTexto(r, deps) {
    var x = await chamar(deps, 'POST', '/ocorrencias/entrada', corpoEntrada(r));
    if (x.ok) { aplicarResposta(r, x.data); if (!r.recebidaEm) r.recebidaEm = deps.agora().toISOString(); await deps.guardar(r); return { ok: true }; }
    return { ok: false, erro: x };
  }
  async function enviarUmaFoto(r, f, deps) {
    // devolve { ok:true } ou { ok:false, erro, global } (global = pára as restantes: rede/login/limite)
    for (var tentativa = 0; tentativa < 2; tentativa++) {
      if (!f.uploadUrl) {
        var t = await enviarTexto(r, deps);               // idempotente: devolve URLs novos
        if (!t.ok) return { ok: false, erro: t.erro, global: true };
        if (f.estado === 'confirmada') return { ok: true };
      }
      f.estado = 'a-enviar'; await deps.guardar(r);
      var put;
      try { put = await deps.fetch(f.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.tipo }, body: f.blob }); }
      catch (e) { return { ok: false, erro: { rede: true, status: 0, online: deps.online ? deps.online() : true }, global: true }; }
      if (!put.ok) {
        if (put.status >= 500 || put.status === 429) return { ok: false, erro: { status: put.status }, global: false };
        f.uploadUrl = '';                                  // URL expirado ou recusado: pede-se outro
        continue;
      }
      var cf = await chamar(deps, 'POST', '/ocorrencias/entrada/foto-confirmada', { id: r.id, n: f.n });
      if (cf.ok) { f.estado = 'confirmada'; f.erro = ''; f.uploadUrl = ''; await deps.guardar(r); return { ok: true }; }
      if (cf.code === 'FOTO_NAO_ENVIADA') continue;        // repete o PUT com o mesmo URL
      if (cf.code === 'FOTO_INVALIDA') { f.uploadUrl = ''; continue; }
      return { ok: false, erro: cf, global: cf.rede || cf.status === 401 || cf.status === 429 || cf.status >= 500 };
    }
    return { ok: false, erro: { code: 'FOTO_INVALIDA', status: 422 }, global: false };
  }
  /** Leva o rascunho congelado o mais longe possível. Devolve { estado, accao, mensagem, espera, rede, relogin }. */
  async function processar(r, deps) {
    // Um rascunho de OUTRA conta nunca se envia sob a identidade de quem está agora na sessão (nem para trocar o id).
    if (deps.contaId && !ehDaConta(r, deps.contaId())) return { estado: 'alheio', mensagem: 'Este rascunho é de ' + (r.contaNome || 'outra conta') + '; só essa conta o pode enviar.' };
    var prob = null;
    var guardarProb = function (e) { var m = mensagemErro(e); m.retryAfter = m.retryAfter || e.retryAfter || 0; prob = prob || m; return m; };
    if (!r.numero) {
      var t = await enviarTexto(r, deps);
      if (!t.ok) {
        var m = guardarProb(t.erro);
        if (m.accao === 'novo-id' && deps.novoId && deps.substituir && ehDaConta(r, deps.contaId ? deps.contaId() : r.contaId)) {
          var antigo = r.id; r.id = deps.novoId(); await deps.substituir(antigo, r);
          t = await enviarTexto(r, deps);
          if (t.ok) m = null; else m = guardarProb(t.erro);
        }
        if (!t.ok) {
          r.bloqueio = m.texto;
          return { estado: m.accao === 'corrigir' ? 'corrigir' : (m.accao === 'login' ? 'login' : (m.accao === 'parar' ? 'parar' : 'pendente')), accao: m.accao, mensagem: m.texto, rede: !!m.rede, relogin: !!m.relogin, campo: m.campo, retryAfter: m.retryAfter };
        }
        prob = null;
      }
    }
    for (var i = 0; i < r.fotos.length; i++) {
      var f = r.fotos[i];
      if (f.estado === 'confirmada') continue;
      var x = await enviarUmaFoto(r, f, deps);
      if (x.ok) continue;
      var mf = guardarProb(x.erro);
      f.estado = 'erro'; f.erro = mf.texto; await deps.guardar(r);
      if (x.global) break;
    }
    if (r.fotos.every(function (f) { return f.estado === 'confirmada'; })) {
      r.estado = 'entregue'; r.entregueEm = deps.agora().toISOString(); r.bloqueio = '';
      await deps.guardar(r);
      return { estado: 'entregue', mensagem: textoEstado(r) };
    }
    r.estado = 'a-enviar'; await deps.guardar(r);
    var p = prob || { accao: 'repetir', texto: 'Faltam fotos por enviar.' };
    return { estado: p.accao === 'login' ? 'login' : (p.accao === 'parar' ? 'parar' : 'pendente'), accao: p.accao, mensagem: p.texto, rede: !!p.rede, retryAfter: p.retryAfter || 0 };
  }

  return {
    LIMITES: LIMITES, ESPERAS_MS: ESPERAS_MS, PASSOS_COMPRESSAO: PASSOS_COMPRESSAO,
    MSG_FOTO_GRANDE: MSG_FOTO_GRANDE, MSG_FOTO_ILEGIVEL: MSG_FOTO_ILEGIVEL,
    novoId: novoId, referencia: referencia,
    validadeToken: validadeToken, sessaoDeLogin: sessaoDeLogin, escolherObra: escolherObra,
    tamanhoImagem: tamanhoImagem, decidirCompressao: decidirCompressao,
    definirClassificacao: definirClassificacao, classificacaoDisponivel: classificacaoDisponivel, defeitosDe: defeitosDe, classificacaoDe: classificacaoDe,
    temClassificacao: temClassificacao, alternarProduto: alternarProduto, escolherDefeito: escolherDefeito, resumoClassificacao: resumoClassificacao,
    novoRascunho: novoRascunho, rascunhoVazio: rascunhoVazio, marcarCaptura: marcarCaptura, podeEnviar: podeEnviar,
    podeAcrescentarFoto: podeAcrescentarFoto, congelar: congelar, reabrir: reabrir, corpoEntrada: corpoEntrada,
    contarFotos: contarFotos, textoEstado: textoEstado, mensagemErro: mensagemErro, esperaRetry: esperaRetry,
    chamar: chamar, processar: processar, login: login,
    contaDoToken: contaDoToken, ehDaConta: ehDaConta, umaVez: umaVez, textoEspera: textoEspera, lerRetryAfter: lerRetryAfter,
    sha256Js: sha256Js, sha256Hex: sha256Hex,
  };
}));
