// =============================================================================
// EMAIL TEMPLATES — shared header + footer
// =============================================================================
// Brutalist email shell — used by every transactional message (inquiries,
// subscriber welcome, wishlist confirmations, price alerts, submissions, etc.).
// Update here once → every email rebrands at the same time.
//
// Each transactional email is composed as:
//   getEmailHeader() + "<body content>" + getEmailFooter()
// so callers only need to write the middle piece.
// =============================================================================

function getEmailHeader() {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GLRA Realty</title></head>
    <body style="margin:0;padding:0;background-color:#e8e4dd;font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#0a0a0a">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#e8e4dd">
        <tr><td align="center" style="padding:30px 16px">
          <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:#f1eee9;border:2px solid #0a0a0a;border-collapse:collapse">
            <tr><td style="background-color:#0a0a0a;padding:24px 28px;border-bottom:4px solid #ff3d00">
              <div style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:-1.5px;color:#ffffff;text-transform:uppercase;line-height:1">GLRA REALTY</div>
              <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;color:#ff3d00;text-transform:uppercase;margin-top:6px;font-weight:700">Premier Real Estate · Manila</div>
            </td></tr>
            <tr><td style="padding:32px 28px 8px;color:#0a0a0a;font-size:15px;line-height:1.65">
  `;
}

function getEmailFooter() {
  return `
            </td></tr>
            <tr><td style="padding:0 28px 28px">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;border-top:2px solid #0a0a0a;padding-top:18px">
                <tr><td>
                  <div style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#0a0a0a;margin-bottom:4px;text-transform:uppercase;letter-spacing:-.2px">Catherine SB Sampayo</div>
                  <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:1.5px;color:#6a6a6a;text-transform:uppercase;font-weight:700;margin-bottom:14px">Licensed Real Estate Broker · GLRA Realty</div>
                  <div style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.8;color:#0a0a0a">
                    📞 <a href="tel:+639171774572" style="color:#0a0a0a;text-decoration:none;font-weight:600">+63 917 177 4572</a><br>
                    ✉️ <a href="mailto:glrarealty@gmail.com" style="color:#0a0a0a;text-decoration:none;font-weight:600">glrarealty@gmail.com</a><br>
                    🌐 <a href="https://glrarealty.com" style="color:#0a0a0a;text-decoration:none;font-weight:600">glrarealty.com</a><br>
                    📍 17th Floor, 252 Senator Gil J. Puyat Avenue, Makati City, Philippines 1200
                  </div>
                </td></tr>
              </table>
            </td></tr>
            <tr><td style="background-color:#0a0a0a;color:#f1eee9;padding:16px 28px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700">
              <a href="https://glrarealty.com" style="color:#ff3d00;text-decoration:none">glrarealty.com</a>
              &nbsp;·&nbsp;
              Reply to this email to reach Catherine directly
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;
}

module.exports = { getEmailHeader, getEmailFooter };
