process.env.DB_PATH = './debug2_coldchain.db';
const fs = require('fs');
const path = require('path');
const dbFile = path.resolve('./debug2_coldchain.db');
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch(e) {}

async function debug() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS temperature_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waybill_no TEXT NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      avg_temp REAL NOT NULL,
      min_temp REAL NOT NULL,
      max_temp REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      location_lat REAL,
      location_lng REAL,
      location_name TEXT,
      door_open INTEGER DEFAULT 0,
      door_open_duration INTEGER DEFAULT 0,
      cooler_status TEXT DEFAULT 'normal',
      device_id TEXT,
      raw_payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS waybills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waybill_no TEXT UNIQUE NOT NULL,
      meat_type TEXT NOT NULL,
      zone_code TEXT NOT NULL,
      status TEXT DEFAULT 'in_transit'
    );
  `);

  console.log('Step 1: Insert waybill');
  const wbStmt = db.prepare('INSERT INTO waybills (waybill_no, meat_type, zone_code) VALUES (?, ?, ?)');
  wbStmt.bind(['WB-DEBUG-002', '冷鲜猪肉', 'CHILLED']);
  wbStmt.step();
  wbStmt.free();
  console.log('OK');

  console.log('Step 2: Prepare segment insert statement');
  const sql = `
    INSERT INTO temperature_segments (waybill_no, start_time, end_time, avg_temp, min_temp, max_temp, sample_count,
      location_lat, location_lng, location_name, door_open, door_open_duration, cooler_status, device_id, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const stmt = db.prepare(sql);
  console.log('OK - statement prepared');

  const params = [
    'WB-DEBUG-002',
    '2026-06-20T08:00:00',
    '2026-06-20T09:00:00',
    2.0, 1.5, 2.8,
    60,
    34.7466,
    113.6253,
    '京港澳高速郑州段',
    0, 0,
    'normal',
    'DEV-001',
    null
  ];
  console.log('Step 3: Bind params:', params.length, 'params');
  console.log('Types:', params.map(p => typeof p));
  try {
    stmt.bind(params);
    console.log('OK - bind succeeded');
  } catch (e) {
    console.log('BIND FAILED:', e.message || e, 'stack:', e && e.stack);
    return;
  }
  console.log('Step 4: Step through');
  try {
    stmt.step();
    console.log('OK - step succeeded');
  } catch (e) {
    console.log('STEP FAILED:', e.message || e);
    return;
  }
  stmt.free();

  console.log('Step 5: Get last insert id');
  const idStmt = db.prepare('SELECT last_insert_rowid() as id');
  idStmt.step();
  const idRow = idStmt.getAsObject();
  idStmt.free();
  console.log('Last insert id:', idRow.id);

  console.log('Step 6: Query back');
  const selStmt = db.prepare('SELECT * FROM temperature_segments WHERE id = ?');
  selStmt.bind([idRow.id]);
  const cols = selStmt.getColumnNames();
  if (selStmt.step()) {
    const row = selStmt.getAsObject();
    console.log('Segment retrieved:', JSON.stringify(row, null, 2));
  }
  selStmt.free();

  console.log('ALL STEPS PASSED!');
}

debug().catch(e => console.error('Fatal:', e, e.stack));
