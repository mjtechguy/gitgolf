import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { RepositoryRunnerSettings } from '../src/RepositoryRunnerSettings';
import '../src/styles.css';
const queries = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
queries.setQueryData(['session'],{id:'1'});
function Fixture(){
 const [props,setProps]=useState({userId:'1',owner:'alice',name:'example',signingOut:false});
 return <><aside aria-label="Fixture controls"><button onClick={()=>void queries.invalidateQueries({queryKey:['repository-settings-access']})}>Fixture refresh access</button><button onClick={()=>setProps(p=>({...p,signingOut:true}))}>Fixture signing out</button><button onClick={()=>{queries.setQueryData(['session'],{id:'2'});setProps(p=>({...p,userId:'2'}));}}>Fixture change user</button><button onClick={()=>setProps(p=>({...p,name:'replacement'}))}>Fixture change repository</button></aside><RepositoryRunnerSettings key={`${props.userId}/${props.owner}/${props.name}`} {...props}/></>;
}
const root=createRootRoute({component:Fixture});
const route=createRoute({getParentRoute:()=>root,path:'/repository-runner-settings-fixture'});
const router=createRouter({routeTree:root.addChildren([route])});
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queries}><RouterProvider router={router}/></QueryClientProvider>);
