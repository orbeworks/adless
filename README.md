# Adless

Monorepo de um app SwiftUI, um serviço DNS Cloudflare Worker e uma landing
estática React/Vite. O iPhone configura DNS criptografado nativo; o Worker
bloqueia domínios de anúncios/rastreadores e resolve nomes permitidos por
Cloudflare DoH, com Quad9 como fallback. O tráfego de sites e apps segue
diretamente aos destinos. Railway serve o site e os artefatos públicos da lista,
fora do caminho das consultas DNS.

**Implemented:** assinatura StoreKit 2, autorização por JWS Apple, credenciais
separadas de DNS/stats, KV e Durable Objects para autorização e contadores.
O projeto não tem conta, login, Packet Tunnel, DNS Proxy ou extensão embutida.
Configuração local de produtos, trial, workflows ou bindings não comprova que
os serviços remotos estão configurados. Evidências e pendências de operação
ficam em [dns-cloud](docs/dns-cloud.md) e [ios-release](docs/ios-release.md).

## Branches e distribuição

| Branch | Finalidade | Destino |
| --- | --- | --- |
| `develop` | Desenvolvimento e validação do app oficial/Dev, conforme o workflow escolhido | Worker Dev no Xcode e TestFlight |
| `main` | Produção do app oficial e dos serviços públicos | App Store e Worker de produção |

A promoção esperada é `develop` → `main`. Pushes em `develop` abrem uma PR
para `main` quando ainda não existe uma aberta; a automação nunca executa o
merge. Veja [Desenvolvimento](docs/DEVELOPMENT.md) e
[Apple e lançamento](docs/ios-release.md).

## Comece aqui

Leia [AGENTS.md](AGENTS.md) antes de editar. Para preparar o ambiente e entender
scripts/hooks, use [DEVELOPMENT](docs/DEVELOPMENT.md); para contribuir, use
[CONTRIBUTING](CONTRIBUTING.md). Validações oficiais estão em
[TESTING](docs/TESTING.md).

```sh
npm ci
npm run dev:landing
```

`npm ci` também instala hooks Git locais. No iOS, abra
`apps/ios/Adless.xcodeproj`. O simulador valida UI/build/testes; a resolução DNS
real exige iPhone. Não execute comandos de publicação sem autorização.

## Documentação por responsabilidade

| Fonte canônica | Conteúdo |
| --- | --- |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Fluxos, responsabilidades, confiança e decisões |
| [SECURITY](docs/SECURITY.md) | Ameaças, dados persistidos, privacidade e rotação |
| [DEVELOPMENT](docs/DEVELOPMENT.md) | Ambiente, scripts, hooks e workflows |
| [TESTING](docs/TESTING.md) | Cobertura, lacunas, comandos e matriz no iPhone |
| [iOS README](apps/ios/README.md) / [instruções](apps/ios/AGENTS.md) | Estado da UI, StoreKit, tokens, DNS nativo e localização |
| [dns-cloud](docs/dns-cloud.md) / [instruções Worker](apps/dns-worker/AGENTS.md) | Protocolo, configuração Cloudflare, deploy autorizado e incidentes |
| [Landing README](apps/landing-page/README.md) | Rotas, tradução, conteúdo público e publicação do site |
| [Blocklists README](tools/blocklists/README.md) | Fontes, allowlist, geração, integridade e rollback |
| [THIRD_PARTY_BLOCKLISTS](THIRD_PARTY_BLOCKLISTS.md) | Atribuição/licença das fontes |
| [ios-release](docs/ios-release.md) | Apple Developer, StoreKit, archive/IPA, TestFlight e App Store |
| [app-store-submission](docs/app-store-submission.md) | Metadados e material de submissão |
| [app-store-privacy-questionnaire](docs/app-store-privacy-questionnaire.md) | Revisão manual de App Privacy |
| [Auditoria](docs/REPOSITORY_AUDIT.md) | Divergências, evidências e limitações identificadas |
| [TODO](TODO.md) | Índice de pendências e ideias de produto |

**Implemented**, **Deployed**, **Verified** e **Pending** descrevem evidências
distintas; não são etapas automaticamente equivalentes. Datas de verificação
pertencem aos relatórios operacionais, não às instruções permanentes dos agentes.
