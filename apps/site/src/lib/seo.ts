/**
 * JSON-LD structured data builders.
 *
 * Mirrors the legacy `MetaTags.razor` structured-data contract:
 *  - Home page → WebSite (with SearchAction) + Organization + BreadcrumbList.
 *  - Tool page → SoftwareApplication (free web dev tool) + BreadcrumbList.
 *
 * All URLs are absolute (required by schema.org) and base-aware (GitHub Pages).
 * The objects are serialized to `<script type="application/ld+json">` by `Seo.astro`.
 */
import type { LocaleCode } from "@/registry/locales";
import { absoluteUrl, localizedPath, withBase } from "@/lib/url";
import { parseHowToSteps } from "@/lib/markdown";

export interface SeoInput {
  locale: LocaleCode;
  /** Tool slug, or empty string for the home page. */
  path?: string;
  title: string;
  description: string;
  isHome: boolean;
  /** Localized category name (tool pages only) — inserted as a breadcrumb. */
  categoryName?: string;
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

function trim(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Build the JSON-LD object array for the current page context. */
export function buildJsonLd(input: SeoInput): Record<string, unknown>[] {
  const { locale, path = "", title, description, isHome, categoryName, howToSteps } = input;

  if (isHome) {
    const siteUrl = absoluteUrl(trim(localizedPath(locale)));
    return [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: title,
        url: siteUrl,
        description,
        // Client-side search lives on the home page; the SearchAction points there.
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: siteUrl,
          },
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: title,
        url: siteUrl,
        logo: logoUrl(),
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: title, item: siteUrl },
        ],
      },
    ];
  }

  // Tool page.
  const toolUrl = absoluteUrl(trim(localizedPath(locale, path)));
  const homeUrl = absoluteUrl(trim(localizedPath(locale)));

  const app: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: title,
    description,
    url: toolUrl,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web Browser",
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };

  const crumbs: Record<string, unknown>[] = [
    { "@type": "ListItem", position: 1, name: "Home", item: homeUrl },
  ];
  if (categoryName) {
    crumbs.push({ "@type": "ListItem", position: 2, name: categoryName, item: homeUrl });
    crumbs.push({ "@type": "ListItem", position: 3, name: title, item: toolUrl });
  } else {
    crumbs.push({ "@type": "ListItem", position: 2, name: title, item: toolUrl });
  }

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
