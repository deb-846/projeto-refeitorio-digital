# Manutenção — Totem Aura Apoena

## O problema: Supabase em repouso

No plano gratuito, o Supabase **pausa o projeto após ~7 dias sem nenhuma
requisição**. Enquanto está pausado (ou acordando, o que leva de 1 a 2
minutos), toda chamada ao banco falha. Antes desta correção, o resultado era:

- o colaborador confirmava o registro e via apenas uma mensagem de erro;
- o registro **não era gravado em lugar nenhum** — se perdia;
- se o banco caísse no meio de um lote (ex.: 5 garrafas), parte das linhas
  entrava e parte não;
- a conexão com erro ficava guardada em cache, então o app continuava
  quebrado mesmo depois de o banco voltar.

## O que foi feito

### 1. Prevenção — o banco não dorme mais

`.github/workflows/manter-supabase-ativo.yml` faz um ping no Supabase a cada
2 dias. Isso conta como atividade e impede a pausa automática.

**Configuração obrigatória (uma única vez)** em
`Settings > Secrets and variables > Actions`:

| Secret | Valor |
|---|---|
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` (mesmo dos Secrets do Streamlit) |
| `SUPABASE_KEY` | a mesma chave `anon` usada no Streamlit |
| `STREAMLIT_APP_URL` | *(opcional)* URL pública do totem, para acordar o app também |

Para testar na hora: aba **Actions > Manter Supabase ativo > Run workflow**.

> O GitHub desativa workflows agendados em repositórios sem commits por 60
> dias. Se isso ocorrer, é só reabilitar na aba Actions.

### 2. Proteção — nenhum registro se perde

Mesmo com o ping, uma queda de rede ainda pode acontecer. Por isso o app
agora tem três camadas:

**Nova tentativa automática (retry).** Toda operação no banco é repetida até
4 vezes com espera crescente (1,5s → 3s → 6s). A primeira chamada acorda o
projeto; as seguintes costumam funcionar.

**Gravação em lote único.** O registro inteiro vai em uma só chamada: ou
grava tudo, ou nada. Acabou o registro pela metade.

**Fila local.** Se o banco não responder, o registro é gravado em
`.dados_locais/registros_pendentes.json` e o colaborador recebe a
confirmação com o código de auditoria. A cada carregamento do app a fila é
reenviada automaticamente — quando o banco acorda, tudo sobe sozinho.
Antes de reenviar, o app confere se o código de auditoria já existe no banco,
então **não há risco de duplicar** registros.

**Snapshot de colaboradores.** A lista de colaboradores é salva em disco a
cada consulta bem-sucedida. Com o banco fora do ar, o totem continua
identificando as pessoas e aceitando registros normalmente.

### 3. Visibilidade

- **Totem:** aviso na tela quando há registros aguardando envio
  ("estão salvos, não repita o registro").
- **Admin (`?admin=1`):** indicador 🟢/🔴 do banco, contador de pendências e
  a aba **☁️ Pendências**, com a tabela do que falta subir, botão
  "Tentar enviar agora" e download de uma cópia de segurança em JSON.

## Limitação importante

A fila fica no disco do servidor onde o app roda. No Streamlit Community
Cloud esse disco é reiniciado quando o app é redeployado ou hiberna. Por isso:

- o ping do GitHub Actions é a proteção principal (evita o problema na raiz);
- se aparecerem pendências no painel admin, **baixe o JSON** pela aba
  Pendências antes de redeployar o app;
- para eliminar a limitação de vez, o caminho é sair do plano gratuito do
  Supabase (projetos pagos não entram em repouso).

## Checklist rápido quando "sumirem" registros

1. Abra o totem com `?admin=1` e veja o indicador do banco.
2. Se estiver 🔴, aguarde 2 minutos e recarregue — o ping acorda o projeto.
3. Confira a aba **☁️ Pendências**: os registros estão lá, não se perderam.
4. Clique em **Tentar enviar agora**.
5. Verifique se o workflow "Manter Supabase ativo" está habilitado e com os
   secrets configurados.
