import { BIRD_SPECIES, type BirdSpeciesId } from './catalog';
import './gallery.css';
const host = document.getElementById('aviary')!;
host.innerHTML = `<main><header><a href="/?autostart=1">SAN FRANCISCO / FIELD STUDIES</a><span>COLLECTION 001 — AVIAN LIFE</span></header><section class="intro"><p class="eyebrow">THE FLIGHT ATELIER</p><h1>Wild by design.</h1><p>Three studies in color, movement, and the art of flight.</p></section><div id="stage"><div id="empty"><span>↗</span><p>Choose a bird to enter the atelier.</p></div></div><nav class="species" aria-label="Bird species">${BIRD_SPECIES.map((s,i) => `<button data-species="${s.id}" style="--accent:${s.color}"><small>0${i+1}</small><strong>${s.name}</strong><span>${s.subtitle}</span><em>Explore ↗</em></button>`).join('')}</nav><footer><div class="controls"><button id="compare">All three</button><select id="motion" aria-label="Animation"><option>Auto</option><option>Fly</option><option>Glide</option><option>Scatter</option></select><button id="flock">See the flock</button><button id="scatter">Plane fly-through</button></div><span id="status" role="status">Drag to orbit · Scroll to look closer</span></footer></main>`;
let viewer: Awaited<ReturnType<typeof import('./galleryScene').createGallery>> | undefined;
let loading: Promise<void> | undefined;
const status = document.getElementById('status')!;
let request = 0;
async function ensure() {
  if (viewer) return;
  if (loading) return loading;
  loading = import('./galleryScene').then(async m => { viewer = await m.createGallery(document.getElementById('stage')!); }).finally(() => { loading = undefined; });
  return loading;
}
async function choose(ids: BirdSpeciesId[], flock = false) {
  const token = ++request; status.textContent = 'Preparing plumage and flight…';
  try {
    await ensure(); if (token !== request) return;
    await viewer!.show(ids, flock); if (token !== request) return;
    document.getElementById('empty')?.remove();
    host.querySelectorAll<HTMLButtonElement>('[data-species]').forEach(b => b.classList.toggle('selected', ids.includes(b.dataset.species as BirdSpeciesId)));
    status.textContent = flock ? 'Local WebGPU flock · Plane fly-through scatters the birds' : 'Drag to orbit · Scroll to inspect feather detail';
  } catch (error) { status.textContent = `Could not open the atelier: ${error instanceof Error ? error.message : error}`; console.error(error); }
}
let selected: BirdSpeciesId = 'pearl-gull';
host.querySelectorAll<HTMLButtonElement>('[data-species]').forEach(b => b.onclick = () => { selected = b.dataset.species as BirdSpeciesId; void choose([selected]); });
document.getElementById('compare')!.onclick = () => { void choose(BIRD_SPECIES.map(s => s.id)); };
document.getElementById('flock')!.onclick = () => { void choose([selected], true); };
document.getElementById('scatter')!.onclick = () => viewer?.scatter();
(document.getElementById('motion') as HTMLSelectElement).onchange = e => viewer?.setAnimation((e.target as HTMLSelectElement).value as 'Auto' | 'Fly' | 'Glide' | 'Scatter');
import.meta.hot?.dispose(() => viewer?.dispose());
