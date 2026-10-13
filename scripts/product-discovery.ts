import { GithubHttpError, isJsonRecord } from "./github-api.ts";
import { CliError, parseJson } from "./runtime-command.ts";

// A repository either keeps its manifests in .github/ (layout "root", one product with the empty
// name) or declares each product in its own directory under projects/ (layout "projects"). The two
// layouts never mix. Deploy and follow reuse this module, so it knows nothing about releases beyond
// the release manifest's root and release key.
export const PRODUCTS_DIRECTORY = "projects";
export const ROOT_MANIFEST_DIRECTORY = ".github";

export const PRODUCT_FILE_NAMES = [
  "release.manifest.json",
  "deploy.json",
  "follows.json",
  "deploy.secrets.required",
  "deploy.secrets.allowed",
] as const;
export type ProductFileName = (typeof PRODUCT_FILE_NAMES)[number];

// A directory under projects/ is a product only when it carries one of these files.
const PRODUCT_MARKER_FILE_NAMES: readonly ProductFileName[] = [
  "release.manifest.json",
  "deploy.json",
  "follows.json",
];

const MAX_PRODUCT_FILE_BYTES = 64 * 1024;
const productNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

export type ProductLayout = "root" | "projects";

export type DiscoveredProduct = {
  // The directory name under projects/, or the empty string for the root layout.
  name: string;
  // Repository-relative directory that holds the product's files.
  directory: string;
  // Repository-relative build root from the release manifest. The empty string is the repository root.
  root: string;
  // The release key from the release manifest, or the empty string when there is no release manifest.
  release_key: string;
  // The text of each product file that exists.
  files: Partial<Record<ProductFileName, string>>;
};

export type ProductDiscovery = {
  layout: ProductLayout;
  products: DiscoveredProduct[];
};

export type ContentReader = {
  get(path: string): Promise<unknown>;
};

type ContentEntry = {
  name: string;
  type: string;
  size: number;
};

export function isProductName(value: string): boolean {
  return productNamePattern.test(value);
}

export function isRepositoryRelativePath(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.includes("..") &&
    value.split("/").every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== ".")
  );
}

/**
 * The root is the build directory, relative to the repository root. The root layout may omit it or
 * leave it empty; the projects layout must declare a non-empty path.
 */
export function parseProductRoot(value: unknown, layout: ProductLayout): string {
  if (value === undefined && layout === "root") {
    return "";
  }
  const isValid =
    typeof value === "string" &&
    (value === "" ? layout === "root" : isRepositoryRelativePath(value));
  if (!isValid) {
    throw new CliError(
      layout === "root"
        ? "Release manifest root must be empty or a relative repository path without '..'."
        : "Product release manifest must declare root as a relative repository path without '..'.",
      65
    );
  }
  return value as string;
}

function contentsPath(repository: string, path: string, sha: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `repos/${repository}/contents/${encoded}?ref=${sha}`;
}

export function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub contents response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

function parseContentEntry(value: unknown): ContentEntry {
  if (
    !isJsonRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    typeof value.size !== "number"
  ) {
    throw new CliError("GitHub directory listing is invalid.", 65);
  }
  return { name: value.name, type: value.type, size: value.size };
}

// A missing directory lists as empty; the caller decides whether that is an error.
async function listDirectory(
  reader: ContentReader,
  repository: string,
  directory: string,
  sha: string
): Promise<ContentEntry[]> {
  let response: unknown;
  try {
    response = await reader.get(contentsPath(repository, directory, sha));
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) {
      return [];
    }
    throw error;
  }
  if (!Array.isArray(response)) {
    throw new CliError(`Expected a directory but GitHub returned a file: ${directory}.`, 65);
  }
  return response.map(parseContentEntry);
}

function fileSizes(entries: readonly ContentEntry[]): Map<string, number> {
  return new Map(
    entries.filter((entry) => entry.type === "file").map((entry) => [entry.name, entry.size])
  );
}

async function readProductFile(
  reader: ContentReader,
  repository: string,
  path: string,
  sha: string,
  size: number
): Promise<string> {
  if (size > MAX_PRODUCT_FILE_BYTES) {
    throw new CliError(`Product file is larger than 64 KiB: ${path}.`, 65);
  }
  const text = decodeGithubContent(await reader.get(contentsPath(repository, path, sha)));
  if (Buffer.byteLength(text, "utf8") > MAX_PRODUCT_FILE_BYTES) {
    throw new CliError(`Product file is larger than 64 KiB: ${path}.`, 65);
  }
  return text;
}

async function readProduct(
  reader: ContentReader,
  repository: string,
  sha: string,
  product: {
    name: string;
    directory: string;
    layout: ProductLayout;
    sizes: Map<string, number>;
  }
): Promise<DiscoveredProduct> {
  const files: Partial<Record<ProductFileName, string>> = {};
  for (const fileName of PRODUCT_FILE_NAMES) {
    const size = product.sizes.get(fileName);
    if (size !== undefined) {
      files[fileName] = await readProductFile(
        reader,
        repository,
        `${product.directory}/${fileName}`,
        sha,
        size
      );
    }
  }

  const base = { name: product.name, directory: product.directory, files };
  const releaseText = files["release.manifest.json"];
  if (releaseText === undefined) {
    return { ...base, root: "", release_key: "" };
  }

  const manifest = parseJson(
    releaseText,
    `Release manifest must be valid JSON: ${product.directory}/release.manifest.json.`,
    65
  );
  if (!isJsonRecord(manifest)) {
    throw new CliError(
      `Release manifest must be a JSON object: ${product.directory}/release.manifest.json.`,
      65
    );
  }
  return {
    ...base,
    root: parseProductRoot(manifest.root, product.layout),
    release_key: typeof manifest.release_key === "string" ? manifest.release_key : "",
  };
}

function assertUniqueReleaseKeys(products: readonly DiscoveredProduct[]): void {
  const owners = new Map<string, string[]>();
  for (const product of products) {
    if (product.release_key !== "") {
      owners.set(product.release_key, [
        ...(owners.get(product.release_key) ?? []),
        product.directory,
      ]);
    }
  }
  const duplicates = [...owners].filter(([, directories]) => directories.length > 1);
  if (duplicates.length > 0) {
    throw new CliError(
      `Release key is declared by more than one product: ${duplicates
        .map(([key, directories]) => `${key} (${directories.join(", ")})`)
        .join("; ")}.`,
      65
    );
  }
}

/**
 * Finds the products of one repository at one commit, reading only through the contents API so the
 * control domain never executes repository code.
 */
export async function discoverProducts(
  reader: ContentReader,
  repository: string,
  sha: string
): Promise<ProductDiscovery> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(sha)) {
    throw new CliError("Product discovery source identity is invalid.", 64);
  }

  const products: DiscoveredProduct[] = [];
  for (const entry of await listDirectory(reader, repository, PRODUCTS_DIRECTORY, sha)) {
    if (entry.type !== "dir") {
      continue;
    }
    const directory = `${PRODUCTS_DIRECTORY}/${entry.name}`;
    const sizes = fileSizes(await listDirectory(reader, repository, directory, sha));
    if (!PRODUCT_MARKER_FILE_NAMES.some((fileName) => sizes.has(fileName))) {
      continue;
    }
    if (!isProductName(entry.name)) {
      throw new CliError(
        `Product directory name is invalid: ${directory}. Use 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit.`,
        65
      );
    }
    products.push(
      await readProduct(reader, repository, sha, {
        name: entry.name,
        directory,
        layout: "projects",
        sizes,
      })
    );
  }

  const rootSizes = fileSizes(
    await listDirectory(reader, repository, ROOT_MANIFEST_DIRECTORY, sha)
  );
  const hasRootManifest = PRODUCT_MARKER_FILE_NAMES.some((fileName) => rootSizes.has(fileName));

  if (products.length > 0) {
    if (hasRootManifest) {
      throw new CliError(
        `Repository has root manifests in ${ROOT_MANIFEST_DIRECTORY}/ and products under ${PRODUCTS_DIRECTORY}/. Keep only one layout.`,
        65
      );
    }
    assertUniqueReleaseKeys(products);
    return { layout: "projects", products };
  }

  if (!hasRootManifest) {
    return { layout: "root", products: [] };
  }
  const rootProduct = await readProduct(reader, repository, sha, {
    name: "",
    directory: ROOT_MANIFEST_DIRECTORY,
    layout: "root",
    sizes: rootSizes,
  });
  return { layout: "root", products: [rootProduct] };
}

/**
 * Picks the product a request names. A repository with one product needs no name; with several, the
 * name is required and must be one of the discovered directories.
 */
export function selectProduct(
  products: readonly DiscoveredProduct[],
  requested: string
): DiscoveredProduct {
  if (products.length === 0) {
    throw new CliError("No product manifest was found in the source repository.", 65);
  }

  if (products.every((product) => product.name === "")) {
    if (requested !== "") {
      throw new CliError(
        "The source repository has a single root manifest and no named products. Leave product empty.",
        64
      );
    }
    return products[0] as DiscoveredProduct;
  }

  const names = products.map((product) => product.name);
  if (requested === "") {
    if (products.length === 1) {
      return products[0] as DiscoveredProduct;
    }
    throw new CliError(
      `Product is required because the source repository has several products. Choose one of: ${names.join(", ")}.`,
      64
    );
  }

  if (!isProductName(requested)) {
    throw new CliError(`Product name is invalid: ${requested}.`, 64);
  }
  const match = products.find((product) => product.name === requested);
  if (!match) {
    throw new CliError(`Unknown product: ${requested}. Choose one of: ${names.join(", ")}.`, 64);
  }
  return match;
}
