const { createApp } = require('./src/app');
const config = require('./config');

const port = config.port;

createApp().then(function(app) {
  const server = app.listen(port, function() {
    console.log('='.repeat(60));
    console.log('  肉类冷链温区稽核后端服务 v1.0.0');
    console.log('  Cold Chain Audit Service for Meat Logistics');
    console.log('='.repeat(60));
    console.log('  监听端口:', port);
    console.log('  服务地址: http://localhost:' + port);
    console.log('='.repeat(60));
    console.log('');
    console.log('  接口清单:');
    console.log('  GET    /health                                       健康检查');
    console.log('  GET    /api/zone-configs                            获取温区配置');
    console.log('  POST   /api/waybills                                创建运单');
    console.log('  GET    /api/waybills/:waybillNo                     查询运单');
    console.log('  POST   /api/segments                                上传温度片段（设备平台）');
    console.log('  POST   /api/segments/batch                          批量上传温度片段');
    console.log('  GET    /api/segments/waybill/:waybillNo             查询运单的温度片段');
    console.log('  GET    /api/audits/waybill/:waybillNo               查询运单的稽核结果（调度系统）');
    console.log('  GET    /api/summary/waybill/:waybillNo              查询温区摘要（客户签收系统）');
    console.log('  POST   /api/evidence/:waybillNo                     生成争议证据（客服系统）');
    console.log('');
  });

  process.on('SIGINT', function() {
    console.log('\n正在关闭服务...');
    server.close(function() {
      console.log('服务已关闭');
      process.exit(0);
    });
  });
}).catch(function(e) {
  console.error('启动失败:', e);
  process.exit(1);
});
