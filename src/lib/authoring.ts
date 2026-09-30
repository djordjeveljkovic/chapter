import { strToU8, zipSync } from "fflate";
import { stringify } from "yaml";
import type { Brief } from "./types";

export const promptStages = [
  "Outline",
  "Write",
  "Continue",
  "Verify sources",
  "Exercises",
  "Review",
  "Publish",
] as const;
export type PromptStage = (typeof promptStages)[number];

export function slugify(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "my-book"
  );
}
export function promptFor(brief: Brief, stage: PromptStage) {
  const intro = `You are an experienced author and teacher creating a Markdown book about ${brief.topic || "[TOPIC]"}.\n\nBook brief\n- Audience: ${brief.audience}\n- Starting level: ${brief.level}\n- Language: ${brief.language}\n- Depth: ${brief.depth}\n- Target chapter count: ${brief.chapters}\n- Learning goals: ${brief.goals || "[DEFINE LEARNING GOALS]"}\n\nRepository contract\n- Publish the book index in book/README.md and chapters in book/volumes/NN-volume-slug/NNN-chapter-slug.md.\n- Give every chapter YAML front matter: book, volume, volume_title, chapter, title, unique slug, status, summary.\n- Status is planned, in-progress, review, or complete. Never mark unwritten material complete.\n- Keep outlines in SKELETON.md, instructions in AI_AUTHORING_GUIDE.md, and AI-only handoffs under book/_ai/.\n- Use relative links, properly labeled fenced code blocks, and repository-local images.\n- Teach through explanations, concrete examples, constraints, and meaningful practice. Clearly label uncertainty.\n- Do not invent facts, citations, experiments, or source verification. Verify technical and current claims against authoritative sources when tools are available; otherwise record them as unverified.\n`;
  const instructions: Record<PromptStage, string> = {
    Outline: `First propose the learning journey and numbered volumes/chapters. Explain prerequisites, scope, and intended outcomes. Ask about any major ambiguity. After the outline is agreed, update SKELETON.md, book indexes, and planned chapter metadata using the supplied scaffold. Keep factual writing for later. Do not try to produce the whole book in one response.`,
    Write: `Read SKELETON.md, AI_AUTHORING_GUIDE.md, book/_ai/CONTINUATION_STATE.md, the target chapter, and its chapter summary. Write one substantial coherent section from Exact Next Section. Preserve completed text. Explain reasoning and tradeoffs with worked examples. Add exercises only where useful. Immediately update its summary and the continuation state with actual completed material, terminology, open questions, source verification, and the exact next section. Stop at a natural boundary.`,
    Continue: `Resume from book/_ai/CONTINUATION_STATE.md: read the target chapter and its summary first. Continue from Exact Next Section, without restarting or duplicating completed material. Keep terminology and examples consistent. Complete a bounded section, then update both handoff files. If the necessary files are missing, request them instead of guessing what was already written.`,
    "Verify sources": `Audit the target chapter for factual, technical, numerical, and current claims. Check authoritative primary sources. Record claim, source URL, what was checked, date, and any correction. Prefer source links close to the claim. Identify uncertain statements and unsupported citations. Do not imply a claim was verified unless you actually inspected supporting material. Update the chapter summary's verification notes and open threads.`,
    Exercises: `Read the target chapter and its learning goals. Design a small set of exercises requiring understanding rather than recall. Include prerequisites, a concrete task, expected outcome, hints, and a separately labeled solution or explanation. Add review questions and check they are answerable from written material. Adapt to the topic; do not force coding exercises into nontechnical books. Update the chapter and its summary.`,
    Review: `Review the target chapter against SKELETON.md and the audience. Check correctness, missing prerequisites, clarity, examples, terminology, repetition, links, and exercise quality. List actionable findings first, then make focused revisions without rewriting unrelated material. Update the summary and continuation state. Mark complete only after intended material and review are finished.`,
    Publish: `Prepare the repository for public publication. Check chapter numbering and unique slugs, YAML metadata, indexes, internal links and anchors, local images, completion statuses, and separation of book/_ai/ from reading content. Preserve source attribution and explain any licensing decision to the author rather than assigning one automatically. Update README.md with reading and writing instructions. Give the author GitHub publication steps and remind them to validate their public repository URL in Chapter before importing. Do not publish or push anything without the author's instruction.`,
  };
  return `${intro}\nCurrent task: ${stage}\n${instructions[stage]}`;
}

export function scaffoldFiles(brief: Brief): Record<string, string> {
  const title = `The ${brief.topic || "Your Topic"} Book`;
  const count = Math.max(1, Math.min(500, Math.round(brief.chapters)));
  const files: Record<string, string> = {};
  const volumeCount = Math.ceil(count / 8);
  const outline: string[] = [];
  const volumes: string[] = [];
  let firstPath = "";
  let firstSummary = "";
  for (let v = 1; v <= volumeCount; v++) {
    const dir = `${String(v).padStart(2, "0")}-volume-${v}`;
    const index: string[] = [];
    volumes.push(`- [Volume ${v}](volumes/${dir}/README.md)`);
    outline.push(
      `\n## Volume ${v}\n\nReplace this placeholder with an agreed volume title and learning outcomes.\n`,
    );
    for (let n = (v - 1) * 8 + 1; n <= Math.min(v * 8, count); n++) {
      const slug = `chapter-${n}`;
      const name = `${String(n).padStart(3, "0")}-${slug}.md`;
      const path = `book/volumes/${dir}/${name}`;
      const summary = `book/_ai/chapter-summaries/${String(n).padStart(3, "0")}-${slug}-summary.md`;
      if (!firstPath) {
        firstPath = path;
        firstSummary = summary;
      }
      files[path] =
        `---\n${stringify({ book: title, volume: v, volume_title: `Volume ${v}`, chapter: n, title: `Chapter ${n}`, slug, status: "planned", summary: `../../_ai/chapter-summaries/${summary.split("/").at(-1)}` })}---\n\n# Chapter ${n}\n\nThis is a planned chapter. Replace this placeholder using the agreed outline and writing workflow.\n\n## Learning outcomes\n\nDefine the chapter's intended outcomes before writing.\n`;
      files[summary] =
        `# Chapter ${n} summary\n\n- Status: planned\n- Written material: none\n- Concepts explained: none\n- Terminology established: none\n- Examples used: none\n- Cross-references: none\n- Open threads: agree on the chapter outline\n- Exact next section: Learning outcomes\n- Verification notes: no claims verified\n`;
      index.push(`- [Chapter ${n}](${name})`);
      outline.push(
        `- Chapter ${n}: define topic, outcomes, prerequisites, examples, and review criteria.`,
      );
    }
    files[`book/volumes/${dir}/README.md`] =
      `# Volume ${v}\n\n${index.join("\n")}\n`;
  }
  files["README.md"] =
    `# ${title}\n\nA planned Markdown book created with Chapter's authoring toolkit.\n\nStart with [the book index](book/README.md). Read [AI_AUTHORING_GUIDE.md](AI_AUTHORING_GUIDE.md) before writing.\n\n1. Give your AI tool this scaffold and prompts/01-outline.md.\n2. Agree on the outline and replace the placeholder titles and learning outcomes.\n3. Write bounded sections, keeping summaries and continuation state current.\n4. Verify sources, review chapters, and choose an appropriate license.\n5. Publish the repository publicly on GitHub, then use Chapter's URL validator.\n\nNo license is assigned by this scaffold; the author must choose one.\n`;
  files["book/README.md"] =
    `# ${title}\n\n${brief.goals || "Learning goals to be agreed during outlining."}\n\n## Volumes\n\n${volumes.join("\n")}\n`;
  files["SKELETON.md"] =
    `# ${title}: outline and teaching brief\n\n${promptFor(brief, "Outline")}\n\n## Planned structure\n${outline.join("\n")}\n\n## Chapter format\n\nLearning outcomes, prerequisites, core explanation, worked examples, tradeoffs, practice, review, and source references where relevant.\n`;
  files["AI_AUTHORING_GUIDE.md"] =
    `# AI authoring guide\n\nRead SKELETON.md, book/_ai/CONTINUATION_STATE.md, the target chapter, and its summary before each writing session. The continuation state is the navigation authority.\n\n${promptFor(brief, "Write")}\n\nAfter each session, update the chapter summary and global continuation state. Record only actually written material. Verify claims and record gaps. Keep authoring-only files under book/_ai/.\n`;
  files["book/_ai/CONTINUATION_STATE.md"] =
    `# Continuation state\n\n- Status: outline not yet agreed\n- Target chapter: ${firstPath}\n- Target summary: ${firstSummary}\n- Exact Next Section: agree on outline, then define Chapter 1 learning outcomes\n- Completed material: scaffold only; no book prose written\n- Established terminology: none\n- Examples: none\n- Open threads: agree on outline and source policy\n- Verification notes: no claims verified\n`;
  files["BOOK_FORMAT.md"] =
    `# Compatible book format\n\nThe reader requires book/README.md and Markdown chapters under book/volumes/. Number volume directories and chapter filenames. Give chapters YAML metadata: book, volume, volume_title, chapter, title, unique slug, status, summary. Use consistent volume titles and unique chapter numbers within each volume.\n\nUse relative Markdown links and heading anchors. Keep images inside the repository. External images are unavailable offline. Raw HTML and MDX are not executed. AI files under book/_ai/ are excluded from reading. Chapters with planned or in-progress status are allowed but reported as warnings.\n`;
  promptStages.forEach((stage, i) => {
    files[`prompts/${String(i + 1).padStart(2, "0")}-${slugify(stage)}.md`] =
      promptFor(brief, stage);
  });
  return files;
}

export function scaffoldZip(brief: Brief): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(scaffoldFiles(brief)).map(([path, text]) => [
        path,
        strToU8(text),
      ]),
    ),
  );
}
