process.env.DB_PATH = './debug4_coldchain.db';
const fs = require('fs');
const path = require('path');
const dbFile = path.resolve('./debug4_coldchain.db');
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch(e) {}

async function debug() {
  const { initDb, waybillRepo, segmentRepo, auditRepo } = require('./src/db');
  await initDb();

  waybillRepo.create({ waybill_no: 'WB-DEBUG-004', meat_type: '冷鲜猪肉', zone_code: 'CHILLED' });

  const segData = {
    waybill_no: 'WB-DEBUG-004',
    start_time: '2026-06-20T08:00:00',
    end_time: '2026-06-20T09:00:00',
    avg_temp: 2.0, min_temp: 1.5, max_temp: 2.8, sample_count: 60,
    location_name: '测试', door_open: 0, door_open_duration: 0,
    cooler_status: 'normal', device_id: 'DEV', raw_payload: null
  };

  // 手动执行 create 的步骤
  const { getDb } = require('./src/db');
  const db2 = require('./src/db');
  const sql = `
    INSERT INTO temperature_segments (waybill_no, start_time, end_time, avg_temp, min_temp, max_temp, sample_count,
      location_lat, location_lng, location_name, door_open, door_open_duration, cooler_status, device_id, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const runFn = require('./src/db');
  // test last insert rowid
  const internalDb = await require('./src/db').initDb();
  const stmt = internalDb.prepare(sql);
  stmt.bind(['WB-DEBUG-004','2026-06-20T08:00:00','2026-06-20T09:00:00',2.0,1.5,2.8,60,null,null,'测试',0,0,'normal','DEV',null]);
  stmt.step();
  stmt.free();
  // Save
  const buf = Buffer.from(internalDb.export());
  fs.writeFileSync(dbFile, buf);
  
  const idStmt = internalDb.prepare('SELECT last_insert_rowid() as id');
  idStmt.step();
  const idRow = idStmt.getAsObject();
  idStmt.free();
  console.log('last_insert_rowid =', idRow.id);

  // Now query
  const sel = internalDb.prepare('SELECT * FROM temperature_segments WHERE id = ?');
  sel.bind([idRow.id]);
  const cols = sel.getColumnNames();
  console.log('Columns:', cols);
  if (sel.step()) {
    const row = sel.getAsObject();
    console.log('FOUND row by id:', JSON.stringify(row, null, 2));
  } else {
    console.log('NOT FOUND by id');
    // Try list all
    const selAll = internalDb.prepare('SELECT * FROM temperature_segments');
    console.log('All segments:');
    while (selAll.step()) {
      console.log('  ', JSON.stringify(selAll.getAsObject()));
    }
    selAll.free();
  }
  sel.free();
}

debug().catch(e => console.error('Fatal:', e));
