// =============================================================================
// TITLING PDF: billing statement for a land-title transfer job
// =============================================================================
// Same letterhead, fonts and table kit as the lease statements (lease-pdf.js).
// Client-facing: it shows what was charged, what was received and what is
// still owed, plus where the title is in the process. It leaves out the
// internal remarks and the staff cash requests.
//
// Money rule, the same one the Titling tab uses on screen:
//   charges  = professional fee + every disbursement (government fees etc.)
//   balance  = charges - payments received
// =============================================================================
const { kit } = require('./lease-pdf');
const { newDoc, toBuffer, letterhead, footers, ensure, section, kvGrid, statCards, table, note, label, sans, semi, bold, rule, amountInWords, M, INK, HOT, GRAY, OK, BAD, W } = kit;

const STAGES = {
  documents: 'Collecting documents', bir: 'At the BIR', transfer_tax: 'Transfer tax', registry: 'Registry of Deeds',
  tax_dec: 'Assessor\'s Office (tax declaration)', completed: 'Completed', on_hold: 'On hold', lra: 'LRA'
};
const peso = n => '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = v => {
  if (!v) return '';
  const d = new Date(v); if (isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

// Numbers the PDF and the screen both rely on. Legacy records that only have
// the old govFees / amountPaid totals still produce a sensible statement.
function billingFigures(t) {
  const expenses = (t.expenses && t.expenses.length) ? t.expenses
    : (Number(t.govFees) > 0 ? [{ date: null, category: 'Government fees', payee: '', amount: Number(t.govFees) }] : []);
  const payments = (t.payments && t.payments.length) ? t.payments
    : (Number(t.amountPaid) > 0 ? [{ date: null, label: 'Payments received', amount: Number(t.amountPaid) }] : []);
  const fee = Number(t.serviceFee) || 0;
  const disb = expenses.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const received = payments.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const charges = fee + disb;
  return { expenses, payments, fee, disb, received, charges, balance: Math.round((charges - received) * 100) / 100 };
}

async function billingPdf(t) {
  const ctx = { title: 'Billing Statement' };
  const f = billingFigures(t);
  const ref = 'T-' + String(t._id || '').slice(-6).toUpperCase();
  const doc = newDoc({ title: `Billing Statement - ${t.clientName || ref}` });
  let y = letterhead(doc, ctx.title, [`Issued ${fmtDate(new Date())}`, `Ref ${ref} · ${STAGES[t.status] || t.status || ''}`]);

  // Who it is for, and what for
  label(doc, M, y, 'Billed to');
  bold(doc, 14).text(t.clientName || 'Client', M, y + 10, { lineBreak: false });
  const contact = [t.clientPhone, t.clientEmail].filter(Boolean).join(' · ');
  if (contact) sans(doc, 8, GRAY).text(contact, M, y + 28, { lineBreak: false });
  label(doc, W(doc) / 2, y, 'Service', { width: W(doc) / 2 - M, align: 'right' });
  semi(doc, 10.5).text(t.serviceType || 'Transfer of Title', W(doc) / 2, y + 11, { width: W(doc) / 2 - M, align: 'right' });
  if (t.propertyLocation) sans(doc, 8, GRAY).text(t.propertyLocation, W(doc) / 2, y + 25, { width: W(doc) / 2 - M, align: 'right' });
  y += 50;

  // Headline numbers
  const bal = f.balance;
  const balCard = bal > 0.004 ? { label: 'Balance due', value: peso(bal), color: BAD, accent: BAD, sub: 'please settle with GLRA' }
    : bal < -0.004 ? { label: 'Overpaid', value: peso(-bal), color: OK, accent: OK, sub: 'to be refunded or applied' }
    : { label: 'Balance', value: 'Fully settled', color: OK, accent: OK, sub: 'nothing further due' };
  y = statCards(doc, y, [
    { label: 'Total charges', value: peso(f.charges), sub: 'fee + government fees' },
    { label: 'Payments received', value: peso(f.received), color: OK, accent: OK, sub: `${f.payments.length} payment${f.payments.length === 1 ? '' : 's'}` },
    balCard
  ], ctx);

  // The job
  y = section(doc, y, 'The job', ctx);
  y = kvGrid(doc, y, [
    ['Mode of acquisition', t.modeOfAcquisition], ['Property type', t.propertyType], ['Title no.', t.titleNumber],
    ['Tax declaration no.', t.taxDecNo], ['Branch', t.branch], ['Target date', fmtDate(t.targetDate)]
  ], ctx, 4);

  // Charges
  y = section(doc, y, 'Charges', ctx);
  const rows = [];
  if (f.fee > 0) rows.push({ desc: 'Professional fee', payee: 'GLRA Realty', date: '', amount: f.fee });
  f.expenses.forEach(e => rows.push({ desc: e.category || 'Government fee', payee: e.payee || '', date: fmtDate(e.date), amount: Number(e.amount) || 0 }));
  y = table(doc, y, [
    { key: 'desc', label: 'Description', strong: true },
    { key: 'payee', label: 'Paid to', w: 150 },
    { key: 'date', label: 'Date', w: 80 },
    { key: 'amount', label: 'Amount', w: 90, align: 'right', fmt: r => peso(r.amount) }
  ], rows, ctx, { empty: 'No charges recorded yet.', totals: rows.length ? { desc: 'TOTAL CHARGES', amount: peso(f.charges) } : null });
  y += 0;

  // Payments
  y = section(doc, y, 'Payments received', ctx);
  y = table(doc, y, [
    { key: 'label', label: 'Payment', strong: true, fmt: p => p.label || 'Payment' },
    { key: 'date', label: 'Date', w: 110, fmt: p => fmtDate(p.date) },
    { key: 'amount', label: 'Amount', w: 110, align: 'right', fmt: p => peso(p.amount) }
  ], f.payments, ctx, { empty: 'No payments received yet.', totals: f.payments.length ? { label: 'TOTAL RECEIVED', amount: peso(f.received) } : null });
  y += 2;

  // Bottom line, boxed so it can be read at a glance
  y = ensure(doc, y, 80, ctx.title);
  const bw = 250, bx = W(doc) - M - bw;
  doc.save().rect(bx, y, bw, 70).lineWidth(1.2).strokeColor(INK).stroke().restore();
  const line = (yy, l, v, strong, color) => {
    (strong ? semi : sans)(doc, strong ? 9.5 : 9, color || INK).text(l, bx + 12, yy, { width: 130, lineBreak: false });
    (strong ? bold : sans)(doc, strong ? 12 : 9, color || INK).text(v, bx + 120, yy - (strong ? 1 : 0), { width: bw - 132, align: 'right', lineBreak: false });
  };
  line(y + 10, 'Total charges', peso(f.charges));
  line(y + 24, 'Less payments received', '− ' + peso(f.received));
  rule(doc, y + 40, 1.2, INK, bx + 12, bx + bw - 12);
  line(y + 49, bal < -0.004 ? 'Overpaid' : 'Balance due', peso(Math.abs(bal)), true, bal > 0.004 ? BAD : OK);
  if (bal > 0.004) { label(doc, M, y + 4, 'Amount due in words'); semi(doc, 9).text(amountInWords(bal), M, y + 16, { width: bx - M - 16 }); }
  y += 76;

  // Where the title is in the process
  const miles = [
    ['Endorsed to GLRA', t.dateEndorsed], ['Filed at the BIR', t.dateFiledBIR], ['CAR received', t.dateCarReceived],
    ['Transfer tax paid', t.dateTransferTax], ['Filed at the Registry of Deeds', t.dateFiledRD],
    ['New title issued', t.dateTitleTransferred], ['Filed at the Assessor\'s Office', t.dateFiledAO]
  ].filter(m => m[1]).map(m => ({ step: m[0], date: fmtDate(m[1]) }));
  if (miles.length || t.lacking) {
    y = section(doc, y, 'Progress', ctx);
    if (miles.length) y = kvGrid(doc, y, miles.map(m => [m.step, m.date]), ctx, 4);
    if (t.lacking) { y = ensure(doc, y + 6, 30, ctx.title); label(doc, M, y, 'Still needed from you'); sans(doc, 8.8).text(String(t.lacking).slice(0, 600), M, y + 10, { width: W(doc) - 2 * M }); y += 14 + doc.heightOfString(String(t.lacking).slice(0, 600), { width: W(doc) - 2 * M }); }
  }

  y = note(doc, y + 4, 'Government fees are paid to the agencies as they fall due and are charged here at cost. This is a billing statement, not a BIR official receipt. Questions about any line: reply to the email this came with, or call the number below.', ctx);
  footers(doc);
  return toBuffer(doc);
}

module.exports = { billingPdf, billingFigures };
