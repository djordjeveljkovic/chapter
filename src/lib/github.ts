import {
  IMAGE_MIME_TYPES,
  bookHref,
  frontMatter,
  isChapter,
  markdownLinks,
  normalizeRoot,
  parseRepoUrl,
  resolvePath,
  sourceId,
  validateDocuments,
  parseGeneralDocuments,
} from "./format";
import { loadDraft, saveDraft } from "./storage";
import type {
  Asset,
  Book,
  Discovery,
  Draft,
  Source,
  TransferProgress,
  TreeEntry,
} from "./types";

const API = "https://api.github.com";
const rawURL = (source: Source, commit: string, path: string) =>
  `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
const endpoint = (source: Pick<Source, "owner" | "repo">) =>
  `${API}/repos/${source.owner}/${source.repo}`;
const blobURL = (source: Pick<Source, "owner" | "repo">, sha: string) =>
  `${endpoint(source)}/git/blobs/${encodeURIComponent(sha)}`;

async function response(
  url: string,
  signal?: AbortSignal,
  token = "",
  accept?: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const headers = new Headers();
      if (accept) headers.set("Accept", accept);
      // Never send a GitHub credential to raw.githubusercontent.com or any other host.
      if (token && new URL(url).origin === API) {
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("Accept", accept || "application/vnd.github+json");
      }
      const res = await fetch(url, {
        headers,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
      if (res.ok) return res;
      if (res.status === 401 && token)
        throw new Error(
          "GitHub rejected the saved access token. Replace it in Library settings, then try again.",
        );
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        if (token && res.status === 403 && remaining !== "0")
          throw new Error(
            "GitHub denied access. Check that this fine-grained token includes the repository and has Contents read permission.",
          );
        const reset = res.headers.get("x-ratelimit-reset");
        throw new Error(
          `GitHub temporarily limited requests.${reset ? ` Try again after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : " Try again later."} Your saved books remain available.`,
        );
      }
      if (res.status === 404)
        throw new Error(
          token
            ? "GitHub could not find this repository, branch, or file, or the saved token cannot access it. Check the URL, branch, selected repositories, and Contents read permission."
            : "GitHub could not find this public repository, branch, or file. Check the URL and branch. If it is private, save a fine-grained token with Contents read permission in Library settings.",
        );
      if (res.status >= 500 && attempt < 2) continue;
      throw new Error(
        `GitHub returned HTTP ${res.status}. Try again; any completed download is saved.`,
      );
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException(
          "Download paused. You can resume it from your library.",
          "AbortError",
        );
      if (
        attempt < 2 &&
        (error instanceof TypeError || (error as Error).name === "TimeoutError")
      )
        continue;
      if (error instanceof TypeError)
        throw new Error(
          "Could not connect to GitHub. Check your connection and resume the download.",
        );
      if ((error as Error).name === "TimeoutError")
        throw new Error(
          "GitHub took too long to respond. Check your connection and resume the download.",
        );
      throw error;
    }
  }
}

async function json<T>(
  url: string,
  signal?: AbortSignal,
  token = "",
): Promise<T> {
  return (await response(url, signal, token)).json() as Promise<T>;
}

async function readFile(
  source: Source,
  commit: string,
  entry: TreeEntry,
  signal?: AbortSignal,
  token = "",
) {
  if (token)
    return response(
      blobURL(source, entry.sha),
      signal,
      token,
      "application/vnd.github.raw+json",
    );
  return response(rawURL(source, commit, entry.path), signal);
}

export async function latestCommit(
  source: Source,
  signal?: AbortSignal,
  token = "",
) {
  const data = await json<{ sha: string }>(
    `${endpoint(source)}/commits/${encodeURIComponent(source.branch)}`,
    signal,
    token,
  );
  return data.sha;
}

export async function discover(
  url: string,
  branch = "",
  root = "book",
  signal?: AbortSignal,
  token = "",
): Promise<Discovery> {
  const repo = parseRepoUrl(url);
  const metadata = await json<{
    default_branch: string;
    description: string;
    private: boolean;
  }>(endpoint(repo), signal, token);
  if (metadata.private && !token)
    throw new Error("Private repositories require a saved GitHub token with Contents read permission; public repositories need no token.");
  let source: Source = {
    ...repo,
    branch: branch.trim() || metadata.default_branch,
    root: normalizeRoot(root),
  };
  const commit = await latestCommit(source, signal, token);
  const tree = await json<{ tree: TreeEntry[]; truncated: boolean }>(
    `${endpoint(source)}/git/trees/${commit}?recursive=1`,
    signal,
    token,
  );
  if (tree.truncated)
    throw new Error(
      "This repository is too large for a complete GitHub tree response. Put the book in a smaller dedicated repository.",
    );
  const entries = tree.tree.filter((e) => e.type === "blob");
  // Prefer a formatted book at the repository root; otherwise detect the
  // conventional book/ subfolder without requiring the reader to enter it.
  if (
    !source.root &&
    !(entries.some((entry) => entry.path === "README.md") && entries.some((entry) => isChapter(entry.path, ""))) &&
    entries.some((entry) => entry.path === "book/README.md") &&
    entries.some((entry) => isChapter(entry.path, "book"))
  ) source = { ...source, root: "book" };
  const prefix = source.root ? `${source.root}/` : "";
  const chapterEntries = entries.filter((e) => isChapter(e.path, source.root));
  const recognized = chapterEntries.length > 0 && entries.some((e) => e.path === `${prefix}README.md`);
  const readableEntries = entries.filter((e) => e.path.startsWith(prefix) && /\.(md|markdown|txt|rst)$/i.test(e.path) && !/(^|\/)README\.(md|markdown|txt|rst)$/i.test(e.path) && !e.path.split("/").some((part) => part.startsWith("_")));
  if (!recognized && !readableEntries.length) {
    throw new Error(
      `No readable Markdown, text, or RST files found in ${source.root || "repository root"}.`,
    );
  }
  const indexEntry = entries.find((entry) => entry.path === `${prefix}README.md`);
  const index = indexEntry ? await (await readFile(source, commit, indexEntry, signal, token)).text() : "";
  const indexDocument = frontMatter(index);
  const title =
    typeof indexDocument.meta.title === "string" &&
    indexDocument.meta.title.trim()
      ? indexDocument.meta.title.trim()
      : indexDocument.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || source.repo;
  return {
    id: sourceId(source),
    source,
    commit,
    title: index ? title : source.repo,
    description: metadata.description || "",
    entries,
    chapterPaths: (recognized ? chapterEntries : readableEntries).map((e) => e.path),
    volumes: recognized ? new Set(
      chapterEntries.map((e) => e.path.split("/").slice(0, -1).join("/")),
    ).size : new Set(readableEntries.map((e) => e.path.split("/").slice(0, -1).join("/"))).size,
    bytes: entries
      .filter(
        (e) =>
          e.path.startsWith(source.root ? `${source.root}/` : "") && !e.path.includes("/_ai/"),
      )
      .reduce((sum, e) => sum + (e.size || 0), 0),
    index,
    generalLayout: !recognized,
    readablePaths: (recognized ? chapterEntries : readableEntries).map(e => e.path),
    selectedPaths: (recognized ? chapterEntries : readableEntries).map(e => e.path),
  };
}

export async function prepareBook(
  discovery: Discovery,
  progress: (value: TransferProgress) => void,
  signal: AbortSignal,
  previous?: Book,
  persist = true,
  token = "",
): Promise<Book> {
  const cached = persist ? await loadDraft(discovery.id) : undefined;
  const draft: Draft =
    cached?.discovery.commit === discovery.commit
      ? cached
      : {
          id: discovery.id,
          discovery,
          documents: discovery.index ? {
            [`${discovery.source.root ? `${discovery.source.root}/` : ""}README.md`]: discovery.index,
          } : {},
          assets: [],
        };
  const wanted = discovery.entries.filter(
    (e) =>
      e.path.startsWith(discovery.source.root ? `${discovery.source.root}/` : "") &&
      (discovery.generalLayout ? ((discovery.selectedPaths || discovery.readablePaths || []).includes(e.path) || /(^|\/)README\.(md|markdown|txt|rst)$/i.test(e.path)) : /\.md$/i.test(e.path)) &&
      !e.path.includes("/_ai/"),
  );
  for (const entry of wanted) {
    if (draft.documents[entry.path] !== undefined) continue;
    const old = previous?.chapters.find(
      (c) => c.path === entry.path && c.blobSha === entry.sha,
    );
    if (old && previous?.documents[entry.path])
      draft.documents[entry.path] = previous.documents[entry.path];
  }
  const count = () =>
    wanted.filter((e) => draft.documents[e.path] !== undefined).length;
  const pending = wanted.filter((e) => draft.documents[e.path] === undefined);
  if (persist) await saveDraft(draft);
  for (let start = 0; start < pending.length; start += 6) {
    signal.throwIfAborted();
    progress({
      done: count(),
      total: wanted.length,
      label: "Downloading chapters and indexes",
    });
    const results = await Promise.allSettled(
      pending.slice(start, start + 6).map(async (entry) => {
        draft.documents[entry.path] = await (
          await readFile(discovery.source, discovery.commit, entry, signal, token)
        ).text();
      }),
    );
    if (persist) await saveDraft(draft);
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  progress({
    done: wanted.length,
    total: wanted.length,
    label: "Validating metadata and links",
  });
  const { chapters, report } = discovery.generalLayout ? {
    chapters: parseGeneralDocuments(draft.documents, discovery.selectedPaths || discovery.readablePaths || [], discovery.entries),
    report: { issues: [], chapters: (discovery.selectedPaths || discovery.readablePaths || []).length, volumes: discovery.volumes },
  } : validateDocuments(
    draft.documents,
    discovery.entries,
    discovery.source.root,
  );
  if (report.issues.some((i) => i.severity === "error")) {
    throw new BookValidationError(report.issues);
  }
  const paths = new Set<string>();
  for (const [path, text] of Object.entries(draft.documents)) {
    for (const link of markdownLinks(frontMatter(text).body).filter(
      (l) => l.image,
    )) {
      const resolved = resolvePath(path, link.href);
      if (resolved && discovery.entries.some((e) => e.path === resolved.path))
        paths.add(resolved.path);
    }
  }
  for (const path of paths) {
    signal.throwIfAborted();
    if (draft.assets.some((a) => a.path === path)) continue;
    const entry = discovery.entries.find((e) => e.path === path)!;
    const mime = IMAGE_MIME_TYPES[path.split(".").at(-1)!.toLowerCase()];
    if (!mime) {
      report.issues.push({
        severity: "warning",
        path,
        message: "Unsupported image format; this image is unavailable offline.",
      });
      continue;
    }
    const oldAsset = previous?.assets.find(
      (a) => a.path === path && a.blobSha === entry.sha,
    );
    progress({
      done: draft.assets.length,
      total: paths.size,
      label: "Saving images for offline reading",
    });
    const asset: Asset = oldAsset
      ? { ...oldAsset }
      : {
          path,
          mime,
          blobSha: entry.sha,
          data: bytesToBase64(
            new Uint8Array(
              await (
                await readFile(
                  discovery.source,
                  discovery.commit,
                  entry,
                  signal,
                  token,
                )
              ).arrayBuffer(),
            ),
          ),
        };
    draft.assets.push(asset);
    if (persist) await saveDraft(draft);
  }
  signal.throwIfAborted();
  const bytes =
    Object.values(draft.documents).reduce(
      (n, text) => n + new TextEncoder().encode(text).length,
      0,
    ) +
    draft.assets.reduce(
      (n, asset) =>
        n + Math.floor((asset.data.replace(/=+$/, "").length * 3) / 4),
      0,
    );
  return {
    id: discovery.id,
    source: discovery.source,
    title: discovery.title,
    description: discovery.description,
    commit: discovery.commit,
    chapters,
    documents: draft.documents,
    assets: draft.assets,
    issues: report.issues,
    downloadedAt: new Date().toISOString(),
    bytes,
    selectedPaths: discovery.selectedPaths || discovery.readablePaths || [],
    generalLayout: !!discovery.generalLayout,
  };
}

export class BookValidationError extends Error {
  constructor(public issues: import("./types").Issue[]) {
    super(
      "This book has format errors. Fix the issues below before importing.",
    );
    this.name = "BookValidationError";
  }
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function base64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
export function repoURL(source: Source) {
  return bookHref({ source } as Book);
}
