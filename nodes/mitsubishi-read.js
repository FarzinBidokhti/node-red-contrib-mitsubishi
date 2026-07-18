/**
 * mitsubishi-read — 三菱 MC Protocol 3E/4E 读取节点 v1.3.1
 *
 * v1.3.0: 设备ID手动配置 + 表格分页(支持上千点位) + 计算点位(referenceTag+operator) + CSV导入导出
 * v1.2.2: 队列深度上限 + 入口节流 + Buffer上限 + 动态连接追踪 + finishWithError释放 + 清理队列检查
 * 变换: engValue = rawValue * slope + offset
 * 计算: 设置引用ID和运算符(add/sub/mul/div)即可合并多寄存器值
 * 输出: msg.payload.data[tagId] = {rawValue, engValue, quality, ts}
 */
module.exports = function (RED) {
  var net = require('net');

  // ===== MC 软元件代码映射 =====
  var MC_DEVICE_CODES = {
    'D': 0xA8, 'W': 0xB4, 'X': 0x9C, 'Y': 0x9D,
    'M': 0x90, 'L': 0x92, 'B': 0xA0, 'R': 0xAF
  };
  var BIT_DEVICES = { 'X': true, 'Y': true, 'M': true, 'L': true, 'B': true };

  // ===== MC 错误码映射 =====
  var MC_ERROR_CODES = {
    0xC050: 'CPU busy', 0xC051: 'Device not supported', 0xC052: 'Address out of range',
    0xC053: 'Batch size out of range', 0xC054: 'Write protect error',
    0xC055: 'Remote operation error', 0xC056: 'File not found', 0xC057: 'File name error',
    0xC059: 'Points out of range', 0xC05B: 'CPU type mismatch', 0xC05C: 'Remote password error',
    0xC05F: 'CPU module error', 0xC061: 'Monitor timer timeout',
    0xC06F: 'ASCII code error', 0xC070: 'Frame length error',
    0xC0D0: 'PLC not running', 0x4004: '4E: Device not supported',
    0x401A: '4E: Address out of range', 0x4028: '4E: Points out of range'
  };
  function mcErrorText(code) {
    return MC_ERROR_CODES[code] || ('Unknown MC error 0x' + code.toString(16).toUpperCase());
  }

  function clampInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.max(min, Math.min(n, max));
  }

  // ===== 帧构造 =====
  function build3EFrame(startAddr, wordCount, stationNo, regType, networkNo) {
    var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
    var buf = Buffer.alloc(21);
    buf[0] = 0x50; buf[1] = 0x00;
    buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
    buf[6] = stationNo || 0; buf[7] = 0x0C; buf[8] = 0x00;
    buf[9] = 0x10; buf[10] = 0x00;
    buf[11] = 0x01; buf[12] = 0x04; buf[13] = 0x00; buf[14] = 0x00;
    buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
    buf[17] = (startAddr >> 16) & 0xFF;
    buf[18] = deviceCode;
    buf.writeUInt16LE(wordCount, 19);
    return buf;
  }

  function build4EFrame(startAddr, wordCount, stationNo, regType, networkNo, serialNo) {
    var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
    var hasSN = (serialNo !== 0);
    var buf = Buffer.alloc(hasSN ? 24 : 22);
    buf[0] = 0x54; buf[1] = 0x00;
    buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
    buf[6] = stationNo || 0;
    buf[7] = hasSN ? 0x0F : 0x0D; buf[8] = 0x00;
    buf[9] = 0x10; buf[10] = 0x00;
    var off = 11;
    if (hasSN) { buf[off] = serialNo & 0xFF; buf[off + 1] = (serialNo >> 8) & 0xFF; off += 2; }
    buf[off] = 0x01; buf[off + 1] = 0x04; off += 2;
    buf[off] = 0x00; buf[off + 1] = 0x00; off += 2;
    buf.writeUInt32LE(startAddr, off); off += 4;
    buf[off] = deviceCode; off += 1;
    buf.writeUInt16LE(wordCount, off);
    return buf;
  }

  // ===== 响应解析 =====
  // 注: 3E 帧无序列号字段，但 TCP 保证同连接有序交付 + 连接池串行化请求，不会收到旧帧
  function parseMCResponse(buf, startAddr, regType, frameType, sentSN) {
    if (!buf || buf.length < 11) return { err: 'Buffer too short' };
    var subheader = (buf[0] === 0xD0) ? 0x50 : ((buf[0] === 0xD4) ? 0xD4 : 0);
    if (subheader === 0) return { err: 'Invalid subheader' };

    var endCode = buf.readUInt16LE(9);
    if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };

    var dataLen = buf.readUInt16LE(7) - ((frameType === '4E') ? 4 : 2);
    if (dataLen < 0 || dataLen > 2000) return { err: 'Bad dataLen: ' + dataLen };

    var dataStart = (frameType === '4E') ? 13 : 11;
    if (frameType === '4E' && sentSN > 0 && buf.length >= 13) {
      if (buf.readUInt16LE(11) !== sentSN) return { err: 'SerialNo mismatch' };
    }

    if (buf.length < dataStart + dataLen) return { err: 'Incomplete frame' };

    var result = {};
    if (BIT_DEVICES[regType]) {
      for (var w = 0; w < dataLen / 2; w++) {
        var wordVal = buf.readUInt16LE(dataStart + w * 2);
        for (var b = 0; b < 16; b++) {
          result[regType + (startAddr + w * 16 + b)] = (wordVal >> b) & 1;
        }
      }
    } else {
      for (var i = 0; i < dataLen / 2; i++) {
        result[regType + (startAddr + i)] = buf.readInt16LE(dataStart + i * 2);
      }
    }
    return result;
  }

  // ===== 斜率偏移变换 =====
  function applyTransform(rawValue, tagDef) {
    if (rawValue === null || rawValue === undefined) return null;
    var slope = parseFloat(tagDef.slope || tagDef.transformSlopeA || 1);
    var offset = parseFloat(tagDef.offset || tagDef.transformOffsetB || 0);
    if (isNaN(slope)) slope = 1;
    if (isNaN(offset)) offset = 0;
    var eng = rawValue * slope + offset;
    return parseFloat(eng.toFixed(4));
  }

  // ====================================================================
  //  长连接池 v1.2.2 — 队列上限 + 清理队列检查
  // ====================================================================
  var CONN_POOL = {};  // key = "host:port" → { socket, inUse, lastUsed, queue[] }
  var MAX_QUEUE = 50;  // 🔧 R1: 队列深度上限，防止 PLC 慢速时 OOM

  function poolKey(host, port) {
    return host + ':' + port;
  }

  function getConnection(node, host, port, timeout, callback) {
    var key = poolKey(host, port);
    var entry = CONN_POOL[key];

    // 如果有可用连接且空闲，直接复用
    if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse) {
      entry.inUse = true;
      entry.lastUsed = Date.now();
      entry.socket.setTimeout(timeout);
      callback(null, entry.socket);
      return;
    }

    // 有连接但正在使用中 → 加入队列
    if (entry && entry.socket && !entry.socket.destroyed && entry.inUse) {
      entry.queue = entry.queue || [];
      // 🔧 R1: 队列深度上限
      if (entry.queue.length >= MAX_QUEUE) {
        callback(new Error('Queue full (' + MAX_QUEUE + ') — PLC too slow'));
        return;
      }
      entry.queue.push({ callback: callback, timeout: timeout });
      return;
    }

    // 新建连接
    var client = new net.Socket();
    client.setTimeout(timeout);
    client.setKeepAlive(true, 30000);

    var connectTimer = setTimeout(function () {
      client.destroy();
      callback(new Error('connect timeout'));
    }, timeout);

    client.connect(port, host, function () {
      clearTimeout(connectTimer);
      if (entry) {
        entry.socket = client;
        entry.inUse = true;
        entry.lastUsed = Date.now();
        entry.queue = entry.queue || [];
      } else {
        CONN_POOL[key] = {
          socket: client,
          inUse: true,
          lastUsed: Date.now(),
          queue: []
        };
        entry = CONN_POOL[key];
      }
      callback(null, client);
    });

    client.on('error', function (e) {
      clearTimeout(connectTimer);
      if (!client.destroyed) { try { client.destroy(); } catch (_) {} }
      if (entry) {
        entry.socket = null;
        entry.inUse = false;
        var q = entry.queue || [];
        entry.queue = [];
        for (var qi = 0; qi < q.length; qi++) {
          q[qi].callback(e);
        }
      }
      callback(e);
    });
  }

  function releaseConnection(host, port) {
    var key = poolKey(host, port);
    var entry = CONN_POOL[key];
    if (!entry) return;
    if (entry.queue && entry.queue.length > 0) {
      var next = entry.queue.shift();
      entry.lastUsed = Date.now();
      if (entry.socket && !entry.socket.destroyed) {
        entry.socket.setTimeout(next.timeout);
        next.callback(null, entry.socket);
        return;
      }
      next.callback(new Error('Connection lost'));
      while (entry.queue && entry.queue.length > 0) {
        var qn = entry.queue.shift();
        qn.callback(new Error('Connection lost'));
      }
    }
    entry.inUse = false;
    entry.lastUsed = Date.now();
  }

  function destroyConnection(host, port) {
    var key = poolKey(host, port);
    var entry = CONN_POOL[key];
    if (!entry) return;
    if (entry.socket && !entry.socket.destroyed) {
      try { entry.socket.destroy(); } catch (_) {}
    }
    var q = entry.queue || [];
    entry.queue = [];
    delete CONN_POOL[key];
    for (var qi = 0; qi < q.length; qi++) {
      q[qi].callback(new Error('Connection destroyed'));
    }
  }

  // 每 5 分钟清理超过 10 分钟未用的空闲连接
  var _cleanTimer = setInterval(function () {
    var now = Date.now();
    var keys = Object.keys(CONN_POOL);
    for (var i = 0; i < keys.length; i++) {
      var entry = CONN_POOL[keys[i]];
      if (!entry.inUse && entry.socket && (now - entry.lastUsed > 600000)) {
        // 🔧 R11: 通知排队请求（边界条件下可能存在）
        if (entry.queue && entry.queue.length > 0) {
          var q = entry.queue;
          entry.queue = [];
          for (var qi = 0; qi < q.length; qi++) {
            q[qi].callback(new Error('Connection idle timeout'));
          }
        }
        try { entry.socket.destroy(); } catch (_) {}
        delete CONN_POOL[keys[i]];
      }
    }
  }, 300000);
  if (_cleanTimer.unref) _cleanTimer.unref();

  // ===== 主节点 =====
  function MitsubishiReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.plcConfig = RED.nodes.getNode(config.plc);
    if (!node.plcConfig) {
      node.error('未关联 PLC 配置节点');
      return;
    }
    node.serialNo = parseInt(config.serialNo, 10) || 0;
    node.configDeviceId = String(config.deviceId || '');  // 🆕 独立使用时手动配置的设备ID

    // 🔧 R6/R7: 追踪动态创建的连接，close 时统一清理
    node._usedConns = {};

    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg) {
      var cfg = node.plcConfig;
      var incoming = msg.payload || {};
      var pp = incoming.protocolParams || {};
      var plc = {
        name: cfg.name, host: incoming.plcIp || cfg.host,
        port: incoming.plcPort || cfg.port, frame: pp.mcFrame || cfg.frame || '3E',
        networkNo: pp.networkNo || cfg.networkNo || 0,
        stationNo: pp.stationNo || cfg.stationNo || 0,
        timeout: clampInt(incoming.timeout || cfg.timeout, 3000, 500, 30000),
        maxRetries: clampInt(incoming.maxRetries || cfg.maxRetries, 2, 0, 10),
        retryInterval: clampInt(incoming.retryInterval || cfg.retryInterval, 300, 50, 10000)
      };

      // 🔧 优先级: 面板填写 > 上游 msg.payload.id > msg.payload.deviceId > hash
      function resolveDeviceId(incoming, plc) {
        // 面板填了就优先用，不管上游传什么
        if (node.configDeviceId && node.configDeviceId !== '') {
          var n = parseInt(node.configDeviceId, 10);
          if (!isNaN(n) && n > 0) return n;
        }
        var id = incoming.id || incoming.deviceId;
        if (id !== undefined && id !== null && id !== '') {
          var m = parseInt(id, 10);
          if (!isNaN(m) && m > 0) return m;
        }
        var name = incoming.deviceName || plc.name || node.configDeviceId || (plc.host + ':' + plc.port);
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash) + name.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash) % 9000 + 1000;
      }
      var deviceId = resolveDeviceId(incoming, plc);

      var _sent = false;
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        node.send(m);
      }

      // === 读取点位: msg.tags → msg.payload.tags → 节点表格配置 ===
      var rawTags = msg.tags || incoming.tags;
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) {
        rawTags = configTags;
      }
      if (!Array.isArray(rawTags)) rawTags = [rawTags];
      var tags = rawTags;

      var validTags = [];
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        var rt = t.regType || 'D';
        if (!MC_DEVICE_CODES[rt]) {
          if (rt) node.warn('[MC] Unknown regType: ' + rt + ', using D');
          rt = 'D';
        }
        var DT_MAP = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var dt = DT_MAP[t.dataType] || t.dataType || 'INT16';
        var rawAddr = (t.addr !== undefined) ? t.addr : (t.regAddr || t.tag_address || t.registerAddress || '');
        if (typeof rawAddr === 'string') rawAddr = String(rawAddr).replace(/\D/g, '');
        var addr = parseInt(rawAddr, 10);
        if (isNaN(addr) || addr < 0) {
          node.warn('[MC] Invalid addr for tag ' + (t.id || t.name || ('#' + i)));
          continue;
        }
        var tagId = t.id || t.name || (rt + addr);
        validTags.push({
          id: String(tagId),
          regType: rt,
          addr: addr,
          dataType: dt,
          slope: t.slope || t.transformSlopeA || 1,
          offset: t.offset || t.transformOffsetB || 0,
          operator: t.operator || '',           // 🆕 计算点位
          referenceTag: t.referenceTag || '',   // 🆕 引用其他点位
          name: t.name || (rt + addr)
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        return;
      }

      var timeout = plc.timeout;
      var maxRetries = plc.maxRetries;
      var retryInterval = plc.retryInterval;
      var frameType = plc.frame;
      var stationNo = plc.stationNo;
      var networkNo = plc.networkNo;
      var roundStart = Date.now();

      // === 模拟模式 ===
      var SIM_MODE = false;
      try { SIM_MODE = RED.settings.mcSimulationMode || false; } catch (e) {}

      if (SIM_MODE) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = BIT_DEVICES[t.regType] ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 1000);
          simOut[t.id] = { rawValue: raw, engValue: applyTransform(raw, t), quality: 0, ts: new Date().toISOString() };
        });
        msg.payload = { success: true, deviceId: deviceId, data: simOut, error: null, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        safeSend(msg);
        return;
      }

      // === 去重（计算点位不参与去重，因为同地址但用途不同）===
      var seen = {};
      var deduped = [];
      for (var di = validTags.length - 1; di >= 0; di--) {
        var dtag = validTags[di];
        if (dtag.operator) {
          // 计算点位始终保留（同地址但需要合并其他点位值）
          deduped.unshift(dtag);
        } else {
          var dk = dtag.regType + '|' + dtag.addr;
          if (!seen[dk]) { seen[dk] = true; deduped.unshift(dtag); }
        }
      }
      if (deduped.length < validTags.length) {
        node.warn('[MC] Deduped ' + (validTags.length - deduped.length) + ' duplicate tags');
      }
      validTags = deduped;

      // === 聚类分组 ===
      var byRegType = {};
      validTags.forEach(function (t) {
        if (!byRegType[t.regType]) byRegType[t.regType] = [];
        byRegType[t.regType].push(t);
      });

      var groups = [];
      Object.keys(byRegType).forEach(function (rt) {
        var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
        var cluster = [sorted[0]];
        for (var i = 1; i < sorted.length; i++) {
          var gap = sorted[i].addr - cluster[cluster.length - 1].addr;
          if (gap <= 20 && cluster.length < 50) {
            cluster.push(sorted[i]);
          } else {
            groups.push({ regType: rt, tags: cluster });
            cluster = [sorted[i]];
          }
        }
        if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
      });

      if (groups.length === 0) {
        node.status({ fill: 'red', shape: 'ring', text: 'no groups' });
        msg.payload = { success: false, deviceId: deviceId, data: {}, error: 'No valid register groups' };
        safeSend(msg);
        return;
      }

      // 🔧 R2: 入口节流 — 队列深度 > 20 时跳过本周期
      var connKey = poolKey(plc.host, plc.port);
      var poolEntry = CONN_POOL[connKey];
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'throttled' });
        return;
      }

      // === 获取长连接 → 顺序处理 groups ===
      var allRaw = {};
      var hasFailed = false;
      var firstError = '';
      var currentSN = node.serialNo;

      // 🔧 R6/R7: 追踪此连接
      node._usedConns = node._usedConns || {};
      node._usedConns[connKey] = true;

      getConnection(node, plc.host, plc.port, timeout, function (err, mcSocket) {
        if (err) {
          hasFailed = true;
          firstError = '[CONNECT] ' + err.message;
          msg.payload = {
            success: false,
            deviceId: deviceId,
            data: {},
            error: firstError,
            driverType: 'driver-mc-protocol',
            plcIp: plc.host, plcPort: plc.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'connect fail' });
          safeSend(msg);
          return;
        }

        function processGroup(gi) {
          if (gi >= groups.length) {
            releaseConnection(plc.host, plc.port);
            var output = {};
            validTags.forEach(function (t) {
              var entry = allRaw[t.id];
              if (entry) {
                output[t.id] = {
                  rawValue: entry.rawValue,
                  convertedValue: entry.convertedValue,  // 🆕 供计算点位使用（32位全值）
                  engValue: applyTransform(entry.convertedValue, t),
                  quality: entry.quality,
                  ts: entry.ts,
                  regType: t.regType
                };
              }
            });

            // 🆕 计算点位：this.convertedValue [op] ref.convertedValue
            validTags.forEach(function (t) {
              if (!t.operator || !t.referenceTag) return;
              var thisEntry = output[t.id];
              var refEntry = output[t.referenceTag];
              if (!thisEntry || !refEntry) return;
              // 使用 convertedValue（32位类型的完整解码值），而非 rawValue（仅低16位）
              var a = (thisEntry.convertedValue != null) ? thisEntry.convertedValue : thisEntry.rawValue;
              var b = (refEntry.convertedValue != null) ? refEntry.convertedValue : refEntry.rawValue;
              if (a == null || b == null) return;
              var result = null;
              switch (t.operator) {
                case 'add': result = a + b; break;
                case 'sub': result = a - b; break;
                case 'mul': result = a * b; break;
                case 'div': result = b !== 0 ? a / b : null; break;
              }
              if (result != null) {
                thisEntry.rawValue = parseFloat(result.toFixed(4));
                thisEntry.engValue = applyTransform(result, t);
              }
            });

            msg.payload = {
              success: !hasFailed,
              deviceId: deviceId,
              data: output,
              error: hasFailed ? firstError : null,
              driverType: 'driver-mc-protocol',
              plcIp: plc.host,
              plcPort: plc.port,
              roundTimeMs: Date.now() - roundStart
            };
            node.status({
              fill: hasFailed ? 'red' : 'green',
              shape: 'dot',
              text: (plc.name || plc.host) + ' ' + Object.keys(output).length + ' vals ' + (Date.now() - roundStart) + 'ms'
            });
            safeSend(msg);
            return;
          }

          var grp = groups[gi];
          var addrs = grp.tags.map(function (t) { return t.addr; });
          var startA = addrs[0];
          var isBit = BIT_DEVICES[grp.regType] || false;
          if (isBit) startA = startA - (startA % 16);

          var wordCount;
          if (isBit) {
            wordCount = Math.ceil((addrs[addrs.length - 1] - startA + 1) / 16);
          } else {
            wordCount = addrs[addrs.length - 1] - startA + 1;
          }

          var MAX_WORDS = isBit ? 15360 : 960;
          if (wordCount > MAX_WORDS) {
            var newGroups = [];
            var ss = 0;
            while (ss < grp.tags.length) {
              var se = ss;
              while (se < grp.tags.length && (grp.tags[se].addr - grp.tags[ss].addr) < MAX_WORDS) se++;
              newGroups.push({ regType: grp.regType, tags: grp.tags.slice(ss, se) });
              ss = se;
            }
            groups.splice.apply(groups, [gi, 1].concat(newGroups));
            setTimeout(function () { processGroup(gi); }, 0);
            return;
          }

          function attemptGroup(attempt) {
            if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
            if (_errHandler) mcSocket.removeListener('error', _errHandler);

            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = 'MC read failed for ' + grp.regType + startA;
              mcSocket.removeListener('data', _dataHandler);
              if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
              if (_errHandler) mcSocket.removeListener('error', _errHandler);
              setTimeout(function () { processGroup(gi + 1); }, 0);
              return;
            }

            if (mcSocket.destroyed) {
              destroyConnection(plc.host, plc.port);
              getConnection(node, plc.host, plc.port, timeout, function (e2, newSock) {
                if (e2) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RECONNECT] ' + e2.message;
                  releaseConnection(plc.host, plc.port);
                  finishWithError();
                  return;
                }
                mcSocket = newSock;
                attemptGroup(attempt);
              });
              return;
            }

            var sentSN = (frameType === '4E' && currentSN > 0) ? currentSN : 0;
            if (frameType === '4E' && currentSN > 0) currentSN = (currentSN + 1) & 0xFFFF;

            var buf = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler, _errHandler, _dataHandler;

            mcSocket.setTimeout(timeout);

            try {
              var frame = (frameType === '4E')
                ? build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                : build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
              mcSocket.write(frame);
            } catch (e) {
              node.warn('[MC] write error: ' + e.message);
              resolved = true;
              destroyConnection(plc.host, plc.port);
              getConnection(node, plc.host, plc.port, timeout, function (e3, newSock2) {
                if (e3) {
                  releaseConnection(plc.host, plc.port);
                  finishWithError();
                  return;
                }
                mcSocket = newSock2;
                setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
              });
              return;
            }

            _dataHandler = function (chunk) {
              try {
                buf = Buffer.concat([buf, chunk]);
                // 🔧 R5: Buffer 上限 64KB，防畸形响应 OOM
                if (buf.length > 65536) {
                  resolved = true;
                  mcSocket.removeListener('data', _dataHandler);
                  if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
                  if (_errHandler) mcSocket.removeListener('error', _errHandler);
                  node.warn('[MC] Buffer overflow ' + buf.length + ' bytes, discarding');
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                  return;
                }
                var hdrLen = (frameType === '4E') ? 13 : 11;
                if (!resolved && buf.length >= hdrLen) {
                  var dataLen = buf.readUInt16LE(7) - ((frameType === '4E') ? 4 : 2);
                  if (dataLen < 0 || dataLen > 2000) {
                    resolved = true;
                    mcSocket.removeListener('data', _dataHandler);
                    if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
                    if (_errHandler) mcSocket.removeListener('error', _errHandler);
                    setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                    return;
                  }
                  if (buf.length >= hdrLen + dataLen) {
                    resolved = true;
                    mcSocket.removeListener('data', _dataHandler);
                    if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
                    if (_errHandler) mcSocket.removeListener('error', _errHandler);
                    var raw = parseMCResponse(buf, startA, grp.regType, frameType, sentSN);

                    if (raw && raw.mcError) {
                      hasFailed = true;
                      if (!firstError) firstError = '[PLC 0x' + raw.mcError.toString(16).toUpperCase() + '] ' + raw.mcErrorText;
                      setTimeout(function () { processGroup(gi + 1); }, 0);
                    } else if (raw && !raw.err) {
                      var groupTs = new Date().toISOString();
                      grp.tags.forEach(function (t) {
                        var key = grp.regType + t.addr;
                        var originRv = raw[key];
                        var cv = originRv;
                        var q = 0;
                        if (originRv === undefined || originRv === null) { q = 2; originRv = null; cv = null; }
                        else if (!isBit) {
                          var dtTag = t.dataType || 'INT16';
                          if (dtTag === 'UINT16') { if (cv < 0) cv += 65536; }
                          else if (dtTag === 'INT32' || dtTag === 'UINT32' || dtTag === 'FLOAT32') {
                            var adj = raw[grp.regType + (t.addr + 1)];
                            if (adj === undefined || adj === null) { q = 2; originRv = null; cv = null; }
                            else {
                              var hi = originRv, lo = adj;
                              var combined = (hi << 16) | (lo & 0xFFFF);
                              if (dtTag === 'INT32') cv = (combined > 0x7FFFFFFF) ? combined - 0x100000000 : combined;
                              else if (dtTag === 'UINT32') cv = combined >>> 0;
                              else if (dtTag === 'FLOAT32') {
                                var b32 = Buffer.alloc(4);
                                b32.writeInt16LE(hi, 0); b32.writeInt16LE(lo, 2);
                                cv = parseFloat(b32.readFloatLE(0).toFixed(4));
                              }
                            }
                          }
                        }
                        allRaw[t.id] = { rawValue: originRv, convertedValue: cv, quality: q, ts: groupTs };
                      });
                      setTimeout(function () { processGroup(gi + 1); }, 0);
                    } else {
                      setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                    }
                  }
                }
              } catch (e) {
                node.warn('[MC] data handler error: ' + e.message);
                mcSocket.removeListener('data', _dataHandler);
                if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
                if (_errHandler) mcSocket.removeListener('error', _errHandler);
                resolved = true;
                setTimeout(function () { processGroup(gi + 1); }, 0);
              }
            };

            mcSocket.on('data', _dataHandler);

            _tmoHandler = function () {
              if (resolved) return;
              resolved = true;
              mcSocket.removeListener('data', _dataHandler);
              if (_errHandler) mcSocket.removeListener('error', _errHandler);
              destroyConnection(plc.host, plc.port);
              getConnection(node, plc.host, plc.port, timeout, function (e4, newSock3) {
                if (e4) {
                  releaseConnection(plc.host, plc.port);
                  finishWithError();
                  return;
                }
                mcSocket = newSock3;
                setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
              });
            };
            mcSocket.once('timeout', _tmoHandler);

            _errHandler = function () {
              if (resolved) return;
              resolved = true;
              mcSocket.removeListener('data', _dataHandler);
              if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
              destroyConnection(plc.host, plc.port);
              getConnection(node, plc.host, plc.port, timeout, function (e5, newSock4) {
                if (e5) {
                  releaseConnection(plc.host, plc.port);
                  finishWithError();
                  return;
                }
                mcSocket = newSock4;
                setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
              });
            };
            mcSocket.once('error', _errHandler);
          }
          attemptGroup(0);
        }

        // 🔧 R10: finishWithError 增加防御性 releaseConnection
        function finishWithError() {
          releaseConnection(plc.host, plc.port);
          msg.payload = {
            success: false,
            deviceId: deviceId,
            data: {},
            error: firstError || 'MC connection lost',
            driverType: 'driver-mc-protocol',
            plcIp: plc.host, plcPort: plc.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'conn lost' });
          safeSend(msg);
        }

        processGroup(0);
      }); // getConnection
    }); // on('input')

    // ===== close: 释放此节点关联的所有连接（包括动态IP创建的）=====
    node.on('close', function (done) {
      // 🔧 R7: 清理所有追踪到的连接
      var conns = node._usedConns || {};
      var keys = Object.keys(conns);
      for (var ci = 0; ci < keys.length; ci++) {
        destroyConnection(keys[ci]);
      }
      // 也清理 config 固定连接（兜底）
      try {
        var p2 = node.plcConfig;
        if (p2 && p2.host) {
          destroyConnection(p2.host, p2.port);
        }
      } catch (e) {}
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('mitsubishi-read', MitsubishiReadNode);
};
