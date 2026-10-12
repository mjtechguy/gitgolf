import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pictureImage } from '../src/repositoryPicture.ts';
import type { Element } from 'hast';
const picture=(sources:Element[]):Element=>({type:'element',tagName:'picture',properties:{},children:[...sources,{type:'element',tagName:'img',properties:{src:'fallback.svg',alt:'Logo',height:60},children:[]}]});
const source=(srcSet:string,media?:string):Element=>({type:'element',tagName:'source',properties:{srcSet,...media?{media}:{}},children:[]});
test('picture selects the applicable theme source while retaining image metadata',()=>{
 const node=picture([source('dark.svg','dark'),source('light.svg','light')]);
 assert.deepEqual(pictureImage(node,media=>media==='dark',1,800),{src:'dark.svg',alt:'Logo',height:60});
 assert.equal(pictureImage(node,media=>media==='light',1,800)?.src,'light.svg');
 assert.equal(pictureImage(node,()=>false,1,800)?.src,'fallback.svg');
});
test('picture selects bounded density and width candidates without changing literal URLs',()=>{
 assert.equal(pictureImage(picture([source('one.svg 1x, two.svg 2x')]),()=>true,2,800)?.src,'two.svg');
 assert.equal(pictureImage(picture([source('small.png 400w, large.png 1600w')]),()=>true,1,800)?.src,'large.png');
 assert.equal(pictureImage(picture([source('https://vite.dev/vite-light.svg')]),()=>true,1,800)?.src,'https://vite.dev/vite-light.svg');
 assert.equal(pictureImage(picture([source('invalid.svg 0x')]),()=>true,1,800)?.src,'fallback.svg');
});
test('picture requires a fallback image and refuses unbounded candidate inventories',()=>{
 assert.equal(pictureImage(undefined,()=>true,1,800),undefined);
 assert.equal(pictureImage(picture([source(Array.from({length:17},(_,i)=>`image-${i}.svg ${i+1}x`).join(', '))]),()=>true,1,800)?.src,'fallback.svg');
});
