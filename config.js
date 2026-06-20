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
  },
  responsibility: {
    carrier: { label: '承运方', key: 'carrier' },
    equipment: { label: '设备方', key: 'equipment' },
    loading: { label: '装卸方', key: 'loading' },
    joint_review: { label: '需共同复核', key: 'joint_review' }
  },
  qualityInspection: {
    samplingPriority: {
      rejection_recommended: 'high',
      review_required: 'medium',
      suggest_signoff: null
    },
    itemsByMeatType: {
      default: ['中心温度抽检', '感官品质检查', '包装完整性检查'],
      frozen: ['中心温度抽检', '解冻失水率检测', '冰晶状态检查', '包装完整性检查'],
      chilled: ['中心温度抽检', '菌落总数检测', '感官品质检查', '色泽气味检查'],
      ice_chilled: ['中心温度抽检', '鲜度指标检测', '感官品质检查', '包装密封检查']
    },
    evidenceRetention: [
      '运输过程温度记录',
      '开门事件及持续时间记录',
      '制冷机运行状态日志',
      '异常片段原始数据',
      '签收时货物现场照片',
      '温度检测仪校准记录'
    ]
  }
};
