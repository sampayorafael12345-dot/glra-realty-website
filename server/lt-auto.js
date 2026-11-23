// =============================================================================
// GLRA LAND TITLE: INBOX AUTOMATION (plain rules, no AI)
// =============================================================================
// Sorts everyone who messages or comments on the GLRA Land Title Page into six
// groups and walks them through the intake questions the staff always ask.
//
//   A ready    case + where the land is + whose name is on the papers
//   B started  asked price / computation / how, has not finished the questions
//   C lawyer   a dispute: goes to Atty. Mel, no process script
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
const OFFICE = '📍 2nd Floor, R Bldg., Gomez cor. Enriquez St., Lucena City, Quezon\n🕘 Lunes hanggang Biyernes, 8:00 AM hanggang 5:00 PM (lunch 12 hanggang 1, sarado tuwing holiday). Mag-message po muna para ma-schedule ang pagbisita.\n📞 042 373 7583 · 0967 340 0165\n📧 glralandtransfer@gmail.com';

// Every word the automation can say. Facts are the ones the staff confirmed on
// 17 and 19 Nov 2026 (the same lines as the FAQ under every Land Title post).
// "owners: true" marks wording that waits for the owners' answer sheet.
const SCRIPTS = {
  welcome: { text: 'Magandang araw po! Salamat sa pag-message sa GLRA Land Title. Ito po ay automated na sagot para mabilis kayong matulungan.\n\nAno po ang kailangan ninyo? Pumili po sa ibaba, o i-type ang numero:\n' + MENU_LINES, quick: MENU_QR },
  unclear: { text: 'Pasensya na po, hindi ko po nakuha. Pumili po sa ibaba, o i-type ang numero (1 hanggang 7):\n' + MENU_LINES, quick: MENU_QR },
  ask_loc: { text: 'Saan po matatagpuan ang lupa?', quick: qr([['LT_LOC_QUEZON', 'Quezon'], ['LT_LOC_LAGUNA', 'Laguna'], ['LT_LOC_BATANGAS', 'Batangas'], ['LT_LOC_CAVITE', 'Cavite'], ['LT_LOC_RIZAL', 'Rizal'], ['LT_LOC_NCR', 'Metro Manila'], ['LT_LOC_OTHER', 'Ibang probinsya']]) },
  ask_loc_other: { text: 'Saang probinsya at bayan po ang lupa? Paki-type po.' },
  ask_papers: { text: 'Ano pong papeles ang hawak ninyo para sa lupa?', quick: qr([['LT_PAP_TITLE', 'May titulo'], ['LT_PAP_TAXDEC', 'Tax declaration lang'], ['LT_PAP_UNKNOWN', 'Hindi ko alam']]) },
  ask_owner: { text: 'Kanino po nakapangalan ang titulo o tax declaration?', quick: qr([['LT_OWN_PARENTS', 'Sa magulang'], ['LT_OWN_GRAND', 'Sa lolo o lola'], ['LT_OWN_SELLER', 'Sa nagbenta'], ['LT_OWN_SELF', 'Sa akin'], ['LT_OWN_OTHER', 'Iba']]) },
  ask_died: { text: 'Kailan po pumanaw ang may-ari?', quick: qr([['LT_DIED_2018', '2018 o pagkatapos'], ['LT_DIED_1998', '1998 hanggang 2017'], ['LT_DIED_OLD', 'Bago 1998'], ['LT_DIED_UNKNOWN', 'Hindi ko alam']]) },
  close: { text: 'Salamat po! Naitala na namin: {summary}.\n\nLibre po ang unang assessment. Para ma-assess, paki-email po ang kopya ng titulo o tax declaration sa glralandtransfer@gmail.com (sa email lang po ang mga dokumento at ID, hindi sa Messenger).\n\nSasagutin po kayo ng aming staff sa susunod na araw ng opisina (Lunes hanggang Biyernes, 8 AM hanggang 5 PM).\n📞 042 373 7583 · 0967 340 0165' },
  office: { text: 'Narito po ang aming opisina at contact:\n' + OFFICE },
  price: { text: 'Libre po ang unang assessment. May ₱1,000 po ang nakasulat na computation, at ibabawas ito sa service fee kapag kami ang kinuha ninyo. Nakadepende po ang kabuuang gastos sa lupa at sa kaso, kaya kailangan muna naming makita ang papeles.' },
  reqs: { text: 'Para ma-assess po, ihanda ang kopya ng titulo at tax declaration. Kung mana: death certificate at family tree. Ipadala po sa glralandtransfer@gmail.com.' },
  tagal: { text: 'Karaniwang 3 hanggang 5 buwan po kapag kumpleto ang papeles. Mas matagal kung may hatian ng lote o kaso sa korte.' },
  abroad: { text: 'Pwede po kahit nasa abroad kayo, sa pamamagitan ng Special Power of Attorney. Hindi na po kailangang umuwi.' },
  hulugan: { text: 'Pwede pong hulugan ang service fee.' },
  lawyer: { owners: true, text: 'Salamat po sa detalye. Ang ganitong sitwasyon ay kailangan pong tingnan ng aming abogado, si Atty. Mel. Ipapasa po namin ito sa kanya at kokontakin kayo ng aming staff sa susunod na araw ng opisina (Lunes hanggang Biyernes, 8 AM hanggang 5 PM).\n📞 042 373 7583 · 0967 340 0165' },
  outside: { owners: true, text: 'Salamat po. Metro Manila at CALABARZON po ang pangunahing sakop namin. Ipapasa ko po ang detalye ninyo sa aming staff para makumpirma kung matutulungan namin kayo sa inyong lugar.' },
  handoff: { text: 'Salamat po. Ipapasa ko po kayo sa aming staff. Sasagutin po kayo sa susunod na araw ng opisina (Lunes hanggang Biyernes, 8 AM hanggang 5 PM).\n📞 042 373 7583 · 0967 340 0165' },
  remind: { text: 'Kumusta po! Kung gusto pa po ninyong ituloy, sagutin lang po ang huling tanong sa itaas at tutulungan namin kayo.' },
  comment_pm: { text: 'Magandang araw po! Nakita po namin ang comment ninyo sa GLRA Land Title page. Ito po ay automated na mensahe para mabilis kayong matulungan.\n\nAno po ang kailangan ninyo? I-type lang po ang numero:\n' + MENU_LINES },
  comment_pm_office: { text: 'Magandang araw po! Nakita po namin ang comment ninyo sa GLRA Land Title page (automated na mensahe po ito). Narito po ang aming opisina at contact:\n' + OFFICE + '\n\nMay iba pa po ba kayong kailangan? I-type lang po ang numero:\n' + MENU_LINES },
  comment_pm_lawyer: { owners: true, text: 'Magandang araw po! Nakita po namin ang comment ninyo sa GLRA Land Title page (automated na mensahe po ito). Ang ganitong sitwasyon ay kailangan pong tingnan ng aming abogado, si Atty. Mel. Paki-reply po dito ng maikling detalye at kung saan ang lupa, at kokontakin kayo ng aming staff sa susunod na araw ng opisina.' },
  comment_pm_sorry: { owners: true, text: 'Magandang araw po, at pasensya na po kung natagalan ang sagot namin. Automated na mensahe po ito para hindi na kayo maghintay.\n\nAno po ang kailangan ninyo? I-type lang po ang numero:\n' + MENU_LINES }
};
const scriptHash = id => crypto.createHash('sha256').update(JSON.stringify([SCRIPTS[id].text, (SCRIPTS[id].quick || []).map(q => q.title)])).digest('hex').slice(0, 16);

// ── READING A MESSAGE ─────────────────────────────────────────
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
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
  tagal: /(gaano (po )?(ka ?tagal|katagal)|ilang (buwan|araw|linggo|taon)|how long|matagal (po )?ba|kailan matatapos)/,
  abroad: /\b(abroad|ofw|ibang bansa|overseas|nasa (dubai|saudi|canada|usa|us|america|japan|korea|qatar|kuwait|uae|italy|hongkong|hong kong|singapore|taiwan|australia|uk|europe))\b/,
  hulugan: /(hulugan|installment|instalment|hulog|utay ?utay|paunti ?unti)/,
  estate: /(\bmana\b|minana|pamana|namatay|patay na|pumanaw|yumao|sumakabilang|\blolo\b|\blola\b|heirs?\b|tagapagmana|\bestate\b|ext?r?a ?judicial|\bejs\b|deceased|magkakapatid|mga kapatid|ninuno)/,
  untitled: /(tax ?dec|tax declaration|deklarasyon|diklarasyon|walang tit[ou]lo|wala pa(ng)? tit[ou]lo|wala (pa )?po(ng)? tit[ou]lo|untitled|unregistered|di (pa )?(naka ?)?rehistr|not registered|free patent|\bpatent\b|cenro|penro|cadastral|pa ?titulo|patitolo|rights lang|\bcloa\b)/,
  sale: /(deed of sale|nabili|binili|bumili|bomeli|bentahan|ibinenta|bininta|\bseller\b|\bbuyer\b|\bdos\b|absolute sale|nabenta)/,
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
const BY_PAYLOAD = {
  LT_CASE_ESTATE: { case: 'estate' }, LT_CASE_SALE: { case: 'sale' }, LT_CASE_UNTITLED: { case: 'untitled' }, LT_CASE_LOST: { case: 'lost' }, LT_CASE_DISPUTE: { case: 'dispute' },
  LT_PRICE: { topic: 'price' }, LT_OFFICE: { topic: 'office' },
  LT_LOC_QUEZON: { loc: 'quezon' }, LT_LOC_LAGUNA: { loc: 'laguna' }, LT_LOC_BATANGAS: { loc: 'batangas' }, LT_LOC_CAVITE: { loc: 'cavite' }, LT_LOC_RIZAL: { loc: 'rizal' }, LT_LOC_NCR: { loc: 'ncr' }, LT_LOC_OTHER: { locOther: true },
  LT_PAP_TITLE: { papers: 'title' }, LT_PAP_TAXDEC: { papers: 'taxdec' }, LT_PAP_UNKNOWN: { papers: 'unknown' },
  LT_OWN_PARENTS: { owner: 'parents' }, LT_OWN_GRAND: { owner: 'grand' }, LT_OWN_SELLER: { owner: 'seller' }, LT_OWN_SELF: { owner: 'self' }, LT_OWN_OTHER: { owner: 'other' },
  LT_DIED_2018: { died: '2018+' }, LT_DIED_1998: { died: '1998-2017' }, LT_DIED_OLD: { died: 'before1998' }, LT_DIED_UNKNOWN: { died: 'unknown' },
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
  const t = norm(raw);
  const d = { t, empty: !t, topics: [], facts: {}, understood: false };
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
  if (d.complaint) { out.sends.push('comment_pm_sorry'); return done('complaint about no reply: private message + red flag'); }
  if (st.a.case === 'dispute') { out.sends.push('comment_pm_lawyer'); return done('dispute comment: private message, lawyer'); }
  const onlyOffice = st.intents.length === 1 && st.intents[0] === 'office' && !st.a.case;
  if (onlyOffice) { out.sends.push('comment_pm_office'); return done('office question: private message'); }
  if (st.intents.length || st.a.case || st.a.papers) { out.sends.push('comment_pm'); return done('question comment: private message'); }
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

module.exports = { isCommentPm, SCRIPTS, GROUPS, ASKING, MENU, LT_PAGE_DEFAULT, QUIET_MS, detect, decide, decideComment, groupOf, render, notHuman, scriptHash, norm, fresh, summaryOf };
