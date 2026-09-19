# Preparação manual da submissão

Última verificação documental: 2026-09-04. **Implemented:** identidades e URLs
abaixo estão no código/configuração citados. **Pending:** confirmação de todos
os valores efetivamente salvos no App Store Connect e do binary distribuído.
Não houve consulta autenticada ao portal nesta auditoria.

Este documento concentra metadata e texto de revisão. Capability, profiles,
produtos/trial, Sandbox, notificações V2, archive/IPA e gates de distribuição têm
fonte canônica em [ios-release](ios-release.md); não execute publicação como
parte de uma revisão documental.

## Identidade

| Item | Fonte e estado |
| --- | --- |
| Bundle ID `com.orbeworks.adless` | **Implemented:** [Production.xcconfig](../apps/ios/Configurations/Production.xcconfig) |
| App ID numérico ASC | **Implemented:** configuração do Xcode Cloud e `APPLE_APP_ID` do [Worker](../apps/dns-worker/wrangler.toml); conferir correspondência no portal |
| Team ID | **Implemented:** `DEVELOPMENT_TEAM` do [projeto](../apps/ios/Adless.xcodeproj/project.pbxproj) e `teamID` de [ExportOptions.plist](app-store/ExportOptions.plist); verificar profile/certificado reais |
| Versão | **Implemented:** `ci_pre_xcodebuild.sh` consulta o App Store Connect, escolhe a versão aberta/próxima e aplica `MARKETING_VERSION`; `CI_BUILD_NUMBER` define o build |
| Nome comercial `Adless: Clean Web` | **Pending:** registro documental anterior; não confirma o nome salvo no portal. O display name local é `Adless` |
| SKU `ADLESS-IOS-ORBEWORKS-001` | **Pending:** registro documental anterior, sem confirmação em configuração funcional ou evidência remota |

IDs não secretos de configuração devem ser obtidos da fonte acima, sem copiar
identificadores de instalações, testers ou transações para o relatório.

## URLs públicas esperadas

Origem configurada da landing: `https://landing-production-9feb.up.railway.app`.
As rotas existem na [aplicação web](../apps/landing-page/src/App.tsx);
existência local não confirma conteúdo publicado ou acessibilidade:

| Finalidade | URL candidata para conferir antes da submissão |
| --- | --- |
| Marketing | [Landing](https://landing-production-9feb.up.railway.app/) |
| Privacy Policy | [Privacidade](https://landing-production-9feb.up.railway.app/privacy) |
| Termos | [Termos](https://landing-production-9feb.up.railway.app/terms) |
| Support URL | [Suporte](https://landing-production-9feb.up.railway.app/support) |
| Artefato público, não formulário Apple | [Manifesto](https://landing-production-9feb.up.railway.app/blocklists/manifest.json) |

As páginas são estáticas; não há conta, login ou cadastro no app. O app embute
seus textos legais em `SubscriptionView.swift`; não busca manifesto ou lista
nessas URLs. Conteúdo da landing e do app precisa representar a mesma prática
real. Divergências de persistência e privacidade:
[questionário](app-store-privacy-questionnaire.md).

## Checklist do portal

Cada item é **Pending** até verificação manual documentada. Salvar ou modificar
qualquer campo remoto exige autorização explícita.

- Conferir identidade, versão, categoria, classificação etária, territórios,
  disponibilidade e opção de lançamento; preparar metadata e screenshots que
  correspondam ao binary e aos idiomas suportados.
- Conferir contatos de suporte/revisão, acordos, informações fiscais/bancárias
  exigidas e URLs públicas funcionando. Não registrar dados pessoais de conta
  ou credenciais de teste na documentação versionada.
- Conferir produtos, grupo, oferta/elegibilidade, preços e informações de
  revisão de assinaturas conforme [ios-release](ios-release.md).
- Conferir Version 2 e URLs Sandbox/Production de Server Notifications,
  capacidade DNS Settings e profiles do build conforme o mesmo runbook.
- Revisar App Privacy com o [inventário atual](app-store-privacy-questionnaire.md),
  inclusive autorização StoreKit persistida e políticas efetivas dos provedores.
- Conferir declaração de criptografia no portal contra o artefato final.
  **Implemented:** `Info.plist` declara `ITSAppUsesNonExemptEncryption=false`;
  isso é uma declaração do projeto, não aprovação Apple ou conclusão jurídica.
- Executar os gates local → artefato assinado → Sandbox → TestFlight interno →
  externo → App Store; incluir testes de trial inelegível, perda de acesso,
  recuperação de credenciais e indisponibilidade DNS/KV.
- Selecionar o build processado correto. Upload anterior não comprova o binary
  atual; sucesso do workflow não comprova publicação pública.

## Texto de revisão sugerido

Ajustar somente depois de testar o build candidato; não salvar no portal sem
autorização. A orientação abaixo descreve o fluxo implementado, sujeito aos
gates e limitações do [README iOS](../apps/ios/README.md).

> Adless configures Apple’s encrypted DNS settings to block known ad and tracker
> domains. Only DNS queries use the Adless service; websites, videos, messages,
> and downloads go directly to their destinations. No account is required.
> Complete an Apple Sandbox subscription or restore an existing entitlement,
> then use the central button to install DNS protection. Approve and enable
> Adless in Settings if requested. The app provides the navigation steps because
> iOS does not provide a public shortcut to the specific DNS screen. Return to
> Adless to check the protection state. The central button removes the
> configuration when protection is active. Restore Purchase is available in the
> subscription sheet; terms and privacy information are available there too.

Não prometer anonimato, ocultação de IP, ausência de processamento de metadados,
trial para assinantes inelegíveis ou prevalência sobre Private Relay, outra VPN,
DNS próprio de um app ou política da rede. Não oferecer bypass de autorização
para revisão: validar a política Sandbox com o build candidato.
