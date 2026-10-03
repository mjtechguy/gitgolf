import { lazy, Suspense, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { RepositoryImage, type DocumentContext } from './RepositoryImage';
import type { Root, Element, RootContent } from 'hast';
import { Code2, Eye } from 'lucide-react';
import { CopyButton } from './RepositoryUI';
import { sourceLanguage } from './sourceLanguage';


export const isMarkdownPath = (path:string) => /\.(md|markdown|mdown)$/i.test(path);
const Syntax=lazy(()=>import('./SyntaxTokens'));
const SourceCode=lazy(()=>import('./SourceCode'));
function Tokens({text,language}:{text:string;language:string}) {return language?<Suspense fallback={text}><Syntax text={text} language={language}/></Suspense>:text;}
export function CodePreview({ text, path, label }: {text:string;path:string;label?:string}) {
 const language=sourceLanguage(path);
 const title=label||`Source of ${path}`;
 const plain=<pre className="source-preview code-preview" tabIndex={0} aria-label={title}><code><Tokens text={text || '(Empty text file)'} language={language}/></code></pre>;
 return <div className="code-block"><CopyButton text={text} label={`Copy source of ${path}`}/>{text&&text.split('\n').length<=12000?<Suspense fallback={plain}><SourceCode text={text} language={language} label={title}/></Suspense>:plain}</div>;
}
const nodeText=(node:RootContent):string=>node.type==='text'?node.value:node.type==='element'?node.children.map(nodeText).join(''):'';
// Resolve relative document links within the same repository/immutable snapshot.
// Relative source links never become Golf account/admin/API routes.
export function contentLink(href:string, context?:DocumentContext):string|undefined {
 if (!href || /[\u0000-\u0020\u007f\\]/.test(href) || href.startsWith('//')) return undefined;
 if (href.startsWith('#')) return `#user-content-${href.slice(1)}`;
 if (/^https?:\/\//i.test(href)) { try { const u=new URL(href);return !u.username&&!u.password ? u.href : undefined; } catch { return undefined; } }
 if (/^[a-z][a-z\d+.-]*:/i.test(href) || !context) return undefined;
 try {
  const base=context.path.split('/').slice(0,-1);
  const target=href.split(/[?#]/)[0]||'';
  const parts=target.startsWith('/')?[]:base;
  for (const part of target.split('/')) { const decoded=decodeURIComponent(part); if (!decoded||decoded==='.') continue; if (decoded==='..') { if (!parts.length) return undefined; parts.pop(); } else {if (/[/\\\u0000-\u001f]/.test(decoded)) return undefined;parts.push(decoded);} }
  const fragment=href.includes('#')?`#user-content-${href.split('#').slice(1).join('#')}`:'';
  return `/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/tree/${context.ref}/${parts.map(encodeURIComponent).join('/')}${fragment}`;
 } catch {return undefined;}
}
function headingAnchors(){return (tree:Root)=>{
 const counts=new Map<string,number>();
 const visit=(node:Root|Element)=>{for(const child of node.children){if(child.type!=='element')continue;
  if(/^h[1-6]$/.test(child.tagName)){const slug=child.children.map(nodeText).join('').toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu,'').replace(/ /g,'-');const count=counts.get(slug)||0;counts.set(slug,count+1);child.properties.id=`user-content-${slug}${count?`-${count}`:''}`;}
  visit(child);
 }};visit(tree);
};}
export function MarkdownBody({text,label,context}:{text:string;label:string;context?:DocumentContext}) {
 return <div className="markdown-body" aria-label={label} tabIndex={0}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw,[rehypeSanitize,{...defaultSchema,attributes:{...defaultSchema.attributes,div:[...(defaultSchema.attributes?.div||[]),'align'],p:[...(defaultSchema.attributes?.p||[]),'align'],img:[...(defaultSchema.attributes?.img||[]),'height','width']}}],headingAnchors]} urlTransform={(value,key)=>key==='src'?value:contentLink(value,context)||''} components={{
  div:({children,node})=><div className={node?.properties.align==='center'?'markdown-align-center':node?.properties.align==='right'?'markdown-align-right':undefined}>{children}</div>,
  p:({children,node})=><p className={node?.properties.align==='center'?'markdown-align-center':node?.properties.align==='right'?'markdown-align-right':undefined}>{children}</p>,
  a:({href,children})=>href?<a href={href} target={/^https?:/.test(href)?'_blank':undefined} rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
  img:({src,alt,height,width})=><RepositoryImage src={src} alt={alt} height={height} width={width} context={context}/>,
  code:({className,children})=><code className={className}><Tokens text={String(children)} language={className?.replace(/^language-/,'')||''}/></code>,
  pre:({children,node})=><div className="code-block"><CopyButton text={node?.children.map(nodeText).join('')||''} label="Copy code block"/><pre>{children}</pre></div>,
 }}>{text}</Markdown></div>;
}
export function FileContent({text,path,context}:{text:string;path:string;context:DocumentContext}) {
 const [raw,setRaw]=useState(false);
 return <><div className="content-view-controls"><button className="text-button" onClick={()=>setRaw(!raw)} aria-pressed={raw}>{raw?<Eye size={15}/>:<Code2 size={15}/>} {raw?'Rendered':'Source'}</button></div>{raw?<CodePreview text={text} path={path}/>:<MarkdownBody text={text} label={`Rendered ${path}`} context={context}/>}</>;
}
