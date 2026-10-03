import { useMemo, type ReactNode } from 'react';
import {common,createLowlight} from 'lowlight';
import type {RootContent} from 'hast';
const highlighter = createLowlight(common);
function nodes(values: RootContent[]): ReactNode { return values.map((n,i) => n.type === 'text' ? n.value : n.type === 'element' ? <span key={i} className={Array.isArray(n.properties.className) ? n.properties.className.join(' ') : undefined}>{nodes(n.children)}</span> : null); }
export default function Tokens({ text, language }: { text: string; language: string }) {
 const value = useMemo(() => {
  if (text.length > 65536 || !highlighter.registered(language)) return text;
  try { return nodes(highlighter.highlight(language, text).children); } catch { return text; }
 }, [text, language]);
 return <>{value}</>;
}
