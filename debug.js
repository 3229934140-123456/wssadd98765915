process.env.DB_PATH = './debug_coldchain.db';
const fs = require('fs');
const path = require('path');
const dbFile = path.resolve('./debug_coldchain.db');
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch(e) {}

async function debug() {
  const { initDb, waybillRepo, segmentRepo, auditRepo } = require('./src/db');
  const { processSegmentAudit } = require('./src/auditEngine');

  await initDb();
  console.log('DB initialized');

  const wb = waybillRepo.create({
    waybill_no: 'WB-DEBUG-001',
    meat_type: '冷鲜猪肉',
    zone_code: 'CHILLED'
  });
  console.log('Waybill created:', wb);

  const segData = {
    waybill_no: 'WB-DEBUG-001',
    start_time: '2026-06-20T08:00:00',
    end_time: '2026-06-20T09:00:00',
    avg_temp: 2.0,
    min_temp: 1.5,
    max_temp: 2.8,
    sample_count: 60,
    location_name: '测试路段',
    door_open: 0,
    door_open_duration: 0,
    cooler_status: 'normal',
    device_id: 'DEV-001',
    raw_payload: null
  };
  console.log('Creating segment...');
  try {
    const seg = segmentRepo.create(segData);
    console.log('Segment created:', JSON.stringify(seg, null, 2));

    console.log('Running audit...');
    try {
      const audit = processSegmentAudit(seg);
      console.log('Audit result:', JSON.stringify(audit, null, 2));
    } catch (e) {
      console.log('Audit error:', e.message, e.stack);
    }
  } catch (e) {
    console.log('Segment create error:', e.message, e.stack);
  }
}

debug().catch(e => console.error('Fatal:', e));
