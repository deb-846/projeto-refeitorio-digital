# Totem Refeitório

Registro digital de café, chá, marmita, almoço e jantar do refeitório, feito
para rodar num tablet.

**Não depende de servidor nem de banco de dados.** O app é uma página web
estática: abre no navegador do tablet, grava os dados no próprio aparelho e
continua funcionando sem internet. Não há nada que "durma", pause ou precise
de aprovação da TI para hospedar dados.

## Como funciona

| Parte | Onde fica |
|---|---|
| Telas e regras (horários, 1 refeição por turno, senha, tempo limite) | `totem/` — HTML, CSS e JavaScript puros, sem bibliotecas externas |
| Hospedagem dos arquivos | GitHub Pages (grátis, publicado automaticamente a cada mudança na `main`) |
| Colaboradores e registros | IndexedDB do navegador **do tablet** |
| Cópia de segurança | Arquivo `.json` baixado pelo admin (menu **Administração › Dados e Backup**) |
| Relatórios | Painel admin no próprio tablet, com exportação para Excel (.xlsx) |

Depois do primeiro acesso, o service worker guarda os arquivos no aparelho: o
totem abre mesmo se a internet cair.

## Instalação (uma única vez)

1. **Publicar:** no GitHub, vá em *Settings › Pages › Build and deployment* e
   escolha **Source: GitHub Actions**. Depois, em *Actions › Publicar totem*,
   clique em *Run workflow*. O endereço será
   `https://deb-846.github.io/projeto-refeitorio-digital/`.
2. **No tablet:** abra esse endereço no Chrome (ou Edge) e use
   *menu › Adicionar à tela inicial / Instalar app*. Instalado, o totem abre
   em tela cheia e o navegador protege os dados contra limpeza automática.
3. **Senha de admin:** toque em **Administração** (canto inferior direito). No
   primeiro acesso você cria a senha de administrador.
4. **Trazer os dados antigos:** em *Administração › Dados e Backup ›
   Importar dados*, escolha o arquivo `dados_migracao_refeitorio.json`
   (exportado do sistema antigo). Os colaboradores continuam com as mesmas
   senhas.

Para testar num computador sem publicar: dentro de `totem/`, rode
`python3 -m http.server 8000` e abra `http://localhost:8000`.

## Trocar o endereço do totem (mudança de conta ou de site)

O navegador guarda os dados **por endereço**. Se o endereço do totem mudar
(por exemplo, o repositório for transferido para outra conta do GitHub), o
totem abre vazio no endereço novo. Para migrar sem perder nada:

1. No endereço **antigo**: *Administração › Dados e Backup › Baixar backup*.
2. No endereço **novo**: instale na tela inicial, crie a senha de admin e
   importe esse backup.
3. Só depois de conferir os dados no endereço novo, remova o ícone antigo.

## Rotina

- **Backup semanal (obrigatório):** *Administração › Dados e Backup › Baixar
  backup*. Guarde o arquivo no computador, e-mail ou OneDrive. O painel avisa
  quando o último backup tem mais de 7 dias.
- **Relatório de medição:** *Administração › Registros e Relatórios*, escolha
  o período e toque em **Baixar Excel**.
- **Tablet novo ou restaurado:** instale o totem (passo 2), crie a senha de
  admin e importe o último backup. A importação só acrescenta: nada é apagado
  e registros repetidos são ignorados.
- **Relatório no computador:** abra o endereço do totem no computador, entre no
  admin e importe o backup mais recente. Os dados ficam só naquele navegador.

## Limitações

- Os dados ficam **em um aparelho**. Se o tablet for perdido, volta-se ao
  último backup. Por isso o backup semanal é obrigatório.
- Não sincroniza entre vários tablets. Para mais de um ponto de registro,
  cada tablet tem seus próprios dados e os backups são juntados por importação
  num mesmo navegador (registros não se duplicam).
- Não use o totem em janela anônima: o navegador apaga tudo ao fechar.
- As regras de "uma refeição por turno" valem para os registros daquele
  aparelho.

## Regras do totem

- Almoço: 10h às 14h. Jantar: 22h às 02h (cruza a meia-noite). Um de cada
  por pessoa, por turno. Horário de Mato Grosso (America/Cuiaba).
- Café, chá e marmita: livres, com quantidade por tamanho de garrafa.
- Sessão do colaborador fecha após 2 min sem toque (aviso nos últimos 30 s).
- 5 senhas erradas bloqueiam aquele nome por 5 minutos.
- Painel admin fecha após 5 min sem toque.
- Senhas são guardadas como hash SHA-256, compatível com o sistema antigo.

## Arquivos

| Arquivo | Função |
|---|---|
| `totem/index.html`, `estilo.css` | Página e visual |
| `totem/app.js` | Telas, regras e painel admin |
| `totem/dados.js` | Gravação no IndexedDB, backup e importação |
| `totem/sha256.js` | Hash das senhas |
| `totem/xlsx.js` | Gerador de planilhas Excel |
| `totem/sw.js`, `manifest.webmanifest`, `icone.svg` | Funcionamento offline e instalação |
| `.github/workflows/publicar-totem.yml` | Publicação no GitHub Pages |
