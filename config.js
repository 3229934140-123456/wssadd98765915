module.exports = {
  port: process.env.PORT || 3000,
  dbPath: process.env.DB_PATH || './coldchain.db',
  audit: {
    warningTempBuffer: 2,
    peakViolationMultiplier: 2,
    singleViolationMinMinutes: 10,
    totalViolationMinMinutes: 30,
    doorOpenMinMinutes: 5,
    manualReviewAmbiguousGapMinutes: 30
  },
  timePeriods: {
    dawn: { start: 0, end: 6, label: '凌晨(0:00-6:00)' },
    morning: { start: 6, end: 12, label: '上午(6:00-12:00)' },
    afternoon: { start: 12, end: 18, label: '下午(12:00-18:00)' },
    evening: { start: 18, end: 24, label: '晚间(18:00-24:00)' }
  },
  transportStages: {
    in_transit: { label: '在途', keywords: ['高速', '路段', '国道', '省道', '公路', '途中', '行驶'] },
    stop: { label: '停靠', keywords: ['服务区', '停车', '休息', '收费站', '检查站', '停靠'] },
    loading_unloading: { label: '装卸', keywords: ['仓库', '冷库', '场站', '装卸', '卸货', '装货', '配送', '收货', '发货'] }
  },
  signoffRisk: {
    levels: {
      SUGGEST_SIGNOFF: 'suggest_signoff',
      REVIEW_REQUIRED: 'review_required',
      REJECTION_RECOMMENDED: 'rejection_recommended'
    },
    labels: {
      suggest_signoff: '建议签收',
      review_required: '建议复核',
      rejection_recommended: '建议拒收'
    },
    rejectionThreshold: {
      violationCount: 3,
      totalViolationMinutes: 45,
      hasPeakViolation: true,
      hasCoolerError: true,
      doorViolationCount: 3
    }
  }
};
