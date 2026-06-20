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

    console.log('\n[18] 签收风险评估 - 正常运单建议签收');
    const safeWaybillNo = 'TEST-SAFE-001';
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: safeWaybillNo,
      meat_type: '冷鲜猪肉',
      zone_code: 'CHILLED',
      shipper: '双汇食品',
      consignee: '某超市',
      origin: '河南漯河',
      destination: '上海浦东'
    });
    assert('安全运单创建成功', r.status === 201 && r.body.code === 0);

    r = await httpRequest('POST', '/api/segments/batch', {
      segments: [
        { waybill_no: safeWaybillNo, start_time: '2026-06-21T08:00:00', end_time: '2026-06-21T10:00:00',
          avg_temp: 2, min_temp: 0, max_temp: 3, location_name: '高速路段', door_open: 0, cooler_status: 'normal' },
        { waybill_no: safeWaybillNo, start_time: '2026-06-21T10:00:00', end_time: '2026-06-21T12:00:00',
          avg_temp: 2.5, min_temp: 1, max_temp: 3.5, location_name: '服务区', door_open: 0, cooler_status: 'normal' }
      ]
    });
    assert('安全运单片段上传成功', r.status === 200 && r.body.data.success === 2);

    r = await httpRequest('GET', '/api/summary/waybill/' + safeWaybillNo);
    assert('安全运单摘要查询成功', r.status === 200 && r.body.code === 0);
    const safeSummary = r.body.data;
    assert('含 signoff_risk 字段', safeSummary.signoff_risk != null);
    assert('正常运单建议签收', safeSummary.signoff_risk.level === 'suggest_signoff',
      '实际=' + safeSummary.signoff_risk.level);
    assert('签收标签正确', safeSummary.signoff_risk.label === '建议签收');
    assert('有风险因素数组', Array.isArray(safeSummary.signoff_risk.factors) && safeSummary.signoff_risk.factors.length > 0);
    assert('affects_signoff 为 false', safeSummary.affects_signoff === false);
    assert('signoff_note 包含正常签收', safeSummary.signoff_note.includes('正常签收') || safeSummary.signoff_note.includes('可正常签收'));

    console.log('\n[19] 签收风险评估 - 严重违规建议拒收');
    const badWaybillNo = 'TEST-BAD-001';
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: badWaybillNo,
      meat_type: '冷鲜牛肉',
      zone_code: 'CHILLED'
    });
    assert('严重违规运单创建成功', r.status === 201 && r.body.code === 0);

    r = await httpRequest('POST', '/api/segments/batch', {
      segments: [
        { waybill_no: badWaybillNo, start_time: '2026-06-21T08:00:00', end_time: '2026-06-21T09:00:00',
          avg_temp: 8, min_temp: 6, max_temp: 10, location_name: '在途', door_open: 0, cooler_status: 'error' },
        { waybill_no: badWaybillNo, start_time: '2026-06-21T09:00:00', end_time: '2026-06-21T10:00:00',
          avg_temp: 9, min_temp: 7, max_temp: 11, location_name: '在途', door_open: 1, door_open_duration: 600, cooler_status: 'error' },
        { waybill_no: badWaybillNo, start_time: '2026-06-21T10:00:00', end_time: '2026-06-21T11:00:00',
          avg_temp: 12, min_temp: 10, max_temp: 14, location_name: '在途', door_open: 1, door_open_duration: 900, cooler_status: 'error' },
        { waybill_no: badWaybillNo, start_time: '2026-06-21T11:00:00', end_time: '2026-06-21T12:00:00',
          avg_temp: 2, min_temp: 0, max_temp: 4, location_name: '在途', door_open: 0, cooler_status: 'normal' }
      ]
    });
    assert('严重违规片段上传成功', r.status === 200 && r.body.data.success === 4);

    r = await httpRequest('GET', '/api/summary/waybill/' + badWaybillNo);
    assert('严重违规摘要查询成功', r.status === 200 && r.body.code === 0);
    const badSummary = r.body.data;
    assert('违规次数>=3触发拒收', badSummary.signoff_risk.level === 'rejection_recommended',
      '实际=' + badSummary.signoff_risk.level + ' 违规数=' + badSummary.status_counts.violation);
    assert('拒收标签正确', badSummary.signoff_risk.label === '建议拒收');
    assert('风险因素包含多个项', badSummary.signoff_risk.factors.length >= 2);
    assert('affects_signoff 为 true', badSummary.affects_signoff === true);
    assert('signoff_note 包含拒收', badSummary.signoff_note.includes('拒收'));

    console.log('\n[20] 运输阶段分布 - 自动归类');
    const stageWaybillNo = 'TEST-STAGE-001';
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: stageWaybillNo,
      meat_type: '冻猪肉',
      zone_code: 'FROZEN'
    });
    assert('阶段测试运单创建成功', r.status === 201 && r.body.code === 0);

    r = await httpRequest('POST', '/api/segments/batch', {
      segments: [
        { waybill_no: stageWaybillNo, start_time: '2026-06-21T08:00:00', end_time: '2026-06-21T10:00:00',
          avg_temp: -20, min_temp: -22, max_temp: -18, sample_count: 60,
          location_name: '京港澳高速路段', door_open: 0, cooler_status: 'normal' },
        { waybill_no: stageWaybillNo, start_time: '2026-06-21T10:00:00', end_time: '2026-06-21T10:30:00',
          avg_temp: -19, min_temp: -21, max_temp: -17, sample_count: 30,
          location_name: '保定服务区', door_open: 0, cooler_status: 'idle' },
        { waybill_no: stageWaybillNo, start_time: '2026-06-21T10:30:00', end_time: '2026-06-21T12:00:00',
          avg_temp: -8, min_temp: -12, max_temp: -2, sample_count: 90,
          location_name: '北京冷库卸货', door_open: 1, door_open_duration: 5400, cooler_status: 'normal' }
      ]
    });
    assert('阶段测试片段上传成功', r.status === 200 && r.body.data.success === 3);

    r = await httpRequest('GET', '/api/summary/waybill/' + stageWaybillNo);
    assert('阶段测试摘要查询成功', r.status === 200 && r.body.code === 0);
    const stageSummary = r.body.data;
    assert('摘要含 stage_breakdown', stageSummary.stage_breakdown != null);
    assert('stage_breakdown 含 in_transit', stageSummary.stage_breakdown.in_transit != null);
    assert('stage_breakdown 含 stop', stageSummary.stage_breakdown.stop != null);
    assert('stage_breakdown 含 loading_unloading', stageSummary.stage_breakdown.loading_unloading != null);
    assert('在途阶段有片段', stageSummary.stage_breakdown.in_transit.segment_count >= 1);
    assert('装卸阶段有开门记录', stageSummary.stage_breakdown.loading_unloading.door_incidents >= 1);

    console.log('\n[21] 运输阶段 - 显式传transport_stage字段');
    const explicitStageWaybill = 'TEST-STAGE-EXP-001';
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: explicitStageWaybill, meat_type: '冻牛肉', zone_code: 'FROZEN'
    });
    assert('显式阶段运单创建成功', r.status === 201 && r.body.code === 0);

    r = await httpRequest('POST', '/api/segments', {
      waybill_no: explicitStageWaybill,
      start_time: '2026-06-22T08:00:00', end_time: '2026-06-22T09:00:00',
      avg_temp: -20, min_temp: -22, max_temp: -18,
      location_name: '测试地点',
      transport_stage: 'loading_unloading',
      door_open: 0, cooler_status: 'normal'
    });
    assert('显式阶段片段上传成功', r.status === 201 && r.body.code === 0);
    assert('稽核结果含 transport_stage 字段', r.body.data.audit.transport_stage === 'loading_unloading',
      '实际=' + r.body.data.audit.transport_stage);

    console.log('\n[22] 多视角证据 - 内部版 vs 客户版');
    r = await httpRequest('POST', '/api/evidence/' + badWaybillNo, { dispute_type: 'customer_complaint', audience: 'internal' });
    assert('内部版证据生成成功', r.status === 200 && r.body.code === 0);
    const internalEvidence = r.body.data;
    assert('内部版 audience=internal', internalEvidence.audience === 'internal');
    assert('内部版含完整时间线', Array.isArray(internalEvidence.timeline) && internalEvidence.timeline.length > 0);
    assert('内部版含违规片段明细', Array.isArray(internalEvidence.temperature_analysis.violation_segments) && internalEvidence.temperature_analysis.violation_segments.length > 0);
    assert('内部版含时段分布', internalEvidence.summary.period_breakdown != null);
    assert('内部版含阶段分布', internalEvidence.summary.stage_breakdown != null);
    assert('内部版文本含数据统计章节', internalEvidence.text_conclusion.includes('数据统计'));
    assert('内部版文本含时段异常分布', internalEvidence.text_conclusion.includes('时段异常分布'));
    assert('内部版文本含运输阶段分布', internalEvidence.text_conclusion.includes('运输阶段异常分布'));

    r = await httpRequest('POST', '/api/evidence/' + badWaybillNo, { dispute_type: 'customer_complaint', audience: 'customer' });
    assert('客户版证据生成成功', r.status === 200 && r.body.code === 0);
    const customerEvidence = r.body.data;
    assert('客户版 audience=customer', customerEvidence.audience === 'customer');
    assert('客户版时间线为空', Array.isArray(customerEvidence.timeline) && customerEvidence.timeline.length === 0);
    assert('客户版违规片段为空', Array.isArray(customerEvidence.temperature_analysis.violation_segments) && customerEvidence.temperature_analysis.violation_segments.length === 0);
    assert('客户版文本不含数据统计章节', !customerEvidence.text_conclusion.includes('数据统计'));
    assert('客户版文本标题含客户版', customerEvidence.text_conclusion.includes('客户版'));

    r = await httpRequest('POST', '/api/evidence/' + badWaybillNo, { audience: 'invalid' });
    assert('非法audience返回400', r.status === 400);

    console.log('\n[23] 稽核结果筛选 - 按状态筛选');
    r = await httpRequest('GET', '/api/audits/waybill/' + badWaybillNo + '?status=violation');
    assert('按violation筛选成功', r.status === 200 && r.body.code === 0);
    const violationOnly = r.body.data;
    assert('只返回violation状态记录', violationOnly.length > 0 && violationOnly.every(function(a) { return a.status === 'violation'; }),
      '数量=' + violationOnly.length);

    r = await httpRequest('GET', '/api/audits/waybill/' + badWaybillNo + '?status=violation&status=manual_review');
    assert('多状态筛选成功', r.status === 200 && r.body.code === 0);
    const multiStatus = r.body.data;
    assert('多状态筛选数量>=单状态', multiStatus.length >= violationOnly.length);

    r = await httpRequest('GET', '/api/audits/waybill/' + badWaybillNo + '?status=normal');
    assert('按normal筛选返回正常片段', r.status === 200 && r.body.code === 0);
    assert('只返回normal状态', r.body.data.every(function(a) { return a.status === 'normal'; }));

    console.log('\n[24] 稽核结果筛选 - 按时间范围筛选');
    r = await httpRequest('GET', '/api/audits/waybill/' + badWaybillNo + '?start_time=2026-06-21T08:30:00&end_time=2026-06-21T10:30:00');
    assert('时间范围筛选成功', r.status === 200 && r.body.code === 0);
    const timeFiltered = r.body.data;
    assert('时间范围内片段数正确', timeFiltered.length >= 2 && timeFiltered.length <= 3, '实际=' + timeFiltered.length);
    assert('返回的filters信息正确', r.body.filters && r.body.filters.start_time != null);

    r = await httpRequest('GET', '/api/audits/waybill/' + badWaybillNo + '?status=violation&start_time=2026-06-21T08:00:00&end_time=2026-06-21T11:00:00');
    assert('状态+时间联合筛选成功', r.status === 200 && r.body.code === 0);
    const combinedFilter = r.body.data;
    assert('联合筛选结果均为violation', combinedFilter.every(function(a) { return a.status === 'violation'; }));

    console.log('\n[25] 数据库迁移兼容 - 老库无transport_stage列不报错');
    const migWaybillNo = 'TEST-MIG-001';
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: migWaybillNo, meat_type: '冷鲜猪肉', zone_code: 'CHILLED'
    });
    assert('迁移测试运单创建成功', r.status === 201 && r.body.code === 0);
    r = await httpRequest('POST', '/api/segments', {
      waybill_no: migWaybillNo,
      start_time: '2026-06-22T08:00:00', end_time: '2026-06-22T10:00:00',
      avg_temp: 2, min_temp: 0, max_temp: 3,
      location_name: '普通路段', door_open: 0, cooler_status: 'normal'
    });
    assert('不带transport_stage的片段上传成功', r.status === 201 && r.body.code === 0);
    r = await httpRequest('GET', '/api/summary/waybill/' + migWaybillNo);
    assert('老片段查摘要不报500', r.status === 200 && r.body.code === 0);
    assert('摘要含stage_breakdown', r.body.data.stage_breakdown != null);

    console.log('\n[26] 责任倾向判定 - 承运方');
    r = await httpRequest('GET', '/api/summary/waybill/' + badWaybillNo);
    assert('违规运单摘要含 responsibility_tendency', r.body.data.responsibility_tendency != null);
    assert('责任倾向含 tendency 字段', r.body.data.responsibility_tendency.tendency != null);
    assert('责任倾向含 label 字段', typeof r.body.data.responsibility_tendency.label === 'string');
    assert('责任倾向含 reasoning 字段', typeof r.body.data.responsibility_tendency.reasoning === 'string');
    assert('推理说明含关键词', r.body.data.responsibility_tendency.reasoning.length > 0);

    console.log('\n[27] 责任倾向判定 - 设备方（制冷机故障为主）');
    const equipWaybillNo = 'TEST-EQUIP-001';
    r = await httpRequest('POST', '/api/waybills', {
      waybill_no: equipWaybillNo, meat_type: '冻猪肉', zone_code: 'FROZEN'
    });
    assert('设备方测试运单创建成功', r.status === 201 && r.body.code === 0);
    r = await httpRequest('POST', '/api/segments/batch', {
      segments: [
        { waybill_no: equipWaybillNo, start_time: '2026-06-22T08:00:00', end_time: '2026-06-22T10:00:00',
          avg_temp: -20, min_temp: -22, max_temp: -18, location_name: '在途', door_open: 0, cooler_status: 'error' },
        { waybill_no: equipWaybillNo, start_time: '2026-06-22T10:00:00', end_time: '2026-06-22T12:00:00',
          avg_temp: -20, min_temp: -22, max_temp: -18, location_name: '在途', door_open: 0, cooler_status: 'error' }
      ]
    });
    assert('设备方测试片段上传成功', r.status === 200 && r.body.data.success === 2);
    r = await httpRequest('GET', '/api/summary/waybill/' + equipWaybillNo);
    assert('设备方摘要含责任倾向', r.body.data.responsibility_tendency != null);
    assert('设备方责任倾向为equipment', r.body.data.responsibility_tendency.tendency === 'equipment',
      '实际=' + r.body.data.responsibility_tendency.tendency);

    console.log('\n[28] 质检联动 - 复核/拒收时给出抽检建议');
    r = await httpRequest('GET', '/api/summary/waybill/' + badWaybillNo);
    assert('拒收运单含 quality_inspection', r.body.data.quality_inspection != null);
    const qi = r.body.data.quality_inspection;
    assert('抽检优先级为high', qi.sampling_priority === 'high', '实际=' + qi.sampling_priority);
    assert('含抽检优先级标签', typeof qi.sampling_priority_label === 'string');
    assert('含建议抽检项目数组', Array.isArray(qi.suggested_items) && qi.suggested_items.length > 0);
    assert('含保留证据清单数组', Array.isArray(qi.evidence_retention_list) && qi.evidence_retention_list.length > 0);

    r = await httpRequest('GET', '/api/summary/waybill/' + safeWaybillNo);
    assert('正常运单无质检建议', r.body.data.quality_inspection == null || r.body.data.quality_inspection.sampling_priority == null);

    console.log('\n[29] 客户版证据保留运输阶段概览');
    r = await httpRequest('POST', '/api/evidence/' + badWaybillNo, { audience: 'customer' });
    assert('客户版证据含 stage_overview', r.body.data.summary.stage_overview != null);
    assert('stage_overview 非空字符串', r.body.data.summary.stage_overview.length > 0);
    assert('客户版文本含运输阶段概览章节', r.body.data.text_conclusion.includes('运输阶段概览'));
    assert('客户版责任倾向只有tendency和label', r.body.data.summary.responsibility_tendency != null && r.body.data.summary.responsibility_tendency.reasoning == null);
    assert('客户版质检建议项目精简', r.body.data.summary.quality_inspection != null && r.body.data.summary.quality_inspection.suggested_items.length <= 2);
    assert('客户版证据清单精简', r.body.data.summary.quality_inspection.evidence_retention_list.length <= 3);

    console.log('\n[30] 处置单导出 - 内部版');
    r = await httpRequest('POST', '/api/disposal/' + badWaybillNo, { audience: 'internal' });
    assert('处置单生成成功', r.status === 200 && r.body.code === 0);
    const disposal = r.body.data;
    assert('处置单含 disposal_id', disposal.disposal_id != null && disposal.disposal_id.startsWith('DISPOSAL_'));
    assert('处置单含运单号', disposal.waybill_no === badWaybillNo);
    assert('处置单含签收建议', disposal.signoff_suggestion != null && disposal.signoff_suggestion.level != null);
    assert('处置单含责任倾向', disposal.responsibility_tendency != null);
    assert('处置单含质检建议', disposal.quality_inspection != null);
    assert('处置单含关键片段列表', Array.isArray(disposal.key_segments) && disposal.key_segments.length > 0);
    assert('关键片段含segment_id', disposal.key_segments[0].segment_id != null);
    assert('关键片段含transport_stage', disposal.key_segments[0].transport_stage != null);
    assert('处置单含文本结论', typeof disposal.text_conclusion === 'string');
    assert('内部版文本含责任倾向章节', disposal.text_conclusion.includes('责任倾向'));
    assert('内部版文本含质检建议章节', disposal.text_conclusion.includes('质检建议'));

    console.log('\n[31] 处置单导出 - 客户版');
    r = await httpRequest('POST', '/api/disposal/' + badWaybillNo, { audience: 'customer' });
    assert('客户版处置单生成成功', r.status === 200 && r.body.code === 0);
    const custDisposal = r.body.data;
    assert('客户版处置单含disposal_id', custDisposal.disposal_id != null);
    assert('客户版关键片段不超过3条', custDisposal.key_segments.length <= 3);
    assert('客户版关键片段不含segment_id', custDisposal.key_segments.every(function(s) { return s.segment_id == null; }));
    assert('客户版文本含责任说明', custDisposal.text_conclusion.includes('责任说明'));
    assert('客户版文本含质检提示', custDisposal.text_conclusion.includes('质检提示'));
    assert('客户版文本含运输阶段概览', custDisposal.text_conclusion.includes('运输阶段概览'));

    r = await httpRequest('POST', '/api/disposal/' + badWaybillNo, { audience: 'invalid' });
    assert('处置单非法audience返回400', r.status === 400);

    r = await httpRequest('POST', '/api/disposal/NONEXIST', { audience: 'internal' });
    assert('处置单不存在的运单返回404', r.status === 404);

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
