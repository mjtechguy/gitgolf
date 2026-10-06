import {contentLink} from './RepositoryContent';
// Relative links can address only one wiki page segment in this exact repository.
// They never inherit the current account/admin/API path or request credentials.
export function wikiLink086(href:string,repository:{owner:string;name:string}):string|undefined{
 if(!href||/[\u0000-\u0020\u007f\\]/.test(href)||href.startsWith('//'))return undefined;
 if(href.startsWith('#')||/^https?:\/\//i.test(href))return contentLink(href);
 if(/^[a-z][a-z\d+.-]*:/i.test(href)||href.includes('?'))return undefined;
 const [target,...fragments]=href.split('#');let slug=target||'';
 const prefix=`/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/wiki/`;
 if(slug.startsWith('/')){if(!slug.startsWith(prefix))return undefined;slug=slug.slice(prefix.length)}else if(slug.startsWith('../wiki/'))slug=slug.slice(8);else if(slug.startsWith('./'))slug=slug.slice(2);
 if(slug.endsWith('.md'))slug=slug.slice(0,-3);
 if(!slug||slug==='.'||slug==='..'||slug.length>1024||!/^[A-Za-z0-9_.~+%\-]+$/.test(slug))return undefined;
 try{const decoded=decodeURIComponent(slug.replaceAll('+',' '));if(!decoded.trim()||decoded==='.'||decoded==='..'||/[\/\\\u0000-\u001f\u007f]/.test(decoded))return undefined}catch{return undefined}
 const fragment=fragments.length?contentLink('#'+fragments.join('#')):'';if(fragments.length&&!fragment)return undefined;
 return `${prefix}${slug}${fragment||''}`;
}
