import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clipboard,
  FileCheck2,
  FolderOpen,
  Sparkles,
} from "lucide-react";
import { defaultBrief, type Brief, type Issue } from "../lib/types";
import { loadBrief, loadGitHubToken, saveBrief } from "../lib/storage";
import {
  promptFor,
  promptStages,
  scaffoldZip,
  slugify,
  type PromptStage,
} from "../lib/authoring";
import { discover, prepareBook, BookValidationError } from "../lib/github";
import { downloadFile } from "../lib/backup";

export default function Authoring({
  notify,
  online,
}: {
  notify: (message: string, error?: boolean) => void;
  online: boolean;
}) {
  const [brief, setBrief] = useState<Brief>(defaultBrief);
  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState<PromptStage>("Outline");
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [root, setRoot] = useState("book");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [result, setResult] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    loadBrief()
      .then((value) => {
        setBrief(value);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      saveBrief(brief).catch(() =>
        notify("Could not save your brief on this device.", true),
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [brief, loaded, notify]);
  const change = (name: keyof Brief, value: string) =>
    setBrief((old) => ({
      ...old,
      [name]:
        name === "chapters"
          ? Math.min(500, Math.max(1, Number(value) || 1))
          : value,
    }));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptFor(brief, stage));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify(
        "Copy is unavailable here. Select the prompt text and copy it manually.",
        true,
      );
    }
  };
  const validate = async () => {
    controller.current = new AbortController();
    setBusy(true);
    setIssues(null);
    setResult("");
    try {
      const token = await loadGitHubToken();
      const discovery = await discover(
        url,
        branch,
        root,
        controller.current.signal,
        token,
      );
      const book = await prepareBook(
        discovery,
        (p) => setProgress(`${p.label} · ${p.done}/${p.total}`),
        controller.current.signal,
        undefined,
        false,
        token,
      );
      setIssues(book.issues);
      setResult(
        `${book.title}: ${book.chapters.length} chapters across ${new Set(book.chapters.map((c) => c.volume)).size} volumes. Ready to import.`,
      );
    } catch (error) {
      if (error instanceof BookValidationError) {
        setIssues(error.issues);
        setResult("Fix these format errors before importing.");
      } else if ((error as Error).name !== "AbortError")
        notify((error as Error).message, true);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  return (
    <main className="page authoring-page">
      <div className="page-intro">
        <span className="eyebrow">
          <Sparkles size={15} /> FROM CURIOSITY TO CHAPTERS
        </span>
        <h1>
          Write the book you
          <br />
          wish existed.
        </h1>
        <p>
          Give your AI a thoughtful brief. Build a book one chapter at a time,
          with a structure you can bring back here to read.
        </p>
      </div>
      <div className="workflow-strip">
        <span>
          <b>01</b> Shape your idea
        </span>
        <ArrowRight size={16} />
        <span>
          <b>02</b> Write with your AI
        </span>
        <ArrowRight size={16} />
        <span>
          <b>03</b> Publish & read
        </span>
      </div>
      <div className="authoring-grid">
        <section className="panel brief-panel">
          <div className="section-label">
            <span className="step">01</span>
            <h2>Your book brief</h2>
          </div>
          <p className="muted">Saved on this device as you go.</p>
          <label>
            What do you want to explore?
            <input
              value={brief.topic}
              onChange={(e) => change("topic", e.target.value)}
              placeholder="e.g. Modern PHP, urban gardening, jazz theory"
            />
          </label>
          <label>
            Who is it for?
            <input
              value={brief.audience}
              onChange={(e) => change("audience", e.target.value)}
            />
          </label>
          <div className="field-row">
            <label>
              Starting level
              <input
                value={brief.level}
                onChange={(e) => change("level", e.target.value)}
              />
            </label>
            <label>
              Language
              <input
                value={brief.language}
                onChange={(e) => change("language", e.target.value)}
              />
            </label>
          </div>
          <label>
            Learning goals
            <textarea
              value={brief.goals}
              onChange={(e) => change("goals", e.target.value)}
              rows={3}
              placeholder="What should readers understand or be able to do?"
            />
          </label>
          <label>
            Depth & approach
            <input
              value={brief.depth}
              onChange={(e) => change("depth", e.target.value)}
            />
          </label>
          <label>
            Target chapters
            <input
              type="number"
              min={1}
              max={500}
              value={brief.chapters}
              onChange={(e) => change("chapters", e.target.value)}
            />
          </label>
          <button
            className="button primary full"
            disabled={!brief.topic.trim()}
            onClick={() => {
              try {
                const zip = scaffoldZip(brief);
                downloadFile(
                  `${slugify(brief.topic)}-book-template.zip`,
                  new Uint8Array(zip).buffer,
                  "application/zip",
                );
                notify(
                  "Your book template is ready. Unzip it and give the files to your AI tool.",
                );
              } catch (error) {
                notify((error as Error).message, true);
              }
            }}
          >
            <FolderOpen size={18} /> Download repository template
            <ArrowDownToLine size={17} />
          </button>
          <p className="small muted">
            Includes an outline, chapter files, summaries, continuation state,
            format guide, and all seven prompts.
          </p>
        </section>
        <section className="panel prompt-panel">
          <div className="section-label">
            <span className="step">02</span>
            <h2>Your AI writing companion</h2>
          </div>
          <p className="muted">
            Use these prompts in the AI tool of your choice.
          </p>
          <div
            className="prompt-tabs"
            role="tablist"
            aria-label="Authoring prompt stages"
          >
            {promptStages.map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={s === stage}
                onClick={() => setStage(s)}
                className={s === stage ? "active" : ""}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="prompt-toolbar">
            <span>{stage} prompt</span>
            <button className="text-button" onClick={copy}>
              {copied ? <Check size={16} /> : <Clipboard size={16} />}
              {copied ? "Copied" : "Copy prompt"}
            </button>
          </div>
          <textarea
            className="prompt-content"
            aria-label={`${stage} prompt`}
            readOnly
            value={promptFor(brief, stage)}
          />
          <p className="small muted">
            Start with the outline. For each writing session, provide the
            current chapter, its summary, and the continuation state. Review and
            verify before publishing.
          </p>
        </section>
      </div>
      <section className="panel validation-panel">
        <div className="section-label">
          <span className="step">03</span>
          <h2>Check your published book</h2>
        </div>
        <p className="muted">
          Check chapter metadata, order, links, and offline images. Public
          repositories work without a token; for private repositories, save a
          fine-grained token in Library settings first.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void validate();
          }}
        >
          <label>
            GitHub repository URL
            <input
              type="url"
              required
              placeholder="https://github.com/you/your-book"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="field-row">
            <label>
              Branch <span className="muted">(default if blank)</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={busy}
                placeholder="main"
              />
            </label>
            <label>
              Book folder
              <input
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                disabled={busy}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="button secondary" disabled={busy || !online}>
              <FileCheck2 size={18} />
              {busy ? "Checking book…" : "Validate GitHub book"}
            </button>
            {busy && (
              <button
                type="button"
                className="text-button"
                onClick={() => controller.current?.abort()}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
        {!online && (
          <p className="small muted">
            Reconnect to check GitHub. Your brief and prompts work offline.
          </p>
        )}
        {progress && (
          <p role="status" className="small muted">
            {progress}
          </p>
        )}
        {issues && (
          <div className="validation-result">
            <strong>{result}</strong>
            <IssueList issues={issues} />
          </div>
        )}
      </section>
    </main>
  );
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length)
    return (
      <p className="success-message">
        <Check size={17} /> No format or link issues found.
      </p>
    );
  return (
    <ul className="issues">
      {issues.map((issue, i) => (
        <li key={i} className={issue.severity}>
          <span className="issue-level">{issue.severity}</span>
          <div>
            <code>{issue.path}</code>
            <p>{issue.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
