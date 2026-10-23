/**
 * JSON-LD structured data builders.
 *
 * Mirrors the legacy `MetaTags.razor` structured-data contract:
 *  - Home page → WebSite + Organization.
 *  - Tool page → SoftwareApplication (free web dev tool) + BreadcrumbList.
 *
 * All URLs are absolute (required by schema.org) and base-aware (GitHub Pages).
 * The objects are serialized to `<script type="application/ld+json">` by `Seo.astro`.
 */
import type { LocaleCode } from "@/registry/locales";
import { absoluteUrl, localizedPath, withBase } from "@/lib/url";
import { parseHowToSteps } from "@/lib/markdown";
import { LOCALES } from "@/registry/locales";
import { t } from "@/i18n/messages";

/** Public source repository, linked from the footer and Organization.sameAs. */
const SOURCE_URL = "https://github.com/ILexV/mydevtools";

export interface SeoInput {
  locale: LocaleCode;
  /** Tool slug, or empty string for the home page. */
  path?: string;
  title: string;
  description: string;
  isHome: boolean;
  /**
   * `Seo_HowToSteps` markdown ("### Step N: Title\nBody …"), tool pages only.
   * When it parses to at least one step, a HowTo schema is appended — mirrors
   * the legacy `MetaTags.razor` `HowToSteps` parameter.
   */
  howToSteps?: string;
}

/** Absolute URL of the 512×512 app icon, reused as Organization logo. */
function logoUrl(): string {
  return absoluteUrl(withBase("icons/icon-512.png"));
}

/** Build the JSON-LD object array for the current page context. */
export function buildJsonLd(input: SeoInput): Record<string, unknown>[] {
  const { locale, path = "", title, description, isHome, howToSteps } = input;
  const inLanguage = LOCALES.find((l) => l.code === locale)?.bcp47 ?? locale;

  if (isHome) {
    const siteUrl = absoluteUrl(localizedPath(locale));
    // No SearchAction: Google retired the sitelinks search box (2024) and the
    // catalog search has no query URL to template.
    return [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: title,
        url: siteUrl,
        description,
        inLanguage,
      },
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: title,
        url: siteUrl,
        logo: logoUrl(),
        sameAs: [SOURCE_URL],
      },
    ];
  }

  // Tool page.
  const toolUrl = absoluteUrl(localizedPath(locale, path));
  const homeUrl = absoluteUrl(localizedPath(locale));

  const app: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: title,
    description,
    url: toolUrl,
    inLanguage,
    applicationCategory: "DeveloperApplication",
    operatingSystem: path === "http-client" || path === "path-trace" || path === "dns-lookup" || path === "tcp-connect" || path === "tls-inspect" || path === "whois-lookup" || path === "asn-lookup" || path === "port-scanner" || path === "network-scanner" ? "Windows 10, Windows 11" : "Web Browser",
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };

  // Home → tool. The category has no page of its own (only a home anchor), and a
  // crumb that repeats the home URL is reported as an invalid item by Google.
  const crumbs: Record<string, unknown>[] = [
    { "@type": "ListItem", position: 1, name: t(locale, "common", "Nav_Home"), item: homeUrl },
    { "@type": "ListItem", position: 2, name: title, item: toolUrl },
  ];

  const schemas: Record<string, unknown>[] = [
    app,
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs,
    },
  ];

  // HowTo schema from Seo_HowToSteps markdown (legacy MetaTags.razor parity).
  if (howToSteps) {
    const steps = parseHowToSteps(howToSteps);
    if (steps.length > 0) {
      schemas.push({
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: title,
        description,
        step: steps.map((s, i) => ({
          "@type": "HowToStep",
          position: i + 1,
          name: s.name,
          text: s.text,
        })),
      });
    }
  }

  return schemas;
}
