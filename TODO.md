# Pendências do Adless

Este é um índice de acompanhamento, não autorização para implementar ou publicar.
A [auditoria](docs/REPOSITORY_AUDIT.md) registra evidências e limitações; cada
assunto abaixo tem uma fonte canônica para evitar checklists duplicados.

| Estado | Item | Onde acompanhar |
| --- | --- | --- |
| Implemented | DoH no Worker e fallback sequencial Cloudflare/Quad9 | [Arquitetura](docs/ARCHITECTURE.md) |
| Implemented | Catálogos PT/EN/ES; cobertura de textos novos ainda incompleta | [iOS](apps/ios/README.md) e [landing](apps/landing-page/README.md) |
| Implemented | Troca do logo | [iOS](apps/ios/Adless/Resources/Assets.xcassets) e [landing](apps/landing-page/src/assets/adless-logo.png) |
| Verified | Falhas, troca de rede e proteção real em iPhone | [Testes](docs/TESTING.md) |
| Implemented | Alinhar landing, Privacy Policy, Terms e Support à implementação | [Landing](apps/landing-page/README.md) |
| Pending | Ajustar as cores da landing page para corresponder à nova logo | [Landing](apps/landing-page/README.md) |
| Pending | Ajustar o tutorial de configuração nos Ajustes do iOS | [iOS](apps/ios/README.md) e [testes](docs/TESTING.md) |
| Pending | Adicionar português e espanhol às localizações da App Store | [Apple e lançamento](docs/ios-release.md) |
| Pending | Conferir preços por moeda/território, oferta introdutória e elegibilidade | [Apple e lançamento](docs/ios-release.md) |
| Implemented | Remover os 7 dias gratuitos do plano mensal | [Apple e lançamento](docs/ios-release.md) |
| Pending | Validação remota de Worker/bindings/JWS/notifications e publicação Apple | [Cloudflare](docs/dns-cloud.md) e [Apple](docs/ios-release.md) |

O comportamento de falhas, trocas de rede e proteção real foi validado em
dispositivo físico.

Ideias de produto preservadas, ainda **Pending** de decisão de escopo:

- Adicionar efeito de fundo quando a proteção estiver ativa.

Não transformar ideias ou lacunas registradas em mudanças técnicas durante uma
tarefa documental. Quando resolvidas, atualizar a fonte canônica e anexar evidência
adequada antes de alterar seu estado.
