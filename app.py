import streamlit as st
from supabase import create_client, Client
from datetime import datetime, timedelta
import pandas as pd
import uuid
import io
import os
import json
import hashlib
import time
try:
    import pytz
    _TZ_CUIABA = pytz.timezone("America/Cuiaba")
    _USE_PYTZ = True
except ImportError:
    _USE_PYTZ = False

# ==========================================
# 1. CONFIGURAÇÃO DA PÁGINA
# ==========================================
st.set_page_config(page_title="Totem Aura Apoena", layout="centered")

# --- Ocultar sidebar e rodapé do Streamlit por padrão ---
# O portal admin é acessado via parâmetro ?admin=1 na URL
st.markdown("""
    <style>
    /* Oculta sidebar no modo totem */
    [data-testid="stSidebar"] { display: none !important; }
    /* Oculta footer do Streamlit */
    footer { visibility: hidden; }
    /* Botões de ação maiores para toque em tablet */
    div[data-testid="stButton"] > button {
        min-height: 3.5rem;
        font-size: 1.05rem;
        font-weight: 600;
    }
    </style>
""", unsafe_allow_html=True)

# ==========================================
# 2. MODO ADMIN — via parâmetro de URL (?admin=1)
# ==========================================
params = st.query_params
MODO_ADMIN_URL = params.get("admin", "0") == "1"

# Se for modo admin, reexibir sidebar
if MODO_ADMIN_URL:
    st.markdown("""
        <style>
        [data-testid="stSidebar"] { display: block !important; }
        </style>
    """, unsafe_allow_html=True)

# ==========================================
# 3. CONEXÃO COM O BANCO DE DADOS (resiliente)
# ==========================================
# No plano gratuito, o projeto Supabase entra em repouso depois de alguns dias
# sem uso e leva de 1 a 2 minutos para acordar. Enquanto isso, toda chamada
# falha. Por isso a conexão NÃO guarda a falha em cache: se der erro agora,
# a próxima execução tenta novamente assim que o banco voltar.

@st.cache_resource(show_spinner=False)
def init_connection() -> Client:
    url = st.secrets["SUPABASE_URL"]
    key = st.secrets["SUPABASE_KEY"]
    return create_client(url, key)

try:
    supabase = init_connection()
except KeyError:
    supabase = None
    st.error("⚠️ Secrets ausentes: configure SUPABASE_URL e SUPABASE_KEY.")
except Exception:
    # Falha de rede/banco em repouso: não cacheia, tenta de novo no próximo ciclo.
    supabase = None

# ==========================================
# 4. CONSTANTES
# ==========================================
TIMEOUT_MINUTOS = 2          # Sessão expira após 2 min de inatividade
AVISO_TIMEOUT_SEG = 30       # Aviso visual nos últimos 30 segundos
MAX_TENTATIVAS_SENHA = 5     # Bloqueia após 5 erros de senha
DATA_CORTE_FALLBACK = datetime(2025, 12, 31)  # Fallback texto puro encerra nesta data

# --- Horários das refeições (hora local de Mato Grosso) ---
ALMOCO_INICIO = 10          # Almoço: das 10h às 14h (mesmo dia)
ALMOCO_FIM = 14
JANTAR_INICIO = 22          # Jantar: das 22h às 02h (cruza a meia-noite)
JANTAR_FIM = 2

# --- Resiliência a banco em repouso / queda de rede ---
TENTATIVAS_REDE = 4          # Tentativas por operação antes de desistir
ESPERA_INICIAL_SEG = 1.5     # Backoff: 1.5s, 3s, 6s (total ~10s)
DIR_LOCAL = os.environ.get("REFEITORIO_DIR_LOCAL", ".dados_locais")
ARQ_FILA = os.path.join(DIR_LOCAL, "registros_pendentes.json")
ARQ_SNAPSHOT = os.path.join(DIR_LOCAL, "colaboradores_snapshot.json")

# ==========================================
# 5. FUNÇÕES DE SEGURANÇA
# ==========================================

def hash_senha(senha: str) -> str:
    """Gera hash SHA-256 da senha."""
    return hashlib.sha256(senha.strip().encode()).hexdigest()

def verificar_senha(senha_digitada: str, senha_db: str) -> bool:
    """
    Verifica senha com suporte a migração:
    - Aceita senhas já em hash (novos cadastros)
    - Aceita senhas em texto puro apenas até DATA_CORTE_FALLBACK
    """
    if not senha_db:
        return False
    if senha_db == hash_senha(senha_digitada):
        return True
    # Fallback: suporte a senhas antigas (texto puro) — expira em DATA_CORTE_FALLBACK
    if datetime.now() <= DATA_CORTE_FALLBACK:
        if senha_db == senha_digitada.strip():
            return True
    return False

# ==========================================
# 6. FUNÇÕES DE SESSÃO / TIMEOUT
# ==========================================

def segundos_restantes() -> float:
    """Retorna segundos restantes antes do timeout. Negativo = expirou."""
    if "ultimo_ativo" not in st.session_state:
        return TIMEOUT_MINUTOS * 60
    decorrido = time.time() - st.session_state.ultimo_ativo
    return (TIMEOUT_MINUTOS * 60) - decorrido

def verificar_timeout() -> bool:
    """Retorna True se a sessão expirou por inatividade."""
    return segundos_restantes() <= 0

def atualizar_atividade():
    """Atualiza o timestamp de última atividade."""
    st.session_state.ultimo_ativo = time.time()

def resetar_sessao():
    """Reseta todos os estados de sessão do colaborador."""
    st.session_state.usuario_autenticado = False
    st.session_state.item_selecionado = None
    st.session_state.ultimo_nome = None
    st.session_state.chave_identificacao = str(uuid.uuid4())
    st.session_state.tentativas_senha = 0
    st.session_state.pop("ultimo_ativo", None)

# ==========================================
# 6.5 RESILIÊNCIA: RETRY, FILA LOCAL E SNAPSHOT
# ==========================================
# Regra de ouro: nenhum registro feito pelo colaborador pode ser perdido
# porque o Supabase estava dormindo. Se o banco não responder, o registro
# é gravado em fila local e reenviado automaticamente quando o banco voltar.

def _garantir_dir_local():
    try:
        os.makedirs(DIR_LOCAL, exist_ok=True)
        return True
    except Exception:
        return False


def _ler_json(caminho, padrao):
    try:
        with open(caminho, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return padrao


def _gravar_json(caminho, dados) -> bool:
    if not _garantir_dir_local():
        return False
    try:
        temporario = caminho + ".tmp"
        with open(temporario, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False, indent=2)
        os.replace(temporario, caminho)
        return True
    except Exception:
        return False


def executar_com_retry(operacao, tentativas: int = TENTATIVAS_REDE):
    """Executa a operação repetindo com espera crescente.

    Cobre o 'cold start' do Supabase: a primeira chamada acorda o projeto e
    as seguintes costumam funcionar.
    """
    if supabase is None:
        raise RuntimeError("Conexão com o banco indisponível.")
    ultimo_erro = None
    for tentativa in range(tentativas):
        try:
            return operacao()
        except Exception as erro:
            ultimo_erro = erro
            if tentativa < tentativas - 1:
                time.sleep(ESPERA_INICIAL_SEG * (2 ** tentativa))
    raise ultimo_erro


def banco_disponivel() -> bool:
    """Ping leve no banco (também serve para acordar o projeto)."""
    if supabase is None:
        return False
    try:
        supabase.table("colaboradores").select("nome").limit(1).execute()
        return True
    except Exception:
        return False


# --- Fila local de registros pendentes ---

def carregar_fila() -> list:
    fila = _ler_json(ARQ_FILA, [])
    return fila if isinstance(fila, list) else []


def salvar_fila(fila: list) -> bool:
    return _gravar_json(ARQ_FILA, fila)


def enfileirar_lote(linhas: list, cod: str) -> bool:
    """Guarda o lote em disco para envio posterior. Retorna False se nem o
    disco aceitou a gravação (aí o lote fica só na sessão, como último recurso)."""
    fila = carregar_fila()
    fila.append({
        "codigo_auditoria": cod,
        "criado_em": datetime.now().isoformat(timespec="seconds"),
        "linhas": linhas,
    })
    gravou = salvar_fila(fila)
    # Espelho em memória: sobrevive a falha de disco enquanto o app estiver de pé.
    pendentes_sessao = st.session_state.get("fila_memoria", [])
    pendentes_sessao.append({"codigo_auditoria": cod, "linhas": linhas})
    st.session_state["fila_memoria"] = pendentes_sessao
    return gravou


def _lote_ja_gravado(cod: str) -> bool:
    """Evita duplicar se o insert chegou ao banco mas a resposta se perdeu."""
    try:
        res = executar_com_retry(
            lambda: supabase.table("registros")
            .select("id")
            .eq("codigo_auditoria", cod)
            .limit(1)
            .execute(),
            tentativas=2,
        )
        return bool(res.data)
    except Exception:
        return False


def reenviar_pendentes() -> tuple:
    """Tenta subir tudo que está na fila. Retorna (enviados, restantes)."""
    fila = carregar_fila()
    memoria = st.session_state.get("fila_memoria", [])
    codigos_em_disco = {lote.get("codigo_auditoria") for lote in fila}
    for lote in memoria:
        if lote.get("codigo_auditoria") not in codigos_em_disco:
            fila.append(lote)

    if not fila or supabase is None:
        return 0, len(fila)

    enviados = 0
    restantes = []
    for lote in fila:
        cod = lote.get("codigo_auditoria")
        linhas = lote.get("linhas") or []
        if not linhas:
            continue
        try:
            if _lote_ja_gravado(cod):
                enviados += 1
                continue
            executar_com_retry(
                lambda linhas=linhas: supabase.table("registros").insert(linhas).execute(),
                tentativas=2,
            )
            enviados += 1
        except Exception:
            restantes.append(lote)

    salvar_fila(restantes)
    st.session_state["fila_memoria"] = list(restantes)
    return enviados, len(restantes)


def total_pendentes() -> int:
    fila = carregar_fila()
    codigos = {lote.get("codigo_auditoria") for lote in fila}
    for lote in st.session_state.get("fila_memoria", []):
        codigos.add(lote.get("codigo_auditoria"))
    return len(codigos)


# --- Snapshot de colaboradores (permite operar com o banco fora do ar) ---

def salvar_snapshot_colaboradores(dados: list):
    if dados:
        _gravar_json(ARQ_SNAPSHOT, {
            "atualizado_em": datetime.now().isoformat(timespec="seconds"),
            "colaboradores": dados,
        })


def carregar_snapshot_colaboradores() -> list:
    dados = _ler_json(ARQ_SNAPSHOT, {})
    if isinstance(dados, dict):
        return dados.get("colaboradores") or []
    return []


# ==========================================
# 7. FUNÇÕES DE DADOS
# ==========================================

@st.cache_data(ttl=60, show_spinner=False)
def _buscar_colaboradores_online() -> list:
    """Busca no banco com retry. Levanta exceção se o banco não responder —
    exceção não é cacheada, então a próxima execução tenta de novo."""
    res = executar_com_retry(
        lambda: supabase.table("colaboradores").select("nome, senha, ativo").execute()
    )
    return res.data or []


def buscar_dados_colaboradores():
    """Colaboradores ativos. Se o banco estiver em repouso, usa o último
    snapshot salvo em disco para o totem continuar funcionando."""
    try:
        dados = _buscar_colaboradores_online()
        salvar_snapshot_colaboradores(dados)
        st.session_state["banco_online"] = True
    except Exception:
        st.session_state["banco_online"] = False
        dados = carregar_snapshot_colaboradores()
    return [u for u in dados if u.get("ativo", True) is not False]


@st.cache_data(ttl=60, show_spinner=False)
def buscar_todos_colaboradores():
    """Busca todos os colaboradores (incluindo inativos) para o admin."""
    try:
        res = executar_com_retry(
            lambda: supabase.table("colaboradores").select("*").execute()
        )
        return res.data or []
    except Exception:
        return carregar_snapshot_colaboradores()

def hora_local() -> datetime:
    """Retorna hora atual no fuso de Mato Grosso (America/Cuiaba)."""
    if _USE_PYTZ:
        return datetime.now(_TZ_CUIABA).replace(tzinfo=None)
    # Fallback sem pytz (UTC-4 fixo)
    return datetime.utcnow() - timedelta(hours=4)

def datas_do_turno(tipo_refeicao, agora) -> list:
    """Datas (dd/mm/aaaa) que o turno atual da refeição pode abranger.

    O jantar vai das 22h às 02h, ou seja, atravessa a meia-noite: quem come
    às 23h grava na data de hoje e quem come à 01h grava na data de amanhã.
    Para o jantar a lista tem duas datas: [noite de, madrugada seguinte].
    """
    if tipo_refeicao != "JANTAR":
        return [agora.strftime("%d/%m/%Y")]

    # Antes das 2h ainda é a noite do dia anterior.
    inicio = agora.date() - timedelta(days=1) if agora.hour < JANTAR_FIM else agora.date()
    return [
        inicio.strftime("%d/%m/%Y"),
        (inicio + timedelta(days=1)).strftime("%d/%m/%Y"),
    ]


def registro_no_turno(linha, tipo_refeicao, datas_turno) -> bool:
    """Diz se um registro já gravado pertence ao turno em questão.

    A data sozinha não basta para o jantar: noites vizinhas compartilham uma
    data. A noite de 15 abrange 15/09 (a partir das 22h) e 16/09 (até as 2h);
    a noite de 16 abrange 16/09 (a partir das 22h) e 17/09. Sem olhar a hora,
    quem jantasse à 01h do dia 16 ficaria impedido de jantar às 22h do mesmo
    dia 16 — duas noites distintas.
    """
    data = linha.get("data")
    if data not in datas_turno:
        return False
    if tipo_refeicao != "JANTAR":
        return True

    hora = linha.get("hora") or ""
    if not hora:
        # Registro antigo, sem hora: conta como a noite da própria data.
        return data == datas_turno[0]
    if data == datas_turno[0]:
        return hora >= f"{JANTAR_INICIO:02d}:00:00"   # noite: das 22h em diante
    return hora < f"{JANTAR_FIM:02d}:00:00"            # madrugada: até as 2h


def verificar_regras_refeicao(nome, tipo_refeicao):
    if tipo_refeicao not in ["ALMOÇO", "JANTAR"]:
        return True, ""

    agora = hora_local()
    hora_atual = agora.hour

    if tipo_refeicao == "ALMOÇO":
        if not (ALMOCO_INICIO <= hora_atual < ALMOCO_FIM):
            return False, f"Fora do horário ({ALMOCO_INICIO}h às {ALMOCO_FIM}h)"
    elif tipo_refeicao == "JANTAR":
        # Janela que cruza a meia-noite: vale das 22h em diante OU antes das 2h.
        if not (hora_atual >= JANTAR_INICIO or hora_atual < JANTAR_FIM):
            return False, f"Fora do horário ({JANTAR_INICIO}h às {JANTAR_FIM:02d}h)"

    datas_turno = datas_do_turno(tipo_refeicao, agora)
    bloqueio = f"Bloqueado: {tipo_refeicao} já consumido neste turno."

    # Checagem na fila local primeiro: pega duplicidade registrada offline.
    for lote in carregar_fila() + st.session_state.get("fila_memoria", []):
        for linha in lote.get("linhas") or []:
            if (
                linha.get("colaborador") == nome
                and linha.get("tipo") == tipo_refeicao
                and registro_no_turno(linha, tipo_refeicao, datas_turno)
            ):
                return False, bloqueio

    try:
        res = executar_com_retry(
            lambda: supabase.table("registros")
            .select("data, hora")
            .eq("colaborador", nome)
            .in_("data", datas_turno)
            .eq("tipo", tipo_refeicao)
            .execute(),
            tentativas=2,
        )
        if any(registro_no_turno(l, tipo_refeicao, datas_turno) for l in (res.data or [])):
            return False, bloqueio
    except Exception:
        # Banco indisponível: libera o registro (vai para a fila) para não
        # travar o atendimento no refeitório.
        pass
    return True, ""

def inserir_registros(nome, item, lista_final):
    """Grava o registro e devolve (codigo_auditoria, enviado_ao_banco).

    O lote inteiro vai em UMA única chamada: ou grava tudo, ou nada — acaba
    com o registro pela metade quando o banco cai no meio do laço.
    Se o banco não responder, o lote vai para a fila local e é reenviado
    automaticamente na próxima vez que o banco estiver de pé.
    """
    cod = str(uuid.uuid4())[:8].upper()
    agora_mt = hora_local()
    dt = agora_mt.strftime("%d/%m/%Y")
    hr = agora_mt.strftime("%H:%M:%S")

    linhas = [
        {
            "data": dt,
            "hora": hr,
            "colaborador": nome,
            "tipo": item,
            "litros": lit,
            "codigo_auditoria": cod,
        }
        for lit in lista_final
    ]

    try:
        executar_com_retry(
            lambda: supabase.table("registros").insert(linhas).execute()
        )
        return cod, True
    except Exception:
        enfileirar_lote(linhas, cod)
        return cod, False

def gerar_excel(df_exibir, d_inicio, d_fim):
    """Gera Excel com aba de resumo e aba de detalhes."""
    resumo_tipo = df_exibir.groupby("tipo").size().reset_index(name="Quantidade")
    resumo_colab = (
        df_exibir.groupby("colaborador").size()
        .reset_index(name="Quantidade")
        .sort_values("Quantidade", ascending=False)
    )

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        resumo_tipo.to_excel(writer, sheet_name="Resumo por Tipo", index=False)
        resumo_colab.to_excel(writer, sheet_name="Resumo por Colaborador", index=False)
        df_exibir.to_excel(writer, sheet_name="Detalhes", index=False)

    return output.getvalue()

# ==========================================
# 8. INICIALIZAÇÃO DO ESTADO
# ==========================================
defaults = {
    "item_selecionado": None,
    "usuario_autenticado": False,
    "chave_identificacao": str(uuid.uuid4()),
    "mostrar_sucesso": False,
    "ultimo_nome": None,
    "tentativas_senha": 0,
    "fila_memoria": [],
    "banco_online": True,
    "ultimo_codigo": None,
    "ultimo_registro_offline": False,
}
for key, val in defaults.items():
    if key not in st.session_state:
        st.session_state[key] = val

# ==========================================
# 8.5 SINCRONIZAÇÃO AUTOMÁTICA DA FILA
# ==========================================
# A cada execução, se houver registros pendentes, tenta subir. É assim que os
# registros feitos enquanto o Supabase dormia entram no banco sozinhos.
if total_pendentes() > 0 and supabase is not None:
    enviados, restantes = reenviar_pendentes()
    if enviados:
        buscar_todos_colaboradores.clear()
        st.toast(f"☁️ {enviados} registro(s) pendente(s) enviado(s) ao banco.")

# ==========================================
# 9. TIMEOUT AUTOMÁTICO
# ==========================================
if st.session_state.usuario_autenticado and verificar_timeout():
    resetar_sessao()
    st.warning("⏱️ Sessão encerrada por inatividade. Identifique-se novamente.")

if st.session_state.usuario_autenticado:
    atualizar_atividade()

# ==========================================
# 10. BARRA LATERAL — ACESSO ADMIN (apenas via ?admin=1)
# ==========================================
senha_admin_ok = False

if MODO_ADMIN_URL:
    st.sidebar.image("https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Aura_Minerals_logo.svg/320px-Aura_Minerals_logo.svg.png", use_container_width=True)
    st.sidebar.markdown("---")
    pw_admin = st.sidebar.text_input("🔑 Senha Admin:", type="password")
    senha_admin_correta = st.secrets.get("ADMIN_PASSWORD", "")

    if not senha_admin_correta:
        st.sidebar.error("⚠️ ADMIN_PASSWORD não configurado nos secrets.")
    elif pw_admin == senha_admin_correta:
        senha_admin_ok = True
    elif pw_admin:
        st.sidebar.error("❌ Senha incorreta!")

# ==========================================
# TELA 1: PORTAL ADMINISTRATIVO
# ==========================================
if senha_admin_ok:
    st.title("📊 Portal Administrativo — Medição")
    st.markdown("---")

    # --- Status do banco e da fila ---
    pendentes_admin = total_pendentes()
    col_s1, col_s2 = st.columns(2)
    with col_s1:
        if banco_disponivel():
            st.success("🟢 Banco de dados: **online**")
        else:
            st.error("🔴 Banco de dados: **sem resposta** (pode estar em repouso)")
    with col_s2:
        st.metric("Registros aguardando envio", pendentes_admin)

    aba_dados, aba_colaboradores, aba_pendentes = st.tabs(
        ["📈 Registros e Relatórios", "👥 Gestão de Colaboradores", "☁️ Pendências"]
    )

    # --- ABA 1: REGISTROS ---
    with aba_dados:
        col_i, col_f = st.columns(2)
        with col_i:
            d_inicio = st.date_input("Data Início:", hora_local() - timedelta(days=30), format="DD/MM/YYYY")
        with col_f:
            d_fim = st.date_input("Data Fim:", hora_local(), format="DD/MM/YYYY")

        if st.button("🔍 CARREGAR DADOS DO PERÍODO", use_container_width=True):
            try:
                # ✅ Filtro feito no Supabase — não carrega tabela inteira
                d_i_str = d_inicio.strftime("%d/%m/%Y")
                d_f_str = d_fim.strftime("%d/%m/%Y")

                # Gera lista de datas do período para filtrar (formato dd/mm/yyyy)
                delta = (d_fim - d_inicio).days
                datas_periodo = [
                    (d_inicio + timedelta(days=i)).strftime("%d/%m/%Y")
                    for i in range(delta + 1)
                ]

                res_adm = executar_com_retry(
                    lambda: supabase.table("registros")
                    .select("*")
                    .in_("data", datas_periodo)
                    .execute()
                )
                df = pd.DataFrame(res_adm.data)

                if not df.empty:
                    df_exibir = df[["data", "hora", "colaborador", "tipo", "litros", "codigo_auditoria"]]

                    # --- CARDS DE RESUMO ---
                    st.subheader("📈 Resumo do Período")
                    m1, m2, m3 = st.columns(3)
                    m1.metric("Total de Registros", len(df_exibir))
                    m2.metric("Colaboradores Ativos", df_exibir["colaborador"].nunique())
                    m3.metric("Tipos Distintos", df_exibir["tipo"].nunique())

                    resumo_tipo = df_exibir.groupby("tipo").size().reset_index(name="Quantidade")
                    st.write("**Consumo por Tipo:**")
                    st.dataframe(resumo_tipo, use_container_width=True, hide_index=True)

                    # --- GRÁFICOS ---
                    st.subheader("📊 Gráficos")
                    gc1, gc2 = st.columns(2)
                    with gc1:
                        st.write("**Registros por Tipo**")
                        st.bar_chart(df_exibir["tipo"].value_counts())
                    with gc2:
                        st.write("**Top 10 Colaboradores**")
                        st.bar_chart(df_exibir["colaborador"].value_counts().head(10))

                    # --- FILTROS DETALHADOS ---
                    st.subheader("🔎 Filtrar Detalhes")
                    fc1, fc2 = st.columns(2)
                    with fc1:
                        filtro_tipo = st.multiselect(
                            "Filtrar por Tipo:",
                            options=sorted(df_exibir["tipo"].unique()),
                            default=sorted(df_exibir["tipo"].unique()),
                        )
                    with fc2:
                        filtro_colab = st.multiselect(
                            "Filtrar por Colaborador:",
                            options=sorted(df_exibir["colaborador"].unique()),
                            default=sorted(df_exibir["colaborador"].unique()),
                        )

                    df_final = df_exibir[
                        df_exibir["tipo"].isin(filtro_tipo)
                        & df_exibir["colaborador"].isin(filtro_colab)
                    ]
                    st.write(f"Exibindo **{len(df_final)}** de {len(df_exibir)} registros.")
                    st.dataframe(df_final, use_container_width=True, hide_index=True)

                    # --- EXPORTAÇÃO ---
                    excel_data = gerar_excel(df_exibir, d_inicio, d_fim)
                    st.download_button(
                        label="📥 BAIXAR EXCEL (Resumo + Detalhes)",
                        data=excel_data,
                        file_name=f"Medicao_{d_inicio.strftime('%d_%m_%Y')}_a_{d_fim.strftime('%d_%m_%Y')}.xlsx",
                        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        use_container_width=True,
                    )
                else:
                    st.warning("Nenhum registro encontrado para este período.")
            except Exception as e:
                st.error(f"Erro ao gerar relatório: {e}")

    # --- ABA 2: GESTÃO DE COLABORADORES ---
    with aba_colaboradores:
        st.subheader("👥 Colaboradores Cadastrados")

        todos_colab = buscar_todos_colaboradores()

        if not todos_colab:
            st.info("Nenhum colaborador cadastrado.")
        else:
            df_colab = pd.DataFrame(todos_colab)
            colunas_exibir = [c for c in ["nome", "empresa", "ativo"] if c in df_colab.columns]
            st.dataframe(df_colab[colunas_exibir], use_container_width=True, hide_index=True)

        st.markdown("---")

        # Resetar senha
        st.write("**🔑 Resetar Senha de Colaborador**")
        nomes_admin = [u["nome"] for u in todos_colab] if todos_colab else []
        col_r1, col_r2 = st.columns(2)
        with col_r1:
            colab_reset = st.selectbox("Colaborador:", [""] + nomes_admin, key="sel_reset")
        with col_r2:
            nova_senha = st.text_input("Nova Senha:", type="password", key="inp_nova_senha")

        if st.button("🔄 RESETAR SENHA", use_container_width=True):
            if not colab_reset or not nova_senha:
                st.error("Selecione o colaborador e digite a nova senha.")
            else:
                try:
                    executar_com_retry(
                        lambda: supabase.table("colaboradores").update(
                            {"senha": hash_senha(nova_senha)}
                        ).eq("nome", colab_reset).execute()
                    )
                    _buscar_colaboradores_online.clear()
                    buscar_todos_colaboradores.clear()
                    st.success(f"✅ Senha de **{colab_reset}** resetada com sucesso.")
                except Exception as e:
                    st.error(f"Erro: {e}")

        st.markdown("---")

        # Ativar / Desativar colaborador
        st.write("**🚫 Ativar / Desativar Colaborador**")
        col_a1, col_a2 = st.columns(2)
        with col_a1:
            colab_ativar = st.selectbox("Colaborador:", [""] + nomes_admin, key="sel_ativar")
        with col_a2:
            acao_ativo = st.radio("Ação:", ["Ativar", "Desativar"], horizontal=True)

        if st.button("✅ APLICAR ALTERAÇÃO", use_container_width=True):
            if not colab_ativar:
                st.error("Selecione um colaborador.")
            else:
                try:
                    novo_status = acao_ativo == "Ativar"
                    executar_com_retry(
                        lambda: supabase.table("colaboradores").update(
                            {"ativo": novo_status}
                        ).eq("nome", colab_ativar).execute()
                    )
                    _buscar_colaboradores_online.clear()
                    buscar_todos_colaboradores.clear()
                    st.success(f"✅ Colaborador **{colab_ativar}** {'ativado' if novo_status else 'desativado'}.")
                except Exception as e:
                    st.error(f"Erro: {e}")

    # --- ABA 3: PENDÊNCIAS (fila local) ---
    with aba_pendentes:
        st.subheader("☁️ Registros aguardando envio ao banco")
        st.caption(
            "Registros feitos enquanto o Supabase estava em repouso ficam salvos aqui "
            "e sobem automaticamente. Nada é perdido."
        )

        fila_atual = carregar_fila()
        if not fila_atual:
            st.success("✅ Nenhuma pendência. Tudo sincronizado com o banco.")
        else:
            linhas_fila = [
                {**linha, "lote": lote.get("codigo_auditoria"), "enfileirado_em": lote.get("criado_em")}
                for lote in fila_atual
                for linha in (lote.get("linhas") or [])
            ]
            st.dataframe(pd.DataFrame(linhas_fila), use_container_width=True, hide_index=True)

            st.download_button(
                "📥 BAIXAR CÓPIA DE SEGURANÇA (JSON)",
                data=json.dumps(fila_atual, ensure_ascii=False, indent=2).encode("utf-8"),
                file_name=f"pendentes_{hora_local().strftime('%d_%m_%Y_%H%M')}.json",
                mime="application/json",
                use_container_width=True,
            )

        if st.button("🔄 TENTAR ENVIAR AGORA", use_container_width=True, type="primary"):
            with st.spinner("Acordando o banco e enviando..."):
                enviados, restantes = reenviar_pendentes()
            if enviados:
                st.success(f"✅ {enviados} lote(s) enviado(s). Restam {restantes}.")
            elif restantes:
                st.error("❌ O banco ainda não respondeu. Os registros continuam salvos aqui.")
            else:
                st.info("Nada para enviar.")
            st.rerun()

# ==========================================
# TELA 2: TOTEM DIGITAL (COLABORADORES)
# ==========================================
elif not MODO_ADMIN_URL:
    st.title("🚀 Registro Digital — Refeitório")
    st.markdown("---")

    # --- AVISO DE TIMEOUT IMINENTE ---
    if st.session_state.usuario_autenticado:
        seg_rest = segundos_restantes()
        if 0 < seg_rest <= AVISO_TIMEOUT_SEG:
            st.warning(f"⚠️ Sessão encerrará em **{int(seg_rest)} segundos** por inatividade.")

    # --- FEEDBACK PÓS-REGISTRO ---
    if st.session_state.mostrar_sucesso:
        cod = st.session_state.get("ultimo_codigo")
        if st.session_state.get("ultimo_registro_offline"):
            st.warning(
                "✅ Registro **salvo com segurança**! O banco de dados está acordando "
                "e o envio será concluído automaticamente em instantes. "
                + (f"\n\nCódigo de auditoria: **{cod}**" if cod else "")
            )
        else:
            st.success("✅ Registro concluído com sucesso! O Totem está pronto para o próximo colaborador.")
            st.balloons()
        st.session_state.mostrar_sucesso = False
        st.session_state.ultimo_registro_offline = False
        st.session_state.ultimo_codigo = None
        time.sleep(3)
        st.rerun()

    # --- STATUS DO BANCO / PENDÊNCIAS ---
    pendentes = total_pendentes()
    if pendentes > 0:
        st.info(
            f"☁️ {pendentes} registro(s) aguardando envio ao banco. "
            "Eles estão salvos e sobem sozinhos assim que a conexão voltar — "
            "**não repita o registro**."
        )

    dados_usuarios = buscar_dados_colaboradores()

    if not st.session_state.get("banco_online", True):
        if dados_usuarios:
            st.warning(
                "⚠️ O banco de dados está acordando. O totem continua funcionando "
                "normalmente — seus registros ficam salvos e sobem automaticamente."
            )
        else:
            st.error(
                "🔴 Banco de dados indisponível e sem lista de colaboradores salva "
                "neste aparelho. Aguarde 2 minutos e recarregue a página. "
                "Se o erro continuar, avise o responsável: o projeto no Supabase "
                "pode estar pausado e precisa ser restaurado no painel."
            )

    nomes_lista = sorted([u["nome"] for u in dados_usuarios])
    nome_selecionado = st.selectbox(
        "IDENTIFIQUE-SE:",
        ["➕ NOVO CADASTRO..."] + nomes_lista,
        index=None,
        placeholder="Toque aqui e selecione seu nome...",
        key=st.session_state.chave_identificacao,
    )

    if st.session_state.ultimo_nome != nome_selecionado:
        st.session_state.usuario_autenticado = False
        st.session_state.tentativas_senha = 0
        st.session_state.ultimo_nome = nome_selecionado

    # --- FLUXO 1: NOVO CADASTRO ---
    if nome_selecionado == "➕ NOVO CADASTRO...":
        st.info("📝 Preencha os dados abaixo e crie sua senha de acesso.")

        with st.form("form_cadastro"):
            n_nome = st.text_input("Nome Completo (Nome e Sobrenome):").strip().upper()
            n_empresa = st.text_input("Empresa:").strip().upper()
            n_senha = st.text_input(
                "Crie uma Senha de Acesso (Ex: 1234):",
                type="password",
                help="Dica: use apenas números para facilitar a digitação no tablet."
            ).strip()
            btn_salvar = st.form_submit_button("💾 SALVAR CADASTRO", type="primary", use_container_width=True)

        if btn_salvar:
            if len(n_nome.split()) < 2:
                st.error("⚠️ Digite o nome completo (nome e sobrenome).")
            elif not n_empresa or not n_senha:
                st.error("⚠️ Todos os campos são obrigatórios.")
            elif n_nome in nomes_lista:
                st.warning("⚠️ Este nome já está cadastrado.")
            else:
                try:
                    with st.spinner("Salvando cadastro..."):
                        executar_com_retry(
                            lambda: supabase.table("colaboradores").insert({
                                "nome": n_nome,
                                "empresa": n_empresa,
                                "senha": hash_senha(n_senha),
                                "ativo": True,
                            }).execute()
                        )
                    _buscar_colaboradores_online.clear()
                    st.session_state.mostrar_sucesso = True
                    st.session_state.chave_identificacao = str(uuid.uuid4())
                    st.rerun()
                except Exception as e:
                    st.error(
                        "❌ Não foi possível salvar o cadastro agora — o banco de dados "
                        "não respondeu (pode estar acordando). Aguarde 1 minuto e tente "
                        f"novamente.\n\nDetalhe técnico: {e}"
                    )

    # --- FLUXO 2: AUTENTICAÇÃO E REGISTRO ---
    elif nome_selecionado:
        colab_info = next((u for u in dados_usuarios if u["nome"] == nome_selecionado), None)
        senha_db = str(colab_info["senha"]).strip() if colab_info and colab_info.get("senha") else None

        # --- Bloqueio por tentativas ---
        tentativas = st.session_state.get("tentativas_senha", 0)
        if tentativas >= MAX_TENTATIVAS_SENHA:
            st.error(f"🔒 Acesso bloqueado após {MAX_TENTATIVAS_SENHA} tentativas incorretas. Procure o responsável.")
        elif not st.session_state.usuario_autenticado:
            with st.form("form_login"):
                st.warning(f"Olá, **{nome_selecionado}**! Digite sua senha para liberar o totem.")
                if tentativas > 0:
                    st.caption(f"⚠️ {tentativas}/{MAX_TENTATIVAS_SENHA} tentativas usadas.")
                senha_digitada = st.text_input(
                    "Digite sua Senha:",
                    type="password",
                    placeholder="Somente números (ex: 1234)",
                )
                btn_login = st.form_submit_button("CONFIRMAR IDENTIDADE", type="primary", use_container_width=True)

            if btn_login:
                if verificar_senha(senha_digitada, senha_db):
                    st.session_state.usuario_autenticado = True
                    st.session_state.tentativas_senha = 0
                    atualizar_atividade()
                    st.rerun()
                else:
                    st.session_state.tentativas_senha += 1
                    restam = MAX_TENTATIVAS_SENHA - st.session_state.tentativas_senha
                    if restam > 0:
                        st.error(f"❌ Senha incorreta! Restam {restam} tentativa(s).")
                    else:
                        st.error("🔒 Acesso bloqueado. Procure o responsável.")
                    st.rerun()

        if st.session_state.usuario_autenticado:

            # TELA A: ESCOLHA DO ITEM
            if not st.session_state.item_selecionado:
                c_bv, c_sair = st.columns([4, 1])
                with c_bv:
                    st.write(f"### Bem-vindo(a), **{nome_selecionado}**!")
                with c_sair:
                    if st.button("🚪 Sair", use_container_width=True, help="Encerrar sessão"):
                        resetar_sessao()
                        st.rerun()

                st.caption(
                    f"⏰ Horário (MT): **{hora_local().strftime('%H:%M')}** "
                    f"| 🍽️ Almoço: {ALMOCO_INICIO}h–{ALMOCO_FIM}h"
                    f" | 🌙 Jantar: {JANTAR_INICIO}h–{JANTAR_FIM:02d}h"
                    f" | ⏱️ Sessão expira em {int(max(segundos_restantes(), 0) // 60)}min"
                )
                st.markdown("---")
                st.write("**O que deseja registrar?**")

                # ✅ Layout 3+2 para botões maiores e mais fáceis de tocar
                c1, c2, c3 = st.columns(3)
                with c1:
                    if st.button("☕\nCAFÉ", use_container_width=True):
                        st.session_state.item_selecionado = "CAFÉ"
                        atualizar_atividade()
                        st.rerun()
                with c2:
                    if st.button("🍵\nCHÁ", use_container_width=True):
                        st.session_state.item_selecionado = "CHÁ"
                        atualizar_atividade()
                        st.rerun()
                with c3:
                    if st.button("🍱\nMARMITA", use_container_width=True):
                        st.session_state.item_selecionado = "MARMITA"
                        atualizar_atividade()
                        st.rerun()

                c4, c5 = st.columns(2)
                with c4:
                    p_a, m_a = verificar_regras_refeicao(nome_selecionado, "ALMOÇO")
                    if st.button("🍽️\nALMOÇO", disabled=not p_a, use_container_width=True):
                        st.session_state.item_selecionado = "ALMOÇO"
                        atualizar_atividade()
                        st.rerun()
                    if not p_a:
                        st.caption(m_a)
                with c5:
                    p_j, m_j = verificar_regras_refeicao(nome_selecionado, "JANTAR")
                    if st.button("🌙\nJANTAR", disabled=not p_j, use_container_width=True):
                        st.session_state.item_selecionado = "JANTAR"
                        atualizar_atividade()
                        st.rerun()
                    if not p_j:
                        st.caption(m_j)

            # TELA B: QUANTIDADES E CONFIRMAÇÃO
            else:
                item = st.session_state.item_selecionado
                st.warning(f"**Registrando: {item}**")

                with st.form("form_registro", clear_on_submit=False):
                    if item in ["CAFÉ", "CHÁ"]:
                        st.write("**Quantas garrafas de cada tamanho você está levando?**")
                        l1, l2, l3, l4 = st.columns(4)
                        with l1: q05 = st.number_input("Garrafa 0.5 L", 0, 10, 0)
                        with l2: q10 = st.number_input("Garrafa 1.0 L", 0, 10, 0)
                        with l3: q15 = st.number_input("Garrafa 1.5 L", 0, 10, 0)
                        with l4: q18 = st.number_input("Garrafa 1.8 L", 0, 10, 0)

                        l5, l6, l7 = st.columns(3)
                        with l5: q20 = st.number_input("Garrafa 2.0 L", 0, 10, 0)
                        with l6: q25 = st.number_input("Garrafa 2.5 L", 0, 10, 0)
                        with l7: q35 = st.number_input("Garrafa 3.5 L", 0, 10, 0)

                        st.write("**Outro tamanho de garrafa?**")
                        c_out1, c_out2 = st.columns(2)
                        with c_out1: litro_outro = st.number_input("Tamanho (Litros):", 0.0, 10.0, 0.0, step=0.1)
                        with c_out2: qtd_outro = st.number_input("Quantidade dessa garrafa:", 0, 10, 0)

                    elif item == "MARMITA":
                        qm = st.number_input("Quantidade de Marmitas:", 1, 10, 1)
                    else:
                        st.info("Regra Corporativa: Limite de 1 unidade por pessoa/turno.")

                    st.markdown("---")
                    assinatura = st.checkbox("✍️ Declaro e confirmo a retirada dos itens preenchidos acima.")

                    c_can, c_con = st.columns(2)
                    with c_can:
                        btn_cancelar = st.form_submit_button("❌ CANCELAR E VOLTAR", use_container_width=True)
                    with c_con:
                        btn_confirmar = st.form_submit_button("✅ CONFIRMAR REGISTRO", type="primary", use_container_width=True)

                if btn_cancelar:
                    st.session_state.item_selecionado = None
                    atualizar_atividade()
                    st.rerun()

                if btn_confirmar:
                    atualizar_atividade()
                    lista_final = []
                    if item in ["CAFÉ", "CHÁ"]:
                        for _ in range(q05): lista_final.append("0.5 L")
                        for _ in range(q10): lista_final.append("1.0 L")
                        for _ in range(q15): lista_final.append("1.5 L")
                        for _ in range(q18): lista_final.append("1.8 L")
                        for _ in range(q20): lista_final.append("2.0 L")
                        for _ in range(q25): lista_final.append("2.5 L")
                        for _ in range(q35): lista_final.append("3.5 L")
                        for _ in range(qtd_outro):
                            if litro_outro > 0:
                                lista_final.append(f"{litro_outro} L")
                    elif item == "MARMITA":
                        for _ in range(qm): lista_final.append("1 UN")
                    else:
                        lista_final.append("1 UN")

                    if len(lista_final) == 0:
                        st.error("⚠️ Adicione a quantidade antes de confirmar.")
                    elif not assinatura:
                        st.error("⚠️ Marque a caixinha de declaração antes de confirmar.")
                    else:
                        with st.spinner("Registrando..."):
                            cod, enviado = inserir_registros(nome_selecionado, item, lista_final)
                        st.session_state.ultimo_codigo = cod
                        st.session_state.ultimo_registro_offline = not enviado
                        st.session_state.mostrar_sucesso = True
                        resetar_sessao()
                        st.rerun()

elif MODO_ADMIN_URL and not senha_admin_ok:
    st.title("🔐 Portal Administrativo")
    st.info("Digite a senha na barra lateral para acessar.")
