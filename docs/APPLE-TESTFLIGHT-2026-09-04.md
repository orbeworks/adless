# Apple e preparação TestFlight — 2026-09-04 (UTC−3)

## Resultado desta execução

- **Verified:** Production e Sandbox têm App Store Server Notifications **V2**
  salvas no App Store Connect para `com.orbeworks.adless`, app `6803552143`.
  URL de ambos: `https://adless-dns.orbeworks.workers.dev/v1/notifications/apple`.
  Conferência posterior pelo portal e por GET autenticado da API oficial.
- **Verified:** App Groups foi desabilitado no App ID. Somente Network Extensions
  e In-App Purchase permanecem selecionados no portal. Não foi removido o
  identificador separado de DNS Proxy, nem o recurso App Group da conta.
- **Verified:** novo profile `Adless AppStore DNS Settings 20260904`, UUID
  `c0f80815-7916-4a20-b3cc-eeae35d86143`, gerado, baixado e instalado.
  Expira em 2027-08-20. Usa o certificado iOS Distribution existente e sua
  chave privada local; nenhum certificado foi criado ou revogado.
- **Verified:** Archive Release e IPA **1.0.1 (6)** gerados com assinatura manual
  de distribuição. A API Apple já mostrava versão 1.0 em `READY_FOR_SALE` e
  builds 1–5 existentes; esses artefatos anteriores não foram publicados por
  esta execução. Os números da nova build foram passados ao Xcode, sem alterar
  a versão no projeto.
- **Verified:** `altool --validate-app` retornou `VERIFY SUCCEEDED with no errors`.
  O IPA foi exportado com `testFlightInternalTestingOnly=true`: não serve para
  TestFlight externo ou App Store. **Não foi feito upload desta build.**

## Profile versus capacidades efetivas

O profile novo não contém App Groups. Tem `get-task-allow=false`, não limita
dispositivos e não é enterprise. A Apple continua incluindo a família de
Network Extensions no allowlist do profile: app-proxy-provider,
content-filter-provider, packet-tunnel-provider, dns-proxy, dns-settings, relay,
url-filter-provider e hotspot-provider.

Isso não habilita esses providers no app. O app assinado contém exatamente:

- `application-identifier` e `com.apple.developer.team-identifier` da equipe;
- `beta-reports-active=true`;
- `get-task-allow=false`;
- `com.apple.developer.networking.networkextension = [dns-settings]`.

Não há `.appex`, Packet Tunnel ou DNS Proxy embutido. O verificador foi ajustado
para exigir que o profile autorize `dns-settings`, mantendo a exigência de
**somente** `dns-settings` na assinatura do app. App Groups e as demais
capabilities extras continuam sendo rejeitados. Essa distinção segue a
[TN3125 da Apple](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).

## Worker publicado

- Worker existente: `adless-dns`.
- Version ID: `6329776b-c624-4c9a-b322-c863fee5b535`.
- Deployment ID: `005d6355-cc5d-48fd-93aa-e1813fa845bd`, tráfego 100%.
- Publicado em `2026-09-05T02:12:54Z`.
- Bindings remotos conferidos: `AUTH`, `STATS`, `AUTHORITY`.
- Presença do secret `AUTH_TOKEN_DERIVATION_SECRET` conferida por nome,
  sem ler seu valor ou rotacioná-lo.
- `APPLE_TESTFLIGHT_BUILD_VERSIONS` passou de `2` para `2,6`.
  O registro normal continua Production; a exceção Sandbox ainda exige os
  JWS correspondentes. Allowlist/AppTransaction não provam origem TestFlight
  exclusiva; não foi acrescentado App Attest.
- Endpoint de produção inalterado e conferido no Info.plist do IPA.

## Testes e limites da evidência

| Verificação executada | Resultado |
| --- | --- |
| Worker, incluindo autorização/estados/rotação/replay com mocks | 78 aprovados |
| XCTest em iPhone 16 Simulator / iOS 26.2 | 19 aprovados |
| Blocklists Python | 10 aprovados; lista validada, sem regeneração |
| Política do profile: DNS único, superset Apple, ausência e tipo inválido | 4 casos aprovados |
| Lint | 0 erros; 8 avisos preexistentes de React Fast Refresh |
| Typecheck, build landing e build Worker | Aprovados |
| Worker dry-run | Aprovado |
| Archive, export, verificadores archive/IPA e codesign | Aprovados |
| Inspeção IPA | Endpoint correto, zero `.appex`, zero arquivos de chave privada e zero marcadores PEM privados encontrados |
| Validação remota Apple do IPA | Sem erros; não equivale a upload/revisão |
| Smoke remoto após deploy | Health 200; DoH GET/POST com token desconhecido 401; stats desconhecido 401; JWS inválido 401; notificação sem assinatura 400 |
| git diff --check | Aprovado |

O smoke inicial com User-Agent padrão `Python-urllib/3.9` recebeu 403 da
Cloudflare, inclusive em health. Curl recebeu 200. Repetição identificada como
`Adless-Release-Smoke/1.0` passou em todos os casos acima; nenhuma regra de
segurança foi alterada. Tempos dessa repetição: health 47 ms, DoH desconhecido
POST 268 ms e GET 50 ms, stats 59 ms, registro inválido 54 ms e notificação
inválida 52 ms. Não são medidas de DNS autorizado nem comparação antes/depois.

Não foi usada transação real de cliente, não se fabricou credencial autorizada
e não se leu conteúdo de KV/DO. Testes locais de assinatura ativa, expiração,
reembolso e revogação não substituem compra e entrega Apple reais. Estados
terminais conhecidos continuam previstos como resolução sem bloqueio/stats;
falhas de infraestrutura e limitações de disponibilidade continuam conforme
[SECURITY.md](SECURITY.md).

## Pendências e teste no iPhone

As URLs não têm mais configuração manual pendente. **Entrega real de
notificação e compra Sandbox permanecem não testadas.**

O portal não possui chave ativa de **Compras dentro do app**. Ela não é
necessária para receber Notifications V2 nem verificar JWS localmente.
É necessária se escolhermos solicitar o evento artificial `TEST` pela
[App Store Server API](https://developer.apple.com/documentation/appstoreserverapi/request-a-test-notification).
As chaves ASC existentes são usadas para operações de distribuição, não
foram copiadas para o Worker ou para o app.

Para esse teste artificial, com autorização para criar a credencial: App Store
Connect → Usuários e acesso → Integrações → Compras dentro do app → Gerar chave;
guardar o `.p8` fora do repositório em armazenamento local protegido. Em seguida,
solicitar TEST nos endpoints Production/Sandbox e consultar Get Test Notification
Status. Não colar chaves ou payloads no chat. Alternativamente, testar a entrega
com eventos de uma compra Sandbox após instalar pelo TestFlight.

Roteiro mínimo após upload autorizado e processamento da build:

1. Associar 1.0.1 (6) ao grupo interno e instalar pelo TestFlight.
2. Abrir o app e comprar um dos produtos reais pelo fluxo Sandbox do TestFlight;
   não usar a fixture `.storekit` do Xcode como prova server-side.
3. Confirmar autorização, salvar o DNS e seguir o tutorial do app até Ajustes
   → Geral → VPN e Rede / VPN e Gerenciamento de Dispositivo → DNS → Adless.
4. Voltar ao app; só então confirmar proteção e incremento do contador com
   tráfego de teste. Verificar também resolução permitida.
5. Exercitar restauração, cancelamento até fim pago, expiração e eventos de
   reembolso/revogação conforme [TESTING.md](TESTING.md), incluindo app fechado,
   retomada, remoção do DNS e conectividade residual. Não registrar tokens/JWS.

## Arquivos e artefatos

Alterações realizadas nesta retomada, preservando o restante do workspace:

- `tools/ios/verify_distribution_profile.sh`: autorizar superset de Network
  Extensions no profile, mantendo a assinatura do app estrita.
- `apps/dns-worker/wrangler.toml`: acrescentar build `6` à allowlist Sandbox.
- Este relatório.

Artefatos locais em `/tmp/adless-apple-ready.KhrCdU/` (diretório temporário):

- `Adless-1.0.1-6.xcarchive`;
- `export/Adless.ipa`;
- `ExportOptions.plist`, `Tests.xcresult`, logs de archive/export/testes/validação.

SHA-256 do IPA: `dc6ba9fcd90e70d96137f2e455e10b4451a57502cf24d64e0d5ce6ba9c5c86d1`.

Não houve commit, push, submissão ou publicação pública. Não houve alteração
em Railway, domínio, nameservers ou rotas. Alterar capabilities invalidou os
profiles antigos do App ID para uso futuro, conforme aviso da Apple; o novo
profile de distribuição foi gerado em seguida.
