import { parse as parseYaml } from "yaml";
import { Lexer } from "marked";
import type {
  Book,
  Chapter,
  Issue,
  Source,
  TreeEntry,
  ValidationReport,
} from "./types";

export const SAMPLE_URL =
  "https://github.com/djordjeveljkovic/chatgpt-php-book";
export const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
};
export function sourceId(source: Source) {
  return [
    source.owner.toLowerCase(),
    source.repo.toLowerCase(),
    source.branch,
    source.root,
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function parseRepoUrl(input: string): { owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "Paste a full GitHub repository URL, such as https://github.com/owner/book.",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.hostname !== "github.com" ||
    url.protocol !== "https:" ||
    url.port ||
    parts.length !== 2 ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Use the repository URL: https://github.com/owner/repository. Choose the branch separately.",
    );
  }
  const [owner, name] = parts;
  const repo = name.replace(/\.git$/, "");
  if (!/^[a-zA-Z0-9-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo))
    throw new Error("The GitHub owner or repository name is invalid.");
  return { owner, repo };
}

export function normalizeRoot(root: string): string {
  const clean = root.trim().replace(/^\/+|\/+$/g, "");
  if (
    !clean ||
    clean.includes("\\") ||
    clean.split("/").some((p) => p === ".." || p === "." || !p)
  )
    throw new Error("Enter a repository-relative book folder, such as book.");
  return clean;
}

export function frontMatter(markdown: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { meta: {}, body: normalized };
  const meta: unknown = parseYaml(match[1], { maxAliasCount: 50 });
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("Front matter must contain a YAML mapping.");
  return {
    meta: meta as Record<string, unknown>,
    body: normalized.slice(match[0].length),
  };
}

function numeric(value: unknown, fallback: number): number {
  const selected = value === undefined || value === null ? fallback : value;
  const n =
    typeof selected === "number" ||
    (typeof selected === "string" && /^\d+$/.test(selected))
      ? Number(selected)
      : NaN;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Volume and chapter numbers must be positive integers.");
  return n;
}

export function isChapter(path: string, root: string): boolean {
  return (
    path.startsWith(`${root}/volumes/`) &&
    /\.md$/i.test(path) &&
    !/(^|\/)README\.md$/i.test(path) &&
    !path.split("/").some((part) => part.startsWith("_"))
  );
}

export function parseChapter(path: string, text: string, sha = ""): Chapter {
  const { meta, body } = frontMatter(text);
  for (const field of [
    "title",
    "slug",
    "volume_title",
    "status",
    "book",
    "summary",
  ]) {
    if (
      meta[field] !== undefined &&
      meta[field] !== null &&
      typeof meta[field] !== "string"
    )
      throw new Error(`Chapter ${field} metadata must be text.`);
  }
  if (
    meta.slug !== undefined &&
    (typeof meta.slug !== "string" || !meta.slug.trim())
  )
    throw new Error("Chapter slug cannot be empty.");
  if (
    meta.title !== undefined &&
    (typeof meta.title !== "string" || !meta.title.trim())
  )
    throw new Error("Chapter title cannot be empty.");
  if (
    meta.status !== undefined &&
    ![
      "planned",
      "draft",
      "drafting",
      "in-progress",
      "review",
      "complete",
      "unspecified",
    ].includes(String(meta.status))
  )
    throw new Error(
      "Chapter status must be planned, draft, drafting, in-progress, review, or complete.",
    );
  const segments = path.split("/");
  const filename = segments.at(-1)!;
  const volumeDir = segments.at(-2)!;
  const volume = numeric(
    meta.volume,
    Number(volumeDir.match(/^(\d+)/)?.[1] || 0),
  );
  const number = numeric(
    meta.chapter,
    Number(filename.match(/^(\d+)/)?.[1] || 0),
  );
  if (!volume || !number)
    throw new Error(
      "Provide volume/chapter metadata or numbered directory and file names.",
    );
  const heading = body.match(/^#\s+(.+)$/m)?.[1];
  const title = String(meta.title || heading || "").trim();
  if (!title)
    throw new Error("Provide a title in front matter or a top-level heading.");
  const slug = String(meta.slug || path).trim();
  if (!slug) throw new Error("Chapter slug cannot be empty.");
  return {
    id: slug,
    path,
    title,
    volume,
    number,
    volumeTitle: String(
      meta.volume_title || volumeDir.replace(/^\d+-/, "").replace(/-/g, " "),
    ),
    status: String(meta.status || "unspecified"),
    markdown: body,
    plainText: plainText(body),
    blobSha: sha,
  };
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n/g, "\n")
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^[#>*\s-]+/gm, "")
    .replace(/[`*_~]/g, "");
}

export function resolvePath(
  from: string,
  href: string,
): { path: string; hash: string } | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null;
  const [rawPath, rawHash = ""] = href.split("#");
  const raw = rawPath.split("?")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const result = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!result.length) return null;
      result.pop();
    } else result.push(part);
  }
  return { path: raw ? result.join("/") : from, hash: rawHash };
}

export function markdownLinks(
  markdown: string,
): { href: string; image: boolean }[] {
  const links: { href: string; image: boolean }[] = [];
  function walk(tokens: unknown[]) {
    for (const raw of tokens) {
      const token = raw as {
        type?: string;
        href?: string;
        tokens?: unknown[];
        items?: unknown[];
        header?: unknown[];
        rows?: unknown[][];
      };
      if ((token.type === "link" || token.type === "image") && token.href)
        links.push({ href: token.href, image: token.type === "image" });
      if (Array.isArray(token.tokens)) walk(token.tokens);
      if (Array.isArray(token.items)) walk(token.items);
      if (Array.isArray(token.header)) walk(token.header);
      if (Array.isArray(token.rows)) token.rows.forEach(walk);
    }
  }
  walk(Lexer.lex(markdown));
  return links;
}

function inlineText(tokens: ReturnType<typeof Lexer.lexInline>): string {
  return tokens
    .map((token) =>
      "tokens" in token && Array.isArray(token.tokens)
        ? inlineText(token.tokens)
        : "text" in token
          ? String(token.text)
          : token.type === "html"
            ? token.raw.replace(/<[^>]*>/g, "")
            : "",
    )
    .join("");
}

export function headingSlug(text: string): string {
  return inlineText(Lexer.lexInline(text))
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi,
      (entity) => {
        const named: Record<string, string> = {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": "\u00a0",
        };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
        const code = entity.toLowerCase().startsWith("&#x")
          ? parseInt(entity.slice(3, -1), 16)
          : Number(entity.slice(2, -1));
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "\ufffd";
      },
    )
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function headingSlugs(markdown: string): string[] {
  const slugs: string[] = [];
  const seen = new Map<string, number>();
  function walk(tokens: unknown[]) {
    for (const raw of tokens) {
      const token = raw as {
        type: string;
        tokens?: ReturnType<typeof Lexer.lexInline>;
        items?: unknown[];
        text?: string;
      };
      if (token.type === "heading") {
        const slug = headingSlug(
          token.tokens ? inlineText(token.tokens) : token.text || "",
        );
        const number = seen.get(slug) || 0;
        seen.set(slug, number + 1);
        slugs.push(number ? `${slug}-${number}` : slug);
      } else {
        if (Array.isArray(token.tokens)) walk(token.tokens);
        if (Array.isArray(token.items)) walk(token.items);
      }
    }
  }
  walk(Lexer.lex(markdown));
  return slugs;
}

export function validateDocuments(
  documents: Record<string, string>,
  entries: TreeEntry[],
  root: string,
): { chapters: Chapter[]; report: ValidationReport } {
  const issues: Issue[] = [];
  const chapters: Chapter[] = [];
  const known = new Set(entries.map((e) => e.path));
  const identities = new Set<string>();
  const numbers = new Set<string>();
  if (!documents[`${root}/README.md`])
    issues.push({
      severity: "error",
      path: root,
      message: "Missing book/README.md index.",
    });
  for (const [path, text] of Object.entries(documents)) {
    if (!isChapter(path, root)) continue;
    try {
      const chapter = parseChapter(
        path,
        text,
        entries.find((e) => e.path === path)?.sha,
      );
      if (identities.has(`${chapter.volume}:${chapter.id}`))
        throw new Error(
          `Duplicate chapter identity in volume ${chapter.volume}: ${chapter.id}. Use unique slugs within each volume.`,
        );
      if (numbers.has(`${chapter.volume}:${chapter.number}`))
        throw new Error("Duplicate chapter number within this volume.");
      identities.add(`${chapter.volume}:${chapter.id}`);
      numbers.add(`${chapter.volume}:${chapter.number}`);
      chapters.push(chapter);
      if (/^(planned|draft|drafting|in-progress|review)$/.test(chapter.status))
        issues.push({
          severity: "warning",
          path,
          message: `Chapter status is ${chapter.status}.`,
        });
    } catch (error) {
      issues.push({
        severity: "error",
        path,
        message: (error as Error).message,
      });
    }
  }
  if (!chapters.length)
    issues.push({
      severity: "error",
      path: root,
      message: "No readable chapters found under volumes/.",
    });
  const slugCounts = new Map<string, number>();
  for (const chapter of chapters)
    slugCounts.set(chapter.id, (slugCounts.get(chapter.id) || 0) + 1);
  for (const chapter of chapters) {
    if ((slugCounts.get(chapter.id) || 0) > 1) {
      issues.push({
        severity: "warning",
        path: chapter.path,
        message: `Slug ${chapter.id} appears in multiple volumes; its reading identity includes the volume number.`,
      });
    }
    chapter.id = `${chapter.volume}:${chapter.id}`;
  }
  // An explicit slug can itself resemble a qualified identity.
  const uniqueIds = new Set<string>();
  for (const chapter of chapters) {
    if (uniqueIds.has(chapter.id))
      issues.push({
        severity: "error",
        path: chapter.path,
        message: `Conflicting chapter identity: ${chapter.id}. Choose another slug.`,
      });
    uniqueIds.add(chapter.id);
  }
  const volumeTitles = new Map<number, string>();
  for (const chapter of chapters) {
    if (
      volumeTitles.has(chapter.volume) &&
      volumeTitles.get(chapter.volume) !== chapter.volumeTitle
    ) {
      issues.push({
        severity: "error",
        path: chapter.path,
        message: "Conflicting titles for the same volume number.",
      });
    }
    volumeTitles.set(chapter.volume, chapter.volumeTitle);
  }
  for (const [path, text] of Object.entries(documents)) {
    let body: string;
    try {
      body = frontMatter(text).body;
    } catch (error) {
      if (
        !issues.some(
          (issue) => issue.path === path && issue.severity === "error",
        )
      )
        issues.push({
          severity: "error",
          path,
          message: (error as Error).message,
        });
      continue;
    }
    for (const link of markdownLinks(body)) {
      const target = resolvePath(path, link.href);
      if (!target) {
        if (link.image)
          issues.push({
            severity: "warning",
            path,
            message: `External image will not be available offline: ${link.href}`,
          });
        continue;
      }
      if (target.path.includes("/_ai/") || target.path.endsWith("/_ai"))
        continue;
      const resolved = known.has(target.path)
        ? target.path
        : `${target.path}/README.md`;
      if (!known.has(resolved))
        issues.push({
          severity: link.image ? "error" : "warning",
          path,
          message: `Broken internal link: ${link.href}`,
        });
      else if (target.hash && documents[resolved]) {
        let targetBody: string;
        try {
          targetBody = frontMatter(documents[resolved]).body;
        } catch {
          continue;
        }
        const slugs = headingSlugs(targetBody);
        let hash = target.hash;
        try {
          hash = decodeURIComponent(hash);
        } catch {
          /* keep original */
        }
        if (!slugs.includes(hash))
          issues.push({
            severity: "warning",
            path,
            message: `Missing heading anchor: ${link.href}`,
          });
      }
    }
  }
  chapters.sort(
    (a, b) =>
      a.volume - b.volume ||
      a.number - b.number ||
      a.path.localeCompare(b.path),
  );
  return {
    chapters,
    report: { issues, chapters: chapters.length, volumes: volumeTitles.size },
  };
}

export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function bookHref(book: Book) {
  return `https://github.com/${book.source.owner}/${book.source.repo}`;
}
export function findChapter(book: Book, id: string, path?: string) {
  return (
    book.chapters.find((c) => c.id === id) ||
    book.chapters.find((c) => c.path === path)
  );
}
