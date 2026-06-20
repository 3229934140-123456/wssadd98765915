const moment = require('moment');
const config = require('../config');
const { zoneConfigRepo, waybillRepo, segmentRepo, auditRepo } = require('./db');

const AUDIT_STATUS = {
  NORMAL: 'normal',
  WARNING: 'warning',
  VIOLATION: 'violation',
  MANUAL_REVIEW: 'manual_review'
};

const TEMP_STATUS = {
  NORMAL: 'normal',
  WARNING_LOW: 'warning_low',
  WARNING_HIGH: 'warning_high',
  VIOLATION_LOW: 'violation_low',
  VIOLATION_HIGH: 'violation_high',
  PEAK_VIOLATION_HIGH: 'peak_violation_high',
  PEAK_VIOLATION_LOW: 'peak_violation_low'
};

const DOOR_STATUS = {
  NORMAL: 'normal',
  WARNING: 'warning',
  VIOLATION: 'violation'
};

const COOLER_STATUS_ENUM = {
  NORMAL: 'normal',
  WARNING: 'warning',
  ERROR: 'error'
};

function minutesBetween(startStr, endStr) {
  return moment(endStr).diff(moment(startStr), 'minutes');
}

function evaluateTemperature(segment, zoneConfig) {
  const buffer = config.audit.warningTempBuffer;
  const peakMultiplier = config.audit.peakViolationMultiplier;
  const { min_temp: zoneMin, max_temp: zoneMax } = zoneConfig;
  const { avg_temp, min_temp: segMin, max_temp: segMax, start_time, end_time } = segment;
  const duration = minutesBetween(start_time, end_time);

  const warnMin = zoneMin - buffer;
  const warnMax = zoneMax + buffer;
  const peakViolationMin = zoneMin - buffer * peakMultiplier;
  const peakViolationMax = zoneMax + buffer * peakMultiplier;

  const segAvgInRange = avg_temp >= zoneMin && avg_temp <= zoneMax;
  const segAllInRange = segMin >= zoneMin && segMax <= zoneMax;
  const avgInWarnRange = avg_temp >= warnMin && avg_temp <= warnMax;
  const anyOutOfRange = segMin < zoneMin || segMax > zoneMax;
  const anyOutOfWarnRange = segMin < warnMin || segMax > warnMax;
  const peakSevereOver = segMax > peakViolationMax;
  const peakSevereUnder = segMin < peakViolationMin;

  let tempStatus = TEMP_STATUS.NORMAL;
  let scoreImpact = 0;
  let isPeakViolation = false;

  if (segAllInRange) {
    tempStatus = TEMP_STATUS.NORMAL;
    scoreImpact = 0;
  } else if (segAvgInRange && (peakSevereOver || peakSevereUnder)) {
    tempStatus = peakSevereOver ? TEMP_STATUS.PEAK_VIOLATION_HIGH : TEMP_STATUS.PEAK_VIOLATION_LOW;
    scoreImpact = 3;
    isPeakViolation = true;
  } else if (segAvgInRange && anyOutOfRange && duration < config.audit.singleViolationMinMinutes) {
    tempStatus = segMin < zoneMin ? TEMP_STATUS.WARNING_LOW : TEMP_STATUS.WARNING_HIGH;
    scoreImpact = 1;
  } else if (avgInWarnRange && duration >= config.audit.singleViolationMinMinutes) {
    tempStatus = segMin < zoneMin ? TEMP_STATUS.WARNING_LOW : TEMP_STATUS.WARNING_HIGH;
    scoreImpact = 2;
  } else if (!avgInWarnRange || (anyOutOfWarnRange && duration >= config.audit.singleViolationMinMinutes)) {
    tempStatus = segMin < warnMin ? TEMP_STATUS.VIOLATION_LOW : TEMP_STATUS.VIOLATION_HIGH;
    scoreImpact = 3;
  }

  return { tempStatus, scoreImpact, duration, isPeakViolation };
}

function evaluateDoor(segment) {
  const { door_open, door_open_duration, start_time, end_time } = segment;
  const duration = minutesBetween(start_time, end_time);

  if (!door_open) {
    return { doorStatus: DOOR_STATUS.NORMAL, scoreImpact: 0 };
  }

  const openSeconds = Math.round(door_open_duration || 0);
  if (openSeconds >= config.audit.doorOpenMinMinutes * 60 || duration >= config.audit.doorOpenMinMinutes) {
    return { doorStatus: DOOR_STATUS.VIOLATION, scoreImpact: 3 };
  }

  return { doorStatus: DOOR_STATUS.WARNING, scoreImpact: 1 };
}

function evaluateCooler(segment) {
  const status = (segment.cooler_status || 'normal').toLowerCase();
  if (status === 'normal' || status === 'running') {
    return { coolerResult: COOLER_STATUS_ENUM.NORMAL, scoreImpact: 0 };
  }
  if (status === 'warning' || status === 'idle') {
    return { coolerResult: COOLER_STATUS_ENUM.WARNING, scoreImpact: 1 };
  }
  return { coolerResult: COOLER_STATUS_ENUM.ERROR, scoreImpact: 3 };
}

function needsManualReview(segment) {
  const reasons = [];
  if (segment.avg_temp == null || segment.min_temp == null || segment.max_temp == null) {
    reasons.push('温度数据不完整');
  }
  if (minutesBetween(segment.start_time, segment.end_time) <= 0) {
    reasons.push('片段时间异常');
  }
  return reasons;
}

function auditSegment(segment, zoneConfig) {
  const reviewReasons = needsManualReview(segment);
  const tempResult = evaluateTemperature(segment, zoneConfig);
  const doorResult = evaluateDoor(segment);
  const coolerResult = evaluateCooler(segment);

  let finalStatus;
  const totalScore = tempResult.scoreImpact + doorResult.scoreImpact + coolerResult.scoreImpact;

  if (reviewReasons.length > 0) {
    finalStatus = AUDIT_STATUS.MANUAL_REVIEW;
  } else if (
    totalScore >= 6 ||
    tempResult.tempStatus.startsWith('violation') || tempResult.tempStatus.startsWith('peak_violation') ||
    doorResult.doorStatus === DOOR_STATUS.VIOLATION ||
    coolerResult.coolerResult === COOLER_STATUS_ENUM.ERROR
  ) {
    finalStatus = AUDIT_STATUS.VIOLATION;
  } else if (totalScore >= 2) {
    finalStatus = AUDIT_STATUS.WARNING;
  } else {
    finalStatus = AUDIT_STATUS.NORMAL;
  }

  const details = {
    reviewReasons,
    temperature: {
      tempStatus: tempResult.tempStatus,
      isPeakViolation: tempResult.isPeakViolation,
      zone: {
        min: zoneConfig.min_temp,
        max: zoneConfig.max_temp,
        buffer: config.audit.warningTempBuffer,
        peakViolationMin: zoneConfig.min_temp - config.audit.warningTempBuffer * config.audit.peakViolationMultiplier,
        peakViolationMax: zoneConfig.max_temp + config.audit.warningTempBuffer * config.audit.peakViolationMultiplier
      },
      segmentTemps: {
        avg: segment.avg_temp,
        min: segment.min_temp,
        max: segment.max_temp
      }
    },
    door: {
      status: doorResult.doorStatus,
      open: !!segment.door_open,
      duration_seconds: segment.door_open_duration
    },
    cooler: {
      status: coolerResult.coolerResult,
      raw: segment.cooler_status
    },
    duration_minutes: tempResult.duration
  };

  return {
    segment_id: segment.id,
    waybill_no: segment.waybill_no,
    status: finalStatus,
    temp_status: tempResult.tempStatus,
    door_status: doorResult.doorStatus,
    cooler_status: coolerResult.coolerResult,
    details: JSON.stringify(details)
  };
}

function processSegmentAudit(segment) {
  const waybill = waybillRepo.getByNo(segment.waybill_no);
  if (!waybill) {
    throw new Error('运单 ' + segment.waybill_no + ' 不存在，请先创单');
  }
  const zoneConfig = zoneConfigRepo.getByCode(waybill.zone_code);
  if (!zoneConfig) {
    throw new Error('温区配置 ' + waybill.zone_code + ' 未找到');
  }
  const auditData = auditSegment(segment, zoneConfig);
  return auditRepo.upsert(auditData);
}

function getTimePeriod(timeStr) {
  if (!timeStr) return 'unknown';
  const hour = moment(timeStr).hour();
  const periods = config.timePeriods;
  if (hour >= periods.dawn.start && hour < periods.dawn.end) return 'dawn';
  if (hour >= periods.morning.start && hour < periods.morning.end) return 'morning';
  if (hour >= periods.afternoon.start && hour < periods.afternoon.end) return 'afternoon';
  if (hour >= periods.evening.start && hour < periods.evening.end) return 'evening';
  return 'unknown';
}

function summarizeWaybillAudit(waybillNo) {
  const waybill = waybillRepo.getByNo(waybillNo);
  if (!waybill) return null;
  const audits = auditRepo.getByWaybill(waybillNo);
  const segments = segmentRepo.getByWaybill(waybillNo);
  const zoneConfig = zoneConfigRepo.getByCode(waybill.zone_code);

  const summary = {
    waybill_no: waybillNo,
    meat_type: waybill.meat_type,
    zone_code: waybill.zone_code,
    zone_name: zoneConfig ? zoneConfig.zone_name : null,
    zone_range: zoneConfig ? { min: zoneConfig.min_temp, max: zoneConfig.max_temp } : null,
    segment_count: segments.length,
    status_counts: {
      normal: 0, warning: 0, violation: 0, manual_review: 0
    },
    temp_violations: {
      count: 0,
      peak_violation_count: 0,
      max_temp_peak: null,
      min_temp_trough: null,
      longest_duration_minutes: 0,
      total_duration_minutes: 0
    },
    door_incidents: {
      count: 0,
      total_open_minutes: 0,
      longest_open_minutes: 0
    },
    cooler_incidents: {
      warning_count: 0,
      error_count: 0
    },
    period_breakdown: {
      dawn: { label: config.timePeriods.dawn.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 },
      morning: { label: config.timePeriods.morning.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 },
      afternoon: { label: config.timePeriods.afternoon.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 },
      evening: { label: config.timePeriods.evening.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 }
    },
    overall_status: AUDIT_STATUS.NORMAL,
    affects_signoff: false,
    signoff_note: ''
  };

  let inViolationRun = false;
  let currentViolationMinutes = 0;
  let longestViolation = 0;

  for (const a of audits) {
    summary.status_counts[a.status] = (summary.status_counts[a.status] || 0) + 1;

    const duration = minutesBetween(a.start_time, a.end_time);
    const period = getTimePeriod(a.start_time);
    if (summary.period_breakdown[period]) {
      summary.period_breakdown[period].segment_count++;
    }

    const isTempViolation = a.temp_status && (a.temp_status.startsWith('violation') || a.temp_status.startsWith('peak_violation'));
    const isPeakViolation = a.temp_status && a.temp_status.startsWith('peak_violation');

    if (isTempViolation) {
      summary.temp_violations.count++;
      summary.temp_violations.total_duration_minutes += duration;
      inViolationRun = true;
      currentViolationMinutes += duration;
      if (summary.period_breakdown[period]) {
        summary.period_breakdown[period].temp_violations++;
      }
    } else {
      if (inViolationRun) {
        longestViolation = Math.max(longestViolation, currentViolationMinutes);
      }
      inViolationRun = false;
      currentViolationMinutes = 0;
    }

    if (isPeakViolation) {
      summary.temp_violations.peak_violation_count++;
      if (summary.period_breakdown[period]) {
        summary.period_breakdown[period].peak_violations++;
      }
    }

    if (a.max_temp != null) {
      summary.temp_violations.max_temp_peak = summary.temp_violations.max_temp_peak == null
        ? a.max_temp : Math.max(summary.temp_violations.max_temp_peak, a.max_temp);
    }
    if (a.min_temp != null) {
      summary.temp_violations.min_temp_trough = summary.temp_violations.min_temp_trough == null
        ? a.min_temp : Math.min(summary.temp_violations.min_temp_trough, a.min_temp);
    }

    if (a.door_status === DOOR_STATUS.WARNING || a.door_status === DOOR_STATUS.VIOLATION) {
      summary.door_incidents.count++;
      const openMin = Math.round((a.door_open_duration || 0) / 60) || Math.round(duration);
      summary.door_incidents.total_open_minutes += openMin;
      summary.door_incidents.longest_open_minutes = Math.max(summary.door_incidents.longest_open_minutes, openMin);
      if (summary.period_breakdown[period]) {
        summary.period_breakdown[period].door_incidents++;
      }
    }

    if (a.cooler_status === COOLER_STATUS_ENUM.WARNING) summary.cooler_incidents.warning_count++;
    if (a.cooler_status === COOLER_STATUS_ENUM.ERROR) summary.cooler_incidents.error_count++;
  }

  longestViolation = Math.max(longestViolation, currentViolationMinutes);
  summary.temp_violations.longest_duration_minutes = longestViolation;

  const counts = summary.status_counts;

  if (counts.manual_review > 0) {
    summary.overall_status = AUDIT_STATUS.MANUAL_REVIEW;
  } else if (counts.violation > 0) {
    summary.overall_status = AUDIT_STATUS.VIOLATION;
  } else if (counts.warning > 0) {
    summary.overall_status = AUDIT_STATUS.WARNING;
  }

  const totalViolationMin = summary.temp_violations.total_duration_minutes;
  const hasSeriousViolation = counts.violation > 0;
  const tooMuchViolation = totalViolationMin >= config.audit.totalViolationMinMinutes;
  const longSingleViolation = summary.temp_violations.longest_duration_minutes >= config.audit.singleViolationMinMinutes * 2;
  const coolerError = summary.cooler_incidents.error_count > 0;
  const hasPeakViolation = summary.temp_violations.peak_violation_count > 0;

  summary.affects_signoff = hasSeriousViolation && (tooMuchViolation || longSingleViolation || coolerError || hasPeakViolation);
  summary.signoff_note = summary.affects_signoff
    ? '冷链数据存在严重异常，建议拒收或需与承运方确认质量确认后签收'
    : '冷链数据正常或轻微异常，可正常签收';

  return summary;
}

function describeEvent(a) {
  const parts = [];
  parts.push('温度' + a.avg_temp + '℃');
  if (a.temp_status && (a.temp_status.startsWith('violation') || a.temp_status.startsWith('peak_violation'))) {
    if (a.temp_status.includes('high')) parts.push('超温');
    if (a.temp_status.includes('low')) parts.push('低温异常');
    if (a.temp_status.startsWith('peak_violation')) parts.push('瞬时严重越界');
  } else if (a.temp_status && a.temp_status.startsWith('warning')) {
    if (a.temp_status.includes('high')) parts.push('温度偏高');
    if (a.temp_status.includes('low')) parts.push('温度偏低');
  }
  if (a.door_open) parts.push('开门');
  if (a.segment_cooler_status && a.segment_cooler_status !== 'normal') {
    parts.push('制冷机:' + a.segment_cooler_status);
  }
  return parts.join('，');
}

function generateConclusion(summary, waybill, zoneConfig) {
  if (summary.overall_status === AUDIT_STATUS.NORMAL) {
    return '本次运输全程冷链温度符合' + zoneConfig.zone_name + '要求（' + zoneConfig.min_temp + '℃~' + zoneConfig.max_temp + '℃），未出现异常，运输质量合格。';
  }
  if (summary.overall_status === AUDIT_STATUS.MANUAL_REVIEW) {
    return '本次运输存在数据不完整或存疑，需人工复核原始记录。';
  }
  if (summary.overall_status === AUDIT_STATUS.VIOLATION) {
    const reasons = [];
    if (summary.temp_violations.peak_violation_count > 0) {
      reasons.push('瞬时严重超温' + summary.temp_violations.peak_violation_count + '次（峰值超温区上限' + (config.audit.warningTempBuffer * config.audit.peakViolationMultiplier) + '℃）');
    }
    if (summary.temp_violations.count > summary.temp_violations.peak_violation_count) {
      const otherCount = summary.temp_violations.count - summary.temp_violations.peak_violation_count;
      reasons.push('其他温度违规' + otherCount + '次，累计' + summary.temp_violations.total_duration_minutes + '分钟');
    }
    if (summary.door_incidents.count > 0) {
      reasons.push('开门异常' + summary.door_incidents.count + '次');
    }
    if (summary.cooler_incidents.error_count > 0) {
      reasons.push('制冷机故障' + summary.cooler_incidents.error_count + '次');
    }
    return '本次运输存在冷链违规：' + reasons.join('；') + '。';
  }
  return '本次运输存在轻微预警，建议关注。';
}

function generateRecommendations(summary) {
  const recs = [];
  if (summary.affects_signoff) {
    recs.push('建议与承运方进行质量确认后再决定是否签收，必要时抽样检测。');
  } else {
    recs.push('可正常签收。');
  }
  if (summary.temp_violations.peak_violation_count > 0) {
    recs.push('存在瞬时严重超温，建议排查制冷系统响应速度及厢体密封。');
  }
  if (summary.temp_violations.count > 0) {
    recs.push('建议承运方检查制冷机组性能及厢体密封。');
  }
  if (summary.door_incidents.count > 2) {
    recs.push('建议优化装卸流程，减少开门次数。');
  }
  if (summary.cooler_incidents.error_count > 0) {
    recs.push('制冷机存在故障记录，建议设备方排查设备维护。');
  }
  if (summary.status_counts.manual_review > 0) {
    recs.push('存在需人工复核的建议核对原始数据日志。');
  }
  return recs;
}

function generateTextConclusion(summary, waybill, zoneConfig, audits) {
  const lines = [];
  lines.push('【冷链温区稽核报告 - 文本版】');
  lines.push('');
  lines.push('运单编号：' + waybill.waybill_no);
  lines.push('货物类型：' + waybill.meat_type);
  lines.push('温区要求：' + zoneConfig.zone_name + '（' + zoneConfig.min_temp + '℃ ~ ' + zoneConfig.max_temp + '℃）');
  if (waybill.origin) lines.push('始发地：' + waybill.origin);
  if (waybill.destination) lines.push('目的地：' + waybill.destination);
  if (waybill.planned_departure) lines.push('计划发车：' + waybill.planned_departure);
  if (waybill.planned_arrival) lines.push('计划到达：' + waybill.planned_arrival);
  lines.push('');
  lines.push('--- 稽核结论 ---');
  lines.push(generateConclusion(summary, waybill, zoneConfig));
  lines.push('综合状态：' + summary.overall_status);
  lines.push('是否影响签收：' + (summary.affects_signoff ? '是' : '否'));
  lines.push('');

  lines.push('--- 数据统计 ---');
  lines.push('监测片段数：' + summary.segment_count);
  lines.push('正常：' + summary.status_counts.normal + '  预警：' + summary.status_counts.warning + '  违规：' + summary.status_counts.violation + '  待复核：' + summary.status_counts.manual_review);
  if (summary.temp_violations.max_temp_peak != null) lines.push('温度峰值：' + summary.temp_violations.max_temp_peak + '℃');
  if (summary.temp_violations.min_temp_trough != null) lines.push('温度谷值：' + summary.temp_violations.min_temp_trough + '℃');
  if (summary.temp_violations.peak_violation_count > 0) lines.push('瞬时严重超温次数：' + summary.temp_violations.peak_violation_count);
  if (summary.door_incidents.count > 0) lines.push('开门异常：' + summary.door_incidents.count + '次，累计' + summary.door_incidents.total_open_minutes + '分钟');
  if (summary.cooler_incidents.error_count > 0) lines.push('制冷机故障：' + summary.cooler_incidents.error_count + '次');
  lines.push('');

  lines.push('--- 时段异常分布 ---');
  for (const key of Object.keys(summary.period_breakdown)) {
    const p = summary.period_breakdown[key];
    if (p.segment_count > 0) {
      lines.push(p.label + '：超温' + p.temp_violations + '次(含瞬时严重' + p.peak_violations + '次)，开门异常' + p.door_incidents + '次');
    }
  }
  lines.push('');

  lines.push('--- 关键异常时间线 ---');
  const abnormalAudits = audits.filter(function(a) {
    return a.status !== 'normal';
  });
  if (abnormalAudits.length === 0) {
    lines.push('全程无异常。');
  } else {
    for (const a of abnormalAudits) {
      const timeRange = a.start_time + ' ~ ' + a.end_time;
      const parts = [];
      parts.push('[' + a.status.toUpperCase() + ']');
      parts.push(timeRange);
      parts.push(describeEvent(a));
      if (a.location_name) parts.push('@' + a.location_name);
      lines.push(parts.join('  '));
    }
  }
  lines.push('');

  lines.push('--- 处理建议 ---');
  const recs = generateRecommendations(summary);
  for (let i = 0; i < recs.length; i++) {
    lines.push((i + 1) + '. ' + recs[i]);
  }
  lines.push('');
  lines.push('报告生成时间：' + new Date().toISOString());

  return lines.join('\n');
}

function generateEvidence(waybillNo, disputeType) {
  const dispute = disputeType || 'customer_complaint';
  const waybill = waybillRepo.getByNo(waybillNo);
  if (!waybill) return null;

  const audits = auditRepo.getByWaybill(waybillNo);
  const segments = segmentRepo.getByWaybill(waybillNo);
  const summary = summarizeWaybillAudit(waybillNo);
  const zoneConfig = zoneConfigRepo.getByCode(waybill.zone_code);

  const keyTimeline = audits.map(function(a) {
    return {
      time: a.start_time,
      event_type: a.status,
      description: describeEvent(a),
      temp_avg: a.avg_temp,
      location: a.location_name,
      door_open: a.door_open,
      cooler: a.segment_cooler_status
    };
  });

  const doorRecords = audits
    .filter(function(a) { return a.door_open; })
    .map(function(a) {
      return {
        start_time: a.start_time,
        end_time: a.end_time,
        duration_minutes: minutesBetween(a.start_time, a.end_time),
        location: a.location_name,
        open_duration_seconds: a.door_open_duration,
        avg_temp: a.avg_temp
      };
    });

  const stopLocations = [...new Set(segments.map(function(s) { return s.location_name; }).filter(Boolean))];

  const tempViolations = audits
    .filter(function(a) {
      return a.temp_status && (a.temp_status.startsWith('violation') || a.temp_status.startsWith('peak_violation'));
    })
    .map(function(a) {
      return {
        start_time: a.start_time,
        end_time: a.end_time,
        duration_minutes: minutesBetween(a.start_time, a.end_time),
        temp_status: a.temp_status,
        is_peak_violation: a.temp_status && a.temp_status.startsWith('peak_violation'),
        avg_temp: a.avg_temp,
        max_temp: a.max_temp,
        min_temp: a.min_temp,
        location: a.location_name
      };
    });

  const textConclusion = generateTextConclusion(summary, waybill, zoneConfig, audits);

  return {
    evidence_id: 'EVIDENCE_' + waybillNo + '_' + Date.now(),
    generated_at: new Date().toISOString(),
    dispute_type: dispute,
    waybill: {
      waybill_no: waybillNo,
      meat_type: waybill.meat_type,
      shipper: waybill.shipper,
      consignee: waybill.consignee,
      origin: waybill.origin,
      destination: waybill.destination,
      planned_departure: waybill.planned_departure,
      planned_arrival: waybill.planned_arrival
    },
    zone_requirement: {
      zone_code: zoneConfig.zone_code,
      zone_name: zoneConfig.zone_name,
      temp_range: { min: zoneConfig.min_temp, max: zoneConfig.max_temp },
      description: zoneConfig.description
    },
    summary: {
      overall_status: summary.overall_status,
      total_segments: summary.segment_count,
      status_counts: summary.status_counts,
      affects_signoff: summary.affects_signoff,
      period_breakdown: summary.period_breakdown
    },
    temperature_analysis: {
      peak_temp: summary.temp_violations.max_temp_peak,
      trough_temp: summary.temp_violations.min_temp_trough,
      violation_count: summary.temp_violations.count,
      peak_violation_count: summary.temp_violations.peak_violation_count,
      total_violation_minutes: summary.temp_violations.total_duration_minutes,
      longest_continuous_minutes: summary.temp_violations.longest_duration_minutes,
      violation_segments: tempViolations
    },
    door_records: {
      total_open_incidents: summary.door_incidents.count,
      total_open_minutes: summary.door_incidents.total_open_minutes,
      incidents: doorRecords
    },
    location_stops: stopLocations.map(function(name) {
      return {
        location_name: name,
        segments: segments.filter(function(s) { return s.location_name === name; }).length
      };
    }),
    cooler_status: {
      warnings: summary.cooler_incidents.warning_count,
      errors: summary.cooler_incidents.error_count
    },
    timeline: keyTimeline,
    conclusion: generateConclusion(summary, waybill, zoneConfig),
    text_conclusion: textConclusion,
    recommendations: generateRecommendations(summary)
  };
}

module.exports = {
  AUDIT_STATUS,
  TEMP_STATUS,
  DOOR_STATUS,
  COOLER_STATUS_ENUM,
  auditSegment,
  processSegmentAudit,
  summarizeWaybillAudit,
  generateEvidence,
  getTimePeriod
};
