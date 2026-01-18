/**
 * Copyright 2013,2014 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
  'use strict';
  const MongoPersistence = require('aedes-persistence-mongodb');
  const aedes = require('aedes');
  const fs = require('fs');
  const net = require('net');
  const tls = require('tls');
  const http = require('http');
  const https = require('https');
  const ws = require('websocket-stream');

  let serverUpgradeAdded = false;
  const listenerNodes = {};

  /**
   * Handles a server upgrade.
   *
   * @param {Object} request - The request object.
   * @param {Object} socket - The socket object.
   * @param {Object} head - The head object.
   */
  function handleServerUpgrade(request, socket, head) {
    const pathname = new URL(request.url, 'http://example.org').pathname;
    if (Object.prototype.hasOwnProperty.call(listenerNodes, pathname)) {
      listenerNodes[pathname].ws_server.handleUpgrade(
        request,
        socket,
        head,
        function done(conn) {
          listenerNodes[pathname].ws_server.emit('connection', conn, request);
        }
      );
    }
  }

  function AedesBrokerNode(config) {
    RED.nodes.createNode(this, config);

    this.usetls = config.usetls;
    if (typeof this.usetls === 'undefined') {
      this.usetls = false;
    }

    this.mqtt_enabled = typeof config.mqtt_enabled === 'undefined' ? !this.usetls : config.mqtt_enabled;
    this.mqtts_enabled = typeof config.mqtts_enabled === 'undefined' ? !!this.usetls : config.mqtts_enabled;
    this.mqtt_port = parseInt(config.mqtt_port, 10);
    this.mqtt_port_ssl = parseInt(config.mqtt_port_ssl, 10) || 8883;

    // Compatibility fix for old config where mqtt_port could be the SSL port
    if (typeof config.mqtt_enabled === 'undefined' && this.usetls) {
      this.mqtt_port_ssl = this.mqtt_port;
      this.mqtt_port = 1883;
    }

    this.mqtt_ws_port = parseInt(config.mqtt_ws_port, 10);
    this.mqtt_ws_port_ssl = parseInt(config.mqtt_ws_port_ssl, 10);
    this.mqtt_ws_path = '' + config.mqtt_ws_path;
    this.mqtt_ws_bind = config.mqtt_ws_bind;

    const certPath = config.cert ? config.cert.trim() : '';
    const keyPath = config.key ? config.key.trim() : '';
    const caPath = config.ca ? config.ca.trim() : '';

    this.uselocalfiles = config.uselocalfiles;
    this.dburl = config.dburl;

    if (this.mqtt_ws_bind === 'path') {
      this.mqtt_ws_port = 0;
      this.mqtt_ws_port_ssl = 0;
    } else {
      this.mqtt_ws_path = '';
    }

    if (certPath.length > 0 || keyPath.length > 0 || caPath.length > 0) {
      if ((certPath.length > 0) !== (keyPath.length > 0)) {
        this.valid = false;
        this.error(RED._('tls.error.missing-file'));
        return;
      }
      try {
        if (certPath) {
          this.cert = fs.readFileSync(certPath);
        }
        if (keyPath) {
          this.key = fs.readFileSync(keyPath);
        }
        if (caPath) {
          this.ca = fs.readFileSync(caPath);
        }
      } catch (err) {
        this.valid = false;
        this.error(err.toString());
        return;
      }
    } else {
      if (this.credentials) {
        this.cert = this.credentials.certdata || '';
        this.key = this.credentials.keydata || '';
        this.ca = this.credentials.cadata || '';
      }
    }
    if (this.credentials) {
      this.username = this.credentials.username;
      this.password = this.credentials.password;
    }

    const node = this;

    const aedesSettings = {};
    const serverOptions = {};

    if (config.persistence_bind === 'mongodb' && config.dburl) {
      aedesSettings.persistence = MongoPersistence({
        url: config.dburl
      });
      node.log('Start persistence to MongeDB');
    }

    if (this.cert && this.key && (this.usetls || this.mqtts_enabled || this.mqtt_ws_port_ssl)) {
      serverOptions.cert = this.cert;
      serverOptions.key = this.key;
      serverOptions.ca = this.ca;
    }

    const broker = aedes.createBroker(aedesSettings);
    node.broker = broker;
    node.servers = [];

    function startServer(s) {
      s.server.once('error', function (err) {
        if (err.code === 'EADDRINUSE') {
          node.error('Error: Port ' + s.port + ' (' + s.type + ') is already in use');
        } else {
          node.error('Error: Port ' + s.port + ' (' + s.type + ') ' + err.toString());
        }
        node.status({ fill: 'red', shape: 'ring', text: 'node-red:common.status.disconnected' });
      });

      s.server.listen(s.port, function () {
        node.log('Binding aedes ' + s.type + ' server on port: ' + s.port);
        node.status({ fill: 'green', shape: 'dot', text: 'node-red:common.status.connected' });
      });
    }

    setImmediate(() => {
      // MQTT Server
      if (node.mqtt_enabled && node.mqtt_port) {
        const server = net.createServer(broker.handle);
        const s = { server, port: node.mqtt_port, type: 'mqtt' };
        node.servers.push(s);
        startServer(s);
      }

      // MQTTS Server
      if (node.mqtts_enabled && node.mqtt_port_ssl && node.cert && node.key) {
        const server = tls.createServer(serverOptions, broker.handle);
        const s = { server, port: node.mqtt_port_ssl, type: 'mqtts' };
        node.servers.push(s);
        startServer(s);
      }

      // WS Server (HTTP) logic with probe
      if (node.mqtt_ws_port) {
        const testServer = net.createServer();
        testServer.once('error', function (err) {
          if (err.code === 'EADDRINUSE') {
            node.error('Error: Port ' + node.mqtt_ws_port + ' (ws) is already in use');
          } else {
            node.error('Error creating probe server on port ' + node.mqtt_ws_port + ', ' + err.toString());
          }
        });
        testServer.once('listening', function () { testServer.close(); });
        testServer.once('close', function () {
          const httpServer = http.createServer();
          const wss = ws.createServer({ server: httpServer }, broker.handle);
          const s = { server: httpServer, wss, port: node.mqtt_ws_port, type: 'ws' };
          node.servers.push(s);
          startServer(s);
        });
        testServer.listen(node.mqtt_ws_port);
      }

      // WSS Server (HTTPS) logic with probe
      if (node.mqtt_ws_port_ssl && node.cert && node.key) {
        const testServer = net.createServer();
        testServer.once('error', function (err) {
          if (err.code === 'EADDRINUSE') {
            node.error('Error: Port ' + node.mqtt_ws_port_ssl + ' (wss) is already in use');
          } else {
            node.error('Error creating probe server on port ' + node.mqtt_ws_port_ssl + ', ' + err.toString());
          }
        });
        testServer.once('listening', function () { testServer.close(); });
        testServer.once('close', function () {
          const httpsServer = https.createServer(serverOptions);
          const wss = ws.createServer({ server: httpsServer }, broker.handle);
          const s = { server: httpsServer, wss, port: node.mqtt_ws_port_ssl, type: 'wss' };
          node.servers.push(s);
          startServer(s);
        });
        testServer.listen(node.mqtt_ws_port_ssl);
      }
    });

    if (this.mqtt_ws_path !== '') {
      if (!serverUpgradeAdded) {
        RED.server.on('upgrade', handleServerUpgrade);
        serverUpgradeAdded = true;
      }

      let path = RED.settings.httpNodeRoot || '/';
      path =
        path +
        (path.slice(-1) === '/' ? '' : '/') +
        (node.mqtt_ws_path.charAt(0) === '/'
          ? node.mqtt_ws_path.substring(1)
          : node.mqtt_ws_path);
      node.fullPath = path;

      if (Object.prototype.hasOwnProperty.call(listenerNodes, path)) {
        node.error(
          RED._('websocket.errors.duplicate-path', { path: node.mqtt_ws_path })
        );
        return;
      }
      listenerNodes[node.fullPath] = node;

      node.ws_server = ws.createServer(
        {
          noServer: true
        },
        broker.handle
      );

      node.log('Binding aedes mqtt server on ws path: ' + node.fullPath);
    }

    if (this.credentials && this.username && this.password) {
      broker.authenticate = function (client, username, password, callback) {
        const authorized =
          username === node.username &&
          password &&
          password.toString() === node.password;
        if (authorized) {
          client.user = username;
        }
        callback(null, authorized);
      };
    }

    broker.on('client', function (client) {
      const msg = {
        topic: 'client',
        payload: {
          client
        }
      };
      node.send([msg, null]);
    });

    broker.on('clientReady', function (client) {
      const msg = {
        topic: 'clientReady',
        payload: {
          client
        }
      };
      node.status({
        fill: 'green',
        shape: 'dot',
        text: RED._('aedes-mqtt-broker.status.connected', {
          count: broker.connectedClients
        })
      });
      node.send([msg, null]);
    });

    broker.on('clientDisconnect', function (client) {
      const msg = {
        topic: 'clientDisconnect',
        payload: {
          client
        }
      };
      node.send([msg, null]);
      node.status({
        fill: 'green',
        shape: 'dot',
        text: RED._('aedes-mqtt-broker.status.connected', {
          count: broker.connectedClients
        })
      });
    });

    broker.on('clientError', function (client, err) {
      const msg = {
        topic: 'clientError',
        payload: {
          client,
          err
        }
      };
      node.send([msg, null]);
      node.status({
        fill: 'green',
        shape: 'dot',
        text: RED._('aedes-mqtt-broker.status.connected', {
          count: broker.connectedClients
        })
      });
    });

    broker.on('connectionError', function (client, err) {
      const msg = {
        topic: 'connectionError',
        payload: {
          client,
          err
        }
      };
      node.send([msg, null]);
      node.status({
        fill: 'green',
        shape: 'dot',
        text: RED._('aedes-mqtt-broker.status.connected', {
          count: broker.connectedClients
        })
      });
    });

    broker.on('keepaliveTimeout', function (client) {
      const msg = {
        topic: 'keepaliveTimeout',
        payload: {
          client
        }
      };
      node.send([msg, null]);
      node.status({
        fill: 'green',
        shape: 'dot',
        text: RED._('aedes-mqtt-broker.status.connected', {
          count: broker.connectedClients
        })
      });
    });

    broker.on('subscribe', function (subscription, client) {
      const msg = {
        topic: 'subscribe',
        payload: {
          topic: subscription.topic,
          qos: subscription.qos,
          client
        }
      };
      node.send([msg, null]);
    });

    broker.on('unsubscribe', function (subscription, client) {
      const msg = {
        topic: 'unsubscribe',
        payload: {
          topic: subscription.topic,
          qos: subscription.qos,
          client
        }
      };
      node.send([msg, null]);
    });

    if (this.wires && this.wires[1] && this.wires[1].length > 0) {
      node.log('Publish output wired. Enable broker publish event messages.');
      broker.on('publish', function (packet, client) {
        const msg = {
          topic: 'publish',
          payload: {
            packet,
            client
          }
        };
        node.send([null, msg]);
      });
    }

    broker.on('closed', function () {
      node.debug('Closed event');
    });

    this.on('close', function (done) {
      node.log('Closing Aedes broker and servers...');
      const serversToClose = [...node.servers];
      if (node.mqtt_ws_path !== '' && node.ws_server) {
        serversToClose.push({ server: node.ws_server, type: 'ws-path' });
      }

      let closeCount = serversToClose.length + 1; // servers + broker
      let doneCalled = false;
      function checkDone() {
        closeCount--;
        if (closeCount <= 0 && !doneCalled) {
          doneCalled = true;
          node.log('All servers and broker closed');
          done();
        }
      }

      // Timeout safety
      setTimeout(() => {
        if (!doneCalled) {
          node.warn('Aedes close timed out, forcing done');
          doneCalled = true;
          done();
        }
      }, 5000);

      broker.close(checkDone);
      serversToClose.forEach(s => {
        node.log('Closing ' + s.type + ' server');
        if (s.wss) {
          s.wss.close(function () {
            s.server.close(checkDone);
          });
        } else {
          s.server.close(checkDone);
        }
      });
    });
  }

  RED.nodes.registerType('aedes broker', AedesBrokerNode, {
    credentials: {
      username: { type: 'text' },
      password: { type: 'password' },
      certdata: { type: 'text' },
      cadata: { type: 'text' },
      keydata: { type: 'text' }
    }
  });
};
