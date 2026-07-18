/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var mcReadNode = require('../nodes/mitsubishi-read.js');
var mcConfigNode = require('../nodes/mitsubishi-config.js');

describe('mitsubishi-read node', function () {
  afterEach(function (done) {
    helper.unload().then(function () { done(); }).catch(done);
  });

  it('should load with defaults', function (done) {
    var flow = [
      { id: 'nc1', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      { id: 'nr1', type: 'mitsubishi-read', name: 'MC Read', plc: 'nc1', wires: [['nh1']] },
      { id: 'nh1', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcReadNode], flow, function () {
      var n1 = helper.getNode('nr1');
      assert.ok(n1);
      assert.strictEqual(n1.name, 'MC Read');
      done();
    });
  });

  it('should output simulated data when mcSimulationMode is true', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'nc2', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nr2', type: 'mitsubishi-read', name: 'MC Read', plc: 'nc2',
        tags: JSON.stringify([{ id: '温度', regType: 'D', addr: 100, dataType: 'INT16', slope: 0.1, offset: 0 }]),
        wires: [['nh2']]
      },
      { id: 'nh2', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcReadNode], flow, function () {
      var helperNode = helper.getNode('nh2');
      var readNode = helper.getNode('nr2');

      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(msg.payload.deviceId, 5678);
          assert.strictEqual(msg.payload.deviceName, 'TestPLC');
          assert.ok(msg.payload.data['温度']);
          assert.strictEqual(typeof msg.payload.data['温度'].rawValue, 'number');
          assert.strictEqual(typeof msg.payload.data['温度'].engValue, 'number');
          assert.strictEqual(msg.payload.data['温度'].quality, 0);
          assert.ok(msg.payload.data['温度'].ts);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({ payload: { id: 5678, deviceName: 'TestPLC' } });
    });
  });

  it('should fallback deviceName to PLC config name', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'nc3', type: 'mitsubishi-config', name: 'PLC-Config-Name', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nr3', type: 'mitsubishi-read', name: 'MC Read', plc: 'nc3',
        tags: JSON.stringify([{ id: '压力', regType: 'D', addr: 200, dataType: 'INT16' }]),
        wires: [['nh3']]
      },
      { id: 'nh3', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcReadNode], flow, function () {
      var helperNode = helper.getNode('nh3');
      var readNode = helper.getNode('nr3');

      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.deviceName, 'PLC-Config-Name');
          assert.strictEqual(msg.payload.data['压力'].quality, 0);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({ payload: { id: 9999 } });
    });
  });

});
