// Trigger: users.*.create
//  - อีเมลที่ไม่ใช่ @mahidol.ac.th → ลบบัญชีทันที
//  - อีเมลอยู่ใน BOOTSTRAP_ROLES (env ของ Function, อีเมลยืนยันแล้ว) → ติด label + app_users = approved
//  - นอกนั้น → app_users = pending (ยังไม่มี label จึงมองไม่เห็นข้อมูล รอ admin อนุมัติ)
// แถว app_users ให้เจ้าของอ่านสถานะตัวเองได้ (หน้า "รออนุมัติ" / "ถูกปฏิเสธ")
import { Client, TablesDB, Users, Permission, Role } from 'node-appwrite';

const DOMAIN = '@mahidol.ac.th';
const ROLES = ['developer', 'admin', 'user', 'viewer'];

// BOOTSTRAP_ROLES = {"someone@mahidol.ac.th":"admin", ...}  (ตั้งเป็น variable ใน Appwrite ไม่เก็บใน repo)
function loadBootstrap(log) {
  const map = new Map();
  try {
    const raw = JSON.parse(process.env.BOOTSTRAP_ROLES || '{}');
    for (const [email, role] of Object.entries(raw)) {
      const e = String(email).trim().toLowerCase();
      if (e.endsWith(DOMAIN) && ROLES.includes(role)) map.set(e, role);
      else log(`ignored bootstrap entry (bad domain/role): ${role}`);
    }
  } catch (e) {
    log(`BOOTSTRAP_ROLES unreadable: ${e.message}`);
  }
  return map;
}

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key']);
  const user = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!user.$id) return res.json({ ok: false, error: 'no user in event' }, 400);

  const email = String(user.email || '').trim().toLowerCase();
  try {
    const users = new Users(client);
    if (!email.endsWith(DOMAIN)) {
      await users.delete({ userId: user.$id });
      log(`deleted non-mahidol user ${user.$id}`);
      return res.json({ ok: true, deleted: true });
    }

    // สิทธิ์ที่กำหนดล่วงหน้า ให้เฉพาะอีเมลที่ผู้ให้บริการ OAuth ยืนยันแล้วเท่านั้น
    let role = loadBootstrap(log).get(email);
    if (role && user.emailVerification !== true) {
      log(`bootstrap role skipped, email not verified: ${user.$id}`);
      role = undefined;
    }

    const row = { $id: user.$id, email, role: role || 'viewer', approval_status: 'pending',
      $permissions: [Permission.read(Role.user(user.$id))] };
    if (role) {
      await users.updateLabels({ userId: user.$id, labels: [role] });
      row.approval_status = 'approved';
      row.approved_by = 'bootstrap';
      row.approved_at = new Date().toISOString();
    }
    await new TablesDB(client).upsertRows({ databaseId: 'opd', tableId: 'app_users', rows: [row] });
    log(`user ${user.$id} → ${row.approval_status}${role ? ` (${role})` : ''}`);
    return res.json({ ok: true, deleted: false, status: row.approval_status });
  } catch (e) {
    error(String(e?.stack || e));
    return res.json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
