import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { PullReviewAuthoringService } from './gen/golf/v1/golf_pb';

export const reviewAuthoringClient=createClient(PullReviewAuthoringService,createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false,fetch:(input,init)=>fetch(input,{...init,credentials:'same-origin',cache:'no-store'})}));
