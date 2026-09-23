// Totem do Refeitório — versão sem servidor.
//
// Tudo roda no navegador do tablet: as telas, as regras de refeição e os
// dados (gravados pelo dados.js no IndexedDB do aparelho). Depois de aberto
// uma vez, o totem funciona mesmo sem internet.
(function () {
  "use strict";

  // ==========================================
  // CONSTANTES
  // ==========================================
  var TIMEOUT_SEG = 120;            // sessão expira após 2 min sem toque
  var TIMEOUT_ADMIN_SEG = 300;      // painel admin fecha após 5 min sem toque
  var AVISO_TIMEOUT_SEG = 30;       // aviso nos últimos 30 segundos
  var MAX_TENTATIVAS_SENHA = 5;     // bloqueia após 5 erros de senha
  var BLOQUEIO_MIN = 5;             // ...por 5 minutos
  var SEG_TELA_SUCESSO = 4;
  var DIAS_AVISO_BACKUP = 7;

  var ALMOCO_INICIO = 10, ALMOCO_FIM = 14;   // 10h às 14h
  var JANTAR_INICIO = 22, JANTAR_FIM = 2;    // 22h às 02h (cruza a meia-noite)

  var ITENS = [
    { id: "CAFÉ", emoji: "☕" },
    { id: "CHÁ", emoji: "🍵" },
    { id: "MARMITA", emoji: "🍱" },
    { id: "ALMOÇO", emoji: "🍽️" },
    { id: "JANTAR", emoji: "🌙" }
  ];
  var GARRAFAS = ["0.5", "1.0", "1.5", "1.8", "2.0", "2.5", "3.5"];
  var NOVO_CADASTRO = "__novo__";

  // ==========================================
  // ESTADO
  // ==========================================
  var estado = {
    tela: "carregando",
    colaboradores: [],
    registros: [],
    nome: null,
    autenticado: false,
    item: null,
    ultimoAtivo: 0,
    tentativas: {},          // nome -> { erros, bloqueadoAte }
    aviso: null,             // { tipo, texto } exibido uma vez na tela inicial
    sucesso: null,           // { titulo, texto, codigo }
    adminOk: false,
    adminAba: "relatorios",
    relatorio: null          // { inicio, fim, tipo, colaborador }
  };

  var app = document.getElementById("app");
  var temporizadorSucesso = null;

  // ==========================================
  // UTILITÁRIOS
  // ==========================================
  function esc(valor) {
    return String(valor === null || valor === undefined ? "" : valor)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function $(seletor) { return app.querySelector(seletor); }
  function $$(seletor) { return Array.prototype.slice.call(app.querySelectorAll(seletor)); }

  function hashSenha(senha) { return window.sha256(String(senha).trim()); }

  function hexAleatorio(bytes) {
    var arr = new Uint8Array(bytes);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (var i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(arr, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function aviso(tipo, texto) {
    return '<div class="aviso ' + tipo + '">' + texto + "</div>";
  }

  function baixarArquivo(blob, nomeArquivo) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // ==========================================
  // DATA E HORA (fuso de Mato Grosso)
  // ==========================================
  var formatadorMT = null;
  try {
    formatadorMT = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Cuiaba", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  } catch (e) { formatadorMT = null; }

  function agoraMT() {
    var agora = new Date();
    if (formatadorMT) {
      var p = {};
      formatadorMT.formatToParts(agora).forEach(function (x) { p[x.type] = x.value; });
      return {
        ano: +p.year, mes: +p.month, dia: +p.day,
        hora: +p.hour % 24, minuto: +p.minute, segundo: +p.second
      };
    }
    // Sem suporte a fuso: UTC-4 fixo, como no app antigo.
    var d = new Date(agora.getTime() - 4 * 3600 * 1000);
    return {
      ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(),
      hora: d.getUTCHours(), minuto: d.getUTCMinutes(), segundo: d.getUTCSeconds()
    };
  }

  function dois(n) { return ("0" + n).slice(-2); }
  function dataBR(ano, mes, dia) { return dois(dia) + "/" + dois(mes) + "/" + ano; }
  function horaTexto(t) { return dois(t.hora) + ":" + dois(t.minuto) + ":" + dois(t.segundo); }

  function somarDias(ano, mes, dia, n) {
    var d = new Date(Date.UTC(ano, mes - 1, dia + n));
    return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
  }

  // "dd/mm/aaaa" -> "aaaa-mm-dd" (ordenável e comparável com <input type=date>)
  function dataIso(br) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br || "");
    return m ? m[3] + "-" + m[2] + "-" + m[1] : "";
  }
  function isoParaBR(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? m[3] + "/" + m[2] + "/" + m[1] : iso;
  }
  function isoDe(t) { return t.ano + "-" + dois(t.mes) + "-" + dois(t.dia); }

  // ==========================================
  // REGRAS DE REFEIÇÃO
  // ==========================================

  // Datas (dd/mm/aaaa) que o turno atual pode abranger. O jantar atravessa a
  // meia-noite: [noite de, madrugada seguinte].
  function datasDoTurno(tipo, agora) {
    if (tipo !== "JANTAR") return [dataBR(agora.ano, agora.mes, agora.dia)];
    var inicio = agora.hora < JANTAR_FIM ? somarDias(agora.ano, agora.mes, agora.dia, -1) : agora;
    var seguinte = somarDias(inicio.ano, inicio.mes, inicio.dia, 1);
    return [dataBR(inicio.ano, inicio.mes, inicio.dia), dataBR(seguinte.ano, seguinte.mes, seguinte.dia)];
  }

  // Diz se um registro pertence ao turno. Para o jantar a data não basta:
  // noites vizinhas compartilham uma data, então a hora decide.
  function registroNoTurno(reg, tipo, datas) {
    if (datas.indexOf(reg.data) < 0) return false;
    if (tipo !== "JANTAR") return true;
    var hora = reg.hora || "";
    if (!hora) return reg.data === datas[0];
    if (reg.data === datas[0]) return hora >= dois(JANTAR_INICIO) + ":00:00";
    return hora < dois(JANTAR_FIM) + ":00:00";
  }

  function verificarRegrasRefeicao(nome, tipo) {
    if (tipo !== "ALMOÇO" && tipo !== "JANTAR") return { ok: true, motivo: "" };
    var agora = agoraMT();
    if (tipo === "ALMOÇO" && !(agora.hora >= ALMOCO_INICIO && agora.hora < ALMOCO_FIM)) {
      return { ok: false, motivo: "Fora do horário (" + ALMOCO_INICIO + "h às " + ALMOCO_FIM + "h)" };
    }
    if (tipo === "JANTAR" && !(agora.hora >= JANTAR_INICIO || agora.hora < JANTAR_FIM)) {
      return { ok: false, motivo: "Fora do horário (" + JANTAR_INICIO + "h às " + dois(JANTAR_FIM) + "h)" };
    }
    var datas = datasDoTurno(tipo, agora);
    var jaConsumiu = estado.registros.some(function (r) {
      return r.colaborador === nome && r.tipo === tipo && registroNoTurno(r, tipo, datas);
    });
    if (jaConsumiu) return { ok: false, motivo: "Já consumido neste turno" };
    return { ok: true, motivo: "" };
  }

  // ==========================================
  // SESSÃO / INATIVIDADE
  // ==========================================
  function marcarAtividade() {
    estado.ultimoAtivo = Date.now();
  }

  function segundosRestantes() {
    return TIMEOUT_SEG - (Date.now() - estado.ultimoAtivo) / 1000;
  }

  function encerrarSessao(mensagem) {
    estado.nome = null;
    estado.autenticado = false;
    estado.item = null;
    estado.aviso = mensagem || null;
    irPara("identificar");
  }

  function tique() {
    var t = agoraMT();
    document.getElementById("relogio").textContent =
      "🕒 " + dois(t.hora) + ":" + dois(t.minuto) + " (MT)";

    if (estado.adminOk && Date.now() - estado.ultimoAtivo > TIMEOUT_ADMIN_SEG * 1000) {
      sairAdmin({ tipo: "alerta", texto: "⏱️ Painel administrativo fechado por inatividade." });
      return;
    }
    if (!estado.autenticado) return;
    var resta = segundosRestantes();
    if (resta <= 0) {
      encerrarSessao({ tipo: "alerta", texto: "⏱️ Sessão encerrada por inatividade. Identifique-se novamente." });
      return;
    }
    var caixa = document.getElementById("aviso-timeout");
    if (caixa) {
      caixa.innerHTML = resta <= AVISO_TIMEOUT_SEG
        ? aviso("alerta", "⚠️ Sessão encerrará em <b>" + Math.ceil(resta) + " segundos</b> por inatividade.")
        : "";
    }
  }

  // ==========================================
  // NAVEGAÇÃO
  // ==========================================
  function irPara(tela) {
    estado.tela = tela;
    clearTimeout(temporizadorSucesso);
    app.classList.toggle("largo", tela === "admin");
    var renderizar = TELAS[tela];
    app.innerHTML = renderizar();
    if (TELAS_EVENTOS[tela]) TELAS_EVENTOS[tela]();
    window.scrollTo(0, 0);
  }

  var TELAS = {};
  var TELAS_EVENTOS = {};

  function cabecalhoTotem() {
    return "<h1>🍽️ Registro Digital — Refeitório</h1>" +
      '<p class="subtitulo">Almoço ' + ALMOCO_INICIO + "h–" + ALMOCO_FIM + "h · Jantar " +
      JANTAR_INICIO + "h–" + dois(JANTAR_FIM) + "h</p>" +
      '<div id="aviso-timeout"></div>';
  }

  function colaboradoresAtivos() {
    return estado.colaboradores
      .filter(function (c) { return c.ativo !== false; })
      .sort(function (a, b) { return a.nome.localeCompare(b.nome, "pt-BR"); });
  }

  // --- TELA: IDENTIFICAÇÃO ---
  TELAS.identificar = function () {
    var ativos = colaboradoresAtivos();
    var html = cabecalhoTotem();
    if (estado.aviso) {
      html += aviso(estado.aviso.tipo, esc(estado.aviso.texto));
      estado.aviso = null;
    }
    if (!ativos.length) {
      html += aviso("info", "Nenhum colaborador cadastrado neste aparelho ainda. " +
        "Use <b>NOVO CADASTRO</b> ou importe os dados em <b>Administração › Dados</b>.");
    }
    html += '<div class="cartao"><label for="sel-nome">IDENTIFIQUE-SE:</label>' +
      '<select id="sel-nome"><option value="" selected disabled>Toque aqui e selecione seu nome…</option>' +
      '<option value="' + NOVO_CADASTRO + '">➕ NOVO CADASTRO…</option>' +
      ativos.map(function (c) { return '<option value="' + esc(c.nome) + '">' + esc(c.nome) + "</option>"; }).join("") +
      "</select></div>";
    return html;
  };
  TELAS_EVENTOS.identificar = function () {
    $("#sel-nome").addEventListener("change", function (e) {
      var valor = e.target.value;
      if (valor === NOVO_CADASTRO) { irPara("cadastro"); return; }
      estado.nome = valor;
      irPara("senha");
    });
  };

  // --- TELA: NOVO CADASTRO ---
  TELAS.cadastro = function () {
    return cabecalhoTotem() +
      aviso("info", "📝 Preencha os dados abaixo e crie sua senha de acesso.") +
      '<form id="form-cadastro" class="cartao" autocomplete="off">' +
      '<label for="c-nome">Nome completo (nome e sobrenome):</label><input type="text" id="c-nome" autocapitalize="characters">' +
      '<label for="c-empresa">Empresa:</label><input type="text" id="c-empresa" autocapitalize="characters">' +
      '<label for="c-senha">Crie uma senha de acesso (ex.: 1234):</label>' +
      '<input type="password" id="c-senha" inputmode="numeric">' +
      '<p class="dica">Dica: use apenas números para facilitar a digitação no tablet.</p>' +
      '<div id="c-erro"></div>' +
      '<div class="linha"><button type="button" id="c-voltar">↩️ VOLTAR</button>' +
      '<button type="submit" class="primario">💾 SALVAR CADASTRO</button></div></form>';
  };
  TELAS_EVENTOS.cadastro = function () {
    $("#c-voltar").addEventListener("click", function () { irPara("identificar"); });
    $("#form-cadastro").addEventListener("submit", function (e) {
      e.preventDefault();
      var nome = $("#c-nome").value.trim().replace(/\s+/g, " ").toUpperCase();
      var empresa = $("#c-empresa").value.trim().toUpperCase();
      var senha = $("#c-senha").value.trim();
      var erro = $("#c-erro");
      if (nome.split(" ").length < 2) { erro.innerHTML = aviso("erro", "⚠️ Digite o nome completo (nome e sobrenome)."); return; }
      if (!empresa || !senha) { erro.innerHTML = aviso("erro", "⚠️ Todos os campos são obrigatórios."); return; }
      if (estado.colaboradores.some(function (c) { return c.nome === nome; })) {
        erro.innerHTML = aviso("alerta", "⚠️ Este nome já está cadastrado."); return;
      }
      var novo = { nome: nome, empresa: empresa, matricula: "", senha: hashSenha(senha), ativo: true };
      Dados.salvarColaborador(novo).then(function () {
        estado.colaboradores.push(novo);
        mostrarSucesso({ titulo: "Cadastro salvo!", texto: "Agora selecione seu nome para fazer o registro." });
      }).catch(function (err) {
        erro.innerHTML = aviso("erro", "❌ Não foi possível salvar: " + esc(err.message));
      });
    });
  };

  // --- TELA: SENHA ---
  function controleTentativas(nome) {
    if (!estado.tentativas[nome]) estado.tentativas[nome] = { erros: 0, bloqueadoAte: 0 };
    var t = estado.tentativas[nome];
    if (t.bloqueadoAte && Date.now() >= t.bloqueadoAte) { t.erros = 0; t.bloqueadoAte = 0; }
    return t;
  }

  TELAS.senha = function () {
    var t = controleTentativas(estado.nome);
    var html = cabecalhoTotem();
    if (t.bloqueadoAte) {
      return html + aviso("erro", "🔒 Acesso bloqueado após " + MAX_TENTATIVAS_SENHA +
        " tentativas incorretas. Tente de novo em alguns minutos ou procure o responsável.") +
        '<button class="largo" id="s-voltar">↩️ VOLTAR</button>';
    }
    return html + '<form id="form-senha" class="cartao" autocomplete="off">' +
      aviso("alerta", "Olá, <b>" + esc(estado.nome) + "</b>! Digite sua senha para liberar o totem.") +
      (t.erros ? '<p class="dica">⚠️ ' + t.erros + "/" + MAX_TENTATIVAS_SENHA + " tentativas usadas.</p>" : "") +
      '<label for="s-senha">Senha:</label>' +
      '<input type="password" id="s-senha" inputmode="numeric" placeholder="Somente números (ex.: 1234)">' +
      '<div id="s-erro"></div>' +
      '<div class="linha"><button type="button" id="s-voltar">↩️ VOLTAR</button>' +
      '<button type="submit" class="primario">CONFIRMAR IDENTIDADE</button></div></form>';
  };
  TELAS_EVENTOS.senha = function () {
    $("#s-voltar").addEventListener("click", function () { encerrarSessao(); });
    var form = $("#form-senha");
    if (!form) return;
    $("#s-senha").focus();
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var colab = estado.colaboradores.find(function (c) { return c.nome === estado.nome; });
      var t = controleTentativas(estado.nome);
      var digitada = $("#s-senha").value;
      if (colab && colab.senha && digitada.trim() && colab.senha === hashSenha(digitada)) {
        t.erros = 0;
        estado.autenticado = true;
        estado.ultimoAtivo = Date.now();
        irPara("menu");
        return;
      }
      t.erros++;
      if (t.erros >= MAX_TENTATIVAS_SENHA) {
        t.bloqueadoAte = Date.now() + BLOQUEIO_MIN * 60 * 1000;
        irPara("senha");
        return;
      }
      $("#s-erro").innerHTML = aviso("erro", "❌ Senha incorreta! Restam " +
        (MAX_TENTATIVAS_SENHA - t.erros) + " tentativa(s).");
      $("#s-senha").value = "";
      $("#s-senha").focus();
    });
  };

  // --- TELA: ESCOLHA DO ITEM ---
  TELAS.menu = function () {
    var botoes = ITENS.map(function (item) {
      var regra = verificarRegrasRefeicao(estado.nome, item.id);
      return '<button class="item" data-item="' + esc(item.id) + '"' + (regra.ok ? "" : " disabled") + ">" +
        '<span class="emoji">' + item.emoji + "</span>" + esc(item.id) +
        (regra.ok ? "" : '<span class="motivo">' + esc(regra.motivo) + "</span>") + "</button>";
    }).join("");
    return cabecalhoTotem() +
      '<div class="linha fim"><h2 style="margin:0">Bem-vindo(a), ' + esc(estado.nome) + "!</h2>" +
      '<button class="pequeno" id="m-sair">🚪 Sair</button></div>' +
      "<p><b>O que deseja registrar?</b></p>" +
      '<div class="grade-itens">' + botoes + "</div>";
  };
  TELAS_EVENTOS.menu = function () {
    $("#m-sair").addEventListener("click", function () { encerrarSessao(); });
    $$("[data-item]").forEach(function (b) {
      b.addEventListener("click", function () {
        estado.item = b.getAttribute("data-item");
        irPara("quantidade");
      });
    });
  };

  // --- TELA: QUANTIDADES E CONFIRMAÇÃO ---
  function contador(id, rotulo, minimo, inicial) {
    return '<div class="contador"><div class="rotulo">' + esc(rotulo) + "</div>" +
      '<div class="controles"><button type="button" data-menos="' + id + '" aria-label="Diminuir">−</button>' +
      '<span class="valor" id="' + id + '" data-min="' + minimo + '">' + inicial + "</span>" +
      '<button type="button" data-mais="' + id + '" aria-label="Aumentar">+</button></div></div>';
  }

  TELAS.quantidade = function () {
    var item = estado.item;
    var corpo = "";
    if (item === "CAFÉ" || item === "CHÁ") {
      corpo = "<p><b>Quantas garrafas de cada tamanho você está levando?</b></p>" +
        '<div class="grade-garrafas">' +
        GARRAFAS.map(function (g, i) { return contador("g" + i, "Garrafa " + g + " L", 0, 0); }).join("") +
        "</div><h3>Outro tamanho de garrafa?</h3>" +
        '<div class="linha"><div><label for="q-outro-litros">Tamanho (litros):</label>' +
        '<input type="number" id="q-outro-litros" min="0" max="10" step="0.1" inputmode="decimal" value="0"></div>' +
        "<div>" + contador("g-outro", "Quantidade dessa garrafa", 0, 0) + "</div></div>";
    } else if (item === "MARMITA") {
      corpo = '<div style="max-width:260px">' + contador("q-marmita", "Quantidade de marmitas", 1, 1) + "</div>";
    } else {
      corpo = aviso("info", "Regra corporativa: limite de 1 unidade por pessoa/turno.");
    }
    return cabecalhoTotem() + aviso("alerta", "<b>Registrando: " + esc(item) + "</b>") +
      '<div class="cartao">' + corpo +
      '<label class="declaracao"><input type="checkbox" id="q-assinatura">' +
      "✍️ Declaro e confirmo a retirada dos itens preenchidos acima.</label>" +
      '<div id="q-erro"></div>' +
      '<div class="linha"><button id="q-cancelar">❌ CANCELAR E VOLTAR</button>' +
      '<button class="primario" id="q-confirmar">✅ CONFIRMAR REGISTRO</button></div></div>';
  };
  TELAS_EVENTOS.quantidade = function () {
    function ajustar(id, delta) {
      var el = document.getElementById(id);
      var min = +el.getAttribute("data-min");
      el.textContent = Math.max(min, Math.min(10, +el.textContent + delta));
    }
    $$("[data-mais]").forEach(function (b) {
      b.addEventListener("click", function () { ajustar(b.getAttribute("data-mais"), 1); });
    });
    $$("[data-menos]").forEach(function (b) {
      b.addEventListener("click", function () { ajustar(b.getAttribute("data-menos"), -1); });
    });
    $("#q-assinatura").addEventListener("change", function () { $("#q-erro").innerHTML = ""; });
    $("#q-cancelar").addEventListener("click", function () { estado.item = null; irPara("menu"); });
    $("#q-confirmar").addEventListener("click", confirmarRegistro);
  };

  function valorContador(id) {
    var el = document.getElementById(id);
    return el ? +el.textContent : 0;
  }

  function confirmarRegistro() {
    var item = estado.item;
    var erro = $("#q-erro");
    var lista = [];
    var i, n;
    if (item === "CAFÉ" || item === "CHÁ") {
      GARRAFAS.forEach(function (g, idx) {
        for (n = valorContador("g" + idx); n > 0; n--) lista.push(g + " L");
      });
      var litros = parseFloat(String($("#q-outro-litros").value).replace(",", "."));
      var qtdOutro = valorContador("g-outro");
      if (qtdOutro > 0 && !(litros > 0 && litros <= 10)) {
        erro.innerHTML = aviso("erro", "⚠️ Informe o tamanho (em litros) da outra garrafa.");
        return;
      }
      for (i = 0; i < qtdOutro; i++) lista.push(litros + " L");
    } else if (item === "MARMITA") {
      for (n = valorContador("q-marmita"); n > 0; n--) lista.push("1 UN");
    } else {
      lista.push("1 UN");
    }

    if (!lista.length) { erro.innerHTML = aviso("erro", "⚠️ Adicione a quantidade antes de confirmar."); return; }
    if (!$("#q-assinatura").checked) {
      erro.innerHTML = aviso("erro", "⚠️ Marque a caixinha de declaração antes de confirmar."); return;
    }
    // Rechecagem: o turno pode ter virado enquanto a tela estava aberta.
    var regra = verificarRegrasRefeicao(estado.nome, item);
    if (!regra.ok) { erro.innerHTML = aviso("erro", "⚠️ " + esc(regra.motivo) + "."); return; }

    $("#q-confirmar").disabled = true;
    var codigo = hexAleatorio(4).toUpperCase();
    var agora = agoraMT();
    var linhas = lista.map(function (litros) {
      return {
        id: hexAleatorio(16),
        data: dataBR(agora.ano, agora.mes, agora.dia),
        hora: horaTexto(agora),
        colaborador: estado.nome,
        tipo: item,
        litros: litros,
        codigo_auditoria: codigo
      };
    });

    Dados.adicionarRegistros(linhas).then(function () {
      Array.prototype.push.apply(estado.registros, linhas);
      estado.nome = null;
      estado.autenticado = false;
      estado.item = null;
      mostrarSucesso({
        titulo: "Registro concluído com sucesso!",
        texto: "O totem está pronto para o próximo colaborador.",
        codigo: codigo
      });
    }).catch(function (err) {
      $("#q-confirmar").disabled = false;
      erro.innerHTML = aviso("erro", "❌ Não foi possível gravar o registro: " + esc(err.message));
    });
  }

  // --- TELA: SUCESSO ---
  function mostrarSucesso(dados) {
    estado.sucesso = dados;
    irPara("sucesso");
    temporizadorSucesso = setTimeout(function () { irPara("identificar"); }, SEG_TELA_SUCESSO * 1000);
  }
  TELAS.sucesso = function () {
    var s = estado.sucesso || {};
    return '<div class="cartao sucesso-grande"><div class="emoji">✅</div>' +
      "<h1>" + esc(s.titulo) + "</h1><p>" + esc(s.texto) + "</p>" +
      (s.codigo ? '<p>Código de auditoria: <span class="codigo">' + esc(s.codigo) + "</span></p>" : "") +
      '<button class="primario" id="ok-sucesso">OK</button></div>';
  };
  TELAS_EVENTOS.sucesso = function () {
    $("#ok-sucesso").addEventListener("click", function () { irPara("identificar"); });
  };

  // ==========================================
  // ADMINISTRAÇÃO
  // ==========================================
  TELAS.adminLogin = function () {
    return "<h1>🔐 Administração</h1>" +
      '<form id="form-admin" class="cartao" autocomplete="off">' +
      (estado.senhaAdminHash
        ? '<label for="a-senha">Senha de administrador:</label><input type="password" id="a-senha">'
        : aviso("info", "Primeiro acesso: crie a senha de administrador deste totem. " +
            "Guarde-a em local seguro: ela protege relatórios, colaboradores e backups.") +
          '<label for="a-senha">Nova senha (mínimo 6 caracteres):</label><input type="password" id="a-senha">' +
          '<label for="a-senha2">Repita a senha:</label><input type="password" id="a-senha2">') +
      '<div id="a-erro"></div>' +
      '<div class="linha"><button type="button" id="a-voltar">↩️ Voltar ao totem</button>' +
      '<button type="submit" class="primario">ENTRAR</button></div></form>';
  };
  TELAS_EVENTOS.adminLogin = function () {
    $("#a-voltar").addEventListener("click", function () { sairAdmin(); });
    $("#a-senha").focus();
    $("#form-admin").addEventListener("submit", function (e) {
      e.preventDefault();
      var senha = $("#a-senha").value;
      var erro = $("#a-erro");
      if (!estado.senhaAdminHash) {
        if (senha.trim().length < 6) { erro.innerHTML = aviso("erro", "A senha precisa ter pelo menos 6 caracteres."); return; }
        if (senha !== $("#a-senha2").value) { erro.innerHTML = aviso("erro", "As senhas não conferem."); return; }
        var hash = hashSenha(senha);
        Dados.gravarConfig("senhaAdmin", hash).then(function () {
          estado.senhaAdminHash = hash;
          entrarAdmin();
        });
        return;
      }
      if (hashSenha(senha) === estado.senhaAdminHash) entrarAdmin();
      else { erro.innerHTML = aviso("erro", "❌ Senha incorreta."); $("#a-senha").value = ""; }
    });
  };

  function entrarAdmin() {
    estado.adminOk = true;
    estado.ultimoAtivo = Date.now();
    estado.autenticado = false;
    irPara("admin");
  }

  function sairAdmin(mensagem) {
    estado.adminOk = false;
    if (/[?&]admin=1/.test(location.search)) history.replaceState(null, "", location.pathname);
    encerrarSessao(mensagem && mensagem.texto ? mensagem : null);
  }

  function abrirAdmin() {
    estado.nome = null;
    estado.autenticado = false;
    irPara(estado.adminOk ? "admin" : "adminLogin");
  }

  TELAS.admin = function () {
    var abas = [
      ["relatorios", "📈 Registros e Relatórios"],
      ["colaboradores", "👥 Colaboradores"],
      ["dados", "💾 Dados e Backup"]
    ];
    var html = '<div class="linha fim"><h1>📊 Portal Administrativo</h1>' +
      '<button class="pequeno" id="adm-sair">🚪 Sair</button></div>';
    var diasBackup = diasDesdeBackup();
    if (estado.registros.length && (diasBackup === null || diasBackup >= DIAS_AVISO_BACKUP)) {
      html += aviso("alerta", "💾 " + (diasBackup === null ? "Nenhum backup feito ainda." :
        "Último backup há " + diasBackup + " dias.") +
        " Os dados ficam só neste aparelho: baixe um backup em <b>Dados e Backup</b>.");
    }
    html += '<div class="abas">' + abas.map(function (a) {
      return '<button data-aba="' + a[0] + '" class="' + (estado.adminAba === a[0] ? "ativa" : "") + '">' + a[1] + "</button>";
    }).join("") + "</div>";
    html += '<div id="conteudo-aba">' + ABAS[estado.adminAba]() + "</div>";
    return html;
  };
  TELAS_EVENTOS.admin = function () {
    $("#adm-sair").addEventListener("click", function () { sairAdmin(); });
    $$("[data-aba]").forEach(function (b) {
      b.addEventListener("click", function () { estado.adminAba = b.getAttribute("data-aba"); irPara("admin"); });
    });
    ABAS_EVENTOS[estado.adminAba]();
  };

  var ABAS = {};
  var ABAS_EVENTOS = {};

  function diasDesdeBackup() {
    if (!estado.ultimoBackup) return null;
    return Math.floor((Date.now() - new Date(estado.ultimoBackup).getTime()) / 86400000);
  }

  // --- ABA: RELATÓRIOS ---
  function periodoPadrao() {
    var hoje = agoraMT();
    return { inicio: isoDe(somarDias(hoje.ano, hoje.mes, hoje.dia, -30)), fim: isoDe(hoje), tipo: "", colaborador: "" };
  }

  function contarPor(lista, campo) {
    var mapa = {};
    lista.forEach(function (r) { mapa[r[campo]] = (mapa[r[campo]] || 0) + 1; });
    return Object.keys(mapa).map(function (k) { return [k, mapa[k]]; })
      .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"); });
  }

  function graficoBarras(pares) {
    var max = pares.reduce(function (m, p) { return Math.max(m, p[1]); }, 0) || 1;
    return '<div class="barras">' + pares.map(function (p) {
      return '<div class="barra-linha"><span class="nome" title="' + esc(p[0]) + '">' + esc(p[0]) + "</span>" +
        '<span class="trilho"><span class="preenchido" style="display:block;width:' + (p[1] / max * 100) + '%"></span></span>' +
        '<span class="num">' + p[1] + "</span></div>";
    }).join("") + "</div>";
  }

  function registrosDoPeriodo(rel) {
    return estado.registros.filter(function (r) {
      var d = dataIso(r.data);
      return d && d >= rel.inicio && d <= rel.fim;
    }).sort(function (a, b) {
      var da = dataIso(a.data) + a.hora, db = dataIso(b.data) + b.hora;
      return da < db ? 1 : da > db ? -1 : 0;
    });
  }

  function opcoes(valores, selecionado) {
    return '<option value="">Todos</option>' + valores.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === selecionado ? " selected" : "") + ">" + esc(v) + "</option>";
    }).join("");
  }

  ABAS.relatorios = function () {
    var rel = estado.relatorio || (estado.relatorio = periodoPadrao());
    var html = '<div class="linha"><div><label for="r-inicio">Data início:</label>' +
      '<input type="date" id="r-inicio" value="' + rel.inicio + '"></div>' +
      '<div><label for="r-fim">Data fim:</label><input type="date" id="r-fim" value="' + rel.fim + '"></div></div>';

    var doPeriodo = registrosDoPeriodo(rel);
    if (!doPeriodo.length) return html + aviso("info", "Nenhum registro encontrado para este período.");

    var porTipo = contarPor(doPeriodo, "tipo");
    var porColab = contarPor(doPeriodo, "colaborador");
    html += "<h2>📈 Resumo do período</h2>" +
      '<div class="metricas">' +
      '<div class="metrica"><div class="rotulo">Total de registros</div><div class="numero">' + doPeriodo.length + "</div></div>" +
      '<div class="metrica"><div class="rotulo">Colaboradores</div><div class="numero">' + porColab.length + "</div></div>" +
      '<div class="metrica"><div class="rotulo">Tipos distintos</div><div class="numero">' + porTipo.length + "</div></div>" +
      "</div>" +
      '<div class="linha" style="align-items:flex-start">' +
      '<div><h3>Registros por tipo</h3>' + graficoBarras(porTipo) + "</div>" +
      "<div><h3>Top 10 colaboradores</h3>" + graficoBarras(porColab.slice(0, 10)) + "</div></div>";

    var filtrados = doPeriodo.filter(function (r) {
      return (!rel.tipo || r.tipo === rel.tipo) && (!rel.colaborador || r.colaborador === rel.colaborador);
    });
    html += "<h2>🔎 Detalhes</h2>" +
      '<div class="linha"><div><label for="r-tipo">Tipo:</label><select id="r-tipo">' +
      opcoes(porTipo.map(function (p) { return p[0]; }).sort(), rel.tipo) + "</select></div>" +
      '<div><label for="r-colab">Colaborador:</label><select id="r-colab">' +
      opcoes(porColab.map(function (p) { return p[0]; }).sort(), rel.colaborador) + "</select></div></div>" +
      "<p>Exibindo <b>" + filtrados.length + "</b> de " + doPeriodo.length + " registros.</p>" +
      '<div class="tabela-rolagem"><table><thead><tr><th>Data</th><th>Hora</th><th>Colaborador</th>' +
      "<th>Tipo</th><th>Litros</th><th>Código</th></tr></thead><tbody>" +
      filtrados.map(function (r) {
        return "<tr><td>" + esc(r.data) + "</td><td>" + esc(r.hora) + "</td><td>" + esc(r.colaborador) +
          "</td><td>" + esc(r.tipo) + "</td><td>" + esc(r.litros) + "</td><td>" + esc(r.codigo_auditoria) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p><button class="primario largo" id="r-excel">📥 BAIXAR EXCEL (Resumo + Detalhes)</button></p>';
    return html;
  };
  ABAS_EVENTOS.relatorios = function () {
    var rel = estado.relatorio;
    function atualizar() { irPara("admin"); }
    $("#r-inicio").addEventListener("change", function (e) { rel.inicio = e.target.value || rel.inicio; atualizar(); });
    $("#r-fim").addEventListener("change", function (e) { rel.fim = e.target.value || rel.fim; atualizar(); });
    var tipo = $("#r-tipo");
    if (tipo) tipo.addEventListener("change", function (e) { rel.tipo = e.target.value; atualizar(); });
    var colab = $("#r-colab");
    if (colab) colab.addEventListener("change", function (e) { rel.colaborador = e.target.value; atualizar(); });
    var excel = $("#r-excel");
    if (excel) excel.addEventListener("click", function () { baixarExcel(rel); });
  };

  function baixarExcel(rel) {
    var doPeriodo = registrosDoPeriodo(rel).slice().reverse();
    var blob = window.gerarXlsx([
      { nome: "Resumo por Tipo", linhas: [["tipo", "Quantidade"]].concat(contarPor(doPeriodo, "tipo")) },
      { nome: "Resumo por Colaborador", linhas: [["colaborador", "Quantidade"]].concat(contarPor(doPeriodo, "colaborador")) },
      {
        nome: "Detalhes",
        linhas: [["data", "hora", "colaborador", "tipo", "litros", "codigo_auditoria"]].concat(
          doPeriodo.map(function (r) { return [r.data, r.hora, r.colaborador, r.tipo, r.litros, r.codigo_auditoria]; })
        )
      }
    ]);
    var nome = "Medicao_" + isoParaBR(rel.inicio).replace(/\//g, "_") + "_a_" +
      isoParaBR(rel.fim).replace(/\//g, "_") + ".xlsx";
    baixarArquivo(blob, nome);
  }

  // --- ABA: COLABORADORES ---
  ABAS.colaboradores = function () {
    var todos = estado.colaboradores.slice().sort(function (a, b) { return a.nome.localeCompare(b.nome, "pt-BR"); });
    var opcoesNomes = '<option value="">Selecione…</option>' + todos.map(function (c) {
      return '<option value="' + esc(c.nome) + '">' + esc(c.nome) + "</option>";
    }).join("");
    return "<h2>👥 Colaboradores cadastrados (" + todos.length + ")</h2>" +
      (todos.length
        ? '<div class="tabela-rolagem"><table><thead><tr><th>Nome</th><th>Empresa</th><th>Situação</th></tr></thead><tbody>' +
          todos.map(function (c) {
            return "<tr><td>" + esc(c.nome) + "</td><td>" + esc(c.empresa) + "</td><td>" +
              (c.ativo !== false ? "✅ Ativo" : "🚫 Inativo") + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : aviso("info", "Nenhum colaborador cadastrado.")) +
      '<div class="cartao" style="margin-top:16px"><h3>🔑 Resetar senha</h3>' +
      '<div class="linha"><div><label for="rs-nome">Colaborador:</label><select id="rs-nome">' + opcoesNomes + "</select></div>" +
      '<div><label for="rs-senha">Nova senha:</label><input type="password" id="rs-senha" inputmode="numeric"></div></div>' +
      '<p><button class="largo" id="rs-ok">🔄 RESETAR SENHA</button></p><div id="rs-msg"></div></div>' +
      '<div class="cartao"><h3>🚫 Ativar / desativar</h3>' +
      '<div class="linha"><div><label for="at-nome">Colaborador:</label><select id="at-nome">' + opcoesNomes + "</select></div>" +
      '<div><label for="at-acao">Ação:</label><select id="at-acao"><option value="1">Ativar</option>' +
      '<option value="0">Desativar</option></select></div></div>' +
      '<p><button class="largo" id="at-ok">✅ APLICAR ALTERAÇÃO</button></p><div id="at-msg"></div></div>';
  };
  ABAS_EVENTOS.colaboradores = function () {
    function achar(nome) { return estado.colaboradores.find(function (c) { return c.nome === nome; }); }
    $("#rs-ok").addEventListener("click", function () {
      var colab = achar($("#rs-nome").value);
      var senha = $("#rs-senha").value.trim();
      var msg = $("#rs-msg");
      if (!colab || !senha) { msg.innerHTML = aviso("erro", "Selecione o colaborador e digite a nova senha."); return; }
      colab.senha = hashSenha(senha);
      delete estado.tentativas[colab.nome];
      Dados.salvarColaborador(colab).then(function () {
        msg.innerHTML = aviso("sucesso", "✅ Senha de <b>" + esc(colab.nome) + "</b> resetada.");
        $("#rs-senha").value = "";
      }).catch(function (err) { msg.innerHTML = aviso("erro", "Erro: " + esc(err.message)); });
    });
    $("#at-ok").addEventListener("click", function () {
      var colab = achar($("#at-nome").value);
      var msg = $("#at-msg");
      if (!colab) { msg.innerHTML = aviso("erro", "Selecione um colaborador."); return; }
      colab.ativo = $("#at-acao").value === "1";
      Dados.salvarColaborador(colab).then(function () { irPara("admin"); })
        .catch(function (err) { msg.innerHTML = aviso("erro", "Erro: " + esc(err.message)); });
    });
  };

  // --- ABA: DADOS E BACKUP ---
  ABAS.dados = function () {
    var dias = diasDesdeBackup();
    return '<div class="metricas">' +
      '<div class="metrica"><div class="rotulo">Colaboradores</div><div class="numero">' + estado.colaboradores.length + "</div></div>" +
      '<div class="metrica"><div class="rotulo">Registros</div><div class="numero">' + estado.registros.length + "</div></div>" +
      '<div class="metrica"><div class="rotulo">Último backup</div><div class="numero" style="font-size:1.1rem">' +
      (estado.ultimoBackup ? esc(new Date(estado.ultimoBackup).toLocaleString("pt-BR")) + "<br>(" + dias + " dia(s))" : "nunca") +
      "</div></div></div>" +
      '<p class="dica" id="d-persist"></p>' +
      '<div class="cartao"><h3>💾 Baixar backup</h3>' +
      "<p>Os dados ficam gravados <b>somente neste aparelho</b>. Baixe um backup pelo menos uma vez por semana " +
      "e guarde o arquivo no computador, e-mail ou OneDrive. Com ele você recupera tudo se o tablet quebrar " +
      "ou for trocado.</p>" +
      '<button class="primario largo" id="d-backup">💾 BAIXAR BACKUP (.json)</button></div>' +
      '<div class="cartao"><h3>📂 Importar dados</h3>' +
      "<p>Use para restaurar um backup, instalar o totem num tablet novo ou trazer os dados do sistema antigo. " +
      "A importação <b>só acrescenta</b>: nada que já está aqui é apagado, e registros repetidos são ignorados.</p>" +
      '<input type="file" id="d-arquivo" accept=".json,application/json">' +
      '<p><button class="largo" id="d-importar">📂 IMPORTAR ARQUIVO</button></p><div id="d-msg"></div></div>';
  };
  ABAS_EVENTOS.dados = function () {
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (ok) {
        var el = document.getElementById("d-persist");
        if (el) el.textContent = ok
          ? "🔒 Armazenamento protegido: o navegador não apagará estes dados automaticamente."
          : "⚠️ O navegador ainda não marcou os dados como protegidos. Instale o totem na tela inicial " +
            "(menu do navegador › Adicionar à tela inicial) para reforçar a proteção.";
      });
    }
    $("#d-backup").addEventListener("click", function () {
      Dados.exportar().then(function (conteudo) {
        var t = agoraMT();
        var nome = "backup_totem_" + t.ano + "-" + dois(t.mes) + "-" + dois(t.dia) + "_" + dois(t.hora) + dois(t.minuto) + ".json";
        baixarArquivo(new Blob([JSON.stringify(conteudo, null, 2)], { type: "application/json" }), nome);
        estado.ultimoBackup = conteudo.gerado_em;
        return Dados.gravarConfig("ultimoBackup", conteudo.gerado_em);
      }).then(function () { irPara("admin"); });
    });
    $("#d-importar").addEventListener("click", function () {
      var arquivo = $("#d-arquivo").files[0];
      var msg = $("#d-msg");
      if (!arquivo) { msg.innerHTML = aviso("erro", "Escolha um arquivo .json primeiro."); return; }
      arquivo.text().then(function (texto) {
        var conteudo;
        try { conteudo = JSON.parse(texto); } catch (e) { throw new Error("O arquivo não é um JSON válido."); }
        return Dados.importar(conteudo);
      }).then(function (res) {
        return carregarDados().then(function () {
          msg.innerHTML = aviso("sucesso", "✅ Importação concluída: " + res.colaboradores +
            " colaborador(es) e " + res.registros + " registro(s) novos ou atualizados.");
        });
      }).catch(function (err) { msg.innerHTML = aviso("erro", "❌ " + esc(err.message)); });
    });
  };

  // ==========================================
  // INICIALIZAÇÃO
  // ==========================================
  function carregarDados() {
    return Promise.all([
      Dados.listarColaboradores(),
      Dados.listarRegistros(),
      Dados.lerConfig("senhaAdmin"),
      Dados.lerConfig("ultimoBackup")
    ]).then(function (r) {
      estado.colaboradores = r[0];
      estado.registros = r[1];
      estado.senhaAdminHash = r[2] || "";
      estado.ultimoBackup = r[3] || "";
    });
  }

  ["pointerdown", "keydown", "input"].forEach(function (ev) {
    document.addEventListener(ev, marcarAtividade, { passive: true });
  });

  document.getElementById("link-admin").addEventListener("click", function (e) {
    e.preventDefault();
    abrirAdmin();
  });

  Dados.abrir().then(carregarDados).then(function () {
    if (/[?&]admin=1/.test(location.search)) abrirAdmin();
    else irPara("identificar");
    tique();
    setInterval(tique, 1000);
  }).catch(function (err) {
    app.innerHTML = "<h1>🍽️ Registro Digital — Refeitório</h1>" +
      aviso("erro", "❌ Não foi possível abrir o armazenamento deste aparelho: " + esc(err.message) +
        "<br>Abra o totem numa janela normal (não anônima) do Chrome ou Edge.");
  });

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
