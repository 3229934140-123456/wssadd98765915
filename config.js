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
  }
};
