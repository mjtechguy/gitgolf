import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricValue } from '../src/operationsMetrics.ts';
test('metrics preserve true zero and never present unavailable, invalid or unobserved values as zero',()=>{
 assert.equal(metricValue({state:'available',value:0,unit:'count'}),'0 count');
 for(const value of [undefined,NaN,Infinity,-1])assert.equal(metricValue({state:'available',value,unit:'USD'}),'Unknown');
 assert.equal(metricValue({state:'unknown',value:0,unit:'USD'}),'Unknown');
 assert.equal(metricValue({state:'unavailable',value:0,unit:'bytes'}),'Unavailable');
});
