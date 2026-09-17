// =============================================================================
// CASE PDFs — case summary, statement of account, full case profile,
// acknowledgement receipt, and the court diary
// =============================================================================
// Same visual language as the lease documents (black letterhead band, hot rule,
// mono uppercase labels, hairline tables) but the firm's own name comes from
// the Cases settings, because the law practice is a separate business that
// happens to share this dashboard. With nothing set it falls back to a neutral
// heading rather than printing "GLRA Realty" on a pleading-adjacent document.
//
// Every function returns a Promise<Buffer>. Nothing here touches the database.
// =============================================================================
const PDFDocument = require('pdfkit');
const path = require('path');

const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = {
  sans: path.join(FONT_DIR, 'Inter-Regular.ttf'),
  semi: path.join(FONT_DIR, 'Inter-SemiBold.ttf'),
  bold: path.join(FONT_DIR, 'Inter-Bold.ttf'),
  mono: path.join(FONT_DIR, 'JetBrainsMono-Regular.ttf'),
  monoBold: path.join(FONT_DIR, 'JetBrainsMono-Bold.ttf')
};
const INK = '#0a0a0a', HOT = '#ff3d00', GRAY = '#6a6a6a', RULE = '#cfc9bf', WHITE = '#ffffff';
const OK = '#0f8a5f', WARN = '#b45309', BAD = '#c2410c', COOL = '#2563eb';
const M = 46;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];

const s = v => (v === null || v === undefined) ? '' : String(v);
const dkey = v => {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const t = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
function fmtDate(v) {
  const k = dkey(v); if (!k) return '';
  const [y, m, d] = k.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
function fmtLong(v) {
  const k = dkey(v); if (!k) return '';
  const [y, m, d] = k.split('-').map(Number);
  return `${d} ${MONTHS_LONG[m - 1]} ${y}`;
}
// The mono face has no peso sign, so ₱ is only ever printed in Inter.
function peso(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-' : '') + '₱' + abs;
}

// ── amount in words, for the receipt ─────────────────────────
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  let out = '';
  if (n >= 100) { out += ONES[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n) out += ' '; }
  if (n >= 20) { out += TENS[Math.floor(n / 10)]; n %= 10; if (n) out += '-' + ONES[n]; }
  else if (n > 0) out += ONES[n];
  return out;
}
function amountInWords(v) {
  const n = Math.floor(Math.abs(Number(v) || 0));
  const cents = Math.round((Math.abs(Number(v) || 0) - n) * 100);
  if (n === 0 && cents === 0) return 'Zero pesos';
  const groups = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  let rest = n, parts = [];
  groups.forEach(([size, name]) => {
    if (rest >= size) { parts.push(under1000(Math.floor(rest / size)) + ' ' + name); rest %= size; }
  });
  if (rest > 0) parts.push(under1000(rest));
  let words = parts.join(' ').trim() || 'zero';
  words = words.charAt(0).toUpperCase() + words.slice(1);
  let out = `${words} peso${n === 1 ? '' : 's'}`;
  if (cents > 0) out += ` and ${under1000(cents)}/100`;
  return out;
}

// ── plumbing ─────────────────────────────────────────────────
function newDoc(opts = {}) {
  // Bottom margin 0 on purpose — page breaks are decided by ensure()/table()
  // against bottomY(), otherwise pdfkit silently inserts blank pages.
  const doc = new PDFDocument({
    size: opts.size || 'A4', layout: opts.layout || 'portrait',
    margins: { top: M, left: M, right: M, bottom: 0 }, bufferPages: true,
    info: { Title: opts.title || 'Case file', Author: opts.author || 'Law Office' }
  });
  Object.entries(FONTS).forEach(([k, p]) => doc.registerFont(k, p));
  return doc;
}
function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
const W = doc => doc.page.width, Hh = doc => doc.page.height;
const bottomY = doc => Hh(doc) - M - 40;

const mono = (doc, size, color) => doc.font('mono').fontSize(size).fillColor(color || GRAY);
const monoB = (doc, size, color) => doc.font('monoBold').fontSize(size).fillColor(color || INK);
const sans = (doc, size, color) => doc.font('sans').fontSize(size).fillColor(color || INK);
const semi = (doc, size, color) => doc.font('semi').fontSize(size).fillColor(color || INK);
const bold = (doc, size, color) => doc.font('bold').fontSize(size).fillColor(color || INK);
function rule(doc, y, weight, color, x1, x2) {
  doc.save().moveTo(x1 ?? M, y).lineTo(x2 ?? W(doc) - M, y)
     .lineWidth(weight || 0.6).strokeColor(color || RULE).stroke().restore();
}
function label(doc, x, y, text, opts = {}) {
  mono(doc, opts.size || 6.8, opts.color || GRAY)
    .text(String(text).toUpperCase(), x, y,
      { characterSpacing: 1.3, width: opts.width, align: opts.align, lineBreak: false });
}

// Shrinks `text` until it fits `maxW` on one line, down to minSize. Returns
// the size it settled on, or null when even minSize is too wide.
function fitSize(doc, font, text, maxW, maxSize, minSize) {
  doc.font(font);
  for (let sz = maxSize; sz >= minSize; sz -= 0.5) {
    doc.fontSize(sz);
    if (doc.widthOfString(text) <= maxW) return sz;
  }
  return null;
}
// Truncates to fit a width at the current font/size, adding an ellipsis.
// pdfkit wraps on `width` even with lineBreak:false, which is how a card
// caption ended up hanging out of the bottom of its box.
function clip(doc, font, size, text, maxW) {
  doc.font(font).fontSize(size);
  const t = s(text);
  if (doc.widthOfString(t) <= maxW) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(t.slice(0, mid) + '\u2026') <= maxW) lo = mid; else hi = mid - 1;
  }
  return t.slice(0, lo).trimEnd() + '\u2026';
}

// Firm identity, from settings, with a neutral fallback.
function firmOf(settings) {
  const st = settings || {};
  return {
    name: (st.firmName || '').trim() || 'LAW OFFICE',
    address: (st.firmAddress || '').trim(),
    contact: (st.firmContact || '').trim()
  };
}

function letterhead(doc, firm, title, metaLines) {
  const w = W(doc);
  const nm = firm.name.toUpperCase();
  const nameW = w / 2 - M - 12;                 // the right half holds the title block
  const one = fitSize(doc, 'bold', nm, nameW, 21, 12);
  // A name that will not fit on one line at 12pt gets two lines and a taller
  // band, rather than being drawn over the strapline.
  const bandH = one ? 78 : 94;
  doc.save().rect(0, 0, w, bandH).fill(INK).restore();
  doc.save().rect(0, bandH, w, 4).fill(HOT).restore();
  if (one) {
    bold(doc, one, WHITE).text(nm, M, 26, { characterSpacing: -0.4, width: nameW, lineBreak: false });
    mono(doc, 7, HOT).text('ATTORNEYS AT LAW', M, 54, { characterSpacing: 2, lineBreak: false });
  } else {
    bold(doc, 14, WHITE).text(nm, M, 16, { characterSpacing: -0.4, width: nameW, height: 40 });
    mono(doc, 7, HOT).text('ATTORNEYS AT LAW', M, 70, { characterSpacing: 2, lineBreak: false });
  }
  const rx = w / 2, rw = w / 2 - M;
  monoB(doc, 9.5, WHITE).text(String(title).toUpperCase(), rx, 26,
    { width: rw, align: 'right', characterSpacing: 2, lineBreak: false });
  let y = 42;
  (metaLines || []).filter(Boolean).forEach(t => {
    mono(doc, 7, '#cfcfcf').text(t, rx, y, { width: rw, align: 'right', characterSpacing: 0.6, lineBreak: false });
    y += 10;
  });
  return bandH + 22;
}
function runningHead(doc, firm, title) {
  const w = W(doc);
  doc.save().rect(0, 0, w, 26).fill(INK).restore();
  bold(doc, 10, WHITE).text(clip(doc, 'bold', 10, firm.name.toUpperCase(), w / 2 - M), M, 8, { lineBreak: false });
  mono(doc, 7, '#cfcfcf').text(String(title).toUpperCase(), w / 2, 10,
    { width: w / 2 - M, align: 'right', characterSpacing: 1.5, lineBreak: false });
  return 44;
}
function footers(doc, firm, note) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = Hh(doc) - M - 26;
    rule(doc, y, 1.4, INK);
    const fw = W(doc) - 2 * M - 86;   // leave room for "Page n of m"
    semi(doc, 7.5, INK).text(clip(doc, 'semi', 7.5, firm.name, fw), M, y + 7, { lineBreak: false });
    if (firm.contact) mono(doc, 6.2, GRAY).text(clip(doc, 'mono', 6.2, firm.contact, fw), M, y + 19, { lineBreak: false });
    if (firm.address) mono(doc, 6.2, GRAY).text(clip(doc, 'mono', 6.2, firm.address, fw), M, y + 29, { lineBreak: false });
    if (note) mono(doc, 5.8, GRAY).text(note, M, y + 39, { lineBreak: false });
    mono(doc, 6.5, GRAY).text(`Page ${i - range.start + 1} of ${range.count}`,
      W(doc) - M - 70, y + 12, { width: 70, align: 'right', lineBreak: false });
  }
}
function ensure(doc, y, need, ctx) {
  if (y + need <= bottomY(doc)) return y;
  doc.addPage();
  return runningHead(doc, ctx.firm, ctx.title);
}
function section(doc, y, title, ctx) {
  y = ensure(doc, y, 44, ctx);
  label(doc, M, y, title, { size: 7.2, color: HOT });
  rule(doc, y + 12, 1.2, INK);
  return y + 20;
}
function kvGrid(doc, y, pairs, ctx, cols = 3) {
  const items = pairs.filter(p => s(p[1]).trim() !== '');
  if (!items.length) return y;
  const cw = (W(doc) - 2 * M) / cols, gap = 10;
  let col = 0, rowH = 0;
  items.forEach((p, idx) => {
    if (col === 0) { y = ensure(doc, y, 34, ctx); rowH = 0; }
    const x = M + col * cw;
    label(doc, x, y, p[0]);
    sans(doc, 9.6, INK);
    const h = doc.heightOfString(s(p[1]), { width: cw - gap });
    doc.text(s(p[1]), x, y + 10, { width: cw - gap });
    rowH = Math.max(rowH, h + 10);
    col++;
    if (col === cols || idx === items.length - 1) { y += rowH + 10; col = 0; }
  });
  return y + 2;
}
function statCards(doc, y, cards, ctx) {
  y = ensure(doc, y, 62, ctx);
  const n = cards.length, gap = 8, cw = (W(doc) - 2 * M - gap * (n - 1)) / n;
  cards.forEach((c, i) => {
    const x = M + i * (cw + gap);
    doc.save().rect(x, y, cw, 54).lineWidth(1.2).strokeColor(INK).stroke().restore();
    if (c.accent) doc.save().rect(x, y, 4, 54).fill(c.accent).restore();
    label(doc, x + 10, y + 9, c.label);
    // Shrink the headline to fit rather than letting it spill past the box.
    const vsz = fitSize(doc, 'bold', s(c.value), cw - 20, 14, 8) || 8;
    bold(doc, vsz, c.color || INK)
      .text(clip(doc, 'bold', vsz, c.value, cw - 20), x + 10, y + 22 + (14 - vsz) / 2, { lineBreak: false });
    if (c.sub) sans(doc, 6.6, GRAY).text(clip(doc, 'sans', 6.6, c.sub, cw - 20), x + 10, y + 41, { lineBreak: false });
  });
  return y + 66;
}
function para(doc, y, text, ctx, opts = {}) {
  if (!s(text).trim()) return y;
  const w = W(doc) - 2 * M;
  sans(doc, opts.size || 9.4, opts.color || INK);
  const h = doc.heightOfString(s(text), { width: w });
  y = ensure(doc, y, Math.min(h, 120) + 10, ctx);
  doc.text(s(text), M, y, { width: w, align: opts.align || 'left' });
  return y + h + (opts.gap === undefined ? 12 : opts.gap);
}
function note(doc, y, text, ctx) {
  y = ensure(doc, y, 40, ctx);
  const w = W(doc) - 2 * M - 16;
  mono(doc, 6.6, GRAY);
  const h = doc.heightOfString(text, { width: w });
  doc.save().rect(M, y, W(doc) - 2 * M, h + 14).fill('#f4f2ee').restore();
  doc.save().rect(M, y, 3, h + 14).fill(HOT).restore();
  mono(doc, 6.6, GRAY).text(text, M + 10, y + 7, { width: w });
  return y + h + 20;
}
function table(doc, y, cols, rows, ctx, opts = {}) {
  const totalW = W(doc) - 2 * M;
  const fixed = cols.reduce((t, c) => t + (c.w || 0), 0);
  const flex = cols.filter(c => !c.w).length;
  const widths = cols.map(c => c.w || (totalW - fixed) / Math.max(1, flex));
  const header = yy => {
    let x = M;
    cols.forEach((c, i) => {
      label(doc, x + (c.pill ? 8 : 2), yy, c.label,
        { width: widths[i] - (c.pill ? 10 : 4), align: c.align || 'left' });
      x += widths[i];
    });
    rule(doc, yy + 11, 1.2, INK);
    return yy + 16;
  };
  y = ensure(doc, y, 44, ctx);
  y = header(y);
  if (!rows.length) {
    sans(doc, 8.5, GRAY).text(opts.empty || 'Nothing recorded.', M + 2, y + 2);
    return y + 18;
  }
  rows.forEach(r => {
    sans(doc, 8.6, INK);
    const cellH = cols.map((c, i) => {
      const v = s(c.fmt ? c.fmt(r) : r[c.key]);
      return doc.heightOfString(v || ' ', { width: widths[i] - 6 });
    });
    const rh = Math.max(12, ...cellH) + 6;
    if (y + rh > bottomY(doc)) { doc.addPage(); y = runningHead(doc, ctx.firm, ctx.title); y = header(y); }
    let x = M;
    cols.forEach((c, i) => {
      const v = s(c.fmt ? c.fmt(r) : r[c.key]);
      if (c.pill) {
        const color = c.pill(r);
        if (color) {
          const tw = Math.min(widths[i] - 10, doc.widthOfString(v.toUpperCase()) + 10);
          doc.save().rect(x + 8, y + 1, tw, 11).fill(color).restore();
          monoB(doc, 5.8, WHITE).text(v.toUpperCase(), x + 13, y + 4, { lineBreak: false, characterSpacing: 0.8 });
        } else {
          mono(doc, 6.5, GRAY).text(v.toUpperCase(), x + 8, y + 3, { lineBreak: false, characterSpacing: 0.8 });
        }
      } else {
        (c.strong ? semi : sans)(doc, 8.6, c.color ? c.color(r) : INK)
          .text(v, x + 3, y + 2, { width: widths[i] - 6, align: c.align || 'left' });
      }
      x += widths[i];
    });
    y += rh;
    rule(doc, y - 1, 0.5, RULE);
  });
  if (opts.totals) {
    y = ensure(doc, y, 22, ctx);
    rule(doc, y, 1.2, INK);
    let x = M;
    cols.forEach((c, i) => {
      const v = s(opts.totals[c.key]);
      if (v) semi(doc, 9, INK).text(v, x + 3, y + 5, { width: widths[i] - 6, align: c.align || 'left' });
      x += widths[i];
    });
    y += 22;
  }
  return y + 6;
}

const STAGE_LABEL = {
  intake: 'Intake', pre_filing: 'Pre-filing', filed: 'Filed', pre_trial: 'Pre-trial',
  trial: 'Trial', decision: 'For decision', post_judgment: 'Post-judgment',
  closed: 'Closed', on_hold: 'On hold'
};
const deadlineColor = st => st === 'missed' ? BAD : st === 'today' || st === 'urgent' ? WARN
  : st === 'done' ? OK : st === 'soon' ? COOL : null;

function courtLine(c) {
  return [c.court, c.branch && ('Branch ' + c.branch), c.courtCity].filter(Boolean).join(', ');
}
function captionOf(c) {
  return [c.title, c.docketNumber && `(${c.docketNumber})`].filter(Boolean).join(' ');
}

// ── 1. CASE DOCUMENT ─────────────────────────────────────────
// mode: 'summary'   — the one-page picture of where the matter stands
//       'statement' — what the client owes, for sending out
//       'full'      — the whole internal file
function casePdf(c, comp, mode, settings) {
  const firm = firmOf(settings);
  const titles = { summary: 'Case summary', statement: 'Statement of account', full: 'Case file' };
  const title = titles[mode] || 'Case summary';
  const doc = newDoc({ title: `${title} — ${c.title || ''}`, author: firm.name });
  const ctx = { firm, title };
  let y = letterhead(doc, firm, title, [
    c.caseRef || '', `AS OF ${fmtDate(comp.today).toUpperCase()}`
  ]);

  // caption
  y += 4;
  bold(doc, 16, INK).text(s(c.title), M, y, { width: W(doc) - 2 * M });
  y = doc.y + 4;
  if (c.docketNumber || c.court) {
    mono(doc, 8, GRAY).text([c.docketNumber, courtLine(c)].filter(Boolean).join('  ·  '), M, y,
      { width: W(doc) - 2 * M, characterSpacing: 0.6 });
    y = doc.y + 6;
  }
  rule(doc, y, 1.6, INK); y += 14;

  if (mode === 'statement') {
    // ── client-facing: money only ──
    y = statCards(doc, y, [
      { label: 'Total billed', value: peso(comp.billed) },
      { label: 'Payments received', value: peso(comp.paid), color: OK, accent: OK },
      { label: 'Balance due', value: peso(comp.balance),
        color: comp.balance > 0.005 ? BAD : OK, accent: comp.balance > 0.005 ? BAD : OK },
      { label: 'Disbursements', value: peso(comp.disbursements), sub: 'advanced by the firm' }
    ], ctx);

    y = section(doc, y, 'Charges', ctx);
    y = table(doc, y, [
      { key: 'date', label: 'Date', w: 66, fmt: r => fmtDate(r.date) },
      { key: 'label', label: 'Particulars', fmt: r => r.label || r.kind },
      { key: 'reimb', label: '', w: 60, fmt: r => r.reimbursable ? 'Advanced' : '', color: () => GRAY },
      { key: 'amount', label: 'Amount', w: 88, align: 'right', fmt: r => peso(r.amount), strong: true }
    ], comp.charges, ctx, {
      empty: 'No charges billed yet.',
      totals: comp.charges.length ? { label: 'Total billed', amount: peso(comp.billed) } : null
    });

    y = section(doc, y, 'Payments received', ctx);
    y = table(doc, y, [
      { key: 'date', label: 'Date', w: 66, fmt: r => fmtDate(r.date) },
      { key: 'receiptNo', label: 'Receipt', w: 78 },
      { key: 'label', label: 'For', fmt: r => r.label || '' },
      { key: 'mode', label: 'Mode', w: 62 },
      { key: 'amount', label: 'Amount', w: 88, align: 'right', fmt: r => peso(r.amount), strong: true, color: () => OK }
    ], comp.payments, ctx, {
      empty: 'No payments received yet.',
      totals: comp.payments.length ? { label: 'Total received', amount: peso(comp.paid) } : null
    });

    y = ensure(doc, y, 60, ctx);
    const bw = 220, bx = W(doc) - M - bw;
    doc.save().rect(bx, y, bw, 44).fill(comp.balance > 0.005 ? INK : OK).restore();
    label(doc, bx + 14, y + 10, comp.balance > 0.005 ? 'Balance due' : 'Fully settled', { color: '#cfcfcf' });
    bold(doc, 18, WHITE).text(peso(Math.max(0, comp.balance)), bx + 14, y + 20, { width: bw - 28, lineBreak: false });
    y += 56;

    y = note(doc, y,
      'This is a statement of account, not a bill of costs taxed by any court. Amounts marked "Advanced" were paid out by the firm on the client\'s behalf and are reimbursed at cost. Please quote the case reference on any payment.', ctx);
  } else {
    // ── internal: where the matter stands ──
    const cards = [
      { label: 'Stage', value: STAGE_LABEL[c.stage] || c.stage },
      { label: 'Next hearing', value: comp.nextHearing ? fmtDate(comp.nextHearing.date) : 'None set',
        sub: comp.nextHearing ? (comp.nextHearing.purpose || '') : '', accent: comp.nextHearing ? COOL : null },
      { label: 'Open deadlines', value: String(comp.openDeadlineCount),
        sub: comp.missedCount ? `${comp.missedCount} missed` : (comp.dueSoonCount ? `${comp.dueSoonCount} due soon` : ''),
        color: comp.missedCount ? BAD : INK, accent: comp.missedCount ? BAD : null },
      { label: 'Balance', value: peso(comp.balance), color: comp.balance > 0.005 ? BAD : OK }
    ];
    y = statCards(doc, y, cards, ctx);

    if (comp.prescription) {
      const p = comp.prescription;
      const col = p.status === 'lapsed' ? BAD : p.status === 'critical' ? BAD : p.status === 'warning' ? WARN : OK;
      y = ensure(doc, y, 40, ctx);
      doc.save().rect(M, y, W(doc) - 2 * M, 30).lineWidth(1.4).strokeColor(col).stroke().restore();
      doc.save().rect(M, y, 4, 30).fill(col).restore();
      label(doc, M + 14, y + 7, 'Prescriptive period', { color: col });
      semi(doc, 10, col).text(
        p.status === 'lapsed'
          ? `LAPSED on ${fmtDate(p.date)} — ${Math.abs(p.daysLeft)} days ago`
          : `${fmtDate(p.date)} — ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left to file`,
        M + 14, y + 17, { width: W(doc) - 2 * M - 28, lineBreak: false });
      y += 42;
    }

    y = section(doc, y, 'The matter', ctx);
    y = kvGrid(doc, y, [
      ['Our reference', c.caseRef],
      ['Docket number', c.docketNumber],
      ['Court / tribunal', courtLine(c)],
      ['Presiding judge', c.judge],
      ['Type', (c.caseType || '').replace(/_/g, ' ')],
      ['Nature of action', c.natureOfAction],
      ['Lead counsel', c.leadCounsel],
      ['Collaborating', c.collaborating],
      ['Engaged', fmtDate(c.dateEngaged)],
      ['Filed', fmtDate(c.dateFiled)],
      ['Pending', comp.pendingDays !== null ? `${comp.pendingDays} days` : ''],
      ['Priority', c.priority !== 'normal' ? c.priority : '']
    ], ctx);

    y = section(doc, y, 'Parties', ctx);
    y = kvGrid(doc, y, [
      ['Our client', c.clientName],
      ['Appearing as', c.clientRole],
      ['Contact', [c.clientPhone, c.clientEmail].filter(Boolean).join('  ')],
      ['Address', c.clientAddress]
    ], ctx, 2);
    if ((c.adverseParties || []).length) {
      y = table(doc, y, [
        { key: 'name', label: 'Adverse party', strong: true },
        { key: 'role', label: 'As', w: 100 },
        { key: 'counsel', label: 'Counsel', w: 150 },
        { key: 'contact', label: 'Contact', w: 110 }
      ], c.adverseParties, ctx, { empty: 'None recorded.' });
    }

    if (c.barangayRequired) {
      y = section(doc, y, 'Barangay conciliation', ctx);
      y = kvGrid(doc, y, [
        ['Barangay', c.barangayName],
        ['Certificate to File Action', c.cfaIssued ? 'Issued' : 'NOT YET ISSUED'],
        ['Date issued', fmtDate(c.cfaDate)]
      ], ctx);
      if (!c.cfaIssued) {
        y = note(doc, y,
          'A Certificate to File Action has not been recorded. Where the Katarungang Pambarangay applies, filing without it exposes the complaint to dismissal for failure to comply with a condition precedent.', ctx);
      }
    }

    if (s(c.summary).trim()) {
      y = section(doc, y, 'Facts', ctx);
      y = para(doc, y, c.summary, ctx);
    }

    y = section(doc, y, 'Deadlines', ctx);
    y = table(doc, y, [
      { key: 'dueDate', label: 'Due', w: 68, fmt: r => fmtDate(r.dueDate) || '—' },
      { key: 'title', label: 'What', strong: true },
      { key: 'rule', label: 'Basis', w: 160, fmt: r => r.rule || '' },
      { key: 'status', label: 'Status', w: 70,
        fmt: r => r.done ? 'Done' : r.status === 'missed' ? 'Missed' : r.status === 'today' ? 'Today'
          : r.daysAway === null ? 'No date' : `${r.daysAway}d`,
        pill: r => deadlineColor(r.done ? 'done' : r.status) }
    ], comp.deadlines, ctx, { empty: 'No deadlines recorded.' });

    y = section(doc, y, 'Hearings', ctx);
    y = table(doc, y, [
      { key: 'date', label: 'Date', w: 68, fmt: r => fmtDate(r.date) },
      { key: 'time', label: 'Time', w: 52 },
      { key: 'purpose', label: 'Purpose', strong: true },
      { key: 'appearedBy', label: 'Appeared', w: 100 },
      { key: 'state', label: '', w: 62,
        fmt: r => r.reset ? 'Reset' : r.past ? 'Held' : 'Upcoming',
        pill: r => r.reset ? GRAY : r.past ? null : COOL }
    ], comp.hearings, ctx, { empty: 'No hearings recorded.' });

    if (mode === 'full') {
      y = section(doc, y, 'Filings and incoming papers', ctx);
      y = table(doc, y, [
        { key: 'date', label: 'Date', w: 68, fmt: r => fmtDate(r.date) },
        { key: 'direction', label: '', w: 58, fmt: r => r.direction === 'received' ? 'In' : 'Out',
          pill: r => r.direction === 'received' ? COOL : null },
        { key: 'title', label: 'Document', strong: true },
        { key: 'mode', label: 'Mode', w: 86 },
        { key: 'by', label: 'By', w: 90 }
      ], comp.filings, ctx, { empty: 'Nothing filed or received yet.' });

      y = section(doc, y, 'Account', ctx);
      y = table(doc, y, [
        { key: 'date', label: 'Date', w: 68, fmt: r => fmtDate(r.date) },
        { key: 'label', label: 'Charge', fmt: r => r.label || r.kind },
        { key: 'amount', label: 'Amount', w: 90, align: 'right', fmt: r => peso(r.amount), strong: true }
      ], comp.charges, ctx, {
        empty: 'Nothing billed.',
        totals: comp.charges.length ? { label: 'Billed', amount: peso(comp.billed) } : null
      });
      y = table(doc, y, [
        { key: 'date', label: 'Date', w: 68, fmt: r => fmtDate(r.date) },
        { key: 'receiptNo', label: 'Receipt', w: 80 },
        { key: 'label', label: 'Payment', fmt: r => r.label || '' },
        { key: 'amount', label: 'Amount', w: 90, align: 'right', fmt: r => peso(r.amount), strong: true, color: () => OK }
      ], comp.payments, ctx, {
        empty: 'Nothing received.',
        totals: comp.payments.length
          ? { label: 'Balance', amount: peso(comp.balance) } : null
      });

      if (comp.timeEntries.length) {
        y = section(doc, y, 'Time', ctx);
        y = table(doc, y, [
          { key: 'date', label: 'Date', w: 68, fmt: r => fmtDate(r.date) },
          { key: 'description', label: 'Work done' },
          { key: 'by', label: 'By', w: 96 },
          { key: 'hours', label: 'Hours', w: 52, align: 'right', fmt: r => r.hours.toFixed(2) },
          { key: 'value', label: 'Value', w: 78, align: 'right', fmt: r => r.value ? peso(r.value) : '—' }
        ], comp.timeEntries, ctx, {
          totals: { description: 'Total', hours: comp.hoursTotal.toFixed(2) }
        });
      }

      const notes = (c.notes || []).slice().sort((a, b) => dkey(b.at).localeCompare(dkey(a.at)));
      if (notes.length) {
        y = section(doc, y, 'Notes', ctx);
        notes.slice(0, 40).forEach(n => {
          y = ensure(doc, y, 34, ctx);
          label(doc, M, y, `${fmtDate(n.at)}${n.byName ? ' · ' + n.byName : ''}`);
          y += 11;
          y = para(doc, y, n.body, ctx, { size: 8.8, gap: 8 });
        });
      }
    }

    y = note(doc, y,
      'Internal working document, privileged and confidential. Dates shown are as recorded in this file — check them against the court\'s own orders before relying on them. The deadline basis given is a reference to the rule used when the entry was made, not legal advice.', ctx);
  }

  footers(doc, firm, mode === 'statement' ? '' : 'PRIVILEGED AND CONFIDENTIAL');
  return toBuffer(doc);
}

// ── 2. ACKNOWLEDGEMENT RECEIPT ───────────────────────────────
// A5 landscape, deliberately NOT called an official receipt: a BIR OR is a
// registered form and this is not one.
function receiptPdf(c, p, comp, settings) {
  const firm = firmOf(settings);
  const doc = newDoc({ size: 'A5', layout: 'landscape', title: `Receipt ${p.receiptNo || ''}`, author: firm.name });
  const ctx = { firm, title: 'Acknowledgement receipt' };
  const w = W(doc);
  // Same shrink-to-fit as the A4 letterhead: a long firm name used to be drawn
  // straight over the "ATTORNEYS AT LAW" strapline.
  const nm = firm.name.toUpperCase();
  const nameW = w / 2 - M - 12;
  const one = fitSize(doc, 'bold', nm, nameW, 14, 9);
  const bandH = one ? 58 : 72;
  doc.save().rect(0, 0, w, bandH).fill(INK).restore();
  doc.save().rect(0, bandH, w, 3).fill(HOT).restore();
  if (one) {
    bold(doc, one, WHITE).text(nm, M, 18, { width: nameW, lineBreak: false });
    mono(doc, 6.4, HOT).text('ATTORNEYS AT LAW', M, 38, { characterSpacing: 2, lineBreak: false });
  } else {
    bold(doc, 11, WHITE).text(nm, M, 12, { width: nameW, height: 32 });
    mono(doc, 6.4, HOT).text('ATTORNEYS AT LAW', M, 52, { characterSpacing: 2, lineBreak: false });
  }
  monoB(doc, 9, WHITE).text('ACKNOWLEDGEMENT RECEIPT', w / 2, 20,
    { width: w / 2 - M, align: 'right', characterSpacing: 1.6, lineBreak: false });
  mono(doc, 7.5, '#cfcfcf').text(p.receiptNo || '', w / 2, 36,
    { width: w / 2 - M, align: 'right', lineBreak: false });

  let y = bandH + 18;
  label(doc, M, y, 'Received from');
  semi(doc, 13, INK).text(s(c.clientName), M, y + 11, { width: w - 2 * M });
  y = doc.y + 8;

  label(doc, M, y, 'The sum of');
  bold(doc, 20, INK).text(peso(p.amount), M, y + 11, { lineBreak: false });
  const words = amountInWords(p.amount);
  sans(doc, 8.6, GRAY).text(`(${words})`, M, y + 36, { width: w - 2 * M });
  y = doc.y + 10;
  rule(doc, y, 1, RULE); y += 10;

  const half = (w - 2 * M) / 2;
  const pairs = [
    ['Date', fmtLong(p.date)],
    ['Mode of payment', p.mode || ''],
    ['In payment of', p.label || 'Legal services'],
    ['Reference', p.reference || ''],
    ['Case', captionOf(c)],
    ['Our reference', c.caseRef || '']
  ].filter(r => s(r[1]).trim());
  let col = 0, rowTop = y;
  pairs.forEach((pr, i) => {
    const x = M + col * half;
    label(doc, x, y, pr[0]);
    sans(doc, 9, INK).text(s(pr[1]), x, y + 10, { width: half - 12 });
    if (col === 1 || i === pairs.length - 1) { y = Math.max(y + 28, doc.y + 6); col = 0; }
    else { col = 1; doc.y = y; }
  });
  y = Math.max(y, rowTop + 28) + 4;

  rule(doc, y, 1, RULE); y += 8;
  label(doc, M, y, 'Balance on this matter after this payment');
  semi(doc, 11, comp.balance > 0.005 ? BAD : OK)
    .text(comp.balance > 0.005 ? peso(comp.balance) + ' remaining' : 'Fully settled', M, y + 11, { lineBreak: false });

  const sx = w - M - 190;
  rule(doc, Hh(doc) - M - 34, 0.8, INK, sx, w - M);
  mono(doc, 6.4, GRAY).text('AUTHORISED SIGNATORY', sx, Hh(doc) - M - 28,
    { width: 190, align: 'center', characterSpacing: 1.2, lineBreak: false });
  mono(doc, 5.8, GRAY).text(
    'This is an acknowledgement receipt only. It is not a BIR-registered official receipt.',
    M, Hh(doc) - M - 16, { width: w - 2 * M, lineBreak: false });
  return toBuffer(doc);
}

// ── 3. COURT DIARY ───────────────────────────────────────────
// A4 landscape: every setting in the next N days, across every open matter.
function docketPdf({ today, days, rows }, settings) {
  const firm = firmOf(settings);
  const title = 'Court diary';
  const doc = newDoc({ size: 'A4', layout: 'landscape', title, author: firm.name });
  const ctx = { firm, title };
  let y = letterhead(doc, firm, title, [
    `${fmtDate(today).toUpperCase()} — NEXT ${days} DAYS`,
    `${rows.length} SETTING${rows.length === 1 ? '' : 'S'}`
  ]);
  y += 6;

  // Group by date so the lawyer reads a day at a time.
  const byDate = [];
  rows.forEach(r => {
    const last = byDate[byDate.length - 1];
    if (last && last.date === r.date) last.rows.push(r);
    else byDate.push({ date: r.date, rows: [r] });
  });

  if (!byDate.length) {
    y = para(doc, y, 'No hearings are set in this period.', ctx, { color: GRAY });
  }
  byDate.forEach(g => {
    y = ensure(doc, y, 60, ctx);
    const [yy, mm, dd] = g.date.split('-').map(Number);
    const wd = new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString('en-PH', { weekday: 'long', timeZone: 'UTC' });
    label(doc, M, y, `${wd} · ${fmtDate(g.date)}`, { size: 7.6, color: HOT });
    rule(doc, y + 12, 1.2, INK);
    y += 18;
    y = table(doc, y, [
      { key: 'time', label: 'Time', w: 58 },
      { key: 'purpose', label: 'Purpose', w: 160, strong: true },
      { key: 'title', label: 'Case', fmt: r => r.title || '' },
      { key: 'docket', label: 'Docket', w: 120 },
      { key: 'court', label: 'Court', w: 150 },
      { key: 'client', label: 'Client', w: 120 },
      { key: 'counsel', label: 'Counsel', w: 110 }
    ], g.rows, ctx, { empty: '' });
    y += 4;
  });

  y = note(doc, y,
    'Generated from the case files. Confirm every setting against the court\'s own calendar and the notice of hearing before relying on it. Privileged and confidential.', ctx);
  footers(doc, firm, 'PRIVILEGED AND CONFIDENTIAL');
  return toBuffer(doc);
}

module.exports = { casePdf, receiptPdf, docketPdf, _test: { amountInWords, fmtDate, peso } };
