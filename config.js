module.exports = {
  port: process.env.PORT || 3000,
  dbPath: process.env.DB_PATH || './coldchain.db',
  audit: {
    warningTempBuffer: 2,
    singleViolationMinMinutes: 10,
    totalViolationMinMinutes: 30,
    doorOpenMinMinutes: 5,
    manualReviewAmbiguousGapMinutes: 30
  }
};
