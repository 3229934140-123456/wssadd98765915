process.env.DB_PATH = './debug3_coldchain.db';
const fs = require('fs');
const path = require('path');
const dbFile = path.resolve('./debug3_coldchain.db');
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch(e) {}

async function debug() {
  const { initDb, waybillRepo, segmentRepo } = require('./src/db');

  await initDb();
  console.log('DB initialized');

  const wb = waybillRepo.create({
    waybill_no: 'WB-DEBUG-003',
    meat_type: '冷鲜猪肉',
    zone_code: 'CHILLED'
  });
  console.log('Waybill created, id:', wb.id);

  const segData = {
    waybill_no: 'WB-DEBUG-003',
    start_time: '2026-06-20T08:00:00',
    end_time: '2026-06-20T09:00:00',
    avg_temp: 2.0,
    min_temp: 1.5,
    max_temp: 2.8,
    sample_count: 60,
    location_lat: 34.7466,
    location_lng: 113.6253,
    location_name: '测试路段',
    door_open: 0,
    door_open_duration: 0,
    cooler_status: 'normal',
    device_id: 'DEV-001',
    raw_payload: null
  };

  console.log('\n--- Step A: call run() directly via db layer ---');
  const { getDb } = require('./src/db');

  const dbModule = require('./src/db');
  console.log('dbModule keys:', Object.keys(dbModule));
  console.log('segmentRepo keys:', Object.keys(dbModule.segmentRepo));

  console.log('\n--- Try calling segmentRepo.create step by step ---');

  const params = [
    segData.waybill_no, segData.start_time, segData.end_time, segData.avg_temp, segData.min_temp, segData.max_temp,
    segData.sample_count || 1,
    segData.location_lat != null ? segData.location_lat : null,
    segData.location_lng != null ? segData.location_lng : null,
    segData.location_name || null,
    segData.door_open ? 1 : 0,
    segData.door_open_duration || 0,
    segData.cooler_status || 'normal',
    segData.device_id || null,
    segData.raw_payload || null
  ];

  console.log('Params count:', params.length);
  console.log('Params:', JSON.stringify(params));

  console.log('\n--- Try segmentRepo.create now with full stack trace ---');
  try {
    const seg = dbModule.segmentRepo.create(segData);
    console.log('SUCCESS, seg.id:', seg.id);
  } catch (e) {
    console.log('EXCEPTION TYPE:', typeof e);
    console.log('EXCEPTION IS:', e);
    console.log('INSTANCEOF Error:', e instanceof Error);
    if (e && e.stack) console.log('STACK:', e.stack);
    if (e && e.message) console.log('MESSAGE:', e.message);
    for (const k of Object.keys(e || {})) {
      console.log(`  PROP ${k}: ${e[k]}`);
    }
  }
}

debug().catch(e => console.error('Fatal:', e, e && e.stack));
