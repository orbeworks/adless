# Testes e critérios de validação

Este é o roteiro canônico de testes. **Implemented** significa teste existente;
**Verified** deve identificar uma execução e seu ambiente; **Pending** identifica
validação ainda necessária. Resultados desta auditoria ficam no
[relatório operacional](REPOSITORY_AUDIT.md), não são garantia da próxima revisão.

## Ordem oficial

Depois de conferir o workspace e as instruções de cada escopo:

```sh
git diff --check
python3 -B -m unittest discover -s tools/blocklists/tests -v
npm run test:dns-worker
npm run lint
npm run typecheck
npm run build:landing
npm run build:dns-worker
python3 -B tools/blocklists/validate_blocklist.py
git status --short --branch
```

Pré-requisitos e instalação estão em [DEVELOPMENT](DEVELOPMENT.md). Não há
`npm test` na raiz. `lint` e `typecheck` cobrem somente a landing;
`build:dns-worker` é `tsc --noEmit`, não bundle/deploy. `test:dns-worker` compila
para `apps/dns-worker/dist-test/` e executa `node --test`; Vite gera `dist/`.
Mudanças somente Markdown exigem validar links, caminhos, comandos, secrets e
diff; não regenerar blocklists, instalar hooks ou produzir artefatos no repositório.
Se testes complementares forem executados, direcione saídas para diretório temporário.

## Cobertura automatizada existente

| Componente / fonte | Implemented: o que os testes demonstram | O que não demonstram |
| --- | --- | --- |
| [Worker](../apps/dns-worker/test/worker.test.ts) | Wire DNS, autorização, migrações, estados e falhas com dependências simuladas | Runtime Cloudflare, propagação real do KV, credenciais Apple válidas ou versão publicada |
| [Contratos de deploy](../tools/dns-worker/tests/test_deploy_workflows.py) | Health checks de produção/desenvolvimento usam `curl`, endpoint e ambiente correspondentes | Disponibilidade remota, propagação do deploy ou validade de secrets |
| [Blocklists](../tools/blocklists/tests/test_blocklists.py) | Parsing/IDN, hosts/Adblock/domínios, deduplicação, allowlist, gzip/checksum, determinismo, rejeição de lista vazia/HTML/variação grande e matriz de domínios | Disponibilidade de download HTTPS real, integridade publicada e aceitabilidade de cada bloqueio |
| [BlocklistTests.swift](../apps/ios/AdlessTests/BlocklistTests.swift) | Helpers de domínio, política de acesso/grace, formatter de oferta, persistência/contador, URLs/payload, gate de proteção e restore | Filtragem DNS no iPhone; elegibilidade real de oferta ou compra Apple |
| [InstallationTokenStoreTests.swift](../apps/ios/AdlessTests/InstallationTokenStoreTests.swift) | Blob único, nonce persistido ao preparar a tentativa, retry após falha de commit, migração antiga e troca de tentativa pendente | POST integrado e acessibilidade real do Keychain após reboot/reinstalação |
| [DNSSettingsManagerTests.swift](../apps/ios/AdlessTests/DNSSettingsManagerTests.swift) | Reload após save falhar; perfil antigo habilitado distinto do endpoint atual | Consentimento, instalação e seleção real do DNS pelo iOS |
| Landing ESLint/TypeScript/Vite | Qualidade estática e compilação | Não há suíte própria de UI, navegação, acessibilidade ou E2E configurada |

### Worker: invariantes já exercitados

A suíte usa KV em memória, DO simulado, relógio/fetch injetados e verificadores
JWS substituídos na maioria dos testes de negócio. Preservar:

- GET/POST, content type, tamanho/método, wire inválido, tipos A/AAAA/HTTPS/SVCB/
  CNAME/TXT/MX/NS/PTR/SOA/SRV, ID, EDNS, matching exato/sufixos/IDN e concorrência.
- Cache com expiração TTL, reescrita do ID e isolamento por instalação;
  NXDOMAIN válido sem fallback; falha de transporte/content type/payload primário
  com Quad9; falha de ambos com SERVFAIL; ausência de upstream em texto puro.
- Token desconhecido recusado **antes** de DO e upstream;
  papéis DNS/stats separados; ausência do secret de derivação não emite tokens.
- Cancelamento válido até o fim pago; grace e billing retry; expiração,
  reembolso e revogação em pass-through sem blocklist, cache DNS, stats ou
  rate limit ativo; stats negado. São testes de política, não eventos Apple reais.
- Retry exato recupera o par; nonce diferente na mesma transação é rejeitado;
  schema v1 da mesma transação exige prova das duas credenciais; falha antes do commit KV conserva
  credenciais anteriores; perda da resposta após commit permite recuperação.
- Migração v1/v2 e autoridade legada para DO vazio; índice perdido em concorrência;
  projeção KV antiga não desfaz revogação; evento de período anterior não vence
  renovação; watermarks de transação/notificação independentes; `REFUND_REVERSED`,
  `RESUBSCRIBE` e `BILLING_RECOVERY`; isolamento de Production/Sandbox.
- KV indisponível: credencial recentemente conhecida degrada e desconhecida
  não resolve. DO indisponível/timeout: conhecida resolve em pass-through;
  stats/registro/notificação não obtêm autorização ativa.

### Pending: lacunas que não podem ser tratadas como testes aprovados

- JWS Apple válido com cadeia real: só há caso negativo do verificador real;
  testes positivos de autorização injetam payloads verificados.
- KV entre regiões, limites/concorrência no runtime Cloudflare, migrações e
  notificações reais, failover real TLS/HTTP e interrupção dos provedores.
- O teste `unknown tokens are rejected before cache, Durable Object, and upstream`
  pretende aquecer o cache, mas não injeta `now` no Worker: a fixture de
  assinatura já expirou perante o relógio real e a consulta inicial faz
  pass-through. A asserção de uma chamada upstream não comprova cache populado.
  Ajustar a fixture e comprovar cache ativo em tarefa de testes separada.
- Vencimento exato da janela de dez minutos de reconhecimento: teste atual
  avança 62 segundos; não cobre expiração completa dessa memória.
- Timeout temporizado dos upstreams e circuit breaker: mock lança erro chamado
  timeout, mas isso não testa o AbortController. O timeout do DO tem caso específico.
- Resposta upstream vazia/HTTP não-2xx como casos dedicados, falha de stats e
  concorrência de incrementos, e checksum SHA-256 adulterado no carregamento
  assíncrono do Worker. O teste com “checksum” no nome altera a contagem.
- HTTP real dos clientes Swift e ciclo completo StoreKit/Keychain/NetworkExtension.
- Grace após `transaction.expirationDate`, divergência entre oferta anunciada e
  elegibilidade e textos/localizações: limitações em [README iOS](../apps/ios/README.md).
- Provar ausência de dados sensíveis exige inspeção de código e configurações
  do provedor; a suíte não é um scanner completo de logs/privacidade.

Mudanças no caminho DNS devem acrescentar a cobertura relevante **antes de serem
aprovadas**, incluindo credencial desconhecida sem fail-open e continuidade de
resolução de instalação conhecida após perda de assinatura/rotação. Não provoque
falhas destruindo bindings/dados de produção. Use mocks e ambiente de teste
previamente autorizado; lacunas atuais não são autorização para criar serviços.

## XCTest e build iOS

Escolha um simulador instalado com `xcodebuild -showdestinations` antes de testar:

```sh
xcodebuild -project apps/ios/Adless.xcodeproj -scheme AdlessTests -showdestinations
xcodebuild -project apps/ios/Adless.xcodeproj -scheme AdlessTests \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath /tmp/adless-ios-test-derived-data \
  CODE_SIGNING_ALLOWED=NO test
xcodebuild -project apps/ios/Adless.xcodeproj -scheme Adless \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /tmp/adless-ios-build CODE_SIGNING_ALLOWED=NO build
```

Substitua o nome de exemplo por um destino listado que suporte o target mínimo
do projeto Xcode. Os schemes são explicados no [runbook iOS](ios-release.md). Build/simulador não comprovam
interceptação DNS. `Adless.storekit` simula StoreKit no Xcode; não comprova JWS
aceito pela raiz Apple do Worker. TestFlight usa Sandbox; distribuição pública
precisa repetir a validação com os produtos/ambiente reais.

Para instalar no iPhone o app de desenvolvimento com essa sessão StoreKit e o
Worker de desenvolvimento, mantenha o aparelho desbloqueado e execute:

```sh
tools/ios/install_adless_dev.sh
```

O instalador valida bundle ID, ambiente, endpoint e entitlements antes de
instalar, depois inicia o app pelo LaunchAction `Adless Dev` do Xcode. Esse teste
não é equivalente ao TestFlight: `develop` alimenta separadamente TestFlight
Internal e External, que usam o Sandbox da Apple e o app oficial.

## Matriz manual no iPhone

**Pending até registrar evidências por build/dispositivo/ambiente.** Partir de
uma assinatura de teste aceita e seguir o tutorial visual do
[README iOS](../apps/ios/README.md). Não arquivar tokens, JWS, QNAMEs ou URLs
completas nas evidências.

| Cenário | Critério objetivo de aprovação |
| --- | --- |
| Compra mensal/anual, restauração e trial | StoreKit verificado, autorização Worker concluída, tokens persistidos; oferta só conforme elegibilidade; cancelamento não antecipa expiração |
| Salvar sem habilitar em Ajustes | UI não indica proteção; mostra navegação manual para DNS |
| Habilitar e voltar ao app | Estado real recarregado; endpoint atual + assinatura + credenciais + ausência de reconciliação pendente |
| Pausar e retomar pelo botão | DNS permanece habilitado; pausado resolve domínio bloqueado via upstream sem incrementar stats; retomar volta a bloquear sem abrir Ajustes |
| Remover/desabilitar manualmente em Ajustes | Nova leitura mostra desligado; Ativar pode recriar configuração |
| Falha ao salvar novo endpoint com perfil antigo ativo | `staleEnabled`; UI não confirma proteção; token antigo resolve em pass-through |
| Worker indisponível no startup/restore | UI não confirma autorização só por possuir tokens; retry reaproveita nonce persistido |
| Resposta recebida, commit Keychain falha | Token não confirmado não é instalado; tenta remover perfil antigo; falha de remoção mostra orientação manual |
| Expiração/reembolso/revogação | UI não confirma proteção após reconciliação; perfil DNS permanece e resolve sem bloqueio; stats é negado |
| Cancelamento/grace/billing recovery | Comparar prazo pago, grace e evento recebido no Worker; testar startup após expiração da transação durante grace |
| Stats indisponível | Último total mantido sem reduzir contador ou desligar DNS |
| Reboot, horas com tela bloqueada, app encerrado | DNS selecionado pelo iOS continua operando; ler novamente ao abrir o app |
| Wi-Fi/celular, IPv4/IPv6, modo avião e retorno | Recuperação de resolução nas redes suportadas; nenhuma afirmação de disponibilidade em modo avião |
| Safari, outro navegador e apps | Bloqueio de domínio de teste conhecido e nome permitido resolvido; validar resposta DNS, não apenas animação da UI |
| Private Relay, Limitar Rastreamento de Endereço IP, outra VPN/perfil e captive portal | Registrar interferências e seleção real do sistema; não prometer precedência |
| PT/EN/ES, iPhone/iPad, texto ampliado | Tutorial e estados legíveis, sem chaves/literais não traduzidos |

Perda de ambos os upstreams ou do Worker pode interromper DNS. O teste esperado
é SERVFAIL/erro coerente e recuperação ao restabelecer o serviço, não internet
ininterrupta nem fallback silencioso para DNS em texto puro.

## Smoke remoto e limites

Executar somente contra alvo/credenciais de teste apropriados. Para o Worker,
`ADLESS_DNS_TOKEN` e `ADLESS_STATS_TOKEN` precisam estar injetados com segurança no
ambiente, sem valores na linha de comando, histórico ou saída:

```sh
python3 -B tools/dns/smoke_worker.py --url https://adless-dns.orbeworks.workers.dev
python3 -B tools/dns/smoke_doh.py
```

[smoke_worker.py](../tools/dns/smoke_worker.py) usa TLS do sistema e verifica
POST/GET, content type, QR/transaction ID e formato de stats. **SERVFAIL pode
passar esse smoke**: ele não afirma resposta útil, host bloqueado, replay,
expiração ou migração. [smoke_doh.py](../tools/dns/smoke_doh.py) consulta os
provedores diretamente e também não testa autorização/roteamento do Worker.
Nenhum deles prova operação no iPhone. Nunca use `curl -k`.

Health check sem credenciais prova somente resposta HTTP daquele handler.
Deployment ID, bindings, estado remoto, smoke após publicação e rollback estão
em [dns-cloud](dns-cloud.md). Não mostrar dumps KV/DO ou exportar tráfego real.

## Gates de distribuição

Para mudanças iOS, seguir [ios-release](ios-release.md): XCTest, build, archive,
`verify_archive.sh`, `verify_distribution_profile.sh`, exportação e
`verify_ipa.sh`, depois revisão Apple e testes físicos por etapa. O comando
`-allowProvisioningUpdates` pode modificar recursos Apple e exige autorização.
A existência de um verificador ou workflow não prova que foi executado nem que
capabilities/profiles remotos correspondem ao binário atual.
