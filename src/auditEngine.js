const moment = require('moment');
const config = require('../config');
const { zoneConfigRepo, waybillRepo, segmentRepo, auditRepo, disposalRepo } = require('./db');

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

const TRANSPORT_STAGE = {
  IN_TRANSIT: 'in_transit',
  STOP: 'stop',
  LOADING_UNLOADING: 'loading_unloading',
  UNKNOWN: 'unknown'
};

const SIGNOFF_RISK_LEVEL = {
  SUGGEST_SIGNOFF: 'suggest_signoff',
  REVIEW_REQUIRED: 'review_required',
  REJECTION_RECOMMENDED: 'rejection_recommended'
};

const RESPONSIBILITY = {
  CARRIER: 'carrier',
  EQUIPMENT: 'equipment',
  LOADING: 'loading',
  JOINT_REVIEW: 'joint_review'
};

function minutesBetween(startStr, endStr) {
  return moment(endStr).diff(moment(startStr), 'minutes');
}

function classifyTransportStage(segment) {
  if (segment.transport_stage && config.transportStages[segment.transport_stage]) {
    return segment.transport_stage;
  }

  const locName = (segment.location_name || '').toLowerCase();
  const doorOpen = !!segment.door_open;

  const stageKeys = Object.keys(config.transportStages);
  for (const key of stageKeys) {
    const kws = config.transportStages[key].keywords || [];
    for (const kw of kws) {
      if (locName.indexOf(kw) >= 0) {
        if (key === 'loading_unloading' && !doorOpen && segment.door_open_duration === 0) {
          return 'stop';
        }
        return key;
      }
    }
  }

  if (doorOpen && (segment.door_open_duration || 0) >= 60) {
    return TRANSPORT_STAGE.LOADING_UNLOADING;
  }

  return TRANSPORT_STAGE.UNKNOWN;
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
  const stage = classifyTransportStage(segment);

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
    transport_stage: stage,
    duration_minutes: tempResult.duration
  };

  return {
    segment_id: segment.id,
    waybill_no: segment.waybill_no,
    status: finalStatus,
    temp_status: tempResult.tempStatus,
    door_status: doorResult.doorStatus,
    cooler_status: coolerResult.coolerResult,
    transport_stage: stage,
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

function evaluateSignoffRisk(summary) {
  const riskConfig = config.signoffRisk;
  const counts = summary.status_counts;
  const tempV = summary.temp_violations;
  const doorV = summary.door_incidents;
  const coolerV = summary.cooler_incidents;
  const factors = [];
  let level = SIGNOFF_RISK_LEVEL.SUGGEST_SIGNOFF;

  if (counts.violation >= riskConfig.rejectionThreshold.violationCount) {
    level = SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED;
    factors.push('违规片段累计 ' + counts.violation + ' 次，已超拒收阈值');
  }
  if (tempV.total_duration_minutes >= riskConfig.rejectionThreshold.totalViolationMinutes) {
    level = SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED;
    factors.push('累计超温 ' + tempV.total_duration_minutes + ' 分钟，已超拒收阈值');
  }
  if (tempV.peak_violation_count > 0 && riskConfig.rejectionThreshold.hasPeakViolation) {
    if (level !== SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED) level = SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED;
    factors.push('存在瞬时严重超温 ' + tempV.peak_violation_count + ' 次（峰值超温区上限 4℃）');
  }
  if (coolerV.error_count > 0 && riskConfig.rejectionThreshold.hasCoolerError) {
    if (level !== SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED) level = SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED;
    factors.push('制冷机故障 ' + coolerV.error_count + ' 次，存在设备异常风险');
  }
  if (doorV.count >= riskConfig.rejectionThreshold.doorViolationCount) {
    if (level !== SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED) level = SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED;
    factors.push('开门异常 ' + doorV.count + ' 次，可能影响冷链稳定性');
  }
  if (counts.manual_review > 0) {
    level = SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED;
    factors.push('存在 ' + counts.manual_review + ' 条待人工复核记录');
  }
  if (counts.warning > 0 && level === SIGNOFF_RISK_LEVEL.SUGGEST_SIGNOFF) {
    level = SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED;
    factors.push('存在 ' + counts.warning + ' 次预警，建议关注');
  }

  if (factors.length === 0) {
    factors.push('全程冷链数据正常，无异常');
  }

  return {
    level: level,
    label: riskConfig.labels[level],
    factors: factors,
    signoff_note: buildSignoffNote(level, factors)
  };
}

function buildSignoffNote(level, factors) {
  if (level === SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED) {
    return '冷链数据存在严重异常，建议拒收；如已签收请立即评估产品质量，必要时抽样检测。';
  }
  if (level === SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED) {
    return '冷链数据存在异常项，建议与承运方核实原因并确认产品质量后再签收。';
  }
  return '冷链数据正常，可正常签收。';
}

function evaluateResponsibilityTendency(summary, audits) {
  const respConfig = config.responsibility;
  const scores = {};
  scores[RESPONSIBILITY.CARRIER] = 0;
  scores[RESPONSIBILITY.EQUIPMENT] = 0;
  scores[RESPONSIBILITY.LOADING] = 0;

  const stageBd = summary.stage_breakdown;
  if (stageBd.in_transit.temp_violations > 0) {
    scores[RESPONSIBILITY.CARRIER] += stageBd.in_transit.temp_violations * 2;
  }
  if (stageBd.stop.temp_violations > 0) {
    scores[RESPONSIBILITY.CARRIER] += stageBd.stop.temp_violations;
  }
  if (stageBd.in_transit.peak_violations > 0) {
    scores[RESPONSIBILITY.CARRIER] += stageBd.in_transit.peak_violations * 3;
  }

  if (summary.cooler_incidents.error_count > 0) {
    scores[RESPONSIBILITY.EQUIPMENT] += summary.cooler_incidents.error_count * 3;
  }
  if (summary.cooler_incidents.warning_count > 0) {
    scores[RESPONSIBILITY.EQUIPMENT] += summary.cooler_incidents.warning_count;
  }
  if (summary.temp_violations.peak_violation_count > 0) {
    scores[RESPONSIBILITY.EQUIPMENT] += summary.temp_violations.peak_violation_count;
  }

  if (stageBd.loading_unloading.door_incidents > 0) {
    scores[RESPONSIBILITY.LOADING] += stageBd.loading_unloading.door_incidents * 2;
  }
  if (stageBd.loading_unloading.temp_violations > 0) {
    scores[RESPONSIBILITY.LOADING] += stageBd.loading_unloading.temp_violations;
  }
  if (summary.door_incidents.count > 0 && stageBd.loading_unloading.door_incidents > 0) {
    const loadingRatio = stageBd.loading_unloading.door_incidents / Math.max(summary.door_incidents.count, 1);
    if (loadingRatio > 0.5) {
      scores[RESPONSIBILITY.LOADING] += 2;
    }
  }

  const activeParties = Object.keys(scores).filter(function(k) { return scores[k] > 0; });
  if (activeParties.length >= 3) {
    return {
      tendency: RESPONSIBILITY.JOINT_REVIEW,
      label: respConfig.joint_review.label,
      scores: scores,
      reasoning: buildResponsibilityReasoning(scores, RESPONSIBILITY.JOINT_REVIEW)
    };
  }
  if (activeParties.length >= 2) {
    const maxScore = Math.max.apply(null, activeParties.map(function(k) { return scores[k]; }));
    const secondMax = activeParties.map(function(k) { return scores[k]; }).sort(function(a, b) { return b - a; })[1];
    if (secondMax >= maxScore * 0.5) {
      return {
        tendency: RESPONSIBILITY.JOINT_REVIEW,
        label: respConfig.joint_review.label,
        scores: scores,
        reasoning: buildResponsibilityReasoning(scores, RESPONSIBILITY.JOINT_REVIEW)
      };
    }
  }

  let maxKey = RESPONSIBILITY.CARRIER;
  for (const k of Object.keys(scores)) {
    if (scores[k] > scores[maxKey]) maxKey = k;
  }
  if (scores[maxKey] === 0) {
    maxKey = RESPONSIBILITY.CARRIER;
  }

  return {
    tendency: maxKey,
    label: respConfig[maxKey].label,
    scores: scores,
    reasoning: buildResponsibilityReasoning(scores, maxKey)
  };
}

function buildResponsibilityReasoning(scores, tendency) {
  const parts = [];
  if (scores[RESPONSIBILITY.CARRIER] > 0) {
    parts.push('在途/停靠阶段温度异常（得分' + scores[RESPONSIBILITY.CARRIER] + '）');
  }
  if (scores[RESPONSIBILITY.EQUIPMENT] > 0) {
    parts.push('制冷设备故障或异常（得分' + scores[RESPONSIBILITY.EQUIPMENT] + '）');
  }
  if (scores[RESPONSIBILITY.LOADING] > 0) {
    parts.push('装卸阶段开门及温度异常（得分' + scores[RESPONSIBILITY.LOADING] + '）');
  }
  if (tendency === RESPONSIBILITY.JOINT_REVIEW) {
    return '多方因素交织，需共同复核：' + parts.join('；');
  }
  if (parts.length > 0) {
    return '主要责任倾向：' + parts[0] + (parts.length > 1 ? '；次要因素：' + parts.slice(1).join('；') : '');
  }
  return '无明确异常，责任倾向不适用。';
}

function buildQualityInspection(summary, waybill) {
  const riskLevel = summary.signoff_risk ? summary.signoff_risk.level : SIGNOFF_RISK_LEVEL.SUGGEST_SIGNOFF;
  const qiConfig = config.qualityInspection;
  const priority = qiConfig.samplingPriority[riskLevel];
  if (!priority) return null;

  let itemKey = 'default';
  const zoneCode = (waybill.zone_code || '').toUpperCase();
  if (zoneCode === 'FROZEN' || zoneCode === 'SEMI_FROZEN') itemKey = 'frozen';
  else if (zoneCode === 'CHILLED') itemKey = 'chilled';
  else if (zoneCode === 'ICE_CHILLED') itemKey = 'ice_chilled';

  const items = qiConfig.itemsByMeatType[itemKey] || qiConfig.itemsByMeatType.default;
  const evidenceList = qiConfig.evidenceRetention.slice();

  if (summary.temp_violations.count > 0) {
    evidenceList.push('超温片段温度曲线截图');
  }
  if (summary.door_incidents.count > 0) {
    evidenceList.push('开门事件记录截图');
  }
  if (summary.cooler_incidents.error_count > 0) {
    evidenceList.push('制冷机故障日志');
  }

  return {
    sampling_priority: priority,
    sampling_priority_label: priority === 'high' ? '优先抽检' : '常规抽检',
    suggested_items: items,
    evidence_retention_list: evidenceList
  };
}

function buildStageOverview(stageBreakdown) {
  const stagesWithIssues = [];
  for (const key of ['in_transit', 'stop', 'loading_unloading']) {
    const s = stageBreakdown[key];
    if (s && (s.temp_violations > 0 || s.door_incidents > 0)) {
      stagesWithIssues.push({ key: key, label: s.label, temp_violations: s.temp_violations, door_incidents: s.door_incidents });
    }
  }
  if (stagesWithIssues.length === 0) {
    return '全程各运输阶段未见异常。';
  }
  if (stagesWithIssues.length === 1) {
    const s = stagesWithIssues[0];
    return '异常主要集中在' + s.label + '阶段。';
  }
  const labels = stagesWithIssues.map(function(s) { return s.label; });
  const maxStage = stagesWithIssues.reduce(function(a, b) {
    return (b.temp_violations + b.door_incidents) > (a.temp_violations + a.door_incidents) ? b : a;
  });
  return '异常涉及' + labels.join('、') + '阶段，其中' + maxStage.label + '阶段问题较为突出。';
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
    stage_breakdown: {
      in_transit: { label: config.transportStages.in_transit.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 },
      stop: { label: config.transportStages.stop.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 },
      loading_unloading: { label: config.transportStages.loading_unloading.label, temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 },
      unknown: { label: '未知', temp_violations: 0, peak_violations: 0, door_incidents: 0, segment_count: 0 }
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
    const stage = a.transport_stage || 'unknown';

    if (summary.period_breakdown[period]) {
      summary.period_breakdown[period].segment_count++;
    }
    if (summary.stage_breakdown[stage]) {
      summary.stage_breakdown[stage].segment_count++;
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
      if (summary.stage_breakdown[stage]) {
        summary.stage_breakdown[stage].temp_violations++;
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
      if (summary.stage_breakdown[stage]) {
        summary.stage_breakdown[stage].peak_violations++;
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
      if (summary.stage_breakdown[stage]) {
        summary.stage_breakdown[stage].door_incidents++;
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

  const risk = evaluateSignoffRisk(summary);
  summary.signoff_risk = {
    level: risk.level,
    label: risk.label,
    factors: risk.factors
  };
  summary.affects_signoff = risk.level === SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED;
  summary.signoff_note = risk.signoff_note;

  const resp = evaluateResponsibilityTendency(summary, audits);
  summary.responsibility_tendency = {
    tendency: resp.tendency,
    label: resp.label,
    reasoning: resp.reasoning
  };

  const qi = buildQualityInspection(summary, waybill);
  if (qi) {
    summary.quality_inspection = qi;
  }

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
  const risk = summary.signoff_risk;
  if (risk && risk.level === SIGNOFF_RISK_LEVEL.REJECTION_RECOMMENDED) {
    recs.push('建议拒收，如已签收请立即评估产品质量，必要时抽样检测。');
  } else if (risk && risk.level === SIGNOFF_RISK_LEVEL.REVIEW_REQUIRED) {
    recs.push('建议与承运方核实异常原因，确认产品质量后再签收。');
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

function generateTextConclusion(summary, waybill, zoneConfig, audits, audience) {
  const aud = audience || 'internal';
  const isInternal = aud === 'internal';
  const lines = [];

  if (isInternal) {
    lines.push('【冷链温区稽核报告 - 内部版】');
  } else {
    lines.push('【冷链温区稽核报告 - 客户版】');
  }
  lines.push('');
  lines.push('运单编号：' + waybill.waybill_no);
  lines.push('货物类型：' + waybill.meat_type);
  lines.push('温区要求：' + zoneConfig.zone_name + '（' + zoneConfig.min_temp + '℃ ~ ' + zoneConfig.max_temp + '℃）');
  if (waybill.origin) lines.push('始发地：' + waybill.origin);
  if (waybill.destination) lines.push('目的地：' + waybill.destination);
  lines.push('');

  lines.push('--- 稽核结论 ---');
  if (isInternal) {
    lines.push(generateConclusion(summary, waybill, zoneConfig));
  } else {
    lines.push('本批次货物冷链运输已完成温区稽核，结果如下。');
  }
  lines.push('综合状态：' + summary.overall_status);
  if (summary.signoff_risk) {
    lines.push('签收建议：' + summary.signoff_risk.label);
    if (isInternal) {
      lines.push('风险因素：' + summary.signoff_risk.factors.join('；'));
    } else {
      lines.push('签收说明：' + summary.signoff_note);
    }
  }
  if (summary.responsibility_tendency) {
    if (isInternal) {
      lines.push('责任倾向：' + summary.responsibility_tendency.label + ' - ' + summary.responsibility_tendency.reasoning);
    } else {
      lines.push('责任说明：异常主要与' + summary.responsibility_tendency.label + '相关，具体原因正在核实中。');
    }
  }
  lines.push('');

  if (isInternal) {
    lines.push('--- 数据统计 ---');
    lines.push('监测片段数：' + summary.segment_count);
    lines.push('正常：' + summary.status_counts.normal + '  预警：' + summary.status_counts.warning + '  违规：' + summary.status_counts.violation + '  待复核：' + summary.status_counts.manual_review);
    if (summary.temp_violations.max_temp_peak != null) lines.push('温度峰值：' + summary.temp_violations.max_temp_peak + '℃');
    if (summary.temp_violations.min_temp_trough != null) lines.push('温度谷值：' + summary.temp_violations.min_temp_trough + '℃');
    if (summary.temp_violations.peak_violation_count > 0) lines.push('瞬时严重超温次数：' + summary.temp_violations.peak_violation_count);
    if (summary.door_incidents.count > 0) lines.push('开门异常：' + summary.door_incidents.count + '次，累计' + summary.door_incidents.total_open_minutes + '分钟');
    if (summary.cooler_incidents.error_count > 0) lines.push('制冷机故障：' + summary.cooler_incidents.error_count + '次');
    lines.push('');
  }

  if (isInternal) {
    lines.push('--- 时段异常分布 ---');
    for (const key of Object.keys(summary.period_breakdown)) {
      const p = summary.period_breakdown[key];
      if (p.segment_count > 0) {
        lines.push(p.label + '：片段' + p.segment_count + '个，超温' + p.temp_violations + '次(含瞬时严重' + p.peak_violations + '次)，开门异常' + p.door_incidents + '次');
      }
    }
    lines.push('');

    lines.push('--- 运输阶段异常分布 ---');
    for (const key of Object.keys(summary.stage_breakdown)) {
      const s = summary.stage_breakdown[key];
      if (s.segment_count > 0) {
        lines.push(s.label + '：片段' + s.segment_count + '个，超温' + s.temp_violations + '次(含瞬时严重' + s.peak_violations + '次)，开门异常' + s.door_incidents + '次');
      }
    }
    lines.push('');
  } else {
    if (summary.stage_breakdown) {
      const overview = buildStageOverview(summary.stage_breakdown);
      lines.push('--- 运输阶段概览 ---');
      lines.push(overview);
      lines.push('');
    }
  }

  if (summary.quality_inspection) {
    if (isInternal) {
      lines.push('--- 质检建议 ---');
      lines.push('抽检优先级：' + summary.quality_inspection.sampling_priority_label);
      lines.push('建议抽检项目：' + summary.quality_inspection.suggested_items.join('、'));
      lines.push('保留证据清单：' + summary.quality_inspection.evidence_retention_list.join('、'));
    } else {
      lines.push('--- 质检提示 ---');
      lines.push('建议对到货进行' + summary.quality_inspection.sampling_priority_label + '，主要关注' + summary.quality_inspection.suggested_items.slice(0, 2).join('和') + '。');
    }
    lines.push('');
  }

  lines.push('--- 关键异常时间线 ---');
  const abnormalAudits = audits.filter(function(a) {
    return a.status !== 'normal';
  });
  if (abnormalAudits.length === 0) {
    lines.push('全程无异常。');
  } else {
    const displayAudits = isInternal ? abnormalAudits : abnormalAudits.slice(0, 5);
    for (const a of displayAudits) {
      const timeRange = a.start_time + ' ~ ' + a.end_time;
      const parts = [];
      parts.push('[' + a.status.toUpperCase() + ']');
      parts.push(timeRange);
      parts.push(describeEvent(a));
      if (a.location_name) parts.push('@' + a.location_name);
      lines.push(parts.join('  '));
    }
    if (!isInternal && abnormalAudits.length > 5) {
      lines.push('... 共' + abnormalAudits.length + '条异常，如需详细记录请联系客服。');
    }
  }
  lines.push('');

  lines.push('--- 处理建议 ---');
  const recs = generateRecommendations(summary);
  if (isInternal) {
    for (let i = 0; i < recs.length; i++) {
      lines.push((i + 1) + '. ' + recs[i]);
    }
  } else {
    lines.push(recs[0]);
    if (recs.length > 1) {
      lines.push('如有疑问请联系我方客服进一步核实。');
    }
  }
  lines.push('');

  lines.push('报告生成时间：' + new Date().toISOString());

  return lines.join('\n');
}

function generateEvidence(waybillNo, options) {
  const opts = options || {};
  const dispute = opts.dispute_type || 'customer_complaint';
  const audience = opts.audience || 'internal';
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
      cooler: a.segment_cooler_status,
      transport_stage: a.transport_stage
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
        avg_temp: a.avg_temp,
        transport_stage: a.transport_stage
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
        location: a.location_name,
        transport_stage: a.transport_stage
      };
    });

  const textConclusion = generateTextConclusion(summary, waybill, zoneConfig, audits, audience);

  const evidence = {
    evidence_id: 'EVIDENCE_' + waybillNo + '_' + Date.now(),
    generated_at: new Date().toISOString(),
    dispute_type: dispute,
    audience: audience,
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
      signoff_risk: summary.signoff_risk,
      responsibility_tendency: summary.responsibility_tendency,
      quality_inspection: summary.quality_inspection || null,
      period_breakdown: summary.period_breakdown,
      stage_breakdown: summary.stage_breakdown
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

  if (audience === 'customer') {
    delete evidence.temperature_analysis.violation_segments;
    delete evidence.door_records.incidents;
    delete evidence.timeline;
    delete evidence.location_stops;
    delete evidence.summary.period_breakdown;
    delete evidence.summary.stage_breakdown;
    evidence.temperature_analysis.violation_segments = [];
    evidence.door_records.incidents = [];
    evidence.timeline = [];
    evidence.summary.stage_overview = buildStageOverview(summary.stage_breakdown);
    if (summary.responsibility_tendency) {
      evidence.summary.responsibility_tendency = {
        tendency: summary.responsibility_tendency.tendency,
        label: summary.responsibility_tendency.label
      };
    }
    if (summary.quality_inspection) {
      evidence.summary.quality_inspection = {
        sampling_priority: summary.quality_inspection.sampling_priority,
        sampling_priority_label: summary.quality_inspection.sampling_priority_label,
        suggested_items: summary.quality_inspection.suggested_items.slice(0, 2),
        evidence_retention_list: summary.quality_inspection.evidence_retention_list.slice(0, 3)
      };
    }
  }

  return evidence;
}

function generateDisposalOrder(waybillNo, options) {
  const opts = options || {};
  const audience = opts.audience || 'internal';
  const waybill = waybillRepo.getByNo(waybillNo);
  if (!waybill) return null;

  const audits = auditRepo.getByWaybill(waybillNo);
  const summary = summarizeWaybillAudit(waybillNo);
  const zoneConfig = zoneConfigRepo.getByCode(waybill.zone_code);

  const signoffLevel = summary.signoff_risk ? summary.signoff_risk.level : null;
  const respTendency = summary.responsibility_tendency ? summary.responsibility_tendency.tendency : null;
  const qualityPriority = summary.quality_inspection ? summary.quality_inspection.sampling_priority : null;

  const persisted = disposalRepo.upsertByWaybill({
    disposal_id: 'DISPOSAL_' + waybillNo + '_' + Date.now(),
    waybill_no: waybillNo,
    signoff_level: signoffLevel,
    responsibility_tendency: respTendency,
    quality_priority: qualityPriority
  });

  const notes = disposalRepo.getNotes(persisted.disposal_id);
  const latestNote = notes.length > 0 ? notes[notes.length - 1] : null;

  const keySegments = audits
    .filter(function(a) { return a.status !== 'normal'; })
    .map(function(a) {
      return {
        segment_id: a.segment_id,
        start_time: a.start_time,
        end_time: a.end_time,
        status: a.status,
        temp_status: a.temp_status,
        door_status: a.door_status,
        cooler_status: a.cooler_status,
        transport_stage: a.transport_stage,
        avg_temp: a.avg_temp,
        max_temp: a.max_temp,
        location: a.location_name,
        description: describeEvent(a)
      };
    });

  const disposal = {
    disposal_id: persisted.disposal_id,
    waybill_no: waybillNo,
    audience: audience,
    status: persisted.status,
    created_at: persisted.created_at,
    updated_at: persisted.updated_at,
    waybill_info: {
      waybill_no: waybillNo,
      meat_type: waybill.meat_type,
      shipper: waybill.shipper,
      consignee: waybill.consignee,
      origin: waybill.origin,
      destination: waybill.destination,
      zone_code: waybill.zone_code,
      zone_name: zoneConfig ? zoneConfig.zone_name : null,
      zone_range: zoneConfig ? { min: zoneConfig.min_temp, max: zoneConfig.max_temp } : null
    },
    signoff_suggestion: {
      level: summary.signoff_risk ? summary.signoff_risk.level : null,
      label: summary.signoff_risk ? summary.signoff_risk.label : null,
      note: summary.signoff_note || null,
      factors: summary.signoff_risk ? summary.signoff_risk.factors : []
    },
    responsibility_tendency: summary.responsibility_tendency || null,
    quality_inspection: summary.quality_inspection || null,
    key_segments: keySegments,
    overall_status: summary.overall_status,
    status_counts: summary.status_counts,
    final_conclusion: persisted.final_responsibility ? {
      responsibility: persisted.final_responsibility,
      note: persisted.final_note
    } : null,
    processing_notes: notes,
    latest_note: latestNote,
    text_conclusion: generateTextConclusion(summary, waybill, zoneConfig, audits, audience)
  };

  if (audience === 'customer') {
    disposal.key_segments = keySegments.slice(0, 3).map(function(s) {
      return {
        start_time: s.start_time,
        end_time: s.end_time,
        status: s.status,
        description: s.description
      };
    });
    delete disposal.processing_notes;
    delete disposal.latest_note;
    if (disposal.responsibility_tendency) {
      disposal.responsibility_tendency = {
        tendency: disposal.responsibility_tendency.tendency,
        label: disposal.responsibility_tendency.label
      };
    }
    if (disposal.quality_inspection) {
      disposal.quality_inspection = {
        sampling_priority: disposal.quality_inspection.sampling_priority,
        suggested_items: (disposal.quality_inspection.suggested_items || []).slice(0, 2),
        evidence_retention_list: (disposal.quality_inspection.evidence_retention_list || []).slice(0, 3)
      };
    }
  }

  return disposal;
}

function getDisposalOrder(disposalId, options) {
  const opts = options || {};
  const audience = opts.audience || 'internal';
  const persisted = disposalRepo.getByDisposalId(disposalId);
  if (!persisted) return null;
  return generateDisposalOrder(persisted.waybill_no, { audience: audience });
}

function getDisposalByWaybill(waybillNo, options) {
  const opts = options || {};
  const audience = opts.audience || 'internal';
  const persisted = disposalRepo.getByWaybill(waybillNo);
  if (!persisted) return null;
  return generateDisposalOrder(waybillNo, { audience: audience });
}

function addDisposalNote(disposalId, party, note, operator) {
  const persisted = disposalRepo.getByDisposalId(disposalId);
  if (!persisted) return null;
  const validParties = ['carrier', 'equipment', 'loading', 'customer_service', 'other'];
  if (validParties.indexOf(party) < 0) {
    throw new Error('party 必须是 carrier/equipment/loading/customer_service/other 之一');
  }
  disposalRepo.addNote(disposalId, party, note, operator);
  return generateDisposalOrder(persisted.waybill_no, { audience: 'internal' });
}

function setDisposalFinalConclusion(disposalId, finalResponsibility, finalNote, operator) {
  const persisted = disposalRepo.getByDisposalId(disposalId);
  if (!persisted) return null;
  const validResp = ['carrier', 'equipment', 'loading', 'joint_review', 'undetermined'];
  if (validResp.indexOf(finalResponsibility) < 0) {
    throw new Error('final_responsibility 必须是 carrier/equipment/loading/joint_review/undetermined 之一');
  }
  disposalRepo.setFinalConclusion(disposalId, finalResponsibility, finalNote);
  if (operator || finalNote) {
    disposalRepo.addNote(disposalId, 'customer_service',
      '最终结论: ' + finalResponsibility + (finalNote ? ' - ' + finalNote : ''),
      operator || null);
  }
  return generateDisposalOrder(persisted.waybill_no, { audience: 'internal' });
}

function batchRiskBoard(waybillNos) {
  const groups = {
    rejection_recommended: [],
    review_required: [],
    suggest_signoff: []
  };
  const flags = [];

  for (const no of waybillNos) {
    const summary = summarizeWaybillAudit(no);
    if (!summary) continue;
    const level = summary.signoff_risk ? summary.signoff_risk.level : 'suggest_signoff';
    const entry = {
      waybill_no: no,
      signoff_level: level,
      signoff_label: summary.signoff_risk ? summary.signoff_risk.label : null,
      responsibility_tendency: summary.responsibility_tendency ?
        summary.responsibility_tendency.tendency : null,
      quality_priority: summary.quality_inspection ?
        summary.quality_inspection.sampling_priority : null,
      violation_count: summary.status_counts ? summary.status_counts.violation || 0 : 0,
      flags: []
    };
    if (summary.quality_inspection && summary.quality_inspection.sampling_priority === 'high') {
      entry.flags.push('need_quality_inspection');
    }
    if (summary.responsibility_tendency &&
        summary.responsibility_tendency.tendency === 'equipment') {
      entry.flags.push('need_equipment_followup');
    }
    if (groups[level]) {
      groups[level].push(entry);
    }
    flags.push(entry);
  }

  return {
    total: waybillNos.length,
    grouped: {
      rejection_recommended: {
        label: '建议拒收',
        count: groups.rejection_recommended.length,
        waybills: groups.rejection_recommended
      },
      review_required: {
        label: '建议复核',
        count: groups.review_required.length,
        waybills: groups.review_required
      },
      suggest_signoff: {
        label: '建议签收',
        count: groups.suggest_signoff.length,
        waybills: groups.suggest_signoff
      }
    },
    priority_flags: {
      need_quality_inspection: groups.rejection_recommended
        .concat(groups.review_required)
        .filter(function(w) { return w.flags.indexOf('need_quality_inspection') >= 0; })
        .map(function(w) { return w.waybill_no; }),
      need_equipment_followup: flags
        .filter(function(w) { return w.flags.indexOf('need_equipment_followup') >= 0; })
        .map(function(w) { return w.waybill_no; })
    }
  };
}

module.exports = {
  AUDIT_STATUS,
  TEMP_STATUS,
  DOOR_STATUS,
  COOLER_STATUS_ENUM,
  TRANSPORT_STAGE,
  SIGNOFF_RISK_LEVEL,
  RESPONSIBILITY,
  auditSegment,
  processSegmentAudit,
  summarizeWaybillAudit,
  generateEvidence,
  generateDisposalOrder,
  getDisposalOrder,
  getDisposalByWaybill,
  addDisposalNote,
  setDisposalFinalConclusion,
  batchRiskBoard,
  generateTextConclusion,
  getTimePeriod,
  classifyTransportStage,
  evaluateSignoffRisk,
  evaluateResponsibilityTendency,
  buildQualityInspection,
  buildStageOverview
};
