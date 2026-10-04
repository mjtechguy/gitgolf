import { create, toJson } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { useForm } from '@tanstack/react-form';
import { useEffect, useRef } from 'react';
import { LoaderCircle, Play, X } from 'lucide-react';
import { WorkflowDispatchInputDefinitionSchema, WorkflowDispatchInputType as Type, WorkflowDispatchInputValueSchema, type WorkflowDispatchInputDefinition as Definition, type WorkflowDispatchInputValue as Value, type PrepareWorkflowDispatchResponse } from './gen/golf/v1/golf_pb';

export const workflowInputsCatalog = 'golf.workflow.act.v0.2.89.linux.v2';
export const workflowInputsContract = 'golf.workflow.dispatch.inputs.v1';
export const inputDigest = (value:string) => /^[a-f0-9]{64}$/.test(value);
const bytes = (value:string) => new TextEncoder().encode(value).length;
const literal = (value:string,max:number) => bytes(value)<=max&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(value)&&!value.includes('${{');
const numberText = (value:string) => value.length<=64&&/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)&&Number.isFinite(Number(value));
function validValue(value:Value,definition:Definition) {
 if(value.name!==definition.name)return false;
 switch(definition.type){
 case Type.STRING:return value.value.case==='stringValue'&&bytes(value.value.value)<=2048&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(value.value.value);
 case Type.BOOLEAN:return value.value.case==='booleanValue';
 case Type.NUMBER:return value.value.case==='numberValue'&&numberText(value.value.value);
 case Type.CHOICE:return value.value.case==='stringValue'&&definition.options.includes(value.value.value);
 default:return false;
 }
}
export function validInputDefinitions(definitions:Definition[]) {
 const names=new Set<string>();
 return definitions.length<=25&&definitions.every(definition=>{
  const name=definition.name.toLowerCase();
  if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(definition.name)||names.has(name)||!literal(definition.description,1024)||![Type.STRING,Type.BOOLEAN,Type.NUMBER,Type.CHOICE].includes(definition.type))return false;
  names.add(name);
  if(definition.type===Type.CHOICE){if(!definition.options.length||definition.options.length>25||new Set(definition.options).size!==definition.options.length||definition.options.some(option=>!option.trim()||!literal(option,2048)))return false;}
  else if(definition.options.length)return false;
  return !definition.defaultValue||(validValue(definition.defaultValue,definition)&& (definition.defaultValue.value.case!=='stringValue'||!definition.defaultValue.value.value.includes('${{')));
 });
}
export function sameInputDefinitions(a:Definition[],b:Definition[]) {
 return validInputDefinitions(a)&&validInputDefinitions(b)&&JSON.stringify(a.map(value=>toJson(WorkflowDispatchInputDefinitionSchema,value)))===JSON.stringify(b.map(value=>toJson(WorkflowDispatchInputDefinitionSchema,value)));
}
export type PreparedTarget={owner:string;name:string;repositoryId:string;ownerId:string;actorId:string;commitId:string;workflowPath:string;workflowBlobId:string;schemaSha256:string};
export function verifyInputPreparation(receipt:PrepareWorkflowDispatchResponse,target:PreparedTarget,definitions:Definition[]) {
 if(receipt.repository?.owner!==target.owner||receipt.repository?.name!==target.name||receipt.repositoryId!==target.repositoryId||receipt.ownerId!==target.ownerId||receipt.nativeActorId!==target.actorId||receipt.commitId!==target.commitId||receipt.workflowPath!==target.workflowPath||receipt.workflowBlobId!==target.workflowBlobId||receipt.schemaSha256!==target.schemaSha256||receipt.inputContract!==workflowInputsContract||!inputDigest(receipt.submittedSha256)||!inputDigest(receipt.effectiveSha256)||!sameInputDefinitions(receipt.definitions,definitions))throw new ConnectError('Workflow input preparation could not be verified. Refresh the workflow before running it.',Code.Internal);
}
type Entry={included:boolean;text:string;checked:boolean};
function submittedValues(definitions:Definition[],entries:Entry[]):Value[] {
 const values:Value[]=[];
 for(const [index,definition]of definitions.entries()){
  const entry=entries[index];if(!entry)throw new Error('Workflow inputs are incomplete.');
  if(!entry.included){if(!definition.defaultValue&&(definition.required||definition.type===Type.NUMBER||definition.type===Type.CHOICE))throw new Error(`Supply ${definition.name} or use a declared default.`);continue;}
  const value=create(WorkflowDispatchInputValueSchema,{name:definition.name,value:definition.type===Type.BOOLEAN?{case:'booleanValue',value:entry.checked}:definition.type===Type.NUMBER?{case:'numberValue',value:entry.text}:{case:'stringValue',value:entry.text}});
  if(!validValue(value,definition))throw new Error(`Enter a valid value for ${definition.name}.`);
  values.push(value);
 }
 return values;
}
function defaultLabel(definition:Definition){const value=definition.defaultValue?.value;return value?.case===undefined?'Not declared':value.case==='booleanValue'?String(value.value):value.value===''?'Empty string':value.value;}
export function WorkflowDispatchInputs({path,definitions,pending,onRun,onCancel,title='Run workflow',actionLabel='Run workflow with inputs',label='Run workflow inputs',formLabel='Workflow inputs'}:{title?:string;actionLabel?:string;label?:string;formLabel?:string;path:string;definitions:Definition[];pending:boolean;onRun:(values:Value[])=>Promise<void>;onCancel:()=>void}){
 const first=useRef<HTMLInputElement>(null);
 const form=useForm({defaultValues:{entries:definitions.map(definition=>({included:!definition.defaultValue&&(definition.required||definition.type===Type.NUMBER||definition.type===Type.CHOICE),text:definition.type===Type.CHOICE?definition.options[0]||'':'',checked:false}))},validators:{onSubmit:({value})=>{try{submittedValues(definitions,value.entries);return undefined;}catch(error){return error instanceof Error?error.message:'Workflow inputs are invalid.';}}},onSubmit:async({value})=>{await onRun(submittedValues(definitions,value.entries));}});
 useEffect(()=>{first.current?.focus();},[]);
 return <section className="browser-panel credential-list-panel" aria-label={label}><div className="browser-panel-heading"><h3>{title}</h3><button type="button" className="icon-button" aria-label={`Close ${formLabel.toLowerCase()}`} disabled={pending} onClick={onCancel}><X size={16}/></button></div><p className="panel-footnote"><code>{path}</code> · Values stay in this editor until the request finishes. Omitted inputs use the declared default.</p><form className="credential-form-content" aria-label={formLabel} onSubmit={event=>{event.preventDefault();if(!pending)void form.handleSubmit();}}>
 {definitions.map((definition,index)=><fieldset key={definition.name} disabled={pending}><legend>{definition.name}{definition.required?' (required)':''}</legend>{definition.description?<p className="field-help">{definition.description}</p>:null}<p className="field-help">Default: <code>{defaultLabel(definition)}</code></p><form.Field name={`entries[${index}].included`}>{field=><label><input ref={index===0?first:undefined} type="checkbox" checked={field.state.value} onChange={event=>field.handleChange(event.target.checked)}/>Supply {definition.name}</label>}</form.Field><form.Subscribe selector={state=>state.values.entries[index]?.included}>{included=>included?definition.type===Type.BOOLEAN?<form.Field name={`entries[${index}].checked`}>{field=><label><input type="checkbox" checked={field.state.value} onChange={event=>field.handleChange(event.target.checked)}/>{definition.name} value</label>}</form.Field>:<form.Field name={`entries[${index}].text`}>{field=><><label htmlFor={`workflow-input-${index}`}>{definition.name} value</label>{definition.type===Type.CHOICE?<select id={`workflow-input-${index}`} value={field.state.value} onChange={event=>field.handleChange(event.target.value)}>{definition.options.map(option=><option key={option} value={option}>{option}</option>)}</select>:<input id={`workflow-input-${index}`} type="text" inputMode={definition.type===Type.NUMBER?'decimal':undefined} autoComplete="off" spellCheck={false} maxLength={definition.type===Type.NUMBER?64:2048} value={field.state.value} onBlur={field.handleBlur} onChange={event=>field.handleChange(event.target.value)}/>}</>}</form.Field>:null}</form.Subscribe></fieldset>)}
 <form.Subscribe selector={state=>state.errors}>{errors=>errors.length?<p role="alert">{errors.map(String).join(' ')}</p>:null}</form.Subscribe><div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}{actionLabel}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div></form></section>;
}
