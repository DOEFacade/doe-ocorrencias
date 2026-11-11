/* DOE · Ocorrências pelo telemóvel: os ícones (SVG de linha 24 × 24, traço 1,75, pontas redondas), DADOS e não HTML.
   Desenho do protótipo validado (docs/prototipos/DOEX-Ocorrencia-Movel-Premium-Prototipo.html, 10 nov 2026).
   Cada ícone é uma lista de [elemento, atributos]: o app.js cria-os com createElementNS (nunca como marcação em texto), por isso
   a CSP fica igual e nada daqui é interpretado como marcação. Os de produto usam o nome da lista (classificacao.js);
   um produto sem ícone usa o de «Outros». Entra no service worker e na versão (sw.js, versao.js). */
self.DOE_MOVEL_ICONES = {
  ui: {
    obra: [['rect',{x:'6',y:'3.5',width:'12',height:'17',rx:'1'}],['path',{d:'M3.5 20.5h17M10 3.5v17M14 3.5v17M6 8h12M6 12.5h12M6 17h12'}]],
    chev: [['path',{d:'M9 6l6 6-6 6'}]],
    proc: [['circle',{cx:'11',cy:'11',r:'6.5'}],['path',{d:'M20 20l-4.2-4.2'}]],
    ok: [['path',{d:'M5 12.5l4.5 4.5L19 7.5'}]],
    x: [['path',{d:'M6.5 6.5l11 11M17.5 6.5l-11 11'}]],
    cam: [['path',{d:'M3.5 8.5A1.5 1.5 0 0 1 5 7h2.2l1.6-2.2h6.4L16.8 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z'}],['circle',{cx:'12',cy:'13',r:'3.6'}]],
    gal: [['rect',{x:'3.5',y:'4.5',width:'17',height:'15',rx:'2'}],['circle',{cx:'9',cy:'10',r:'1.6'}],['path',{d:'M20.5 15.5l-4.5-4.5-8.5 8.5'}]],
    mic: [['rect',{x:'9',y:'3.5',width:'6',height:'11',rx:'3'}],['path',{d:'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5'}]],
    enviar: [['path',{d:'M12 19V5M6 11l6-6 6 6'}]],
    subir: [['path',{d:'M12 16V6M7.5 10.5L12 6l4.5 4.5M5 19h14'}]],
    semrede: [['path',{d:'M7 18h10a4 4 0 0 0 .9-7.9A6 6 0 0 0 6.3 9.1 4.5 4.5 0 0 0 7 18z'}],['path',{d:'M4 4l16 16'}]],
    tel: [['rect',{x:'7',y:'3',width:'10',height:'18',rx:'2.2'}],['path',{d:'M11 17.5h2'}]],
    atual: [['path',{d:'M19.5 12a7.5 7.5 0 1 1-2.2-5.3'}],['path',{d:'M19.5 4.5v4h-4'}]],
    pessoa: [['circle',{cx:'12',cy:'8.5',r:'3.5'}],['path',{d:'M5 20a7 7 0 0 1 14 0'}]],
    olho: [['path',{d:'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'}],['circle',{cx:'12',cy:'12',r:'2.8'}]],
    alerta: [['path',{d:'M12 4.5l8.5 15h-17z'}],['path',{d:'M12 10.5v4M12 17.2v.1'}]],
    relogio: [['circle',{cx:'12',cy:'12',r:'8'}],['path',{d:'M12 8v4.2l2.6 2.6'}]],
    mais: [['path',{d:'M12 5.5v13M5.5 12h13'}]],
    sair: [['path',{d:'M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14'}],['path',{d:'M10 16l-4-4 4-4M6 12h10'}]],
  },
  produto: {
    'Vidro': [['rect',{x:'4.5',y:'3.5',width:'15',height:'17',rx:'1.5'}],['path',{d:'M8.5 10.5l4-4M8.5 15.5l7-7'}]],
    'Perfis': [['path',{d:'M7 4h10v3.5h-3V6.5h-4v11h4v-1h3V20H7z'}]],
    'Ferro': [['path',{d:'M5 4.5h14v3h-5.25v9H19v3H5v-3h5.25v-9H5z'}]],
    'Chapas': [['path',{d:'M3.5 9L12 5l8.5 4L12 13z'}],['path',{d:'M3.5 13l8.5 4 8.5-4M3.5 17l8.5 4 8.5-4'}]],
    'Acessórios': [['path',{d:'M9 3.5h6l2 3-2 3H9l-2-3z'}],['path',{d:'M12 9.5v11M9.5 12.5h5M9.5 15.5h5M9.5 18.5h5'}]],
    'Outros': [['rect',{x:'4.5',y:'4.5',width:'6',height:'6',rx:'1.5'}],['rect',{x:'13.5',y:'4.5',width:'6',height:'6',rx:'1.5'}],['rect',{x:'4.5',y:'13.5',width:'6',height:'6',rx:'1.5'}],['rect',{x:'13.5',y:'13.5',width:'6',height:'6',rx:'1.5'}]],
  },
};
