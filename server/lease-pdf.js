// =============================================================================
// LEASE PDFs — statement of account, owner statement, lease profile,
// acknowledgement receipt, monthly rent roll
// =============================================================================
// Built with pdfkit and the site's own typefaces (Inter + JetBrains Mono, the
// latin-ext cut so the peso sign renders). Same brutalist letterhead as the
// emails: black band, hot-orange rule, mono uppercase labels, hairline tables.
//
// Every function returns a Promise<Buffer>. Nothing here touches the database:
// the caller passes the lease, the computed ledger (server/leasing.js
// computeLease) and a handful of formatting helpers.
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
const INK = '#0a0a0a', HOT = '#ff3d00', GRAY = '#6a6a6a', RULE = '#cfc9bf', PAPER = '#f1eee9', WHITE = '#ffffff';
const OK = '#0f8a5f', WARN = '#b45309', BAD = '#c2410c';
const M = 46;   // page margin

const BROKER = {
  name: 'Catherine SB Sampayo', title: 'Licensed Real Estate Broker',
  phone: '+63 917 177 4572', email: 'glrarealty@gmail.com', site: 'glrarealty.com',
  address: '17th Floor, 252 Senator Gil J. Puyat Avenue, Makati City 1200'
};

// ── plumbing ────────────────────────────────────────────────
function newDoc(opts = {}) {
  // Bottom margin is 0 on purpose: pdfkit would otherwise start a new page by
  // itself whenever text lands in the footer zone. Page breaks are decided
  // here (ensure / table) against bottomY(), and the footer is drawn last.
  const doc = new PDFDocument({ size: opts.size || 'A4', layout: opts.layout || 'portrait', margins: { top: M, left: M, right: M, bottom: 0 }, bufferPages: true, info: { Title: opts.title || 'GLRA Realty', Author: 'GLRA Realty' } });
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
const bottomY = doc => Hh(doc) - M - 40;   // keep clear of the footer

function mono(doc, size, color) { doc.font('mono').fontSize(size).fillColor(color || GRAY); return doc; }
function monoB(doc, size, color) { doc.font('monoBold').fontSize(size).fillColor(color || INK); return doc; }
function sans(doc, size, color) { doc.font('sans').fontSize(size).fillColor(color || INK); return doc; }
function semi(doc, size, color) { doc.font('semi').fontSize(size).fillColor(color || INK); return doc; }
function bold(doc, size, color) { doc.font('bold').fontSize(size).fillColor(color || INK); return doc; }
function rule(doc, y, weight, color, x1, x2) { doc.save().moveTo(x1 ?? M, y).lineTo(x2 ?? W(doc) - M, y).lineWidth(weight || 0.6).strokeColor(color || RULE).stroke().restore(); }
function label(doc, x, y, text, opts = {}) { mono(doc, opts.size || 6.8, opts.color || GRAY).text(String(text).toUpperCase(), x, y, { characterSpacing: 1.3, width: opts.width, align: opts.align, lineBreak: false }); }
const s = v => (v === null || v === undefined) ? '' : String(v);
// 'YYYY-MM-DD' from a Date, an ISO string or a plain key; '' when unset.
const dkey = v => {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const t = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const fd = (H, v) => { const k = dkey(v); return k ? H.fmtDate(k) : ''; };
// "Sep 15 – Oct 14, 2026" (the first year is dropped when both dates share it)
const covers = (H, r) => { const a = H.fmtDate(r.start), b = H.fmtDate(r.end); return (r.start.slice(0, 4) === r.end.slice(0, 4) ? a.replace(/, \d{4}$/, '') : a) + ' – ' + b; };

// The black letterhead band. Returns the y where content may start.
function letterhead(doc, title, metaLines) {
  const w = W(doc);
  doc.save().rect(0, 0, w, 78).fill(INK).restore();
  doc.save().rect(0, 78, w, 4).fill(HOT).restore();
  bold(doc, 22, WHITE).text('GLRA REALTY', M, 24, { characterSpacing: -0.8, lineBreak: false });
  mono(doc, 7, HOT).text('PREMIER REAL ESTATE · MANILA', M, 50, { characterSpacing: 2, lineBreak: false });
  const rx = w / 2, rw = w / 2 - M;
  monoB(doc, 9.5, WHITE).text(title.toUpperCase(), rx, 26, { width: rw, align: 'right', characterSpacing: 2, lineBreak: false });
  let y = 42;
  (metaLines || []).forEach(t => { mono(doc, 7, '#cfcfcf').text(t, rx, y, { width: rw, align: 'right', characterSpacing: 0.6, lineBreak: false }); y += 10; });
  return 100;
}
// Continuation pages get a slim strip instead of the full band.
function runningHead(doc, title) {
  const w = W(doc);
  doc.save().rect(0, 0, w, 26).fill(INK).restore();
  bold(doc, 10, WHITE).text('GLRA REALTY', M, 8, { lineBreak: false });
  mono(doc, 7, '#cfcfcf').text(title.toUpperCase(), w / 2, 10, { width: w / 2 - M, align: 'right', characterSpacing: 1.5, lineBreak: false });
  return 44;
}
function footers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = Hh(doc) - M - 26;
    rule(doc, y, 1.4, INK);
    semi(doc, 7.5, INK).text(`${BROKER.name} · ${BROKER.title} · GLRA Realty`, M, y + 7, { lineBreak: false });
    mono(doc, 6.2, GRAY).text(`${BROKER.phone} · ${BROKER.email} · ${BROKER.site}`, M, y + 19, { lineBreak: false });
    mono(doc, 6.2, GRAY).text(BROKER.address, M, y + 29, { lineBreak: false });
    mono(doc, 6.5, GRAY).text(`Page ${i - range.start + 1} of ${range.count}`, W(doc) - M - 70, y + 12, { width: 70, align: 'right', lineBreak: false });
  }
}
// Page-break guard: asks for `need` points of room, starts a new page if not.
function ensure(doc, y, need, title) {
  if (y + need <= bottomY(doc)) return y;
  doc.addPage();
  return runningHead(doc, title);
}
function section(doc, y, title, ctx) {
  y = ensure(doc, y, 40, ctx.title);
  label(doc, M, y, title, { size: 7.2, color: HOT });
  rule(doc, y + 12, 1.2, INK);
  return y + 20;
}
// Label-over-value pairs laid out in columns. Skips empty values.
function kvGrid(doc, y, pairs, ctx, cols = 3) {
  const items = pairs.filter(p => s(p[1]).trim() !== '');
  if (!items.length) return y;
  const cw = (W(doc) - 2 * M) / cols, gap = 10;
  let col = 0, rowH = 0;
  items.forEach((p, idx) => {
    if (col === 0) { y = ensure(doc, y, 34, ctx.title); rowH = 0; }
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
// Four big-number cards across the page.
function statCards(doc, y, cards, ctx) {
  y = ensure(doc, y, 62, ctx.title);
  const n = cards.length, gap = 8, cw = (W(doc) - 2 * M - gap * (n - 1)) / n;
  cards.forEach((c, i) => {
    const x = M + i * (cw + gap);
    doc.save().rect(x, y, cw, 54).lineWidth(1.2).strokeColor(INK).stroke().restore();
    if (c.accent) doc.save().rect(x, y, 4, 54).fill(c.accent).restore();
    label(doc, x + 10, y + 9, c.label);
    bold(doc, c.value.length > 14 ? 11.5 : 14, c.color || INK).text(c.value, x + 10, y + 22, { width: cw - 16, lineBreak: false });
    if (c.sub) sans(doc, 6.6, GRAY).text(c.sub, x + 10, y + 40, { width: cw - 16, lineBreak: false });
  });
  return y + 66;
}
// A table with a mono header, hairline rows and automatic page breaks.
function table(doc, y, cols, rows, ctx, opts = {}) {
  const totalW = W(doc) - 2 * M;
  const fixed = cols.reduce((t, c) => t + (c.w || 0), 0);
  const flex = cols.filter(c => !c.w).length;
  const widths = cols.map(c => c.w || (totalW - fixed) / Math.max(1, flex));
  const header = yy => {
    let x = M;
    cols.forEach((c, i) => { label(doc, x + (c.pill ? 8 : 2), yy, c.label, { width: widths[i] - (c.pill ? 10 : 4), align: c.align || 'left' }); x += widths[i]; });
    rule(doc, yy + 11, 1.2, INK);
    return yy + 16;
  };
  y = ensure(doc, y, 40, ctx.title);
  y = header(y);
  if (!rows.length) {
    sans(doc, 8.5, GRAY).text(opts.empty || 'Nothing recorded.', M + 2, y + 2);
    return y + 16;
  }
  rows.forEach(r => {
    sans(doc, 8.6, INK);
    const cellH = cols.map((c, i) => { const v = s(c.fmt ? c.fmt(r) : r[c.key]); return doc.heightOfString(v || ' ', { width: widths[i] - 6 }); });
    const rh = Math.max(12, ...cellH) + 6;
    if (y + rh > bottomY(doc)) { doc.addPage(); y = runningHead(doc, ctx.title); y = header(y); }
    let x = M;
    cols.forEach((c, i) => {
      const v = s(c.fmt ? c.fmt(r) : r[c.key]);
      if (c.pill) {
        const color = c.pill(r);
        if (color) { const tw = Math.min(widths[i] - 10, doc.widthOfString(v.toUpperCase()) + 10); doc.save().rect(x + 8, y + 1, tw, 11).fill(color).restore(); monoB(doc, 5.8, WHITE).text(v.toUpperCase(), x + 13, y + 4, { lineBreak: false, characterSpacing: 0.8 }); }
        else mono(doc, 6.5, GRAY).text(v.toUpperCase(), x + 8, y + 3, { lineBreak: false, characterSpacing: 0.8 });
      } else {
        (c.strong ? semi : sans)(doc, 8.6, c.color ? c.color(r) : INK).text(v, x + 3, y + 2, { width: widths[i] - 6, align: c.align || 'left' });
      }
      x += widths[i];
    });
    y += rh;
    rule(doc, y - 1, 0.5, RULE);
  });
  if (opts.totals) {
    y = ensure(doc, y, 20, ctx.title);
    let x = M;
    cols.forEach((c, i) => { const v = opts.totals[c.key]; if (v !== undefined) (c.key === '_label' ? monoB : bold)(doc, 8.8, INK).text(s(v), x + 3, y + 5, { width: widths[i] - 6, align: c.align || 'left', lineBreak: false }); x += widths[i]; });
    rule(doc, y + 19, 1.2, INK);
    y += 24;
  }
  return y + 6;
}
function note(doc, y, text, ctx) {
  y = ensure(doc, y, 30, ctx.title);
  sans(doc, 7.6, GRAY).text(text, M, y, { width: W(doc) - 2 * M, lineGap: 1.5 });
  return y + doc.heightOfString(text, { width: W(doc) - 2 * M }) + 8;
}
const statusColor = st => ({ paid: OK, overdue: BAD, partial: WARN, due: WARN, upcoming: null })[st] ?? null;
const statusText = st => ({ paid: 'Paid', overdue: 'Overdue', partial: 'Partial', due: 'Due now', upcoming: 'Upcoming' })[st] || st;

// Amount in words for the acknowledgement receipt.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + words(n % 100) : '');
  const units = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  for (const [v, name] of units) if (n >= v) return words(Math.floor(n / v)) + ' ' + name + (n % v ? ' ' + words(n % v) : '');
  return '';
}
function amountInWords(amount) {
  const whole = Math.floor(Math.abs(amount)), cents = Math.round((Math.abs(amount) - whole) * 100);
  const base = whole ? words(whole) + ' Peso' + (whole === 1 ? '' : 's') : 'Zero Pesos';
  return cents ? `${base} and ${String(cents).padStart(2, '0')}/100` : `${base} Only`;
}

// ── LEASE PROFILE / STATEMENT OF ACCOUNT / OWNER STATEMENT ──
async function leasePdf(l, c, mode, H) {
  const titles = { tenant: 'Statement of Account', owner: 'Owner Statement', full: 'Lease Profile' };
  const ctx = { title: titles[mode] || titles.full };
  const ref = 'L-' + String(l._id || '').slice(-6).toUpperCase();
  const doc = newDoc({ title: `${ctx.title} — ${l.tenantName || l.propertyTitle || ref}` });
  let y = letterhead(doc, ctx.title, [`As of ${H.fmtDate(c.today)}`, `Ref ${ref} · ${H.stageLabel(l.stage)}`]);
  const unit = [l.propertyTitle, l.unit].filter(Boolean).join(' · ');

  // Addressee
  if (mode === 'owner') {
    label(doc, M, y, 'Prepared for the owner'); bold(doc, 14).text(l.ownerName || 'Property owner', M, y + 10, { lineBreak: false });
  } else {
    label(doc, M, y, mode === 'tenant' ? 'Prepared for' : 'Tenant'); bold(doc, 14).text(l.tenantName || 'No tenant yet', M, y + 10, { lineBreak: false });
  }
  label(doc, W(doc) / 2, y, 'Property', { width: W(doc) / 2 - M, align: 'right' });
  semi(doc, 10.5).text(unit || 'Property not set', W(doc) / 2, y + 11, { width: W(doc) / 2 - M, align: 'right' });
  if (l.address) sans(doc, 8, GRAY).text(l.address, W(doc) / 2, y + 25, { width: W(doc) / 2 - M, align: 'right' });
  y += 46;

  // Headline numbers
  const balanceCard = c.balance > 0
    ? { label: 'Balance due', value: H.peso(c.balance), color: BAD, accent: BAD, sub: c.overdueCount ? `${c.overdueCount} overdue · oldest ${c.oldestOverdueDays} days` : 'within grace period' }
    : c.balance < 0 ? { label: 'Paid ahead', value: H.peso(-c.balance), color: OK, accent: OK, sub: 'credit on account' }
    : { label: 'Balance', value: 'Fully paid', color: OK, accent: OK, sub: `${H.peso(c.credits.rent)} received to date` };
  const nextCard = c.nextDue ? { label: c.nextDue.status === 'overdue' ? 'Overdue payment' : 'Next payment', value: H.peso(c.nextDue.remaining), sub: `${c.nextDue.label} · due ${H.fmtDate(c.nextDue.due)}`, color: c.nextDue.status === 'overdue' ? BAD : INK }
    : { label: 'Next payment', value: 'None due', sub: c.schedule.length ? 'schedule complete' : 'no schedule yet' };
  const depCard = { label: 'Security deposit', value: H.peso(c.deposit.held), sub: { unpaid: 'not yet received', partial: `of ${H.peso(c.deposit.required)} required`, held: 'held for the tenant', settled: 'settled at move-out', none: 'no deposit set' }[c.deposit.status] };
  const endCard = { label: 'Lease ends', value: c.end ? H.fmtDate(c.end) : 'Not set', sub: c.daysToEnd === null ? '' : c.daysToEnd < 0 ? `${-c.daysToEnd} days ago` : `${c.daysToEnd} days from now`, color: c.endsSoon ? WARN : INK };
  if (mode === 'owner') {
    const fee = l.managedByGLRA ? H.peso(Math.round(c.credits.rent * (Number(l.managementFeePct) || 0) / 100 * 100) / 100) : 'None';
    y = statCards(doc, y, [{ label: 'Rent collected', value: H.peso(c.credits.rent), color: OK, accent: OK, sub: `of ${H.peso(c.dueToDate)} due to date` }, { label: 'Tenant balance', value: c.balance > 0 ? H.peso(c.balance) : 'Up to date', color: c.balance > 0 ? BAD : OK, sub: c.overdueCount ? `${c.overdueCount} overdue` : '' }, { label: 'Management fee', value: fee, sub: l.managedByGLRA ? `${l.managementFeePct}% of rent collected` : 'not GLRA-managed' }, endCard], ctx);
  } else {
    y = statCards(doc, y, [balanceCard, nextCard, depCard, endCard], ctx);
  }

  // The unit
  y = section(doc, y, 'The unit', ctx);
  y = kvGrid(doc, y, [['Property', l.propertyTitle], ['Unit', l.unit], ['Address', l.address], ['Type', l.propertyType], ['Furnished', { unfurnished: 'Unfurnished', semi: 'Semi-furnished', full: 'Fully furnished' }[l.furnished] || ''], ['Parking', l.parkingSlots ? `${l.parkingSlots} slot${l.parkingSlots > 1 ? 's' : ''}` : ''], ['Inclusions', l.inclusions], ['Utilities included', l.utilitiesIncluded]], ctx);

  // Parties
  if (mode !== 'tenant') {
    y = section(doc, y, 'Tenant (lessee)', ctx);
    y = kvGrid(doc, y, [['Name', l.tenantName], ['Phone', l.tenantPhone], ['Email', l.tenantEmail], ['Occupation', [l.tenantOccupation, l.tenantCompany].filter(Boolean).join(' · ')], ['Occupants', l.occupants], ['Permanent address', l.tenantAddress], ...(mode === 'full' ? [['ID presented', [l.tenantIdType, l.tenantIdNo].filter(Boolean).join(' ')], ['Emergency contact', [l.emergencyName, l.emergencyPhone].filter(Boolean).join(' · ')]] : [])], ctx);
  }
  if (mode !== 'owner') {
    y = section(doc, y, 'Owner (lessor)', ctx);
    y = kvGrid(doc, y, mode === 'tenant' ? [['Name', l.ownerName], ['Managed by', 'GLRA Realty']] : [['Name', l.ownerName], ['Phone', l.ownerPhone], ['Email', l.ownerEmail], ['Address', l.ownerAddress], ['Rent collection', l.managedByGLRA ? `GLRA collects, ${l.managementFeePct || 0}% management fee` : 'Owner collects directly']], ctx);
  }

  // Terms
  y = section(doc, y, 'Lease terms', ctx);
  const termPairs = [['Term', c.start ? `${H.fmtDate(c.start)} to ${H.fmtDate(c.end)} (${c.termMonths} months)` : ''], ['Monthly rent', l.monthlyRent ? H.peso(l.monthlyRent) : ''], ['Rent due', l.dueDay ? `Every ${H.ordinal(l.dueDay)} of the month` : ''], ['Grace period', l.graceDays ? `${l.graceDays} days` : 'None'], ['Yearly escalation', l.escalationPct ? `${l.escalationPct}%` : 'None'], ['Security deposit', l.depositAmount ? `${H.peso(l.depositAmount)} (${l.depositMonths} month${l.depositMonths === 1 ? '' : 's'})` : ''], ['Advance rent', l.advanceAmount ? `${H.peso(l.advanceAmount)} (${l.advanceMonths} month${l.advanceMonths === 1 ? '' : 's'})` : ''], ['Late fee', l.lateFeeType === 'percent' ? `${l.lateFeeValue}% of rent` : l.lateFeeType === 'fixed' ? H.peso(l.lateFeeValue) : 'None'], ['Association dues', l.duesPaidBy ? `Paid by ${l.duesPaidBy}` : ''], ['Pets', l.petsAllowed ? 'Allowed' : 'Not allowed'], ['Total contract value', c.contractValue ? H.peso(c.contractValue) : '']];
  if (mode === 'full') termPairs.push(['Broker’s fee', c.brokerFee ? `${H.peso(c.brokerFee)} · paid by ${l.brokerFeePaidBy}${l.brokerFeeCollected ? ` · ${H.peso(l.brokerFeeCollected)} collected` : ''}` : 'None'], ['Move-in', l.moveInDate ? fd(H, l.moveInDate) : ''], ['Move-out', l.moveOutDate ? fd(H, l.moveOutDate) : '']);
  y = kvGrid(doc, y, termPairs, ctx);

  // Schedule
  y = section(doc, y, 'Rent schedule', ctx);
  y = table(doc, y, [
    { key: 'label', label: 'Period', w: 64, strong: true },
    { key: 'range', label: 'Covers', fmt: r => covers(H, r) },
    { key: 'due', label: 'Due date', w: 72, fmt: r => H.fmtDate(r.due) },
    { key: 'amount', label: 'Rent', w: 64, align: 'right', fmt: r => H.peso(r.amount) },
    { key: 'paid', label: 'Paid', w: 64, align: 'right', fmt: r => r.paid ? H.peso(r.paid) : '—' },
    { key: 'remaining', label: 'Balance', w: 64, align: 'right', fmt: r => r.remaining ? H.peso(r.remaining) : '—', color: r => r.status === 'overdue' ? BAD : INK },
    { key: 'status', label: 'Status', w: 72, fmt: r => statusText(r.status), pill: r => statusColor(r.status) }
  ], c.schedule, ctx, { empty: 'No schedule yet — set the start date, term and monthly rent.', totals: c.schedule.length ? { label: 'Total', amount: H.peso(c.contractValue), paid: H.peso(c.schedule.reduce((t, r) => t + r.paid, 0)), remaining: H.peso(c.schedule.reduce((t, r) => t + r.remaining, 0)) } : null });

  if (c.charges.length) {
    y = section(doc, y, 'Other charges', ctx);
    y = table(doc, y, [
      { key: 'date', label: 'Date', w: 72, fmt: r => H.fmtDate(r.date) },
      { key: 'label', label: 'Charge', strong: true },
      { key: 'kind', label: 'Type', w: 70, fmt: r => ({ dues: 'Assoc. dues', utilities: 'Utilities', penalty: 'Penalty', repair: 'Repair', other: 'Other' })[r.kind] || r.kind },
      { key: 'amount', label: 'Amount', w: 68, align: 'right', fmt: r => H.peso(r.amount) },
      { key: 'paid', label: 'Paid', w: 68, align: 'right', fmt: r => r.paid ? H.peso(r.paid) : '—' },
      { key: 'status', label: 'Status', w: 72, fmt: r => statusText(r.status), pill: r => statusColor(r.status) }
    ], c.charges, ctx);
  }

  // Payments
  y = section(doc, y, 'Payments received', ctx);
  const pays = [...(l.payments || [])].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  y = table(doc, y, [
    { key: 'date', label: 'Date', w: 78, fmt: r => fd(H, r.date) },
    { key: 'receiptNo', label: 'Receipt', w: 84, strong: true },
    { key: 'kind', label: 'For', fmt: r => H.kindLabel(r.kind) + (r.forPeriod ? ` · ${H.fmtMonth(r.forPeriod)}` : '') },
    { key: 'mode', label: 'Mode / reference', w: 120, fmt: r => [r.mode, r.reference].filter(Boolean).join(' · ') },
    { key: 'amount', label: 'Amount', w: 80, align: 'right', fmt: r => H.peso(r.amount) }
  ], pays, ctx, { empty: 'No payments recorded yet.', totals: pays.length ? { mode: 'Total received', amount: H.peso(c.credits.total) } : null });

  // Deposit account
  if (c.deposit.status !== 'none') {
    y = section(doc, y, 'Security deposit account', ctx);
    y = kvGrid(doc, y, [['Required', H.peso(c.deposit.required)], ['Received', H.peso(c.deposit.paid)], ['Deductions', c.deposit.deductions ? H.peso(c.deposit.deductions) : 'None'], ['Refunded', c.deposit.refunded ? `${H.peso(c.deposit.refunded)}${l.depositRefundDate ? ' on ' + fd(H, l.depositRefundDate) : ''}` : 'Not yet'], ['Currently held', H.peso(c.deposit.held)], ['Status', { unpaid: 'Not yet received', partial: 'Partially received', held: 'Held in full', settled: 'Settled' }[c.deposit.status]]], ctx, 3);
    if ((l.depositDeductions || []).length) {
      y = table(doc, y, [{ key: 'label', label: 'Deduction at move-out' }, { key: 'amount', label: 'Amount', w: 90, align: 'right', fmt: r => H.peso(r.amount) }], l.depositDeductions, ctx);
    }
  }

  // Owner remittance
  if (mode === 'owner' && l.managedByGLRA) {
    y = section(doc, y, 'Remittance summary', ctx);
    const fee = Math.round(c.credits.rent * (Number(l.managementFeePct) || 0)) / 100;
    y = kvGrid(doc, y, [['Rent collected to date', H.peso(c.credits.rent)], [`Management fee (${l.managementFeePct || 0}%)`, H.peso(fee)], ['Net due to owner', H.peso(c.credits.rent - fee)], ['Deposit held in trust', H.peso(c.deposit.held)]], ctx, 4);
  }

  // Internal trail (full profile only)
  if (mode === 'full') {
    if ((l.files || []).length) {
      y = section(doc, y, 'Documents on file', ctx);
      y = table(doc, y, [{ key: 'label', label: 'Document', w: 150, strong: true }, { key: 'name', label: 'File' }, { key: 'uploadedAt', label: 'Added', w: 78, fmt: r => fd(H, r.uploadedAt) }, { key: 'uploadedByName', label: 'By', w: 90 }], l.files, ctx);
    }
    const trail = [...(l.notes || [])].slice(-20).reverse();
    if (trail.length) {
      y = section(doc, y, 'Activity', ctx);
      y = table(doc, y, [{ key: 'at', label: 'When', w: 78, fmt: r => fd(H, r.at) }, { key: 'kind', label: 'Type', w: 58, fmt: r => r.kind }, { key: 'text', label: 'Entry' }, { key: 'byName', label: 'By', w: 90 }], trail, ctx);
    }
    if (l.remarks) { y = section(doc, y, 'Remarks', ctx); y = ensure(doc, y, 30, ctx.title); sans(doc, 8.8).text(l.remarks, M, y, { width: W(doc) - 2 * M }); y += doc.heightOfString(l.remarks, { width: W(doc) - 2 * M }) + 8; }
  }

  y = note(doc, y + 4, mode === 'tenant'
    ? `Figures are computed from payments recorded by GLRA Realty as of ${H.fmtDate(c.today)}. Payments are applied to the oldest unpaid rent first. If anything here does not match your records, please reply within seven days with your proof of payment so we can correct your ledger. This statement is not a demand letter.`
    : mode === 'owner'
      ? `Figures are computed from payments recorded by GLRA Realty as of ${H.fmtDate(c.today)}. The security deposit is held in trust for the tenant and is not income. Prepared for the property owner; please keep confidential.`
      : `Internal lease profile generated ${H.fmtDate(c.today)}. Contains personal data of the tenant and owner — for GLRA Realty staff only. Do not forward.`, ctx);

  y = ensure(doc, y, 60, ctx.title);
  label(doc, M, y + 6, 'Prepared by');
  rule(doc, y + 40, 0.8, INK, M, M + 190);
  semi(doc, 9).text(BROKER.name, M, y + 44, { lineBreak: false });
  mono(doc, 6.5, GRAY).text(`${BROKER.title} · GLRA Realty`, M, y + 56, { lineBreak: false });
  if (mode === 'tenant') {
    label(doc, W(doc) / 2 + 20, y + 6, 'Received by (tenant)');
    rule(doc, y + 40, 0.8, INK, W(doc) / 2 + 20, W(doc) - M);
    mono(doc, 6.5, GRAY).text('Signature over printed name · date', W(doc) / 2 + 20, y + 44, { lineBreak: false });
  }

  footers(doc);
  return toBuffer(doc);
}

// ── ACKNOWLEDGEMENT RECEIPT (A5 landscape) ─────────────────
async function receiptPdf(l, p, c, H) {
  const doc = newDoc({ size: 'A5', layout: 'landscape', title: `Receipt ${p.receiptNo || ''}` });
  const w = W(doc);
  doc.save().rect(0, 0, w, 58).fill(INK).restore();
  doc.save().rect(0, 58, w, 3).fill(HOT).restore();
  bold(doc, 18, WHITE).text('GLRA REALTY', M, 18, { characterSpacing: -0.6, lineBreak: false });
  mono(doc, 6.5, HOT).text('PREMIER REAL ESTATE · MANILA', M, 40, { characterSpacing: 2, lineBreak: false });
  monoB(doc, 9, WHITE).text('ACKNOWLEDGEMENT RECEIPT', w / 2, 20, { width: w / 2 - M, align: 'right', characterSpacing: 2, lineBreak: false });
  bold(doc, 13, HOT).text(p.receiptNo || '', w / 2, 34, { width: w / 2 - M, align: 'right', lineBreak: false });

  let y = 78;
  label(doc, M, y, 'Date'); sans(doc, 10).text(fd(H, p.date) || '\u2014', M, y + 10, { lineBreak: false });
  label(doc, w / 2, y, 'Amount received', { width: w / 2 - M, align: 'right' });
  bold(doc, 20).text(H.peso(p.amount), w / 2, y + 8, { width: w / 2 - M, align: 'right', lineBreak: false });
  y += 40;
  label(doc, M, y, 'Received from'); bold(doc, 12).text(l.tenantName || '—', M, y + 10, { width: w - 2 * M, lineBreak: false });
  y += 32;
  label(doc, M, y, 'The sum of'); semi(doc, 9.5).text(amountInWords(Number(p.amount) || 0), M, y + 10, { width: w - 2 * M });
  y += 30;
  const purpose = `${H.kindLabel(p.kind)}${p.forPeriod ? ' for ' + H.fmtMonth(p.forPeriod) : ''} — lease of ${[l.propertyTitle, l.unit].filter(Boolean).join(' ') || 'the premises'}${l.address ? ', ' + l.address : ''}`;
  label(doc, M, y, 'As payment for'); sans(doc, 9.5).text(purpose, M, y + 10, { width: w - 2 * M });
  y += 12 + doc.heightOfString(purpose, { width: w - 2 * M }) + 8;
  const cw = (w - 2 * M) / 3;
  label(doc, M, y, 'Mode'); sans(doc, 9.5).text(p.mode || '—', M, y + 10, { lineBreak: false });
  label(doc, M + cw, y, 'Reference'); sans(doc, 9.5).text(p.reference || '—', M + cw, y + 10, { width: cw - 8, lineBreak: false });
  label(doc, M + 2 * cw, y, 'Balance after this payment'); semi(doc, 9.5, c.balance > 0 ? BAD : OK).text(c.balance > 0 ? `${H.peso(c.balance)} still due` : c.balance < 0 ? `${H.peso(-c.balance)} credit` : 'Fully paid to date', M + 2 * cw, y + 10, { width: cw, lineBreak: false });
  y += 34;
  if (p.note) { label(doc, M, y, 'Note'); sans(doc, 8.5, GRAY).text(p.note, M, y + 10, { width: w - 2 * M }); y += 12 + doc.heightOfString(p.note, { width: w - 2 * M }) + 6; }

  const sy = Hh(doc) - M - 58;
  rule(doc, sy + 26, 0.8, INK, w / 2 + 10, w - M);
  label(doc, w / 2 + 10, sy + 30, 'Received by');
  semi(doc, 8.5).text(BROKER.name, w / 2 + 10, sy + 40, { lineBreak: false });
  mono(doc, 6.2, GRAY).text(`${BROKER.title} · GLRA Realty`, w / 2 + 10, sy + 51, { lineBreak: false });
  sans(doc, 6.6, GRAY).text('Issued by GLRA Realty on behalf of the lessor as proof that the amount above was received. This is an acknowledgement receipt, not a BIR official receipt. Keep it with your lease records.', M, sy + 26, { width: w / 2 - 60, lineGap: 1 });
  rule(doc, Hh(doc) - 22, 1.2, INK);
  mono(doc, 6, GRAY).text(`${BROKER.phone} · ${BROKER.email} · ${BROKER.site}`, M, Hh(doc) - 16, { lineBreak: false });
  return toBuffer(doc);
}

// ── RENT ROLL (A4 landscape) ───────────────────────────────
async function rentRollPdf(roll, H) {
  const ctx = { title: `Rent roll — ${H.fmtMonth(roll.month)}` };
  const doc = newDoc({ layout: 'landscape', title: ctx.title });
  let y = letterhead(doc, 'Rent roll', [H.fmtMonth(roll.month), `${roll.rows.length} lease${roll.rows.length === 1 ? '' : 's'}`]);
  const t = roll.totals;
  y = statCards(doc, y, [
    { label: 'Expected this month', value: H.peso(t.expected) },
    { label: 'Collected', value: H.peso(t.collected), color: OK, accent: OK, sub: `${t.rate}% collection rate` },
    { label: 'Outstanding', value: H.peso(t.outstanding), color: t.outstanding > 0 ? WARN : INK },
    { label: 'Overdue', value: H.peso(t.overdue), color: t.overdue > 0 ? BAD : INK, accent: t.overdue > 0 ? BAD : null, sub: t.overdueCount ? `${t.overdueCount} lease${t.overdueCount === 1 ? '' : 's'}` : '' },
    { label: 'Management fees', value: H.peso(t.managementFees), sub: t.managedCollected ? `on ${H.peso(t.managedCollected)} managed rent` : 'no GLRA-managed units' }
  ], ctx);
  y = table(doc, y, [
    { key: 'tenantName', label: 'Tenant', strong: true, fmt: r => r.tenantName || 'No tenant' },
    { key: 'propertyTitle', label: 'Property', fmt: r => [r.propertyTitle, r.unit].filter(Boolean).join(' · ') },
    { key: 'ownerName', label: 'Owner', w: 110 },
    { key: 'due', label: 'Due', w: 74, fmt: r => r.due ? H.fmtDate(r.due) : '—' },
    { key: 'rent', label: 'Rent', w: 76, align: 'right', fmt: r => r.rent ? H.peso(r.rent) : '—' },
    { key: 'charges', label: 'Charges', w: 70, align: 'right', fmt: r => r.charges ? H.peso(r.charges) : '—' },
    { key: 'collected', label: 'Collected', w: 76, align: 'right', fmt: r => r.collected ? H.peso(r.collected) : '—', color: () => OK },
    { key: 'bal', label: 'Balance', w: 76, align: 'right', fmt: r => (r.expected - r.collected) > 0.005 ? H.peso(r.expected - r.collected) : '—', color: r => r.status === 'overdue' ? BAD : INK },
    { key: 'status', label: 'Status', w: 76, fmt: r => statusText(r.status), pill: r => statusColor(r.status) }
  ], roll.rows, ctx, { empty: 'No rent falls due this month.', totals: roll.rows.length ? { ownerName: 'Totals', rent: H.peso(roll.rows.reduce((s, r) => s + r.rent, 0)), charges: H.peso(roll.rows.reduce((s, r) => s + r.charges, 0)), collected: H.peso(t.collected), bal: H.peso(t.outstanding) } : null });
  y = note(doc, y, `Generated ${H.fmtDate(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10))} from the GLRA Realty leasing ledger. Payments are applied to the oldest unpaid rent first, so a month shows as paid only once every earlier month is settled. Internal document.`, ctx);
  footers(doc);
  return toBuffer(doc);
}

module.exports = { leasePdf, receiptPdf, rentRollPdf, _test: { amountInWords } };
