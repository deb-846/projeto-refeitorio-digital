// Armazenamento local do totem (IndexedDB do navegador do tablet).
//
// Não há servidor nem banco externo: colaboradores e registros ficam gravados
// no próprio aparelho, então o totem funciona sem internet e nunca "dorme".
// A segurança dos dados vem do backup em arquivo (menu Administração > Dados).
(function () {
  "use strict";

  var NOME_BANCO = "totem-refeitorio";
  var VERSAO_BANCO = 1;
  var VERSAO_BACKUP = 1;
  var banco = null;

  function promessa(requisicao) {
    return new Promise(function (resolver, rejeitar) {
      requisicao.onsuccess = function () { resolver(requisicao.result); };
      requisicao.onerror = function () { rejeitar(requisicao.error); };
    });
  }

  function concluir(transacao) {
    return new Promise(function (resolver, rejeitar) {
      transacao.oncomplete = function () { resolver(); };
      transacao.onerror = function () { rejeitar(transacao.error); };
      transacao.onabort = function () { rejeitar(transacao.error || new Error("Gravação cancelada.")); };
    });
  }

  function abrir() {
    if (banco) return Promise.resolve(banco);
    if (!window.indexedDB) {
      return Promise.reject(new Error("Este navegador não permite salvar dados (modo anônimo?)."));
    }
    var req = indexedDB.open(NOME_BANCO, VERSAO_BANCO);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains("colaboradores")) db.createObjectStore("colaboradores", { keyPath: "nome" });
      if (!db.objectStoreNames.contains("registros")) {
        var regs = db.createObjectStore("registros", { keyPath: "id" });
        regs.createIndex("colaborador", "colaborador", { unique: false });
      }
      if (!db.objectStoreNames.contains("config")) db.createObjectStore("config", { keyPath: "chave" });
    };
    return promessa(req).then(function (db) {
      banco = db;
      // Pede ao navegador para não apagar os dados quando faltar espaço.
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      return db;
    });
  }

  function loja(nome, modo) {
    return banco.transaction(nome, modo || "readonly").objectStore(nome);
  }

  function listar(nome) {
    return abrir().then(function () { return promessa(loja(nome).getAll()); });
  }

  function listarColaboradores() { return listar("colaboradores"); }
  function listarRegistros() { return listar("registros"); }

  function salvarColaborador(colab) {
    return abrir().then(function () {
      var t = banco.transaction("colaboradores", "readwrite");
      colab.atualizado_em = new Date().toISOString();
      t.objectStore("colaboradores").put(colab);
      return concluir(t);
    });
  }

  // Grava todas as linhas de um registro numa única transação: ou entram
  // todas, ou nenhuma.
  function adicionarRegistros(linhas) {
    return abrir().then(function () {
      var t = banco.transaction("registros", "readwrite");
      var s = t.objectStore("registros");
      linhas.forEach(function (l) { s.add(l); });
      return concluir(t);
    });
  }

  function lerConfig(chave) {
    return abrir().then(function () { return promessa(loja("config").get(chave)); })
      .then(function (r) { return r ? r.valor : undefined; });
  }

  function gravarConfig(chave, valor) {
    return abrir().then(function () {
      var t = banco.transaction("config", "readwrite");
      t.objectStore("config").put({ chave: chave, valor: valor });
      return concluir(t);
    });
  }

  function exportar() {
    return Promise.all([listarColaboradores(), listarRegistros()]).then(function (r) {
      return {
        tipo: "backup-totem-refeitorio",
        versao: VERSAO_BACKUP,
        gerado_em: new Date().toISOString(),
        colaboradores: r[0],
        registros: r[1]
      };
    });
  }

  function texto(v) { return v === null || v === undefined ? "" : String(v); }

  // Junta um backup (ou a exportação do banco antigo) com o que já existe.
  // Nada é apagado: registros entram só se o id ainda não existir, e um
  // colaborador só é sobrescrito se a versão do arquivo for mais recente.
  function importar(conteudo) {
    if (!conteudo || !Array.isArray(conteudo.colaboradores) || !Array.isArray(conteudo.registros)) {
      return Promise.reject(new Error("Arquivo inválido: não é um backup do totem."));
    }
    return Promise.all([abrir(), listarColaboradores(), listarRegistros()]).then(function (r) {
      var colabAtuais = {};
      r[1].forEach(function (c) { colabAtuais[c.nome] = c; });
      var idsAtuais = {};
      r[2].forEach(function (reg) { idsAtuais[reg.id] = true; });

      var resultado = { colaboradores: 0, registros: 0 };
      var t = banco.transaction(["colaboradores", "registros"], "readwrite");
      var sColab = t.objectStore("colaboradores");
      var sRegs = t.objectStore("registros");

      conteudo.colaboradores.forEach(function (c) {
        var nome = texto(c && c.nome).trim().toUpperCase();
        if (!nome) return;
        var novo = {
          nome: nome,
          empresa: texto(c.empresa),
          matricula: texto(c.matricula),
          senha: texto(c.senha).trim(),
          ativo: c.ativo !== false,
          atualizado_em: texto(c.atualizado_em) || "1970-01-01T00:00:00.000Z"
        };
        var atual = colabAtuais[nome];
        if (!atual || texto(atual.atualizado_em) <= novo.atualizado_em) {
          sColab.put(novo);
          resultado.colaboradores++;
        }
      });

      conteudo.registros.forEach(function (reg) {
        var id = texto(reg && reg.id);
        if (!id || idsAtuais[id]) return;
        idsAtuais[id] = true;
        sRegs.put({
          id: id,
          data: texto(reg.data),
          hora: texto(reg.hora),
          colaborador: texto(reg.colaborador),
          tipo: texto(reg.tipo),
          litros: texto(reg.litros),
          codigo_auditoria: texto(reg.codigo_auditoria)
        });
        resultado.registros++;
      });

      return concluir(t).then(function () { return resultado; });
    });
  }

  window.Dados = {
    abrir: abrir,
    listarColaboradores: listarColaboradores,
    listarRegistros: listarRegistros,
    salvarColaborador: salvarColaborador,
    adicionarRegistros: adicionarRegistros,
    lerConfig: lerConfig,
    gravarConfig: gravarConfig,
    exportar: exportar,
    importar: importar
  };
})();
