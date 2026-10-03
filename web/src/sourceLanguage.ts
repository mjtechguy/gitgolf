const languages: Record<string, string> = { js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',go:'go',rs:'rust',sh:'bash',yml:'yaml',yaml:'yaml',json:'json',css:'css',html:'xml',xml:'xml',sql:'sql',md:'markdown',toml:'ini',ini:'ini',java:'java',rb:'ruby',php:'php',c:'c',h:'c',cpp:'cpp',cs:'csharp',dockerfile:'dockerfile' };
export function sourceLanguage(path:string) {
 const filename=path.split('/').pop()?.toLowerCase()||'';
 const key=Object.hasOwn(languages,filename)?filename:filename.split('.').pop()||'';
 return Object.hasOwn(languages,key)?languages[key]||'':'';
}
