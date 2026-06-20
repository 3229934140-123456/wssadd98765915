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
    console.log('  ✓ ' + name);
  } else {
    failed++;
    results.push({ name: name, ok: false, detail: detail });
    console.log('  ✗ ' + name + (detail ? ' - ' + detail : ''));
  }
}

async function runTests() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  肉类冷链温区稽核服务 - 集成测试');
  console.log('='.repeat(60));

  const app = await createApp();
  const server = app.listen(PORT);
  await new Promise(function(r) { setTimeout(r, 200); });

  try {
    console.log('\n[1] 基础健康检查');
    let r = await httpRequest('GET', '/health');
    assert('服务健康检查返回200', r.status === 200, 'status=' + r.status);
    assert('health返回status=ok', r.body && r.body.status === 'ok');

    r = await httpRequest('GET', '/');
    assert('根路径返回服务信息', r.body && r.body.service === 'meat-coldchain-audit');

    console.log('\n[2] 温区配置查询');
    r = await httpRequest('GET', '/api/zone-configs');
    assert('温区配置查询成功', r.status === 200 && r.body.code === 0);
    const zones = r.body.data;
    assert('预置4个温区配置', zones && zones.length === 4);
    const chilled = zones.find(function(z) { return z.zone_code === 'CHILLED'; });
    assert('冷藏区配置正确 (0-4℃)', chilled && chilled.min_temp === 0 && chilled.max_temp === 4);
    const frozen = zones.find(function(z) { return z.zone_code === 'FROZEN'; });
    assert('冷冻区配置正确 (-25--15℃)', frozen && frozen.min_temp === -25 && frozen.max_temp === -15);

    console.log('\n[3] 运单创建与查询');
    const waybillNo = 'WB-TEST-' + Date.now();
    const waybillData = {
      waybill_no: waybillNo,
      meat_type: '冷鲜猪肉',
      zone_code: 'CHILLED',
      shipper: 'XX屠宰场',
      consignee: 'YY生鲜超市',
      origin: '河南省郑州市',
      destination: '湖北省武汉市',
      planned_departure: '2026-06-20T08:00:00',
      planned_arrival: '2026-06-21T06:00:00'
    };
    r = await httpRequest('POST', '/api/waybills', waybillData);
    assert('创建运单成功 (201)', r.status === 201 && r.body.code === 0, 'status=' + r.status);
    assert('运单信息正确', r.body.data && r.body.data.waybill_no === waybillNo);

    r = await httpRequest('GET', '/api/waybills/' + waybillNo);
    assert('查询运单成功', r.status === 200 && r.body.code === 0);
    assert('运单温区正确', r.body.data.zone_code === 'CHILLED');

    r = await httpRequest('GET', '/api/waybills/NOT_EXIST');
    assert('不存在运单返回404', r.status === 404);

    console.log('\n[4] 温度片段上传 - 正常数据');
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
      location_name: '京港澳高速郑州段',
      door_open: 0,
      door_open_duration: 0,
      cooler_status: 'normal',
      device_id: 'DEV-TRUCK-001'
    };
    r = await httpRequest('POST', '/api/segments', normalSeg);
    assert('正常温度片段上传成功', r.status === 201 && r.body.code === 0, 'status=' + r.status + ' msg=' + (r.body ? r.body.error : ''));
    if (r.body && r.body.data && r.body.data.audit) {
      let audit1 = r.body.data.audit;
      assert('正常片段判定为 normal', audit1.status === 'normal', 'status=' + audit1.status);
      assert('温度状态为 normal', audit1.temp_status === 'normal');
      assert('开门状态为 normal', audit1.door_status === 'normal');
    }

    console.log('\n[5] 温度片段上传 - 超温数据（违规）');
    const overTempSeg = {
      waybill_no: waybillNo,
      start_time: '2026-06-20T09:00:00',
      end_time: '2026-06-20T09:30:00',
      avg_temp: 8.5,
      min_temp: 7.0,
      max_temp: 10.0,
      sample_count: 30,
      location_name: '漯河服务区',
      door_open: 1,
      door_open_duration: 600,
      cooler_status: 'idle',
      device_id: 'DEV-TRUCK-001'
    };
    r = await httpRequest('POST', '/api/segments', overTempSeg);
    assert('超温片段上传成功', r.status === 201 && r.body.code === 0, 'status=' + r.status);
    if (r.body && r.body.data && r.body.data.audit) {
      let audit2 = r.body.data.audit;
      assert('超温片段判定为 violation', audit2.status === 'violation', '实际=' + audit2.status);
      assert('温度状态为 violation_high', audit2.temp_status === 'violation_high');
    }

    console.log('\n[6] 温度片段上传 - 轻微预警');
    const warningSeg = {
      waybill_no: waybillNo,
      start_time: '2026-06-20T09:30:00',
      end_time: '2026-06-20T09:40:00',
      avg_temp: 5.5,
      min_temp: 5.0,
      max_temp: 6.0,
      sample_count: 10,
      location_name: '京港澳高速信阳段',
      door_open: 0,
      cooler_status: 'normal',
      device_id: 'DEV-TRUCK-001'
    };
    r = await httpRequest('POST', '/api/segments', warningSeg);
    assert('预警片段上传成功', r.status === 201 && r.body.code === 0);
    if (r.body && r.body.data && r.body.data.audit) {
      let audit3 = r.body.data.audit;
      assert('预警片段判定为 warning 或 violation',
        audit3.status === 'warning' || audit3.status === 'violation', '实际=' + audit3.status);
    }

    console.log('\n[7] 批量上传温度片段');
    const batchSegments = [
      {
        waybill_no: waybillNo,
        start_time: '2026-06-20T10:00:00',
        end_time: '2026-06-20T11:00:00',
        avg_temp: 2.5,
        min_temp: 1.8,
        max_temp: 3.2,
        sample_count: 60,
        location_name: '鄂北收费站',
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
        location_name: '武汉绕城高速',
        door_open: 0,
        cooler_status: 'error'
      }
    ];
    r = await httpRequest('POST', '/api/segments/batch', { segments: batchSegments });
    assert('批量上传成功', r.status === 200 && r.body.code === 0);
    assert('批量结果数量正确 (2条)', r.body.data && r.body.data.total === 2);
    if (r.body.data && r.body.data.results && r.body.data.results[1]) {
      assert('第二条含制冷机故障判定为 violation',
        r.body.data.results[1].audit.status === 'violation',
        '实际=' + (r.body.data.results[1].audit ? r.body.data.results[1].audit.status : 'null'));
    }

    console.log('\n[8] 调度系统 - 稽核结果查询');
    r = await httpRequest('GET', '/api/audits/waybill/' + waybillNo);
    assert('稽核结果查询成功', r.status === 200 && r.body.code === 0);
    const audits = r.body.data;
    assert('稽核记录数量=5', audits.length === 5, '实际=' + audits.length);
    const hasViolation = audits.some(function(a) { return a.status === 'violation'; });
    const hasNormal = audits.some(function(a) { return a.status === 'normal'; });
    assert('包含 violation 记录', hasViolation);
    assert('包含 normal 记录', hasNormal);

    console.log('\n[9] 客户签收系统 - 温区摘要查询');
    r = await httpRequest('GET', '/api/summary/waybill/' + waybillNo);
    assert('温区摘要查询成功', r.status === 200 && r.body.code === 0);
    const summary = r.body.data;
    assert('摘要 segment_count=5', summary.segment_count === 5);
    assert('状态统计正确', summary.status_counts.violation >= 2);
    assert('温度峰值>=5℃', summary.temp_violations.max_temp_peak != null && summary.temp_violations.max_temp_peak >= 5);
    assert('温度谷值<=-4℃', summary.temp_violations.min_temp_trough != null && summary.temp_violations.min_temp_trough <= -4);
    assert('有超温次数统计', summary.temp_violations.count >= 1);
    assert('最长持续时间已统计', summary.temp_violations.longest_duration_minutes >= 0);
    assert('signoff_note 字段存在', typeof summary.signoff_note === 'string');

    console.log('\n[10] 客服系统 - 争议证据生成');
    r = await httpRequest('POST', '/api/evidence/' + waybillNo, { dispute_type: 'customer_complaint' });
    assert('证据生成成功', r.status === 200 && r.body.code === 0);
    const evidence = r.body.data;
    assert('evidence_id 存在', !!evidence.evidence_id);
    assert('包含 waybill 信息', evidence.waybill && evidence.waybill.waybill_no === waybillNo);
    assert('包含 zone_requirement', evidence.zone_requirement && evidence.zone_requirement.zone_code === 'CHILLED');
    assert('包含 temperature_analysis', !!evidence.temperature_analysis);
    assert('包含 door_records', !!evidence.door_records);
    assert('包含 location_stops', !!evidence.location_stops && evidence.location_stops.length >= 1);
    assert('包含 timeline 时间线', !!evidence.timeline && evidence.timeline.length >= 1);
    assert('包含 conclusion 结论', typeof evidence.conclusion === 'string' && evidence.conclusion.length > 0);
    assert('包含 recommendations 建议', Array.isArray(evidence.recommendations) && evidence.recommendations.length >= 1);
    assert('温度分析含峰值记录', evidence.temperature_analysis.peak_temp != null);

    console.log('\n[11] 参数校验');
    r = await httpRequest('POST', '/api/segments', { waybill_no: waybillNo });
    assert('缺失字段返回400', r.status === 400);
    r = await httpRequest('POST', '/api/segments', {
      waybill_no: 'NOT_EXIST',
      start_time: '2026-06-20T08:00:00',
      end_time: '2026-06-20T09:00:00',
      avg_temp: 2.0,
      min_temp: 1.0,
      max_temp: 3.0
    });
    assert('不存在的运单返回404', r.status === 404);

    console.log('\n[12] 运单分段列表查询');
    r = await httpRequest('GET', '/api/segments/waybill/' + waybillNo);
    assert('分段列表查询成功', r.status === 200 && r.body.code === 0);
    assert('分段数量=5', r.body.data.length === 5);

  } catch (e) {
    console.error('测试运行出错:', e);
    failed++;
  } finally {
    server.close(function() {
      console.log('');
      console.log('='.repeat(60));
      console.log('  测试完成');
      console.log('  通过: ' + passed);
      console.log('  失败: ' + failed);
      console.log('  总计: ' + (passed + failed));
      console.log('='.repeat(60));
      if (failed > 0) {
        console.log('');
        console.log('  失败详情:');
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
  console.error('致命错误:', e);
  process.exit(1);
});
