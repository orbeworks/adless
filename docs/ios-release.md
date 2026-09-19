# Operação Apple e publicação iOS

Última verificação documental: 2026-09-04, baseada no workspace local e nas
referências Apple citadas. **Implemented:** fluxo no código. **Deployed:** exige
comprovação do artefato remoto. **Verified:** precisa indicar ambiente e evidência.
**Pending:** ação ou verificação ainda necessária. Esta auditoria não verificou
App Store Connect, Apple Developer, TestFlight, profiles remotos ou publicação.

Arquitetura/credenciais: [README iOS](../apps/ios/README.md).
Testes detalhados: [TESTING](TESTING.md). Metadata e texto para revisão:
[app-store-submission](app-store-submission.md). Inventário de privacidade:
[questionário](app-store-privacy-questionnaire.md). Operação do Worker:
[dns-cloud](dns-cloud.md).

## Ambientes que não devem ser confundidos

| Contexto | Implementação local e limite da evidência |
| --- | --- |
| `Adless Dev` | `Debug Dev` / `Release Dev`, bundle `com.orbeworks.adless.dev`, nome Adless Dev |
| `Adless` | `Debug` / `Release`, bundle `com.orbeworks.adless`, nome Adless; identidade oficial usada nos dois workflows |
| Debug vs Release | Flags de compilação, otimização e ambiente Sentry; não determinam o ambiente assinado no JWS StoreKit |
| StoreKit Testing no Xcode | `Adless.storekit` nos LaunchActions; o Worker Dev aceita somente certificados JWS Xcode explicitamente fixados e o bundle `com.orbeworks.adless.dev` |
| Sandbox no iPhone | Produtos reais configurados na Apple, transações de teste assinadas pela Apple; aprovação server-side ainda depende da política do Worker |
| TestFlight interno/externo | Archive Release da identidade oficial, compras Sandbox; estar em TestFlight não comprova assinatura Production |
| App Store pública | Distribuição oficial e compras Production, com aprovação/publicação separadas do sucesso do upload |

`Development.xcconfig` aponta para
`https://adless-dns-development.orbeworks.workers.dev`; KV, Durable
Objects e segredo de derivação são isolados do Worker oficial. Somente esse
ambiente aceita `environment=Xcode`, o bundle `com.orbeworks.adless.dev`, uma
AppTransaction correspondente e um certificado de assinatura StoreKit presente
na allowlist SHA-256 do ambiente Dev. `Production.xcconfig` continua apontando para
`https://adless-dns.orbeworks.workers.dev` e não aceita transações Xcode.
No simulador Debug lançado sem
`-useStoreKitProducts`, há opções somente visuais com `Product == nil` e compra
indisponível. Os LaunchActions incluem esse argumento para StoreKit local.
A Apple distingue explicitamente [Xcode, Sandbox e TestFlight](https://developer.apple.com/documentation/storekit/testing-at-all-stages-of-development-with-xcode-and-the-sandbox):
TestFlight usa Sandbox, sem cobrança, enquanto Xcode não produz a assinatura
App Store usada na validação server-side.

## Produtos e oferta introdutória

**Implemented:** [SubscriptionConfiguration.swift](../apps/ios/Adless/Services/SubscriptionConfiguration.swift)
e [Adless.storekit](../apps/ios/Adless.storekit) usam:

| Plano | Product ID | Configuração somente local |
| --- | --- | --- |
| Mensal | `com.orbeworks.adless.pro.monthly` | P1M, preço de fixture 4.90, sem oferta introdutória |
| Anual | `com.orbeworks.adless.pro.yearly` | P1Y, preço de fixture 29.90, trial gratuito P1W |

O arquivo StoreKit tem grupo `Adless Pro` / `ADLESSPRO`, storefront BRA,
localizações en_US/pt_BR/es_ES, sem Family Sharing; grace de teste está
inicialmente desabilitado. Valores de fixture não são preços ou configuração
publicada. **Pending:** verificar ambos os produtos no mesmo grupo remoto,
níveis apropriados, disponibilidade, preços, trial anual de uma semana por storefront,
localizações, screenshots de revisão e acordos válidos.

Cada pessoa só pode aproveitar uma oferta introdutória por grupo; trocar mensal
por anual no mesmo grupo não concede outro trial. A UI deve ser testada com
pessoas elegíveis e inelegíveis conforme as [regras Apple da oferta](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-introductory-offers-for-auto-renewable-subscriptions/).
**Pending no código:** `SubscriptionManager.makeOption(from:)` lê a oferta e a
UI ajusta CTA e aviso ao plano selecionado, mas ainda não consulta elegibilidade.
Não aprove o paywall enquanto ele prometer trial a quem não tem direito.

## Autorização Apple no Worker

**Implemented:** o app envia JWS verificado da transação e tenta obter o
`AppTransaction` verificado do mesmo bundle. Persiste nonce antes do POST,
reconcilia no primeiro foreground, compra, restore e updates; só instala o
endpoint após commit do par completo no Keychain. Detalhes e falhas recuperáveis
estão no [README iOS](../apps/ios/README.md).

O [wrangler.toml](../apps/dns-worker/wrangler.toml) local aceita Production
normalmente; Sandbox depende de `AppTransaction` Apple-signed e da allowlist
`APPLE_TESTFLIGHT_BUILD_VERSIONS`. Na verificação local essa lista contém `2`, `6` e `7`,
mas o workflow escolhe build number dinamicamente. **Pending:** antes de testar
um novo build, comparar o número realmente enviado com a configuração remota
publicada e validar o gate; o workflow iOS não altera/publica o Worker. Mudar a
allowlist ou publicar o Worker exige autorização explícita. Não abrir Sandbox
indiscriminadamente para contornar erro. Evidências de download e allowlist não
provam criptograficamente que a instalação veio exclusivamente do TestFlight;
builds de desenvolvimento também podem produzir transações Sandbox Apple-signed.

**Pending no portal:** configurar Version 2 explicitamente para Production e
Sandbox em App Information → App Store Server Notifications, com a URL sem
credencial `https://adless-dns.orbeworks.workers.dev/v1/notifications/apple`.
A Apple [documenta ambos os campos](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications/).
Confirmar entrega de testes e eventos reais de assinatura nos dois ambientes,
sem copiar payloads/JWS para logs ou relatórios. Um endpoint no código não prova
que essas URLs foram salvas. A validação JWS não usa segredo compartilhado Apple;
o Worker possui segredo próprio de derivação de tokens, separado das chaves ASC.

## Capability e provisioning profiles

**Implemented:** [Adless.entitlements](../apps/ios/Adless/Resources/Adless.entitlements)
contém apenas `com.apple.developer.networking.networkextension = dns-settings`.
O projeto só tem app e XCTest. O caminho DNS Settings é configuração de DNS
criptografado do sistema com ativação do usuário, descrito pela
[Apple](https://developer.apple.com/documentation/networkextension/dns-settings).
As restrições de supervisão/gerenciamento de [DNS Proxy providers](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)
não constituem evidência de exigência MDM para esta implementação sem provider.
Isso também não comprova que o App ID/profile da equipe esteja correto.

**Pending, alteração externa exige autorização:** no Apple Developer, verificar
Network Extensions / DNS Settings dos App IDs oficial e de desenvolvimento.
O app assinado deve ter somente `dns-settings`, sem Packet Tunnel, DNS Proxy ou
App Groups. Se houver capabilities independentes indevidas no portal, corrigi-las
e regenerar os profiles aplicáveis. Valores adicionais na família Network
Extension do profile, por si só, não comprovam capabilities efetivas extras no
app e são aceitos pelo verificador atual. Não afirmar que permissões antigas
existem no portal só pelo histórico local.
Consultar [habilitação de capabilities](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/).
O profile autoriza capacidades; o entitlement efetivamente assinado do app é
outro objeto. Validar ambos em cada artefato de distribuição.

## Comandos locais e artefatos

Execute da raiz. Build/XCTest: [AGENTS iOS](../apps/ios/AGENTS.md). Xcode pode
resolver packages e escrever arquivos de projeto; em auditorias restritas a
documentação, não executar builds que possam exceder esse escopo. Dependências,
toolchain e simulador precisam estar disponíveis. Estes comandos são um runbook;
resultados executados pertencem ao [relatório de auditoria](REPOSITORY_AUDIT.md).

Archive e exportação com identidade/profiles já preparados, sem solicitar
alteração remota de provisioning:

```sh
xcodebuild archive -project apps/ios/Adless.xcodeproj -scheme Adless \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/Adless.xcarchive
sh tools/ios/verify_archive.sh /tmp/Adless.xcarchive
xcodebuild -exportArchive -archivePath /tmp/Adless.xcarchive \
  -exportOptionsPlist docs/app-store/ExportOptions.plist \
  -exportPath /tmp/Adless-export
sh tools/ios/verify_ipa.sh /tmp/Adless-export/Adless.ipa
```

Use diretórios livres para não substituir artefatos anteriores. Sem assinatura
válida, é possível gerar archive com `CODE_SIGNING_ALLOWED=NO` e executar
`sh tools/ios/verify_archive.sh --layout-only /tmp/Adless.xcarchive` para layout.
**Isso não aprova distribuição.** Não use `Adless Dev` para archive oficial.

`verify_archive.sh` e `verify_ipa.sh` conferem somente `Adless.app`, bundle
oficial, ambiente/origem de produção e ausência total de `.appex`; chamam
[verify_distribution_profile.sh](../tools/ios/verify_distribution_profile.sh)
para verificar profile não expirado, ausência de dispositivos de desenvolvimento/
ad hoc/enterprise, ligação entre application identifier e Team ID, `get-task-allow=false`,
`dns-settings` como único valor de Network Extension **no app assinado** e
presença de `dns-settings` entre os valores autorizados **no profile**.
`require_profile_authorizes_dns_settings` aceita outros valores da família de
Network Extension no profile; `require_dns_settings_only` continua estrito no
app. A allowlist de chaves de entitlements continua estrita nos dois: permite
campos de assinatura Apple, `beta-reports-active` e `keychain-access-groups`;
App Groups e outras chaves de capabilities não previstas são rejeitados.
Os scripts inspecionam entitlements; não substituem
validação Apple, aprovação de revisão ou teste físico.

O workflow exige `Adless.app.dSYM` e ausência de `.appex.dSYM` no nível superior;
não garante que esse seja o único dSYM. Upload opcional de dSYM usa
[upload-dsyms.sh](../tools/sentry/upload-dsyms.sh) com `--include-sources`:
autorizá-lo inclui envio dos fontes associados, não só símbolos.

Checks de manutenção existentes, sem escrever bytecode no repositório:

```sh
sh -n tools/ios/verify_archive.sh
sh -n tools/ios/verify_ipa.sh
sh -n tools/ios/verify_distribution_profile.sh
python3 -c 'from pathlib import Path; p = Path("tools/appstore/appstore_connect.py"); compile(p.read_text(), str(p), "exec")'
python3 tools/appstore/appstore_connect.py --help
```

## Automação de distribuição

**Implemented:** Xcode Cloud mantém os workflows oficiais de TestFlight na
`beta` e de App Store na `main`; GitHub Actions não possui workflows iOS.
Execução manual respeita os mesmos guards de branch.
A política operacional é develop → beta → main, mas o código não
comprova proteção de branches ou revisão obrigatória. Disparar workflow ou push
pode publicar: exige autorização explícita, assim como upload/submissão manual.

O trabalho começa na `develop`, usando `Adless Dev`, StoreKit local e o Worker
de desenvolvimento; essa branch não alimenta TestFlight. Seus commits são
promovidos para `beta` e depois `main`, incluindo os arquivos Dev, mas esses
arquivos permanecem inativos fora do scheme/configuração e do ambiente Wrangler
selecionados explicitamente. Os testes TestFlight Internal e External partem
ambos da `beta`, em workflows Xcode Cloud independentes, usando o app oficial
`Adless`. A `main` fica reservada à distribuição pública/App Store e aos serviços
de produção.

| Fluxo | Comportamento presente no workflow |
| --- | --- |
| `beta` → TestFlight interno | Archive Release, exportação **internal-only**, inspeção, validação Apple, autorização do número no Worker, upload, espera VALID e associação somente ao grupo interno configurado |
| `beta` → TestFlight externo | Exportação sem restrição internal-only, mesmos gates, associação somente aos grupos externos do app e submissão à Beta App Review quando necessária; notificações automáticas quando aprovado |
| `main` → App Store produção | Verifica versão previamente preparada, archive/exportação/inspeção, valida/upload, espera VALID, define `releaseType=AFTER_APPROVAL`, anexa e submete à revisão pública |

O número de build é superior aos números conhecidos pela API; os três fluxos
compartilham `adless-ios-distribution` sem cancelar publicação em andamento.
A versão comercial vem do projeto Xcode (`1.0.1`), não de uma constante separada
por branch. A exportação não renumera o binário. O archive automático intermediário
pode usar assinatura de desenvolvimento; o IPA exportado passa pelo verificador
completo de distribuição, assinatura, endpoint, versão e número esperados.

Os dois workflows da `beta` atualizam somente `APPLE_TESTFLIGHT_BUILD_VERSIONS` nas settings
do Worker existente após validação Apple e antes do upload. Não enviam código
dessas branches ao Worker de produção. Os demais bindings são herdados na
Cloudflare, incluindo o secret opaco; a leitura posterior confirma a alteração.
O deploy do Worker da `main` preserva a união da allowlist publicada com a local.
Ambas as operações usam o lock `adless-dns-worker-production`; alterações manuais
externas não participam desse lock. A allowlist não prova, sozinha, a origem TestFlight:
o Worker mantém as verificações de JWS descritas em [SECURITY](SECURITY.md).

O fluxo externo reutiliza os grupos externos; se não houver nenhum, cria `Adless
Beta`, sem ativar link público nem convidar pessoas arbitrariamente. Configure
testadores ou habilite o link no App Store Connect. `testflight-notes.txt` é o
texto de teste enviado para os idiomas de beta cadastrados. O preflight externo
exige descrição, email de feedback e contato de revisão preenchidos; o interno
não depende desses campos. Não cria contatos, metadata pública ou assinaturas.

Nenhum desses workflows executa XCTest. O pre-push local só os executa quando
os hooks estão instalados e os caminhos enviados incluem iOS; não é gate
remoto comprovado. Ambos definem `API_PRIVATE_KEYS_DIR` para `altool` e removem
a chave temporária no encerramento. Testes de orquestração com APIs simuladas e
actionlint rodam no pre-push para alterações nos caminhos de distribuição;
não acrescentam uma suíte ao Actions.

[appstore_connect.py](../tools/appstore/appstore_connect.py) usa stdlib Python e
OpenSSL, JWT ASC temporário e polling limitado. `preflight`, `next-build` e
`wait-build` consultam a API; não imprimem JWT. `add-beta-build`, `distribute-beta`
e `attach-submit` alteram estado remoto. `preflight` ignora estados conhecidos em revisão/lançamento;
versão inexistente e estados não suportados falham. Se criar a submissão falhar
após anexar o build, é necessária conclusão manual. O script não cria metadata,
produtos, preços ou oferta. Erros HTTP não imprimem o corpo remoto.

Secrets necessários são `ASC_KEY_ID`, `ASC_ISSUER_ID` e `ASC_PRIVATE_KEY`.
TestFlight também exige `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` para
atualizar a allowlist no Worker existente (mesmos nomes do deploy do Worker).
`SENTRY_AUTH_TOKEN` é opcional para dSYMs. Os workflows materializam `.p8` no
diretório temporário do runner com permissão 600; existência dos secrets e
permissões da chave são **Pending** de verificação externa. Nunca mostrar
conteúdo, JWT ou comandos com valores resolvidos. Não executar scripts de
upload/submissão ou `-allowProvisioningUpdates` sem autorização para a ação.

### Pendências verificadas em leitura (2026-09-04)

- GitHub: os secrets ASC e Sentry estão cadastrados no repositório; os dois
  secrets Cloudflare não aparecem na lista do repositório. Cadastrá-los em
  **Settings → Secrets and variables → Actions → Repository secrets** via canal
  seguro. O token precisa ler/editar Workers Scripts na conta correspondente;
  o deploy completo também depende das permissões de recursos já usados.
- App Store Connect → Adless → **TestFlight → Test Information**: preencher
  descrição e email de feedback em todos os idiomas, e conferir contatos de
  Beta App Review. A leitura parou nos campos de localização faltantes; não
  comprovou a completude dos contatos. Havia somente um grupo interno.
- App Store Connect → Adless → **Distribution → adicionar versão iOS `1.0.1`**:
  ainda não existe. Preparar novidades, screenshots/metadata e revisão antes
  da promoção para `main`. O workflow não inventa essas informações.

As alterações de workflow foram testadas localmente com APIs simuladas, não
executadas no GitHub nem usadas para upload/deploy nesta etapa. Uma consulta
de configuração não comprova que o runner tem permissão de assinatura cloud.

## Gates de aprovação

Todos os estados abaixo permanecem **Pending** até registrar evidência do
ambiente, build, resultado e responsável, sem credenciais.

| Etapa | Critério objetivo |
| --- | --- |
| Local | Checks relevantes passam, XCTest usa `AdlessTests`; nenhuma extensão ou entitlement extra; limitações do README revisadas |
| Archive/IPA | Verificadores completos passam no artefato assinado oficial; validação Apple aceita o pacote; profile/certificado corretos |
| Sandbox físico | Produtos/valores corretos; elegibilidade coerente; compra e restore reconciliam Worker; expiração, cancelamento, grace, reembolso e revogação exercitados; internet preservada nos casos conhecidos suportados |
| TestFlight interno | Build VALID e associado ao grupo, instalação real pelo TestFlight, allowlist Sandbox publicada compatível, roteiro físico concluído |
| TestFlight externo | Informações de beta/revisão, grupo e convites preparados; primeiro build aprovado na TestFlight App Review e teste externo realizado |
| App Store pública | Metadata/privacidade/produtos aprovados, build correto anexado, revisão aprovada, opção de lançamento conferida e disponibilidade pública verificada; compra Production testada separadamente com autorização |

TestFlight externo passa pelo fluxo da `beta` e sua beta review. A
[documentação Apple](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
explica grupo externo, revisão e distribuição. A aprovação TestFlight não é
aprovação da App Store pública. Sucesso de `attach-submit` significa submissão,
não publicação imediata; produção é liberada automaticamente depois de aprovada
([opção Apple](https://developer.apple.com/documentation/appstoreconnectapi/appstoreversionupdaterequest/data-data.dictionary/attributes-data.dictionary)).
Roteiro detalhado no iPhone: [TESTING](TESTING.md); preparação
manual de portal: [app-store-submission](app-store-submission.md).
