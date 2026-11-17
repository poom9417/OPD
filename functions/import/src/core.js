// OPD AR — import core (pure logic + db adapter). ไม่ผูกกับ Appwrite SDK เพื่อให้ทดสอบได้
import crypto from 'node:crypto';

export const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 32);
const s = (v) => (v === undefined || v === null ? '' : String(v).trim());

// DDMMYYYY (อาจขาดเลข 0 นำหน้า เช่น 1102026) -> YYYY-MM-DD
export function ddmmyyyyToIso(v) {
  const t = s(v).padStart(8, '0');
  if (!/^\d{8}$/.test(t)) return null;
  return `${t.slice(4)}-${t.slice(2, 4)}-${t.slice(0, 2)}`;
}
// MM/DD/YYYY -> YYYY-MM-DD
export function mdyToIso(v) {
  const m = s(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
export const normHn = (h) => s(h).replace(/^HN/i, '');
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

export function normalizeDailyRow(r) {
  const hn = normHn(r.hn);
  const service_date = ddmmyyyyToIso(r.per_date);
  if (!hn || !service_date) return { error: 'hn หรือ per_date ไม่ถูกต้อง', raw: r };
  const sithi = s(r.sithi).toUpperCase() || 'UNK';
  const payer_id = s(r.payer) || 'UNK';
  return {
    hn, service_date, sithi, payer_id,
    req_unit: s(r.req_unit) || null,
    amount: money(r.tamt),
    is_c: s(r.complete).toUpperCase() === 'C',
    complete: s(r.complete).toUpperCase(),
    name: s(r.name) || null,
    birthdate: mdyToIso(r.birthdate),
    sex: s(r.sex) || null,
    caseId: sha(`${hn}|${service_date}|${sithi}|${payer_id}`),
  };
}

/** ให้ทุกบรรทัดมี lineId คงที่ (ซ้ำเหมือนกันทุกประการ -> นับลำดับ n เพื่อไม่ชนกัน) */
export function assignLineIds(lines) {
  const seen = new Map();
  for (const l of lines) {
    const base = `${l.hn}|${l.service_date}|${l.sithi}|${l.payer_id}|${l.complete}|${l.amount}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    l.lineId = sha(`${base}|${n}`);
  }
  return lines;
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * วางแผนนำเข้าไฟล์รายวัน (ไม่เขียนอะไร)
 * db.getByIds(table, ids) -> Map(id -> row)
 * แถวที่ส่งมาต้องไม่ตัดกลางกลุ่ม key (ฝั่งเบราว์เซอร์เรียงตาม key แล้วตัดที่ขอบกลุ่ม)
 */
export async function planDaily(rawRows, db, { fileDate, decisions = {} } = {}) {
  const errors = [];
  let lines = [];
  for (const r of rawRows) {
    const n = normalizeDailyRow(r);
    if (n.error) errors.push(n); else lines.push(n);
  }
  assignLineIds(lines);

  const existingLines = await db.getByIds('visit_lines', lines.map((l) => l.lineId));
  const dupLines = lines.filter((l) => existingLines.has(l.lineId));
  const newLines = lines.filter((l) => !existingLines.has(l.lineId));

  const byCase = new Map();
  for (const l of newLines) {
    if (!byCase.has(l.caseId)) byCase.set(l.caseId, []);
    byCase.get(l.caseId).push(l);
  }
  const existingCases = await db.getByIds('cases', [...byCase.keys()]);

  const caseWrites = [], lineWrites = [], needsDecision = [], orphanLines = [];
  const sum = { new_cases: 0, updated_cases: 0, dup_lines: dupLines.length, ggo_pending_lines: 0, skipped_cases: 0, new_lines: 0 };

  for (const [caseId, ls] of byCase) {
    const f = ls[0];
    const isGgo = f.sithi === 'GGO';
    const addC = money(ls.filter((l) => l.is_c).reduce((a, l) => a + l.amount, 0));
    const addAll = money(ls.reduce((a, l) => a + l.amount, 0));
    const addTotal = isGgo ? addC : addAll;
    const addHasC = ls.some((l) => l.is_c);
    const ex = existingCases.get(caseId);

    if (!ex && isGgo && !addHasC) { // GGO ไม่ C ที่ยังไม่มีเคส -> รอรับรองสิทธิ
      for (const l of ls) lineWrites.push(lineRow(l, null, fileDate));
      sum.ggo_pending_lines += ls.length; sum.new_lines += ls.length; orphanLines.push(...ls);
      continue;
    }
    if (ex && ex.status !== 'pending_claim') {
      const d = decisions[caseId] || 'skip';
      const info = { caseId, hn: f.hn, service_date: f.service_date, sithi: f.sithi, payer_id: f.payer_id,
        status: ex.status, active_claim_no: ex.active_claim_no || null, current_amount: ex.amount_total,
        added_amount: addTotal, decision: d };
      needsDecision.push(info);
      if (d === 'skip') { sum.skipped_cases++; continue; }
      caseWrites.push({ $id: caseId, amount_total: money(ex.amount_total + addTotal),
        amount_c: money((ex.amount_c || 0) + addC), has_c: !!ex.has_c || addHasC,
        review_flag: d === 'resend' ? true : !!ex.review_flag });
      for (const l of ls) lineWrites.push(lineRow(l, caseId, fileDate));
      sum.updated_cases++; sum.new_lines += ls.length;
      continue;
    }
    if (ex) { // pending_claim: บวกยอด
      caseWrites.push({ $id: caseId, amount_total: money(ex.amount_total + addTotal),
        amount_c: money((ex.amount_c || 0) + addC), has_c: !!ex.has_c || addHasC });
      sum.updated_cases++;
    } else {
      caseWrites.push({ $id: caseId, hn: f.hn, service_date: f.service_date, sithi: f.sithi, payer_id: f.payer_id,
        req_unit: f.req_unit, amount_total: addTotal, amount_c: addC, has_c: addHasC, status: 'pending_claim',
        amount_mismatch: false, cancel_detected: false, review_flag: false });
      sum.new_cases++;
    }
    for (const l of ls) lineWrites.push(lineRow(l, caseId, fileDate));
    sum.new_lines += ls.length;
  }

  // ผู้ป่วย / master ที่ยังไม่มี
  const hns = [...new Set(newLines.map((l) => l.hn))];
  const exPat = await db.getByIds('patients', hns);
  const patientWrites = hns.filter((h) => !exPat.has(h)).map((h) => {
    const l = newLines.find((x) => x.hn === h);
    return { $id: h, hn: h, full_name: l.name, birthdate: l.birthdate, sex: l.sex };
  });
  const sithis = [...new Set(newLines.map((l) => l.sithi))], payers = [...new Set(newLines.map((l) => l.payer_id))];
  const exCov = await db.getByIds('coverage_master', sithis), exPay = await db.getByIds('payer_master', payers);
  const coverageWrites = sithis.filter((c) => !exCov.has(c)).map((c) => ({ $id: c, code: c }));
  const payerWrites = payers.filter((p) => !exPay.has(p)).map((p) => ({ $id: p, payer_id: p }));

  sum.new_patients = patientWrites.length;
  sum.new_coverage = coverageWrites.length;
  sum.new_payers = payerWrites.length;
  sum.rows_total = rawRows.length; sum.errors = errors.length;
  return { summary: sum, needsDecision, errors: errors.slice(0, 20),
    writes: { patients: patientWrites, coverage_master: coverageWrites, payer_master: payerWrites, visit_lines: lineWrites, cases: caseWrites } };
}

function lineRow(l, caseId, fileDate) {
  return { $id: l.lineId, hn: l.hn, service_date: l.service_date, sithi: l.sithi, payer_id: l.payer_id,
    req_unit: l.req_unit, amount: l.amount, is_c: l.is_c, file_date: fileDate || null, case_id: caseId };
}

/** เขียนจริง (ลำดับ: master -> patients -> visit_lines -> cases) เป็นชุดย่อย ทำซ้ำได้ */
export async function applyPlan(plan, db, { batchId, userId } = {}) {
  const w = plan.writes;
  for (const t of ['coverage_master', 'payer_master', 'patients']) await db.upsert(t, w[t]);
  await db.upsert('visit_lines', w.visit_lines.map((r) => ({ ...r, batch_id: batchId || null })));
  await db.upsert('cases', w.cases.map((r) => ({ ...r, updated_by: userId || null })));
  return plan.summary;
}

export { chunk };
