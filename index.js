/**
 * Cloudflare Worker: CompanyCam webhook receiver + GeoJSON publisher
 *
 * Routes:
 *  POST /companycam/webhook  (receive signed webhook)
 *  GET  /projects.geojson    (public feed for your website)
 *
 * Storage:
 *  - KV namespace: COMPANYCAM_PROJECTS
 *
 * Env vars/secrets:
 *  - COMPANYCAM_WEBHOOK_TOKEN (string)
 *  - MAP_LABEL (optional, default "Website Map")
 *  - JITTER_METERS (optional, default 0)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/projects.geojson") {
      return handleGeoJSON(request, env);
    }

    if (request.method === "POST" && url.pathname === "/companycam/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleGeoJSON(request, env) {
  // Serve cached GeoJSON (fast path)
  const cached = await env.COMPANYCAM_PROJECTS.get("__geojson__");
  const body = cached || JSON.stringify(emptyFeatureCollection());

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/geo+json; charset=utf-8",
      "cache-control": "public, max-age=60",
      // Allow your site to fetch it (tighten to your domain once you’re done testing)
      "access-control-allow-origin": "*",
    },
  });
}

async function handleWebhook(request, env, ctx) {
  const rawBody = await request.text();

  // 1) Verify signature if present
  // NOTE: This matches the common "HMAC-SHA1 + base64" pattern described by CompanyCam.
  // If your signature never matches, the only thing to change is the encoding/algorithm
  // (base64 vs hex, sha1 vs sha256) per your CompanyCam webhook docs/account settings.
  const signature = request.headers.get("X-CompanyCam-Signature");
  if (signature) {
    const ok = await verifyHmacSha1Base64(signature, rawBody, env.COMPANYCAM_WEBHOOK_TOKEN);
    if (!ok) return new Response("Invalid signature", { status: 401 });
  }

  // 2) Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  // 3) Extract project-ish data from a few likely shapes
  const project = extractProject(payload);
  if (!project?.id) {
    // Not fatal; acknowledge so CompanyCam doesn’t retry forever
    return new Response("No project id in payload (acknowledged)", { status: 200 });
  }

  // 4) Optional: only publish projects with a specific label
  const requiredLabel = (env.MAP_LABEL || "Website Map").trim();
  const labels = normalizeLabels(project.labels);
  const isPublishable = requiredLabel ? labels.includes(requiredLabel) : true;

  // 5) Require coordinates for mapping
  // If your webhook doesn’t include lat/lng, you’ll need to fetch details from CompanyCam API here.
  const lat = toNumber(project.lat ?? project.latitude);
  const lng = toNumber(project.lng ?? project.longitude ?? project.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    // Store minimal record anyway (useful for debugging), but don’t include on map
    await env.COMPANYCAM_PROJECTS.put(projectKey(project.id), JSON.stringify({ ...project, _missingCoords: true }));
    ctx.waitUntil(regenerateGeoJSON(env));
    return new Response("Missing coordinates (stored, not mapped)", { status: 200 });
  }

  // 6) Jitter (privacy) if configured
  const jitterMeters = toNumber(env.JITTER_METERS) || 0;
  const coords = jitterMeters > 0 ? jitterLatLng(lat, lng, jitterMeters, project.id) : { lat, lng };

  // 7) Save normalized record
  const record = {
    id: String(project.id),
    title: project.title || project.name || "Project",
    category: project.category || null,
    labels,
    published: Boolean(isPublishable),
    lat: coords.lat,
    lng: coords.lng,
    thumb_url: project.thumb_url || project.thumbnail_url || project.cover_photo_url || null,
    url: project.url || project.public_url || null,
    updated_at: new Date().toISOString(),
  };

  await env.COMPANYCAM_PROJECTS.put(projectKey(record.id), JSON.stringify(record));

  // 8) Regenerate GeoJSON in background
  ctx.waitUntil(regenerateGeoJSON(env));

  return new Response("OK", { status: 200 });
}

function extractProject(payload) {
  // common-ish patterns: payload.project, payload.data.project, payload.data, payload
  const p =
    payload?.project ||
    payload?.data?.project ||
    payload?.data ||
    payload;

  // normalize id
  const id = p?.id || p?.project_id || p?.uuid;
  if (!id) return null;

  // labels can be array of strings or objects
  return { ...p, id };
}

function normalizeLabels(labels) {
  if (!labels) return [];
  if (Array.isArray(labels)) {
    return labels
      .map((x) => (typeof x === "string" ? x : x?.name))
      .filter(Boolean)
      .map((s) => String(s).trim());
  }
  return [];
}

function projectKey(id) {
  return `project:${String(id)}`;
}

async function regenerateGeoJSON(env) {
  // List all keys (KV list is paginated; this handles multiple pages)
  const features = [];
  let cursor = undefined;

  do {
    const page = await env.COMPANYCAM_PROJECTS.list({ prefix: "project:", cursor });
    cursor = page.cursor;

    for (const k of page.keys) {
      const raw = await env.COMPANYCAM_PROJECTS.get(k.name);
      if (!raw) continue;

      const rec = safeJson(raw);
      if (!rec?.published) continue;
      if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lng)) continue;

      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [rec.lng, rec.lat] },
        properties: {
          id: rec.id,
          title: rec.title,
          category: rec.category,
          labels: rec.labels,
          thumb_url: rec.thumb_url,
          url: rec.url,
        },
      });
    }
  } while (cursor);

  const geojson = {
    type: "FeatureCollection",
    features,
  };

  await env.COMPANYCAM_PROJECTS.put("__geojson__", JSON.stringify(geojson));
}

function emptyFeatureCollection() {
    return { type: "FeatureCollection", features: [] };
}

function safeJson(s) {
    try { return JSON.parse(s); } catch { return null; }
}

function toNumber(x) {
    const n = typeof x === "string" ? Number(x)  : x;
    return Number.isFinite(n) ? n : NaN;
}

async function verifyHmacSha1Base64(signatureHeader, body, secret) {
    if (!secret) return false;

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expected = base64FromArrayBuffer(sigBuf);

    return timingSafeEqual(signatureHeader.trim(), expected.trim());
}

function base64FromArrayBuffer(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let out = 0;
    for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return out === 0;
}

/** Deterministic jitter so the same project always appears in the same offset place.
 * Great for privacy without pins hopping around.
 */

function jitterLantlng(lat, lng, meters, seedStr) {
    // simple deterministic pseudo-random from seed
    const seed = hashString(seedStr);
    const rand1 = mulberry32(seed);
    const rand2 = mulberry32(seed ^ 0x9e3779b9) ();

    const r = meters * Math.sqrt(rand1);
    const theta = 2 * Math.PI * rand2;

    // convert meters to degrees
    const dLat = (r * Math.cos(theta)) / 111320;
    const dLng = (r * Math.sin(theta)) / (111320 * Math.cos((lat * Math.PI) / 180));
    
    return { lat: lat + dLat, lng: lng + dLng };
}

function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(a) {
    return function() {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

}
