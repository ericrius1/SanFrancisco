import { mkdir, open, readFile, unlink } from 'node:fs/promises';

/** Avoid contaminating GPU measurements with another performance browser. */
export async function acquirePerformanceProbe() {
  const path='.data/world-upgrade-perf.lock';
  await mkdir('.data',{recursive:true});
  try {
    const pid=Number(await readFile(path,'utf8'));
    if (!Number.isSafeInteger(pid) || pid<=0) throw new Error(`Invalid performance lock: ${path}`);
    try { process.kill(pid,0); }
    catch(error) { if(error.code!=='ESRCH')throw error; await unlink(path); }
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const handle=await open(path,'wx').catch(error=>{
    if(error.code==='EEXIST')throw new Error('Another performance probe owns the GPU measurement lock');
    throw error;
  });
  try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
  return async()=>{if(await readFile(path,'utf8')===String(process.pid))await unlink(path)};
}
