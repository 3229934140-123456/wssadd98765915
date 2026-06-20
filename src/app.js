const express = require('express');
const bodyParser = require('body-parser');
const { initDb, zoneConfigRepo, waybillRepo, segmentRepo, auditRepo } = require('./db');
const { processSegmentAudit, summarizeWaybillAudit, generateEvidence } = require('./auditEngine');

let dbReady = false;
let dbInitPromise = null;

function ensureDbReady(req, res, next) {
  if (dbReady) return next();
  if (!dbInitPromise) {
    dbInitPromise = initDb().then(function() { dbReady = true; });
  }
  dbInitPromise.then(function() { next(); }).catch(function(e) {
    console.error('数据库初始化失败:', e);
    res.status(500).json({ code: 500, error: '数据库初始化失败: ' + e.message });
  });
}

async function createApp() {
  await initDb();
  dbReady = true;
  const app = express();

  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));

  app.use(function(req, res, next) {
    res.setHeader('X-Powered-By', 'ColdChainAudit/1.0');
    next();
  });

  app.get('/', function(req, res) {
    res.json({
      service: 'meat-coldchain-audit',
      version: '1.0.0',
      description: '肉类冷链温区稽核后端服务',
      endpoints: {
        zone_configs: 'GET /api/zone-configs',
        waybill_create: 'POST /api/waybills',
        waybill_get: 'GET /api/waybills/:waybillNo',
        segment_upload: 'POST /api/segments',
        segment_batch: 'POST /api/segments/batch',
        segments_list: 'GET /api/segments/waybill/:waybillNo',
        audit_results: 'GET /api/audits/waybill/:waybillNo',
        audit_summary: 'GET /api/summary/waybill/:waybillNo',
        evidence: 'POST /api/evidence/:waybillNo',
        health: 'GET /health'
      }
    });
  });

  app.get('/health', function(req, res) {
    res.json({ status: dbReady ? 'ok' : 'init', timestamp: new Date().toISOString() });
  });

  app.use(ensureDbReady);

  app.get('/api/zone-configs', function(req, res) {
    try {
      const configs = zoneConfigRepo.getAll();
      res.json({ code: 0, data: configs });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.post('/api/waybills', function(req, res) {
    try {
      const body = req.body;
      if (!body.waybill_no || !body.meat_type || !body.zone_code) {
        return res.status(400).json({ code: 400, error: 'waybill_no, meat_type, zone_code 必填' });
      }
      const zoneConfig = zoneConfigRepo.getByCode(body.zone_code);
      if (!zoneConfig) {
        const validCodes = zoneConfigRepo.getAll().map(function(z) { return z.zone_code; });
        return res.status(400).json({
          code: 400,
          error: '不支持的温区编码: ' + body.zone_code + '，当前支持的编码: ' + validCodes.join(', ')
        });
      }
      const existing = waybillRepo.getByNo(body.waybill_no);
      if (existing) {
        return res.json({ code: 0, data: existing, message: '运单已存在' });
      }
      const created = waybillRepo.create(body);
      res.status(201).json({ code: 0, data: created });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.get('/api/waybills/:waybillNo', function(req, res) {
    try {
      const waybill = waybillRepo.getByNo(req.params.waybillNo);
      if (!waybill) {
        return res.status(404).json({ code: 404, error: '运单不存在' });
      }
      res.json({ code: 0, data: waybill });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.post('/api/segments', function(req, res) {
    try {
      const body = req.body;
      if (!body.waybill_no || !body.start_time || !body.end_time ||
          body.avg_temp == null || body.min_temp == null || body.max_temp == null) {
        return res.status(400).json({
          code: 400,
          error: 'waybill_no, start_time, end_time, avg_temp, min_temp, max_temp 必填'
        });
      }
      if (!waybillRepo.getByNo(body.waybill_no)) {
        return res.status(404).json({ code: 404, error: '运单不存在，请先创建运单' });
      }
      body.sample_count = body.sample_count || 1;
      let rawPayload = null;
      if (body.raw_payload) {
        rawPayload = typeof body.raw_payload === 'string' ? body.raw_payload : JSON.stringify(body.raw_payload);
      }
      const segmentData = Object.assign({}, body, { raw_payload: rawPayload });
      const segment = segmentRepo.create(segmentData);
      const audit = processSegmentAudit(segment);
      const detailsParsed = audit.details ? JSON.parse(audit.details) : null;
      res.status(201).json({
        code: 0,
        data: {
          segment: segment,
          audit: Object.assign({}, audit, { details: detailsParsed })
        }
      });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.post('/api/segments/batch', function(req, res) {
    try {
      const body = req.body;
      if (!body.segments || !Array.isArray(body.segments)) {
        return res.status(400).json({ code: 400, error: 'segments 数组必填' });
      }
      const results = [];
      const errors = [];
      for (let i = 0; i < body.segments.length; i++) {
        const seg = body.segments[i];
        try {
          if (!seg.waybill_no || !seg.start_time || !seg.end_time ||
              seg.avg_temp == null || seg.min_temp == null || seg.max_temp == null) {
            errors.push({ index: i, error: '字段缺失' });
            continue;
          }
          if (!waybillRepo.getByNo(seg.waybill_no)) {
            errors.push({ index: i, error: '运单不存在' });
            continue;
          }
          seg.sample_count = seg.sample_count || 1;
          let rawPayload = null;
          if (seg.raw_payload) {
            rawPayload = typeof seg.raw_payload === 'string' ? seg.raw_payload : JSON.stringify(seg.raw_payload);
          }
          const segmentData = Object.assign({}, seg, { raw_payload: rawPayload });
          const segment = segmentRepo.create(segmentData);
          const audit = processSegmentAudit(segment);
          const detailsParsed = audit.details ? JSON.parse(audit.details) : null;
          results.push({
            index: i,
            segment: segment,
            audit: Object.assign({}, audit, { details: detailsParsed })
          });
        } catch (e) {
          errors.push({ index: i, error: e.message });
        }
      }
      res.json({
        code: 0,
        data: {
          total: body.segments.length,
          success: results.length,
          failed: errors.length,
          results: results,
          errors: errors
        }
      });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.get('/api/segments/waybill/:waybillNo', function(req, res) {
    try {
      const segments = segmentRepo.getByWaybill(req.params.waybillNo);
      res.json({ code: 0, data: segments });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.get('/api/audits/waybill/:waybillNo', function(req, res) {
    try {
      if (!waybillRepo.getByNo(req.params.waybillNo)) {
        return res.status(404).json({ code: 404, error: '运单不存在' });
      }
      const filterOptions = {};
      if (req.query.status) {
        const statusList = Array.isArray(req.query.status) ? req.query.status : [req.query.status];
        filterOptions.status = statusList.filter(Boolean);
      }
      if (req.query.start_time) {
        filterOptions.start_time = req.query.start_time;
      }
      if (req.query.end_time) {
        filterOptions.end_time = req.query.end_time;
      }
      const audits = auditRepo.getByWaybillFiltered(req.params.waybillNo, filterOptions);
      const enriched = audits.map(function(a) {
        const d = a.details ? JSON.parse(a.details) : null;
        return Object.assign({}, a, { details: d });
      });
      res.json({ code: 0, data: enriched, filters: filterOptions });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.get('/api/summary/waybill/:waybillNo', function(req, res) {
    try {
      const summary = summarizeWaybillAudit(req.params.waybillNo);
      if (!summary) {
        return res.status(404).json({ code: 404, error: '运单不存在' });
      }
      res.json({ code: 0, data: summary });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.post('/api/evidence/:waybillNo', function(req, res) {
    try {
      const opts = {};
      opts.dispute_type = (req.body && req.body.dispute_type) || 'customer_complaint';
      opts.audience = (req.body && req.body.audience) || 'internal';
      if (['internal', 'customer'].indexOf(opts.audience) < 0) {
        return res.status(400).json({ code: 400, error: 'audience 必须是 internal 或 customer' });
      }
      const evidence = generateEvidence(req.params.waybillNo, opts);
      if (!evidence) {
        return res.status(404).json({ code: 404, error: '运单不存在' });
      }
      res.json({ code: 0, data: evidence });
    } catch (e) {
      res.status(500).json({ code: 500, error: e.message });
    }
  });

  app.use(function(err, req, res, next) {
    console.error('Unhandled error:', err);
    res.status(500).json({ code: 500, error: '内部服务错误: ' + err.message });
  });

  return app;
}

module.exports = { createApp };
