## v1.4.2 (2026-07-18)
- CHORE: 发布 v1.4.2

## v1.4.1 (2026-07-18)
- FIX: 输出补全 `deviceName` — 模拟/成功/失败/节流/无组/连接丢失路径全部携带，兼容下游 `sf-data-processor`
- FIX: 连接池引用计数 — `CONN_POOL[key].users[nodeId]` 跟踪节点使用关系，单个节点 close 不再误杀其他节点共享的连接
- FIX: `_activeNodeCount` 泄漏 — PLC 配置未关联时提前 return 前正确递减，清理定时器可正常停止
- FIX: socket 闭包捕获 — `attemptGroup` 内 timeout/error/data 处理器通过 IIFE 绑定当前 socket 实例，重连后避免误操作新 socket
- FIX: 统一监听器清理 — `cleanupListeners(sock)` 替代多处重复 removeListener
- TEST: 新增 `deviceName` 传入与 fallback 到 PLC 配置名的测试

## v1.4.0 (2026-07-18)
- FIX: INT32/UINT32 高低字顺序修正（D0 为低字，D1 为高字）
- FIX: X/Y 位元件地址按三菱八进制解析与显示
- FIX: 4E 帧始终携带序列号字段，兼容严格 PLC 实现
- FIX: 位元件批量字数上限统一为 960 字（15360 点）
- FIX: 32 位类型自动扩展读取范围以包含相邻寄存器
- FIX: 数据处理器异常时正确标记失败并继续后续组
- FIX: deviceId hash 边界值处理（`Math.abs` 负数问题）
- FIX: Buffer 溢出判断前置于 `Buffer.concat`
- FIX: frameType 支持大小写不敏感
- ENHANCE: 连接池 key 增加帧格式/网络号/站号，避免不同配置冲突
- ENHANCE: 并发建连请求串行化，防止同一 PLC 建立多个 socket
- ENHANCE: socket 增加 `end`/`close` 监听，快速检测干净断连
- ENHANCE: 连接失败指数退避，避免重连风暴
- ENHANCE: 队列请求增加超时机制
- ENHANCE: 输入节流时输出失败消息，不再静默丢弃
- ENHANCE: 支持 Node-RED 1.0+ `done()` 回调
- ENHANCE: 全局清理定时器在最后一个节点关闭时停止
- TEST: 新增单元测试覆盖帧构造、解码、连接池


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
