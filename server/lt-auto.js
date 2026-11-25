// =============================================================================
// GLRA LAND TITLE: INBOX AUTOMATION (plain rules, no AI)
// =============================================================================
// Sorts everyone who messages or comments on the GLRA Land Title Page into six
// groups and walks them through the intake questions the staff always ask.
//
//   A ready    case + where the land is + whose name is on the papers
//   B started  asked price / computation / how, has not finished the questions
//   C lawyer   a dispute: free first consultation by email, no process script
//   D outside  land is outside Metro Manila + CALABARZON
//   E info     only asked for the office, hours or contact
//   F none     only "Get started", greetings, thanks, chatter, spam
//
// MODES (the lt_auto setting, changed by an admin in GLRA Social):
//   off     nothing happens
//   shadow  DEFAULT. Sorts and writes down what it WOULD have sent. Never
//           contacts Meta.
//   live    sends. Needs ALL of: mode live, LT_AUTO_SEND=1 in Render, and each
//           script approved word for word (the approval is tied to the exact
//           text, so an edited script must be approved again).
//
// SAFETY: only the fixed scripts below are ever sent; a script goes to a person
// once; when a staff member answers by hand the automation is quiet for that
// person for 12 hours; a person the rules do not understand is handed to staff
// after one retry, never looped.
//
// The engine (detect / decide / decideComment) is pure: no database, no
// network. scripts/test-lt-auto.js runs it against saved conversations.
// =============================================================================
'use strict';
const crypto = require('crypto');

const LT_PAGE_DEFAULT = '136503057118212';
const QUIET_MS = 12 * 3600e3;
const GROUPS = { A: 'Ready client', B: 'Started, not finished', C: 'For the lawyer', D: 'Outside the area', E: 'Info only', F: 'Not a client yet' };
const ASKING = ['menu', 'loc', 'loc_other', 'papers', 'owner', 'died'];

const MENU = [
  ['1', 'LT_CASE_ESTATE', 'Mana / namatayan', 'Mana (namatay na ang may-ari)'],
  ['2', 'LT_CASE_SALE', 'Nabili, di nalipat', 'Nabili pero hindi pa nalilipat'],
  ['3', 'LT_CASE_UNTITLED', 'Walang titulo', 'Walang titulo / tax declaration lang'],
  ['4', 'LT_CASE_LOST', 'Nawala ang titulo', 'Nawala ang titulo'],
  ['5', 'LT_CASE_DISPUTE', 'May umaagaw/problema', 'May umaagaw o may problema sa lupa'],
  ['6', 'LT_PRICE', 'Magkano?', 'Magkano?'],
  ['7', 'LT_OFFICE', 'Opisina at contact', 'Opisina at contact']
];
const MENU_LINES = MENU.map(m => `${m[0]} - ${m[3]}`).join('\n');
const qr = list => list.map(([payload, title]) => ({ payload, title }));
const MENU_QR = qr(MENU.map(m => [m[1], m[2]]));
const EMAIL = 'glralandtransfer@gmail.com';
const OFFICE = `Sa ngayon po, sa email at private message lang po kami tumatanggap ng inquiry: ${EMAIL}. Ang pagtawag o pagbisita sa opisina ay sa pamamagitan lamang ng appointment, kapag napagkasunduan na.`;

// Every word the automation can say. The owners answered the question sheet on
// 25 Nov 2026 and these are their words. THEIR STANDING RULES, for any future
// edit: never name the lawyer, the broker or any staff member; never give an
// office address, a telephone or a cellphone number; email and private message
// only; the first consultation is free and by email; no ₱1,000 computation.
// scripts/test-lt-auto.js fails if a name, address or phone number comes back.
const SCRIPTS = {
  welcome: { text: 'Magandang araw po! Salamat sa pag-message sa GLRA Land Title. Ito po ay automated na sagot para mabilis kayong matulungan.\n\nAno po ang kailangan ninyo? Pumili po sa ibaba, o i-type ang numero:\n' + MENU_LINES, quick: MENU_QR },
  unclear: { text: 'Pasensya na po, hindi ko po nakuha. Pumili po sa ibaba, o i-type ang numero (1 hanggang 7):\n' + MENU_LINES, quick: MENU_QR },
  ask_loc: { text: 'Saan po matatagpuan ang lupa?', quick: qr([['LT_LOC_QUEZON', 'Quezon'], ['LT_LOC_LAGUNA', 'Laguna'], ['LT_LOC_BATANGAS', 'Batangas'], ['LT_LOC_CAVITE', 'Cavite'], ['LT_LOC_RIZAL', 'Rizal'], ['LT_LOC_NCR', 'Metro Manila'], ['LT_LOC_OTHER', 'Ibang probinsya']]) },
  ask_loc_other: { text: 'Saang probinsya at bayan po ang lupa? Paki-type po.' },
  ask_papers: { text: 'Ano pong papeles ang hawak ninyo para sa lupa?', quick: qr([['LT_PAP_TITLE', 'May titulo'], ['LT_PAP_TAXDEC', 'Tax declaration lang'], ['LT_PAP_UNKNOWN', 'Hindi ko alam']]) },
  ask_owner: { text: 'Kanino po nakapangalan ang titulo o tax declaration?', quick: qr([['LT_OWN_PARENTS', 'Sa magulang'], ['LT_OWN_GRAND', 'Sa lolo o lola'], ['LT_OWN_SELLER', 'Sa nagbenta'], ['LT_OWN_SELF', 'Sa akin'], ['LT_OWN_OTHER', 'Iba']]) },
  ask_died: { text: 'Anong taon po pumanaw ang may-ari? Paki-type lang po ang taon (halimbawa: 2015).' },
  close: { text: `Salamat po! Naitala na namin: {summary}.\n\nLibre po ang unang konsultasyon sa email. Para ma-assess, paki-email po ang kopya ng titulo o tax declaration sa ${EMAIL} (sa email lang po ang mga dokumento at ID, hindi sa Messenger).\n\nSasagutin po kayo ng aming staff sa susunod na araw ng opisina (Lunes hanggang Biyernes, 8 AM hanggang 5 PM).` },
  office: { text: OFFICE },
  price: { text: `Libre po ang unang konsultasyon sa pamamagitan ng email. I-kuwento lang po ang inyong sitwasyon at ipadala sa ${EMAIL}, at sasagutin din po namin kayo sa email. Ang mga susunod na konsultasyon ay ayon sa mapagkakasunduan.\n\nAng service fee po ay mula ₱30,000 hanggang ₱50,000 para sa Metro Manila, Quezon, Batangas, Cavite, Laguna at mga karatig-bayan. Sa ibang lugar, ayon po sa mapagkakasunduan. Paalala po: service fee lamang ito. Ang buwis at filing fees ay sagot po ng kliyente.` },
  reqs: { text: `Para ma-assess po, ihanda ang kopya ng titulo at tax declaration. Kung mana: death certificate at family tree. Ipadala po sa ${EMAIL}.` },
  tagal: { text: 'Karaniwang 3 hanggang 6 na buwan po kapag kumpleto ang papeles. Mas matagal kung may hatian ng lote o kaso sa korte.' },
  abroad: { text: 'Pwede po kahit nasa abroad kayo, sa pamamagitan ng Special Power of Attorney. Hindi na po kailangang umuwi.' },
  hulugan: { text: 'Pwede pong hulugan ang service fee: 50% down payment, at ang balanse ay babayaran kapag naibigay na ang titulo. Paalala po: ang ₱30,000 hanggang ₱50,000 ay para sa service fee lamang. Ang buwis at filing fees ay sagot po ng kliyente.' },
  lawyer: { text: `Salamat po sa detalye. Ang ganitong sitwasyon ay kailangan pong masuri nang mabuti. Libre po ang unang konsultasyon sa email: paki-kuwento po ang buong pangyayari at ipadala, kasama ang kopya ng inyong mga papeles, sa ${EMAIL}. Sasagutin din po namin kayo sa email.` },
  outside: { text: 'Salamat po. Metro Manila at CALABARZON po ang pangunahing sakop namin. Ipapasa ko po ang detalye ninyo sa aming staff para makumpirma kung matutulungan namin kayo sa inyong lugar.' },
  handoff: { text: 'Salamat po. Ipapasa ko po kayo sa aming staff. Sasagutin po kayo sa susunod na araw ng opisina (Lunes hanggang Biyernes, 8 AM hanggang 5 PM).' },
  // The owners want this 3 days after the person stops answering. Facebook lets
  // an automatic message go out only within 24 hours of the person's last
  // message, so it is NOT sent automatically (see ltTick in social.js): those
  // people are listed for staff to follow up by hand.
  remind: { text: 'Kumusta po! Kung gusto pa po ninyong ituloy, sagutin lang po ang huling tanong sa itaas at tutulungan namin kayo.' },
  comment_pm: { text: `Magandang araw po! Nakita po namin ang comment ninyo sa GLRA Land Title page. Ito po ay automated na mensahe para mabilis kayong matulungan.\n\nAno po ang kailangan ninyo? I-type lang po ang numero:\n${MENU_LINES}\n\nMaaari rin po kayong mag-email sa ${EMAIL}.` },
  comment_pm_office: { text: 'Magandang araw po! Nakita po namin ang comment ninyo sa GLRA Land Title page (automated na mensahe po ito). ' + OFFICE + '\n\nMay iba pa po ba kayong kailangan? I-type lang po ang numero:\n' + MENU_LINES },
  comment_pm_lawyer: { text: `Magandang araw po! Nakita po namin ang comment ninyo sa GLRA Land Title page (automated na mensahe po ito). Ang ganitong sitwasyon ay kailangan pong masuri nang mabuti. Libre po ang unang konsultasyon sa email: paki-kuwento po ang buong pangyayari at kung saan ang lupa, at ipadala sa ${EMAIL}. Sasagutin din po namin kayo sa email.` },
  comment_pm_sorry: { text: 'Magandang araw po, at pasensya na po kung natagalan ang sagot namin. Automated na mensahe po ito para hindi na kayo maghintay.\n\nAno po ang kailangan ninyo? I-type lang po ang numero:\n' + MENU_LINES },
  // Posted in public under the comment, after the private message went out.
  comment_public: { text: 'Na-message na po namin kayo.' }
};
const scriptHash = id => crypto.createHash('sha256').update(JSON.stringify([SCRIPTS[id].text, (SCRIPTS[id].quick || []).map(q => q.title)])).digest('hex').slice(0, 16);

// ── READING A MESSAGE ─────────────────────────────────────────
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
// ── SPELLING ──────────────────────────────────────────────────
// People type "mgkno", "titolo", "bininta", "lusena". Before the rules read a
// message, every word is compared with the words the rules know, and a near
// miss is read as that word. Four ways a word can match, strictest first:
//   1. a known shortcut ("aq" = ako, "pwd" = pwede)
//   2. it sounds the same (e/i, o/u, c/k/q, s/z, b/v, p/f, doubled letters)
//   3. it is the word with letters left out to save typing: same consonants
//      in the same order, some or all vowels dropped ("mgkno", "pngln", "byd")
//   4. one letter off (6+ letters) or two letters off (10+ letters)
// Place names match by sound only (rule 2): a wrong guess there would put the
// land in the wrong province. Common Cebuano and Hiligaynon words are read as
// their Tagalog meaning (yuta = lupa, tagpila = magkano, unsaon = paano).
// Still plain rules, no AI. A word that is itself a normal word (SAFE) is
// never changed, so "bayan" does not become "bayad".
const SHORT = { aq: 'ako', aqo: 'ako', q: 'ko', qo: 'ko', poh: 'po', nmn: 'naman', nman: 'naman', lng: 'lang', lang: 'lang', wla: 'wala', wlang: 'walang', wlng: 'walang',
  pwd: 'pwede', pde: 'pwede', pwde: 'pwede', pede: 'pwede', puede: 'pwede', pwdi: 'pwede', pwedi: 'pwede', panu: 'paano', pnu: 'paano', pno: 'paano', panno: 'paano', paanu: 'paano',
  kyo: 'kayo', kau: 'kayo', kaio: 'kayo', anu: 'ano', anung: 'anong', cnu: 'sino', sken: 'sa akin', skin: 'sa akin', saken: 'sa akin', sakin: 'sa akin', akn: 'akin',
  hm: 'hm', hmm: 'hm', mgkno: 'magkano', mgkano: 'magkano', mkano: 'magkano', magkno: 'magkano', mgknu: 'magkano', mgkanu: 'magkano', magkanu: 'magkano', mgkn: 'magkano', magkanoe: 'magkano',
  ttlo: 'titulo', titlo: 'titulo', ttulo: 'titulo', tittle: 'title', titel: 'title', titles: 'title', taytol: 'title', taytel: 'title',
  txdec: 'tax dec', taxdec: 'tax dec', taxdic: 'tax dec', taxdek: 'tax dec', taxdeck: 'tax dec', taxdecs: 'tax dec', taksdek: 'tax dec',
  bkt: 'bakit', kc: 'kasi', ksi: 'kasi', nde: 'hindi', ndi: 'hindi', hnd: 'hindi', hndi: 'hindi', dko: 'di ko', dpa: 'di pa', dp: 'di pa',
  tnx: 'thanks', thnx: 'thanks', thx: 'thanks', slmt: 'salamat', slamat: 'salamat', salamt: 'salamat', gud: 'good', gd: 'good',
  san: 'san', saan: 'saan', sn: 'saan', ofc: 'office', ofis: 'office', opis: 'office', adress: 'address', adres: 'address', loc: 'loc',
  req: 'requirements', reqs: 'requirements', reqts: 'requirements', requirments: 'requirements', requirment: 'requirements', rekwayrments: 'requirements',
  mgulang: 'magulang', mglang: 'magulang', kptd: 'kapatid', kptid: 'kapatid', mgkptd: 'magkakapatid', mgkkptid: 'magkakapatid',
  npangalan: 'nakapangalan', nkpangalan: 'nakapangalan', nkapangalan: 'nakapangalan', pngalan: 'pangalan', lpa: 'lupa', lupah: 'lupa', bhay: 'bahay',
  yuta: 'lupa', duta: 'lupa', tagpila: 'magkano', tagpilay: 'magkano', unsaon: 'paano', unsaun: 'paano', giunsa: 'paano', unsay: 'ano ang', diin: 'saan', hain: 'saan',
  ginikanan: 'magulang', igsoon: 'kapatid', igsuon: 'kapatid', utod: 'kapatid', manghod: 'kapatid', apohan: 'lolo', lolohon: 'lolo', kabilin: 'mana', panulondon: 'mana', panulundon: 'mana',
  napalit: 'nabili', gipalit: 'binili', nakapalit: 'nabili', gibaligya: 'ibinenta', nabaligya: 'nabenta', tabang: 'tulong', patabang: 'patulong', balay: 'bahay', bayranan: 'babayaran', bayronon: 'bayarin',
  walay: 'walang', naay: 'may', aduna: 'may', namatyan: 'namatay', nahanaw: 'nawala', nasunog: 'nasunog', gikuha: 'kinuha', giilog: 'inagaw', nailog: 'inagaw', kiha: 'kaso sa korte',
  // Text-saving shorthand: single letters and squeezed everyday words.
  p: 'po', b: 'ba', n: 'na', s: 'sa', d: 'di', nd: 'hindi', my: 'may', un: 'yun', ung: 'yung', km: 'kami', kmi: 'kami', cla: 'sila', xa: 'siya', cya: 'siya', nmin: 'namin', nmen: 'namin', ntin: 'natin', nten: 'natin',
  kng: 'kung', pra: 'para', bka: 'baka', sna: 'sana', cge: 'sige', tlga: 'talaga', dhil: 'dahil', dw: 'daw', dn: 'din', rn: 'rin', pb: 'po ba', poba: 'po ba', nlng: 'na lang', nlang: 'na lang', mron: 'meron', myron: 'meron',
  gsto: 'gusto', ilng: 'ilang', bwan: 'buwan', bwn: 'buwan', taon: 'taon', tn: 'taon', gano: 'gaano', gno: 'gaano', tgal: 'tagal', ktgal: 'katagal', ktagal: 'katagal',
  byad: 'bayad', byd: 'bayad', bayd: 'bayad', byran: 'bayarin', byaran: 'bayarin', byarin: 'bayarin', bnta: 'benta', bnili: 'binili', bnli: 'binili', nbli: 'nabili', bnenta: 'binenta', bnnta: 'binenta', ngbenta: 'nagbenta', ngbnta: 'nagbenta',
  ptay: 'patay', pty: 'patay', nmtay: 'namatay', nmty: 'namatay', pmnaw: 'pumanaw', ppeles: 'papeles', pples: 'papeles', papels: 'papeles', ppls: 'papeles', tnong: 'tanong', tnung: 'tanong', lote: 'lote', lte: 'lote',
  opsna: 'opisina', opcna: 'opisina', adrs: 'address', addrs: 'address', mgpa: 'magpa', mgpapa: 'magpapa', mna: 'mana', mnana: 'minana', lolo: 'lolo', lla: 'lola', llo: 'lolo', nnay: 'nanay', ttay: 'tatay',
  ejs: 'ejs', xtrajudicial: 'extrajudicial', xtra: 'extra', dos: 'dos', spa: 'spa' };
// The words the rules listen for (single words; phrases are built from them).
const VOCAB = ('magkano gastos magagastos gagastusin bayad babayaran bayarin presyo singil budget compute kwenta estimate assess assessment libre ' +
  'location address office opisina branch contact numero tawagan landline cellphone viber ' +
  'paano proseso process details interested inquire inquiry patulong magpatulong tulong konsulta consult abogado tanong question tumatanggap ' +
  'requirements kailangan papeles dokumento dadalhin ihahanda gaano katagal matagal buwan linggo ' +
  'abroad overseas hulugan installment pambayad ' +
  'mana minana pamana namatay pumanaw yumao tagapagmana estate extrajudicial judicial settlement deceased magkakapatid kapatid ninuno heirs ' +
  'deklarasyon declaration titulo title untitled unregistered rehistro patent cadastral ' +
  'nabili nakabili binili bumili bentahan ibinenta binenta nabenta seller buyer nagbenta binilhan ' +
  'nawala nawawala nasunog reconstitution nasira ' +
  'inagaw inaagaw umaagaw kinamkam pineke overlap squatter umalis pumirma pirmahan korte kinasuhan demanda umangkin inaangkin pinaalis pinapaalis pinalayas eviction demolition nilamangan niloko ' +
  'hatian paghahati hahatiin subdivide subdivision partition portion donation donasyon ' +
  'magulang nanay tatay parents mother father lolo lola grandparents grandfather grandmother pangalan nakapangalan sarili ' +
  'lupa lote bahay property transfer salamat reply sumasagot sumagot').split(' ');
// Normal words that sit one letter away from a word above. Never changed.
const SAFE = new Set(('bayan bayaw bahay bakit banda bayag balak balik bata bago baka basa ' +
  'mama nana mana maya mura muna mula meron mali mahal malaki maliit matanda marami ' +
  'lote lola lolo loob lang lupa luma ' +
  'tita tito tatay tanay taon tama tapos talaga tayo tulad tulog titser ' +
  'kaso kasi kami kayo kahit kaya kanya kanila kanino kapag kasama kuya kapatid kailan ' +
  'pano paano para pati pala papa pera pero pwede pirma piso patay pasok ' +
  'saan sana sabi sila siya sino sige sagot salamat sarili ' +
  'nasa naman nang nila niya ninyo namin natin nanay ' +
  'gusto gaano ganun ganyan ganito gamit galing ' +
  'hindi hanggang halos hati hatid ' +
  'dito doon dati dating dahil dapat dalawa ' +
  'ako akin amin atin anak asawa araw ayaw alam alin aming ating ayos ' +
  'isang ilan ilang ito iyon iyan ibang iba ' +
  'wala walang may meron mga yung yong ung ' +
  'office officer process processing title titled estate state contact contract transfer transfers question questions portion position property proper location ' +
  'father farther mother another brother other parents patent patient seller teller buyer bayer details detail budget address assess access consult result ' +
  'about above after again also been before being could does each from have here into just like made make many more most much need only over same some such than that them then there these they this very want well were what when where which while will with would your year years month months week weeks days today sorry please thank thanks hello mister madam maam ' +
  'natira really assist kwento buhay payment payments talagang bigyan bigay makikita barangay interest petition assessor registry plus long part katunayan tunay nagpunta napatayo pangulong sumilang malabo ' +
  'kapit ganon ganoon nanag pinag pinasa tugas mario consuelo angelica nakita makita kinita binata dalaga pamilya kamag kamaganak pinsan tiyuhin tiyahin bayaw hipag biyenan manugang ' +
  'solo real tall lipat lipas imos naik ' +
  'legal local total small house lands lease loan loans bank banks court count county case cases file filed files paid paper papers price prices sale sales sell sold tax taxes land lot lots deed deeds heir heirs').split(' '));
// How a word sounds: e/i and o/u are one letter, c is s before e or i and k
// otherwise, q is k, z is s, v is b, f and ph are p, doubled letters are one.
const sound = w => w.replace(/ph/g, 'p').replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/v/g, 'b').replace(/f/g, 'p').replace(/e/g, 'i').replace(/u/g, 'o').replace(/(.)\1+/g, '$1');
const bones = w => sound(w).replace(/[aeiouy]/g, '');
const BY_SOUND = new Map(), BY_BONES = new Map(), KNOWN = new Set(VOCAB), PLACE_WORDS = new Set();
// Is `w` the word `v` with letters left out (in order)?
const within = (w, v) => { let i = 0; for (const c of v) if (c === w[i]) i++; return i === w.length; };
// Two words with one sound ("inagaw", "inaagaw") are the same word to the rules: the first is kept.
function index(map, key, w) { if (key && !map.has(key)) map.set(key, w); }
// Typos (no transpositions needed: they are caught as two edits on 8+ letters,
// and the common ones are in SHORT).
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    var prevPrev = prev; prev = cur;
  }
  return prev[b.length];
}
function buildSpelling(placeWords) {
  for (const w of placeWords) if (w.length >= 4 && !KNOWN.has(w) && !SAFE.has(w)) { PLACE_WORDS.add(w); KNOWN.add(w); index(BY_SOUND, sound(w), w); }
  for (const w of VOCAB) {
    index(BY_SOUND, sound(w), w);
    // A skeleton shared by two different words points to neither.
    if (w.length >= 5) { const b = bones(w); BY_BONES.set(b, BY_BONES.has(b) && sound(BY_BONES.get(b)) !== sound(w) ? '' : (BY_BONES.get(b) || w)); }
  }
}
function respellWord(w) {
  if (Object.prototype.hasOwnProperty.call(SHORT, w)) return SHORT[w];
  if (w.length < 4 || KNOWN.has(w) || SAFE.has(w) || !/^[a-z]+$/.test(w)) return w;
  const s = sound(w);
  if (BY_SOUND.get(s)) return BY_SOUND.get(s);
  // Letters left out to save typing: the same consonants in the same order,
  // and what was typed is the known word with vowels removed.
  const b = bones(w), hit = BY_BONES.get(b);
  if (hit && (b.length >= 4 || (b.length === 3 && !/[aeiou]/.test(w))) && s.length < sound(hit).length && within(s, sound(hit))) return hit;
  // A short word with one letter left out ("nbili", "nawla"): the only word it can be.
  if (w.length < 6) {
    const fits = VOCAB.filter(v => v.length === w.length + 1 && v.length >= 6 && v[0] === w[0] && [...v].some((_, i) => v.slice(0, i) + v.slice(i + 1) === w));
    return fits.length === 1 ? fits[0] : w;
  }
  // A typo: same first sound, one letter off (two on long words), one clear winner.
  const max = w.length >= 10 ? 2 : 1;
  let best = '', bestD = max + 1, tie = false;
  for (const v of VOCAB) {
    if (v.length < 5 || Math.abs(v.length - w.length) > max) continue;
    const vs = sound(v);
    if (vs[0] !== s[0]) continue;
    const dist = editDistance(s, vs, max);
    if (dist < bestD) { best = v; bestD = dist; tie = false; } else if (dist === bestD && vs !== sound(best)) tie = true;
  }
  return best && !tie ? best : w;
}
// The whole message, word by word. Returns the text the rules read.
function respell(t) {
  return String(t || '').replace(/\bta(?:x|ks)[ .-]*de(?:c|k|ck|cl)\b/g, 'tax dec')
    // Cebuano "pila" (how much) and "asa" (where) are also Tagalog words, so only in a question shape.
    .replace(/\bpila(?= (?:po|ang|ka|man|ba|bayad|bayran|ni|kaha|gasto|magasto|tanan)\b|[ ?]*$)/g, 'magkano')
    .replace(/\basa(?= (?:man|inyong|inyo|ang|dapit|mo|mi)\b)/g, 'saan')
    // "2" typed for "to": pa2long, 2long, gs2 (a year or a count stays a number).
    .replace(/([a-z])2(?![0-9])/g, '$1to').replace(/(^|[^a-z0-9])2(?=[a-z]{3,})/g, '$1to')
    // A word glued to a number ("2nd", "200k", "3rd") is left as typed.
    .replace(/(?<![0-9a-z])[a-z]+/g, respellWord);
}

const FB_AUTO = ['thanks for messaging us', 'we are located in', 'hi, thanks for contacting us', 'salamat sa pag-message'];
const FB_SYS = ['facebook created this chat', 'ginawa ng facebook ang chat'];
const RE = {
  start: /^(get started|magsimula|simulan)$/,
  greet: /^((hi+|hello+|helo|hey|good ?(day|morning|afternoon|evening|eve|pm|am|noon)|gud ?(day|am|pm|morning|eve|evening|afternoon)|magandang (araw|umaga|hapon|gabi|tanghali)|ma'?am|mam|sir|po|atty|attorney)[\s,.!?]*)+$/,
  thanks: /^((ok(ay)?|k|sige|cge|salamat|maraming salamat|thank you|thanks|thank u|ty|tnx|noted|copy|👍|🙏|❤️|yes|opo|oo|nice|wow|good info|galing|amen)( po| so much| ma'?am| sir)*[\s,.!]*)+$/,
  spam: /(crypto|bitcoin|forex|investment opportunity|click here|bit\.ly|t\.me\/|whatsapp\.com\/|earn \$|followers|loan offer|casino|sabong|gcash promo)/,
  complaint: /(^(sir|ser|mam|ma'?am|atty)?[ ,]*(pa ?)?reply( po| naman| nman| pls| please)*[\s.!?]*$|(di|hindi|wala(ng)?|d) (rin |din )?(nama[nm] |man |nman )?(ka?yo |sila |po )?(nag ?re?ply|reply|nagre?reply|sumasagot|sumagot|namamansin|pumapansin|nasagot|sagot|reply)|no reply|walang (sagot|reply|pumapansin)|seen ?(lang|zone)|di rin naman sila|ang tagal (n'?yo|ninyo|nila)? ?(po )?(sumagot|mag ?reply)|hanggang ngayon wala|scam)/,
  price: /\b(hm+|how much|ma?g ?ka?n[ou]|gastos|magagast[ou]s?|magagasto|magastos|gagastusin|bayad|babayaran|bayarin|presyo|cost|fees?|singil|rate|service fee|budget)\b/,
  compute: /(compute|kompyut|pa ?kwenta|pakwenta|estimate|extimate|assess|libre ba)/,
  office: /(\b(location|located|loc|where|exact add|ofc|ofice|cel+phone|viber|kontak|makontak|makontact|saan (po )?(kayo|ang office|ang opisina|banda|ito|makikita)|san (po )?(kayo|ito|banda|ang office|ang opisina)|taga saan|address|office|opisina|branch|contact|cp number|number n'?yo|numero|tawagan|landline)\b|^(saan|san)( po)?[\s?]*$)/,
  how: /(^(how|paano|pano|papaano|pm|pm sent|details?|interested|info|inquire|inquiry|pa ?help|patulong|tulong)\b|paano po|pano po|proseso|process|how to|naglalakad|nag ?aasikaso|konsulta|kumunsulta|consult|mag ?patulong|abogado n'?yo|\bcater\b|nationwide|about sa lupa|tungkol sa lupa|may (tanong|question)|mag ?ta?tanong|pw?e?de? pa (po )?ba|makipagkita|nag ?aayos|nag ?pro?process|tumatanggap (po )?(ba )?kayo|pa ?ayos|ipapaayos|pa ?asikaso|magpa ?(transfer|lipat|titulo)|pa ?(transfer|lipat) |ipalipat|ilipat|mag ?transfer)/,
  reqs: /(requirements?|rekisitos|ano (po )?(ang |mga )?(kailangan|dadalhin|ihahanda)|kailangan(g)? (papeles|dokumento|dalhin))/,
  tagal: /(gaano (po )?(ka ?)?tagal|ilang (buwan|araw|linggo|taon)|how long|matagal (po )?ba|kailan matatapos)/,
  abroad: /\b(abroad|ofw|ibang bansa|overseas|nasa (dubai|saudi|canada|usa|us|america|japan|korea|qatar|kuwait|uae|italy|hongkong|hong kong|singapore|taiwan|australia|uk|europe))\b/,
  hulugan: /(hulugan|installment|instalment|hulog|utay ?utay|paunti ?unti|wala (po )?(akong|kaming|pang) ?(pera|budget|pambayad)|walang (pera|budget|pambayad)|(di|hindi) (ko|namin) (po )?kaya(ng)? (bayaran|ang bayad))/,
  estate: /(\bmana\b|minana|pamana|namatay|patay na|pumanaw|yumao|sumakabilang|\blolo\b|\blola\b|heirs?\b|tagapagmana|\bestate\b|ext?r?a ?judicial|\bejs\b|deceased|magkakapatid|mga kapatid|ninuno)/,
  untitled: /(tax ?dec|tax declaration|deklarasyon|diklarasyon|walang tit[ou]lo|wala pa(ng)? tit[ou]lo|wala (pa )?po(ng)? tit[ou]lo|untitled|unregistered|di (pa )?(naka ?)?rehistr|not registered|free patent|\bpatent\b|cenro|penro|cadastral|pa ?titulo|patitolo|rights lang|\bcloa\b)/,
  sale: /(deed of sale|nabili|nakabili|binili|binenta|bumili|bomeli|bentahan|ibinenta|bininta|\bseller\b|\bbuyer\b|\bdos\b|absolute sale|nabenta)/,
  lost: /(nawala|nawawala|nasunog|lost title|owner'?s (duplicate )?copy|reconstitut|nasira ang titulo)/,
  dispute: /(inagaw|inaagaw|umaagaw|kinamkam|kinuha (ng|ang lupa)|pineke|\bpeke\b|\bfake\b|double titl|doble titulo|overlap|encroach|squat|ayaw (umalis|pumirma|mag ?pirma|pirmahan)|nasa korte|may kaso|kinasuhan|demanda|umangkin|inaangkin|pinaalis|pinapaalis|pinalayas|eviction|demolition|land ?grab|tumir[ie]k|sa kaso\b|\bkasu\b|nahahabol|hinahabol|may habol|nakikihati|ayaw (kami )?bigyan|nilamangan|niloko)/,
  partition: /(hatian|paghahati|hahatiin|subdivide|subdivision ng lupa|partition|portion)/,
  donation: /(donat|donasyon|ipamana habang buhay)/,
  title: /(\btit[ou]lo\b|\btitle\b|\btct\b|\boct\b|\bcct\b)/,
  noTitle: /(walang tit[ou]lo|wala pa(ng)? tit[ou]lo|wala (pa )?po(ng)? tit[ou]lo|no title|untitled|tax ?dec(laration)? lang)/,
  taxdec: /(tax ?dec|tax declaration|deklarasyon|diklarasyon)/,
  oParents: /(magulang|nanay|tatay|\bmama\b|\bpapa\b|\bama\b|\bina\b|parents|mother|father|\berpat\b|\bermat\b)/,
  oGrand: /(\blolo\b|\blola\b|grandparents?|grandfather|grandmother|ninuno|lelong|lelang)/,
  oSeller: /(nagbenta|\bseller\b|binilhan|dating may-?ari)/,
  oSelf: /(sa akin|pangalan ko|akin (po )?nakapangalan|\bako\b|sarili)/
};
// Places. Order matters: "quezon city" must be read before "quezon".
const PLACES = [
  ['ncr', 'in', /(quezon city|\bqc\b|metro manila|\bncr\b|\bmanila\b|makati|pasig|taguig|caloocan|paranaque|las pinas|muntinlupa|marikina|mandaluyong|valenzuela|pasay|malabon|navotas|pateros|\bbgc\b)/],
  ['quezon', 'in', /(\bquezon\b|lucena|tayabas|sariaya|candelaria|tiaong|pagbilao|lucban|infanta|gumaca|atimonan|mauban|lopez|calauag|catanauan|mulanay|real quezon|dolores quezon|san antonio quezon|unisan|padre burgos|agdangan|polillo)/],
  ['laguna', 'in', /(laguna|calamba|san pablo|sta\.? rosa|santa rosa|binan|los banos|san pedro|cabuyao|pagsanjan|sta\.? cruz laguna|nagcarlan|liliw|siniloan|calauan|\bbay\b laguna)/],
  ['batangas', 'in', /(batangas|\blipa\b|tanauan|nasugbu|sto\.? tomas|bauan|lemery|rosario batangas|san juan batangas|calatagan|taal|balayan)/],
  ['cavite', 'in', /(cavite|dasma|imus|bacoor|tagaytay|gen\.? trias|general trias|silang|trece|naic|tanza|carmona|indang|alfonso)/],
  ['rizal', 'in', /(\brizal\b|antipolo|cainta|taytay|san mateo|rodriguez|montalban|binangonan|tanay|angono|teresa|morong|baras|pililla)/],
  ['other', 'out', /(bulacan|pampanga|pangasinan|\bcebu\b|leyte|samar|davao|iloilo|bicol|camarines|albay|sorsogon|masbate|catanduanes|mindoro|palawan|marinduque|romblon|nueva ecija|nueva vizcaya|tarlac|zambales|bataan|aurora|ilocos|la union|isabela|cagayan|quirino|benguet|baguio|abra|kalinga|ifugao|apayao|mountain province|negros|bacolod|bohol|siquijor|biliran|aklan|capiz|antique|guimaras|visayas|mindanao|cotabato|zamboanga|bukidnon|misamis|surigao|agusan|lanao|maguindanao|sultan kudarat|sarangani|gensan|general santos|basilan|sulu|tawi|dinagat|camiguin|compostela|butuan|tacloban|ormoc|dumaguete|naga city|legazpi|puerto princesa|cabanatuan|olongapo|angeles|dagupan|tuguegarao|vigan|laoag|koronadal|kidapawan|iligan|ozamiz|pagadian|dipolog|tagum|digos|mati)/]
];
buildSpelling(PLACES.flatMap(([, , re]) => re.source.replace(/\\[a-z.?]/g, ' ').split(/[^a-z]+/)));
const BY_PAYLOAD = {
  LT_CASE_ESTATE: { case: 'estate' }, LT_CASE_SALE: { case: 'sale' }, LT_CASE_UNTITLED: { case: 'untitled' }, LT_CASE_LOST: { case: 'lost' }, LT_CASE_DISPUTE: { case: 'dispute' },
  LT_PRICE: { topic: 'price' }, LT_OFFICE: { topic: 'office' },
  LT_LOC_QUEZON: { loc: 'quezon' }, LT_LOC_LAGUNA: { loc: 'laguna' }, LT_LOC_BATANGAS: { loc: 'batangas' }, LT_LOC_CAVITE: { loc: 'cavite' }, LT_LOC_RIZAL: { loc: 'rizal' }, LT_LOC_NCR: { loc: 'ncr' }, LT_LOC_OTHER: { locOther: true },
  LT_PAP_TITLE: { papers: 'title' }, LT_PAP_TAXDEC: { papers: 'taxdec' }, LT_PAP_UNKNOWN: { papers: 'unknown' },
  LT_OWN_PARENTS: { owner: 'parents' }, LT_OWN_GRAND: { owner: 'grand' }, LT_OWN_SELLER: { owner: 'seller' }, LT_OWN_SELF: { owner: 'self' }, LT_OWN_OTHER: { owner: 'other' },
  GET_STARTED: { start: true }
};
// A tapped button arrives through the 10-minute check as its title only.
const BY_TITLE = {};
for (const id of Object.keys(SCRIPTS)) for (const q of (SCRIPTS[id].quick || [])) BY_TITLE[norm(q.title)] = q.payload;
const WORDS = { case: { estate: 'mana', sale: 'nabili, hindi pa nalilipat', untitled: 'walang titulo', lost: 'nawalang titulo', dispute: 'may problema o agawan', partition: 'hatian ng lote', donation: 'donasyon' },
  loc: { quezon: 'Quezon', laguna: 'Laguna', batangas: 'Batangas', cavite: 'Cavite', rizal: 'Rizal', ncr: 'Metro Manila' },
  papers: { title: 'may titulo', taxdec: 'tax declaration lang', unknown: 'hindi pa tiyak ang papeles' },
  owner: { parents: 'nakapangalan sa magulang', grand: 'nakapangalan sa lolo o lola', seller: 'nakapangalan sa nagbenta', self: 'nakapangalan sa inyo', other: 'nakapangalan sa iba' } };

function placeOf(t) { for (const [code, area, re] of PLACES) if (re.test(t)) return { loc: code, area }; return null; }
function diedBand(t) {
  const m = t.match(/\b(19[0-9]{2}|20[0-2][0-9])\b/);
  if (!m) return '';
  const y = Number(m[1]);
  return y >= 2018 ? '2018+' : y >= 1998 ? '1998-2017' : 'before1998';
}

// What one message says. `step` lets a bare answer ("2", "Lucena") be read as
// the answer to the question that was just asked.
function detect(text, payload, step) {
  const raw = String(text || '');
  const typed = norm(raw);
  const t = respell(typed);
  const d = { t, empty: !t, topics: [], facts: {}, understood: false };
  if (t !== typed) d.readAs = t;
  if (FB_SYS.some(s => t.startsWith(s))) { d.system = true; return d; }
  let p = BY_PAYLOAD[String(payload || '')] ? String(payload) : BY_TITLE[t] || '';
  if (!p && /^[1-7][.)]?$/.test(t) && (!step || step === 'new' || step === 'menu')) p = MENU[Number(t[0]) - 1][1];
  if (RE.start.test(t)) p = 'GET_STARTED';
  if (p) {
    const b = BY_PAYLOAD[p];
    d.button = p; d.understood = !b.start;
    if (b.start) d.start = true;
    if (b.topic) d.topics.push(b.topic);
    for (const k of ['case', 'loc', 'papers', 'owner', 'died']) if (b[k]) d.facts[k] = b[k];
    if (b.loc) d.facts.area = 'in';
    if (b.locOther) d.locOther = true;
    return d;
  }
  if (d.empty) return d;
  if (RE.spam.test(t)) { d.spam = true; return d; }
  d.complaint = RE.complaint.test(t);
  d.greet = RE.greet.test(t);
  d.thanks = RE.thanks.test(t);
  if (d.greet || d.thanks) return d;
  for (const k of ['price', 'compute', 'office', 'how', 'reqs', 'tagal', 'abroad', 'hulugan']) if (RE[k].test(t)) d.topics.push(k);
  // "saan magpa-compute" is about computing, not the office.
  if (d.topics.includes('office') && (d.topics.includes('compute') || /saan (po )?(ang |yung )?(lupa|lote|property)/.test(t)) && !/(office|opisina|address|location|branch|contact|numero|number)/.test(t)) d.topics = d.topics.filter(x => x !== 'office');
  const dispute = RE.dispute.test(t);
  d.facts.case = dispute ? 'dispute' : RE.estate.test(t) ? 'estate' : RE.lost.test(t) ? 'lost' : RE.untitled.test(t) ? 'untitled' : RE.sale.test(t) ? 'sale' : RE.partition.test(t) ? 'partition' : RE.donation.test(t) ? 'donation' : '';
  if (!d.facts.case) delete d.facts.case;
  const pl = placeOf(t);
  if (pl) { d.facts.loc = pl.loc; d.facts.area = pl.area; if (pl.area === 'out') d.facts.locText = raw.trim().slice(0, 120); }
  if (RE.noTitle.test(t)) d.facts.papers = 'taxdec';
  else if (RE.taxdec.test(t) && !RE.title.test(t)) d.facts.papers = 'taxdec';
  else if (RE.title.test(t) && !RE.lost.test(t)) d.facts.papers = 'title';
  if (RE.oGrand.test(t)) d.facts.owner = 'grand'; else if (RE.oParents.test(t)) d.facts.owner = 'parents'; else if (RE.oSeller.test(t)) d.facts.owner = 'seller';
  if (d.facts.case === 'estate') { const b = diedBand(t); if (b) d.facts.died = b; }
  // A bare answer to the question that was just asked.
  if (step === 'loc' || step === 'loc_other') {
    if (!d.facts.loc && !d.topics.length && !d.facts.case && raw.trim().length <= 60) { d.facts.loc = 'unknown'; d.facts.area = 'unknown'; d.facts.locText = raw.trim().slice(0, 120); }
  } else if (step === 'papers') {
    if (!d.facts.papers && !d.topics.length && raw.trim().length <= 60) d.facts.papers = 'unknown';
  } else if (step === 'owner') {
    if (!d.facts.owner && !d.topics.length) d.facts.owner = RE.oSelf.test(t) ? 'self' : 'other';
  } else if (step === 'died') {
    if (!d.facts.died && !d.topics.length) d.facts.died = diedBand(t) || 'unknown';
    const yr = t.match(/\b(19[0-9]{2}|20[0-2][0-9])\b/);
    if (yr && !d.topics.length) d.facts.diedYear = yr[1];
  }
  d.understood = !!(d.topics.length || Object.keys(d.facts).length);
  return d;
}

function summaryOf(a) {
  const parts = [];
  if (a.case) parts.push(WORDS.case[a.case] || a.case);
  if (a.loc) parts.push(WORDS.loc[a.loc] || a.locText || 'lugar: titingnan ng staff');
  if (a.papers) parts.push(WORDS.papers[a.papers]);
  if (a.owner) parts.push(WORDS.owner[a.owner]);
  return parts.join(', ') || 'ang inyong tanong';
}
function groupOf(st) {
  const a = st.a || {}, it = st.intents || [];
  if (st.flag === 'spam') return 'F';
  if (a.case === 'dispute') return 'C';
  if (a.area === 'out') return 'D';
  const wants = !!a.case || it.some(x => ['price', 'compute', 'how', 'reqs', 'tagal', 'abroad', 'hulugan'].includes(x));
  if (a.loc && a.papers && a.owner) return 'A';
  if (wants || a.loc || a.papers || a.owner) return 'B';
  if (it.includes('office')) return 'E';
  return 'F';
}
const fresh = () => ({ step: 'new', a: {}, sent: {}, intents: [], flag: '', group: 'F', misses: 0 });

// One inbound Messenger message. Returns the new state and what to send.
function decide(prev, ev, now) {
  now = now || Date.now();
  const st = JSON.parse(JSON.stringify({ ...fresh(), ...(prev || {}) }));
  st.a = st.a || {}; st.sent = st.sent || {}; st.intents = st.intents || [];
  const d = detect(ev.text, ev.payload, st.step);
  const out = { state: st, sends: [], rule: '', detect: d };
  const done = r => { st.group = groupOf(st); out.rule = out.rule || r; return out; };
  const send = id => { if (st.sent[id] || out.sends.includes(id)) return false; out.sends.push(id); return true; };
  if (d.system) return done('system line: ignored');
  if (d.spam) { st.flag = 'spam'; return done('spam: nothing sent'); }
  if (d.complaint) st.flag = 'complaint';
  // Facts: the first answer stays, except a tapped button, which is deliberate.
  for (const k of Object.keys(d.facts)) if (!st.a[k] || d.button) st.a[k] = d.facts[k];
  if (d.facts.loc && d.facts.area) st.a.area = d.facts.area;
  for (const tp of d.topics) if (!st.intents.includes(tp)) st.intents.push(tp);
  const quiet = st.humanAt && now - new Date(st.humanAt).getTime() < QUIET_MS;
  if (quiet) return done('quiet: staff answered this person in the last 12 hours');
  if (st.step === 'handoff') return done('already handed to staff');
  // A dispute is never walked through the process.
  if (st.a.case === 'dispute') { send('lawyer'); st.step = 'handoff'; return done('dispute: to the lawyer'); }
  // Fixed answers, at most two per message. Office at most once a day.
  const fixed = [];
  if (d.topics.includes('office') && !(st.sent.office && now - new Date(st.sent.office).getTime() < 864e5)) { delete st.sent.office; fixed.push('office'); }
  if (d.topics.includes('price') || d.topics.includes('compute')) fixed.push('price');
  if (d.topics.includes('reqs') || d.topics.includes('compute')) fixed.push('reqs');
  for (const k of ['tagal', 'abroad', 'hulugan']) if (d.topics.includes(k)) fixed.push(k);
  let nFixed = 0;
  for (const id of fixed) if (nFixed < 2 && send(id)) nFixed++;
  const onlyOffice = st.intents.length === 1 && st.intents[0] === 'office' && !st.a.case && !st.a.loc;
  if (st.step === 'done') return done(nFixed ? 'after close: fixed answer' : 'after close: staff will answer');
  if (d.locOther && !st.a.loc) { send('ask_loc_other'); st.step = 'loc_other'; return done('other province: asked which'); }
  if (st.a.area === 'out') { send('outside'); st.step = 'handoff'; return done('outside the area'); }
  const wants = !!st.a.case || !!st.a.papers || !!st.a.owner || st.intents.some(x => x !== 'office');
  if (!wants) {
    if (onlyOffice) { if (st.step === 'new') st.step = 'menu'; return done('office only'); }
    if (!st.sent.welcome) { send('welcome'); st.step = 'menu'; return done(d.start ? 'Get started: welcome' : d.greet ? 'greeting: welcome' : 'unclear first message: welcome'); }
    if (d.start || d.thanks || d.greet) return done('nothing to answer');
    if (d.understood) return done('answered');
    st.misses = (st.misses || 0) + 1;
    if (st.misses === 1 && send('unclear')) return done('not understood: menu once more');
    send('handoff'); st.step = 'handoff';
    return done('not understood twice: handed to staff');
  }
  // The intake questions, each asked once.
  if (!st.a.loc) { if (send('ask_loc')) { st.step = 'loc'; return done('asked where the land is'); } }
  else if (!st.a.papers) { if (send('ask_papers')) { st.step = 'papers'; return done('asked which papers'); } }
  else if (!st.a.owner) { if (send('ask_owner')) { st.step = 'owner'; return done('asked whose name'); } }
  else if (st.a.case === 'estate' && !st.a.died) { if (send('ask_died')) { st.step = 'died'; return done('asked when the owner died'); } }
  else { send('close'); st.step = 'done'; return done('intake complete: closed'); }
  if (nFixed) return done('fixed answer');
  if (d.thanks || d.start || d.greet) return done('nothing to answer');
  // The question was already asked and this did not answer it. One pass
  // (people often tell their story first), then staff.
  st.misses = (st.misses || 0) + 1;
  if (st.misses < 2) return done('question still open: waiting for the answer');
  send('handoff'); st.step = 'handoff';
  return done('question unanswered twice: handed to staff');
}

// One comment under a post. At most one private message per comment thread.
function decideComment(prev, ev) {
  const st = JSON.parse(JSON.stringify({ ...fresh(), ...(prev || {}) }));
  st.a = st.a || {}; st.sent = st.sent || {}; st.intents = st.intents || [];
  const d = detect(ev.text, '', '');
  const out = { state: st, sends: [], hide: false, rule: '', detect: d };
  const done = (r, g) => { st.group = g || groupOf(st); out.rule = r; return out; };
  if (d.spam) { st.flag = 'spam'; out.hide = true; return done('spam comment: hide'); }
  if (d.complaint) st.flag = 'complaint';
  for (const k of Object.keys(d.facts)) if (!st.a[k]) st.a[k] = d.facts[k];
  for (const tp of d.topics) if (!st.intents.includes(tp)) st.intents.push(tp);
  const pmSent = Object.keys(st.sent).some(k => k.startsWith('comment_pm'));
  if (st.humanAt) return done('the Page already replied under this comment');
  if (pmSent) return done('private message already sent for this comment');
  if (ev.isReply && !d.complaint && !d.understood) return done('reply between commenters: nothing');
  if (d.complaint) { out.sends.push('comment_pm_sorry', 'comment_public'); return done('complaint about no reply: private message + red flag'); }
  if (st.a.case === 'dispute') { out.sends.push('comment_pm_lawyer', 'comment_public'); return done('dispute comment: private message, lawyer'); }
  const onlyOffice = st.intents.length === 1 && st.intents[0] === 'office' && !st.a.case;
  if (onlyOffice) { out.sends.push('comment_pm_office', 'comment_public'); return done('office question: private message'); }
  if (st.intents.length || st.a.case || st.a.papers) { out.sends.push('comment_pm', 'comment_public'); return done('question comment: private message'); }
  return done('chatter: nothing', 'F');
}

function render(id, st) {
  const s = SCRIPTS[id];
  return { id, text: s.text.replace('{summary}', summaryOf((st && st.a) || {})), quick: s.quick || [] };
}
const SCRIPT_STARTS = Object.values(SCRIPTS).map(s => norm(s.text.split('{summary}')[0]).slice(0, 40));
// Is this Page message one of ours (or one of Facebook's own auto-replies)?
// Those must not count as "a staff member answered".
function notHuman(text) {
  const t = norm(text);
  return !t || FB_AUTO.some(s => t.startsWith(s)) || SCRIPT_STARTS.some(s => t.startsWith(s));
}

const isCommentPm = text => /nakita po namin ang comment ninyo/.test(norm(text)) || norm(text).startsWith('magandang araw po, at pasensya na po kung natagalan');

module.exports = { isCommentPm, SCRIPTS, GROUPS, ASKING, MENU, LT_PAGE_DEFAULT, QUIET_MS, detect, decide, decideComment, groupOf, render, notHuman, scriptHash, norm, fresh, summaryOf, respell, _respellWord: respellWord };
