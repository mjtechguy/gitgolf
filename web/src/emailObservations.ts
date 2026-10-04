import type { EmailConfigurationObservation, EmailTransport } from './gen/golf/v1/golf_pb';
const decimal=(s:string,zero=false)=>/^(0|[1-9][0-9]{0,18})$/.test(s)&&BigInt(s)<=9223372036854775807n&&(zero||s!=='0');
const at=(s:string)=>s!==''&&Number.isFinite(Date.parse(s));
export function validEmailObservation(o:EmailConfigurationObservation|undefined,generation:string,transports:EmailTransport[]):boolean {
 if(!o)return true; // Older servers/fixtures explicitly have no observation.
 if(!at(o.observedAt)||o.activationGeneration!==generation||!decimal(generation,true)||o.connectedWorkers>2||o.recentlyActiveWorkers>o.connectedWorkers)return false;
 const active=transports.filter(t=>t.active);
 if(o.configured ? active.length!==1||active[0]?.id!==o.transportId||active[0]?.version!==o.transportVersion||!decimal(o.transportVersion) : active.length!==0||o.transportId!==''||o.transportVersion!=='0'||o.latestDelivery!==undefined)return false;
 if(o.lastWorkerActivity ? !at(o.lastWorkerActivity)||Date.parse(o.lastWorkerActivity)>Date.parse(o.observedAt)||o.connectedWorkers===0 : o.connectedWorkers!==0)return false;
 if(o.recentlyActiveWorkers>0&&Date.parse(o.lastWorkerActivity)<=Date.parse(o.observedAt)-30000)return false;
 const d=o.latestDelivery;if(!d)return true;
 if(!at(d.createdAt)||Date.parse(d.createdAt)>Date.parse(o.observedAt)||d.attempts>6||d.smtpStatus>599||!['queued','sending','retrying','accepted','failed','cancelled','suppressed'].includes(d.state))return false;
 const terminal=['accepted','failed','cancelled','suppressed'].includes(d.state);
 if(terminal!==Boolean(d.completedAt)||d.completedAt&&(!at(d.completedAt)||Date.parse(d.completedAt)<Date.parse(d.createdAt)||Date.parse(d.completedAt)>Date.parse(o.observedAt)))return false;
 return d.relayAccepted===(d.state==='accepted'&&d.smtpStatus===250)&&(d.state!=='accepted'||d.attempts>0&&d.relayAccepted);
}
