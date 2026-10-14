import {createClient} from '@connectrpc/connect';
import {createConnectTransport} from '@connectrpc/connect-web';
import {FeaturePolicyService,RepositoryFeatureService} from './gen/golf/v1/feature_policy_pb';
const transport=createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false,fetch:(input,init)=>fetch(input,{...init,credentials:'same-origin',cache:'no-store'})});
export const featurePolicyClient=createClient(FeaturePolicyService,transport);
export const repositoryFeatureClient=createClient(RepositoryFeatureService,transport);
