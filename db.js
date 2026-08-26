const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'observatory.db');
const db = new DatabaseSync(DB_PATH);

const SCHEMA = [
  'PRAGMA foreign_keys = ON;',
  'CREATE TABLE IF NOT EXISTS users (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  username TEXT NOT NULL UNIQUE,',
  '  password_hash TEXT NOT NULL,',
  '  name TEXT NOT NULL,',
  '  role TEXT NOT NULL DEFAULT \'user\',',
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS applications (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  app_no TEXT NOT NULL UNIQUE,',
  '  user_id INTEGER NOT NULL,',
  '  applicant_name TEXT NOT NULL,',
  '  applicant_contact TEXT NOT NULL,',
  '  device TEXT NOT NULL,',
  '  start_time TEXT NOT NULL,',
  '  end_time TEXT NOT NULL,',
  '  target TEXT NOT NULL,',
  '  purpose TEXT NOT NULL,',
  '  status TEXT NOT NULL DEFAULT \'pending\',',
  '  created_at TEXT NOT NULL,',
  '  reviewed_at TEXT,',
  '  reviewed_by INTEGER,',
  '  review_comment TEXT,',
  '  FOREIGN KEY (user_id) REFERENCES users(id),',
  '  FOREIGN KEY (reviewed_by) REFERENCES users(id)',
  ');',
  'CREATE TABLE IF NOT EXISTS status_history (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  application_id INTEGER NOT NULL,',
  '  from_status TEXT,',
  '  to_status TEXT NOT NULL,',
  '  action TEXT NOT NULL,',
  '  operator_id INTEGER,',
  '  operator_name TEXT,',
  '  comment TEXT,',
  '  created_at TEXT NOT NULL,',
  '  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE',
  ');',
  'CREATE TABLE IF NOT EXISTS audit_logs (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  user_id INTEGER,',
  '  username TEXT,',
  '  action TEXT NOT NULL,',
  '  detail TEXT,',
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS devices (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  name TEXT NOT NULL UNIQUE,',
  '  created_at TEXT NOT NULL',
  ');'
].join('\n');

db.exec(SCHEMA);

function now() { return new Date().toISOString(); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(pw, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const hash = parts[1];
  const test = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (test.length !== expected.length) return false;
  return crypto.timingSafeEqual(test, expected);
}

function seedAdmin() {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const envPwd = process.env.ADMIN_PASSWORD;
  if (!existing) {
    const initialPwd = envPwd || 'admin123';
    db.prepare('INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('admin', hashPassword(initialPwd), '系统管理员', 'admin', now());
    console.log('[seed] 管理员账号已创建: admin / ' + initialPwd);
    if (!envPwd) {
      console.log('[warn] 未设置 ADMIN_PASSWORD，已使用默认密码，生产环境请通过环境变量 ADMIN_PASSWORD 指定');
    }
  } else if (envPwd && !verifyPassword(envPwd, existing.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hashPassword(envPwd), 'admin');
    console.log('[seed] 管理员密码已按 ADMIN_PASSWORD 同步更新');
  }
}
seedAdmin();

function seedDevices() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count === 0) {
    const defaults = ['望远镜A（0.5米）', '望远镜B（0.8米）', '望远镜C（1.2米）', '射电望远镜'];
    const ins = db.prepare('INSERT INTO devices (name, created_at) VALUES (?, ?)');
    defaults.forEach(function (n) { ins.run(n, now()); });
    console.log('[seed] 已初始化默认观测设备');
  }
}
seedDevices();

module.exports = { db, now, hashPassword, verifyPassword };
