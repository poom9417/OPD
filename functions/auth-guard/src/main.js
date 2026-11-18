import { Client, TablesDB, Users, Query, ID } from 'node-appwrite';
import { planDaily, applyPlan, chunk } from './core.js';

const DB = 'opd';
const ALLOWED = ['developer', 'admin'];

export default async ({ req, res, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key']);
  const users = new Users(client);
  const tables = new TablesDB(client);

  // --- ตรวจผู้เรียก: ต้องล็อกอิน, โดเมน mahidol, มี role ที่อนุญาต ---
  const uid = req.headers['x-appwrite-user-id'];
  if (!uid) return res.json({ ok: false, error: 'unauthenticated' }, 401);
  const u = await users.get({ userId: uid });
  if (!/@mahidol\.ac\.th$/i.test(u.email || '') || !u.labels.some((l) => ALLOWED.includes(l)))
    return res.json({ ok: false, error: 'forbidden' }, 403);

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  const db = {
    async getByIds(table, ids) {
      const m = new Map();
      for (const part of chunk([...new Set(ids)], 100)) {
        if (!part.length) continue;
        const r = await tables.listRows({ databaseId: DB, tableId: table, queries: [Query.equal('$id', part), Query.limit(100)], total: false });
        for (const row of r.rows) m.set(row.$id, row);
      }
      return m;
    },
    async upsert(table, rows) {
      for (const part of chunk(rows, 100))
        if (part.length) await tables.upsertRows({ databaseId: DB, tableId: table, rows: part });
    },
  };

  try {
    switch (body.action) {
      case 'open_batch': {
        const id = ID.unique();
        await tables.createRow({ databaseId: DB, tableId: 'import_batches', rowId: id, data: {
          kind: 'daily', filename: body.filename || null, file_date: body.fileDate || null, uploaded_by: uid, status: 'running' } });
        return res.json({ ok: true, batchId: id });
      }
      case 'preview_daily': {
        const plan = await planDaily(body.rows || [], db, { fileDate: body.fileDate, decisions: body.decisions || {} });
        return res.json({ ok: true, summary: plan.summary, needsDecision: plan.needsDecision, errors: plan.errors });
      }
      case 'commit_daily': {
        const plan = await planDaily(body.rows || [], db, { fileDate: body.fileDate, decisions: body.decisions || {} });
        const summary = await applyPlan(plan, db, { batchId: body.batchId, userId: uid });
        return res.json({ ok: true, summary, needsDecision: plan.needsDecision });
      }
      case 'close_batch': {
        const t = body.totals || {};
        await tables.updateRow({ databaseId: DB, tableId: 'import_batches', rowId: body.batchId, data: {
          status: 'done', rows_total: t.rows_total || 0, rows_new: t.new_lines || 0, rows_updated: t.updated_cases || 0,
          rows_skipped: (t.dup_lines || 0) + (t.skipped_cases || 0), rows_review: t.needs_decision || 0 } });
        return res.json({ ok: true });
      }
      default:
        return res.json({ ok: false, error: 'unknown action' }, 400);
    }
  } catch (e) {
    error(String(e?.stack || e));
    return res.json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
