const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db = null;
let SQL = null;
let dbFilePath = null;

function saveDb() {
  if (!db || !dbFilePath) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  } catch (e) {
    console.error('保存数据库失败:', e.message);
  }
}

async function initDb() {
  if (db) return db;
  SQL = await initSqlJs();
  dbFilePath = path.resolve(config.dbPath);

  if (fs.existsSync(dbFilePath)) {
    try {
      const fileBuffer = fs.readFileSync(dbFilePath);
      db = new SQL.Database(fileBuffer);
    } catch (e) {
      console.warn('加载现有数据库失败，创建新数据库:', e.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  createTables();
  migrateDb();
  seedZoneConfigs();
  saveDb();
  return db;
}

function createTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS temperature_zone_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_code TEXT UNIQUE NOT NULL,
      zone_name TEXT NOT NULL,
      min_temp REAL NOT NULL,
      max_temp REAL NOT NULL,
      meat_types TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS waybills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waybill_no TEXT UNIQUE NOT NULL,
      meat_type TEXT NOT NULL,
      zone_code TEXT NOT NULL,
      shipper TEXT,
      consignee TEXT,
      origin TEXT,
      destination TEXT,
      planned_departure DATETIME,
      planned_arrival DATETIME,
      status TEXT DEFAULT 'in_transit',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
      transport_stage TEXT,
      device_id TEXT,
      raw_payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id INTEGER NOT NULL UNIQUE,
      waybill_no TEXT NOT NULL,
      status TEXT NOT NULL,
      temp_status TEXT,
      door_status TEXT,
      cooler_status TEXT,
      transport_stage TEXT,
      details TEXT,
      audit_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_segments_waybill ON temperature_segments(waybill_no);
    CREATE INDEX IF NOT EXISTS idx_audit_waybill ON audit_results(waybill_no);
    CREATE INDEX IF NOT EXISTS idx_segments_time ON temperature_segments(waybill_no, start_time);
  `;
  db.run(sql);
}

function getTableColumns(tableName) {
  const stmt = db.prepare('PRAGMA table_info(' + tableName + ')');
  const cols = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    cols.push(row.name);
  }
  stmt.free();
  return cols;
}

function migrateDb() {
  const migrations = [
    { table: 'temperature_segments', column: 'transport_stage', type: 'TEXT', default: null },
    { table: 'audit_results', column: 'transport_stage', type: 'TEXT', default: null }
  ];
  for (const m of migrations) {
    const cols = getTableColumns(m.table);
    if (cols.indexOf(m.column) < 0) {
      const defVal = m.default != null ? ' DEFAULT ' + m.default : '';
      db.run('ALTER TABLE ' + m.table + ' ADD COLUMN ' + m.column + ' ' + m.type + defVal);
    }
  }
}

function seedZoneConfigs() {
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM temperature_zone_configs');
  const result = stmt.getAsObject();
  const count = result.cnt || 0;
  stmt.free();
  if (count > 0) return;

  const zones = [
    { zone_code: 'FROZEN', zone_name: '冷冻区', min_temp: -25, max_temp: -15, meat_types: '冻牛肉,冻猪肉,冻羊肉,禽肉冻品', description: '深冷冻肉类，需保持-18℃以下' },
    { zone_code: 'CHILLED', zone_name: '冷藏区', min_temp: 0, max_temp: 4, meat_types: '冷鲜猪肉,冷鲜牛肉,冷鲜羊肉', description: '冷却排酸肉，0-4℃保鲜' },
    { zone_code: 'ICE_CHILLED', zone_name: '冰鲜区', min_temp: -2, max_temp: 2, meat_types: '冰鲜鸡,冰鲜鸭,冰鲜鱼', description: '冰鲜禽类和水产品' },
    { zone_code: 'SEMI_FROZEN', zone_name: '微冻区', min_temp: -7, max_temp: -3, meat_types: '微冻海鲜,微冻调理肉', description: '微冻保鲜，保持部分水分活性' }
  ];

  const insert = db.prepare(`
    INSERT INTO temperature_zone_configs (zone_code, zone_name, min_temp, max_temp, meat_types, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.run('BEGIN TRANSACTION');
  for (const z of zones) {
    insert.bind([z.zone_code, z.zone_name, z.min_temp, z.max_temp, z.meat_types, z.description]);
    insert.step();
    insert.reset();
  }
  insert.free();
  db.run('COMMIT');
}

function ensureDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 initDb()');
}

function stmtGetRows(stmt) {
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const obj = {};
    for (const col of cols) {
      obj[col] = row[col];
    }
    rows.push(obj);
  }
  return rows;
}

function getLastInsertRowid() {
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row.id;
}

function normalizeParams(params) {
  if (!params) return [];
  return params.map(function(p) {
    if (p === undefined) return null;
    return p;
  });
}

function run(sql, params) {
  ensureDb();
  const normalized = normalizeParams(params);
  const stmt = db.prepare(sql);
  try {
    if (normalized.length > 0) {
      stmt.bind(normalized);
    }
    stmt.step();
  } finally {
    stmt.free();
  }
  const lastId = getLastInsertRowid();
  saveDb();
  return lastId;
}

function get(sql, params) {
  ensureDb();
  const normalized = normalizeParams(params);
  const stmt = db.prepare(sql);
  if (normalized.length > 0) stmt.bind(normalized);
  const rows = stmtGetRows(stmt);
  stmt.free();
  return rows.length > 0 ? rows[0] : undefined;
}

function all(sql, params) {
  ensureDb();
  const normalized = normalizeParams(params);
  const stmt = db.prepare(sql);
  if (normalized.length > 0) stmt.bind(normalized);
  const rows = stmtGetRows(stmt);
  stmt.free();
  return rows;
}

const zoneConfigRepo = {
  getAll: function() {
    return all('SELECT * FROM temperature_zone_configs');
  },
  getByCode: function(code) {
    return get('SELECT * FROM temperature_zone_configs WHERE zone_code = ?', [code]);
  },
  getByMeatType: function(meatType) {
    const rows = zoneConfigRepo.getAll();
    return rows.find(function(r) {
      return r.meat_types.split(',').some(function(t) {
        return meatType.includes(t.trim()) || t.trim().includes(meatType);
      });
    });
  }
};

const waybillRepo = {
  create: function(data) {
    const sql = `
      INSERT INTO waybills (waybill_no, meat_type, zone_code, shipper, consignee, origin, destination, planned_departure, planned_arrival)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    run(sql, [data.waybill_no, data.meat_type, data.zone_code, data.shipper || null,
      data.consignee || null, data.origin || null, data.destination || null,
      data.planned_departure || null, data.planned_arrival || null]);
    return waybillRepo.getByNo(data.waybill_no);
  },
  getByNo: function(no) {
    return get('SELECT * FROM waybills WHERE waybill_no = ?', [no]);
  },
  updateStatus: function(no, status) {
    run('UPDATE waybills SET status = ? WHERE waybill_no = ?', [status, no]);
    return waybillRepo.getByNo(no);
  },
  upsert: function(data) {
    const existing = waybillRepo.getByNo(data.waybill_no);
    if (existing) return existing;
    return waybillRepo.create(data);
  }
};

const segmentRepo = {
  create: function(data) {
    const sql = `
      INSERT INTO temperature_segments (waybill_no, start_time, end_time, avg_temp, min_temp, max_temp, sample_count,
        location_lat, location_lng, location_name, door_open, door_open_duration, cooler_status, transport_stage, device_id, raw_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const id = run(sql, [data.waybill_no, data.start_time, data.end_time, data.avg_temp, data.min_temp, data.max_temp,
      data.sample_count || 1, data.location_lat != null ? data.location_lat : null,
      data.location_lng != null ? data.location_lng : null, data.location_name || null,
      data.door_open ? 1 : 0, data.door_open_duration || 0, data.cooler_status || 'normal',
      data.transport_stage || null,
      data.device_id || null, data.raw_payload || null]);
    return segmentRepo.getById(id);
  },
  getById: function(id) {
    return get('SELECT * FROM temperature_segments WHERE id = ?', [id]);
  },
  getByWaybill: function(waybillNo) {
    return all('SELECT * FROM temperature_segments WHERE waybill_no = ? ORDER BY start_time ASC', [waybillNo]);
  },
  getByWaybillBetween: function(waybillNo, start, end) {
    return all(`
      SELECT * FROM temperature_segments WHERE waybill_no = ? AND start_time >= ? AND end_time <= ? ORDER BY start_time ASC
    `, [waybillNo, start, end]);
  }
};

const auditRepo = {
  create: function(data) {
    const sql = `
      INSERT INTO audit_results (segment_id, waybill_no, status, temp_status, door_status, cooler_status, transport_stage, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const id = run(sql, [data.segment_id, data.waybill_no, data.status, data.temp_status || null,
      data.door_status || null, data.cooler_status || null, data.transport_stage || null, data.details || null]);
    return auditRepo.getById(id);
  },
  getById: function(id) {
    return get('SELECT * FROM audit_results WHERE id = ?', [id]);
  },
  getBySegmentId: function(sid) {
    return get('SELECT * FROM audit_results WHERE segment_id = ?', [sid]);
  },
  getByWaybill: function(waybillNo) {
    return all(`
      SELECT ar.*, ts.start_time, ts.end_time, ts.avg_temp, ts.max_temp, ts.min_temp, ts.location_name,
             ts.door_open, ts.door_open_duration, ts.cooler_status as segment_cooler_status,
             ts.transport_stage as segment_transport_stage
      FROM audit_results ar
      JOIN temperature_segments ts ON ar.segment_id = ts.id
      WHERE ar.waybill_no = ? ORDER BY ts.start_time ASC
    `, [waybillNo]);
  },
  getByWaybillFiltered: function(waybillNo, options) {
    const opts = options || {};
    const params = [waybillNo];
    let whereSql = 'WHERE ar.waybill_no = ?';

    if (opts.status && Array.isArray(opts.status) && opts.status.length > 0) {
      const placeholders = opts.status.map(function() { return '?'; }).join(',');
      whereSql += ' AND ar.status IN (' + placeholders + ')';
      for (const s of opts.status) { params.push(s); }
    }

    if (opts.start_time) {
      whereSql += ' AND ts.end_time >= ?';
      params.push(opts.start_time);
    }
    if (opts.end_time) {
      whereSql += ' AND ts.start_time <= ?';
      params.push(opts.end_time);
    }

    const sql = `
      SELECT ar.*, ts.start_time, ts.end_time, ts.avg_temp, ts.max_temp, ts.min_temp, ts.location_name,
             ts.door_open, ts.door_open_duration, ts.cooler_status as segment_cooler_status,
             ts.transport_stage as segment_transport_stage
      FROM audit_results ar
      JOIN temperature_segments ts ON ar.segment_id = ts.id
      ${whereSql}
      ORDER BY ts.start_time ASC
    `;
    return all(sql, params);
  },
  upsert: function(data) {
    const existing = auditRepo.getBySegmentId(data.segment_id);
    if (existing) {
      const sql = `
        UPDATE audit_results SET status = ?, temp_status = ?, door_status = ?,
          cooler_status = ?, transport_stage = ?, details = ?, audit_time = CURRENT_TIMESTAMP
        WHERE segment_id = ?
      `;
      run(sql, [data.status, data.temp_status || null, data.door_status || null,
        data.cooler_status || null, data.transport_stage || null, data.details || null, data.segment_id]);
      return auditRepo.getBySegmentId(data.segment_id);
    }
    return auditRepo.create(data);
  }
};

module.exports = {
  initDb,
  zoneConfigRepo,
  waybillRepo,
  segmentRepo,
  auditRepo
};
