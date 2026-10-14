// =============================================================================
// GLRA SOCIAL — the weekly report: an email and a PDF (pdfkit)
// =============================================================================
// Built from social.js buildReport(): per Page reach, followers, posts, top
// posts with thumbnails, leads that came in through post links, reply speed,
// and three "what to do next week" suggestions.
// =============================================================================
'use strict';
const path = require('path');
const PDFDocument = require('pdfkit');
const { getEmailHeader, getEmailFooter } = require('./email-templates');

const FONTS = {
  sans: path.join(__dirname, 'fonts', 'Inter-Regular.ttf'),
  semi: path.join(__dirname, 'fonts', 'Inter-SemiBold.ttf'),
  bold: path.join(__dirname, 'fonts', 'Inter-Bold.ttf')
};
const INK = '#141414', GRAY = '#666666', RULE = '#e5e1da', HOT = '#de3500', SOFT = '#f6f3ee';
const n = v => v == null ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
const signed = v => v == null ? '' : (v > 0 ? '+' : '') + n(v);
const speedText = m => m == null ? '–' : m < 60 ? Math.round(m) + ' min' : (Math.round(m / 6) / 10) + ' h';
const short = (s, k) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > k ? t.slice(0, k - 1) + '…' : t; };

// Sparkline as inline SVG is not safe in email clients, so the email uses a
// row of small bars made of table cells.
function bars(series, color) {
  const v = (series || []).filter(x => x != null).slice(-14);
  if (v.length < 2) return '';
  const max = Math.max(...v, 1);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;height:34px"><tr style="vertical-align:bottom">${v.map(x => `<td style="padding:0 1px"><div style="width:8px;height:${Math.max(2, Math.round(x / max * 32))}px;background:${color};border-radius:2px"></div></td>`).join('')}</tr></table>`;
}

function reportHtml(d, esc) {
  const card = p => `
    <div style="border:1px solid ${RULE};border-radius:14px;padding:16px 18px;margin:0 0 14px">
      <div style="font:700 16px Inter,Helvetica,Arial,sans-serif;margin:0 0 2px"><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:${esc(p.color)};margin-right:6px"></span>${esc(p.name)}</div>
      <div style="font-size:12px;color:${GRAY};margin:0 0 10px">${p.igUsername ? 'Facebook + Instagram @' + esc(p.igUsername) : 'Facebook'}</div>
      <table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="padding:4px 0;color:${GRAY}">Facebook reach</td><td style="text-align:right;font-weight:700">${n(p.fbReach)}</td><td rowspan="3" style="width:150px;padding-left:12px">${bars(p.reachSeries, esc(p.color))}</td></tr>
        <tr><td style="padding:4px 0;color:${GRAY}">Facebook followers</td><td style="text-align:right;font-weight:700">${n(p.fbFollowers)} <span style="color:#0a7551;font-weight:600">${p.fbNew != null ? '+' + n(p.fbNew) : ''}</span></td></tr>
        <tr><td style="padding:4px 0;color:${GRAY}">Instagram reach / followers</td><td style="text-align:right;font-weight:700">${n(p.igReach)} / ${n(p.igFollowers)}</td></tr>
        <tr><td style="padding:4px 0;color:${GRAY}">Posts (FB / IG)</td><td style="text-align:right;font-weight:700">${n(p.posts.fb)} / ${n(p.posts.ig)}</td><td></td></tr>
        <tr><td style="padding:4px 0;color:${GRAY}">Leads from post links</td><td style="text-align:right;font-weight:700;color:${HOT}">${n(p.leads)}</td><td></td></tr>
        <tr><td style="padding:4px 0;color:${GRAY}">Unanswered now</td><td style="text-align:right;font-weight:700">${n(p.unanswered)}</td><td></td></tr>
      </table>
      ${p.top.length ? `<div style="font:700 12px Inter,Helvetica,Arial,sans-serif;margin:12px 0 6px;color:${GRAY};text-transform:uppercase;letter-spacing:.06em">Top posts</div>
      ${p.top.map(t => `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 8px"><tr>
        <td style="width:56px;vertical-align:top">${t.thumb ? `<img src="${esc(t.thumb)}" width="52" height="52" style="border-radius:8px;object-fit:cover;display:block" alt="">` : `<div style="width:52px;height:52px;border-radius:8px;background:${SOFT}"></div>`}</td>
        <td style="vertical-align:top;font-size:13px;padding-left:8px">${t.permalink ? `<a href="${esc(t.permalink)}" style="color:${INK};text-decoration:none">` : ''}${esc(short(t.text, 110) || '(no text)')}${t.permalink ? '</a>' : ''}
          <div style="font-size:12px;color:${GRAY};margin-top:3px">${t.network === 'ig' ? 'Instagram' : 'Facebook'} · ${n(t.engagement)} engagement${t.reach != null ? ' · ' + n(t.reach) + ' reached' : ''}${t.leads ? ` · <b style="color:${HOT}">${n(t.leads)} lead(s)</b>` : ''}</div></td></tr></table>`).join('')}` : ''}
    </div>`;
  return getEmailHeader() + `
    <h2 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:21px;margin:0 0 4px">Your Pages last week</h2>
    <p style="font-size:13px;color:${GRAY};margin:0 0 16px">${esc(d.from)} to ${esc(d.to)} · GLRA Social</p>
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 16px"><tr>
      <td style="background:${SOFT};border-radius:12px;padding:12px 14px"><div style="font-size:12px;color:${GRAY}">Leads from posts</div><div style="font:800 22px Inter,Helvetica,Arial,sans-serif;color:${HOT}">${n(d.leads)}</div></td>
      <td style="background:${SOFT};border-radius:12px;padding:12px 14px"><div style="font-size:12px;color:${GRAY}">Median first reply</div><div style="font:800 22px Inter,Helvetica,Arial,sans-serif">${speedText(d.replySpeed.medianMin)}</div></td>
      <td style="background:${SOFT};border-radius:12px;padding:12px 14px"><div style="font-size:12px;color:${GRAY}">Conversations</div><div style="font:800 22px Inter,Helvetica,Arial,sans-serif">${n(d.replySpeed.threads)}</div></td>
    </tr></table>
    ${d.pages.map(card).join('')}
    <div style="background:#fff6f1;border-radius:14px;padding:14px 18px;margin:6px 0 14px">
      <div style="font:700 15px Inter,Helvetica,Arial,sans-serif;margin:0 0 6px">What to do next week</div>
      <ol style="margin:0;padding-left:20px;font-size:13.5px;line-height:1.6">${d.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
    </div>
    <p style="font-size:12px;color:#777">Reach is Meta's estimate added up day by day (a person reached on two days counts twice) and lags 1 to 2 days. Leads count people whose first visit came through a post link. The PDF is attached.</p>
    <p><a href="https://glrarealty.com/social.html#insights" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600">Open Insights</a></p>` + getEmailFooter();
}

async function fetchImage(url) {
  if (!/^https:\/\//.test(String(url || ''))) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok || !/^image\/(jpeg|png)/.test(r.headers.get('content-type') || '')) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length < 4 * 1024 * 1024 ? b : null;
  } catch (e) { return null; }
}

async function reportPdf(d) {
  const thumbs = {};
  for (const p of d.pages) for (const t of p.top) if (t.thumb && !(t.thumb in thumbs)) thumbs[t.thumb] = await fetchImage(t.thumb.replace('/upload/', '/upload/c_fill,w_160,h_160,f_jpg/'));
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 30 }, bufferPages: true, info: { Title: `GLRA Social report ${d.from} to ${d.to}`, Author: 'GLRA Realty' } });
  Object.entries(FONTS).forEach(([k, p]) => doc.registerFont(k, p));
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  const W = doc.page.width, M = 40, CW = W - 2 * M;
  const ensure = h => { if (doc.y + h > doc.page.height - 50) doc.addPage(); };

  doc.save().rect(0, 0, W, 70).fill(INK).restore();
  doc.save().rect(0, 70, W, 4).fill(HOT).restore();
  doc.font('bold').fontSize(18).fillColor('#fff').text('GLRA Social · Weekly report', M, 22, { lineBreak: false });
  doc.font('sans').fontSize(9).fillColor('#d0d0d0').text(`${d.from} to ${d.to}`, M, 46, { lineBreak: false });
  doc.y = 92;

  // headline figures
  const kpis = [['Leads from posts', n(d.leads)], ['Median first reply', speedText(d.replySpeed.medianMin)], ['Conversations', n(d.replySpeed.threads)], ['Pages', n(d.pages.length)]];
  const kw = (CW - 3 * 10) / 4;
  kpis.forEach(([l, v], i) => {
    const x = M + i * (kw + 10);
    doc.save().roundedRect(x, doc.y, kw, 50, 8).fill(SOFT).restore();
    doc.font('sans').fontSize(8).fillColor(GRAY).text(l, x + 10, doc.y + 9, { width: kw - 20, lineBreak: false });
    doc.font('bold').fontSize(16).fillColor(i === 0 ? HOT : INK).text(v, x + 10, doc.y + 22, { width: kw - 20, lineBreak: false });
  });
  doc.y += 66;

  for (const p of d.pages) {
    ensure(250);
    const y0 = doc.y;
    doc.save().circle(M + 5, y0 + 7, 5).fill(p.color || HOT).restore();
    doc.font('bold').fontSize(13).fillColor(INK).text(p.name, M + 16, y0, { lineBreak: false });
    doc.font('sans').fontSize(8.5).fillColor(GRAY).text(p.igUsername ? 'Facebook + Instagram @' + p.igUsername : 'Facebook', M + 16, y0 + 17, { lineBreak: false });
    let y = y0 + 34;
    const rows = [['Facebook reach', n(p.fbReach)], ['Facebook followers', `${n(p.fbFollowers)} ${p.fbNew != null ? '(+' + n(p.fbNew) + ')' : ''}`], ['Instagram reach', n(p.igReach)],
      ['Instagram followers', `${n(p.igFollowers)} ${p.igNew != null ? '(+' + n(p.igNew) + ')' : ''}`], ['Posts (FB / IG)', `${n(p.posts.fb)} / ${n(p.posts.ig)}`], ['Leads from post links', n(p.leads)], ['Unanswered now', n(p.unanswered)]];
    rows.forEach(([l, v], i) => {
      doc.font('sans').fontSize(9).fillColor(GRAY).text(l, M, y, { width: 150, lineBreak: false });
      doc.font('semi').fontSize(9).fillColor(i === 5 ? HOT : INK).text(v, M + 150, y, { width: 90, align: 'right', lineBreak: false });
      y += 15;
    });
    // reach chart (bars)
    const s = (p.reachSeries || []).filter(x => x != null).slice(-14);
    const cx = M + 270, cy = y0 + 34, cw = CW - 270, ch = 95;
    doc.font('semi').fontSize(8).fillColor(GRAY).text('Facebook reach per day', cx, cy - 2, { lineBreak: false });
    doc.save().moveTo(cx, cy + ch).lineTo(cx + cw, cy + ch).lineWidth(0.6).strokeColor(RULE).stroke().restore();
    if (s.length > 1) {
      const max = Math.max(...s, 1), bw = cw / s.length;
      s.forEach((v, i) => { const h = Math.max(1.5, v / max * (ch - 18)); doc.save().roundedRect(cx + i * bw + 1.5, cy + ch - h, Math.max(2, bw - 3), h, 1.5).fill(p.color || HOT).restore(); });
      doc.font('sans').fontSize(7).fillColor(GRAY).text('max ' + n(max), cx + cw - 60, cy - 2, { width: 60, align: 'right', lineBreak: false });
    } else doc.font('sans').fontSize(8).fillColor(GRAY).text('Not enough days yet.', cx, cy + 40, { lineBreak: false });
    doc.y = Math.max(y, cy + ch) + 12;
    if (p.top.length) {
      doc.font('bold').fontSize(9).fillColor(GRAY).text('TOP POSTS', M, doc.y, { characterSpacing: 1, lineBreak: false });
      doc.y += 14;
      for (const t of p.top) {
        ensure(48);
        const ty = doc.y;
        const img = thumbs[t.thumb];
        if (img) { try { doc.image(img, M, ty, { width: 40, height: 40, cover: [40, 40] }); } catch (e) { doc.save().roundedRect(M, ty, 40, 40, 6).fill(SOFT).restore(); } }
        else doc.save().roundedRect(M, ty, 40, 40, 6).fill(SOFT).restore();
        doc.font('sans').fontSize(9).fillColor(INK).text(short(t.text, 120) || '(no text)', M + 50, ty, { width: CW - 50, height: 24, ellipsis: true });
        doc.font('sans').fontSize(8).fillColor(GRAY).text(`${t.network === 'ig' ? 'Instagram' : 'Facebook'} · ${n(t.engagement)} engagement${t.reach != null ? ' · ' + n(t.reach) + ' reached' : ''}${t.leads ? ' · ' + n(t.leads) + ' lead(s)' : ''}`, M + 50, ty + 27, { width: CW - 50, lineBreak: false });
        doc.y = ty + 48;
      }
    }
    doc.save().moveTo(M, doc.y + 2).lineTo(M + CW, doc.y + 2).lineWidth(0.6).strokeColor(RULE).stroke().restore();
    doc.y += 14;
  }
  ensure(120);
  doc.font('bold').fontSize(12).fillColor(INK).text('What to do next week', M, doc.y);
  doc.moveDown(0.4);
  d.tips.forEach((t, i) => { ensure(40); doc.font('bold').fontSize(9.5).fillColor(HOT).text(`${i + 1}.`, M, doc.y, { continued: true }).font('sans').fillColor(INK).text('  ' + t, { width: CW }); doc.moveDown(0.3); });
  doc.moveDown(0.6);
  doc.font('sans').fontSize(7.5).fillColor(GRAY).text("Reach is Meta's estimate added up day by day and lags 1 to 2 days. Leads count people whose first visit to glrarealty.com came through a link in one of these posts.", M, doc.y, { width: CW });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;   // the footer sits in the margin; this stops pdfkit opening a new page for it
    doc.font('sans').fontSize(7).fillColor(GRAY).text(`GLRA Realty · glrarealty.com · page ${i + 1} of ${range.count}`, M, doc.page.height - 24, { width: CW, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { reportHtml, reportPdf };
