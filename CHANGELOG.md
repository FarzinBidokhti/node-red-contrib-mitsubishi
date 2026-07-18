## v1.3.1 (2026-07-17)
- FIX: 计算点位 — operator/referenceTag 未写入 validTags 导致计算失效
- FIX: 计算点位 — 32位类型用 convertedValue（全解码值），非 rawValue（低16位）
- FIX: CSV 导入 — 字段映射冗余 fallback 修正

## v1.3.0 (2026-07-17)
- NEW: 设备ID手动配置 — config 面板新增 deviceId 字段，独立使用无需 msg.payload.id
- NEW: 表格分页 — 每页 50/100/200/500 条，支持上千点位不卡顿
- NEW: 计算点位 — referenceTag + operator(add/sub/mul/div) 合并多寄存器值 (如 D0+D1)
- NEW: CSV导入导出 — 批量管理点位数据
- ENHANCE: 表头 sticky 固定 + 滚动体限制 420px

## v1.2.2 (2026-07-14)
- FIX: 队列深度上限 R1 — MAX_QUEUE=50，PLC慢速时拒绝入队防OOM
- FIX: 入口节流 R2 — 队列>20时跳过本周期，防雪崩
- FIX: Buffer上限 R5 — 64KB上限，畸形响应防内存泄漏
- FIX: 动态连接追踪 R6/R7 — close时清理所有曾用连接（含动态IP）
- FIX: finishWithError 防御性释放 R10
- FIX: 清理定时器队列检查 R11
- PERF: groupTs 每组合并时间戳，减少 new Date() 调用

## v1.2.1 (2026-07-14)
- ENHANCE: 连接池请求队列 — 多节点共享同一PLC时排队串行，防止读写交错
- ENHANCE: TCP keepalive (setKeepAlive 30s) — 防止空闲连接被交换机断开
- FIX: 事件监听器残留 — once('timeout')/once('error') 在成功路径中精确清理
- FIX: deviceId 归一化为数字 — 防止下游 edge_commStatus 索引类型错乱
- FIX: node.send 防重入保护 — safeSend 确保每次 on('input') 只输出一条消息
- CLEAN: 移除死代码 connLog + refCount
- DOCS: 版本号注释与 package.json 对齐

## v1.2.0 (2026-07-04)
- FIX: busy-wait self-send causing 4GB heap OOM (message clone storm)
- FIX: deviceId now uses msg.payload.id (numeric) first, falling back to deviceName
- FIX: lock conflict now drops message directly instead of setTimeout(self-send)
# Changelog

## 1.0.2 (2026-06-30)

### Fixed
- 输出添加 `regType` 字段，适配 `edgelink-pg-store` 直写 `register_type` 列
- `rawValue` 保留 PLC 原始 int16，`engValue` 使用解码值 × 斜率 + 偏移
- 4E 帧 `serialNo` 首帧不再跳号（先赋值再递增）
- 输出添加 `deviceId` 字段，适配 pg-store 动态分表

## 1.0.1 (2026-06-29)

### Added
- 14 个运行时 BUG 修复（锁重入、异步异常、serialNo 自增、批量超限、脏帧拦截等）
- `close` 处理器：节点关闭时释放全局锁
- `_destroyedByUs` 标志：区分主动关闭与异常断开

## 1.0.0 (2026-06-29)

### Initial Release
- 三菱 MC Protocol 3E/4E 以太网采集
- 表格编辑器：一个节点读写 N 个点位
- 6 种数据类型：INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / BOOL
- 8 种软元件：D / W / R / X / Y / M / L / B
- 斜率偏移变换：`engValue = rawValue × slope + offset`
- 19 个 MC 错误码中文映射
- 全局模拟模式
- 零外部依赖（纯 Node.js `net` + `Buffer`）
