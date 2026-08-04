/**
 * mitsubishi-write — 三菱 MC Protocol 3E/4E 写入节点 v1.5.1
 *
 * v1.5.1: 位设备原生位写（0x1401/0x0001，M/X/Y/L/B 单往返无 RMW 竞态）、
 *         写分组严格连续（groupTagsContiguous，杜绝间隙填 0 清空 PLC）、
 *         写帧 dataLen=12+2n 修正、UDP RMW _closed 释放、X 写入警告、越界钳制
 * v1.5.0: 批量字写入 + 位元件 RMW（read-modify-write）、独立连接池、
 *          TCP/UDP 双传输、encodeWriteWords 与 decodeTag 对称变换、
 *          _closed 全路径守卫、per-PLC 轮次闸、node.error(msg) 可捕获、
 *          write golden buffer 对拍测试
 * 输入: msg.payload.tags = [{id, regType, addr, dataType, value, byteOrder?, wordOrder?, bitOffset?}]
 * 输出: msg.payload.data[tagId] = {value(写入值), quality, ts, regType}
 * driverType: 'driver-mc-write-protocol'
 */
module.exports = function (RED) {
  var net = require('net');
  var mc = require('./mc-protocol');
  var mcUdp = require('./mc-udp');

  // 🔧 v1.6.0: 面板默认值列是字符串，统一按类型收敛。
  // BOOL 用词表（true/1/on），避免字符串 "false"/"0" 被 truthy 误判为写 1；
  // 数字 Number() 转换，非法值返回 null —— 拒写而不是静默写 0（写操作有副作用）
  function coerceWriteValue(v, dt) {
    if (dt === 'BOOL') {
      return (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;
    }
    if (typeof v === 'string') {
      var n = Number(v.trim());
      return isNaN(n) ? null : n;
    }
    if (typeof v === 'number') return isNaN(v) ? null : v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return null;
  }

  // ===== 写入连接池（独立于读取池，写操作零星稀疏避免排队）=====
  var CONN_POOL_W = {};
  var IN_FLIGHT_W = {};
  var MAX_QUEUE = 50;
  var MAX_BACKOFF_MS = 10000;
  var _activeNodeCount = 0;
  var _cleanTimer = null;

  function ensureCleanTimer() {
    if (_cleanTimer) return;
    _cleanTimer = setInterval(function () {
      var now = Date.now();
      var keys = Object.keys(CONN_POOL_W);
      for (var i = 0; i < keys.length; i++) {
        var entry = CONN_POOL_W[keys[i]];
        if (!entry || entry.inUse || entry.connecting) continue;
        if (entry.socket && (now - entry.lastUsed > 600000)) {
          var q = entry.queue || [];
          entry.queue = [];
          for (var qi = 0; qi < q.length; qi++) {
            try { q[qi].callback(new Error('Connection idle timeout')); } catch (_) {}
          }
          try { entry.socket.destroy(); } catch (_) {}
          delete CONN_POOL_W[keys[i]];
        }
      }
    }, 300000);
    if (_cleanTimer.unref) _cleanTimer.unref();
  }

  function poolKey(plc) {
    return plc.host + ':' + plc.port + ':' + plc.frame + ':' + plc.networkNo + ':' + plc.stationNo + ':' + (plc.protocol || 'tcp');
  }

  function getConnection(node, plc, callback) {
    var key = poolKey(plc);
    var entry = CONN_POOL_W[key];

    if (entry && entry.backoffMs && entry.lastErrorTime) {
      var sinceErr = Date.now() - entry.lastErrorTime;
      if (sinceErr < entry.backoffMs) {
        callback(new Error('connect backoff (' + (entry.backoffMs - sinceErr) + 'ms)'));
        return;
      }
    }

    if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse && !entry.connecting) {
      entry.inUse = true;
      entry.lastUsed = Date.now();
      entry.users = entry.users || {};
      entry.users[node.id] = true;
      entry.socket.setTimeout(plc.timeout);
      callback(null, entry.socket);
      return;
    }

    if (entry && (entry.inUse || entry.connecting)) {
      entry.queue = entry.queue || [];
      if (entry.queue.length >= MAX_QUEUE) {
        callback(new Error('Queue full (' + MAX_QUEUE + ') — PLC too slow'));
        return;
      }
      entry.queue.push({ callback: callback, timeout: plc.timeout, enqueueTime: Date.now() });
      return;
    }

    if (!entry) {
      entry = CONN_POOL_W[key] = {
        socket: null, inUse: false, lastUsed: 0, queue: [],
        connecting: true, backoffMs: 0, lastErrorTime: 0
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
      entry.users = entry.users || {};
      entry.users[node.id] = true;

      client.once('end', function () { destroyConnection(key); });
      client.once('close', function () { destroyConnection(key); });
      client.once('error', function () { destroyConnection(key); });

      callback(null, client);
    });
  }

  function releaseConnection(key) {
    var entry = CONN_POOL_W[key];
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
    var entry = CONN_POOL_W[key];
    if (!entry || entry._destroyed) return;
    entry._destroyed = true;
    if (entry.socket && !entry.socket.destroyed) {
      try { entry.socket.destroy(); } catch (_) {}
    }
    var q = entry.queue || [];
    entry.queue = [];
    delete CONN_POOL_W[key];
    for (var qi = 0; qi < q.length; qi++) {
      try { q[qi].callback(new Error('Connection destroyed')); } catch (_) {}
    }
  }

  // ===== 主节点 =====
  function MitsubishiWriteNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    _activeNodeCount++;
    ensureCleanTimer();

    node.plcConfig = RED.nodes.getNode(config.plc);
    if (!node.plcConfig) {
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) {
        clearInterval(_cleanTimer);
        _cleanTimer = null;
      }
      node.error('未关联 PLC 配置节点');
      return;
    }
    node.serialNo = parseInt(config.serialNo, 10) || 0;
    node.configDeviceId = String(config.deviceId || '');
    node._usedConns = {};
    node._inFlightKeys = {};
    node._closed = false;

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
        series: pp.plcSeries || cfg.series || 'Q',
        protocol: String(pp.protocol || cfg.protocol || 'tcp').toLowerCase(),
        ascii: !!(pp.ascii !== undefined ? pp.ascii : cfg.ascii),  // 🔧 v1.5.1: ASCII 通信模式
        networkNo: pp.networkNo || cfg.networkNo || 0,
        stationNo: pp.stationNo || cfg.stationNo || 0,
        timeout: mc.clampInt(incoming.timeout || cfg.timeout, 3000, 500, 30000),
        maxRetries: mc.clampInt(incoming.maxRetries || cfg.maxRetries, 2, 0, 10),
        retryInterval: mc.clampInt(incoming.retryInterval || cfg.retryInterval, 300, 50, 10000)
      };

      if (plc.protocol !== 'tcp' && plc.protocol !== 'udp') {
        msg.payload = { success: false, deviceId: incoming.id || incoming.deviceId, deviceName: incoming.deviceName, data: {}, error: '不支持的传输协议: ' + plc.protocol + '（仅支持 tcp/udp）', driverType: 'driver-mc-write-protocol' };
        node.error('[MC-WRITE] 不支持的传输协议: ' + plc.protocol, msg);
        node.send(msg);
        if (done) done();
        return;
      }
      if (plc.frame !== '3E' && plc.frame !== '4E') {
        msg.payload = { success: false, deviceId: incoming.id || incoming.deviceId, deviceName: incoming.deviceName, data: {}, error: '不支持的 MC 帧格式: ' + plc.frame, driverType: 'driver-mc-write-protocol' };
        node.error('[MC-WRITE] 不支持的 MC 帧格式: ' + plc.frame + '（仅支持 3E/4E）', msg);
        node.send(msg);
        if (done) done();
        return;
      }

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
      var deviceName = incoming.deviceName || plc.name || ('PLC-' + deviceId);

      var _sent = false;
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        if (typeof connKey !== 'undefined' && connKey && IN_FLIGHT_W[connKey] === node.id) {
          delete IN_FLIGHT_W[connKey];
        }
        try { send(m); } catch (_) {}
        if (done) {
          try { done(); } catch (_) {}
        }
      }

      // 🔧 v1.6.0: 面板表格与 msg.tags 合并（此前 msg.tags 全量覆盖面板）。规则：
      //   - 无 msg.tags：整轮用面板表格（v1.6.0 默认值列生效，纯静态写入走通）
      //   - 有 msg.tags：msg 驱动本轮；每条 msg 点位按 id（其次 regType+addr）匹配面板行
      //     补齐缺失字段（value 缺省回落面板默认值）；未被 msg 引用的面板行本轮【不】执行
      //     （防静态默认值随动态轮次被误写——写操作有副作用）
      var msgTags = msg.tags || incoming.tags;
      var tags;
      if (!msgTags || (Array.isArray(msgTags) && msgTags.length === 0)) {
        tags = configTags.slice();
      } else {
        if (!Array.isArray(msgTags)) msgTags = [msgTags];
        var cfgById = {}, cfgByAddr = {};
        configTags.forEach(function (ct) {
          if (ct.id !== undefined && ct.id !== null && ct.id !== '') cfgById[String(ct.id)] = ct;
          var ca = (ct.addr !== undefined && ct.addr !== null && ct.addr !== '') ? ct.addr : ct.regAddr;
          if (ca !== undefined && ca !== null && ca !== '') cfgByAddr[(ct.regType || 'D') + '|' + String(ca)] = ct;
        });
        tags = msgTags.map(function (mt) {
          var cfg = null;
          if (mt.id !== undefined && mt.id !== null && mt.id !== '') cfg = cfgById[String(mt.id)] || null;
          if (!cfg) {
            var ma = (mt.addr !== undefined && mt.addr !== null && mt.addr !== '') ? mt.addr : mt.regAddr;
            if (ma !== undefined && ma !== null && ma !== '') cfg = cfgByAddr[(mt.regType || 'D') + '|' + String(ma)] || null;
          }
          if (!cfg) return mt;
          // 面板兜底，msg 字段优先（undefined/null 不覆盖）
          var merged = {};
          for (var ck in cfg) { if (cfg.hasOwnProperty(ck)) merged[ck] = cfg[ck]; }
          for (var mk in mt) { if (mt.hasOwnProperty(mk) && mt[mk] !== undefined && mt[mk] !== null) merged[mk] = mt[mk]; }
          return merged;
        });
      }

      var allValidTags = [];
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        var rt = t.regType || 'D';
        if (!mc.MC_DEVICE_CODES[rt]) {
          if (rt) node.warn('[MC-WRITE] Unknown regType: ' + rt + ', using D');
          rt = 'D';
        }
        var DT_MAP = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var dt = DT_MAP[t.dataType] || t.dataType || 'INT16';
        var rawAddr = (t.addr !== undefined) ? t.addr : (t.regAddr || t.tag_address || t.registerAddress || '');
        var addr = mc.parseDeviceAddress(rt, rawAddr, plc.series);
        if (addr < 0) {
          node.warn('[MC-WRITE] Invalid addr for tag ' + (t.id || t.name || ('#' + i)));
          continue;
        }
        // 🔧 v1.6.0: 空串同样视为缺省值（面板默认值列留空 ≠ 写入空串）
        if (t.value === undefined || t.value === null || t.value === '') {
          node.warn('[MC-WRITE] Missing value for tag ' + (t.id || t.name || (rt + addr)));
          continue;
        }
        var displayAddr = mc.formatDeviceAddress(rt, addr, plc.series).slice(rt.length);
        var tagId = t.id || t.name || (rt + displayAddr);
        var bo = t.byteOrder || null;
        var wo = t.wordOrder || null;
        var bitOff = (function () {
          if (t.bitOffset === undefined || t.bitOffset === null) return null;
          var bv = parseInt(t.bitOffset, 10);
          if (isNaN(bv) || bv < 0 || bv > 15) { node.warn('[MC-WRITE] Invalid bitOffset ' + t.bitOffset + ', using 0'); return 0; }
          return bv;
        })();
        // 值校验与钳制
        // 🔧 v1.6.0: 面板默认值列是字符串，统一按类型收敛；非法值拒写而不是静默写 0
        var writeVal = coerceWriteValue(t.value, dt);
        if (writeVal === null) {
          node.warn('[MC-WRITE] Invalid value for tag ' + (t.id || t.name || (rt + addr)) + ': ' + t.value);
          continue;
        }
        if (dt === 'UINT16' && writeVal > 65535) {
          node.warn('[MC-WRITE] UINT16 overflow for ' + tagId + ', clamped to 65535');
          writeVal = 65535;
        } else if (dt === 'INT16' && writeVal > 32767) {
          node.warn('[MC-WRITE] INT16 overflow for ' + tagId + ', clamped to 32767');
          writeVal = 32767;
        } else if (dt === 'INT16' && writeVal < -32768) {
          node.warn('[MC-WRITE] INT16 underflow for ' + tagId + ', clamped to -32768');
          writeVal = -32768;
        }

        allValidTags.push({
          id: String(tagId),
          regType: rt,
          addr: addr,
          displayAddr: displayAddr,
          dataType: dt,
          value: writeVal,
          byteOrder: bo,
          wordOrder: wo,
          bitOffset: bitOff,
          name: t.name || (rt + displayAddr)
        });
      }

      if (allValidTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'No valid write tags (all addresses invalid or values missing)', driverType: 'driver-mc-write-protocol', plcIp: plc.host, plcPort: plc.port };
        node.error('[MC-WRITE] No valid write tags', msg);
        safeSend(msg);
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
        allValidTags.forEach(function (t) {
          simOut[t.id] = { value: t.value, quality: 0, ts: new Date().toISOString(), regType: t.regType };
        });
        msg.payload = { success: true, deviceId: deviceId, deviceName: deviceName, data: simOut, error: null, driverType: 'driver-mc-write-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM write ' + allValidTags.length + ' tags' });
        safeSend(msg);
        return;
      }

      // 🔧 v1.5.1: 三分流 — 字写入 / 位设备原生位写（无RMW竞态） / 字内BOOL(RMW)
      var wordTags = [];
      var bitDeviceTags = [];  // M/X/Y/L/B… → 原生位写
      var wordBoolTags = [];   // D100.3… → RMW
      for (var wi = 0; wi < allValidTags.length; wi++) {
        var at = allValidTags[wi];
        var isBitDevice = !!mc.BIT_DEVICES[at.regType];
        // 🔧 P1-3: X（输入继电器）由 PLC 扫描刷新，写入可能无效或立即被覆盖
        if (at.regType === 'X') {
          node.warn('[MC-WRITE] X device write may be overwritten by PLC scan — 建议改用 M 或 B 继电器');
        }
        if (isBitDevice) {
          bitDeviceTags.push(at);
        } else if (at.dataType === 'BOOL') {
          wordBoolTags.push(at);  // 字内位→RMW
        } else {
          wordTags.push(at);
        }
      }

      // 部署 @{roundStart} 外供集回用
      var connKey = poolKey(plc);
      var hasFailed = false;
      var firstError = '';
      var currentSN = node.serialNo;
      var allResults = {};  // tagId → { value, quality, ts }

      // 轮次闸
      if (IN_FLIGHT_W[connKey]) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'round in progress' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'Round in progress (previous write not finished)', driverType: 'driver-mc-write-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.error('[MC-WRITE] Round in progress', msg);
        safeSend(msg);
        return;
      }
      IN_FLIGHT_W[connKey] = node.id;
      node._inFlightKeys[connKey] = true;
      node._usedConns[connKey] = true;

      var poolEntry = CONN_POOL_W[connKey];
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        IN_FLIGHT_W[connKey] && delete IN_FLIGHT_W[connKey];
        node.status({ fill: 'yellow', shape: 'dot', text: 'throttled' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'Throttled: queue > 20', driverType: 'driver-mc-write-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.error('[MC-WRITE] Throttled: queue > 20', msg);
        safeSend(msg);
        return;
      }

      function assembleAndSend() {
        var output = {};
        var roundTs = new Date().toISOString();
        allValidTags.forEach(function (t) {
          var entry = allResults[t.id];
          if (entry) {
            output[t.id] = { value: entry.value, quality: entry.quality, ts: entry.ts, regType: t.regType };
          } else {
            output[t.id] = { value: null, quality: 2, ts: roundTs, regType: t.regType };
          }
        });
        msg.payload = {
          success: !hasFailed,
          deviceId: deviceId,
          deviceName: deviceName,
          data: output,
          error: hasFailed ? firstError : null,
          driverType: 'driver-mc-write-protocol',
          plcIp: plc.host,
          plcPort: plc.port,
          roundTimeMs: Date.now() - roundStart
        };
        node.status({
          fill: hasFailed ? 'red' : 'green',
          shape: 'dot',
          text: (plc.name || plc.host) + ' wrote ' + Object.keys(output).length + ' tags ' + (Date.now() - roundStart) + 'ms'
        });
        safeSend(msg);
      }

      // ===== 字写入分组（严格连续：groupTagsContiguous 杜绝间隙填 0 清空 PLC）=====
      var wordGroups = wordTags.length > 0 ? mc.groupTagsContiguous(wordTags) : [];

      // ===== v1.5.1: 位设备原生位写分组（无 RMW 竞态，单往返）=====
      var bitWritePhases = [];
      if (bitDeviceTags.length > 0) {
        var bitByReg = {};
        bitDeviceTags.forEach(function (t) {
          if (!bitByReg[t.regType]) bitByReg[t.regType] = [];
          bitByReg[t.regType].push(t);
        });
        Object.keys(bitByReg).forEach(function (rt) {
          var sorted = bitByReg[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
          var cluster = [sorted[0]];
          for (var bi = 1; bi < sorted.length; bi++) {
            var prevEnd = cluster[cluster.length - 1].addr;
            // 🔧 P0-2 位版：严格连续（next.addr == prevEnd+1，有间隙就拆组）。
            // 位写同样是"绝对写入"——中间位被显式写 0，与字写 fill-0 是同一类数据破坏。
            if (sorted[bi].addr === prevEnd + 1 && (sorted[bi].addr - cluster[0].addr + 1) <= 960) {
              cluster.push(sorted[bi]);
            } else {
              bitWritePhases.push({ regType: rt, tags: cluster });
              cluster = [sorted[bi]];
            }
          }
          if (cluster.length > 0) bitWritePhases.push({ regType: rt, tags: cluster });
        });
      }

      // ===== 位 RMW 分组（仅字内 BOOL，如 D100.3）=====
      var rmwGroups = [];
      if (wordBoolTags.length > 0) {
        var boolByReg = {};
        wordBoolTags.forEach(function (t) {
          if (!boolByReg[t.regType]) boolByReg[t.regType] = [];
          boolByReg[t.regType].push(t);
        });
        Object.keys(boolByReg).forEach(function (rt) {
          var rmw = mc.buildRMWWriteGroup(boolByReg[rt], rt, plc.series);
          rmw.forEach(function (r) { rmwGroups.push(r); });
        });
      }

      // 构建统一的任务队列：字写入 → 位设备原生位写 → 字内 RMW
      var totalPhases = [];
      wordGroups.forEach(function (wg) { totalPhases.push({ type: 'word', group: wg }); });
      bitWritePhases.forEach(function (bp) { totalPhases.push({ type: 'bit', group: bp }); });
      rmwGroups.forEach(function (rg) { totalPhases.push({ type: 'rmw', group: rg }); });

      if (totalPhases.length === 0) {
        assembleAndSend();
        return;
      }

      // ===== UDP 路径 =====
      if (plc.protocol === 'udp') {
        mcUdp.acquire(node, connKey, plc.timeout, function (aerr, udpEntry) {
          if (aerr) {
            msg.payload = {
              success: false, deviceId: deviceId, deviceName: deviceName, data: {},
              error: '[UDP-ACQUIRE] ' + aerr.message, driverType: 'driver-mc-write-protocol',
              plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart
            };
            node.status({ fill: 'red', shape: 'ring', text: 'udp acquire fail' });
            node.error('[MC-WRITE] [UDP-ACQUIRE] ' + aerr.message, msg);
            safeSend(msg);
            return;
          }

          function processPhaseUdp(pi) {
            if (node._closed) { mcUdp.release(connKey); return; }
            if (pi >= totalPhases.length) {
              mcUdp.release(connKey);
              assembleAndSend();
              return;
            }
            var phase = totalPhases[pi];

            if (phase.type === 'bit') {
              processBitPhaseUdp(pi, phase.group);
              return;
            }
            if (phase.type === 'word') {
              var grp = phase.group;
              var grpSorted = grp.tags.slice().sort(function (a, b) { return a.addr - b.addr; });
              var startA = grpSorted[0].addr;
              var lastTag = grpSorted[grpSorted.length - 1];
              var maxAddr = lastTag.addr + mc.wordSpanOf(lastTag.dataType) - 1;
              var wordCount = maxAddr - startA + 1;

              // 🔧 P0-2: groupTagsContiguous 保证严格连续，无间隙→直接顺序编码
              var words = [];
              for (var fi = 0; fi < grpSorted.length; fi++) {
                var encoded = mc.encodeWriteWords(grpSorted[fi].value, grpSorted[fi].dataType, grpSorted[fi].byteOrder, grpSorted[fi].wordOrder);
                for (var ei = 0; ei < encoded.length; ei++) words.push(encoded[ei]);
              }

              function attemptWordUdp(attempt) {
                if (node._closed) { mcUdp.release(connKey); return; }
                if (attempt > maxRetries) {
                  hasFailed = true;
                  if (!firstError) firstError = 'MC/UDP write failed for ' + grp.regType + startA;
                  setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                  return;
                }
                var sentSN = (frameType === '4E') ? currentSN : 0;
                if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
                var frame;
                try {
                  frame = mc.buildWriteFrame(frameType, startA, words, stationNo, grp.regType, networkNo, sentSN);
                } catch (e) {
                  node.warn('[MC-WRITE] frame build error: ' + e.message);
                  hasFailed = true;
                  if (!firstError) firstError = '[FRAME] ' + e.message;
                  setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                  return;
                }
                mcUdp.request(connKey, frame, plc.port, plc.host, timeout, function (rerr, buf) {
                  if (node._closed) { mcUdp.release(connKey); return; }
                  if (rerr || !buf) {
                    setTimeout(function () { attemptWordUdp(attempt + 1); }, retryInterval);
                    return;
                  }
                  var resp;
                  try {
                    resp = mc.parseMCWriteResponse(buf, frameType, sentSN);
                  } catch (e) {
                    node.warn('[MC-WRITE] parse error: ' + e.message);
                    setTimeout(function () { attemptWordUdp(attempt + 1); }, retryInterval);
                    return;
                  }
                  if (resp && resp.mcError) {
                    hasFailed = true;
                    if (!firstError) firstError = '[PLC 0x' + resp.mcError.toString(16).toUpperCase() + '] ' + resp.mcErrorText;
                    grp.tags.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                    setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                    return;
                  }
                  if (resp && resp.ok) {
                    var groupTs = new Date().toISOString();
                    grp.tags.forEach(function (t) { allResults[t.id] = { value: t.value, quality: 0, ts: groupTs }; });
                    setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                    return;
                  }
                  setTimeout(function () { attemptWordUdp(attempt + 1); }, retryInterval);
                });
              }
              attemptWordUdp(0);

            } else {
              // UDP RMW 阶段
              var rmwGrp = phase.group;
              processRMWPhaseUdp(pi, rmwGrp);
            }
          }

          // ===== v1.5.1: UDP 原生位写（单往返，无 RMW 竞态）=====
          function processBitPhaseUdp(pi, bitGrp) {
            if (node._closed) { mcUdp.release(connKey); return; }
            var sorted = bitGrp.tags.slice().sort(function (a, b) { return a.addr - b.addr; });
            var bits = sorted.map(function (t) { return { addr: t.addr, value: t.value ? 1 : 0 }; });
            var enc = mc.encodeBitWriteData(bits);

            function attemptBitUdp(attempt) {
              if (node._closed) { mcUdp.release(connKey); return; }
              if (attempt > maxRetries) {
                hasFailed = true;
                if (!firstError) firstError = 'MC/UDP bit-write failed for ' + bitGrp.regType + enc.startAddr;
                sorted.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                return;
              }
              var sentSN = (frameType === '4E') ? currentSN : 0;
              if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
              var frame;
              try {
                frame = mc.buildBitWriteFrame(frameType, enc.startAddr, enc.bitCount, enc.data, stationNo, bitGrp.regType, networkNo, sentSN);
              } catch (e) {
                node.warn('[MC-WRITE] bit frame build error: ' + e.message);
                hasFailed = true;
                if (!firstError) firstError = '[FRAME] ' + e.message;
                setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                return;
              }
              mcUdp.request(connKey, frame, plc.port, plc.host, timeout, function (rerr, buf) {
                if (node._closed) { mcUdp.release(connKey); return; }
                if (rerr || !buf) {
                  setTimeout(function () { attemptBitUdp(attempt + 1); }, retryInterval);
                  return;
                }
                var resp;
                try { resp = mc.parseMCWriteResponse(buf, frameType, sentSN); } catch (e) {
                  setTimeout(function () { attemptBitUdp(attempt + 1); }, retryInterval);
                  return;
                }
                if (resp && resp.mcError) {
                  hasFailed = true;
                  if (!firstError) firstError = '[PLC 0x' + resp.mcError.toString(16).toUpperCase() + '] ' + resp.mcErrorText;
                  sorted.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                  setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                  return;
                }
                if (resp && resp.ok) {
                  var groupTs = new Date().toISOString();
                  sorted.forEach(function (t) { allResults[t.id] = { value: t.value, quality: 0, ts: groupTs }; });
                  setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                  return;
                }
                setTimeout(function () { attemptBitUdp(attempt + 1); }, retryInterval);
              });
            }
            attemptBitUdp(0);
          }

          function processRMWPhaseUdp(pi, rmwGrp) {
            // Step 1: 读当前字
            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
            var readFrame;
            try {
              readFrame = (frameType === '4E')
                ? mc.build4EFrame(rmwGrp.wordAddr, 1, stationNo, rmwGrp.regType, networkNo, sentSN)
                : mc.build3EFrame(rmwGrp.wordAddr, 1, stationNo, rmwGrp.regType, networkNo);
            } catch (e) {
              node.warn('[MC-WRITE] RMW read frame error: ' + e.message);
              hasFailed = true;
              if (!firstError) firstError = '[RMW-READ] ' + e.message;
              rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
              setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
              return;
            }

            function rmwUdpRead(attempt) {
              if (node._closed) { mcUdp.release(connKey); return; }
              if (attempt > maxRetries) {
                hasFailed = true;
                if (!firstError) firstError = '[RMW-READ] failed for ' + rmwGrp.regType + rmwGrp.wordAddr;
                rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                return;
              }
              mcUdp.request(connKey, readFrame, plc.port, plc.host, timeout, function (rerr, buf) {
                if (node._closed) { mcUdp.release(connKey); return; }
                if (rerr || !buf) { setTimeout(function () { rmwUdpRead(attempt + 1); }, retryInterval); return; }
                var raw = mc.parseMCResponse(buf, rmwGrp.wordAddr, rmwGrp.regType, frameType, sentSN);
                if (!raw || raw.err || raw.mcError) {
                  setTimeout(function () { rmwUdpRead(attempt + 1); }, retryInterval);
                  return;
                }
                // 🔧 RMW: 位设备 parseMCResponse 返回每 bit 值而非 word 值，
                // 此处需直接读 buf 中的 raw word（dataStart = 3E@11 / 4E@15）
                var ds = (frameType === '4E') ? 15 : 11;
                if (buf.length < ds + 2) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RMW-READ] buffer too short for ' + rmwGrp.regType + rmwGrp.wordAddr;
                  rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                  setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                  return;
                }
                var wordVal = buf.readUInt16LE(ds);
                if (wordVal === undefined || wordVal === null) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RMW-READ] no data for ' + rmwGrp.regType + rmwGrp.wordAddr;
                  rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                  setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                  return;
                }
                // Step 2: 修改位
                var modified = wordVal & 0xFFFF;
                rmwGrp.bits.forEach(function (b) {
                  if (b.value) modified |= (1 << b.bitOffset);
                  else modified &= ~(1 << b.bitOffset);
                });
                // Step 3: 写回
                var wsSN = (frameType === '4E') ? currentSN : 0;
                if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
                var writeFrame = mc.buildWriteFrame(frameType, rmwGrp.wordAddr, [modified], stationNo, rmwGrp.regType, networkNo, wsSN);

                function rmwUdpWrite(writeAttempt) {
                  if (node._closed) { mcUdp.release(connKey); return; }
                  if (writeAttempt > maxRetries) {
                    hasFailed = true;
                    if (!firstError) firstError = '[RMW-WRITE] failed for ' + rmwGrp.regType + rmwGrp.wordAddr;
                    rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                    setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                    return;
                  }
                  mcUdp.request(connKey, writeFrame, plc.port, plc.host, timeout, function (werr, wbuf) {
                    if (node._closed) { mcUdp.release(connKey); return; }
                    if (werr || !wbuf) { setTimeout(function () { rmwUdpWrite(writeAttempt + 1); }, retryInterval); return; }
                    var wresp = mc.parseMCWriteResponse(wbuf, frameType, wsSN);
                    if (wresp && wresp.ok) {
                      var groupTs = new Date().toISOString();
                      rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: b.value, quality: 0, ts: groupTs }; });
                      setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                    } else if (wresp && wresp.mcError) {
                      hasFailed = true;
                      if (!firstError) firstError = '[PLC 0x' + wresp.mcError.toString(16).toUpperCase() + '] ' + wresp.mcErrorText;
                      rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                      setTimeout(function () { processPhaseUdp(pi + 1); }, 0);
                    } else {
                      setTimeout(function () { rmwUdpWrite(writeAttempt + 1); }, retryInterval);
                    }
                  });
                }
                rmwUdpWrite(0);
              });
            }
            rmwUdpRead(0);
          }

          processPhaseUdp(0);
        });
        return;
      }

      // ===== TCP 路径 =====
      getConnection(node, plc, function (err, mcSocket) {
        if (err) {
          msg.payload = {
            success: false, deviceId: deviceId, deviceName: deviceName, data: {},
            error: '[CONNECT] ' + err.message, driverType: 'driver-mc-write-protocol',
            plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'connect fail' });
          node.error('[MC-WRITE] [CONNECT] ' + err.message, msg);
          safeSend(msg);
          return;
        }

        function processPhase(pi) {
          if (node._closed) { releaseConnection(connKey); return; }
          if (pi >= totalPhases.length) {
            releaseConnection(connKey);
            assembleAndSend();
            return;
          }
          var phase = totalPhases[pi];

          if (phase.type === 'word') {
            processWordPhase(pi, phase.group);
          } else if (phase.type === 'bit') {
            processBitPhase(pi, phase.group);
          } else {
            processRMWPhase(pi, phase.group);
          }
        }

        // ===== v1.5.1: TCP 原生位写（单往返，无 RMW 竞态）=====
        function processBitPhase(pi, bitGrp) {
          if (node._closed) { releaseConnection(connKey); return; }
          var sorted = bitGrp.tags.slice().sort(function (a, b) { return a.addr - b.addr; });
          var bits = sorted.map(function (t) { return { addr: t.addr, value: t.value ? 1 : 0 }; });
          var enc = mc.encodeBitWriteData(bits);

          function attemptBitWrite(attempt) {
            if (node._closed) { releaseConnection(connKey); return; }
            if (mcSocket.destroyed) {
              destroyConnection(connKey);
              getConnection(node, plc, function (e2, newSock) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e2) { releaseConnection(connKey); finishWithError(); return; }
                mcSocket = newSock;
                attemptBitWrite(attempt);
              });
              return;
            }
            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = 'MC bit-write failed for ' + bitGrp.regType + enc.startAddr;
              sorted.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
              setTimeout(function () { processPhase(pi + 1); }, 0);
              return;
            }
            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;

            var buf = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler = null, _errHandler = null, _dataHandler = null;
            var _reqTimer = null;

            function cleanupListeners(sock) {
              if (!sock) return;
              sock.removeListener('data', _dataHandler);
              sock.removeListener('timeout', _tmoHandler);
              sock.removeListener('error', _errHandler);
              if (_reqTimer) { clearTimeout(_reqTimer); _reqTimer = null; }
            }

            mcSocket.setTimeout(timeout);
            try {
              var frame = mc.buildBitWriteFrame(frameType, enc.startAddr, enc.bitCount, enc.data, stationNo, bitGrp.regType, networkNo, sentSN);
              var wireBit = plc.ascii ? mc.asciify(frame) : frame;
              mcSocket.write(wireBit);
            } catch (e) {
              node.warn('[MC-WRITE] bit frame build error: ' + e.message);
              resolved = true; cleanupListeners(mcSocket);
              destroyConnection(connKey);
              getConnection(node, plc, function (e3, newSock2) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e3) { releaseConnection(connKey); finishWithError(); return; }
                mcSocket = newSock2;
                setTimeout(function () { attemptBitWrite(attempt + 1); }, retryInterval);
              });
              return;
            }

            _dataHandler = function (sock) {
              return function (chunk) {
                try {
                  if (buf.length + chunk.length > 65536) { resolved = true; cleanupListeners(sock); setTimeout(function () { attemptBitWrite(attempt + 1); }, retryInterval); return; }
                  buf = Buffer.concat([buf, chunk]);
                  var hdrLen = (frameType === '4E') ? 15 : 11;
                  if (!resolved && buf.length >= hdrLen) {
                    var dataLen = buf.readUInt16LE((frameType === '4E') ? 11 : 7) - 2;
                    if (dataLen < 0 || dataLen > 2000) { resolved = true; cleanupListeners(sock); setTimeout(function () { attemptBitWrite(attempt + 1); }, retryInterval); return; }
                    if (buf.length >= hdrLen + dataLen) {
                      resolved = true; cleanupListeners(sock);
                      var resp = mc.parseMCWriteResponse(buf, frameType, sentSN);
                      if (resp && resp.mcError) {
                        hasFailed = true;
                        if (!firstError) firstError = '[PLC 0x' + resp.mcError.toString(16).toUpperCase() + '] ' + resp.mcErrorText;
                        sorted.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                        setTimeout(function () { processPhase(pi + 1); }, 0);
                      } else if (resp && resp.ok) {
                        var groupTs = new Date().toISOString();
                        sorted.forEach(function (t) { allResults[t.id] = { value: t.value, quality: 0, ts: groupTs }; });
                        setTimeout(function () { processPhase(pi + 1); }, 0);
                      } else {
                        setTimeout(function () { attemptBitWrite(attempt + 1); }, retryInterval);
                      }
                    }
                  }
                } catch (e) {
                  node.warn('[MC-WRITE] bit write handler error: ' + e.message);
                  cleanupListeners(sock); resolved = true; hasFailed = true;
                  if (!firstError) firstError = '[DATA] ' + e.message;
                  setTimeout(function () { processPhase(pi + 1); }, 0);
                }
              };
            }(mcSocket);
            mcSocket.on('data', _dataHandler);

            _tmoHandler = function (sock) { return function () { if (resolved) return; resolved = true; cleanupListeners(sock); destroyConnection(connKey); getConnection(node, plc, function (e4, newSock3) { if (node._closed) { releaseConnection(connKey); return; } if (e4) { releaseConnection(connKey); finishWithError(); return; } mcSocket = newSock3; setTimeout(function () { attemptBitWrite(attempt + 1); }, retryInterval); }); }; }(mcSocket);
            mcSocket.once('timeout', _tmoHandler);
            _errHandler = function (sock) { return function () { if (resolved) return; resolved = true; cleanupListeners(sock); destroyConnection(connKey); getConnection(node, plc, function (e5, newSock4) { if (node._closed) { releaseConnection(connKey); return; } if (e5) { releaseConnection(connKey); finishWithError(); return; } mcSocket = newSock4; setTimeout(function () { attemptBitWrite(attempt + 1); }, retryInterval); }); }; }(mcSocket);
            mcSocket.once('error', _errHandler);
            _reqTimer = setTimeout(function () { if (resolved) return; node.warn('[MC-WRITE] bit write request-level timeout'); _tmoHandler(); }, timeout);
          }
          attemptBitWrite(0);
        }

        function processWordPhase(pi, grp) {
          if (node._closed) { releaseConnection(connKey); return; }

          var grpSorted = grp.tags.slice().sort(function (a, b) { return a.addr - b.addr; });
          var startA = grpSorted[0].addr;
          var lastTag = grpSorted[grpSorted.length - 1];
          var maxAddr = lastTag.addr + mc.wordSpanOf(lastTag.dataType) - 1;
          var wordCount = maxAddr - startA + 1;

          if (wordCount > 960) {
            // 超过 960 字再拆分（groupTags 已处理，此处兜底）
            var half = Math.floor(grpSorted.length / 2);
            var g1 = grpSorted.slice(0, half);
            var g2 = grpSorted.slice(half);
            totalPhases.splice.apply(totalPhases, [pi, 1, { type: 'word', group: { regType: grp.regType, tags: g1 } }, { type: 'word', group: { regType: grp.regType, tags: g2 } }]);
            setTimeout(function () { processPhase(pi); }, 0);
            return;
          }

          // 🔧 P0-2: groupTagsContiguous 保证严格连续→直接顺序编码
          var words = [];
          for (var fi = 0; fi < grpSorted.length; fi++) {
            var encoded = mc.encodeWriteWords(grpSorted[fi].value, grpSorted[fi].dataType, grpSorted[fi].byteOrder, grpSorted[fi].wordOrder);
            for (var ei = 0; ei < encoded.length; ei++) words.push(encoded[ei]);
          }

          function attemptWordWrite(attempt) {
            if (node._closed) { releaseConnection(connKey); return; }
            if (mcSocket.destroyed) {
              destroyConnection(connKey);
              getConnection(node, plc, function (e2, newSock) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e2) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RECONNECT] ' + e2.message;
                  releaseConnection(connKey);
                  finishWithError();
                  return;
                }
                mcSocket = newSock;
                attemptWordWrite(attempt);
              });
              return;
            }
            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = 'MC write failed for ' + grp.regType + startA;
              grp.tags.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
              setTimeout(function () { processPhase(pi + 1); }, 0);
              return;
            }

            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;

            var buf = Buffer.alloc(0);
            var asciiBufW = Buffer.alloc(0);  // 🔧 v1.5.1: ASCII 模式累加缓冲
            var resolved = false;
            var _tmoHandler = null, _errHandler = null, _dataHandler = null;
            var _reqTimer = null;

            function cleanupListeners(sock) {
              if (!sock) return;
              sock.removeListener('data', _dataHandler);
              sock.removeListener('timeout', _tmoHandler);
              sock.removeListener('error', _errHandler);
              if (_reqTimer) { clearTimeout(_reqTimer); _reqTimer = null; }
            }

            mcSocket.setTimeout(timeout);

            try {
              var frame = mc.buildWriteFrame(frameType, startA, words, stationNo, grp.regType, networkNo, sentSN);
              var wireFrameW = plc.ascii ? mc.asciify(frame) : frame;
              mcSocket.write(wireFrameW);
            } catch (e) {
              node.warn('[MC-WRITE] write error: ' + e.message);
              resolved = true;
              cleanupListeners(mcSocket);
              destroyConnection(connKey);
              getConnection(node, plc, function (e3, newSock2) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e3) { releaseConnection(connKey); finishWithError(); return; }
                mcSocket = newSock2;
                setTimeout(function () { attemptWordWrite(attempt + 1); }, retryInterval);
              });
              return;
            }

            _dataHandler = function (sock) {
              return function (chunk) {
                try {
                  // 🔧 v1.5.1: ASCII deasciify shim — 将 ASCII chunk 转为 binary chunk，其余逻辑不变
                  if (plc.ascii) {
                    asciiBufW = Buffer.concat([asciiBufW, chunk]);
                    while (true) {
                      var da = mc.deasciify(asciiBufW); asciiBufW = asciiBufW.slice(da.consumed);
                      if (da.err) { node.warn('[MC-WRITE] ASCII decode: ' + da.err); continue; }
                      if (!da.result) return;
                      chunk = da.result; break;
                    }
                  }
                  if (buf.length + chunk.length > 65536) {
                    resolved = true;
                    cleanupListeners(sock);
                    node.warn('[MC-WRITE] Buffer overflow ' + (buf.length + chunk.length) + ' bytes, discarding');
                    setTimeout(function () { attemptWordWrite(attempt + 1); }, retryInterval);
                    return;
                  }
                  buf = Buffer.concat([buf, chunk]);
                  var hdrLen = (frameType === '4E') ? 15 : 11;
                  if (!resolved && buf.length >= hdrLen) {
                    var dataLen = buf.readUInt16LE((frameType === '4E') ? 11 : 7) - 2;
                    if (dataLen < 0 || dataLen > 2000) {
                      resolved = true;
                      cleanupListeners(sock);
                      setTimeout(function () { attemptWordWrite(attempt + 1); }, retryInterval);
                      return;
                    }
                    if (buf.length >= hdrLen + dataLen) {
                      resolved = true;
                      cleanupListeners(sock);
                      var resp = mc.parseMCWriteResponse(buf, frameType, sentSN);
                      if (resp && resp.mcError) {
                        hasFailed = true;
                        if (!firstError) firstError = '[PLC 0x' + resp.mcError.toString(16).toUpperCase() + '] ' + resp.mcErrorText;
                        grp.tags.forEach(function (t) { allResults[t.id] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                        setTimeout(function () { processPhase(pi + 1); }, 0);
                      } else if (resp && resp.ok) {
                        var groupTs = new Date().toISOString();
                        grp.tags.forEach(function (t) { allResults[t.id] = { value: t.value, quality: 0, ts: groupTs }; });
                        setTimeout(function () { processPhase(pi + 1); }, 0);
                      } else {
                        setTimeout(function () { attemptWordWrite(attempt + 1); }, retryInterval);
                      }
                    }
                  }
                } catch (e) {
                  node.warn('[MC-WRITE] data handler error: ' + e.message);
                  cleanupListeners(sock);
                  resolved = true;
                  hasFailed = true;
                  if (!firstError) firstError = '[DATA] ' + e.message;
                  setTimeout(function () { processPhase(pi + 1); }, 0);
                }
              };
            }(mcSocket);

            mcSocket.on('data', _dataHandler);

            _tmoHandler = function (sock) {
              return function () {
                if (resolved) return;
                resolved = true;
                cleanupListeners(sock);
                destroyConnection(connKey);
                getConnection(node, plc, function (e4, newSock3) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e4) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock3;
                  setTimeout(function () { attemptWordWrite(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('timeout', _tmoHandler);

            _errHandler = function (sock) {
              return function () {
                if (resolved) return;
                resolved = true;
                cleanupListeners(sock);
                destroyConnection(connKey);
                getConnection(node, plc, function (e5, newSock4) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e5) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock4;
                  setTimeout(function () { attemptWordWrite(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('error', _errHandler);

            _reqTimer = setTimeout(function () {
              if (resolved) return;
              node.warn('[MC-WRITE] request-level timeout (slow-drip response or stuck peer)');
              _tmoHandler();
            }, timeout);
          }
          attemptWordWrite(0);
        }

        function processRMWPhase(pi, rmwGrp) {
          if (node._closed) { releaseConnection(connKey); return; }
          if (mcSocket.destroyed) {
            destroyConnection(connKey);
            getConnection(node, plc, function (e2, newSock) {
              if (node._closed) { releaseConnection(connKey); return; }
              if (e2) { releaseConnection(connKey); finishWithError(); return; }
              mcSocket = newSock;
              processRMWPhase(pi, rmwGrp);
            });
            return;
          }

          // Step 1: 读当前字
          var sentSN = (frameType === '4E') ? currentSN : 0;
          if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
          var readFrame;
          try {
            readFrame = (frameType === '4E')
              ? mc.build4EFrame(rmwGrp.wordAddr, 1, stationNo, rmwGrp.regType, networkNo, sentSN)
              : mc.build3EFrame(rmwGrp.wordAddr, 1, stationNo, rmwGrp.regType, networkNo);
          } catch (e) {
            node.warn('[MC-WRITE] RMW read frame error: ' + e.message);
            hasFailed = true;
            if (!firstError) firstError = '[RMW-READ] ' + e.message;
            rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
            setTimeout(function () { processPhase(pi + 1); }, 0);
            return;
          }

          function rmwReadAttempt(attempt) {
            if (node._closed) { releaseConnection(connKey); return; }
            if (mcSocket.destroyed) {
              destroyConnection(connKey);
              getConnection(node, plc, function (e2, newSock) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e2) { releaseConnection(connKey); finishWithError(); return; }
                mcSocket = newSock;
                rmwReadAttempt(attempt);
              });
              return;
            }
            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = '[RMW-READ] failed for ' + rmwGrp.regType + rmwGrp.wordAddr;
              rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
              setTimeout(function () { processPhase(pi + 1); }, 0);
              return;
            }

            var rdBuf = Buffer.alloc(0);
            var rdResolved = false;
            var rdTmo = null, rdErr = null, rdData = null;
            var rdReqTimer = null;

            function rdCleanup(sock) {
              if (!sock) return;
              sock.removeListener('data', rdData);
              sock.removeListener('timeout', rdTmo);
              sock.removeListener('error', rdErr);
              if (rdReqTimer) { clearTimeout(rdReqTimer); rdReqTimer = null; }
            }

            mcSocket.setTimeout(timeout);

            try {
              var wireRMW = plc.ascii ? mc.asciify(readFrame) : readFrame;
              mcSocket.write(wireRMW);
            } catch (e) {
              node.warn('[MC-WRITE] RMW read write error: ' + e.message);
              rdResolved = true;
              rdCleanup(mcSocket);
              destroyConnection(connKey);
              getConnection(node, plc, function (e3, newSock2) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e3) { releaseConnection(connKey); finishWithError(); return; }
                mcSocket = newSock2;
                setTimeout(function () { rmwReadAttempt(attempt + 1); }, retryInterval);
              });
              return;
            }

            rdData = function (sock) {
              return function (chunk) {
                try {
                  if (rdBuf.length + chunk.length > 65536) {
                    rdResolved = true; rdCleanup(sock);
                    setTimeout(function () { rmwReadAttempt(attempt + 1); }, retryInterval);
                    return;
                  }
                  rdBuf = Buffer.concat([rdBuf, chunk]);
                  var hdrLen = (frameType === '4E') ? 15 : 11;
                  if (!rdResolved && rdBuf.length >= hdrLen) {
                    var dataLen = rdBuf.readUInt16LE((frameType === '4E') ? 11 : 7) - 2;
                    if (dataLen < 0 || dataLen > 2000) {
                      rdResolved = true; rdCleanup(sock);
                      setTimeout(function () { rmwReadAttempt(attempt + 1); }, retryInterval);
                      return;
                    }
                    if (rdBuf.length >= hdrLen + dataLen) {
                      rdResolved = true;
                      rdCleanup(sock);
                      var raw = mc.parseMCResponse(rdBuf, rmwGrp.wordAddr, rmwGrp.regType, frameType, sentSN);
                      if (!raw || raw.err || raw.mcError) {
                        setTimeout(function () { rmwReadAttempt(attempt + 1); }, retryInterval);
                        return;
                      }
                      // 🔧 RMW: 位设备 parseMCResponse 返回每 bit 值而非 word 值，
                      // 直接读 buf 中的 raw word
                      var ds2 = (frameType === '4E') ? 15 : 11;
                      if (rdBuf.length < ds2 + 2) {
                        hasFailed = true;
                        if (!firstError) firstError = '[RMW-READ] buffer too short for ' + rmwGrp.regType + rmwGrp.wordAddr;
                        rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                        setTimeout(function () { processPhase(pi + 1); }, 0);
                        return;
                      }
                      var wordVal = rdBuf.readUInt16LE(ds2);
                      if (wordVal === undefined || wordVal === null) {
                        hasFailed = true;
                        if (!firstError) firstError = '[RMW-READ] no data for ' + rmwGrp.regType + rmwGrp.wordAddr;
                        rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                        setTimeout(function () { processPhase(pi + 1); }, 0);
                        return;
                      }
                      // Step 2: 修改位
                      var modified = wordVal & 0xFFFF;
                      rmwGrp.bits.forEach(function (b) {
                        if (b.value) modified |= (1 << b.bitOffset);
                        else modified &= ~(1 << b.bitOffset);
                      });
                      // Step 3: 写回
                      rmwWriteBack(modified);
                    }
                  }
                } catch (e) {
                  node.warn('[MC-WRITE] RMW read handler error: ' + e.message);
                  rdCleanup(sock); rdResolved = true;
                  hasFailed = true;
                  if (!firstError) firstError = '[RMW-READ] ' + e.message;
                  setTimeout(function () { processPhase(pi + 1); }, 0);
                }
              };
            }(mcSocket);
            mcSocket.on('data', rdData);

            rdTmo = function (sock) {
              return function () {
                if (rdResolved) return;
                rdResolved = true; rdCleanup(sock);
                destroyConnection(connKey);
                getConnection(node, plc, function (e4, newSock3) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e4) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock3;
                  setTimeout(function () { rmwReadAttempt(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('timeout', rdTmo);

            rdErr = function (sock) {
              return function () {
                if (rdResolved) return;
                rdResolved = true; rdCleanup(sock);
                destroyConnection(connKey);
                getConnection(node, plc, function (e5, newSock4) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e5) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock4;
                  setTimeout(function () { rmwReadAttempt(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('error', rdErr);

            rdReqTimer = setTimeout(function () {
              if (rdResolved) return;
              node.warn('[MC-WRITE] RMW read request-level timeout');
              rdTmo();
            }, timeout);
          }

          function rmwWriteBack(modified) {
            if (node._closed) { releaseConnection(connKey); return; }
            if (mcSocket.destroyed) {
              destroyConnection(connKey);
              getConnection(node, plc, function (e2, newSock) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e2) { releaseConnection(connKey); finishWithError(); return; }
                mcSocket = newSock;
                rmwWriteBack(modified);
              });
              return;
            }

            var wsSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
            var writeFrame = mc.buildWriteFrame(frameType, rmwGrp.wordAddr, [modified], stationNo, rmwGrp.regType, networkNo, wsSN);

            function rmwWriteAttempt(writeAttempt) {
              if (node._closed) { releaseConnection(connKey); return; }
              if (mcSocket.destroyed) {
                destroyConnection(connKey);
                getConnection(node, plc, function (e2, newSock) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e2) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock;
                  rmwWriteAttempt(writeAttempt);
                });
                return;
              }
              if (writeAttempt > maxRetries) {
                hasFailed = true;
                if (!firstError) firstError = '[RMW-WRITE] failed for ' + rmwGrp.regType + rmwGrp.wordAddr;
                rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                setTimeout(function () { processPhase(pi + 1); }, 0);
                return;
              }

              var wrBuf = Buffer.alloc(0);
              var wrResolved = false;
              var wrTmo = null, wrErr = null, wrData = null;
              var wrReqTimer = null;

              function wrCleanup(sock) {
                if (!sock) return;
                sock.removeListener('data', wrData);
                sock.removeListener('timeout', wrTmo);
                sock.removeListener('error', wrErr);
                if (wrReqTimer) { clearTimeout(wrReqTimer); wrReqTimer = null; }
              }

              mcSocket.setTimeout(timeout);

              try {
                var wireRMW2 = plc.ascii ? mc.asciify(writeFrame) : writeFrame;
                mcSocket.write(wireRMW2);
              } catch (e) {
                node.warn('[MC-WRITE] RMW write error: ' + e.message);
                wrResolved = true; wrCleanup(mcSocket);
                destroyConnection(connKey);
                getConnection(node, plc, function (e3, newSock2) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e3) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock2;
                  setTimeout(function () { rmwWriteAttempt(writeAttempt + 1); }, retryInterval);
                });
                return;
              }

              wrData = function (sock) {
                return function (chunk) {
                  try {
                    if (wrBuf.length + chunk.length > 65536) {
                      wrResolved = true; wrCleanup(sock);
                      setTimeout(function () { rmwWriteAttempt(writeAttempt + 1); }, retryInterval);
                      return;
                    }
                    wrBuf = Buffer.concat([wrBuf, chunk]);
                    var hdrLen = (frameType === '4E') ? 15 : 11;
                    if (!wrResolved && wrBuf.length >= hdrLen) {
                      var dataLen = wrBuf.readUInt16LE((frameType === '4E') ? 11 : 7) - 2;
                      if (dataLen < 0 || dataLen > 2000) {
                        wrResolved = true; wrCleanup(sock);
                        setTimeout(function () { rmwWriteAttempt(writeAttempt + 1); }, retryInterval);
                        return;
                      }
                      if (wrBuf.length >= hdrLen + dataLen) {
                        wrResolved = true; wrCleanup(sock);
                        var wresp = mc.parseMCWriteResponse(wrBuf, frameType, wsSN);
                        if (wresp && wresp.ok) {
                          var groupTs = new Date().toISOString();
                          rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: b.value, quality: 0, ts: groupTs }; });
                          setTimeout(function () { processPhase(pi + 1); }, 0);
                        } else if (wresp && wresp.mcError) {
                          hasFailed = true;
                          if (!firstError) firstError = '[PLC 0x' + wresp.mcError.toString(16).toUpperCase() + '] ' + wresp.mcErrorText;
                          rmwGrp.bits.forEach(function (b) { allResults[b.tagId] = { value: null, quality: 2, ts: new Date().toISOString() }; });
                          setTimeout(function () { processPhase(pi + 1); }, 0);
                        } else {
                          setTimeout(function () { rmwWriteAttempt(writeAttempt + 1); }, retryInterval);
                        }
                      }
                    }
                  } catch (e) {
                    node.warn('[MC-WRITE] RMW write handler error: ' + e.message);
                    wrCleanup(sock); wrResolved = true;
                    hasFailed = true;
                    if (!firstError) firstError = '[RMW-WRITE] ' + e.message;
                    setTimeout(function () { processPhase(pi + 1); }, 0);
                  }
                };
              }(mcSocket);
              mcSocket.on('data', wrData);

              wrTmo = function (sock) {
                return function () {
                  if (wrResolved) return;
                  wrResolved = true; wrCleanup(sock);
                  destroyConnection(connKey);
                  getConnection(node, plc, function (e4, newSock3) {
                    if (node._closed) { releaseConnection(connKey); return; }
                    if (e4) { releaseConnection(connKey); finishWithError(); return; }
                    mcSocket = newSock3;
                    setTimeout(function () { rmwWriteAttempt(writeAttempt + 1); }, retryInterval);
                  });
                };
              }(mcSocket);
              mcSocket.once('timeout', wrTmo);

              wrErr = function (sock) {
                return function () {
                  if (wrResolved) return;
                  wrResolved = true; wrCleanup(sock);
                  destroyConnection(connKey);
                  getConnection(node, plc, function (e5, newSock4) {
                    if (node._closed) { releaseConnection(connKey); return; }
                    if (e5) { releaseConnection(connKey); finishWithError(); return; }
                    mcSocket = newSock4;
                    setTimeout(function () { rmwWriteAttempt(writeAttempt + 1); }, retryInterval);
                  });
                };
              }(mcSocket);
              mcSocket.once('error', wrErr);

              wrReqTimer = setTimeout(function () {
                if (wrResolved) return;
                node.warn('[MC-WRITE] RMW write request-level timeout');
                wrTmo();
              }, timeout);
            }
            rmwWriteAttempt(0);
          }

          rmwReadAttempt(0);
        }

        function finishWithError() {
          releaseConnection(connKey);
          msg.payload = {
            success: false, deviceId: deviceId, deviceName: deviceName, data: {},
            error: firstError || 'MC write connection lost', driverType: 'driver-mc-write-protocol',
            plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'conn lost' });
          node.error('[MC-WRITE] ' + (firstError || 'MC write connection lost'), msg);
          safeSend(msg);
        }

        processPhase(0);
      });
    });

    node.on('close', function (done) {
      node._closed = true;
      var fk = Object.keys(node._inFlightKeys || {});
      for (var fi = 0; fi < fk.length; fi++) {
        if (IN_FLIGHT_W[fk[fi]] === node.id) delete IN_FLIGHT_W[fk[fi]];
      }
      node._inFlightKeys = {};
      try { mcUdp.releaseNode(node.id); } catch (_) {}
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) {
        clearInterval(_cleanTimer);
        _cleanTimer = null;
      }
      var conns = node._usedConns || {};
      var keys = Object.keys(conns);
      for (var ci = 0; ci < keys.length; ci++) {
        var entry = CONN_POOL_W[keys[ci]];
        if (entry && entry.users) {
          delete entry.users[node.id];
          if (Object.keys(entry.users).length === 0) {
            destroyConnection(keys[ci]);
          }
        }
      }
      node._usedConns = {};
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('mitsubishi-write', MitsubishiWriteNode);
};
