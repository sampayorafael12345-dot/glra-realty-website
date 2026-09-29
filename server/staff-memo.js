// =============================================================================
// ONE-TIME NOTES TO THE STAFF MEMBER (Staff tab messages)
// =============================================================================
// 30 Sept 2026: Rafael asked for the listing problems found by comparing the
// GLRA Management System sheet with the live website to go straight to
// Bladimir's desk. Each note is delivered once (Setting 'staff_memo_<id>');
// if Bladimir has no account yet it is tried again on the next start.
// Listing ids are the live website's.
// =============================================================================
const { Setting, Account, StaffMessage, Property } = require('./db');

const MEMOS = [{
  id: '2026-09-30-excel-vs-website',
  fromName: 'Rafael (listing check)',
  notes: [
    { kind: 'warning', text: 'Welcome to the new Staff desk. From today, please:\n1. Time in when you start and time out when you finish. Use the status buttons (break, lunch, field work) when you are away.\n2. Log every post on the Posting board with the link to the post. The link is the proof; a post without a link does not count.\n3. Log every call, Viber, WhatsApp or text to a lead on their card in the Leads tab.\n4. Press "Got it" on every note here, and reply if something is unclear.\nYour daily targets and your progress are at the top of My desk. Ma\'am and Rafael can see your time in, your active time in the dashboard, and everything you record here.' },
    { kind: 'fix', propertyId: '69d6a3ac715495760095e341', text: 'VERVE RESIDENCES 1 (BGC): the Excel sheet says LEASED, but the website still shows it as available. Confirm with the owner. If it is leased, mark it Leased on the website; if it is available again, change the sheet.' },
    { kind: 'fix', propertyId: '69d6a39e715495760095e311', text: 'GENTRY RESIDENCES (Salcedo Village): the Excel sheet says LEASED, but the website still shows it as available. Confirm and correct whichever one is wrong.' },
    { kind: 'fix', propertyId: '69d6a39f715495760095e315', text: 'BRGY. HIGHWAY HILLS (Mandaluyong): the price is ₱52,000,000 in the Excel sheet but ₱65,000,000 on the website. Ask Ma\'am or the owner which is right and correct the other.' },
    { kind: 'fix', propertyId: '6aa11a1cbaa67ea66506fb3d', text: 'GRACE RESIDENCES - TOWER B: the price is ₱2,750,000 in the Excel sheet but ₱3,000,000 on the website. Check which is right and correct the other.' },
    { kind: 'fix', propertyId: '6a70310f54071ca036192305', text: 'VICTORIA PLACE PASIG RESIDENTIAL LOT: the price is ₱51,084,000 in the Excel sheet but ₱47,500,000 on the website. Check which is right and correct the other.' },
    { kind: 'fix', propertyId: '69d6a39b715495760095e307', text: 'ETON RESIDENCES: this listing is live on the website, but the Excel sheet marks it "Inc. Info" (incomplete). On the website it has no floor area and the rent of ₱40,000 is also typed in the SALE price box. Complete the details (floor area, bedrooms, photos) and clear the sale price, or unpublish it until it is complete.' },
    { kind: 'fix', propertyId: '6aba266fb641f59bc8deead0', text: 'ROYAL PALM RESIDENCES (Rawai bldg): the Excel sheet lists it FOR SALE AND LEASE but the website only shows it for sale, and the sheet has no price. Add the monthly rent on the website if it is also for lease, and put the price in the sheet.' },
    { kind: 'fix', propertyId: '6abb4ad77c2a631c4d08a275', text: 'THE COLUMNS TOWER 1: two listings on the website are exactly the same (₱7,500,000, 38 sqm, same title). If they are two different units, make the titles different (floor or unit type) and check both have their own photos. If it is the same unit twice, tell Ma\'am so one can be removed.' },
    { kind: 'fix', text: 'Marked AVAILABLE in the Excel sheet but NOT on the website. Upload each one (photos, price, floor/lot area, description), or change the sheet if they are no longer available:\n- Kingstown 2 Subd., Caloocan (₱3,500,000, for sale)\n- Benitez Courtyard, San Juan (₱33,395,000, for sale)\n- Benitez Courtyard, San Juan (₱29,145,000, for sale)\n- Pacific Plaza Towers, BGC (₱90,000,000, for sale)\n- The Red Oak at Two Serendra, Taguig (₱8,000,000, for sale)\n- One Eastwood Tower 2, Quezon City: the 69 sqm unit FOR SALE (₱15,000,000); only the rental is on the website\n- Vista Pointe Katipunan, Quezon City (₱35,000/month)\n- Prime C6 Road, Taguig (for lease; the sheet has no price)\n- Lot in Pasig, Tapuac, Masinloc, Zambales (₱5,963,000; the owner signed the Authority to Sell on 29 May)' },
    { kind: 'fix', text: 'The Excel sheet is out of date: about 27 rows for listings that ARE on the website are not ticked in the WS (website) column, and the 2-storey house on the 8,786 sqm orchard lot (₱76,000,000) is on the website but not in the sheet at all. From now on, the Posting board in this tab is where posts are recorded; please still keep the sheet correct for Ma\'am.' }
  ]
}];

async function deliverStaffMemos() {
  try {
    const staff = await Account.find({ role: 'employee', isActive: { $ne: false }, status: { $ne: 'pending' } }).select('name email').lean();
    const to = staff.find(a => /bladimir/i.test(`${a.name} ${a.email}`)) || (staff.length === 1 ? staff[0] : null);
    if (!to) return;
    const from = await Account.findOne({ role: 'admin' }).select('_id').lean();
    for (const memo of MEMOS) {
      const key = 'staff_memo_' + memo.id;
      if (await Setting.exists({ key })) continue;
      for (const n of memo.notes) {
        // A listing removed since the check: keep the note, drop the link.
        const propertyId = n.propertyId && (await Property.exists({ _id: n.propertyId })) ? n.propertyId : null;
        await StaffMessage.create({ to: to._id, from: from ? from._id : null, fromName: memo.fromName, kind: n.kind, text: n.text, propertyId });
      }
      await Setting.create({ key, value: { to: String(to._id), at: new Date(), n: memo.notes.length } });
      console.log(`Staff memo ${memo.id}: ${memo.notes.length} notes to ${to.name || to.email}`);
    }
  } catch (e) { console.error('staff memo:', e.message); }
}

module.exports = { deliverStaffMemos };
