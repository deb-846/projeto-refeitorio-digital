// Gerador mínimo de planilhas .xlsx, sem bibliotecas externas.
//
// Um .xlsx é um ZIP com alguns arquivos XML. Aqui o ZIP é montado sem
// compressão (método "stored"), o que o Excel, o LibreOffice e o Google
// Planilhas abrem normalmente.
//
// Uso: gerarXlsx([{ nome: "Aba", linhas: [["Cabeçalho", ...], [valor, ...]] }])
// devolve um Blob pronto para download.
(function () {
  "use strict";

  var TABELA_CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function montarZip(arquivos) {
    var codificador = new TextEncoder();
    var partes = [];
    var central = [];
    var deslocamento = 0;

    arquivos.forEach(function (arq) {
      var nome = codificador.encode(arq.nome);
      var dados = codificador.encode(arq.conteudo);
      var crc = crc32(dados);

      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);          // nomes em UTF-8
      local.setUint16(8, 0, true);               // sem compressão
      local.setUint16(10, 0, true);
      local.setUint16(12, 0x21, true);           // data fixa: 01/01/1980
      local.setUint32(14, crc, true);
      local.setUint32(18, dados.length, true);
      local.setUint32(22, dados.length, true);
      local.setUint16(26, nome.length, true);
      local.setUint16(28, 0, true);
      partes.push(new Uint8Array(local.buffer), nome, dados);

      var cab = new DataView(new ArrayBuffer(46));
      cab.setUint32(0, 0x02014b50, true);
      cab.setUint16(4, 20, true);
      cab.setUint16(6, 20, true);
      cab.setUint16(8, 0x0800, true);
      cab.setUint16(10, 0, true);
      cab.setUint16(12, 0, true);
      cab.setUint16(14, 0x21, true);
      cab.setUint32(16, crc, true);
      cab.setUint32(20, dados.length, true);
      cab.setUint32(24, dados.length, true);
      cab.setUint16(28, nome.length, true);
      cab.setUint32(42, deslocamento, true);
      central.push(new Uint8Array(cab.buffer), nome);

      deslocamento += 30 + nome.length + dados.length;
    });

    var tamanhoCentral = central.reduce(function (s, p) { return s + p.length; }, 0);
    var fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true);
    fim.setUint16(8, arquivos.length, true);
    fim.setUint16(10, arquivos.length, true);
    fim.setUint32(12, tamanhoCentral, true);
    fim.setUint32(16, deslocamento, true);

    return new Blob(partes.concat(central, [new Uint8Array(fim.buffer)]), {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
  }

  function escaparXml(valor) {
    return String(valor)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function nomeColuna(indice) {
    var nome = "";
    indice += 1;
    while (indice > 0) {
      var resto = (indice - 1) % 26;
      nome = String.fromCharCode(65 + resto) + nome;
      indice = Math.floor((indice - 1) / 26);
    }
    return nome;
  }

  function xmlDaAba(linhas) {
    var corpo = linhas.map(function (linha, i) {
      var celulas = linha.map(function (valor, j) {
        var ref = nomeColuna(j) + (i + 1);
        if (valor === null || valor === undefined || valor === "") return "";
        if (typeof valor === "number" && isFinite(valor)) {
          return '<c r="' + ref + '"><v>' + valor + "</v></c>";
        }
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escaparXml(valor) + "</t></is></c>";
      }).join("");
      return '<row r="' + (i + 1) + '">' + celulas + "</row>";
    }).join("");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      "<sheetData>" + corpo + "</sheetData></worksheet>";
  }

  function gerarXlsx(abas) {
    var arquivos = [];
    var tiposAbas = "";
    var abasWorkbook = "";
    var relsWorkbook = "";

    abas.forEach(function (aba, i) {
      var n = i + 1;
      var nome = escaparXml(String(aba.nome).replace(/[\\\/?*\[\]:]/g, " ").slice(0, 31));
      arquivos.push({ nome: "xl/worksheets/sheet" + n + ".xml", conteudo: xmlDaAba(aba.linhas) });
      tiposAbas += '<Override PartName="/xl/worksheets/sheet' + n + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      abasWorkbook += '<sheet name="' + nome + '" sheetId="' + n + '" r:id="rId' + n + '"/>';
      relsWorkbook += '<Relationship Id="rId' + n + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + n + '.xml"/>';
    });

    arquivos.unshift(
      {
        nome: "[Content_Types].xml",
        conteudo: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          tiposAbas + "</Types>"
      },
      {
        nome: "_rels/.rels",
        conteudo: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
          'Target="xl/workbook.xml"/></Relationships>'
      },
      {
        nome: "xl/workbook.xml",
        conteudo: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          "<sheets>" + abasWorkbook + "</sheets></workbook>"
      },
      {
        nome: "xl/_rels/workbook.xml.rels",
        conteudo: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          relsWorkbook + "</Relationships>"
      }
    );

    return montarZip(arquivos);
  }

  window.gerarXlsx = gerarXlsx;
})();
