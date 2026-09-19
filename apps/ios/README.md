# Adless iOS

Referência canônica da implementação local. **Implemented** significa presente
no código; não comprova versão instalada, Worker publicado ou configuração da
Apple. Instruções curtas: [AGENTS](AGENTS.md). Fluxo geral:
[arquitetura](../../docs/ARCHITECTURE.md). Operação Apple:
[ios-release](../../docs/ios-release.md). Cobertura:
[testes](../../docs/TESTING.md).

## Responsabilidades

O app configura DNS-over-HTTPS nativo do iOS. O sistema envia as consultas
selecionadas para o Worker; o app não recebe pacotes DNS nem filtra domínios
localmente. Tráfego de sites, vídeos e outros aplicativos segue diretamente aos
destinos. Railway hospeda a landing; o app atual não baixa manifest ou blocklist.

| Arquivo / símbolo | Responsabilidade implementada |
| --- | --- |
| [AdlessApp.swift](Adless/AdlessApp.swift), `AppViewModel` | Inicialização, foreground, reconciliação, ativação/remoção e confirmação da UI |
| [ContentView.swift](Adless/ContentView.swift) | Tela principal, contadores, paywall e alertas de Ajustes |
| [SubscriptionView.swift](Adless/SubscriptionView.swift) | Compra, restore, planos e documentos legais embutidos |
| [SubscriptionManager.swift](Adless/Services/SubscriptionManager.swift) | StoreKit 2: produtos, status de grupo, current entitlements e transaction updates |
| [SubscriptionConfiguration.swift](Adless/Services/SubscriptionConfiguration.swift) | Product IDs, formatação da oferta e `SubscriptionAccessPolicy` |
| [InstallationTokenStore.swift](Adless/Services/InstallationTokenStore.swift) | UUID da instalação, Keychain, nonce, migração e commit do par |
| [DNSStatsAPIClient.swift](Adless/Services/DNSStatsAPIClient.swift) | Clientes HTTPS separados de stats e autorização |
| [DNSCloudConfiguration.swift](Adless/Services/DNSCloudConfiguration.swift) | Validação da origem HTTPS, construção e reconhecimento do endpoint |
| [DNSSettingsManager.swift](Adless/Managers/DNSSettingsManager.swift) | Actor que carrega, salva, relê e remove preferências Apple |
| [BlockingStatsStore.swift](Adless/Services/BlockingStatsStore.swift) / [SubscriptionStorage.swift](Adless/Services/SubscriptionStorage.swift) | Cache agregado local e snapshot de acesso |
| [SentryConfiguration.swift](Adless/Services/SentryConfiguration.swift) | Diagnósticos e sanitização; configurações remotas continuam externas |
| [BuildEnvironment.swift](Shared/BuildEnvironment.swift) | Valores de build injetados via `Info.plist` |
| [BlocklistParser.swift](Adless/Services/BlocklistParser.swift) / [DomainMatcher.swift](Adless/Services/DomainMatcher.swift) | Helpers de parsing/matching usados pelos XCTest; não fazem parte da resolução DNS |
| [LogoView.swift](Adless/LogoView.swift) / [recursos](Adless/Resources) | Logo, ícones, entitlements, Info.plist e catálogo de strings |

O [projeto](Adless.xcodeproj/project.pbxproj) tem somente `Adless` e
`AdlessTests`, SwiftUI/Combine, StoreKit 2, NetworkExtension, Security e Sentry
via Swift Package Manager. O SDK Sentry está fixado no projeto. Não existe
Packet Tunnel, DNS Proxy, `.appex`, App Group, `.mobileconfig`, configuração
MDM, interface de rede ou rota própria. O entitlement de Network Extension
é exclusivamente `dns-settings`.

## StoreKit e estados

Para teste em iPhone físico com produtos simulados, use
[`tools/ios/install_adless_dev.sh`](../../tools/ios/install_adless_dev.sh). O
script instala `com.orbeworks.adless.dev`, aponta exclusivamente para o Worker
de desenvolvimento e inicia o scheme `Adless Dev` pelo Xcode para ativar
`Adless.storekit`. Ele não instala nem altera o app oficial usado pelos workflows
de TestFlight Internal/External em `develop`.

**Implemented:** `SubscriptionManagerState` separa `checking`, `active` (produto,
prazo e grace), `inactive` e `unavailable`. `Product.products(for:)` carrega os
planos; status do grupo e transações devem estar verificados. Estados
`.subscribed` e `.inGracePeriod` podem conceder acesso até `effectiveUntil`;
revogação e prazo vencido não concedem. Cancelamento da renovação não cancela
imediatamente o período já válido. Compra pendente exibe mensagem, compra
cancelada não concede acesso, resultado não verificado é rejeitado.

`Transaction.updates` acompanha alterações enquanto o processo está vivo;
`AppStore.sync()` restaura compras por ação do usuário. `SubscriptionStorage`
persiste produto, prazo, grace e data da última verificação em Application
Support, com escrita atômica e proteção até o primeiro desbloqueio. Em falha
temporária de consulta StoreKit, o snapshot pode sustentar acesso local somente
até seu prazo; não concede autorização no Worker.

Os produtos e a configuração de oferta local, elegibilidade por grupo e
validação manual no App Store Connect têm fonte canônica em
[ios-release](../../docs/ios-release.md). Não presuma trial disponível para
qualquer assinante apenas porque o paywall o oferece.

## Emissão, rotação e Keychain

**Implemented:** `installationID()` cria UUID interno aleatório. Não usa IDFA,
IDFV, Apple Account ou hardware. `StoredState` versão 2 mantém instalação,
dois tokens de 256 bits, transaction IDs e nonces atual/pendente em um único
Generic Password `installation-state-v2`, com
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Atributo de Keychain não
vincula criptograficamente um bearer token a hardware; posse do token continua
sendo suficiente para apresentá-lo ao servidor. Não prometa exclusão automática
no uninstall ou migração das credenciais para outro dispositivo.

```text
StoreKit verified transaction + AppTransaction, quando disponível
  → persistir installationId e rotationNonce antes da requisição
  → DNSAuthorizationAPIClient.authorize → Worker /v1/authorization/register
  → validar resposta e gravar ambos os tokens + metadados em um commit
  → DNSSettingsManager.install → reler estado Apple → atualizar a UI
```

`authorizationAttempt(transactionId:)` reutiliza exatamente o nonce salvo nos
retries da mesma transação, inclusive após resposta perdida ou escrita falha.
Nova transação recebe nonce novo; pode substituir tentativa pendente anterior
sem apagar o par confirmado. Enquanto existe nonce pendente, `credentials()`
oculta o par antigo. O Worker deriva o par e armazena hashes; o iOS guarda os
bearers porque precisa usá-los. O DNS token compõe o caminho DoH; o stats token
é usado exclusivamente no Bearer de `GET /v1/stats`. Nunca registre o caminho
com token, JWS, nonce ou credenciais.

A migração dos três itens legados preserva instalação e par coerente no blob.
Antes da primeira reconciliação desse par, envia ambos como prova de posse;
retries da mesma tentativa podem repetir a prova até o commit. Não é uma
promessa de apenas uma transmissão HTTP. O token único do MVP antigo é somente
reconhecido e removido após migração/commit, nunca enviado ao servidor. Remoção
dos itens legados é best effort.

Compra, restore e transaction update com acesso válido exigem reconciliação,
mesmo com Keychain preenchido. O primeiro foreground de cada `AppViewModel`
também força reconciliação. Foregrounds seguintes recarregam StoreKit e DNS,
mas não necessariamente fazem outro POST se as credenciais já estão confirmadas.

Se o Worker responder e o commit local de uma rotação falhar, o app tenta
remover o perfil anterior e mantém o nonce para retry. Se a remoção falhar,
orienta Ajustes. Se o par novo foi salvo mas o save das preferências DNS falhar,
recarrega o perfil efetivamente persistido: uma URL antiga é `.staleEnabled`.
No Worker, um token anterior conhecido é pass-through; a UI não confirma
bloqueio dessa configuração residual. Limites dessa continuidade durante falhas
de infraestrutura estão em [dns-cloud](../../docs/dns-cloud.md).

## Instalação, ativação e remoção DNS

**Implemented:** `install()` carrega preferências e configura
`NEDNSOverHTTPSSettings(servers: [])`, origem HTTPS do build, `matchDomains =
[""]`, `matchDomainsNoSearch = true`, sem regras on-demand; no iOS 26+ define
`allowFailover = false`. Depois de salvar, relê. `isEnabled` é somente leitura;
salvar não substitui a ativação explícita do usuário exigida pela
[API DNS Settings da Apple](https://developer.apple.com/documentation/networkextension/dns-settings).

`currentState()` distingue ausência, desabilitada, habilitada, habilitada antiga
e inválida. Para `.enabled`, a preferência precisa pertencer ao Adless, estar
habilitada, ter a URL exata das credenciais atuais e o escopo de domínio esperado.
`remove()` só remove uma configuração reconhecida como Adless e confirma sua
ausência após reler; erros não autorizam afirmar que o DNS foi removido.

A UI usa `AppViewModel.protectionIsConfirmed`: acesso StoreKit + credenciais
presentes + resposta atual do Worker com `blockingEnabled=true` + nenhuma
reconciliação de autorização pendente + estado DNS `.enabled`. O estado remoto
é `unknown`, `enabled` ou `paused`; falha, timeout e resposta inválida permanecem
`unknown` e nunca reutilizam um valor verdadeiro local para afirmar proteção.
`isOn` também é verdadeiro para `.staleEnabled` e não deve dirigir essa
afirmação.

Abertura, foreground, notificação de mudança das preferências e conclusão de
ativação/pausa usam o mesmo reconciliador. Cada execução invalida a anterior e
relê o DNS depois da resposta remota, impedindo que uma resposta antiga ou uma
mudança durante o GET publique estado obsoleto. Mudanças feitas nos Ajustes
executam somente GET; apenas uma ação explícita de ativação/pausa no app envia
PUT. Remoção manual do perfil deve aparecer como desligada e permitir nova
instalação. O botão interno altera somente `blockingEnabled`; o perfil DNS fica
habilitado e o Worker usa pass-through enquanto pausado. Ao perder acesso, o
perfil também é preservado e a autoridade do Worker cessa o bloqueio.

Esse gate confirma o estado local conhecido; não mede saúde atual do Worker,
KV ou upstream nem comprova que todos os apps usam o resolvedor do sistema.

### Tutorial de ativação

**Implemented:** existe alerta textual localizado com o caminho. Não existe
um tutorial com screenshots no código; esse material visual permanece
**Pending** e não foi criado nesta auditoria.

```text
App: compra/restauração → autorização confirmada → botão de ativar
  → aprovar a configuração, se o iOS pedir
  → abrir Ajustes e voltar à tela principal
  → Geral → VPN e Rede (ou VPN e Gerenciamento de Dispositivo)
  → DNS → selecionar Adless
  → voltar ao app → confirmação automática, sem segundo toque
```

| Idioma | Caminho mostrado no catálogo |
| --- | --- |
| PT-BR | Ajustes → Geral → VPN e Rede / VPN e Gerenciamento de Dispositivo → DNS → Adless |
| EN | Settings → General → VPN & Network / VPN & Device Management → DNS → Adless |
| ES | Ajustes → General → VPN y red / VPN y gestión de dispositivos → DNS → Adless |

A nomenclatura do sistema deve ser conferida no iPhone alvo. O botão usa
`UIApplication.openSettingsURLString`, que abre ajustes do app, não uma tela
global de DNS; veja a [API pública](https://developer.apple.com/documentation/uikit/uiapplication/opensettingsurlstring).
Não há deep link público específico de DNS adotável neste fluxo; `App-Prefs:`
e `prefs:` são proibidos. Se a remoção automática falhar, navegue ao mesmo
local e desative Adless manualmente, verificando acesso à rede.

## Contadores e limites

**Implemented:** stats usam sessão efêmera, sem cookies ou cache HTTP, timeout
de 4 segundos; autorização usa timeout de 8 segundos. `refreshCloudStats()`
consulta apenas quando a proteção local está confirmada, no foreground e após
ativação. Falhas mantêm o último total sem desligar proteção. O contador total
nunca diminui; o total diário usa baseline local e não equivale a um histórico
remoto preciso por dia, especialmente após reinstalação ou longos intervalos
sem abrir o app. Os arquivos locais ficam em Application Support; não há App Group.

A configuração é gerida pelo sistema fora do ciclo de vida do processo. Persistência
após reinicialização/tela bloqueada, trocas Wi-Fi/celular, IPv4/IPv6, modo avião,
Private Relay, Limitar Rastreamento de Endereço IP, VPN, outro DNS, captive portal
e redes que bloqueiam DoH exigem iPhone físico. O app não promete prevalecer
sobre essas condições. `allowFailover = false` não cria fallback ao DNS comum
quando Cloudflare/Quad9 ou a infraestrutura Adless falham.

## Limitações verificáveis a revisar

- **Pending — grace na autorização:** `snapshot(from:now:)` aceita prazo de
  grace de `renewalInfo`, mas `currentEntitlementAuthorization()` exige
  `transaction.expirationDate > Date()`. Reconciliação inicial/credenciais novas
  durante grace após vencimento da transação precisa de teste integrado.
- **Pending — atualização temporal:** não há timer dedicado para reconciliação
  StoreKit/expiração no app; updates e foreground disparam avaliação. O gate
  da UI não consulta saúde remota continuamente.
- **Pending — localização:** o catálogo tem EN, PT-BR e ES para as chaves
  presentes, inclusive o tutorial, mas falta a chave legal atual de coleta e
  strings como `Authorizing`, `Reconnect to update DNS protection` e
  `The subscription could not be authorized`. Alertas de remoção e textos
  efetivamente renderizados precisam de conferência; fallback em inglês não é
  tradução concluída. A política também tem descrição de persistência incompleta:
  veja [App Privacy](../../docs/app-store-privacy-questionnaire.md).
- **Pending — outras plataformas:** `SUPPORTED_PLATFORMS` inclui macOS e xros,
  mas isso não comprova suporte funcional nem publicação nessas plataformas.
  Build/archive operacional usa destino iOS explícito. O deployment target
  iOS está no projeto e não é a disponibilidade mínima histórica das APIs.

Build e XCTest estão no [AGENTS local](AGENTS.md); matriz automatizada/física em
[TESTING](../../docs/TESTING.md). Comandos e critérios para artefato assinado,
Sandbox e distribuição são canônicos em [ios-release](../../docs/ios-release.md).
