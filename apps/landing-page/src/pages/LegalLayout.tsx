import { ArrowLeft, ArrowRight, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import Footer from "@/components/Footer";
import LanguageSelector from "@/components/LanguageSelector";
import Seo from "@/components/Seo";
import ThemeToggle from "@/components/ThemeToggle";
import adlessLogo from "@/assets/adless-logo.webp";
import { useLanguage } from "@/i18n/LanguageContext";
import { legalDocuments, legalUi } from "@/i18n/translations";
import type { LegalPageId } from "@/i18n/translations";
import { languageHomePath } from "@/lib/site";

const email = "a_figueiredo@icloud.com";

function Paragraph({ text }: { text: string }) {
  return (
    <p>
      {text.split(email).map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 && <a href={`mailto:${email}`}>{email}</a>}
          {part}
        </span>
      ))}
    </p>
  );
}
export default function LegalLayout({ page }: { page: LegalPageId }) {
  const { language } = useLanguage();
  const document = legalDocuments[language][page];
  const ui = legalUi[language];
  const languageHome = languageHomePath(language);
  const localizedPath = `${languageHome.slice(0, -1)}/${page}`;
  const date = new Intl.DateTimeFormat(language === "pt" ? "pt-BR" : language, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date("2026-08-26T12:00:00Z"));
  const toc = document.sections.map((section, index) => ({
    ...section,
    id: `section-${index + 1}`,
  }));
  const links = toc.map((section) => (
    <a
      key={section.id}
      href={`#${section.id}`}
      className="block rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {section.title}
    </a>
  ));

  return (
    <div className="legal-page min-h-screen bg-background text-foreground">
      <Seo
        title={`${document.title} — Adless`}
        description={document.intro}
        path={localizedPath}
        language={language}
        localizedPath={`/${page}`}
      />
      <a
        href="#legal-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:bg-background focus:p-4"
      >
        {ui.skip}
      </a>
      <header className="border-b border-border px-6 py-5">
        <div className="mx-auto max-w-6xl pr-24">
          <Link
            to={languageHome}
            aria-label={ui.back}
            className="inline-flex items-center gap-3 rounded-xl font-semibold"
          >
            <img
              src={adlessLogo}
              alt=""
              width="512"
              height="512"
              className="h-10 w-10 rounded-xl shadow-apple-sm"
            />
            <span>Adless</span>
          </Link>
        </div>
        <LanguageSelector />
        <ThemeToggle />
      </header>
      <main id="legal-content" tabIndex={-1}>
        <section className="border-b border-border bg-gradient-to-b from-secondary/70 to-background px-6 py-12 md:py-16">
          <div className="mx-auto max-w-6xl">
            <Link
              to={languageHome}
              className="mb-8 inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft size={16} />
              {ui.back}
            </Link>
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">{ui.eyebrow}</p>
            <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight leading-tight sm:text-5xl lg:text-6xl">
              {document.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              {document.intro}
            </p>
            <p className="mt-6 text-sm text-muted-foreground">
              {ui.updated}: <time dateTime="2026-08-26">{date}</time>
            </p>
          </div>
        </section>
        <div
          className="mx-auto max-w-6xl px-6 py-12 md:py-16 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16"
        >
          <details
            key={`${language}-${page}`}
            className="mb-10 rounded-2xl border border-border bg-card p-4 lg:hidden"
          >
            <summary className="cursor-pointer font-medium">{ui.contents}</summary>
            <nav aria-label={ui.contents} className="mt-3">
              {links}
            </nav>
          </details>
          <aside className="hidden lg:block">
            <nav
              aria-label={ui.contents}
              className="sticky top-24 border-l border-border pl-3"
            >
              <p className="px-3 pb-3 text-sm font-semibold">{ui.contents}</p>
              {links}
            </nav>
          </aside>
          <article className={`min-w-0 ${page === "support" ? "mx-auto max-w-3xl" : ""}`}>
            {toc.map((section) => (
              <section
                id={section.id}
                key={section.id}
                className="scroll-mt-24 border-b border-border py-8 first:pt-0 last:border-0"
              >
                <h2 className="text-2xl font-semibold tracking-tight">{section.title}</h2>
                <div className="legal-copy mt-5 space-y-5 leading-8 text-muted-foreground">
                  {section.paragraphs.map((text) => (
                    <Paragraph key={text} text={text} />
                  ))}
                  {section.steps.length > 0 && (
                    <ol className="space-y-5">
                      {section.steps.map((step, index) => (
                        <li key={step} className="flex items-start gap-4">
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-foreground"
                          >
                            {index + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                {page === "support" && section.id === "section-2" && (
                  <a
                    href={`mailto:${email}`}
                    className="mt-6 inline-flex items-center gap-3 rounded-xl bg-foreground px-5 py-3 font-medium text-background shadow-apple-sm"
                  >
                    <Mail size={18} />
                    {ui.contact}
                  </a>
                )}
              </section>
            ))}
            <nav aria-label={ui.related} className="mt-10 grid gap-4 sm:grid-cols-2">
              {(["privacy", "terms", "support"] as const)
                .filter((id) => id !== page)
                .map((id) => (
                  <Link
                    key={id}
                    to={`${languageHome.slice(0, -1)}/${id}`}
                    className="flex items-center justify-between gap-3 rounded-2xl bg-card p-5 font-medium shadow-apple-sm hover:bg-secondary"
                  >
                    <span>{legalDocuments[language][id].title}</span>
                    <ArrowRight size={18} className="shrink-0" />
                  </Link>
                ))}
            </nav>
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
