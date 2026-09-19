# DNS Cloud: protocolo e operação Cloudflare

Fonte canônica do Worker, seus bindings e procedimentos operacionais.
[Segurança](SECURITY.md) centraliza autorização, armazenamento, rotação e
privacidade; [TESTING.md](TESTING.md) centraliza cobertura e critérios de teste;
[blocklists](../tools/blocklists/README.md) centraliza geração das listas.

## Estado local e evidência remota

Última verificação operacional: **2026-09-06, UTC−3**.

| Estado | Evidência | O que permite concluir |
| --- | --- | --- |
| Implemented | [wrangler.toml](../apps/dns-worker/wrangler.toml), [worker.ts](../apps/dns-worker/src/worker.ts), código do workspace | Alvo local `adless-dns`, entrada `src/worker.ts`; não identifica a revisão publicada |
| Deployed / Verified | GET público de `https://adless-dns.orbeworks.workers.dev/healthz`: HTTP 200, `status=ok`, `environment=production` | Há serviço respondendo nesse hostname; health não consulta KV, DO, Apple, blocklist ou upstream |
| Deployed / Verified | GET público de `https://adless-dns-development.orbeworks.workers.dev/healthz`: HTTP 200, `status=ok`, `environment=development`; autorização StoreKit Xcode passou no simulador e no iPhone físico | O Worker Dev está publicado e aceita somente os certificados JWS Xcode explicitamente fixados para `com.orbeworks.adless.dev`; não comprova sozinho a interceptação de consultas DNS |
| Deployed / Verified | Manifesto público da landing em `https://landing-production-9feb.up.railway.app/blocklists/manifest.json`: HTTP 200, versão `vccdec93540613cc1`, 58.216 domínios | Somente disponibilidade/metadados da lista publicada na landing; não confirma bundle do Worker |
| Pending | Sem consulta autenticada da conta nesta auditoria | Deployment ID, version ID, código publicado, bindings efetivos, secret, migrations aplicadas, permissões, faturamento, logs e outros Workers da conta |
| Pending | Sem smoke autenticado ou evento Apple real nesta auditoria | Emissão/rotação, Sandbox/Production, autorização DNS/stats e Notifications V2 remotos |

O repositório declara um alvo de Worker; não prova que seja o único existente
na conta. O nome `DEPLOYMENT_ENV=production` é uma variável, não evidência de
assinatura StoreKit Production nem de implantação da revisão local.

## Endpoints e sequência de uma consulta

Fonte: [handler.ts](../apps/dns-worker/src/handler.ts), `createDNSWorker`.
O DoH aceita RFC 8484 em formato binário; não há resolução JSON, proxy de URL
arbitrária, listener UDP/TCP ou configuração CORS no Worker.

| Ambiente | Origem HTTPS | Consumidor |
| --- | --- | --- |
| Produção | `https://adless-dns.orbeworks.workers.dev` | App oficial em TestFlight/App Store |
| Desenvolvimento | `https://adless-dns-development.orbeworks.workers.dev` | `Adless Dev` executado pelo Xcode |

Os endpoints abaixo são relativos à origem do ambiente selecionado; KV,
Durable Objects, segredo, bundle e política StoreKit também são separados.

| Endpoint Implemented | Método | Contrato |
| --- | --- | --- |
| `/healthz` | GET, HEAD | Saúde superficial e ambiente declarado |
| `/{dnsToken}/dns-query` | POST | Pacote em corpo `application/dns-message`; token Base64URL de 43 caracteres no pathname |
| `/{dnsToken}/dns-query` | GET | Pacote Base64URL sem padding no parâmetro `dns`; mesmo papel de token |
| `/v1/stats` | GET | Bearer stats corrente e assinatura ativa; retorna `blockedTotal`, `updatedAt` |
| `/v1/blocking` | GET, PUT | Bearer stats corrente e assinatura ativa; lê/altera `blockingEnabled` por instalação |
| `/v1/authorization/register` | POST | JSON com JWS/instalação/nonce; retorna o par de tokens; contrato em [SECURITY.md](SECURITY.md) |
| `/v1/notifications/apple` | POST | JSON com `signedPayload` Apple V2, verificado novamente no servidor |

**Implemented:** DoH reconhece hash/papel/instalação em `AUTH` primeiro.
Token desconhecido ou papel inválido termina antes de qualquer DO, cache ou
upstream. Para token corrente conhecido, `authorizeToken` consulta/semeia a
autoridade da assinatura via `AUTHORITY`; somente então decide entre bloqueio,
pass-through e rejeição. Essa etapa já pode persistir um evento de migração.
Autorização não se resume a uma leitura KV.

```text
requisição DoH
  → KV AUTH: mapping hash + papel + instalação
  → AUTHORITY: estado efetivo, se token corrente conhecido
  → STATS: preferência de bloqueio por instalação, se a assinatura está ativa
  → validação de método/tamanho/pacote
  → assinatura + bloqueio ativos: blocklist → cache DNS → Cloudflare DoH → Quad9 em falha
  → pausado ou conhecido sem direito: Cloudflare DoH → Quad9 em falha
  → desconhecido: rejeição; sem DO/cache/upstream
```

Rate limit ocorre antes da leitura do pacote para DNS com bloqueio ativo e para
stats/controle, após a autorização. Pass-through não consulta blocklist, cache
DNS nem contador, e não usa o rate limit. Tokens DNS substituídos não precisam da
autoridade; permanecem pass-through. Apple e Railway não são consultados por
requisição DNS. Estados e falhas KV/DO estão detalhados em
[segurança](SECURITY.md).

## Wire format, listas, cache e upstreams

Fontes: [dns.ts](../apps/dns-worker/src/dns.ts), `parseDNSMessage`,
`blockedResponse`, `cacheKey`, `withTransactionID`, `withRemainingTTL`;
[blocklist.ts](../apps/dns-worker/src/blocklist.ts), `createBlocklist`;
[handler.ts](../apps/dns-worker/src/handler.ts), `loadBlocklist`, `fetchAllowed`.

| Controle Implemented | Valor/comportamento local |
| --- | --- |
| Query | Até 4.096 bytes, uma pergunta, opcode padrão e no máximo 4.096 resource records; valida ponteiros/labels/comprimento |
| Resposta upstream | HTTP 2xx, `application/dns-message`, 1–65.535 bytes, QR, ID e pergunta correspondentes |
| Bloqueio | Classe IN; hostname exato e descendentes; A → `0.0.0.0`, AAAA → `::`, outros tipos → resposta vazia; preserva pergunta, ID e EDNS |
| TTL sintético | 60 segundos no wire; cache HTTP desativado |
| Cache DNS | Memória do isolate, até 512 entradas; chave por UUID + pacote completo com ID zero; expira pelo menor TTL não-OPT, limitado internamente a 86.400 s |
| Cache hit | Reescreve ID atual e todos os TTLs não-OPT com o TTL restante; nenhuma resposta HTTP pública cacheável |
| Rate limit | Até 1.200 requisições/minuto por par hash token/hash IP, DNS ativo e stats; até 4.096 chaves em memória |
| Upstream primário | `https://cloudflare-dns.com/dns-query`, sempre POST HTTPS |
| Fallback | `https://dns.quad9.net/dns-query`, sequencial |
| Timeout/circuit breaker | 1.500 ms por tentativa upstream; após três falhas primárias, ignora Cloudflare por 15 s no isolate |

Uma resposta DNS válida, inclusive NXDOMAIN ou SERVFAIL do upstream, encerra a
tentativa; fallback é para falha de transporte, HTTP/content type, corpo vazio
ou wire inválido. Se ambos falharem, o Worker sintetiza SERVFAIL com HTTP 200.
Não use apenas HTTP 200 como aprovação de resolução. Não adicione fallback
plaintext ou contorno TLS.

O Worker embute `data/blocklist.txt` e `data/blocklist.meta.json`; não busca o
manifesto durante consultas. `loadBlocklist` valida schema, versão, ordenação,
contagem e checksum quando presente no metadata (a preparação atual fornece o
checksum). Lista inválida falha com 500 para assinatura ativa; pass-through
independe dela. O gerador aplica allowlist previamente; não existe allowlist
dinâmica capaz de abrir um subdomínio cujo ancestral continue bloqueado.

A atualização de artefatos usa troca atômica por arquivo, não transação de todo
o conjunto. Nunca edite `data/` ou a lista pública à mão. A geração, validação,
limite de variação, fonte OISD Small e rollback de artefatos pertencem ao
[runbook de blocklists](../tools/blocklists/README.md).

## Configuração Cloudflare

**Implemented:** [wrangler.toml](../apps/dns-worker/wrangler.toml) declara
`workers_dev=true`, `preview_urls=false`, `observability.enabled=false` e
compatibilidade `2026-08-26`. Não há rota de zone ou domínio customizado nesse
arquivo. `workers.dev` usa hostname fornecido pela Cloudflare;
[referência oficial](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

| Binding/variável | Responsabilidade local |
| --- | --- |
| `AUTH` | KV de credenciais, projeções e índices; conferir recurso na conta sem copiar dados ou IDs para documentação |
| `STATS` | Namespace DO de `StatsDurableObject`, IDs derivados do UUID da instalação |
| `AUTHORITY` | Segundo binding da **mesma classe/namespace**, IDs por ambiente e hash de assinatura |
| migration `v1` | `new_sqlite_classes` de `StatsDurableObject`; adicionar o binding AUTHORITY não declara nova classe/migration |
| `AUTH_TOKEN_DERIVATION_SECRET` | Secret necessário à emissão; não é `[vars]` e não deve ser lido/impresso |
| `DEPLOYMENT_ENV` | Rótulo de health, localmente `production` |
| `APPLE_BUNDLE_ID`, `APPLE_APP_ID` | Identificadores esperados de app e notificações Apple; fonte canônica é o TOML |
| `APPLE_ALLOWED_ENVIRONMENTS` | Localmente `Production` no registro normal |
| `APPLE_NOTIFICATION_ENVIRONMENTS` | Localmente `Production,Sandbox` |
| `APPLE_TESTFLIGHT_BUILD_VERSIONS` | Allowlist local dos builds `2` e `6`; não comprova que esses builds foram carregados/aprovados no TestFlight |
| `XCODE_STOREKIT_CERTIFICATE_SHA256` | Somente no ambiente `development`; allowlist separada por vírgulas dos certificados ES256 presentes no `x5c` dos JWS StoreKit 2 do simulador e do aparelho físico. O certificado exportado por **Editor → Save Public Certificate** valida recibos locais e não deve ser presumido igual aos certificados dos JWS |

O ambiente Wrangler `development` publica `adless-dns-development` e declara
bindings próprios de `AUTH`, `STATS` e `AUTHORITY`, além de segredo próprio. Ele
aceita somente `environment=Xcode` e `com.orbeworks.adless.dev`; notificações
Apple e TestFlight ficam desabilitados. O alvo top-level de produção conserva
seus bindings, segredo, bundle e políticas Production/Sandbox.

**Implemented (automação):** os uploads interno e externo da `beta` adicionam o
número validado pela Apple à allowlist do Worker de produção,
via `tools/dns-worker/testflight_builds.py`. O PATCH modifica somente esse binding;
os demais são herdados no servidor. Não faz deploy de código dessas branches,
não abre Sandbox genericamente e não toca KV/DO ou rotas. O deploy de código
da `main` une os números locais aos publicados antes de enviar o Worker.
Os workflows serializam essas operações; não serializam alterações manuais
fora do GitHub. Consultar [distribuição iOS](ios-release.md#automação-de-distribuição)
para secrets, pré-requisitos e limites da evidência.

Não reescreva a migration existente nem recrie namespaces para solucionar uma
falha. KV schema v1/v2 e migração da autoridade são rotinas da aplicação, não
novas migrations Cloudflare; leia [SECURITY.md](SECURITY.md) antes de alterar.
Ausência de `STATS` devolve contador zero/epoch no código; não interprete esse
resultado como prova de binding saudável. Ausência de `AUTHORITY` remove o
direito de bloqueio de credencial reconhecida; registro falha.

## Preparação e validação local

Com dependências já instaladas, da raiz:

```sh
npm run test:dns-worker
npm run build:dns-worker
python3 -B -m unittest discover -s tools/blocklists/tests -v
python3 -B tools/blocklists/validate_blocklist.py
npx --yes wrangler@4 deploy --env="" --dry-run --config apps/dns-worker/wrangler.toml
npx --yes wrangler@4 deploy --env development --dry-run --config apps/dns-worker/wrangler.toml
```

O `build:dns-worker` executa TypeScript com `noEmit`; o teste compila para
`apps/dns-worker/dist-test/` e usa Node com mocks. Dry-run testa bundling sem
publicar, mas gera artefatos locais; `npx` pode baixar Wrangler. Não execute
passos que gravam arquivos funcionais em uma tarefa restrita a Markdown.
Configuração local, mocks e dry-run não validam integrações publicadas.
[Sintaxe Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

Ao preparar uma mudança autorizada de lista, use
`python3 -B tools/dns-worker/prepare_blocklist.py` depois da geração/validação
canônica; esse comando modifica `data/`. `npm ci` também altera dependências e
executa `prepare` da raiz para instalar hooks; consulte
[desenvolvimento](DEVELOPMENT.md). Nenhum desses passos concede autorização de
deploy. Cobertura, falhas simuladas e testes no aparelho: [TESTING.md](TESTING.md).

## Conferência remota sem alterar recursos

Com sessão/credencial já disponibilizada por canal seguro, use comandos de
leitura; nunca exiba valores de secrets, dados de KV ou solicitações reais:

```sh
npx --yes wrangler@4 deployments list --config apps/dns-worker/wrangler.toml
npx --yes wrangler@4 versions list --config apps/dns-worker/wrangler.toml
npx --yes wrangler@4 versions view "$ADLESS_WORKER_VERSION_ID" --config apps/dns-worker/wrangler.toml
npx --yes wrangler@4 secret list --config apps/dns-worker/wrangler.toml
curl --fail --silent --show-error https://adless-dns.orbeworks.workers.dev/healthz
curl --fail --silent --show-error https://adless-dns-development.orbeworks.workers.dev/healthz
```

`ADLESS_WORKER_VERSION_ID` é o identificador não secreto selecionado na lista,
não um token. Compare o deployment ativo e suas versões com o run de deploy
correspondente; registre deployment ID e version ID separadamente quando
obtidos. Version identifica código/configuração; deployment identifica a
ativação e distribuição de tráfego. Armazenamento KV/DO não é versionado com o
código. [Versions e deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

No painel do Worker, confirme bindings efetivos, recurso KV e classe DO,
variáveis não secretas, `workers.dev`, migration aplicada, nomes dos secrets e
configuração de logs. Guarde somente resultado sanitizado. `secret list`
confirma nome/presença, não validade do valor; health não comprova nenhum desses
itens. Sem acesso, mantenha **Pending**. Nunca use leitura de dados de clientes
como smoke.

## Deploy autorizado e smoke

**Implemented:** [.github/workflows/deploy-dns-worker.yml](../.github/workflows/deploy-dns-worker.yml)
publica em push de caminhos selecionados na `main` ou `workflow_dispatch`.
Tem concurrency com cancelamento, timeout de 15 minutos e `contents: read`;
usa `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` vindos de GitHub Secrets.
Esses secrets administrativos não pertencem ao iPhone. Permissões devem se
limitar aos recursos envolvidos; a configuração atual não exige uma zone para
rota customizada. **Pending:** conferir escopo efetivo e presença dos secrets.

O workflow prepara/valida lista e executa build, mas não executa a suíte Worker
nem smoke após deploy. Mudanças apenas em package/lock da raiz não constam nos
paths do gatilho. `wrangler@4` acompanha versões do major, sem fixação de minor.
Essas limitações foram registradas, não corrigidas nesta auditoria.

O Worker `adless-dns-development` é publicado pelo Cloudflare Workers Builds a
partir da branch `develop`, com o ambiente Wrangler `development`. Ele não
modifica o Worker de produção nem a allowlist de builds TestFlight.

Após autorização explícita, revisão do diff, testes e conferência do alvo:

```sh
python3 -B tools/dns-worker/prepare_blocklist.py
python3 -B tools/blocklists/validate_blocklist.py
npm run test:dns-worker
npm run build:dns-worker
npx --yes wrangler@4 deploy --env="" --config apps/dns-worker/wrangler.toml
```

`npm --prefix apps/dns-worker run deploy` também existe, prepara lista e publica,
mas não substitui a sequência de testes. Disparar o workflow é publicação e
exige a mesma autorização. Preserve workspace sujo; prepare revisão isolada se
necessário, sem checkout destrutivo, stash automático, commit ou push implícito.

Para smoke, disponibilize **dois** tokens descartáveis legítimos e ativos em
`ADLESS_DNS_TOKEN` e `ADLESS_STATS_TOKEN` por ambiente seguro já preparado, sem
valores no comando, shell history, logs ou URL exibida:

```sh
python3 -B tools/dns/smoke_worker.py --url https://adless-dns.orbeworks.workers.dev
python3 -B tools/dns/smoke_doh.py
```

[smoke_worker.py](../tools/dns/smoke_worker.py) envia consulta sintética via POST
**e GET** e lê stats. Mesmo smoke de leitura consulta autorização/DO e pode
semear estado; não usar identidade de cliente como fixture.
[smoke_doh.py](../tools/dns/smoke_doh.py) testa Cloudflare/Quad9 diretamente;
`--endpoint cloudflare` ou `--endpoint quad9` seleciona um. Esse teste isolado
não confirma o fallback dentro do Worker.

**Pending para aprovação completa:** os scripts conferem envelope, ID/QR e
content type, mas não rejeitam todo SERVFAIL por rcode nem comprovam bloqueio
real, token inválido, migração ou configuração DNS do iPhone. Complete a matriz
em [TESTING.md](TESTING.md). Não publique só porque health ou smoke básico passou.

## Incidente, rollback e custo

1. Verifique health e resultados agregados de consultas sintéticas; diferencie
   falha de HTTP, autorização, rcode, lista, primário e fallback.
2. Confira deployment/version e bindings sem tail/log de consultas de clientes.
   Uma queda de stats não justifica remover a configuração DNS do iPhone.
3. Prepare rollback para **version ID** conhecido e compatível com os dados
   atuais. Confira schema v1/v2, autoridade e migration antes da autorização.
4. Somente após autorização, execute
   `npx --yes wrangler@4 rollback "$ADLESS_WORKER_VERSION_ID" --config apps/dns-worker/wrangler.toml`
   ou a ação equivalente no painel. Não assuma que rollback de código reverte
   dados KV/DO; recursos alterados e migrations podem impedir rollback.
   [Limites oficiais de rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
5. Repita validação de listas, smoke e roteiro físico compatíveis com o incidente;
   registre versão, status e latência agregada. Não registre tokens, QNAME ou IP.

Mudanças em Cloudflare, secrets, namespaces, migrations, domínio/DNS, Railway
ou App Store Connect exigem autorização explícita. Remover mapping/namespace,
classe DO ou Worker é destrutivo e pode interromper resolução; não é procedimento
de limpeza. Uma correção de infra ou rollback não autoriza commit/push.

Para latência, preserve o roteiro de Wi-Fi/rede móvel e regiões distintas,
registrando p50/p95, tamanho, status e versão. Captive portal, bloqueio de DoH,
Private Relay e outros perfis/VPNs precisam de teste no iPhone, sem promessa de
que Adless prevalece. O app só deve mostrar proteção ativa com estado real
conforme [instruções iOS](../apps/ios/AGENTS.md).

**Pending:** a antiga tabela monetária assumia DO apenas por bloqueio e omitia
KV e autoridade no caminho de cada credencial corrente. Foi substituída pelo
modelo operacional abaixo; não reutilizar aqueles valores como orçamento.
Preserve as dimensões úteis: usuários, consultas/dia, proporção bloqueada,
cache do cliente, leituras de stats e duração/CPU por operação.

Se `D` é volume potencial e `B` a parcela bloqueada, e `h` a fração de bloqueios
que o cache do cliente evita reenviar, as consultas observadas aproximam-se de
`D − B × h`; incrementos stats, de `B × (1 − h)`. TTL 60 só economiza quando o
cliente reutiliza a resposta; TTL 0 não é a implementação atual. Acrescente KV,
chamadas/eventos AUTHORITY, registro/notificações, requests/CPU Worker,
requests/duração/storage DO e retenção de hashes/eventos. Nenhuma taxa `h`,
latência ou custo por usuário foi medida nesta auditoria. Planeje alertas
agregados e orçamento no painel com autorização, sem dimensões por consulta.
Consulte preços vigentes de [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[KV](https://developers.cloudflare.com/kv/platform/pricing/) e
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
antes de contratar; não inferir plano/custo remoto da configuração local.
