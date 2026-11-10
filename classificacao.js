/* GERADO por movel/gerar-classificacao.js a partir de OCC_PRODUTO_TYPES e OCC_DEFEITOS (js/src/modules/ocorrencias.js). NÃO editar à mão:
   muda-se a lista na app, corre-se `node movel/gerar-classificacao.js` e depois `node movel/versao.js --escrever`. */
self.DOE_MOVEL_CLASSIF = {
  "produtos": [
    "Vidro",
    "Perfis",
    "Ferro",
    "Chapas",
    "Acessórios",
    "Outros"
  ],
  "defeitos": {
    "Vidro": [
      {
        "key": "QUEBRA_ESPONTANEA_HST",
        "label": "Quebra espontânea (HST)",
        "hint": "partiu sozinho, sem pancada nem esforço"
      },
      {
        "key": "DEFEITO_PRODUCAO",
        "label": "Defeito de produção do vidro",
        "hint": "bolhas, delaminação, manchas, riscos de fábrica"
      },
      {
        "key": "ERRO_ESPECIFICACAO",
        "label": "Erro de especificação ou medida",
        "hint": "composição, dimensão ou furação diferente do pedido"
      },
      {
        "key": "PARTIDO_TRANSPORTE",
        "label": "Partido no transporte/embalagem",
        "hint": "chegou partido ou lascado da viagem ou do parque"
      },
      {
        "key": "OUTRO",
        "label": "Outro",
        "hint": "nenhum dos anteriores — explique nas observações"
      }
    ],
    "Perfis": [
      {
        "key": "EMPENADO",
        "label": "Empenado ou torcido",
        "hint": "não está direito, não assenta"
      },
      {
        "key": "ACABAMENTO",
        "label": "Lacagem ou acabamento defeituoso",
        "hint": "cor, brilho, riscos ou falhas de lacagem"
      },
      {
        "key": "ERRO_MEDIDA",
        "label": "Erro de medida ou maquinação",
        "hint": "corte, furação, entalhe ou esquadria errados"
      },
      {
        "key": "DANIFICADO_TRANSPORTE",
        "label": "Danificado no transporte",
        "hint": "amolgado ou riscado na viagem ou no manuseamento"
      },
      {
        "key": "OUTRO",
        "label": "Outro",
        "hint": "nenhum dos anteriores — explique nas observações"
      }
    ],
    "Ferro": [
      {
        "key": "ERRO_FABRICO",
        "label": "Erro de fabrico ou soldadura",
        "hint": "peça mal executada, soldadura deficiente"
      },
      {
        "key": "ERRO_MEDIDA",
        "label": "Erro de medida ou furação",
        "hint": "dimensão ou furos que não batem com o projeto"
      },
      {
        "key": "PINTURA_CORROSAO",
        "label": "Pintura defeituosa ou corrosão",
        "hint": "galvanização ou pintura má, ferrugem"
      },
      {
        "key": "DANIFICADO_TRANSPORTE",
        "label": "Danificado no transporte",
        "hint": "empenado ou amassado na viagem ou no manuseamento"
      },
      {
        "key": "OUTRO",
        "label": "Outro",
        "hint": "nenhum dos anteriores — explique nas observações"
      }
    ],
    "Chapas": [
      {
        "key": "AMOLGADA_RISCADA",
        "label": "Amolgada ou riscada de fábrica",
        "hint": "já veio marcada do fabricante"
      },
      {
        "key": "ERRO_QUINAGEM",
        "label": "Erro de quinagem ou corte",
        "hint": "dobra ou corte fora do desenho"
      },
      {
        "key": "ACABAMENTO_COR",
        "label": "Cor ou acabamento fora do pedido",
        "hint": "tom, brilho ou material diferente do previsto"
      },
      {
        "key": "DANIFICADA_TRANSPORTE",
        "label": "Danificada no transporte",
        "hint": "amolgada ou riscada na viagem ou no manuseamento"
      },
      {
        "key": "OUTRO",
        "label": "Outro",
        "hint": "nenhum dos anteriores — explique nas observações"
      }
    ],
    "Acessórios": [
      {
        "key": "EM_FALTA",
        "label": "Em falta na entrega",
        "hint": "não veio, ou veio a menos do que o pedido"
      },
      {
        "key": "REFERENCIA_ERRADA",
        "label": "Referência errada ou trocada",
        "hint": "veio outro artigo, ou outro acabamento"
      },
      {
        "key": "DEFEITO_FUNCIONAMENTO",
        "label": "Não funciona como devia",
        "hint": "ferragem emperra, vedante não veda, fecho não trinca"
      },
      {
        "key": "DANIFICADO_TRANSPORTE",
        "label": "Danificado no transporte",
        "hint": "partido ou riscado na viagem ou no manuseamento"
      },
      {
        "key": "OUTRO",
        "label": "Outro",
        "hint": "nenhum dos anteriores — explique nas observações"
      }
    ],
    "Outros": [
      {
        "key": "EM_FALTA",
        "label": "Material em falta",
        "hint": "não chegou, ou chegou a menos"
      },
      {
        "key": "MATERIAL_ERRADO",
        "label": "Material errado",
        "hint": "veio outra coisa em vez do que foi pedido"
      },
      {
        "key": "DANIFICADO",
        "label": "Material danificado",
        "hint": "partido, amolgado ou riscado à chegada"
      },
      {
        "key": "ERRO_PROJETO",
        "label": "Erro de projeto ou especificação",
        "hint": "o que foi pedido é que estava errado"
      },
      {
        "key": "OUTRO",
        "label": "Outro",
        "hint": "nenhum dos anteriores — explique nas observações"
      }
    ]
  }
};
