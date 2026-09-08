import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const blender=process.env.BLENDER_BIN??'/Applications/Blender.app/Contents/MacOS/Blender';
const r=spawnSync(blender,['--background',path.join(root,'assets-src/aviary/aviary.blend'),'--python',path.join(root,'tools/aviary/export_blender.py')],{stdio:'inherit'});
process.exit(r.status??1);
