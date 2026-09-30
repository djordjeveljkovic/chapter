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

async function response(url: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
      if (res.ok) return res;
      if (res.status === 403 || res.status === 429) {
        const reset = res.headers.get("x-ratelimit-reset");
        throw new Error(
          `GitHub temporarily limited requests.${reset ? ` Try again after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : " Try again later."} Your saved books remain available.`,
        );
      }
      if (res.status === 404)
        throw new Error(
          "GitHub could not find this public repository, branch, or file. Check the URL and branch.",
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

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  return (await response(url, signal)).json() as Promise<T>;
}

export async function latestCommit(source: Source, signal?: AbortSignal) {
  const data = await json<{ sha: string }>(
    `${endpoint(source)}/commits/${encodeURIComponent(source.branch)}`,
    signal,
  );
  return data.sha;
}

export async function discover(
  url: string,
  branch = "",
  root = "book",
  signal?: AbortSignal,
): Promise<Discovery> {
  const repo = parseRepoUrl(url);
  const metadata = await json<{
    default_branch: string;
    description: string;
    private: boolean;
  }>(endpoint(repo), signal);
  if (metadata.private)
    throw new Error("This version supports public repositories only.");
  const source: Source = {
    ...repo,
    branch: branch.trim() || metadata.default_branch,
    root: normalizeRoot(root),
  };
  const commit = await latestCommit(source, signal);
  const tree = await json<{ tree: TreeEntry[]; truncated: boolean }>(
    `${endpoint(source)}/git/trees/${commit}?recursive=1`,
    signal,
  );
  if (tree.truncated)
    throw new Error(
      "This repository is too large for a complete GitHub tree response. Put the book in a smaller dedicated repository.",
    );
  const entries = tree.tree.filter((e) => e.type === "blob");
  const chapterEntries = entries.filter((e) => isChapter(e.path, source.root));
  if (
    !chapterEntries.length ||
    !entries.some((e) => e.path === `${source.root}/README.md`)
  ) {
    throw new Error(
      `No compatible book found in ${source.root}/. It needs README.md and Markdown chapters under volumes/. See the Book format guide.`,
    );
  }
  const index = await (
    await response(rawURL(source, commit, `${source.root}/README.md`), signal)
  ).text();
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
    title,
    description: metadata.description || "",
    entries,
    chapterPaths: chapterEntries.map((e) => e.path),
    volumes: new Set(
      chapterEntries.map((e) => e.path.split("/").slice(0, -1).join("/")),
    ).size,
    bytes: entries
      .filter(
        (e) =>
          e.path.startsWith(`${source.root}/`) && !e.path.includes("/_ai/"),
      )
      .reduce((sum, e) => sum + (e.size || 0), 0),
    index,
  };
}

export async function prepareBook(
  discovery: Discovery,
  progress: (value: TransferProgress) => void,
  signal: AbortSignal,
  previous?: Book,
  persist = true,
): Promise<Book> {
  const cached = persist ? await loadDraft(discovery.id) : undefined;
  const draft: Draft =
    cached?.discovery.commit === discovery.commit
      ? cached
      : {
          id: discovery.id,
          discovery,
          documents: {
            [`${discovery.source.root}/README.md`]: discovery.index,
          },
          assets: [],
        };
  const wanted = discovery.entries.filter(
    (e) =>
      e.path.startsWith(`${discovery.source.root}/`) &&
      /\.md$/i.test(e.path) &&
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
          await response(
            rawURL(discovery.source, discovery.commit, entry.path),
            signal,
          )
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
  const { chapters, report } = validateDocuments(
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
                await response(
                  rawURL(discovery.source, discovery.commit, path),
                  signal,
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
