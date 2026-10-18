// The Today sheet: a one-page PDF pushed to the tablet each morning, so the loop closes where he writes.
// Sized to the reMarkable 3:4 aspect. Item numbers are large so "✓14" in today's notebook page is easy.
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { paths, config, localWeekday, fmtTime } from '../config.js';

const FONT_DIR = '/usr/share/fonts/truetype/dejavu';
const hasDejaVu = fs.existsSync(path.join(FONT_DIR, 'DejaVuSans.ttf'));
const BOX = hasDejaVu ? '☐' : '[ ]';

export async function buildTodaySheet({ today, plan, top, b }) {
  const file = path.join(paths.out, `${config.notify.tabletTodayName}.pdf`);
  const doc = new PDFDocument({ size: [445, 594], margins: { top: 28, bottom: 24, left: 30, right: 30 } });
  if (hasDejaVu) {
    doc.registerFont('R', path.join(FONT_DIR, 'DejaVuSans.ttf'));
    doc.registerFont('B', path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));
  }
  const R = hasDejaVu ? 'R' : 'Helvetica', B = hasDejaVu ? 'B' : 'Helvetica-Bold';
  const out = fs.createWriteStream(file);
  doc.pipe(out);

  const w = 445 - 60;
  doc.font(B).fontSize(17).text(`${localWeekday()} · ${today}`);
  doc.moveDown(0.3).font(R).fontSize(10).fillColor('#333').text(plan.headline, { width: w });
  doc.fillColor('black');

  const section = (title, items, note) => {
    if (!items.length) return;
    if (doc.y > 520) return; // keep to one page; the full list lives in open-loops.md
    doc.moveDown(0.7).font(B).fontSize(11).text(title.toUpperCase(), { characterSpacing: 0.6 });
    if (note) doc.font(R).fontSize(8.5).fillColor('#444').text(note, { width: w }).fillColor('black');
    for (const i of items) {
      if (doc.y > 540) { doc.font(R).fontSize(8.5).text('… more in open loops'); break; }
      const y = doc.y + 3;
      doc.font(B).fontSize(13).text(String(i.code), 30, y, { width: 34, align: 'right' });
      const meta = [i.person, i.assignee ? `@${i.assignee}` : null, i.due ? `due ${i.due}${i.due_time ? ` ${fmtTime(i.due_time)}` : ''}` : null,
        i.carry_days > 1 ? `${i.carry_days}d` : null].filter(Boolean).join(' · ');
      doc.font(R).fontSize(10.5).text(`${BOX} ${i.text}`, 72, y + 1, { width: w - 42 });
      if (meta || i.why) doc.font(R).fontSize(8).fillColor('#555').text([meta, i.why].filter(Boolean).join(' — '), 84, doc.y, { width: w - 54 }).fillColor('black');
      doc.x = 30;
    }
  };

  section('Top 3', top);
  const shown = new Set(top.map((t) => t.code));
  const fresh = (list) => list.filter((i) => !shown.has(i.code) && shown.add(i.code));
  section('Overdue', fresh(b.overdue));
  section('Due today', fresh(b.dueToday));
  section('Waiting on', fresh(b.waiting).slice(0, 5));
  section('Carrying', fresh(b.carrying).slice(0, 4), plan.carrying_callout || 'Rewritten for days — do it, delegate it, or drop it.');

  doc.font(R).fontSize(8).fillColor('#555').text(
    `${b.items.length} open. In today's notebook page write: ✓14 done · x14 drop · 14 → Fri snooze`.replace(/✓/g, hasDejaVu ? '✓' : 'done:'),
    30, 594 - 40, { width: w, align: 'center' });
  doc.end();
  await new Promise((r) => out.on('finish', r));
  return file;
}
