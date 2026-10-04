// =============================================================================
// STAFF RULES — working hours, due times and proof links (Oct 2026)
// =============================================================================
// One place for the rules the staff desk, the cloud supervisor and the alerts
// all share, so they can never disagree:
//   * Working hours: Monday to Friday, 9:00 to 18:00 Asia/Manila, with lunch
//     12:00 to 13:00. Manila has no daylight saving: UTC+8 all year.
//   * A task may be due 9:00-12:00 or 13:00-18:00 on a working day. 12:00 and
//     13:00 themselves are fine; 12:01-12:59 is lunch.
//   * A posting task is proved by the link to the post itself. A profile, a
//     page's home, a group's front page or a search result is not a post.
// =============================================================================

const OFF = 8 * 3600e3;
const WORK = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60, lunchStart: 12 * 60, lunchEnd: 13 * 60, tz: 'Asia/Manila' };
const WORK_TEXT = 'Mon-Fri 9:00-18:00 Asia/Manila, lunch 12:00-13:00';

// Manila wall clock of an instant: { day:'YYYY-MM-DD', dow, min (minute of day) }.
function manilaClock(d) {
  const m = new Date(new Date(d == null ? Date.now() : d).getTime() + OFF);
  const pad = n => String(n).padStart(2, '0');
  return { day: `${m.getUTCFullYear()}-${pad(m.getUTCMonth() + 1)}-${pad(m.getUTCDate())}`, dow: m.getUTCDay(), min: m.getUTCHours() * 60 + m.getUTCMinutes() };
}
const isWorkday = d => WORK.days.includes(manilaClock(d).dow);
const inLunch = min => min > WORK.lunchStart && min < WORK.lunchEnd;
// Is this minute of the day inside paid working time (not lunch)?
const isWorkMinute = min => min >= WORK.start && min < WORK.end && !(min >= WORK.lunchStart && min < WORK.lunchEnd);
const hm = min => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

// Why a due date is not allowed, or '' if it is fine.
function dueProblem(d) {
  if (d == null || d === '') return '';
  const t = new Date(d);
  if (isNaN(t)) return 'That due date is not a real date';
  const c = manilaClock(t);
  if (!WORK.days.includes(c.dow)) return 'Due on a Saturday or Sunday; pick a working day (Mon-Fri)';
  if (inLunch(c.min)) return `Due at ${hm(c.min)}, during lunch (12:00-13:00); pick 12:00 or 13:00 or later`;
  if (c.min < WORK.start) return `Due at ${hm(c.min)}, before work starts at 9:00`;
  if (c.min > WORK.end) return `Due at ${hm(c.min)}, after work ends at 18:00`;
  return '';
}

// Paid minutes between two instants on one day (lunch not counted).
function workedMinutes(from, to) {
  if (!from || !to) return 0;
  const a = new Date(from).getTime(), b = new Date(to).getTime();
  if (!(b > a)) return 0;
  const ca = manilaClock(a), cb = manilaClock(b);
  const s = ca.min, e = ca.day === cb.day ? cb.min : 24 * 60;
  let n = 0;
  for (let m = s; m < e; m++) if (m >= WORK.start && m < WORK.end && !(m >= WORK.lunchStart && m < WORK.lunchEnd)) n++;
  return n;
}

// ── PROOF LINKS ─────────────────────────────────────────────
function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    x.hash = '';
    const keep = new URLSearchParams();
    // These query values identify a post; everything else (tracking) is dropped.
    ['story_fbid', 'fbid', 'id', 'v', 'set', 'p'].forEach(k => { if (x.searchParams.get(k)) keep.set(k, x.searchParams.get(k)); });
    const q = keep.toString();
    return (x.hostname.replace(/^(www|m|web|mbasic|touch)\./, '') + x.pathname.replace(/\/+$/, '') + (q ? '?' + q : '')).toLowerCase();
  } catch (e) { return String(u || '').trim().toLowerCase(); }
}

// What a proof link is. { ok, kind, reason }.
//   fb_post   - a single Facebook post, photo, video, reel or group post
//   instagram - an Instagram post or reel
//   tiktok    - a TikTok video
//   portal    - a listing page on a property portal or this website
function checkProofUrl(u, want) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch (e) { return { ok: false, kind: 'none', reason: 'Not a web link' }; }
  if (!/^https?:$/.test(x.protocol)) return { ok: false, kind: 'none', reason: 'Not a web link' };
  const host = x.hostname.toLowerCase().replace(/^(www|m|web|mbasic|touch)\./, '');
  const path = x.pathname.replace(/\/+$/, '');
  const qp = k => x.searchParams.get(k);
  const fb = /^(facebook\.com|fb\.com|business\.facebook\.com)$/.test(host);
  if (host === 'fb.watch') return /^\/[A-Za-z0-9_-]{4,}$/.test(path) ? { ok: true, kind: 'fb_post' } : { ok: false, kind: 'none', reason: 'Not a Facebook video link' };
  if (fb) {
    const okPaths = [
      /^\/[^/]+\/posts\/[A-Za-z0-9_.-]{5,}$/i,          // /GLRARealty/posts/pfbid... or numeric
      /^\/[^/]+\/photos\/.+/i,                         // /page/photos/a.123/456
      /^\/[^/]+\/videos\/[A-Za-z0-9_.-]{5,}/i,
      /^\/groups\/[^/]+\/(posts|permalink)\/[0-9A-Za-z_.-]{5,}$/i,
      /^\/reel\/[0-9]{5,}$/i,
      /^\/share\/(p|r|v)\/[A-Za-z0-9_-]{4,}$/i,        // the Share button's post/reel/video links
      /^\/marketplace\/item\/[0-9]{5,}$/i
    ];
    if (okPaths.some(re => re.test(path))) return { ok: true, kind: 'fb_post' };
    if (/^\/(permalink|story)\.php$/i.test(path) && qp('story_fbid')) return { ok: true, kind: 'fb_post' };
    if (/^\/photo(\.php)?$/i.test(path) && qp('fbid')) return { ok: true, kind: 'fb_post' };
    if (/^\/watch$/i.test(path) && qp('v')) return { ok: true, kind: 'fb_post' };
    if (!path) return { ok: false, kind: 'page', reason: 'That is the Facebook home page, not a post' };
    if (/^\/profile\.php$/i.test(path)) return { ok: false, kind: 'page', reason: 'That is a profile, not a post' };
    if (/^\/groups\/[^/]+$/i.test(path)) return { ok: false, kind: 'page', reason: "That is the group's front page, not the post" };
    if (/^\/share\/[A-Za-z0-9_-]+$/i.test(path)) return { ok: false, kind: 'page', reason: 'A plain share link can point anywhere; open the post and copy its own link' };
    if (/^\/[^/]+$/.test(path)) return { ok: false, kind: 'page', reason: "That is a page or profile, not a post. Open the post and copy its link (the date under the name)" };
    return { ok: false, kind: 'page', reason: 'That Facebook link is not a single post' };
  }
  if (host === 'instagram.com') return /^\/(p|reel|tv)\/[A-Za-z0-9_-]{5,}$/i.test(path) ? { ok: true, kind: 'instagram' } : { ok: false, kind: 'page', reason: 'That Instagram link is not a single post' };
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return /\/video\/[0-9]{8,}/.test(path) || host === 'vt.tiktok.com' ? { ok: true, kind: 'tiktok' } : { ok: false, kind: 'page', reason: 'That TikTok link is not a single video' };
  if (want === 'fb') return { ok: false, kind: 'other', reason: 'This task needs the link to the Facebook post' };
  // Anything else (a portal listing, the website's listing page): it has to be
  // a specific page, not a site's home.
  if (!path || path === '/') return { ok: false, kind: 'page', reason: "That is a website's home page, not the listing" };
  return { ok: true, kind: 'portal' };
}

module.exports = { WORK, WORK_TEXT, manilaClock, isWorkday, inLunch, isWorkMinute, hm, dueProblem, workedMinutes, normUrl, checkProofUrl };
