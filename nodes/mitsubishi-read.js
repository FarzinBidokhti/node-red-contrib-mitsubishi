/**
 * mitsubishi-read — 三菱 MC Protocol 3E/4E 读取节点 v1.4.0
 *
 * v1.4.0: 生产级修复 — 连接池键包含帧/网络/站号、并发建连串行化、
 *          INT32/UINT32 高低字修正、X/Y 八进制地址、4E 序列号始终携带、
 *          位元件字数上限修正、32 位范围扩展、队列超时、重连退避、
 *          done() 回调、清理定时器生命周期。
 * v1.3.0: 设备ID手动配置 + 表格分页 + 计算点位 + CSV导入导出
 * 变换: engValue = rawValue * slope + offset
 * 计算: 设置引用ID和运算符(add/sub/mul/div)即可合并多寄存器值
 * 输出: msg.payload.data[tagId] = {rawValue, engValue, quality, ts}
 */
module.exports = function (RED) {
  var net = require('net');
  var mc = require('./mc-protocol');

  // ===== 长连接池 v1.4.0 — 键含帧/网络/站号、并发建连串行化、队列超时、退避
  var CONN_POOL = {};  // key = "host:port:frame:network:station" → entry
  var MAX_QUEUE = 50;
  var MAX_BACKOFF_MS = 10000;
  var _activeNodeCount = 0;
  var _cleanTimer = null;

  function ensureCleanTimer() {
    if (_cleanTimer) return;
    _cleanTimer = setInterval(function () {
      var now = Date.now();
      var keys = Object.keys(CONN_POOL);
      for (var i = 0; i < keys.length; i++) {
        var entry = CONN_POOL[keys[i]];
        if (!entry || entry.inUse || entry.connecting) continue;
        if (entry.socket && (now - entry.lastUsed > 600000)) {
          var q = entry.queue || [];
          entry.queue = [];
          for (var qi = 0; qi < q.length; qi++) {
            try { q[qi].callback(new Error('Connection idle timeout')); } catch (_) {}
          }
          try { entry.socket.destroy(); } catch (_) {}
          delete CONN_POOL[keys[i]];
        }
      }
    }, 300000);
    if (_cleanTimer.unref) _cleanTimer.unref();
  }

  function poolKey(plc) {
    // 同一 IP:端口 但帧格式/网络号/站号不同不能复用连接
    return plc.host + ':' + plc.port + ':' + plc.frame + ':' + plc.networkNo + ':' + plc.stationNo;
  }

  function getConnection(node, plc, callback) {
    var key = poolKey(plc);
    var entry = CONN_POOL[key];

    // 退避期：连接刚失败时避免立即重连风暴
    if (entry && entry.backoffMs && entry.lastErrorTime) {
      var sinceErr = Date.now() - entry.lastErrorTime;
      if (sinceErr < entry.backoffMs) {
        callback(new Error('connect backoff (' + (entry.backoffMs - sinceErr) + 'ms)'));
        return;
      }
    }

    // 复用空闲连接
    if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse && !entry.connecting) {
      entry.inUse = true;
      entry.lastUsed = Date.now();
      entry.socket.setTimeout(plc.timeout);
      callback(null, entry.socket);
      return;
    }

    // 连接正忙或正在建立 → 排队
    if (entry && (entry.inUse || entry.connecting)) {
      entry.queue = entry.queue || [];
      if (entry.queue.length >= MAX_QUEUE) {
        callback(new Error('Queue full (' + MAX_QUEUE + ') — PLC too slow'));
        return;
      }
      entry.queue.push({ callback: callback, timeout: plc.timeout, enqueueTime: Date.now() });
      return;
    }

    // 新建连接
    if (!entry) {
      entry = CONN_POOL[key] = {
        socket: null,
        inUse: false,
        lastUsed: 0,
        queue: [],
        connecting: true,
        backoffMs: 0,
        lastErrorTime: 0
      };
    } else {
      entry.connecting = true;
    }

    var client = new net.Socket();
    client.setTimeout(plc.timeout);
    client.setKeepAlive(true, 30000);

    var connectTimer = setTimeout(function () {
      client.destroy();
      onConnectError(new Error('connect timeout'));
    }, plc.timeout);

    function onConnectError(e) {
      clearTimeout(connectTimer);
      try { client.destroy(); } catch (_) {}
      entry.connecting = false;
      entry.socket = null;
      entry.inUse = false;
      entry.lastErrorTime = Date.now();
      var base = plc.retryInterval || 300;
      entry.backoffMs = Math.max(base, Math.min((entry.backoffMs || base) * 2, MAX_BACKOFF_MS));
      var q = entry.queue || [];
      entry.queue = [];
      for (var qi = 0; qi < q.length; qi++) {
        try { q[qi].callback(e); } catch (_) {}
      }
      callback(e);
    }

    client.once('error', onConnectError);

    client.connect(plc.port, plc.host, function () {
      clearTimeout(connectTimer);
      client.removeListener('error', onConnectError);

      entry.socket = client;
      entry.inUse = true;
      entry.connecting = false;
      entry.lastUsed = Date.now();
      entry.backoffMs = 0;
      entry.lastErrorTime = 0;

      // 空闲断连：PLC/交换机干净关闭时立即清理
      client.once('end', function () { destroyConnection(key); });
      client.once('close', function () { destroyConnection(key); });
      // 空闲错误：仅清理连接池，不调用请求 callback（由当前请求的 once('error') 处理）
      client.once('error', function () { destroyConnection(key); });

      callback(null, client);
    });
  }

  function releaseConnection(key) {
    var entry = CONN_POOL[key];
    if (!entry) return;
    if (entry.queue && entry.queue.length > 0) {
      var now = Date.now();
      while (entry.queue.length > 0) {
        var next = entry.queue.shift();
        if (now - next.enqueueTime > next.timeout) {
          try { next.callback(new Error('Queue timeout')); } catch (_) {}
          continue;
        }
        entry.lastUsed = Date.now();
        if (entry.socket && !entry.socket.destroyed) {
          entry.inUse = true;
          entry.socket.setTimeout(next.timeout);
          try { next.callback(null, entry.socket); } catch (_) {}
          return;
        }
        try { next.callback(new Error('Connection lost')); } catch (_) {}
      }
    }
    entry.inUse = false;
    entry.lastUsed = Date.now();
  }

  function destroyConnection(key) {
    var entry = CONN_POOL[key];
    if (!entry || entry._destroyed) return;
    entry._destroyed = true;
    if (entry.socket && !entry.socket.destroyed) {
      try { entry.socket.destroy(); } catch (_) {}
    }
    var q = entry.queue || [];
    entry.queue = [];
    delete CONN_POOL[key];
    for (var qi = 0; qi < q.length; qi++) {
      try { q[qi].callback(new Error('Connection destroyed')); } catch (_) {}
    }
  }

  // ===== 主节点 =====
  function MitsubishiReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    _activeNodeCount++;
    ensureCleanTimer();

    node.plcConfig = RED.nodes.getNode(config.plc);
    if (!node.plcConfig) {
      node.error('未关联 PLC 配置节点');
      return;
    }
    node.serialNo = parseInt(config.serialNo, 10) || 0;
    node.configDeviceId = String(config.deviceId || '');
    node._usedConns = {};

    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      var cfg = node.plcConfig;
      var incoming = msg.payload || {};
      var pp = incoming.protocolParams || {};
      var plc = {
        name: cfg.name,
        host: incoming.plcIp || cfg.host,
        port: incoming.plcPort || cfg.port,
        frame: String(pp.mcFrame || cfg.frame || '3E').toUpperCase(),
        networkNo: pp.networkNo || cfg.networkNo || 0,
        stationNo: pp.stationNo || cfg.stationNo || 0,
        timeout: mc.clampInt(incoming.timeout || cfg.timeout, 3000, 500, 30000),
        maxRetries: mc.clampInt(incoming.maxRetries || cfg.maxRetries, 2, 0, 10),
        retryInterval: mc.clampInt(incoming.retryInterval || cfg.retryInterval, 300, 50, 10000)
      };

      function resolveDeviceId(incoming, plc) {
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
        return ((hash >>> 0) % 9000) + 1000;
      }
      var deviceId = resolveDeviceId(incoming, plc);

      var _sent = false;
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        try { send(m); } catch (_) {}
        if (done) {
          try { done(); } catch (_) {}
        }
      }

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
        if (!mc.MC_DEVICE_CODES[rt]) {
          if (rt) node.warn('[MC] Unknown regType: ' + rt + ', using D');
          rt = 'D';
        }
        var DT_MAP = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var dt = DT_MAP[t.dataType] || t.dataType || 'INT16';
        var rawAddr = (t.addr !== undefined) ? t.addr : (t.regAddr || t.tag_address || t.registerAddress || '');
        var addr = mc.parseDeviceAddress(rt, rawAddr);
        if (addr < 0) {
          node.warn('[MC] Invalid addr for tag ' + (t.id || t.name || ('#' + i)));
          continue;
        }
        var displayAddr = (rt === 'X' || rt === 'Y') ? addr.toString(8).toUpperCase() : String(addr);
        var tagId = t.id || t.name || (rt + displayAddr);
        validTags.push({
          id: String(tagId),
          regType: rt,
          addr: addr,
          displayAddr: displayAddr,
          dataType: dt,
          slope: t.slope || t.transformSlopeA || 1,
          offset: t.offset || t.transformOffsetB || 0,
          operator: t.operator || '',
          referenceTag: t.referenceTag || '',
          name: t.name || (rt + displayAddr)
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        if (done) done();
        return;
      }

      var timeout = plc.timeout;
      var maxRetries = plc.maxRetries;
      var retryInterval = plc.retryInterval;
      var frameType = plc.frame;
      var stationNo = plc.stationNo;
      var networkNo = plc.networkNo;
      var roundStart = Date.now();

      var SIM_MODE = false;
      try { SIM_MODE = RED.settings.mcSimulationMode || false; } catch (e) {}

      if (SIM_MODE) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = mc.BIT_DEVICES[t.regType] ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 1000);
          simOut[t.id] = { rawValue: raw, engValue: mc.applyTransform(raw, t), quality: 0, ts: new Date().toISOString(), regType: t.regType };
        });
        msg.payload = { success: true, deviceId: deviceId, data: simOut, error: null, driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        safeSend(msg);
        return;
      }

      var seen = {};
      var deduped = [];
      for (var di = validTags.length - 1; di >= 0; di--) {
        var dtag = validTags[di];
        if (dtag.operator) {
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
        msg.payload = { success: false, deviceId: deviceId, data: {}, error: 'No valid register groups', driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        safeSend(msg);
        return;
      }

      var connKey = poolKey(plc);
      var poolEntry = CONN_POOL[connKey];
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'throttled' });
        msg.payload = { success: false, deviceId: deviceId, data: {}, error: 'Throttled: queue > 20', driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        safeSend(msg);
        return;
      }

      var allRaw = {};
      var hasFailed = false;
      var firstError = '';
      var currentSN = node.serialNo;

      node._usedConns[connKey] = true;

      getConnection(node, plc, function (err, mcSocket) {
        if (err) {
          msg.payload = {
            success: false,
            deviceId: deviceId,
            data: {},
            error: '[CONNECT] ' + err.message,
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
            releaseConnection(connKey);
            var output = {};
            validTags.forEach(function (t) {
              var entry = allRaw[t.id];
              if (entry) {
                output[t.id] = {
                  rawValue: entry.rawValue,
                  convertedValue: entry.convertedValue,
                  engValue: mc.applyTransform(entry.convertedValue, t),
                  quality: entry.quality,
                  ts: entry.ts,
                  regType: t.regType
                };
              }
            });

            validTags.forEach(function (t) {
              if (!t.operator || !t.referenceTag) return;
              var thisEntry = output[t.id];
              var refEntry = output[t.referenceTag];
              if (!thisEntry || !refEntry) {
                node.warn('[MC] Calc tag ' + t.id + ' missing reference ' + t.referenceTag);
                return;
              }
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
                thisEntry.engValue = mc.applyTransform(result, t);
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
          var isBit = mc.BIT_DEVICES[grp.regType] || false;
          if (isBit) startA = startA - (startA % 16);

          var maxAddr = addrs[addrs.length - 1];
          var lastTag = grp.tags[grp.tags.length - 1];
          if (!isBit && mc.is32BitType(lastTag.dataType)) {
            maxAddr += 1;
          }

          var wordCount;
          if (isBit) {
            wordCount = Math.ceil((maxAddr - startA + 1) / 16);
          } else {
            wordCount = maxAddr - startA + 1;
          }

          // 字元件与位元件统一为 960 字（位元件 = 15360 点）
          var MAX_WORDS = 960;
          if (wordCount > MAX_WORDS) {
            var newGroups = [];
            var ss = 0;
            while (ss < grp.tags.length) {
              var se = ss;
              var subMax = grp.tags[ss].addr + (mc.is32BitType(grp.tags[ss].dataType) ? 1 : 0);
              while (se + 1 < grp.tags.length) {
                var nextAddr = grp.tags[se + 1].addr + (mc.is32BitType(grp.tags[se + 1].dataType) ? 1 : 0);
                if (nextAddr - grp.tags[ss].addr >= MAX_WORDS) break;
                subMax = nextAddr;
                se++;
              }
              newGroups.push({ regType: grp.regType, tags: grp.tags.slice(ss, se + 1) });
              ss = se + 1;
            }
            groups.splice.apply(groups, [gi, 1].concat(newGroups));
            setTimeout(function () { processGroup(gi); }, 0);
            return;
          }

          function attemptGroup(attempt) {
            if (mcSocket.destroyed) {
              destroyConnection(connKey);
              getConnection(node, plc, function (e2, newSock) {
                if (e2) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RECONNECT] ' + e2.message;
                  releaseConnection(connKey);
                  finishWithError();
                  return;
                }
                mcSocket = newSock;
                attemptGroup(attempt);
              });
              return;
            }

            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = 'MC read failed for ' + grp.regType + startA;
              setTimeout(function () { processGroup(gi + 1); }, 0);
              return;
            }

            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;

            var buf = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler, _errHandler, _dataHandler;

            mcSocket.setTimeout(timeout);

            try {
              var frame = (frameType === '4E')
                ? mc.build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                : mc.build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
              mcSocket.write(frame);
            } catch (e) {
              node.warn('[MC] write error: ' + e.message);
              resolved = true;
              destroyConnection(connKey);
              getConnection(node, plc, function (e3, newSock2) {
                if (e3) {
                  releaseConnection(connKey);
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
                if (buf.length + chunk.length > 65536) {
                  resolved = true;
                  mcSocket.removeListener('data', _dataHandler);
                  if (_tmoHandler) mcSocket.removeListener('timeout', _tmoHandler);
                  if (_errHandler) mcSocket.removeListener('error', _errHandler);
                  node.warn('[MC] Buffer overflow ' + (buf.length + chunk.length) + ' bytes, discarding');
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                  return;
                }
                buf = Buffer.concat([buf, chunk]);
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
                    var raw = mc.parseMCResponse(buf, startA, grp.regType, frameType, sentSN);

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
                          else if (mc.is32BitType(dtTag)) {
                            var adj = raw[grp.regType + (t.addr + 1)];
                            if (adj === undefined || adj === null) { q = 2; originRv = null; cv = null; }
                            else {
                              var lo = originRv & 0xFFFF;
                              var hi = adj & 0xFFFF;
                              var combined = (hi << 16) | lo;
                              if (dtTag === 'INT32') cv = (combined > 0x7FFFFFFF) ? combined - 0x100000000 : combined;
                              else if (dtTag === 'UINT32') cv = combined >>> 0;
                              else if (dtTag === 'FLOAT32') {
                                var b32 = Buffer.alloc(4);
                                b32.writeInt16LE(lo, 0); b32.writeInt16LE(hi, 2);
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
                hasFailed = true;
                if (!firstError) firstError = '[DATA] ' + e.message;
                setTimeout(function () { processGroup(gi + 1); }, 0);
              }
            };

            mcSocket.on('data', _dataHandler);

            _tmoHandler = function () {
              if (resolved) return;
              resolved = true;
              mcSocket.removeListener('data', _dataHandler);
              if (_errHandler) mcSocket.removeListener('error', _errHandler);
              destroyConnection(connKey);
              getConnection(node, plc, function (e4, newSock3) {
                if (e4) {
                  releaseConnection(connKey);
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
              destroyConnection(connKey);
              getConnection(node, plc, function (e5, newSock4) {
                if (e5) {
                  releaseConnection(connKey);
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

        function finishWithError() {
          releaseConnection(connKey);
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
      });
    });

    node.on('close', function (done) {
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) {
        clearInterval(_cleanTimer);
        _cleanTimer = null;
      }
      var conns = node._usedConns || {};
      var keys = Object.keys(conns);
      for (var ci = 0; ci < keys.length; ci++) {
        destroyConnection(keys[ci]);
      }
      try {
        var p2 = node.plcConfig;
        if (p2 && p2.host) {
          destroyConnection(poolKey({ host: p2.host, port: p2.port, frame: p2.frame || '3E', networkNo: p2.networkNo || 0, stationNo: p2.stationNo || 0 }));
        }
      } catch (e) {}
      node._usedConns = {};
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('mitsubishi-read', MitsubishiReadNode);
};
