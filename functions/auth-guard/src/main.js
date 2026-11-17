// Trigger: users.*.create — ผู้ใช้ที่ไม่ใช่ @mahidol.ac.th ถูกลบทันที, ที่เหลือเข้า app_users สถานะ pending
import { Client, TablesDB, Users } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key']);
  const user = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!user.$id) return res.json({ ok: false, error: 'no user in event' }, 400);

  const email = String(user.email || '').trim().toLowerCase();
  try {
    if (!email.endsWith('@mahidol.ac.th')) {
      await new Users(client).delete({ userId: user.$id });
      log(`deleted non-mahidol user ${user.$id}`);
      return res.json({ ok: true, deleted: true });
    }
    await new TablesDB(client).upsertRows({ databaseId: 'opd', tableId: 'app_users', rows: [
      { $id: user.$id, email, role: 'viewer', approval_status: 'pending' } ] });
    return res.json({ ok: true, deleted: false });
  } catch (e) {
    error(String(e?.stack || e));
    return res.json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
