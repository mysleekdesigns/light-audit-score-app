"use client";

/**
 * A deliberately tiny markdown renderer for the streamed analysis diagnosis.
 *
 * The diagnosis is short prose (a few paragraphs / bullet lists), so rather than
 * pull in a markdown dependency — and its generic `prose` styling, which clashes
 * with this app's "precision instrument" look — we render a small, safe subset
 * (#/##/### headings, -/* and 1. lists, paragraphs, plus inline **bold**, `code`,
 * and [links](url)) scoped to the design tokens. It tolerates *incomplete* markdown
 * so partial tokens streaming in never render as broken markup: unmatched markers
 * fall through as literal text.
 */

import type { ReactNode } from "react";

import { safeHttpHref } from "@/lib/redactUrl";

/** Render inline `code`, **bold**, and [label](url); unmatched markers stay literal. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      // Only http(s) becomes a link: this prose is model output shaped by the
      // audited page's own text, so a `javascript:` target is a real possibility
      // and would run on this app's origin. Anything else stays literal.
      const href = link ? safeHttpHref(link[2]) : null;
      if (link && href) {
        nodes.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface ListBuffer {
  ordered: boolean;
  items: string[];
}

export function AnalysisDiagnosis({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: ListBuffer | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={`p-${key}`} className="text-pretty">
        {renderInline(para.join(" "), `p-${key}`)}
      </p>,
    );
    key += 1;
    para = [];
  };

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, idx) => (
      <li key={idx} className="pl-1">
        {renderInline(item, `li-${key}-${idx}`)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={`l-${key}`} className="flex list-decimal flex-col gap-1 pl-5 marker:text-muted-foreground">
          {items}
        </ol>
      ) : (
        <ul key={`l-${key}`} className="flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground">
          {items}
        </ul>
      ),
    );
    key += 1;
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push(
        <p
          key={`h-${key}`}
          className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-muted-foreground"
        >
          {renderInline(heading[2], `h-${key}`)}
        </p>,
      );
      key += 1;
      continue;
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (unordered) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    if (ordered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground/90">
      {blocks}
    </div>
  );
}
