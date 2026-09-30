export interface Source {
  owner: string;
  repo: string;
  branch: string;
  root: string;
}

export interface Chapter {
  id: string;
  path: string;
  title: string;
  volume: number;
  volumeTitle: string;
  number: number;
  status: string;
  markdown: string;
  plainText: string;
  blobSha: string;
}

export interface Asset {
  path: string;
  mime: string;
  data: string;
  blobSha: string;
}
export interface Issue {
  severity: "error" | "warning";
  path: string;
  message: string;
}
export interface ValidationReport {
  issues: Issue[];
  chapters: number;
  volumes: number;
}
export interface Book {
  id: string;
  source: Source;
  title: string;
  description: string;
  commit: string;
  chapters: Chapter[];
  documents: Record<string, string>;
  assets: Asset[];
  issues: Issue[];
  downloadedAt: string;
  bytes: number;
}

export interface Location {
  chapterId: string;
  path: string;
  block: number;
  offset: number;
  quote: string;
}
export interface Bookmark {
  id: string;
  location: Location;
  label: string;
  createdAt: string;
}
export interface Note {
  id: string;
  location: Location;
  text: string;
  createdAt: string;
  updatedAt: string;
}
export interface ReadingState {
  bookId: string;
  location?: Location;
  bookmarks: Bookmark[];
  notes?: Note[];
  completed: string[];
  lastReadAt?: string;
}
export interface UpdateStatus {
  bookId: string;
  latestCommit?: string;
  checkedAt?: string;
  attemptedAt?: string;
  error?: string;
}
export interface Preferences {
  theme: "light" | "dark" | "sepia";
  fontSize: number;
  lineHeight: number;
  width: number;
  mode: "scroll" | "pages";
  font: "serif" | "sans";
}
export const defaultPreferences: Preferences = {
  theme: "light",
  fontSize: 19,
  lineHeight: 1.8,
  width: 720,
  mode: "scroll",
  font: "serif",
};

export interface Brief {
  topic: string;
  audience: string;
  level: string;
  language: string;
  goals: string;
  depth: string;
  chapters: number;
}
export const defaultBrief: Brief = {
  topic: "",
  audience: "Curious learners",
  level: "Beginner to advanced",
  language: "English",
  goals: "",
  depth: "Comprehensive, with practical examples",
  chapters: 12,
};

export interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}
export interface Discovery {
  id: string;
  source: Source;
  title: string;
  description: string;
  commit: string;
  entries: TreeEntry[];
  chapterPaths: string[];
  volumes: number;
  bytes: number;
  index: string;
}
export interface Draft {
  id: string;
  discovery: Discovery;
  documents: Record<string, string>;
  assets: Asset[];
}
export interface TransferProgress {
  done: number;
  total: number;
  label: string;
}
