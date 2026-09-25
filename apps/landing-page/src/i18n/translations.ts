export type Language = "en" | "pt" | "es";

// Legal copy is translated without changing the source policy's meaning.
export type LegalPageId = "privacy" | "terms" | "support";
export type LegalDocument = {
  title: string;
  intro: string;
  sections: { title: string; paragraphs: string[]; steps: string[] }[];
};
export const legalDocuments: Record<
  Language,
  Record<LegalPageId, LegalDocument>
> = {
  en: {
    privacy: {
      intro:
        "Adless is developed by Orbe Works. This Privacy Policy explains what happens when you use the Adless iOS app and website.",
      sections: [
        {
          paragraphs: [
            "All DNS queries selected by iOS for Adless are sent over HTTPS to the Adless DNS service. The edge checks the active blocklist: blocked names are answered there and are not sent to a resolver; permitted names are sent as encrypted DNS-over-HTTPS messages to Cloudflare DNS first, with Quad9 as a fallback. Only DNS uses Adless infrastructure. Websites, videos, messages, and downloads go directly from your device to their destinations.",
          ],
          steps: [],
          title: "What Adless does",
        },
        {
          paragraphs: [
            "Orbe Works does not collect or retain account information, browsing history, DNS query history, advertising identifiers, or payment information through Adless. The app has no account or login. The service stores only an aggregate blocked total associated with an anonymous installation token; it does not store domains, DNS packets, or an application-level history. Because a DoH GET can carry the DNS wire message in the URL and the installation token is part of the endpoint path, Cloudflare may process technical request metadata under its infrastructure and logging systems; Adless does not enable application-level request logging or send these values to Sentry. Permitted DNS queries are transmitted to Cloudflare DNS or Quad9 only to obtain DNS answers; their handling is governed by their own policies. Adless uses Sentry for crash and performance diagnostics, but does not send DNS queries, domain names, browsing history, or the installation token to it.",
          ],
          steps: [],
          title: "Information we collect",
        },
        {
          paragraphs: [
            "Apple processes App Store purchases and subscriptions under Apple's own terms and privacy policy. Cloudflare provides infrastructure for the Adless edge service. Cloudflare DNS and Quad9 process permitted DNS-over-HTTPS queries to return DNS answers under their respective service and privacy policies. Sentry, operated by Functional Software, Inc., processes crash and performance diagnostics for reliability. Adless downloads public, static blocklist files from the public Railway landing service; hosting providers can process standard technical connection information for those requests.",
          ],
          steps: [],
          title: "Third-party services",
        },
        {
          paragraphs: [
            "Adless does not maintain a user account or domain history. The aggregate counter is removed from the app's data when you delete it. The device-bound Keychain token may remain in the Keychain after uninstall on the same device; it is not migrated to a new device. The service retains only aggregate counter data needed to show the total and operate the service; it is not a domain history. This version has no token-deletion endpoint. Apple manages purchase records and subscription history. Adless does not sell data or use DNS queries for advertising.",
          ],
          steps: [],
          title: "Data retention and deletion",
        },
        {
          paragraphs: [
            "DNS encryption protects the connection to the configured service; Adless does not promise anonymity, hide your IP address, prevent infrastructure logs, or guarantee that your internet provider cannot infer destinations. iCloud Private Relay, IP address tracking limits, another DNS profile, a VPN, a captive portal, or network policy can change which resolver iOS uses.",
          ],
          steps: [],
          title: "Important limitations",
        },
        {
          paragraphs: [
            "Adless is not directed at children and does not knowingly collect personal information from children.",
          ],
          steps: [],
          title: "Children",
        },
      ],
      title: "Privacy Policy",
    },
    support: {
      intro:
        "Adless is an encrypted DNS protection app for iPhone. It does not use an Adless account and does not proxy your general internet traffic.",
      sections: [
        {
          paragraphs: [],
          steps: [
            "Make sure the subscription is active in your Apple Account.",
            "Open Adless and tap the main button to enable protection.",
            "Open Settings → General → VPN & Device Management → DNS and enable the Adless DNS configuration if iOS asks for approval.",
            "When a network changes, iOS applies the saved DNS configuration when it remains available.",
          ],
          title: "Before contacting support",
        },
        {
          paragraphs: [
            "Email a_figueiredo@icloud.com with your iOS version and a short description of the issue. Please do not include passwords, payment details, or private browsing history.",
          ],
          steps: [],
          title: "Contact us",
        },
      ],
      title: "Adless Support",
    },
    terms: {
      intro:
        "These Terms of Use govern your use of Adless, a DNS filtering application developed by Orbe Works.",
      sections: [
        {
          paragraphs: [
            "Adless may be offered through monthly and annual auto-renewable subscriptions. A subscription includes the features shown in the app at the time of purchase. Any free trial, price, renewal date, and applicable taxes are displayed by Apple before purchase.",
            "Payment is charged to your Apple Account. Unless canceled through your Apple Account settings at least 24 hours before the end of the current period, a subscription renews automatically. Apple manages billing, refunds, and cancellation.",
          ],
          steps: [],
          title: "Subscriptions",
        },
        {
          paragraphs: [
            "Adless provides DNS-based blocking of domains identified by its edge blocklist. No filtering system can identify every ad, tracker, or domain, and blocking a domain can occasionally affect a website or app. You are responsible for deciding whether to keep the protection enabled.",
          ],
          steps: [],
          title: "Use of the service",
        },
        {
          paragraphs: [
            "We may update the blocklist, app, or service to improve reliability and security. DNS protection depends on the saved iOS configuration and network availability, so uninterrupted operation cannot be guaranteed.",
          ],
          steps: [],
          title: "Availability",
        },
      ],
      title: "Terms of Use",
    },
  },
  pt: {
    privacy: {
      title: "Política de Privacidade",
      intro:
        "O Adless é desenvolvido pela Orbe Works. Esta Política de Privacidade explica o que acontece quando você usa o aplicativo Adless para iOS e o site.",
      sections: [
        {
          title: "O que o Adless faz",
          paragraphs: [
            "Todas as consultas DNS selecionadas pelo iOS para o Adless são enviadas por HTTPS ao serviço DNS do Adless. A edge verifica a lista de bloqueio ativa: os nomes bloqueados são respondidos ali e não são enviados a um resolvedor; os nomes permitidos são enviados como mensagens DNS-over-HTTPS criptografadas primeiro ao Cloudflare DNS, com Quad9 como alternativa. Somente o DNS usa a infraestrutura do Adless. Sites, vídeos, mensagens e downloads vão diretamente do seu dispositivo aos respectivos destinos.",
          ],
          steps: [],
        },
        {
          title: "Informações que coletamos",
          paragraphs: [
            "A Orbe Works não coleta nem retém informações de conta, histórico de navegação, histórico de consultas DNS, identificadores de publicidade ou informações de pagamento por meio do Adless. O aplicativo não possui conta nem login. O serviço armazena somente um total agregado de bloqueios associado a um token anônimo de instalação; não armazena domínios, pacotes DNS nem histórico em nível de aplicação. Como uma requisição DoH GET pode conter a mensagem DNS na URL e o token de instalação faz parte do caminho do endpoint, a Cloudflare pode processar metadados técnicos das requisições em seus sistemas de infraestrutura e logs; o Adless não habilita logs de requisições em nível de aplicação nem envia esses valores ao Sentry. As consultas DNS permitidas são transmitidas ao Cloudflare DNS ou ao Quad9 somente para obter respostas DNS; o tratamento delas é regido pelas políticas desses serviços. O Adless usa o Sentry para diagnóstico de falhas e desempenho, mas não envia consultas DNS, nomes de domínio, histórico de navegação nem o token de instalação a ele.",
          ],
          steps: [],
        },
        {
          title: "Serviços de terceiros",
          paragraphs: [
            "A Apple processa compras e assinaturas da App Store de acordo com seus próprios termos e política de privacidade. A Cloudflare fornece infraestrutura para o serviço de edge do Adless. O Cloudflare DNS e o Quad9 processam consultas DNS-over-HTTPS permitidas para retornar respostas DNS de acordo com suas respectivas políticas de serviço e privacidade. O Sentry, operado pela Functional Software, Inc., processa diagnósticos de falhas e desempenho para melhorar a confiabilidade. O Adless baixa arquivos públicos e estáticos de listas de bloqueio do serviço público da landing page no Railway; os provedores de hospedagem podem processar informações técnicas padrão de conexão nessas requisições.",
          ],
          steps: [],
        },
        {
          title: "Retenção e exclusão de dados",
          paragraphs: [
            "O Adless não mantém uma conta de usuário nem histórico de domínios. O contador agregado é removido dos dados do aplicativo quando você o exclui. O token do Keychain vinculado ao dispositivo pode permanecer no Keychain após a desinstalação no mesmo dispositivo; ele não é migrado para um novo dispositivo. O serviço retém somente os dados agregados do contador necessários para mostrar o total e operar o serviço; não se trata de um histórico de domínios. Esta versão não possui endpoint para exclusão de tokens. A Apple gerencia os registros de compras e o histórico de assinaturas. O Adless não vende dados nem usa consultas DNS para publicidade.",
          ],
          steps: [],
        },
        {
          title: "Limitações importantes",
          paragraphs: [
            "A criptografia DNS protege a conexão com o serviço configurado; o Adless não promete anonimato, não oculta seu endereço IP, não impede logs de infraestrutura nem garante que seu provedor de internet não possa inferir os destinos. A Retransmissão Privada do iCloud, os limites de rastreamento de endereço IP, outro perfil DNS, uma VPN, um portal de autenticação ou a política da rede podem alterar qual resolvedor o iOS usa.",
          ],
          steps: [],
        },
        {
          title: "Crianças",
          paragraphs: [
            "O Adless não é direcionado a crianças e não coleta intencionalmente informações pessoais de crianças.",
          ],
          steps: [],
        },
      ],
    },
    terms: {
      title: "Termos de Uso",
      intro:
        "Estes Termos de Uso regem seu uso do Adless, um aplicativo de filtragem DNS desenvolvido pela Orbe Works.",
      sections: [
        {
          title: "Assinaturas",
          paragraphs: [
            "O Adless pode ser oferecido por meio de assinaturas mensais e anuais com renovação automática. Uma assinatura inclui os recursos exibidos no aplicativo no momento da compra. Qualquer período de teste gratuito, preço, data de renovação e impostos aplicáveis são exibidos pela Apple antes da compra.",
            "O pagamento é cobrado na sua Conta Apple. A menos que seja cancelada nas configurações da sua Conta Apple pelo menos 24 horas antes do fim do período atual, a assinatura será renovada automaticamente. A Apple gerencia a cobrança, os reembolsos e o cancelamento.",
          ],
          steps: [],
        },
        {
          title: "Uso do serviço",
          paragraphs: [
            "O Adless oferece bloqueio baseado em DNS de domínios identificados pela sua lista de bloqueio na edge. Nenhum sistema de filtragem consegue identificar todos os anúncios, rastreadores ou domínios, e o bloqueio de um domínio pode ocasionalmente afetar um site ou aplicativo. Você é responsável por decidir se mantém a proteção ativada.",
          ],
          steps: [],
        },
        {
          title: "Disponibilidade",
          paragraphs: [
            "Podemos atualizar a lista de bloqueio, o aplicativo ou o serviço para melhorar a confiabilidade e a segurança. A proteção DNS depende da configuração salva no iOS e da disponibilidade da rede, portanto não é possível garantir o funcionamento ininterrupto.",
          ],
          steps: [],
        },
      ],
    },
    support: {
      title: "Suporte",
      intro:
        "O Adless é um aplicativo de proteção DNS criptografada para iPhone. Ele não usa uma conta Adless nem atua como proxy do seu tráfego geral de internet.",
      sections: [
        {
          title: "Antes de entrar em contato",
          paragraphs: [],
          steps: [
            "Verifique se a assinatura está ativa na sua Conta Apple.",
            "Abra o Adless e toque no botão principal para ativar a proteção.",
            "Abra Ajustes → Geral → Gestão de VPN e Dispositivo → DNS e ative a configuração DNS do Adless se o iOS solicitar aprovação.",
            "Quando a rede muda, o iOS aplica a configuração DNS salva enquanto ela permanece disponível.",
          ],
        },
        {
          title: "Fale conosco",
          paragraphs: [
            "Envie um e-mail para a_figueiredo@icloud.com com sua versão do iOS e uma breve descrição do problema. Não inclua senhas, dados de pagamento ou histórico privado de navegação.",
          ],
          steps: [],
        },
      ],
    },
  },
  es: {
    privacy: {
      title: "Política de Privacidad",
      intro:
        "Adless es desarrollado por Orbe Works. Esta Política de Privacidad explica qué ocurre cuando usas la aplicación Adless para iOS y el sitio web.",
      sections: [
        {
          title: "Qué hace Adless",
          paragraphs: [
            "Todas las consultas DNS seleccionadas por iOS para Adless se envían por HTTPS al servicio DNS de Adless. El servicio en el edge comprueba la lista de bloqueo activa: los nombres bloqueados se responden allí y no se envían a un resolvedor; los nombres permitidos se envían como mensajes DNS-over-HTTPS cifrados primero a Cloudflare DNS, con Quad9 como alternativa. Solo el DNS utiliza la infraestructura de Adless. Los sitios web, vídeos, mensajes y descargas van directamente desde tu dispositivo a sus destinos.",
          ],
          steps: [],
        },
        {
          title: "Información que recopilamos",
          paragraphs: [
            "Orbe Works no recopila ni conserva información de cuenta, historial de navegación, historial de consultas DNS, identificadores publicitarios ni información de pago a través de Adless. La aplicación no tiene cuenta ni inicio de sesión. El servicio almacena únicamente un total agregado de bloqueos asociado a un token anónimo de instalación; no almacena dominios, paquetes DNS ni un historial a nivel de aplicación. Como una solicitud DoH GET puede incluir el mensaje DNS en la URL y el token de instalación forma parte de la ruta del endpoint, Cloudflare puede procesar metadatos técnicos de las solicitudes en sus sistemas de infraestructura y registros; Adless no habilita registros de solicitudes a nivel de aplicación ni envía estos valores a Sentry. Las consultas DNS permitidas se transmiten a Cloudflare DNS o Quad9 únicamente para obtener respuestas DNS; su tratamiento se rige por sus propias políticas. Adless usa Sentry para diagnósticos de fallos y rendimiento, pero no le envía consultas DNS, nombres de dominio, historial de navegación ni el token de instalación.",
          ],
          steps: [],
        },
        {
          title: "Servicios de terceros",
          paragraphs: [
            "Apple procesa las compras y suscripciones de la App Store conforme a sus propios términos y política de privacidad. Cloudflare proporciona infraestructura para el servicio de edge de Adless. Cloudflare DNS y Quad9 procesan consultas DNS-over-HTTPS permitidas para devolver respuestas DNS conforme a sus respectivas políticas de servicio y privacidad. Sentry, operado por Functional Software, Inc., procesa diagnósticos de fallos y rendimiento para mejorar la fiabilidad. Adless descarga archivos públicos y estáticos de listas de bloqueo del servicio público de la landing page en Railway; los proveedores de alojamiento pueden procesar información técnica estándar de conexión para esas solicitudes.",
          ],
          steps: [],
        },
        {
          title: "Conservación y eliminación de datos",
          paragraphs: [
            "Adless no mantiene una cuenta de usuario ni un historial de dominios. El contador agregado se elimina de los datos de la aplicación cuando la borras. El token de Keychain vinculado al dispositivo puede permanecer en Keychain tras desinstalar la aplicación en el mismo dispositivo; no se migra a un dispositivo nuevo. El servicio conserva únicamente los datos agregados del contador necesarios para mostrar el total y operar el servicio; no es un historial de dominios. Esta versión no tiene un endpoint para eliminar tokens. Apple gestiona los registros de compras y el historial de suscripciones. Adless no vende datos ni utiliza consultas DNS para publicidad.",
          ],
          steps: [],
        },
        {
          title: "Limitaciones importantes",
          paragraphs: [
            "El cifrado DNS protege la conexión con el servicio configurado; Adless no promete anonimato, no oculta tu dirección IP, no impide los registros de infraestructura ni garantiza que tu proveedor de internet no pueda inferir los destinos. La Retransmisión Privada de iCloud, los límites de seguimiento de direcciones IP, otro perfil DNS, una VPN, un portal cautivo o la política de la red pueden cambiar el resolvedor que utiliza iOS.",
          ],
          steps: [],
        },
        {
          title: "Menores",
          paragraphs: [
            "Adless no está dirigido a menores y no recopila conscientemente información personal de menores.",
          ],
          steps: [],
        },
      ],
    },
    terms: {
      title: "Términos de Uso",
      intro:
        "Estos Términos de Uso rigen tu uso de Adless, una aplicación de filtrado DNS desarrollada por Orbe Works.",
      sections: [
        {
          title: "Suscripciones",
          paragraphs: [
            "Adless puede ofrecerse mediante suscripciones mensuales y anuales con renovación automática. Una suscripción incluye las funciones mostradas en la aplicación en el momento de la compra. Apple muestra cualquier prueba gratuita, precio, fecha de renovación e impuestos aplicables antes de la compra.",
            "El pago se carga a tu Cuenta de Apple. A menos que se cancele en los ajustes de tu Cuenta de Apple al menos 24 horas antes del final del período actual, la suscripción se renueva automáticamente. Apple gestiona la facturación, los reembolsos y la cancelación.",
          ],
          steps: [],
        },
        {
          title: "Uso del servicio",
          paragraphs: [
            "Adless ofrece bloqueo basado en DNS de dominios identificados por su lista de bloqueo en el edge. Ningún sistema de filtrado puede identificar todos los anuncios, rastreadores o dominios, y bloquear un dominio puede afectar ocasionalmente a un sitio web o una aplicación. Tú eres responsable de decidir si mantienes la protección activada.",
          ],
          steps: [],
        },
        {
          title: "Disponibilidad",
          paragraphs: [
            "Podemos actualizar la lista de bloqueo, la aplicación o el servicio para mejorar la fiabilidad y la seguridad. La protección DNS depende de la configuración guardada en iOS y de la disponibilidad de la red, por lo que no se puede garantizar un funcionamiento ininterrumpido.",
          ],
          steps: [],
        },
      ],
    },
    support: {
      title: "Soporte Adless",
      intro:
        "Adless es una aplicación de protección DNS cifrada para iPhone. No usa una cuenta Adless ni actúa como proxy de tu tráfico general de internet.",
      sections: [
        {
          title: "Antes de contactar con soporte",
          paragraphs: [],
          steps: [
            "Comprueba que la suscripción esté activa en tu Cuenta de Apple.",
            "Abre Adless y toca el botón principal para activar la protección.",
            "Abre Ajustes → General → Gestión de VPN y dispositivos → DNS y activa la configuración DNS de Adless si iOS solicita aprobación.",
            "Cuando cambia la red, iOS aplica la configuración DNS guardada mientras siga disponible.",
          ],
        },
        {
          title: "Contacta con nosotros",
          paragraphs: [
            "Envía un correo a a_figueiredo@icloud.com con tu versión de iOS y una breve descripción del problema. No incluyas contraseñas, datos de pago ni historial privado de navegación.",
          ],
          steps: [],
        },
      ],
    },
  },
};
export const legalUi = {
  en: {
    back: "Back to Adless",
    updated: "Last updated",
    contents: "On this page",
    related: "Explore Adless",
    skip: "Skip to content",
    language: "Select language",
    light: "Switch to light mode",
    dark: "Switch to dark mode",
    theme: "Toggle theme",
    contact: "Contact support",
    eyebrow: "ADLESS · TRUST & SUPPORT",
  },
  pt: {
    back: "Voltar ao Adless",
    updated: "Última atualização",
    contents: "Nesta página",
    related: "Explore o Adless",
    skip: "Ir para o conteúdo",
    language: "Selecionar idioma",
    light: "Ativar tema claro",
    dark: "Ativar tema escuro",
    theme: "Alternar tema",
    contact: "Entrar em contato",
    eyebrow: "ADLESS · CONFIANÇA E SUPORTE",
  },
  es: {
    back: "Volver a Adless",
    updated: "Última actualización",
    contents: "En esta página",
    related: "Explora Adless",
    skip: "Ir al contenido",
    language: "Seleccionar idioma",
    light: "Activar tema claro",
    dark: "Activar tema oscuro",
    theme: "Cambiar tema",
    contact: "Contactar con soporte",
    eyebrow: "ADLESS · CONFIANZA Y SOPORTE",
  },
};

export const notFoundUi: Record<
  Language,
  {
    title: string;
    description: string;
    action: string;
    eyebrow: string;
  }
> = {
  en: {
    title: "Page not found",
    description: "The page you’re looking for doesn’t exist or may have moved.",
    action: "Back to Adless",
    eyebrow: "ADLESS · 404",
  },
  pt: {
    title: "Página não encontrada",
    description:
      "A página que você procura não existe ou pode ter sido movida.",
    action: "Voltar ao Adless",
    eyebrow: "ADLESS · 404",
  },
  es: {
    title: "Página no encontrada",
    description:
      "La página que buscas no existe o puede haber cambiado de lugar.",
    action: "Volver a Adless",
    eyebrow: "ADLESS · 404",
  },
};

export const translations = {
  en: {
    // Page
    pageTitle: "Adless — Ad Blocking. Done Right.",
    pageDescription:
      "Block ads and trackers across your entire iPhone with encrypted DNS. No Adless account. Just privacy that works.",

    // Hero
    heroHeadline1: "Ad blocking.",
    heroHeadline2: "Done right.",
    heroSubheadline:
      "Block ads and trackers across your entire iPhone with encrypted DNS. No Adless account. Just privacy that works.",
    downloadOnThe: "Download on the",
    appStore: "App Store",
    availableFor: "Available for iPhone and iPad",

    // Benefits
    benefitsTitle: "Why Adless?",
    benefitsSubtitle:
      "Privacy protection that just works. No complexity, no compromises.",
    benefit1Title: "System-wide blocking",
    benefit1Desc: "Works across all apps, not just your browser.",
    benefit2Title: "Real privacy",
    benefit2Desc:
      "No browsing history stored by Adless. You don't need to create an account.",
    benefit3Title: "Light & efficient",
    benefit3Desc:
      "Minimal battery usage with native performance. Once activated, you don't need to keep the app open.",
    benefit4Title: "You're in control",
    benefit4Desc: "Pause and resume blocking from the app whenever you need.",
    benefit5Title: "Built for iPhone",
    benefit5Desc:
      "A simple interface to monitor your protection and blocking totals.",

    // How it works
    howTitle: "How it works",
    howSubtitle: "Set it up once. Control it from the app.",
    step1Title: "Enable in Settings",
    step1Desc:
      "Follow the app's instructions to select Adless as the DNS service in iPhone Settings.",
    step2Title: "Encrypted queries",
    step2Desc:
      "DNS queries are sent over an encrypted connection to the filtering service.",
    step3Title: "Fewer ads and trackers",
    step3Desc: "Known ad and tracker domains are silently blocked.",
    step4Title: "Internet works normally",
    step4Desc: "Everything else loads as usual. Fast and reliable.",
    howNote:
      "The content of web pages, videos, messages, and downloads does not pass through Adless.",
    noteLabel: "Note:",

    // Comparison
    comparisonTitle: "The difference",
    comparisonSubtitle: "Not all ad blockers are created equal.",
    feature: "Feature",
    others: "Others",
    localBlocking: "DNS filtering",
    noExternalServers: "No traffic proxy",
    noSignup: "No sign-up",
    noDataCollection: "No browsing history stored by Adless",
    nativeInterface: "Native iOS interface",
    beyondBrowser: "Protection beyond the browser",

    // Privacy
    privacyTitle1: "Your privacy isn't a feature.",
    privacyTitle2: "It's the default.",
    privacySubtitle:
      "Adless sends encrypted DNS queries to its service for filtering and keeps no domain history.",
    noLogin: "No login required",
    noAccount: "No account needed",
    noTracking: "No tracking",
    noDataSelling: "No data selling",

    // CTA
    ctaTitle: "Ready for a cleaner internet?",
    ctaSubtitle:
      "Download Adless and experience the web the way it should be. Private, fast, and ad-free.",

    // Footer
    privacyPolicy: "Privacy Policy",
    terms: "Terms",
    support: "Support",
    copyright: "All rights reserved.",
  },
  pt: {
    // Page
    pageTitle: "Adless — Bloqueio de anúncios. Do jeito certo.",
    pageDescription:
      "Bloqueie anúncios e rastreadores em todo o iPhone com DNS criptografado. Sem conta Adless. Privacidade que funciona.",

    // Hero
    heroHeadline1: "Bloqueio de anúncios.",
    heroHeadline2: "Do jeito certo.",
    heroSubheadline:
      "Bloqueie anúncios e rastreadores em todo o iPhone com DNS criptografado. Sem conta Adless. Privacidade que funciona.",
    downloadOnThe: "Baixar na",
    appStore: "App Store",
    availableFor: "Disponível para iPhone e iPad",

    // Benefits
    benefitsTitle: "Por que Adless?",
    benefitsSubtitle:
      "Proteção de privacidade que simplesmente funciona. Sem complexidade, sem compromissos.",
    benefit1Title: "Bloqueio em todo sistema",
    benefit1Desc: "Funciona em todos os apps, não só no navegador.",
    benefit2Title: "Privacidade real",
    benefit2Desc:
      "Nenhum histórico guardado pelo Adless. Você não precisa criar uma conta.",
    benefit3Title: "Leve e eficiente",
    benefit3Desc:
      "Consumo mínimo de bateria com performance nativa. Depois de ativado, não é preciso manter o app aberto.",
    benefit4Title: "Você no controle",
    benefit4Desc: "Pause e retome o bloqueio pelo app sempre que precisar.",
    benefit5Title: "Feito para iPhone",
    benefit5Desc:
      "Uma interface simples para acompanhar sua proteção e os totais de bloqueio.",

    // How it works
    howTitle: "Como funciona",
    howSubtitle: "Configure uma vez. Controle pelo app.",
    step1Title: "Ative nos Ajustes",
    step1Desc:
      "Siga as instruções do app para selecionar o Adless como serviço DNS nos Ajustes do iPhone.",
    step2Title: "Consultas criptografadas",
    step2Desc:
      "As consultas DNS são enviadas por uma conexão criptografada ao serviço de filtragem.",
    step3Title: "Menos anúncios e rastreadores",
    step3Desc:
      "Domínios de anúncios e rastreadores conhecidos são bloqueados silenciosamente.",
    step4Title: "Internet funciona normalmente",
    step4Desc: "Todo o resto carrega como sempre. Rápido e confiável.",
    howNote:
      "O conteúdo de páginas, vídeos, mensagens e downloads não passam pelo Adless.",
    noteLabel: "Nota:",

    // Comparison
    comparisonTitle: "A diferença",
    comparisonSubtitle: "Nem todos os bloqueadores são iguais.",
    feature: "Recurso",
    others: "Outros",
    localBlocking: "Filtragem DNS",
    noExternalServers: "Sem proxy de tráfego",
    noSignup: "Sem cadastro",
    noDataCollection: "Sem histórico guardado pelo Adless",
    nativeInterface: "Interface iOS nativa",
    beyondBrowser: "Proteção além do navegador",

    // Privacy
    privacyTitle1: "Sua privacidade não é um recurso.",
    privacyTitle2: "É o padrão.",
    privacySubtitle:
      "O Adless envia consultas DNS criptografadas ao serviço para filtrar e não mantém histórico de domínios.",
    noLogin: "Sem login necessário",
    noAccount: "Sem conta necessária",
    noTracking: "Sem rastreamento",
    noDataSelling: "Sem venda de dados",

    // CTA
    ctaTitle: "Pronto para uma internet mais limpa?",
    ctaSubtitle:
      "Baixe o Adless e experimente a web como ela deveria ser. Privada, rápida e sem anúncios.",

    // Footer
    privacyPolicy: "Política de Privacidade",
    terms: "Termos",
    support: "Suporte",
    copyright: "Todos os direitos reservados.",
  },
  es: {
    // Page
    pageTitle: "Adless — Bloqueo de anuncios. Bien hecho.",
    pageDescription:
      "Bloquea anuncios y rastreadores en todo tu iPhone con DNS cifrado. Sin cuenta de Adless. Privacidad que funciona.",

    // Hero
    heroHeadline1: "Bloqueo de anuncios.",
    heroHeadline2: "Bien hecho.",
    heroSubheadline:
      "Bloquea anuncios y rastreadores en todo tu iPhone con DNS cifrado. Sin cuenta de Adless. Privacidad que funciona.",
    downloadOnThe: "Descargar en",
    appStore: "App Store",
    availableFor: "Disponible para iPhone y iPad",

    // Benefits
    benefitsTitle: "¿Por qué Adless?",
    benefitsSubtitle:
      "Protección de privacidad que simplemente funciona. Sin complejidad, sin compromisos.",
    benefit1Title: "Bloqueo en todo el sistema",
    benefit1Desc: "Funciona en todas las apps, no solo en el navegador.",
    benefit2Title: "Privacidad real",
    benefit2Desc:
      "Adless no guarda tu historial. No necesitas crear una cuenta.",
    benefit3Title: "Ligero y eficiente",
    benefit3Desc:
      "Consumo mínimo de batería con rendimiento nativo. Una vez activado, no necesitas mantener la app abierta.",
    benefit4Title: "Tú tienes el control",
    benefit4Desc:
      "Pausa y reanuda el bloqueo desde la app cuando lo necesites.",
    benefit5Title: "Hecho para iPhone",
    benefit5Desc:
      "Una interfaz sencilla para consultar tu protección y los totales de bloqueos.",

    // How it works
    howTitle: "Cómo funciona",
    howSubtitle: "Configúralo una vez. Contrólalo desde la app.",
    step1Title: "Actívalo en Ajustes",
    step1Desc:
      "Sigue las instrucciones de la app para seleccionar Adless como servicio DNS en los Ajustes del iPhone.",
    step2Title: "Consultas cifradas",
    step2Desc:
      "Las consultas DNS se envían mediante una conexión cifrada al servicio de filtrado.",
    step3Title: "Menos anuncios y rastreadores",
    step3Desc:
      "Los dominios de anuncios y rastreadores conocidos se bloquean silenciosamente.",
    step4Title: "Internet funciona normalmente",
    step4Desc: "Todo lo demás carga como siempre. Rápido y confiable.",
    howNote:
      "El contenido de páginas, vídeos, mensajes y descargas no pasa por Adless.",
    noteLabel: "Nota:",

    // Comparison
    comparisonTitle: "La diferencia",
    comparisonSubtitle: "No todos los bloqueadores son iguales.",
    feature: "Característica",
    others: "Otros",
    localBlocking: "Filtrado DNS",
    noExternalServers: "Sin proxy de tráfico",
    noSignup: "Sin registro",
    noDataCollection: "Adless no guarda tu historial",
    nativeInterface: "Interfaz iOS nativa",
    beyondBrowser: "Protección más allá del navegador",

    // Privacy
    privacyTitle1: "Tu privacidad no es una función.",
    privacyTitle2: "Es el estándar.",
    privacySubtitle:
      "Adless envía consultas DNS cifradas al servicio para filtrar y no conserva un historial de dominios.",
    noLogin: "Sin inicio de sesión",
    noAccount: "Sin cuenta necesaria",
    noTracking: "Sin rastreo",
    noDataSelling: "Sin venta de datos",

    // CTA
    ctaTitle: "¿Listo para un internet más limpio?",
    ctaSubtitle:
      "Descarga Adless y experimenta la web como debería ser. Privada, rápida y sin anuncios.",

    // Footer
    privacyPolicy: "Política de Privacidad",
    terms: "Términos",
    support: "Soporte",
    copyright: "Todos los derechos reservados.",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;
