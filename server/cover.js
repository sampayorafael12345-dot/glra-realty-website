// THE WEBSITE COVER PHOTO. Listings are imported with the Facebook flyer as
// mainImage: a square with the title, price, phone number and social logos
// printed across the bottom (55 of the 57 hosted covers, Sept 2026). On the
// website the first clean gallery photo leads instead, and the flyer moves to
// the end of the gallery, where it is still there to see. A cover picked in
// the admin (coverImage) wins. Only the copy being rendered is reordered; the
// stored listing, and so the admin's edit form, are untouched.
function applyWebsiteCover(p) {
  if (!p) return p;
  const main = typeof p.mainImage === 'string' ? p.mainImage : '';
  const gallery = Array.isArray(p.gallery) ? p.gallery.filter(g => typeof g === 'string' && g) : [];
  // With no main image at all, the first gallery photo still becomes the
  // cover, so the card shows a photo rather than a blank tile.
  const pick = p.coverImage && (p.coverImage === main || gallery.includes(p.coverImage)) ? p.coverImage
    : (gallery.length ? gallery[0] : '');
  if (pick && pick !== main) {
    const rest = gallery.filter(g => g !== pick && g !== main);
    p.mainImage = pick;
    p.gallery = main ? [...rest, main] : rest;
  }
  delete p.coverImage;
  return p;
}

module.exports = { applyWebsiteCover };
