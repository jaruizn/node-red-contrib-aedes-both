/* eslint-env mocha */
const helper = require('node-red-node-test-helper');
const aedesNode = require('../aedes.js');
const mqttNode = require('../node_modules/@node-red/nodes/core/network/10-mqtt.js');
const mqtt = require('mqtt');
const should = require('should');
const fs = require('fs');
const path = require('path');

helper.init(require.resolve('node-red'));

describe('Aedes Broker Multi-Port tests', function () {
    const keyPath = path.join(__dirname, 'certs', 'key.pem');
    const certPath = path.join(__dirname, 'certs', 'cert.pem');

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it('should support simultaneous MQTT and MQTTS connections', function (done) {
        this.timeout(10000);
        const flow = [
            {
                id: 'n1',
                type: 'aedes broker',
                mqtt_enabled: true,
                mqtt_port: '1883',
                mqtts_enabled: true,
                mqtt_port_ssl: '8883',
                cert: certPath,
                key: keyPath,
                name: 'Aedes Multi',
                wires: [[], []]
            }
        ];

        helper.load(aedesNode, flow, function () {
            const client_mqtt = mqtt.connect('mqtt://localhost:1883');
            const client_mqtts = mqtt.connect('mqtts://localhost:8883', { rejectUnauthorized: false });

            let connectedCount = 0;
            function checkConnected() {
                connectedCount++;
                if (connectedCount === 2) {
                    client_mqtts.subscribe('test/multi', function () {
                        client_mqtt.publish('test/multi', 'hello from mqtt');
                    });
                }
            }

            let doneCalled = false;
            function safeDone(err) {
                if (!doneCalled) {
                    doneCalled = true;
                    done(err);
                }
            }

            client_mqtt.on('connect', checkConnected);
            client_mqtts.on('connect', checkConnected);

            client_mqtts.on('message', function (topic, message) {
                topic.should.equal('test/multi');
                message.toString().should.equal('hello from mqtt');
                client_mqtt.end();
                client_mqtts.end();
                safeDone();
            });

            client_mqtt.on('error', function (err) { safeDone(err); });
            client_mqtts.on('error', function (err) { safeDone(err); });
        });
    });

    it('should support simultaneous WS and WSS connections', function (done) {
        this.timeout(10000);
        const flow = [
            {
                id: 'n1',
                type: 'aedes broker',
                mqtt_enabled: false,
                mqtts_enabled: false,
                mqtt_ws_bind: 'port',
                mqtt_ws_port: '8080',
                mqtt_ws_port_ssl: '8081',
                cert: certPath,
                key: keyPath,
                name: 'Aedes WS Multi',
                wires: [[], []]
            }
        ];

        helper.load(aedesNode, flow, function () {
            const client_ws = mqtt.connect('ws://localhost:8080');
            const client_wss = mqtt.connect('wss://localhost:8081', { rejectUnauthorized: false });

            let connectedCount = 0;
            function checkConnected() {
                connectedCount++;
                if (connectedCount === 2) {
                    client_wss.subscribe('test/multi_ws', function () {
                        client_ws.publish('test/multi_ws', 'hello from ws');
                    });
                }
            }

            let doneCalled = false;
            function safeDone(err) {
                if (!doneCalled) {
                    doneCalled = true;
                    done(err);
                }
            }

            client_ws.on('connect', checkConnected);
            client_wss.on('connect', checkConnected);

            client_wss.on('message', function (topic, message) {
                topic.should.equal('test/multi_ws');
                message.toString().should.equal('hello from ws');
                client_ws.end();
                client_wss.end();
                safeDone();
            });

            client_ws.on('error', function (err) { safeDone(err); });
            client_wss.on('error', function (err) { safeDone(err); });
        });
    });
});
