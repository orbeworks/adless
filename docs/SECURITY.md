# Segurança, autorização e privacidade

Fonte canônica do modelo de ameaças e dos dados do Adless. **Implemented**
descreve o código local; não atesta controles publicados. Consulte
[arquitetura](ARCHITECTURE.md), [operação Cloudflare](dns-cloud.md) para evidência
remota e [testes](TESTING.md) para cobertura e pendências.

## Limites de confiança

**Implemented:** o iPhone apresenta uma transação StoreKit verificada e o Worker
verifica novamente sua assinatura. O cliente não determina sozinho a validade
da assinatura. O serviço não autentica identidade civil, conta própria ou posse
exclusiva do Apple Account; `installationId` é UUID de instalação, não identidade
de usuário. Não há App Attest no fluxo.

O HTTPS termina na Cloudflare. O Worker vê token e pacote DNS, e o upstream
recebe o pacote permitido, sem o token Adless. Cloudflare e Quad9 são limites
de confiança externos. Railway entrega a landing e artefatos de blocklist;
não participa das consultas DNS nem da autorização de cada consulta.

| Ameaça | Controle Implemented | Limitação / Pending |
| --- | --- | --- |
| Token inventado ou papel trocado | `authorizeToken` exige mapping hash, papel e registro de instalação no KV antes de DO/cache/upstream | KV indisponível sem prova recente retorna erro; nunca liberar token desconhecido |
| Vazamento de token DNS | Bearer opaco, separado de stats, hash no armazenamento | Quem possui o token pode consultar; rotação antiga preserva pass-through, não revoga consumo do upstream |
| Vazamento de token stats | Bearer próprio e assinatura ativa antes de ler contador | Quem possui o token corrente ativo pode ler o agregado; não é autenticação de identidade |
| Replay de JWS válido | Nonce, clocks separados, claims e autoridade serializada | JWS compartilhado pode registrar instalações dentro do limite; claims KV não são linearizáveis |
| Replay após refund/revoke | Eventos imutáveis por assinatura e prioridade de correções Apple | Depende da entrega/processamento do evento e reconhecimento da instalação no KV |
| KV/DO indisponível | DNS conhecido degrada para pass-through; stats é negado | Cold isolate, KV sem resposta e ambos upstreams fora ainda podem impedir resolução |
| Cache mistura usuários ou IDs | Namespace por instalação, pacote normalizado, ID e TTL reescritos, HTTP no-store | Cache em memória contém pacote DNS enquanto vive; não equivale a ausência de processamento |
| Abuso/custo | Wire e tamanho limitados, upstreams fixos, rate token/IP ativo | Limite local por isolate; registro, notificações e DNS pass-through não usam esse limitador |
| Blocklist corrompida | Geração/validação, contagem, ordenação, checksum embutido | Lista inválida retorna 500 no caminho ativo; false positive ainda exige revisão/rollback |
| Logs de plataforma | Sem logging de consulta no código e observabilidade local desativada | Regras da conta, retenção e metadados remotos precisam de auditoria independente |

## Emissão, replay e rotação

Fontes: [authorization.ts](../apps/dns-worker/src/authorization.ts),
`handleAuthorizationRegister`, `registerInstallation`, `deriveTokens`;
[InstallationTokenStore.swift](../apps/ios/Adless/Services/InstallationTokenStore.swift)
e [SubscriptionManager.swift](../apps/ios/Adless/Services/SubscriptionManager.swift).

**Implemented:** `POST /v1/authorization/register` recebe `installationId`,
`transactionJWS`, `rotationNonce` e, para Sandbox, `appTransactionJWS`.
`currentDnsToken` e `currentStatsToken` são prova de credenciais na migração
schema v1 da mesma transação. O cliente persiste o nonce aleatório de 256 bits
antes do POST. HMAC-SHA-256 deriva dois tokens de 256 bits com contexto contendo
papel, instalação, ambiente, assinatura, transação e nonce.

O KV conserva hashes SHA-256 dos tokens e nonce, não os valores. Mesma
instalação/transação/nonce recupera os mesmos tokens se a autoridade ainda
conceder acesso; nonce diferente para a mesma transação schema v2 falha.
Nova transação requer nonce novo. O registro da instalação é gravado após
mappings/claims/índices, como ponto de troca dos hashes correntes. Uma falha
antes dessa troca preserva as credenciais anteriores.

**Implemented:** mappings antigos não são removidos. Token DNS substituído
continua conhecido em pass-through; seu par stats é negado. Isso preserva
resolução após perda da resposta HTTP ou falha ao salvar credenciais no
Keychain. Não descreva rotação como invalidação completa de token DNS vazado.
Não existe endpoint administrativo de revoke/delete/rotação forçada.

**Pending:** claims de transação e índice de até oito instalações por assinatura
estão no KV, sem CAS ou transação multi-chave. Concorrência e propagação podem
atrasar o reconhecimento de token novo ou perder atualizações de índice; o DO
ordena o direito da assinatura, mas não transforma esses índices em registros
fortemente consistentes. A Cloudflare também cacheia leituras negativas.
[Consistência do KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

## Apple JWS, ambientes e notificações

**Implemented:** [apple-jws.ts](../apps/dns-worker/src/apple-jws.ts),
`verifyAppleJWS`, aceita ES256 com cadeia Apple `x5c` de três certificados, raiz
Apple G3 fixada, validade temporal, issuer/subject, extensões Apple e assinaturas
da cadeia. Somente no Worker Dev também aceita o `x5c` único do StoreKit Testing,
após igualdade exata do SHA-256 configurado e validade do certificado.
[authorization.ts](../apps/dns-worker/src/authorization.ts) confere
bundle, produtos permitidos, identificadores e datas. A verificação é local;
não há chamada Apple no caminho DNS. **Pending:** não há verificação online
OCSP/CRL, e a suíte não demonstra uma cadeia Apple válida real de ponta a ponta.

O registro normal aceita Production conforme `APPLE_ALLOWED_ENVIRONMENTS`.
Sandbox usa caminho próprio, independentemente de incluir Sandbox nessa
variável: `validTestFlightAppTransaction` exige AppTransaction Apple com
`receiptType=Sandbox`, bundle correspondente, mesmo `appTransactionId`,
`appAppleId` ausente, data válida e versão do app em `APPLE_TESTFLIGHT_BUILD_VERSIONS`.
Isso limita o uso do JWS, mas não comprova criptograficamente que a execução
veio de TestFlight. A Apple documenta que TestFlight usa Sandbox nas
[notificações](https://developer.apple.com/documentation/appstoreservernotifications/environment).

O ambiente Dev exige simultaneamente `APPLE_ALLOWED_ENVIRONMENTS=Xcode`, bundle
`com.orbeworks.adless.dev`, pin do certificado, Transaction e AppTransaction
Xcode com o mesmo `appTransactionId`. Esses dados ficam em Worker/KV/DO e segredo
separados. O ambiente de produção não possui o pin e continua rejeitando Xcode.

`handleAppleNotification` verifica `signedPayload` e JWS internos de transação
e renovação, cruza bundle, produto, original transaction e ambiente. Em
Production exige `APPLE_APP_ID` correspondente no envelope; em Sandbox o código
exige ausência desse campo. Índices de assinatura, claims de transação e IDs da
autoridade separam Production de Sandbox. UUID de notificação é marcador global;
não concede autorização nem evita reprocessamento.

`processAppleNotification` semeia a autoridade com registros/índices legados e
aplica evento antes de gravar marcador KV com TTL de 45 dias. Mesmo marcador
preexistente não pula migração/aplicação: a idempotência efetiva está nos eventos
imutáveis do DO. Atualizações das projeções KV usam `Promise.allSettled`; uma
falha nelas não desfaz a autoridade persistida.

A função `compareAuthorityEvents` em
[stats.ts](../apps/dns-worker/src/stats.ts), usada por `StatsDurableObject`, ordena períodos por
`purchaseDate` quando ambos existem e por expiração como fallback legado.
Correções do mesmo período vencem transação genérica/reassinada. REFUND/REVOKE
ou `revocationDate` resultam em `revoked`; EXPIRED/GRACE_PERIOD_EXPIRED resultam
em `expired`. `REFUND_REVERSED`, recuperação de cobrança, RESUBSCRIBE e período
posterior podem restaurar acesso. Cancelar renovação não encerra o período pago;
grace period válido pode estender `accessUntil`.

**Pending:** configurar/confirmar Notifications V2 nos dois ambientes e testar
entrega real é tarefa manual no [runbook Apple](ios-release.md). Um handler
existente ou health 200 não prova a configuração do App Store Connect.

## Dados efetivamente armazenados

| Local / fonte | Dados Implemented | Retenção e ressalva |
| --- | --- | --- |
| Keychain iOS / `InstallationTokenStore` | UUID, tokens DNS/stats, nonce e estado da autorização pendente/corrente | `AfterFirstUnlockThisDeviceOnly`; não prometer migração para outro aparelho nem apagar para contornar erro |
| KV `AUTH`, `AuthorizationRecord` | UUID, hashes tokens/nonce, IDs Apple de assinatura/transação/último registro, produto, ambiente, estado, expiração, grace/retry, timestamps e clocks de transação/notificação | Registro schema v2; leitura/migração v1; sem TTL/rotina de limpeza nesses registros |
| KV mappings/índices/claims | Hash token → UUID/papel; IDs Apple/ambiente → UUIDs; marcador de UUID de notificação | Apenas marcador tem TTL de 45 dias; mappings substituídos permanecem |
| DO via `STATS` | `blockedTotal`, `updatedAt` e `blockingEnabled`, objeto nomeado por UUID da instalação | Sem histórico de domínio; preferência controla blocklist/pass-through; sem política de expurgo implementada |
| DO via `AUTHORITY` | `authority:chain`, eventos imutáveis e `authority:latest`: IDs Apple, origem/reason, produto, ambiente, estado, período, grace/retry e datas | Nome do objeto usa hash do original transaction e ambiente; **conteúdo** conserva IDs Apple em claro; sem expurgo implementado |
| Memória do isolate / `handler.ts` | Cache de pacotes DNS por instalação, prova recente de autorização por papel/hash, hash token + hash IP no limitador, estado do circuit breaker | Estruturas limitadas e voláteis; não são armazenamento histórico persistente |

Não persistir token/nonce em claro, JWS bruto, QNAME, pacote DNS, URL completa ou
IP no KV, DO, logs ou analytics. “Somente hashes” refere-se às credenciais,
não aos demais metadados. “Somente contadores” refere-se aos objetos de stats,
não à classe compartilhada usada para autoridade. Identificadores e contadores
por instalação são dados vinculáveis; não chamá-los de estatísticas anônimas.

## Falhas de autorização e disponibilidade

**Implemented:** `authorizeWithAvailability` tenta nova autorização em cada
requisição de token; seu cache não é atalho de assinatura ativa. Após confirmação com
`accessUntil`, mantém prova local por dez minutos, por papel/hash, até 4.096
entradas. Se uma leitura KV lança erro nessa janela, DNS usa somente
pass-through e stats é negado. Cache frio/expirado retorna 503. Ausência de
mapping ou binding `AUTH` é rejeição, não exceção de KV; retorna 401.

Depois de mapping e instalação conhecidos, erro ao ler a projeção legada ou
acessar `AUTHORITY` também degrada DNS para pass-through e nega stats. Cada
chamada ao DO tem timeout de 750 ms; pode haver mais de uma chamada sequencial.
**Pending:** leituras KV não têm timeout explícito na aplicação. Mudança de
isolate, negativa temporária do KV, indisponibilidade do Worker e falha dos dois
upstreams não têm garantia de continuidade. O cache DNS do iPhone pode manter
resposta bloqueada até TTL 60 mesmo após perda de assinatura.

## Logs, secrets e resposta a vazamento

**Implemented:** `wrangler.toml` desativa observabilidade e preview URLs;
não há `console.log`, Sentry ou Analytics Engine no Worker. **Pending:** auditar
Workers Logs, Logpush, tracing, regras de segurança e retenção da conta, sem
coletar consultas reais. O GET DoH põe token no pathname e pacote em `dns` na
query string; POST ainda põe token no pathname. Logs/metadados de plataforma
podem expor esses campos. Prefira POST onde o cliente permitir, mas não
afirme controlar o método escolhido pelo resolver nativo do iOS.

Nunca inclua secrets em código, documentação, logs, comandos exibidos, issues,
screenshots ou shell history. Não execute `env`, dumps de Keychain/KV, `curl -v`,
shell tracing ou tail de requisições reais para diagnosticar autorização.
Credenciais de smoke são injetadas por ambiente seguro conforme
[operação Cloudflare](dns-cloud.md); não imprima o ambiente.

`AUTH_TOKEN_DERIVATION_SECRET` é secret do Worker; o código aceita de 32 a
1.024 bytes UTF-8, e a operação deve fornecer alta entropia. Trocar esse secret
altera a derivação e impede recuperar respostas pendentes/correntes por retry;
não há key ring ou migração automática. Tokens já reconhecidos não dependem
dele no caminho DNS. **Pending:** planejar e testar rotação de secret com
recuperação do cliente antes de qualquer mudança autorizada.

Para vazamento: contenha exposição e identifique somente referências internas
sem copiar a credencial. Uma nova autorização legítima rotaciona o par e
preserva DNS antigo em pass-through. Remover associação KV, aplicar restrição
de edge ou trocar secrets exige autorização explícita e avaliação de impacto
no iPhone; não há procedimento implementado de revogação seletiva que preserve
todas as garantias de conectividade. Para o token administrativo Cloudflare,
prepare substituição de menor privilégio, valide implantação autorizada e só
então revogue o anterior. Nunca altere Cloudflare/GitHub Secrets durante uma
auditoria documental.

Outras pendências verificáveis: `readJSONBody` carrega o corpo inteiro antes da
checagem final de tamanho se o Content-Length não antecipar o limite;
`handleAuthorizationRegister` converte também falhas de infraestrutura em 401,
e `handleAppleNotification` em 400. Não atribua esses status exclusivamente a
fraude/JWS inválido. Priorização e cobertura estão em [TESTING.md](TESTING.md).
