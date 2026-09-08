/** GPT concept image -> Tripo base mesh. Credentials remain in the environment.
 * Generated results are sculpt/rig inputs, never automatically shipped assets.
 * node --env-file=.env tools/aviary/generate.mjs submit lagoon-jay lagoon-reference-v2.png
 * node --env-file=.env tools/aviary/generate.mjs collect lagoon-jay
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const [mode,id,filename]=process.argv.slice(2);
const dir=path.resolve('.data/aviary/generation',id);await mkdir(dir,{recursive:true});
const headers={Authorization:`Bearer ${process.env.TRIPO_API_KEY}`};
if(!process.env.TRIPO_API_KEY)throw Error('TRIPO_API_KEY must be loaded from .env');
async function api(route,options={}){
 const r=await fetch('https://api.tripo3d.ai/v2/openapi'+route,{...options,headers:{...headers,...options.headers}});
 const j=await r.json();if(!r.ok||j.code!==0)throw Error(`Tripo ${r.status}: ${JSON.stringify(j)}`);return j.data;
}
if(mode==='submit'){
 const form=new FormData();form.append('file',new Blob([await readFile(path.resolve('assets-src/aviary',filename))],{type:'image/png'}),filename);
 const uploaded=await api('/upload/sts',{method:'POST',body:form});
 const payload={type:'image_to_model',model_version:'v3.1-20260211',file:{type:'png',file_token:uploaded.image_token},texture:true,pbr:true,texture_quality:'detailed',face_limit:30000,orientation:'default',auto_size:false,export_uv:true};
 const task=await api('/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 await writeFile(path.join(dir,'task.json'),JSON.stringify({id,filename,...task},null,2));console.log(id,task.task_id);
}else if(mode==='collect'){
 const {task_id}=JSON.parse(await readFile(path.join(dir,'task.json'),'utf8'));const task=await api('/task/'+task_id);
 await writeFile(path.join(dir,'status.json'),JSON.stringify(task,null,2));console.log(id,task.status,task.progress);
 if(task.status==='success'){
  for(const [key,url] of Object.entries(task.output??{})){
   if(typeof url!=='string'||!url.startsWith('https:'))continue;
   if(!/\.(glb|png|webp|jpg)(\?|$)/.test(url))continue;
   const ext=new URL(url).pathname.split('.').pop();const file=path.join(dir,key+'.'+ext);
   const r=await fetch(url);if(!r.ok)throw Error(`Download ${key}: ${r.status}`);await writeFile(file,Buffer.from(await r.arrayBuffer()));console.log('saved',file);
  }
 }
}else throw Error('Expected submit or collect');
