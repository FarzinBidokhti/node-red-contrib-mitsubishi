/**
 * mc-protocol — 三菱 MC Protocol 3E/4E 协议工具函数
 * 与运行时解耦，便于单元测试
 */

// ===== MC 软元件代码映射 =====
var MC_DEVICE_CODES = {
  'D': 0xA8, 'W': 0xB4, 'X': 0x9C, 'Y': 0x9D,
  'M': 0x90, 'L': 0x92, 'B': 0xA0, 'R': 0xAF
};
var BIT_DEVICES = { 'X': true, 'Y': true, 'M': true, 'L': true, 'B': true };
var WORD_32_TYPES = { 'INT32': true, 'UINT32': true, 'FLOAT32': true };

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

function is32BitType(dt) {
  return !!WORD_32_TYPES[dt];
}

function parseDeviceAddress(regType, rawAddr) {
  var s = String(rawAddr || '').replace(/\D/g, '');
  if (!s) return -1;
  var radix = (regType === 'X' || regType === 'Y') ? 8 : 10;
  var addr = parseInt(s, radix);
  return isNaN(addr) || addr < 0 ? -1 : addr;
}

function formatDeviceAddress(regType, addr) {
  if (regType === 'X' || regType === 'Y') return regType + addr.toString(8).toUpperCase();
  return regType + addr;
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
  var buf = Buffer.alloc(24);
  buf[0] = 0x54; buf[1] = 0x00;
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0;
  buf[7] = 0x0F; buf[8] = 0x00;
  buf[9] = 0x10; buf[10] = 0x00;
  buf[11] = serialNo & 0xFF; buf[12] = (serialNo >> 8) & 0xFF;
  buf[13] = 0x01; buf[14] = 0x04;
  buf[15] = 0x00; buf[16] = 0x00;
  buf.writeUInt32LE(startAddr, 17);
  buf[21] = deviceCode;
  buf.writeUInt16LE(wordCount, 22);
  return buf;
}

// ===== 响应解析 =====
function parseMCResponse(buf, startAddr, regType, frameType, sentSN) {
  if (!buf || buf.length < 11) return { err: 'Buffer too short' };
  var subheader = (buf[0] === 0xD0) ? 0x50 : ((buf[0] === 0xD4) ? 0xD4 : 0);
  if (subheader === 0) return { err: 'Invalid subheader' };

  var endCode = buf.readUInt16LE(9);
  if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };

  var dataLen = buf.readUInt16LE(7) - ((frameType === '4E') ? 4 : 2);
  if (dataLen < 0 || dataLen > 2000) return { err: 'Bad dataLen: ' + dataLen };

  var dataStart = (frameType === '4E') ? 13 : 11;
  if (frameType === '4E' && buf.length >= 13) {
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

module.exports = {
  MC_DEVICE_CODES: MC_DEVICE_CODES,
  BIT_DEVICES: BIT_DEVICES,
  WORD_32_TYPES: WORD_32_TYPES,
  MC_ERROR_CODES: MC_ERROR_CODES,
  mcErrorText: mcErrorText,
  clampInt: clampInt,
  is32BitType: is32BitType,
  parseDeviceAddress: parseDeviceAddress,
  formatDeviceAddress: formatDeviceAddress,
  build3EFrame: build3EFrame,
  build4EFrame: build4EFrame,
  parseMCResponse: parseMCResponse,
  applyTransform: applyTransform
};
