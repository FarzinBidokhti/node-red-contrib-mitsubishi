/* eslint-env mocha */
'use strict';

var assert = require('assert');
var mc = require('../nodes/mc-protocol');

describe('mc-protocol', function () {
  describe('parseDeviceAddress', function () {
    it('parses decimal addresses for D/W/R/M/L/B', function () {
      assert.strictEqual(mc.parseDeviceAddress('D', 'D100'), 100);
      assert.strictEqual(mc.parseDeviceAddress('M', 'M123'), 123);
      assert.strictEqual(mc.parseDeviceAddress('D', 200), 200);
    });

    it('parses octal addresses for X/Y', function () {
      // X10 (octal) = 8 (decimal)
      assert.strictEqual(mc.parseDeviceAddress('X', 'X10'), 8);
      // X17 (octal) = 15 (decimal)
      assert.strictEqual(mc.parseDeviceAddress('X', 'X17'), 15);
      // X20 (octal) = 16 (decimal)
      assert.strictEqual(mc.parseDeviceAddress('Y', 'Y20'), 16);
    });

    it('returns -1 for invalid addresses', function () {
      assert.strictEqual(mc.parseDeviceAddress('D', ''), -1);
      assert.strictEqual(mc.parseDeviceAddress('D', null), -1);
    });
  });

  describe('formatDeviceAddress', function () {
    it('formats X/Y as octal', function () {
      assert.strictEqual(mc.formatDeviceAddress('X', 8), 'X10');
      assert.strictEqual(mc.formatDeviceAddress('Y', 16), 'Y20');
    });

    it('formats others as decimal', function () {
      assert.strictEqual(mc.formatDeviceAddress('D', 100), 'D100');
    });
  });

  describe('build3EFrame', function () {
    it('constructs a 3E read frame with correct subheader and length', function () {
      var buf = mc.build3EFrame(100, 5, 0, 'D', 0);
      assert.strictEqual(buf.length, 21);
      assert.strictEqual(buf[0], 0x50);
      assert.strictEqual(buf[1], 0x00);
      assert.strictEqual(buf[18], 0xA8); // D device code
      assert.strictEqual(buf.readUInt16LE(19), 5);
    });
  });

  describe('build4EFrame', function () {
    it('always includes serial number field', function () {
      var buf0 = mc.build4EFrame(100, 5, 0, 'D', 0, 0);
      assert.strictEqual(buf0.length, 24);
      assert.strictEqual(buf0.readUInt16LE(11), 0);

      var buf1 = mc.build4EFrame(100, 5, 0, 'D', 0, 7);
      assert.strictEqual(buf1.length, 24);
      assert.strictEqual(buf1.readUInt16LE(11), 7);
    });
  });

  describe('parseMCResponse', function () {
    it('parses 3E word response', function () {
      // 3E response header: 11 bytes
      // [subheader(2), network, pc, io(2), station, dataLen+2(2), endCode(2)]
      var data = Buffer.alloc(4);
      data.writeInt16LE(100, 0);
      data.writeInt16LE(200, 2);
      var hdr = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x06, 0x00, 0x00, 0x00]);
      var buf = Buffer.concat([hdr, data]);
      var res = mc.parseMCResponse(buf, 10, 'D', '3E', 0);
      assert.strictEqual(res.err, undefined);
      assert.strictEqual(res['D10'], 100);
      assert.strictEqual(res['D11'], 200);
    });

    it('parses 3E bit response', function () {
      // bit response: 1 word = 16 bits, dataLen+2=4
      var data = Buffer.alloc(2);
      data.writeUInt16LE(0b0000000000001010, 0); // bits 1 and 3 set
      var hdr = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x04, 0x00, 0x00, 0x00]);
      var buf = Buffer.concat([hdr, data]);
      var res = mc.parseMCResponse(buf, 0, 'X', '3E', 0);
      assert.strictEqual(res['X0'], 0);
      assert.strictEqual(res['X1'], 1);
      assert.strictEqual(res['X2'], 0);
      assert.strictEqual(res['X3'], 1);
    });

    it('reports MC end code errors', function () {
      // endCode 0xC052 (address out of range), dataLen+2=2
      var hdr = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x02, 0x00, 0x52, 0xC0]);
      var res = mc.parseMCResponse(hdr, 10, 'D', '3E', 0);
      assert.strictEqual(res.mcError, 0xC052);
      assert.ok(res.mcErrorText.indexOf('Address out of range') >= 0);
    });

    it('detects 4E serial number mismatch', function () {
      // 4E response header: 13 bytes
      // [subheader(2), network, pc, io(2), station, dataLen+4(2), endCode(2), serial(2)]
      var data = Buffer.alloc(2);
      data.writeInt16LE(42, 0);
      var hdr = Buffer.from([0xD4, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x06, 0x00, 0x00, 0x00, 0x05, 0x00]);
      // sentSN=7 but response SN=5
      var buf = Buffer.concat([hdr, data]);
      var res = mc.parseMCResponse(buf, 10, 'D', '4E', 7);
      assert.strictEqual(res.err, 'SerialNo mismatch');
    });
  });

  describe('32-bit decoding via parseMCResponse', function () {
    it('produces low/high words in correct positions', function () {
      // D0 = 0x0064 (100), D1 = 0x0000
      var data = Buffer.alloc(4);
      data.writeInt16LE(0x0064, 0);
      data.writeInt16LE(0x0000, 2);
      var hdr = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x06, 0x00, 0x00, 0x00]);
      var buf = Buffer.concat([hdr, data]);
      var raw = mc.parseMCResponse(buf, 0, 'D', '3E', 0);
      assert.strictEqual(raw['D0'], 100);
      assert.strictEqual(raw['D1'], 0);
    });
  });

  describe('applyTransform', function () {
    it('applies slope and offset', function () {
      assert.strictEqual(mc.applyTransform(2530, { slope: 0.1, offset: 0 }), 253);
      assert.strictEqual(mc.applyTransform(100, { slope: 2, offset: 5 }), 205);
    });
  });
});
