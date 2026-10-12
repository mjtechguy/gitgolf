import type { Element } from 'hast';

export function pictureImage(node: Element | undefined, matches: (media: string) => boolean, ratio: number, width: number) {
 const children=node?.children.filter((child):child is Element=>child.type==='element')||[];
 const fallback=children.find(child=>child.tagName==='img');if(!fallback)return undefined;
 const properties={...fallback.properties};
 for(const source of children.filter(child=>child.tagName==='source')){
  const media=source.properties.media;if(typeof media==='string'&&!matches(media))continue;
  const set=source.properties.srcSet;if(typeof set!=='string'||set.length>8192)continue;
  const candidates=set.split(/,\s*/).map(candidate=>candidate.trim().match(/^(\S+?)(?:\s+(\d+(?:\.\d+)?)([xw]))?$/)).filter(candidate=>candidate&&(!candidate[2]||Number(candidate[2])>0));
  if(!candidates.length||candidates.length>16)continue;
  const ordered=candidates.map(candidate=>({src:candidate![1]!,density:candidate![3]==='w'?Number(candidate![2])/Math.max(1,width):Number(candidate![2]||1)})).sort((a,b)=>a.density-b.density);
  properties.src=(ordered.find(candidate=>candidate.density>=ratio)||ordered.at(-1))!.src;break;
 }
 return properties;
}
