const http = require('http');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.resolve('./test_coldchain.db');
process.env.DB_PATH = TEST_DB;

function cleanupDb() {
  try {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  } catch (e) {}
}

cleanupDb();

const { createApp } = require('../src/app');
const PORT = 19876;
const BASE = 'http://localhost:' + PORT;

let passed = 0;
let failed = 0;
const results = [];

function httpRequest(method, urlPath, body) {
  return new Promise(function(resolve, reject) {
    const url = new URL(BASE + urlPath);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    results.push({ name: name, ok: true });
    console.log('  \u221a ' + name);
  } else {
    failed++;
    results.push({ name: name, ok: false, detail: detail });
    console.log('  \u00d7 ' + name + (detail ? ' - ' + detail : ''));
  }
}

async function runTests() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  \u8089\u7c7b\u51b7\u94fe\u6e29\u533a\u7a3d\u6838\u670d\u52a1 - \u96c6\u6210\u6d4b\u8bd5');
  console.log('='.repeat(60));

  const app = await createApp();
  const server = app.listen(PORT);
  await new Promise(function(r) { setTimeout(r, 200); });

  try {
    console.log('\n[1] \u57fa\u7840\u5065\u5eb7\u68c0\u67e5');
    let r = await httpRequest('GET', '/health');
    assert('\u670d\u52a1\u5065\u5eb7\u68c0\u67e5\u8fd4\u56de200', r.status === 200, 'status=' + r.status);
    assert('health\u8fd4\u56destatus=ok', r.body && r.body.status === 'ok');

    r = await httpRequest('GET', '/');
    assert('\u6839\u8def\u5f84\u8fd4\u56de\u670d\u52a1\u4fe1\u606f', r.body && r.body.service === 'meat-coldchain-audit');

    console.log('\n[2] \u6e29\u533a\u914d\u7f6e\u67e5\u8be2');
    r = await httpRequest('GET', '/api/zone-configs');
    assert('\u6e29\u533a\u914d\u7f6e\u67e5\u8be2\u6210\u529f', r.status === 200 && r.body.code === 0);
    const zones = r.body.data;
    assert('\u9884\u7f6e4\u4e2a\u6e29\u533a\u914d\u7f6e', zones && zones.length === 4);
    const chilled = zones.find(function(z) { return z.zone_code === 'CHILLED'; });
    assert('\u51b7\u85cf\u533a\u914d\u7f6e\u6b63\u786e (0-4\u2103)', chilled && chilled.min_temp === 0 && chilled.max_temp === 4);
    const frozen = zones.find(function(z) { return z.zone_code === 'FROZEN'; });
    assert('\u51b7\u51bb\u533a\u914d\u7f6e\u6b63\u786e (-25--15\u2103)', frozen && frozen.min_temp === -25 && frozen.max_temp === -15);

    console.log('\n[3] \u8fd0\u5355\u521b\u5efa\u4e0e\u67e5\u8be2');
    const waybillNo = 'WB-TEST-' + Date.now();
    const waybillData = {
      waybill_no: waybillNo,
      meat_type: '\u51b7\u9c9c\u732a\u8089',
      zone_code: 'CHILLED',
      shipper: 'XX\u5c60\u5bb0\u573a',
      consignee: 'YY\u751f\u9c9c\u8d85\u5e02',
      origin: '\u6cb3\u5357\u7701\u90d1\u5dde\u5e02',
      destination: '\u6e56\u5317\u7701\u6b66\u6c49\u5e02',
      planned_departure: '2026-06-20T08:00:00',
      planned_arrival: '2026-06-21T06:00:00'
    };
    r = await httpRequest('POST', '/api/waybills', waybillData);
    assert('\u521b\u5efa\u8fd0\u5355\u6210\u529f (201)', r.status === 201 && r.body.code === 0, 'status=' + r.status);
    assert('\u8fd0\u5355\u4fe1\u606f\u6b63\u786e', r.body.data && r.body.data.waybill_no === waybillNo);

    r = await httpRequest('GET', '/api/waybills/' + waybillNo);
    assert('\u67e5\u8be2\u8fd0\u5355\u6210\u529f', r.status === 200 && r.body.code === 0);
    assert('\u8fd0\u5355\u6e29\u533a\u6b63\u786e', r.body.data.zone_code === 'CHILLED');

    r = await httpRequest('GET', '/api/waybills/NOT_EXIST');
    assert('\u4e0d\u5b58\u5728\u8fd0\u5355\u8fd4\u56de404', r.status === 404);

    console.log('\n[4] \u6e29\u5ea6\u7247\u6bb5\u4e0a\u4f20 - \u6b63\u5e38\u6570\u636e');
    const normalSeg = {
      waybill_no: waybillNo,
      start_time: '2026-06-20T08:00:00',
      end_time: '2026-06-20T09:00:00',
      avg_temp: 2.0,
      min_temp: 1.5,
      max_temp: 2.8,
      sample_count: 60,
      location_lat: 34.7466,
      location_lng: 113.6253,
      location_name: '\u4eac\u6e2f\u6fb3\u9ad8\u901f\u90d1\u5dde\u6bb5',
      door_open: 0,
      door_open_duration: 0,
      cooler_status: 'normal',
      device_id: 'DEV-TRUCK-001'
    };
    r = await httpRequest('POST', '/api/segments', normalSeg);
    assert('\u6b63\u5e38\u6e29\u5ea6\u7247\u6bb5\u4e0a\u4f20\u6210\u529f', r.status === 201 && r.body.code === 0, 'status=' + r.status);
    if (r.body && r.body.data && r.body.data.audit) {
      let audit1 = r.body.data.audit;
      assert('\u6b63\u5e38\u7247\u6bb5\u5224\u5b9a\u4e3a normal', audit1.status === 'normal', 'status=' + audit1.status);
      assert('\u6e29\u5ea6\u72b6\u6001\u4e3a normal', audit1.temp_status === 'normal');
      assert('\u5f00\u95e8\u72b6\u6001\u4e3a normal', audit1.door_status === 'normal');
    }

    console.log('\n[5] \u6e29\u5ea6\u7247\u6bb5\u4e0a\u4f20 - \u8d85\u6e29\u6570\u636e\uff08\u8fdd\u89c4\uff09');
    const overTempSeg = {
      waybill_no: waybillNo,
      start_time: '2026-06-20T09:00:00',
      end_time: '2026-06-20T09:30:00',
      avg_temp: 8.5,
      min_temp: 7.0,
      max_temp: 10.0,
      sample_count: 30,
      location_name: '\u6f2f\u6cb3\u670d\u52a1\u533a',
      door_open: 1,
      door_open_duration: 600,
      cooler_status: 'idle',
      device_id: 'DEV-TRUCK-001'
    };
    r = await httpRequest('POST', '/api/segments', overTempSeg);
    assert('\u8d85\u6e29\u7247\u6bb5\u4e0a\u4f20\u6210\u529f', r.status === 201 && r.body.code === 0, 'status=' + r.status);
    if (r.body && r.body.data && r.body.data.audit) {
      let audit2 = r.body.data.audit;
      assert('\u8d85\u6e29\u7247\u6bb5\u5224\u5b9a\u4e3a violation', audit2.status === 'violation', '\u5b9e\u9645=' + audit2.status);
      assert('\u6e29\u5ea6\u72b6\u6001\u5305\u542b violation', audit2.temp_status.includes('violation'), '\u5b9e\u9645=' + audit2.temp_status);
    }

    console.log('\n[6] \u6e29\u5ea6\u7247\u6bb5\u4e0a\u4f20 - \u8f7b\u5fae\u9884\u8b66');
    const warningSeg = {
      waybill_no: waybillNo,
      start_time: '2026-06-20T09:30:00',
      end_time: '2026-06-20T09:40:00',
      avg_temp: 5.5,
      min_temp: 5.0,
      max_temp: 6.0,
      sample_count: 10,
      location_name: '\u4eac\u6e2f\u6fb3\u9ad8\u901f\u4fe1\u9633\u6bb5',
      door_open: 0,
      cooler_status: 'normal',
      device_id: 'DEV-TRUCK-001'
    };
    r = await httpRequest('POST', '/api/segments', warningSeg);
    assert('\u9884\u8b66\u7247\u6bb5\u4e0a\u4f20\u6210\u529f', r.status === 201 && r.body.code === 0);
    if (r.body && r.body.data && r.body.data.audit) {
      let audit3 = r.body.data.audit;
      assert('\u9884\u8b66\u7247\u6bb5\u5224\u5b9a\u4e3a warning \u6216 violation',
        audit3.status === 'warning' || audit3.status === 'violation', '\u5b9e\u9645=' + audit3.status);
    }

    console.log('\n[7] \u6279\u91cf\u4e0a\u4f20\u6e29\u5ea6\u7247\u6bb5');
    const batchSegments = [
      {
        waybill_no: waybillNo,
        start_time: '2026-06-20T10:00:00',
        end_time: '2026-06-20T11:00:00',
        avg_temp: 2.5,
        min_temp: 1.8,
        max_temp: 3.2,
        sample_count: 60,
        location_name: '\u9102\u5317\u6536\u8d39\u7ad9',
        door_open: 0,
        cooler_status: 'normal'
      },
      {
        waybill_no: waybillNo,
        start_time: '2026-06-20T11:00:00',
        end_time: '2026-06-20T12:00:00',
        avg_temp: -5.0,
        min_temp: -6.0,
        max_temp: -4.0,
        sample_count: 60,
        location_name: '\u6b66\u6c49\u7ed5\u57ce\u9ad8\u901f',
        door_open: 0,
        cooler_status: 'error'
      }
    ];
    r = await httpRequest('POST', '/api/segments/batch', { segments: batchSegments });
    assert('\u6279\u91cf\u4e0a\u4f20\u6210\u529f', r.status === 200 && r.body.code === 0);
    assert('\u6279\u91cf\u7ed3\u679c\u6570\u91cf\u6b63\u786e (2\u6761)', r.body.data && r.body.data.total === 2);
    if (r.body.data && r.body.data.results && r.body.data.results[1]) {
      assert('\u7b2c\u4e8c\u6761\u542b\u5236\u51b7\u673a\u6545\u969c\u5224\u5b9a\u4e3a violation',
        r.body.data.results[1].audit.status === 'violation',
        '\u5b9e\u9645=' + (r.body.data.results[1].audit ? r.body.data.results[1].audit.status : 'null'));
    }

    console.log('\n[8] \u8c03\u5ea6\u7cfb\u7edf - \u7a3d\u6838\u7ed3\u679c\u67e5\u8be2');
    r = await httpRequest('GET', '/api/audits/waybill/' + waybillNo);
    assert('\u7a3d\u6838\u7ed3\u679c\u67e5\u8be2\u6210\u529f', r.status === 200 && r.body.code === 0);
    const audits = r.body.data;
    assert('\u7a3d\u6838\u8bb0\u5f55\u6570\u91cf=5', audits.length === 5, '\u5b9e\u9645=' + audits.length);
    const hasViolation = audits.some(function(a) { return a.status === 'violation'; });
    const hasNormal = audits.some(function(a) { return a.status === 'normal'; });
    assert('\u5305\u542b violation \u8bb0\u5f55', hasViolation);
    assert('\u5305\u542b normal \u8bb0\u5f55', hasNormal);

    console.log('\n[9] \u5ba2\u6237\u7b7e\u6536\u7cfb\u7edf - \u6e29\u533a\u6458\u8981\u67e5\u8be2');
    r = await httpRequest('GET', '/api/summary/waybill/' + waybillNo);
    assert('\u6e29\u533a\u6458\u8981\u67e5\u8be2\u6210\u529f', r.status === 200 && r.body.code === 0);
    const summary = r.body.data;
    assert('\u6458\u8981 segment_count=5', summary.segment_count === 5);
    assert('\u72b6\u6001\u7edf\u8ba1\u6b63\u786e', summary.status_counts.violation >= 2);
    assert('\u6e29\u5ea6\u5cf0\u503c>=5\u2103', summary.temp_violations.max_temp_peak != null && summary.temp_violations.max_temp_peak >= 5);
    assert('\u6e29\u5ea6\u8c37\u503c<=-4\u2103', summary.temp_violations.min_temp_trough != null && summary.temp_violations.min_temp_trough <= -4);
    assert('\u6709\u8d85\u6e29\u6b21\u6570\u7edf\u8ba1', summary.temp_violations.count >= 1);
    assert('\u6700\u957f\u6301\u7eed\u65f6\u95f4\u5df2\u7edf\u8ba1', summary.temp_violations.longest_duration_minutes >= 0);
    assert('signoff_note \u5b57\u6bb5\u5b58\u5728', typeof summary.signoff_note === 'string');
    assert('\u6458\u8981\u5305\u542b period_breakdown \u65f6\u6bb5\u5206\u5e03', !!summary.period_breakdown);
    assert('period_breakdown \u542b\u56db\u4e2a\u65f6\u6bb5',
      summary.period_breakdown.dawn && summary.period_breakdown.morning &&
      summary.period_breakdown.afternoon && summary.period_breakdown.evening);
    assert('morning \u65f6\u6bb5\u6709\u7247\u6bb5\u6570\u636e', summary.period_breakdown.morning.segment_count > 0,
      '\u5b9e\u9645=' + summary.period_breakdown.morning.segment_count);
    assert('period_breakdown \u542b\u5f00\u95e8\u5f02\u5e38\u5b57\u6bb5',
      typeof summary.period_breakdown.morning.door_incidents === 'number');
    assert('period_breakdown \u542b\u77ac\u65f6\u4e25\u91cd\u8d85\u6e29\u5b57\u6bb5',
      typeof summary.period_breakdown.morning.peak_violations === 'number');

    console.log('\n[10] \u5ba2\u670d\u7cfb\u7edf - \u4e89\u8bae\u8bc1\u636e\u751f\u6210');
    r = await httpRequest('POST', '/api/evidence/' + waybillNo, { dispute_type: 'customer_complaint' });
    assert('\u8bc1\u636e\u751f\u6210\u6210\u529f', r.status === 200 && r.body.code === 0);
    const evidence = r.body.data;
    assert('evidence_id \u5b58\u5728', !!evidence.evidence_id);
    assert('\u5305\u542b waybill \u4fe1\u606f', evidence.waybill && evidence.waybill.waybill_no === waybillNo);
    assert('\u5305\u542b zone_requirement', evidence.zone_requirement && evidence.zone_requirement.zone_code === 'CHILLED');
    assert('\u5305\u542b temperature_analysis', !!evidence.temperature_analysis);
    assert('\u5305\u542b door_records', !!evidence.door_records);
    assert('\u5305\u542b location_stops', !!evidence.location_stops && evidence.location_stops.length >= 1);
    assert('\u5305\u542b timeline \u65f6\u95f4\u7ebf', !!evidence.timeline && evidence.timeline.length >= 1);
    assert('\u5305\u542b conclusion \u7ed3\u8bba', typeof evidence.conclusion === 'string' && evidence.conclusion.length > 0);
    assert('\u5305\u542b recommendations \u5efa\u8bae', Array.isArray(evidence.recommendations) && evidence.recommendations.length >= 1);
    assert('\u6e29\u5ea6\u5206\u6790\u542b\u5cf0\u503c\u8bb0\u5f55', evidence.temperature_analysis.peak_temp != null);
    assert('\u5305\u542b text_conclusion \u6587\u672c\u7248\u7ed3\u8bba', typeof evidence.text_conclusion === 'string' && evidence.text_conclusion.length > 0);
    assert('text_conclusion \u542b\u7a3d\u6838\u62a5\u544a\u6807\u9898', evidence.text_conclusion.includes('\u51b7\u94fe\u6e29\u533a\u7a3d\u6838\u62a5\u544a'));
    assert('text_conclusion \u542b\u65f6\u6bb5\u5f02\u5e38\u5206\u5e03', evidence.text_conclusion.includes('\u65f6\u6bb5\u5f02\u5e38\u5206\u5e03'));
    assert('text_conclusion \u542b\u5173\u952e\u5f02\u5e38\u65f6\u95f4\u7ebf', evidence.text_conclusion.includes('\u5173\u952e\u5f02\u5e38\u65f6\u95f4\u7ebf'));
    assert('text_conclusion \u542b\u5904\u7406\u5efa\u8bae', evidence.text_conclusion.includes('\u5904\u7406\u5efa\u8bae'));
    assert('\u8bc1\u636e\u6458\u8981\u542b period_breakdown', !!evidence.summary.period_breakdown);
    assert('\u6e29\u5ea6\u5206\u6790\u542b peak_violation_count',
      typeof evidence.temperature_analysis.peak_violation_count === 'number');
    assert('\u8fdd\u89c4\u7247\u6bb5\u542b is_peak_violation \u6807\u8bc6',
      evidence.temperature_analysis.violation_segments.some(function(v) { return typeof v.is_peak_violation === 'boolean'; }));

    console.log('\n[11] \u53c2\u6570\u6821\u9a8c');
    r = await httpRequest('POST', '/api/segments', { waybill_no: waybillNo });
    assert('\u7f3a\u5931\u5b57\u6bb5\u8fd4\u56de400', r.status === 400);
    r = await httpRequest('POST', '/api/segments', {
      waybill_no: 'NOT_EXIST',
      start_time: '2026-06-20T08:00:00',
      end_time: '2026-06-20T09:00:00',
      avg_temp: 2.0,
      min_temp: 1.0,
      max_temp: 3.0
    });
    assert('\u4e0d\u5b58\u5728\u7684\u8fd0\u5355\u8fd4\u56de404', r.status === 404);

    console.log('\n[12] \u8fd0\u5355\u5206\u6bb5\u5217\u8868\u67e5\u8be2');
    r = await httpRequest('GET', '/api/segments/waybill/' + waybillNo);
    assert('\u5206\u6bb5\u5217\u8868\u67e5\u8be2\u6210\u529f', r.status === 200 && r.body.code === 0);
    assert('\u5206\u6bb5\u6570\u91cf=5', r.body.data.length === 5);

    console.log('\n[13] \u8fd0\u5355\u521b\u5efa - \u4e0d\u652f\u6301\u7684\u6e29\u533a\u7f16\u7801\u62e6\u622a');
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: 'WB-INVALID-ZONE',
      meat_type: '\u6d4b\u8bd5\u8089',
      zone_code: 'NONEXIST_ZONE'
    });
    assert('\u4e0d\u652f\u6301\u7684\u6e29\u533a\u7f16\u7801\u8fd4\u56de400', r.status === 400, 'status=' + r.status);
    assert('\u9519\u8bef\u4fe1\u606f\u5305\u542b\u4e0d\u652f\u6301\u7684\u7f16\u7801',
      r.body && r.body.error && r.body.error.includes('NONEXIST_ZONE'), '\u5b9e\u9645=' + (r.body ? r.body.error : 'null'));
    assert('\u9519\u8bef\u4fe1\u606f\u5305\u542b\u652f\u6301\u7684\u7f16\u7801\u5217\u8868',
      r.body && r.body.error && r.body.error.includes('CHILLED'), '\u5b9e\u9645=' + (r.body ? r.body.error : 'null'));

    console.log('\n[14] \u5cf0\u503c\u77ac\u65f6\u4e25\u91cd\u8d85\u6e29 - \u5747\u503c\u672a\u8d85\u4f46\u5cf0\u503c\u8d85\u8fc72\u500d\u7f13\u51b2');
    const peakWaybillNo = 'WB-PEAK-' + Date.now();
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: peakWaybillNo,
      meat_type: '\u51b7\u9c9c\u725b\u8089',
      zone_code: 'CHILLED'
    });
    assert('\u5cf0\u503c\u6d4b\u8bd5\u8fd0\u5355\u521b\u5efa\u6210\u529f', r.status === 201);

    const peakViolationSeg = {
      waybill_no: peakWaybillNo,
      start_time: '2026-06-20T14:00:00',
      end_time: '2026-06-20T14:15:00',
      avg_temp: 3.5,
      min_temp: 2.0,
      max_temp: 9.5,
      sample_count: 15,
      location_name: '\u670d\u52a1\u533a\u88c5\u5378',
      door_open: 0,
      door_open_duration: 0,
      cooler_status: 'normal'
    };
    r = await httpRequest('POST', '/api/segments', peakViolationSeg);
    assert('\u5cf0\u503c\u77ac\u65f6\u8d85\u6e29\u7247\u6bb5\u4e0a\u4f20\u6210\u529f', r.status === 201 && r.body.code === 0);
    if (r.body && r.body.data && r.body.data.audit) {
      const peakAudit = r.body.data.audit;
      assert('\u5cf0\u503c\u77ac\u65f6\u8d85\u6e29\u5224\u5b9a\u4e3a violation', peakAudit.status === 'violation',
        '\u5b9e\u9645=' + peakAudit.status);
      assert('\u6e29\u5ea6\u72b6\u6001\u4e3a peak_violation_high',
        peakAudit.temp_status === 'peak_violation_high',
        '\u5b9e\u9645=' + peakAudit.temp_status);
      assert('details \u542b isPeakViolation=true',
        peakAudit.details && peakAudit.details.temperature.isPeakViolation === true,
        '\u5b9e\u9645=' + JSON.stringify(peakAudit.details && peakAudit.details.temperature.isPeakViolation));
    }

    console.log('\n[15] \u5cf0\u503c\u6d4b\u8bd5 - \u5cf0\u503c\u8d85\u6e29\u533a\u4f46\u672a\u8d852\u500d\u7f13\u51b2\uff08\u4ec5\u9884\u8b66\uff09');
    const peakWarningWaybillNo = 'WB-PEAKWARN-' + Date.now();
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: peakWarningWaybillNo,
      meat_type: '\u51b7\u9c9c\u732a\u8089',
      zone_code: 'CHILLED'
    });

    const peakWarningSeg = {
      waybill_no: peakWarningWaybillNo,
      start_time: '2026-06-20T14:00:00',
      end_time: '2026-06-20T14:15:00',
      avg_temp: 3.0,
      min_temp: 1.5,
      max_temp: 5.5,
      sample_count: 15,
      location_name: '\u6b63\u5e38\u8fd0\u8f93',
      door_open: 0,
      door_open_duration: 0,
      cooler_status: 'normal'
    };
    r = await httpRequest('POST', '/api/segments', peakWarningSeg);
    assert('\u5cf0\u503c\u8d85\u6e29\u533a\u4f46\u672a\u8d852\u500d\u7f13\u51b2\u7247\u6bb5\u4e0a\u4f20\u6210\u529f', r.status === 201);
    if (r.body && r.body.data && r.body.data.audit) {
      const warnAudit = r.body.data.audit;
      assert('\u672a\u8d852\u500d\u7f13\u51b2\u7684\u5cf0\u503c\u4e0d\u5224\u5b9a\u4e3a peak_violation',
        warnAudit.temp_status !== 'peak_violation_high' && warnAudit.temp_status !== 'peak_violation_low',
        '\u5b9e\u9645=' + warnAudit.temp_status);
    }

    console.log('\n[16] \u6458\u8981\u65f6\u6bb5\u5206\u5e03 - \u591a\u65f6\u6bb5\u6570\u636e');
    const multiPeriodWaybillNo = 'WB-MULTI-' + Date.now();
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: multiPeriodWaybillNo,
      meat_type: '\u51bb\u732a\u8089',
      zone_code: 'FROZEN'
    });

    const multiSegs = [
      {
        waybill_no: multiPeriodWaybillNo,
        start_time: '2026-06-20T02:00:00',
        end_time: '2026-06-20T03:00:00',
        avg_temp: -18, min_temp: -20, max_temp: -16,
        sample_count: 60, location_name: '\u51cc\u6668\u8fd0\u8f93', door_open: 0, cooler_status: 'normal'
      },
      {
        waybill_no: multiPeriodWaybillNo,
        start_time: '2026-06-20T03:00:00',
        end_time: '2026-06-20T04:00:00',
        avg_temp: -10, min_temp: -12, max_temp: -8,
        sample_count: 60, location_name: '\u51cc\u6668\u88c5\u5378', door_open: 1, door_open_duration: 300, cooler_status: 'idle'
      },
      {
        waybill_no: multiPeriodWaybillNo,
        start_time: '2026-06-20T10:00:00',
        end_time: '2026-06-20T11:00:00',
        avg_temp: -19, min_temp: -21, max_temp: -17,
        sample_count: 60, location_name: '\u767d\u5929\u8fd0\u8f93', door_open: 0, cooler_status: 'normal'
      },
      {
        waybill_no: multiPeriodWaybillNo,
        start_time: '2026-06-20T20:00:00',
        end_time: '2026-06-20T21:00:00',
        avg_temp: -5, min_temp: -7, max_temp: -3,
        sample_count: 60, location_name: '\u665a\u95f4\u8fd0\u8f93', door_open: 0, cooler_status: 'error'
      }
    ];
    r = await httpRequest('POST', '/api/segments/batch', { segments: multiSegs });
    assert('\u591a\u65f6\u6bb5\u6279\u91cf\u4e0a\u4f20\u6210\u529f', r.status === 200 && r.body.code === 0);

    r = await httpRequest('GET', '/api/summary/waybill/' + multiPeriodWaybillNo);
    assert('\u591a\u65f6\u6bb5\u6458\u8981\u67e5\u8be2\u6210\u529f', r.status === 200 && r.body.code === 0);
    const multiSummary = r.body.data;
    assert('dawn \u65f6\u6bb5\u6709\u7247\u6bb5', multiSummary.period_breakdown.dawn.segment_count >= 1,
      '\u5b9e\u9645=' + multiSummary.period_breakdown.dawn.segment_count);
    assert('morning \u65f6\u6bb5\u6709\u7247\u6bb5', multiSummary.period_breakdown.morning.segment_count >= 1,
      '\u5b9e\u9645=' + multiSummary.period_breakdown.morning.segment_count);
    assert('evening \u65f6\u6bb5\u6709\u7247\u6bb5', multiSummary.period_breakdown.evening.segment_count >= 1,
      '\u5b9e\u9645=' + multiSummary.period_breakdown.evening.segment_count);
    assert('dawn \u542b\u6e29\u5ea6\u8fdd\u89c4', multiSummary.period_breakdown.dawn.temp_violations >= 1,
      '\u5b9e\u9645=' + multiSummary.period_breakdown.dawn.temp_violations);
    assert('dawn \u542b\u5f00\u95e8\u5f02\u5e38', multiSummary.period_breakdown.dawn.door_incidents >= 1,
      '\u5b9e\u9645=' + multiSummary.period_breakdown.dawn.door_incidents);
    assert('evening \u542b\u6e29\u5ea6\u8fdd\u89c4', multiSummary.period_breakdown.evening.temp_violations >= 1);

    console.log('\n[17] \u6587\u672c\u7248\u8bc1\u636e - \u5b8c\u6574\u6027\u68c0\u67e5');
    r = await httpRequest('POST', '/api/evidence/' + multiPeriodWaybillNo, { dispute_type: 'quality_dispute' });
    assert('\u591a\u65f6\u6bb5\u8bc1\u636e\u751f\u6210\u6210\u529f', r.status === 200 && r.body.code === 0);
    const multiEvidence = r.body.data;
    assert('\u8bc1\u636e\u542b text_conclusion', typeof multiEvidence.text_conclusion === 'string');
    assert('\u6587\u672c\u7248\u542b\u8fd0\u5355\u7f16\u53f7', multiEvidence.text_conclusion.includes(multiPeriodWaybillNo));
    assert('\u6587\u672c\u7248\u542b\u6e29\u533a\u8981\u6c42', multiEvidence.text_conclusion.includes('\u6e29\u533a\u8981\u6c42'));
    assert('\u6587\u672c\u7248\u542b\u7a3d\u6838\u7ed3\u8bba', multiEvidence.text_conclusion.includes('\u7a3d\u6838\u7ed3\u8bba'));
    assert('\u6587\u672c\u7248\u542b\u6570\u636e\u7edf\u8ba1', multiEvidence.text_conclusion.includes('\u6570\u636e\u7edf\u8ba1'));
    assert('\u6587\u672c\u7248\u542b\u65f6\u6bb5\u5f02\u5e38\u5206\u5e03', multiEvidence.text_conclusion.includes('\u65f6\u6bb5\u5f02\u5e38\u5206\u5e03'));
    assert('\u6587\u672c\u7248\u542b\u5173\u952e\u5f02\u5e38\u65f6\u95f4\u7ebf', multiEvidence.text_conclusion.includes('\u5173\u952e\u5f02\u5e38\u65f6\u95f4\u7ebf'));
    assert('\u6587\u672c\u7248\u542b\u5904\u7406\u5efa\u8bae', multiEvidence.text_conclusion.includes('\u5904\u7406\u5efa\u8bae'));
    assert('\u6587\u672c\u7248\u542b\u62a5\u544a\u751f\u6210\u65f6\u95f4', multiEvidence.text_conclusion.includes('\u62a5\u544a\u751f\u6210\u65f6\u95f4'));
    assert('\u6587\u672c\u7248\u5f02\u5e38\u65f6\u95f4\u7ebf\u542b VIOLATION',
      multiEvidence.text_conclusion.includes('VIOLATION') || multiEvidence.text_conclusion.includes('WARNING'));

  } catch (e) {
    console.error('\u6d4b\u8bd5\u8fd0\u884c\u51fa\u9519:', e);
    failed++;
  } finally {
    server.close(function() {
      console.log('');
      console.log('='.repeat(60));
      console.log('  \u6d4b\u8bd5\u5b8c\u6210');
      console.log('  \u901a\u8fc7: ' + passed);
      console.log('  \u5931\u8d25: ' + failed);
      console.log('  \u603b\u8ba1: ' + (passed + failed));
      console.log('='.repeat(60));
      if (failed > 0) {
        console.log('');
        console.log('  \u5931\u8d25\u8be6\u60c5:');
        results.filter(function(r) { return !r.ok; }).forEach(function(r) {
          console.log('    - ' + r.name + (r.detail ? ' (' + r.detail + ')' : ''));
        });
      }
      setTimeout(function() {
        cleanupDb();
        process.exit(failed > 0 ? 1 : 0);
      }, 500);
    });
  }
}

runTests().catch(function(e) {
  console.error('\u81f4\u547d\u9519\u8bef:', e);
  process.exit(1);
});
