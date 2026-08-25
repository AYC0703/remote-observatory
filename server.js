const express = require('express');
const session = require('express-session');
const path = require('node:path');
const { db, now, hashPassword, verifyPassword } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const DEVICES = ['望远镜A（0.5米）', '望远镜B（0.8米）', '望远镜C（1.2米）', '射电望远镜'];
const STATUS_LABEL = { pending: '待审批', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };

app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'observatory.sid',
  secret: 'remote-observatory-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 }
}));

const APP_COLS = [
  'a.id', 'a.app_no', 'a.user_id', 'a.applicant_name', 'a.applicant_contact',
  'a.device', 'a.start_time', 'a.end_time', 'a.target', 'a.purpose', 'a.status',
  'a.created_at', 'a.reviewed_at', 'a.reviewed_by', 'a.review_comment',
  'r.name AS reviewer_name', 'u.username AS applicant_username'
].join(', ');
const APP_FROM = 'FROM applications a LEFT JOIN users r ON a.reviewed_by = r.id LEFT JOIN users u ON a.user_id = u.id';

function genAppNo() {
  const year = new Date().getFullYear();
  const row = db.prepare('SELECT COUNT(*) AS c FROM applications WHERE app_no LIKE ?').get('TEL-' + year + '-%');
  const seq = (row ? row.c : 0) + 1;
  return 'TEL-' + year + '-' + String(seq).padStart(4, '0');
}

function findConflicts(device, startTime, endTime, excludeId) {
  let sql = 'SELECT id, app_no, start_time, end_time, status FROM applications WHERE device = ? AND status IN (\'pending\',\'approved\') AND start_time < ? AND end_time > ?';
  const params = [device, endTime, startTime];
  if (excludeId) { sql += ' AND id != ?'; params.push(excludeId); }
  sql += ' ORDER BY start_time';
  return db.prepare(sql).all(...params);
}

function addHistory(applicationId, fromStatus, toStatus, action, operator, comment) {
  db.prepare('INSERT INTO status_history (application_id, from_status, to_status, action, operator_id, operator_name, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(applicationId, fromStatus, toStatus, action, operator ? operator.id : null, operator ? operator.name : null, comment || null, now());
}

function addAudit(user, action, detail) {
  db.prepare('INSERT INTO audit_logs (user_id, username, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(user ? user.id : null, user ? user.username : null, action, detail, now());
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ---------- 认证 ----------
app.post('/api/auth/register', (req, res) => {
  const { username, password, name } = req.body || {};
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  const dispName = String(name || '').trim() || uname;
  if (!uname || uname.length < 3 || uname.length > 20) return res.status(400).json({ error: '用户名需为 3-20 个字符' });
  if (!/^[a-zA-Z0-9_]+$/.test(uname)) return res.status(400).json({ error: '用户名仅支持字母、数字、下划线' });
  if (pwd.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (exists) return res.status(409).json({ error: '用户名已存在' });
  const info = db.prepare('INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uname, hashPassword(pwd), dispName, 'user', now());
  const user = { id: Number(info.lastInsertRowid), username: uname, name: dispName, role: 'user' };
  req.session.user = user;
  addAudit(user, 'register', '用户注册');
  res.json({ user });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const user = { id: Number(row.id), username: row.username, name: row.name, role: row.role };
  req.session.user = user;
  addAudit(user, 'login', '登录系统');
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.user) addAudit(req.session.user, 'logout', '退出登录');
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get('/api/devices', (req, res) => res.json({ devices: DEVICES }));

// ---------- 用户：申请 ----------
app.get('/api/applications/conflicts', requireAuth, (req, res) => {
  const device = String(req.query.device || '');
  const startTime = String(req.query.start || '');
  const endTime = String(req.query.end || '');
  if (!device || !startTime || !endTime) return res.json({ conflicts: [] });
  res.json({ conflicts: findConflicts(device, startTime, endTime, null) });
});

app.post('/api/applications', requireAuth, (req, res) => {
  const b = req.body || {};
  const device = String(b.device || '').trim();
  const startTime = String(b.start_time || '').trim();
  const endTime = String(b.end_time || '').trim();
  const target = String(b.target || '').trim();
  const purpose = String(b.purpose || '').trim();
  const applicantName = String(b.applicant_name || '').trim();
  const applicantContact = String(b.applicant_contact || '').trim();
  if (!device || !DEVICES.includes(device)) return res.status(400).json({ error: '请选择有效的观测设备' });
  if (!startTime || !endTime) return res.status(400).json({ error: '请填写完整的使用时段' });
  if (startTime >= endTime) return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  if (startTime < new Date().toISOString().slice(0, 16)) return res.status(400).json({ error: '不能选择过去的时段' });
  if (!target) return res.status(400).json({ error: '请填写拍摄目标' });
  if (!purpose) return res.status(400).json({ error: '请填写拍摄目的' });
  if (!applicantName) return res.status(400).json({ error: '请填写申请人姓名' });
  if (!applicantContact) return res.status(400).json({ error: '请填写联系方式' });
  const conflicts = findConflicts(device, startTime, endTime, null);
  if (conflicts.length > 0) {
    return res.status(409).json({ error: '该设备在所选时段已被占用', conflicts });
  }
  const appNo = genAppNo();
  const info = db.prepare('INSERT INTO applications (app_no, user_id, applicant_name, applicant_contact, device, start_time, end_time, target, purpose, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appNo, req.session.user.id, applicantName, applicantContact, device, startTime, endTime, target, purpose, 'pending', now());
  const id = Number(info.lastInsertRowid);
  addHistory(id, null, 'pending', 'submit', req.session.user, null);
  addAudit(req.session.user, 'submit_application', '提交申请 ' + appNo);
  res.status(201).json({ ok: true, id, app_no: appNo });
});

app.get('/api/applications/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' WHERE a.user_id = ? ORDER BY a.created_at DESC').all(req.session.user.id);
  res.json({ applications: rows });
});

app.get('/api/applications/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' WHERE a.id = ?').get(id);
  if (!row) return res.status(404).json({ error: '申请不存在' });
  if (req.session.user.role !== 'admin' && Number(row.user_id) !== req.session.user.id) {
    return res.status(403).json({ error: '无权查看该申请' });
  }
  const history = db.prepare('SELECT * FROM status_history WHERE application_id = ? ORDER BY created_at ASC').all(id);
  res.json({ application: row, history });
});

app.post('/api/applications/:id/withdraw', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '申请不存在' });
  if (Number(row.user_id) !== req.session.user.id) return res.status(403).json({ error: '无权操作该申请' });
  if (row.status !== 'pending') return res.status(400).json({ error: '仅待审批的申请可撤回' });
  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('withdrawn', id);
  addHistory(id, 'pending', 'withdrawn', 'withdraw', req.session.user, null);
  addAudit(req.session.user, 'withdraw_application', '撤回申请 ' + row.app_no);
  res.json({ ok: true });
});

// ---------- 管理员 ----------
app.get('/api/admin/applications', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const search = String(req.query.search || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '20', 10) || 20));
  const where = [];
  const params = [];
  if (status && ['pending','approved','rejected','withdrawn'].includes(status)) { where.push('a.status = ?'); params.push(status); }
  if (search) { where.push('(a.app_no LIKE ? OR a.applicant_name LIKE ? OR a.target LIKE ? OR a.device LIKE ?)'); const like = '%' + search + '%'; params.push(like, like, like, like); }
  const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  const total = db.prepare('SELECT COUNT(*) AS c FROM applications a' + whereSql).get(...params).c;
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + whereSql + ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?')
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ applications: rows, total, page, pageSize });
});

app.get('/api/admin/pending', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + " WHERE a.status = 'pending' ORDER BY a.created_at ASC").all();
  res.json({ applications: rows });
});

app.get('/api/admin/calendar', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, app_no, device, start_time, end_time, status FROM applications WHERE status IN (\'pending\',\'approved\') ORDER BY start_time').all();
  res.json({ slots: rows });
});

app.post('/api/admin/applications/:id/review', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const action = String((req.body || {}).action || '');
  const comment = String((req.body || {}).comment || '').trim();
  const force = !!(req.body || {}).force;
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: '无效的审批操作' });
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '申请不存在' });
  if (row.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
  if (action === 'reject' && !comment) return res.status(400).json({ error: '拒绝时必须填写审批意见' });
  if (action === 'approve') {
    const conflicts = findConflicts(row.device, row.start_time, row.end_time, id);
    if (conflicts.length > 0 && !force) {
      return res.status(409).json({ error: '该申请与以下已占用时段冲突', conflicts });
    }
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE applications SET status = ?, reviewed_at = ?, reviewed_by = ?, review_comment = ? WHERE id = ?')
    .run(newStatus, now(), req.session.user.id, comment || null, id);
  addHistory(id, 'pending', newStatus, action, req.session.user, comment);
  addAudit(req.session.user, action + '_application', (action === 'approve' ? '通过' : '拒绝') + '申请 ' + row.app_no);
  res.json({ ok: true, status: newStatus });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const counts = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM applications GROUP BY status').all();
  let total = 0;
  rows.forEach(function (r) { if (counts.hasOwnProperty(r.status)) counts[r.status] = r.c; total += r.c; });
  const byDevice = db.prepare('SELECT device, COUNT(*) AS c FROM applications GROUP BY device ORDER BY c DESC').all();
  const byMonthRaw = db.prepare('SELECT substr(created_at,1,7) AS ym, COUNT(*) AS c FROM applications GROUP BY ym ORDER BY ym ASC').all();
  const approveRate = total > 0 ? Math.round((counts.approved / (counts.approved + counts.rejected)) * 100) : 0;
  res.json({ counts, total, byDevice, byMonthRaw, approveRate });
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' ORDER BY a.created_at ASC').all();
  const header = ['申请编号','申请人','申请人账号','联系方式','观测设备','开始时间','结束时间','拍摄目标','拍摄目的','状态','提交时间','审批时间','审批人','审批意见'];
  const esc = function (v) {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[\",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [header.map(esc).join(',')];
  rows.forEach(function (r) {
    lines.push([
      r.app_no, r.applicant_name, r.applicant_username, r.applicant_contact, r.device,
      r.start_time, r.end_time, r.target, r.purpose, STATUS_LABEL[r.status] || r.status,
      r.created_at, r.reviewed_at || '', r.reviewer_name || '', r.review_comment || ''
    ].map(esc).join(','));
  });
  const csv = '\uFEFF' + lines.join('\r\n');
  const filename = 'observatory-report-' + new Date().toISOString().slice(0, 10) + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(csv);
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all();
  res.json({ logs: rows });
});

// ---------- 静态资源 ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

const server = app.listen(PORT, () => {
  console.log('远程天文台系统已启动: http://localhost:' + PORT);
  console.log('管理员账号: admin / admin123');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('【错误】端口 ' + PORT + ' 已被占用。');
    console.error('请先关闭占用该端口的进程，或使用其他端口启动，例如：');
    console.error('  PORT=3001 npm start');
    process.exit(1);
  }
  throw err;
});
