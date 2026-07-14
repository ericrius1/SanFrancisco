# Fog weather architecture

The fog system is designed to feel like San Francisco immediately, vary coherently over hours and days, and optionally converge on current conditions without making startup depend on a network request.

## Runtime model

Procedural weather is always the base layer. It is deterministic from San Francisco civil date and time, so the same simulated instant produces the same weather whether time is moving forward, accelerated, paused, or scrubbed backward.

Live observations are a bias on that procedural state, not a replacement weather engine:

1. The procedural model produces the current marine bank, distance haze, localized mist, wind, coastal front, and Golden Gate reach.
2. The live adapter normalizes several government weather feeds into a compact macro-weather signal.
3. The client blends that signal into the procedural state according to the selected mode, source confidence, and data freshness.
4. The retained fog renderer receives one coherent state. Live data does not directly mutate individual art controls.

This gives the world a useful first frame, smooth transitions when data arrives, deterministic simulated time, and a graceful fallback during network or provider outages.

## Procedural San Francisco weather

The procedural model uses continuous, seeded noise over a scalar civil-day timeline rather than choosing an unrelated random value every day. Its major influences are:

- a summer marine maximum and an early-autumn clearing notch;
- correlated multi-day synoptic regimes;
- day-specific morning burn-off and evening return timing;
- overnight strengthening toward dawn;
- wind-driven movement and a west-to-east coastal front;
- a distinct Golden Gate tongue, inland floor, top height, billow, and drift.

Nearby times and neighboring days therefore remain related, while no two days need to be identical. Because the sampler has no dependency on browser wall-clock history, reverse scrubbing and accelerated time remain stable.

## Modes and clock semantics

The Rendering / Fog pane exposes three weather-source modes:

| Mode | Behavior |
| --- | --- |
| `procedural SF` | Uses only the deterministic procedural model. No live feed is needed. |
| `procedural + live` | Blends live conditions into the procedural model. The Live influence control sets the requested maximum blend. |
| `live SF` | Requests full live influence, still bounded by provider confidence and freshness. Procedural weather remains the fallback. |

Live influence is permitted only while the sky is following the real clock. If the player scrubs, selects another time, or uses an accelerated or frozen simulated clock, the live contribution falls to zero and the procedural model owns the result. Returning the sky to real time allows the current live signal to blend back in. This prevents a real 8 a.m. observation from being applied to a simulated afternoon or future date.

Even in `live SF`, the renderer never blocks on data and never treats stale measurements as authoritative. “Live” means maximum eligible live weight, not unconditional replacement.

## Government data sources and spatial roles

The same-origin server adapter gathers complementary observations. METAR is strongest for current surface visibility and ceiling; the National Weather Service grid provides broader spatial and forecast context.

| Source | Role | Location |
| --- | --- | --- |
| AviationWeather.gov METAR `KHAF` | `coast` | Half Moon Bay / incoming marine air |
| AviationWeather.gov METAR `KSFO` | `southBay` | South Bay and city proxy |
| AviationWeather.gov METAR `KOAK` | `eastBay` | Bay-side contrast |
| NWS MTR grid `81,105` | `west` | Ocean Beach / west side |
| NWS MTR grid `85,105` | `center` | Central city / downtown context |
| NWS MTR grid `88,106` | `bay` | Bay side |

Each paired area starts with a 68% station / 32% grid weighting, then weights are reduced independently by freshness. This preserves the direct observational value of METAR while using the NWS grid to shape city-scale coverage.

METAR inputs include visibility, present-weather codes, temperature/dewpoint spread, cloud layers, vertical visibility, and wind. NWS inputs include visibility, ceiling, relative humidity, total sky cover, and wind. The normalizer distinguishes surface fog from a low layer aloft: excellent horizontal visibility plus low overcast should not turn every street into dense soup. Non-positive NWS ceiling sentinel values are ignored rather than interpreted as a ceiling at ground level.

Wind direction is converted from the meteorological “from” convention into a movement vector before it biases fog advection.

Official references:

- [AviationWeather.gov Data API](https://aviationweather.gov/data/api/) — METAR JSON, provider usage rules, rate limits, and required request identification.
- [National Weather Service API documentation](https://www.weather.gov/documentation/services-web-api) — free/open forecast-grid data, cache guidance, and request identification.

## Freshness, caching, and failure behavior

Freshness is evaluated per station and grid role. One delayed station does not invalidate otherwise useful city data.

| Data | Full influence through | Expires after |
| --- | ---: | ---: |
| METAR station observation | 20 minutes | 90 minutes |
| NWS grid value | 90 minutes | 6 hours |

Between those thresholds, influence decays smoothly. The aggregate live weight is:

`requested mode weight × normalized confidence × freshness`

and is additionally gated by real-clock mode. Client-side smoothing prevents visible jumps when a provider updates or disappears.

There are two intentionally separate cache layers:

- The browser retains the last normalized payload in `localStorage`, applies it immediately only when it still contains usable fresh observations, and polls every five minutes with jitter. Requests time out after seven seconds, do not overlap, pause while the document is hidden, and resume when the page becomes visible or connectivity returns.
- The server keeps single-flight in-memory upstream caches: five minutes for METAR and 30 minutes for NWS grid data, with an availability-oriented stale horizon of three hours. That stale server copy can keep a partial response available, but it does not override client observation-age checks or extend render influence.

Upstream calls have a four-second timeout and a five-MiB response cap. Partial provider success is returned. If neither provider has usable data or retained cache, the endpoint responds with `503`, while the visual system simply remains procedural. The endpoint advertises a short shared cache (`max-age=60`) with `stale-while-revalidate=900`.

## Same-origin API contract

The browser fetches `GET /api/weather/fog`; it never calls weather providers directly. Keeping the adapter same-origin avoids provider CORS limitations, keeps request policy and identification on the server, and ensures that provider-specific schemas do not leak into rendering code. `HEAD` is also supported; other methods return `405`.

The version-1 response shape is:

```json
{
  "version": 1,
  "generatedAt": "2026-07-13T12:00:00.000Z",
  "stale": false,
  "sources": {
    "metar": { "ok": true, "fetchedAt": "2026-07-13T12:00:00.000Z" },
    "nwsGrid": { "ok": true, "fetchedAt": "2026-07-13T12:00:00.000Z" }
  },
  "stations": [
    {
      "role": "coast",
      "id": "KHAF",
      "observedAt": "2026-07-13T11:55:00.000Z",
      "visibilityM": 1609,
      "temperatureC": 13,
      "dewpointC": 12,
      "windFromDeg": 280,
      "windSpeedMps": 4.6,
      "weather": "BR",
      "clouds": [{ "cover": "OVC", "baseM": 152 }]
    }
  ],
  "grid": [
    {
      "role": "west",
      "issuedAt": "2026-07-13T11:30:00.000Z",
      "validAt": "2026-07-13T12:00:00.000Z",
      "visibilityM": 3200,
      "ceilingM": 180,
      "humidityPct": 96,
      "skyCoverPct": 94,
      "windFromDeg": 275,
      "windSpeedMps": 5.2
    }
  ],
  "satellite": {
    "available": false,
    "detail": "GOES mask pending"
  }
}
```

Every nullable measurement may be `null`; consumers must judge the reading from the fields actually present. The server normalizes units to metres, degrees Celsius, metres per second, degrees, and percentages. Art-direction mapping remains client-side.

For local development, Vite proxies `/api/weather` to the local relay. Production serves the route from the application server. The relay identifies itself upstream through `SF_WEATHER_USER_AGENT`.

## Lazy-loading lifecycle

Weather data is optional content under the massive-app loading policy. The initial bundle and boot path construct procedural fog only. After the world reveal, a live-capable mode dynamically imports the live-feed module, applies a valid cached payload if available, and begins background polling. Nothing waits for that import or request.

Selecting `procedural SF` stops the feed. Selecting a live-capable mode later starts it on demand. This keeps clean boot free of live-weather code and requests while preserving an immediate procedural result.

## Controls and diagnostics

The Rendering / Fog folder contains:

- **All fog** — enables or disables the fog system.
- **Master density** — globally scales the marine bank, distance haze, and localized mist. The cull-edge concealment veil is intentionally excluded because it hides world-streaming boundaries rather than representing weather.
- **Weather source** — selects one of the three modes above.
- **Live influence** — maximum requested live blend in `procedural + live`.
- Existing art controls for height, marine bank, billow, motion, and distance haze.

Slider defaults, ranges, and labels live in `WORLD_TUNING` in `src/config.ts` — treat those tweakpane params as the source of truth, not this doc.

Read-only diagnostics in the same folder report the active driver, San Francisco date, actual live mix, bank and haze levels, coastal-front state, observation summary, provider detail, satellite status, and receipt time. The actual live mix is the useful truth: it reflects mode, real-clock eligibility, confidence, and freshness rather than merely echoing the requested slider.

## Future GOES Fog/Low Stratus boundary

GOES satellite fog is deliberately not claimed as implemented. The current contract reports `satellite.available: false` and diagnostics show that the GOES mask is pending.

NOAA's Fog/Low Stratus product (`ABI-L2-GFLS`) estimates fog and low-cloud thickness and probabilities of reduced aviation visibility at roughly ten-minute intervals. It is delivered as a scientific NetCDF-4 product in the GOES fixed-grid projection, and official access is oriented around archives/order/search and operational data distribution rather than a small browser-ready city JSON response:

- [NOAA GOES Fog/Low Stratus product metadata](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc%3AC01572)
- [NOAA operational satellite-data formats and access overview](https://www.star.nesdis.noaa.gov/atmospheric-composition-training/satellite_data.php)

The production boundary should therefore be a separate scheduled preprocessor, not the browser and not the synchronous `/api/weather/fog` request handler. Approximately every ten minutes it would:

1. Acquire the appropriate FLS scene and inspect product-quality flags.
2. Decode NetCDF-4 and reproject/sample only the San Francisco bounding box.
3. Convert fog probability, low-cloud thickness, and quality into a compact versioned 32×32 or 64×64 city mask.
4. Publish that mask as a small byte array, binary object, or lossless image with observation time, source, projection/version, and quality metadata.
5. Let the same-origin adapter advertise the current mask URL and metadata.

The client would fetch the mask lazily only after world reveal and only for a live-capable mode, freshness-decay the last good mask, and continue using procedural fog if it is absent. It should not download or decode regional NetCDF files in the browser, and ordinary satellite RGB imagery should not be treated as an equivalent fog sensor.
