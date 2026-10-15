// =============================================================================
// LISTING LITE — read listings without dragging base64 photos out of Atlas
// =============================================================================
// A few listings still carry photos as `data:` URIs inside the document (one
// is 2.3 MB). A plain Property.find().select('mainImage gallery') pulls every
// byte of those across the wire on every call, which is what made the admin,
// Leads, Social and Staff paths slow (audit 15 Oct 2026, PERF-ADMIN-3).
//
// findListingsLite() runs the same query as an aggregate that swaps any
// data: value for the 5-character stub 'data:' INSIDE the database, then
// externalizeInline() points the stub at /api/property-image/<id>/<slot>,
// the route that streams the real photo when somebody actually looks at it.
// Same trick as the sitemap and hero routes in server.js (dataStub there).
// =============================================================================
const mongoose = require('mongoose');
const { Property } = require('./db');

// Mongo expression: the value itself, or just 'data:' when it is a data URI.
const dataStub = f => ({ $cond: [{ $eq: [{ $substrCP: [{ $convert: { input: f, to: 'string', onError: '', onNull: '' } }, 0, 5] }, 'data:'] }, 'data:', f] });
const isDataUri = v => typeof v === 'string' && v.startsWith('data:');

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; }
}

// Turn the 'data:' stubs into links to the image route. mainImage and gallery
// have their own slots; a coverImage that was inline matches nothing on the
// image route, so it is dropped (the cover then falls back to the first photo).
function externalizeInline(p) {
  if (!p || !p._id) return p;
  const id = String(p._id);
  if (isDataUri(p.mainImage)) p.mainImage = `/api/property-image/${id}/main`;
  if (Array.isArray(p.gallery)) p.gallery = p.gallery.map((g, i) => isDataUri(g) ? `/api/property-image/${id}/${i}` : g);
  if (isDataUri(p.coverImage)) p.coverImage = '';
  if (isDataUri(p.floorPlan)) p.floorPlan = '';
  return p;
}

// filter: a plain Mongo filter (aggregate does NOT cast, so pass ObjectIds for
// _id and real types elsewhere). fields: the non-image fields wanted. The four
// image fields are always included, stubbed. opts: { sort, limit }.
async function findListingsLite(filter, fields, opts = {}) {
  const project = { _id: 1 };
  (fields || []).forEach(f => { project[f] = 1; });
  project.mainImage = dataStub('$mainImage');
  project.coverImage = dataStub('$coverImage');
  project.gallery = { $map: { input: { $ifNull: ['$gallery', []] }, as: 'g', in: dataStub('$$g') } };
  if (opts.floorPlan) project.floorPlan = dataStub('$floorPlan');
  const pipe = [{ $match: filter || {} }];
  if (opts.sort) pipe.push({ $sort: opts.sort });
  if (opts.limit) pipe.push({ $limit: opts.limit });
  pipe.push({ $project: project });
  const rows = await Property.aggregate(pipe);
  return rows.map(externalizeInline);
}

// One listing by id, every field except the images read the stubbed way.
async function findListingLiteById(id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const rows = await Property.aggregate([
    { $match: { _id: oid } },
    { $addFields: {
      mainImage: dataStub('$mainImage'), coverImage: dataStub('$coverImage'), floorPlan: dataStub('$floorPlan'),
      gallery: { $map: { input: { $ifNull: ['$gallery', []] }, as: 'g', in: dataStub('$$g') } }
    } }
  ]);
  return rows.length ? externalizeInline(rows[0]) : null;
}

module.exports = { dataStub, isDataUri, toObjectId, externalizeInline, findListingsLite, findListingLiteById };
