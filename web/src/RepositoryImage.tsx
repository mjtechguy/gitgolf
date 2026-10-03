import { useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { repositoryClient } from './api';
import { privateQuery } from './RepositoryUI';
export type DocumentContext={owner:string;name:string;ref:string;path:string;userId?:string};
function dataURL(bytes:Uint8Array,type:string){let text='';for(const value of bytes)text+=String.fromCharCode(value);return `data:${type};base64,${btoa(text)}`;}
export function imageDataURL(bytes:Uint8Array,type:string):string {
 if(bytes.length>256*1024)throw new Error('Image exceeds preview limits.');
 if(['image/png','image/jpeg','image/gif'].includes(type))return dataURL(bytes,type);
 if(type!=='image/svg+xml')throw new Error('Unsupported image format.');
 const document=new DOMParser().parseFromString(new TextDecoder('utf-8',{fatal:true}).decode(bytes),'image/svg+xml');
 if(document.querySelector('parsererror')||document.documentElement.localName!=='svg')throw new Error('Invalid SVG.');
 // Convert a small presentation subset used by ordinary logos. Never retain
 // CSS, network references, embedded documents or active SVG elements.
 for(const element of document.querySelectorAll('[style]')){
  for(const declaration of (element.getAttribute('style')||'').split(';')){
   const [name,...rest]=declaration.split(':');const value=rest.join(':').trim();const key=name?.trim()||'';
   if(['fill','stroke','stop-color'].includes(key)&&/^(?:#[a-f\d]{3,8}|[a-z]+|url\(#[a-z\d_-]+\))$/i.test(value))element.setAttribute(key,value);
   if(['opacity','fill-opacity','stroke-opacity','stop-opacity','stroke-width','stroke-miterlimit'].includes(key)&&/^\d+(?:\.\d+)?$/.test(value))element.setAttribute(key,value);
   if(key==='fill-rule'&&['nonzero','evenodd'].includes(value))element.setAttribute(key,value);
  }element.removeAttribute('style');
 }
 const clean=DOMPurify.sanitize(new XMLSerializer().serializeToString(document.documentElement),{USE_PROFILES:{svg:true},FORBID_TAGS:['style','script','foreignObject','use','image','a','animate','animateMotion','animateTransform','set','feImage'],FORBID_ATTR:['style','href','xlink:href']});
 const safe=new DOMParser().parseFromString(clean,'image/svg+xml');
 for(const element of safe.querySelectorAll('*'))for(const attribute of Array.from(element.attributes)){
  if(/url\(/i.test(attribute.value)&&!/^url\(#[a-z\d_-]+\)$/i.test(attribute.value))element.removeAttribute(attribute.name);
 }
 return dataURL(new TextEncoder().encode(new XMLSerializer().serializeToString(safe.documentElement)),type);
}
export function RepositoryImage({src,alt,height,width,context}:{src?:string;alt?:string;height?:number|string;width?:number|string;context?:DocumentContext}){
 const allowed=(value:string)=>{if(!/^https?:/i.test(value))return !/^[a-z][a-z\d+.-]*:/i.test(value);try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['raw.githubusercontent.com','img.shields.io','avatars.githubusercontent.com','user-images.githubusercontent.com','github.githubassets.com','badgen.net','expressjs.com','sindresorhus.com','api.securityscorecards.dev'].includes(url.host);}catch{return false;}};
 const supported=!!context&&!!src&&allowed(src)&&/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(context.ref)&&!/^\s*(?:javascript|data|blob):|^\/\//i.test(src);
 const query=useQuery({...privateQuery,queryKey:['repository',context?.userId,context?.owner,context?.name,'image',context?.ref,context?.path,src],enabled:supported,queryFn:async({signal})=>{
  const response=await repositoryClient.getRepositoryImage({repository:{owner:context!.owner,name:context!.name},commitId:context!.ref,documentPath:context!.path,imageUrl:src!},{signal,timeoutMs:10000});return imageDataURL(response.content,response.mediaType);
 }});
 const dimension=(value:unknown)=>/^\d{1,4}$/.test(String(value))&&Number(value)>0&&Number(value)<=4096?Number(value):undefined;
 if(!supported||query.isError)return <span className="markdown-image-placeholder" title={query.isError?'Image could not be loaded safely':undefined}>{alt||'Image'} (image preview unavailable)</span>;
 if(!query.data||query.isFetching)return <span className="markdown-image-placeholder" role="status">Loading {alt||'image'}…</span>;
 return <img src={query.data} alt={alt||''} height={dimension(height)} width={dimension(width)} loading="lazy" decoding="async" referrerPolicy="no-referrer"/>;
}
