import { Fragment, type ReactNode } from "react";

/**
 * A tiny, dependency-free Markdown renderer — just the subset an assistant reply
 * actually uses (headings, bold/italic/code, bullet & numbered lists, blank-line
 * paragraphs). Rendered the way Claude renders its answers rather than showing
 * raw `**stars**`.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // **bold** · *italic* · `code`  (bold checked before italic)
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<strong key={`${keyBase}-${i}`}>{m[2]}</strong>);
    else if (m[3] !== undefined) nodes.push(<em key={`${keyBase}-${i}`}>{m[3]}</em>);
    else if (m[4] !== undefined) nodes.push(<code key={`${keyBase}-${i}`}>{m[4]}</code>);
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={key++}>{inline(para.join(" "), `p${key}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, n) => <li key={n}>{inline(it, `li${key}-${n}`)}</li>);
    blocks.push(list.ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key++}>{inline(heading[2], `h${key}`)}</Tag>);
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ? bullet[1] : numbered![1]));
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();

  return <Fragment>{blocks}</Fragment>;
}
