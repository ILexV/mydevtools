/**
 * Category registry — the site's information architecture.
 *
 * Source: legacy `Home.razor → GetToolsByCategoryForSections()` (12 categories),
 * plus a `generators` group for the 4 tools the legacy catalog never placed
 * (uuid-generator, lorem-ipsum-generator) and re-homing date-converter →
 * converters, pdf-to-text → pdf. Final IA is a Stage 2 design decision; this
 * registry is the single place to change it.
 *
 * `iconKey` names an entry in the future icon family (Stage 6); values are
 * placeholders that resolve once the icon set is chosen.
 */

export type CategoryId =
  | "images"
  | "design"
  | "hashing"
  | "encoding"
  | "structured-data"
  | "text"
  | "cryptography"
  | "jwt"
  | "regex"
  | "qrcode"
  | "pdf"
  | "converters"
  | "generators";

export interface CategoryMeta {
  id: CategoryId;
  /** Localization key in the `categories` namespace, e.g. `images`. */
  labelKey: string;
  /** Icon family key (resolved in Stage 6). */
  iconKey: string;
  /** Display sort order in the catalog. */
  order: number;
}

export const CATEGORIES: readonly CategoryMeta[] = [
  { id: "encoding", labelKey: "Category_Encoding", iconKey: "encoding", order: 10 },
  { id: "structured-data", labelKey: "Category_StructuredData", iconKey: "structured-data", order: 20 },
  { id: "text", labelKey: "Category_TextTools", iconKey: "text", order: 30 },
  { id: "jwt", labelKey: "Category_JwtAndTokens", iconKey: "jwt", order: 40 },
  { id: "regex", labelKey: "Category_Regex", iconKey: "regex", order: 50 },
  { id: "hashing", labelKey: "Category_HashingAndSecurity", iconKey: "hashing", order: 60 },
  { id: "cryptography", labelKey: "Category_Cryptography", iconKey: "cryptography", order: 70 },
  { id: "generators", labelKey: "Category_Generators", iconKey: "generators", order: 80 },
  { id: "converters", labelKey: "Category_Converters", iconKey: "converters", order: 90 },
  { id: "design", labelKey: "Category_ColorsAndDesign", iconKey: "design", order: 100 },
  { id: "images", labelKey: "Category_Images", iconKey: "images", order: 110 },
  { id: "pdf", labelKey: "Category_PdfTools", iconKey: "pdf", order: 120 },
  { id: "qrcode", labelKey: "Category_QrCodes", iconKey: "qrcode", order: 130 },
] as const;

export const CATEGORY_IDS: readonly CategoryId[] = CATEGORIES.map((c) => c.id);

export function isCategoryId(value: string): value is CategoryId {
  return CATEGORY_IDS.includes(value as CategoryId);
}

export function getCategory(id: string): CategoryMeta | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
