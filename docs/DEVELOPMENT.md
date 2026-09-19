# Desenvolvimento e automação

Fonte canônica de setup, scripts e efeitos das ferramentas. Para arquitetura,
leia [ARCHITECTURE.md](ARCHITECTURE.md); a ordem completa de validação e cobertura
está em [TESTING.md](TESTING.md). Resultados datados ficam em
[REPOSITORY_AUDIT.md](REPOSITORY_AUDIT.md), sem transformar o estado local em remoto.

## Requisitos e instalação

- Node.js 20+ conforme [package.json](../package.json); npm declarado em
  `packageManager`. O lockfile da raiz é a referência para JavaScript.
- Python 3.12 é a versão declarada pelos workflows; o pipeline usa biblioteca
  padrão e não tem instalação pip.
- macOS/Xcode para build e XCTest do iOS; iPhone para DNS real. Schemes,
  configurações, assinatura e diferenças StoreKit pertencem ao
  [README iOS](../apps/ios/README.md).
- Credenciais Cloudflare, Railway e Apple não são requisito para lint,
  typecheck, testes mockados e build de simulador sem assinatura.

Em setup autorizado de uma cópia de trabalho:

```sh
npm ci
```

Esse comando instala dependências e executa `prepare`, que chama
[install-git-hooks.sh](../tools/dev/install-git-hooks.sh) e escreve
`core.hooksPath=.githooks` na configuração Git local. O script pula essa escrita
se `CI=true`. `npm run setup:hooks` faz a mesma configuração explicitamente.
Não executar instalação ou configuração de hooks numa tarefa restrita a
Markdown. `npm install` pode modificar o lockfile; não usá-lo como substituto
silencioso do setup reproduzível.

## Política de branches

| Branch | Identidade/ambiente | Automação autorizada pelo desenho |
| --- | --- | --- |
| `develop` | `Adless Dev` (`com.orbeworks.adless.dev`), configurações `Debug Dev`/`Release Dev`, StoreKit local e Worker de desenvolvimento | Desenvolvimento local e deploy isolado de `adless-dns-development`; não alimenta TestFlight |
| `beta` | App oficial `Adless`, assinatura automática e Worker de produção | Dois workflows isolados do Xcode Cloud: um distribui ao TestFlight Internal e o outro ao TestFlight External |
| `main` | App oficial e ambiente de produção | Submissão App Store, Worker de produção e landing Railway conforme seus filtros/configurações |

O fluxo de promoção é `develop` → `beta` → `main`, portanto os arquivos de todos
os ambientes seguem para as branches posteriores. Isso não mistura as
identidades em runtime: `Adless Dev` e `[env.development]` continuam isolados
pelo scheme/configuração e pela seleção explícita `--env development`, enquanto
os dois fluxos da `beta` geram o app oficial. TestFlight Internal e External não
são estágios sequenciais do mesmo workflow; cada um tem seu próprio workflow
Xcode Cloud e seus próprios critérios de distribuição.
Um push em `develop` abre uma PR de promoção para `beta` se nenhuma estiver
aberta; um push em `beta` abre a correspondente PR para `main`. Os workflows
apenas criam a PR, são serializados por par de branches e nunca fazem merge
automático. Para funcionarem com `GITHUB_TOKEN`, o repositório precisa manter
habilitada em **Settings → Actions → General → Workflow permissions** a opção
**Allow GitHub Actions to create and approve pull requests**. Os workflows
declaram somente `contents: read` e `pull-requests: write`; não aprovam PRs.

### Instalar Adless Dev em um iPhone com StoreKit local

Com o iPhone conectado, confiável, desbloqueado e com a tela acesa, execute da
raiz do repositório:

```sh
tools/ios/install_adless_dev.sh
```

Se houver mais de um aparelho físico disponível, passe parte do nome ou o UDID:

```sh
tools/ios/install_adless_dev.sh 'iPhone de Andre'
```

O script valida antes do build que o scheme é `Adless Dev`, a configuração é
`Debug Dev`, o bundle ID é `com.orbeworks.adless.dev`, o ambiente é
`development`, o LaunchAction usa `Adless.storekit` e a URL é a do Worker de
desenvolvimento. Ele compila numa cópia temporária de `apps/ios`, valida o app
assinado, instala e inicia **Product → Run** no Xcode. Essa última etapa é
necessária porque a sessão StoreKit local pertence ao LaunchAction do Xcode;
abrir apenas o bundle instalado não ativa `Adless.storekit`.

O script não altera o projeto original nem substitui o app oficial, pois os
bundle IDs são diferentes. A automação da interface exige permissão de
Acessibilidade para o terminal/Codex controlar o Xcode. Mantenha o workspace
temporário informado no final enquanto a sessão estiver ativa. Compras dessa
sessão são simulações locais; TestFlight continua usando o Sandbox da Apple.
O `DerivedData` temporário usado para instalar o primeiro bundle é removido
automaticamente ao final do script; somente a cópia de fontes necessária para
a sessão aberta no Xcode permanece. Diretórios antigos com prefixo `adless`
em `/private/tmp` ou no diretório temporário da sessão do macOS podem ser
removidos com `tools/dev/cleanup-adless-temp.sh`; por padrão, o comando preserva
os criados nas últimas 24 horas e qualquer diretório associado a um processo
ativo.

A raiz declara somente `apps/landing-page` como workspace. Os scripts do Worker
usam `npm --prefix apps/dns-worker` e compilador de `node_modules` da raiz; o
Worker não é um segundo workspace. As dependências JWS/X.509 também estão no
`package.json` da raiz. Não deduzir que o pacote do Worker se instala sozinho.

## Comandos e efeitos locais

Comandos abaixo partem da raiz. **Implemented:** nomes e encaminhamentos
confirmados nos arquivos `package.json`.

| Comando | Escopo e efeito |
| --- | --- |
| `npm run dev:landing` | Servidor Vite local da landing |
| `npm run lint` | ESLint somente da landing, sem `--fix` |
| `npm run typecheck` | TypeScript app e ferramentas da landing, `--noEmit` |
| `npm run build` / `npm run build:landing` | Build Vite da landing; gera `apps/landing-page/dist/` |
| `npm run preview:landing` | Serve a build existente da landing |
| `npm run build:dns-worker` | TypeScript do Worker com `noEmit`; não cria bundle de deploy nem publica |
| `npm run test:dns-worker` | Compila testes em `apps/dns-worker/dist-test/` e usa `node --test` |
| `npm run prepare:dns-blocklist` | Regrava texto/metadata da blocklist no Worker |
| `python3 -B -m unittest discover -s tools/blocklists/tests -v` | Testes Python, temporários fora do repositório; `-B` evita bytecode |
| `python3 -B tools/blocklists/validate_blocklist.py` | Lê e valida artefatos existentes, sem regenerar |

Não há `npm test` na raiz, suíte automatizada da landing nem comando npm para
XCTest. Não usar `npm run build` como prova de compilação de todo o monorepo.
O gerador de blocklist acessa a rede e altera artefatos; comandos e limites
estão no [pipeline](../tools/blocklists/README.md). Build/archive/export Xcode
produzem arquivos e podem acessar a rede; `-allowProvisioningUpdates` também
pode alterar profiles remotos, exigindo autorização para essa operação.

## Hooks existentes

[common.sh](../.githooks/common.sh) contém os checks chamados pelos hooks.
Eles ajudam o desenvolvimento local, mas não constituem a CI inteira.

| Hook | O que realmente executa |
| --- | --- |
| [pre-commit](../.githooks/pre-commit) | `git diff --cached --check`; sintaxe Python em blocklists/appstore/dns-worker; lint quando landing ou pacote/lock da raiz entra no stage |
| [pre-push](../.githooks/pre-push) | Shellcheck nos scripts shell alterados; testes Python blocklists; testes/build Worker; dry-run Wrangler de produção e desenvolvimento ao tocar Worker/deploy; typecheck/build landing; XCTest para iOS; testes offline de distribuição/allowlist e contratos de health check; actionlint para workflows/scripts/exports/hooks; lockfile seleciona Worker e landing |

O pre-push escolhe o primeiro simulador iPhone disponível e usa DerivedData
em diretório temporário. Num ref remoto novo, inspeciona todos os caminhos da
árvore. Alterações de Markdown dentro de aplicações podem selecionar checks
pelo caminho mesmo sem mudança de código. Os checks leem o working tree,
não uma cópia isolada do conteúdo staged: preserve e relate alterações locais.

**Pending:** pre-commit não cobre sintaxe de todos os scripts Python/shell;
pre-push não inclui lint da landing nem verifica IPA/archive, e
mudanças só em `tools/blocklists` não selecionam automaticamente a suíte Worker.
Seguir [TESTING.md](TESTING.md) para dependências entre áreas. Não rodar hooks
via commit/push apenas para validar: chamar os comandos relevantes diretamente.

## Workflows declarados e limites

**Implemented:** os workflows versionados têm `concurrency`,
`cancel-in-progress`, timeout e permissões de conteúdo explícitas. Deploys usam
`contents: read`; atualização de blocklist usa `contents: write`.
Não há `pull_request` nem job de testes geral nesses arquivos. Os YAMLs não
referenciam GitHub Environments com aprovação; proteções e secrets remotos
permanecem **Pending** até inspeção autorizada do estado remoto.

| Workflow | Gatilho declarado | Ação e lacuna observável |
| --- | --- | --- |
| [deploy-dns-worker.yml](../.github/workflows/deploy-dns-worker.yml) | `main` com filtros de caminho; manual | Prepara/valida lista, compila e publica Worker. Não executa suíte Worker nem smoke após deploy. Filtros não incluem pacote/lock da raiz. Runbook: [dns-cloud.md](dns-cloud.md). |
| Cloudflare Workers Builds (development) | branch `develop` do repositório conectado ao Worker `adless-dns-development` | Prepara, valida, compila e publica o ambiente Dev diretamente no Cloudflare. |
| Railway landing | conexão direta ao repositório `andre-fig/adless`, branch `main` | O serviço Railway usa `apps/landing-page` como raiz e publica após push; não passa pelo GitHub Actions. |
| [update-blocklist.yml](../.github/workflows/update-blocklist.yml) | Domingo 03:17 UTC; manual | Testa/gera/valida e faz commit/push de seis artefatos; não publica Worker ou Railway diretamente. |
| Xcode Cloud | `beta` e `main`, configurados no App Store Connect | `beta`: TestFlight interno e externo em workflows isolados. `main`: App Store com liberação após aprovação. |

Os dois workflows iOS usam o scheme `Adless`, não `Adless Dev`; detalhes,
comandos App Store Connect e diferenças entre upload/revisão/disponibilidade
estão em [ios-release.md](ios-release.md). `tools/appstore/appstore_connect.py`
possui comandos que escrevem no App Store Connect; `tools/sentry/upload-dsyms.sh`
envia dados remotamente. Não chamar esses scripts como smoke local genérico.

**Pending:** o workflow da blocklist usa checkout sem token alternativo e não
faz dispatch dos deploys. Com `GITHUB_TOKEN`, o push do workflow não dispara
novos workflows de `push`; portanto commit gerado não comprova atualização da
edge/site. Confirmar execução e deployment separadamente, conforme a
[documentação oficial de gatilhos GitHub](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

Não disparar workflows, deploy, upload, submissão, commit ou push sem
explicitamente autorizar seus efeitos. Um futuro push autorizado a `main` ou
`develop` pode acionar publicação conforme os filtros acima; revisar isso antes
da operação. Datas de execução, IDs de deployment e verificações de secrets
não devem ser inferidos da existência do YAML.
