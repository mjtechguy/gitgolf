import { useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { useSyncExternalStore } from 'react';
import type { Element } from 'hast';
import { pictureImage } from './repositoryPicture';
import { repositoryClient } from './api';
import { sourceRepositoryID, validateSourceImage } from './sourceReads';
import { privateNavigationQuery } from './RepositoryUI';
export type DocumentContext={repositoryId:string;owner:string;name:string;ref:string;path:string;userId?:string;sourceAddress?:{kind:'branch'|'tag';name:string}};
function dataURL(bytes:Uint8Array,type:string){let text='';for(const value of bytes)text+=String.fromCharCode(value);return `data:${type};base64,${btoa(text)}`;}
function embeddedRaster(value:string) {
 const match=/^data:image\/(png|jpeg|gif);base64,([a-z\d+/]*={0,2})$/i.exec(value);
 if(!match||match[2]!.length>256*1024)return false;
 try{const bytes=atob(match[2]!);return match[1]==='png'?bytes.startsWith('\x89PNG\r\n\x1a\n'):match[1]==='jpeg'?bytes.startsWith('\xff\xd8'):bytes.startsWith('GIF87a')||bytes.startsWith('GIF89a');}catch{return false;}
}
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
 for(const element of document.querySelectorAll('*'))for(const attribute of Array.from(element.attributes))if(['href','xlink:href'].includes(attribute.name)&&!(element.localName==='image'&&embeddedRaster(attribute.value)))element.removeAttribute(attribute.name);
 const clean=DOMPurify.sanitize(new XMLSerializer().serializeToString(document.documentElement),{USE_PROFILES:{svg:true},ADD_DATA_URI_TAGS:['image'],FORBID_TAGS:['style','script','foreignObject','use','a','animate','animateMotion','animateTransform','set','feImage'],FORBID_ATTR:['style']});
 const safe=new DOMParser().parseFromString(clean,'image/svg+xml');
 for(const element of safe.querySelectorAll('*'))for(const attribute of Array.from(element.attributes)){
  if(/url\(/i.test(attribute.value)&&!/^url\(#[a-z\d_-]+\)$/i.test(attribute.value))element.removeAttribute(attribute.name);
  if(['href','xlink:href'].includes(attribute.name)&&!(element.localName==='image'&&embeddedRaster(attribute.value)))element.removeAttribute(attribute.name);
 }
 return dataURL(new TextEncoder().encode(new XMLSerializer().serializeToString(safe.documentElement)),type);
}
function subscribePicture(update:()=>void){const observer=new MutationObserver(update);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});window.addEventListener('resize',update);return()=>{observer.disconnect();window.removeEventListener('resize',update);};}
export function RepositoryPicture({node,context}:{node?:Element;context?:DocumentContext}){
 useSyncExternalStore(subscribePicture,()=>`${document.documentElement.dataset.theme}/${innerWidth}/${devicePixelRatio}`);
 const properties=pictureImage(node,media=>{
  const theme=media.match(/^\s*\(prefers-color-scheme:\s*(dark|light)\)\s*$/);
  return theme?document.documentElement.dataset.theme===theme[1]:matchMedia(media).matches;
 },devicePixelRatio,innerWidth);
 if(!properties)return null;
 const string=(value:unknown)=>typeof value==='string'?value:undefined;
 const dimension=(value:unknown)=>typeof value==='number'||typeof value==='string'?value:undefined;
 return <RepositoryImage src={string(properties.src)} alt={string(properties.alt)} width={dimension(properties.width)} height={dimension(properties.height)} context={context}/>;
}
export function RepositoryImage({src,alt,height,width,context}:{src?:string;alt?:string;height?:number|string;width?:number|string;context?:DocumentContext}){
 const allowed=(value:string)=>{if(!/^https?:/i.test(value))return !/^[a-z][a-z\d+.-]*:/i.test(value);try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['raw.githubusercontent.com','img.shields.io','avatars.githubusercontent.com','user-images.githubusercontent.com','github.githubassets.com','badgen.net','expressjs.com','sindresorhus.com','api.securityscorecards.dev','github.com','vite.dev','sponsors.vite.dev'].includes(url.host);}catch{return false;}};
 const supported=!!context&&sourceRepositoryID(context.repositoryId)&&!!src&&allowed(src)&&/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(context.ref)&&!/^\s*(?:javascript|data|blob):|^\/\//i.test(src);
 const query=useQuery({...privateNavigationQuery,queryKey:['repository',context?.userId,context?.owner,context?.name,'image',context?.repositoryId,context?.ref,context?.path,src],enabled:supported,queryFn:async({signal})=>{
  const response=await repositoryClient.getRepositoryImage({repository:{owner:context!.owner,name:context!.name},repositoryId:context!.repositoryId,commitId:context!.ref,documentPath:context!.path,imageUrl:src!},{signal,timeoutMs:10000});signal.throwIfAborted();validateSourceImage(response,context!.repositoryId,context!.ref,context!.path,src!);return imageDataURL(response.content,response.mediaType);
 }});
 const dimension=(value:unknown)=>/^\d{1,4}$/.test(String(value))&&Number(value)>0&&Number(value)<=4096?Number(value):undefined;
 if(!supported||query.isError)return <span className="markdown-image-placeholder" title={query.isError?'Image could not be loaded safely':undefined}>{alt||'Image'} (image preview unavailable)</span>;
 if(!query.data||query.isFetching)return <span className="markdown-image-placeholder" role="status">Loading {alt||'image'}…</span>;
 return <img src={query.data} alt={alt||''} height={dimension(height)} width={dimension(width)} loading="lazy" decoding="async" referrerPolicy="no-referrer"/>;
}
