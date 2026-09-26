/* Natural hazards at one point, for the listing pages.

   - Flood (5-, 25- and 100-year rain), storm surge (the four PAGASA storm
     surge advisory levels), landslide and debris flow: UP NOAH's hazard maps,
     ODbL, read straight from the PMTiles files BetterGov.ph publishes on
     Hugging Face. A PMTiles file is one big archive read in small ranges, so
     a point costs a few hundred kilobytes, not the gigabytes of the whole map.
   Ground height was tried and left out: the free elevation data measures
   the tops of buildings in dense districts (Salcedo Village came out at
   56 m), which would mislead more than it helps.

   hazardAt(lat, lng) answers with plain numbers (0 = not in any mapped area,
   1 low, 2 medium, 3 high); server.js turns them into words. */
'use strict';

const NOAH = 'https://huggingface.co/datasets/bettergovph/project-noah-hazard-maps/resolve/main/PMTiles/layers/';
const UA = 'GLRA Realty website (https://glrarealty.com; glrarealty@gmail.com)';
// Bumped when the set of layers or their meaning changes, so every listing
// is looked at again.
const HAZARD_VERSION = 1;

let libs = null;
async function load() {
  if (!libs) {
    libs = Promise.all([import('pmtiles'), import('@mapbox/vector-tile'), import('pbf')]).then(([pm, vt, pbf]) => ({
      PMTiles: pm.PMTiles, FetchSource: pm.FetchSource, VectorTile: vt.VectorTile, Pbf: pbf.PbfReader || pbf.default
    }));
    libs.catch(() => { libs = null; });
  }
  return libs;
}

// One archive object per layer, kept: it remembers the archive's directory,
// so the second listing in the same city costs one small read, not three.
const archives = new Map();
async function archive(name) {
  if (!archives.has(name)) {
    const { PMTiles, FetchSource } = await load();
    archives.set(name, new PMTiles(new FetchSource(NOAH + name + '.pmtiles', new Headers({ 'User-Agent': UA }))));
  }
  return archives.get(name);
}

function tileXY(lat, lng, z) {
  const n = 2 ** z, x = (lng + 180) / 360 * n;
  const r = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  return { x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
}
// Even-odd test over every ring of a polygon feature: a point inside an
// outer ring and inside one of its holes is outside, as it should be.
function inside(px, py, rings) {
  let inn = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > py) !== (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) inn = !inn;
    }
  }
  return inn;
}

// The highest hazard level mapped at the point in one layer: 0 when the
// point is outside every mapped area (or the layer has no tile there).
async function levelAt(name, lat, lng) {
  const { VectorTile, Pbf } = await load();
  const pm = await archive(name);
  const h = await pm.getHeader();
  const z = h.maxZoom;
  const t = tileXY(lat, lng, z);
  const tile = await pm.getZxy(z, t.x, t.y);
  if (!tile || !tile.data) return 0;
  const vt = new VectorTile(new Pbf(new Uint8Array(tile.data)));
  let best = 0;
  for (const id of Object.keys(vt.layers)) {
    const L = vt.layers[id];
    const px = t.fx * L.extent, py = t.fy * L.extent;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      if (f.type !== 3) continue;
      const v = Number(f.properties.Var != null ? f.properties.Var : f.properties.HAZ) || 0;
      if (v > best && inside(px, py, f.loadGeometry())) best = v;
    }
  }
  return Math.max(0, Math.min(3, best));
}

async function hazardAt(lat, lng) {
  const out = { v: HAZARD_VERSION, at: new Date() };
  out.f5 = await levelAt('flood_5yr', lat, lng);
  out.f25 = await levelAt('flood_25yr', lat, lng);
  out.f100 = await levelAt('flood_100yr', lat, lng);
  // Storm surge: the lowest advisory level that reaches the point (1 = a 2 m
  // surge ... 4 = over 4 m), and how deep it gets at that level. 0 = none of
  // the four reach it.
  out.ss = 0; out.ssh = 0;
  for (let n = 1; n <= 4; n++) {
    const lv = await levelAt('storm_surge_ssa' + n, lat, lng);
    if (lv) { out.ss = n; out.ssh = lv; break; }
  }
  out.ls = await levelAt('landslide', lat, lng);
  out.df = await levelAt('debris_flow', lat, lng);
  return out;
}

module.exports = { hazardAt, HAZARD_VERSION, _test: { inside, tileXY } };
