import type * as THREE from "three/webgpu";

/** Sample one live frame every two seconds. Mapping is asynchronous and never
 * awaited by the frame loop. Unsupported adapters keep pacing/CPU telemetry. */
export function createGpuFrameTiming(renderer: THREE.WebGPURenderer) {
  const backend = renderer.backend as typeof renderer.backend & { trackTimestamp: boolean };
  const supported = renderer.hasFeature("timestamp-query");
  let owned = false, pending = false, nextAt = performance.now()+5000;
  let renderQueries = 0, computeQueries = 0;
  let renderMs = 0, computeMs = 0, sampledAt = 0;
  let enabled = supported;
  // r185 reuses pass descriptors. When tracking is turned off it leaves the
  // preceding timestampWrites attached, which would keep writing old queries.
  // Clear only the inactive descriptor; preserve the backend's active path.
  const host = backend as unknown as { initTimestampQuery(type:string,uid:number,descriptor:{timestampWrites?:unknown}):void };
  const original = host.initTimestampQuery;
  if (supported) host.initTimestampQuery = function(type,uid,descriptor) {
    if (!backend.trackTimestamp) { delete descriptor.timestampWrites; return; }
    original.call(this,type,uid,descriptor);
    if (owned && descriptor.timestampWrites) {
      if (type === "render") renderQueries++;
      if (type === "compute") computeQueries++;
    }
  };
  return {
    begin() {
      if (!enabled || pending || backend.trackTimestamp || performance.now()<nextAt) return;
      owned = true;
      renderQueries = computeQueries = 0;
      backend.trackTimestamp = true;
    },
    end() {
      if (!owned) return;
      owned = false;
      pending = true;
      nextAt = performance.now()+2000;
      if (!renderQueries) sampledAt = 0;
      // r185 returns its LAST value when a query pool received no new work.
      // Compile-held frames must not turn that cached value into fresh GPU
      // pressure. Drain any real compute work, but publish only rendered frames.
      const query = Promise.all([
        renderQueries ? renderer.resolveTimestampsAsync("render") : Promise.resolve(0),
        computeQueries ? renderer.resolveTimestampsAsync("compute") : Promise.resolve(0)
      ]);
      backend.trackTimestamp = false;
      void query.then(([render,compute]) => {
        if (typeof render === "number" && render > 0 && Number.isFinite(render)) {
          renderMs = render; computeMs = typeof compute === "number" && Number.isFinite(compute) ? compute : 0;
          sampledAt = performance.now();
        }
      }).catch(() => { enabled = false; }).finally(() => { pending = false; });
    },
    get totalMs(): number | undefined { return sampledAt && performance.now()-sampledAt<6000 ? renderMs+computeMs : undefined; },
    get stats() { return {supported,enabled,pending,renderMs,computeMs,sampledAt}; },
    dispose() { enabled = false; if (owned) backend.trackTimestamp=false; if(supported)host.initTimestampQuery=original; }
  };
}
