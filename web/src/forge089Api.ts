import {createClient} from '@connectrpc/connect';
import {createConnectTransport} from '@connectrpc/connect-web';
import {RepositoryFileBatchService,DiscussionAttachmentService} from './gen/golf/v1/forge089_pb';
const transport=createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false,fetch:(input,init)=>fetch(input,{...init,credentials:'same-origin',cache:'no-store'})});
export const fileBatchClient=createClient(RepositoryFileBatchService,transport);
export const discussionAttachmentClient=createClient(DiscussionAttachmentService,transport);
