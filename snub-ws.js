const { WebSocketServer } = require('@clusterws/cws');

module.exports = function (config) {
  config = Object.assign({
    port: 8585,
    auth: false,
    debug: false,
    mutliLogin: true,
    authTimeout: 3000,
    throttle: [50, 5000], // X number of messages per Y milliseconds.
    idleTimeout: 1000 * 60 * 60, // disconnect if nothing has come from client in x ms 1 hour default
    error: _ => {}
  }, config || {});

  // process.stdin.resume();// so the program will not close instantly

  // function exitHandler (options, exitCode) {
  //   if (options.cleanup) console.log('clean');
  //   if (exitCode || exitCode === 0) console.log(exitCode);
  //   if (options.exit) process.exit();
  // }

  // // do something when app is closing
  // process.on('exit', exitHandler.bind(null, { cleanup: true }));

  // // catches ctrl+c event
  // process.on('SIGINT', exitHandler.bind(null, { exit: true }));

  // // catches "kill pid" (for example: nodemon restart)
  // process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
  // process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));

  // catches uncaught exceptions
  // process.on('uncaughtException', exitHandler.bind(null, { exit: true }));

  return function (snub) {
    var wss = new WebSocketServer({
      port: config.port
    }, () => {
      if (config.debug) { console.log('Snub WS server listening on port ' + config.port); }
    });
    var socketClients = [];
    var trackedClients = [];

    // clean up old sockets
    setInterval(_ => {
      socketClients.forEach((client, idx) => {
        if (!client) { return socketClients.splice(idx, 1); }
        let kill = false;

        if (client.dead) { kill = 'DEAD_SOCKET'; }

        if (client.lastMsgTime < Date.now() - config.idleTimeout) { kill = 'IDLE_TIMEOUT'; }

        if (client.connectTime < Date.now() - 1000 * 60 && !client.authenticated) { kill = 'AUTH_FAIL'; }

        if (!kill) return;

        if (client.ws && client.ws.close) {
          client.ws.close(1000, kill);
        }
        socketClients.splice(idx, 1);
      });
    }, 5000);

    snub.on('ws_internal:tracked-client-upsert', upsertTrackedClients);

    snub.on('ws_internal:tracked-client-remove', function (clientId) {
      var idx = trackedClients.findIndex(tc => tc.id === clientId);
      if (idx > -1)
        trackedClients.splice(idx, 1);
    });

    snub.on('ws_internal:tracked-client-fetch', function (clientId, reply) {
      var clients = socketClients.filter(client => {
        return (client.state.connected && client.state.authenticated);
      }).map(client => client.state);
      if (clients.length)
        snub.poly('ws_internal:tracked-client', clients).send();
    });

    snub.on('ws_internal:tracked-client-fetch', upsertTrackedClients);

    Object.defineProperty(snub, 'wsConnectedClients', {
      get: function () {
        return JSON.parse(JSON.stringify(trackedClients));
      }
    });

    wss.on('connection', (ws, upGr) => {
      ws.upgradeReq = upGr;
      var clientConn = new ClientConnection(ws);
      socketClients.push(clientConn);
      if (config.debug) { console.log('Snub WS Client Connected => ' + clientConn.id); }
      snub.mono('ws:client-connected', clientConn.state).send();
      snub.poly('ws_internal:client-connected', clientConn.state).send();
    });

    snub.on('ws:send-all', function (payload) {
      socketClients.forEach(client => {
        if (client.authenticated)
          client.send(...payload);
      });
    });

    // get client info
    // snub.on('ws:get-clients', function (arrayOfClients, reply) {
    //   if (typeof arrayOfClients === 'string') arrayOfClients = [arrayOfClients];
    //   if (!Array.isArray(arrayOfClients)) return;
    //   arrayOfClients = socketClients.filter(client => {
    //     if (arrayOfClients.includes(client.state.id) || arrayOfClients.includes(client.state.username)) { return true; }
    //     return false;
    //   }).map(client => client.state);
    //   if (arrayOfClients.length > 0) { reply(arrayOfClients); }
    // });

    snub.on('ws:get-clients', function (ids, reply) {
      if (typeof ids === 'string') ids = [ids];
      if (!Array.isArray()) return;
      trackedClients.filter(tc => {
        if (tc.connectedClient || tc.authenticated) return false;
        if (ids.includes(tc.username) || ids.includes(tc.id))
          return true;
        return false;
      });
    });

    snub.on('ws:send:*', function (payload, n1, channel) {
      var sendTo = channel.split(':').pop().split(',');
      var [event, ePayload] = payload;

      socketClients.forEach(client => {
        if (sendTo.includes(client.state.id) || sendTo.includes(client.state.username)) {
          client.send(event, ePayload);
        }
      });
    });

    snub.on('ws:send-channel:*', function (payload, n1, channel) {
      var channels = channel.split(':').pop().split(',');
      var [event, ePayload] = payload;
      socketClients.forEach(client => {
        if (channels.some(channel => client.state.channels.includes(channel))) { client.send(event, ePayload); }
      });
    });

    snub.on('ws:set-meta:*', function (metaObj, reply, channel) {
      Object.keys(metaObj).forEach(k => {
        if (Array.isArray(metaObj[k])) {
          return (metaObj[k] = metaObj[k].filter(i => {
            return (['number', 'string'].includes(typeof i) && String(i).length < 64);
          }).slice(0, 64));
        }
        if (['number', 'string'].includes(typeof metaObj[k]) && String(metaObj[k]).length > 128) { return (delete metaObj[k]); }
        if (typeof metaObj[k] === 'object') { return (delete metaObj[k]); }
      });

      var clients = channel.split(':').pop().split(',');
      clients = socketClients.filter(client => {
        if (!clients.includes(client.state.id) && !clients.includes(client.state.username)) return false;
        Object.assign(client.metaObj, metaObj);
        return true;
      }).map(client => client.state);
      snub.mono('ws_internal:tracked-client', clients).send();
      if (clients.length > 0 && reply) { reply(clients); }
    });

    // add, set and delet channels for a client
    snub.on('ws:add-channel:*', function (arrayOfChannels, reply, channel) {
      if (typeof arrayOfChannels === 'string') arrayOfChannels = [arrayOfChannels];
      var clients = channel.split(':').pop().split(',');
      clients = socketClients.filter(client => {
        if (!clients.includes(client.state.id) && !clients.includes(client.state.username)) return false;
        client.channels = [].concat(client.channels, arrayOfChannels);
        return true;
      }).map(client => client.state);
      snub.mono('ws_internal:tracked-client', clients).send();
      if (clients.length > 0 && reply) { reply(clients); }
    });
    snub.on('ws:set-channel:*', function (arrayOfChannels, reply, channel) {
      if (typeof arrayOfChannels === 'string') arrayOfChannels = [arrayOfChannels];
      var clients = channel.split(':').pop().split(',');
      clients = socketClients.filter(client => {
        if (!clients.includes(client.state.id) && !clients.includes(client.state.username)) return false;
        client.channels = arrayOfChannels;
        return true;
      }).map(client => client.state);
      snub.mono('ws_internal:tracked-client', clients).send();
      if (clients.length > 0 && reply) { reply(clients); }
    });
    snub.on('ws:del-channel:*', function (arrayOfChannels, reply, channel) {
      if (typeof arrayOfChannels === 'string') arrayOfChannels = [arrayOfChannels];
      var clients = channel.split(':').pop().split(',');
      clients = socketClients.filter(client => {
        if (!clients.includes(client.state.id) && !clients.includes(client.state.username)) return false;
        client.channels = client.state.channels.filter(channel => (!(arrayOfChannels.indexOf(channel) > -1)));
        return true;
      }).map(client => client.state);
      snub.mono('ws_internal:tracked-client', clients).send();
      if (clients.length > 0 && reply) { reply(clients); }
    });

    snub.on('ws:kick:*', function (message, n2, channel) {
      var sendTo = channel.split(':').pop().split(',');
      socketClients.forEach(client => {
        if (!sendTo.includes(client.state.id) && !sendTo.includes(client.state.username)) return;
        client.kick(message);
        client.authenticated = false;
      });
    });

    snub.on('ws_internal:client-authenticated', function (connectedClient) {
      // if mutliLogin is on then we need to kick other clients with the same username.
      if (config.mutliLogin === false) {
        socketClients.forEach(client => {
          if (client.state.username === connectedClient.username &&
            client.state.id !== connectedClient.id &&
            client.connectTime < connectedClient.connectTime &&
            !client.dead) {
            return client.kick('DUPE_LOGIN');
          }
          return false;
        });
      }
    });

    snub.on('ws:connected-clients', function (nil, reply) {
      reply(snub.wsConnectedClients);
    });

    function generateUID () {
      var firstPart = (Math.random() * 46656) | 0;
      var secondPart = (Math.random() * 46656) | 0;
      firstPart = ('000' + firstPart.toString(36)).slice(-3);
      secondPart = ('000' + secondPart.toString(36)).slice(-3);
      return firstPart + secondPart;
    }

    function ClientConnection (ws) {
      this.ws = ws;
      var authTimeout;

      var wsMeta = {
        url: ws.upgradeReq.url,
        origin: ws.upgradeReq.headers.origin,
        host: ws.upgradeReq.headers.host,
        remoteAddress: ws.upgradeReq.headers['x-real-ip'] || ws.upgradeReq.headers['x-forwarded-for'] || ws._socket.remoteAddress
      };

      Object.assign(this, {
        id: process.pid + '-' + generateUID(),
        auth: {},
        channels: [],
        connected: true,
        authenticated: false,
        connectTime: Date.now(),
        recent: [],
        lastMsgTime: Date.now(),
        metaObj: {}
      });

      Object.defineProperty(this, 'state', {
        get: function () {
          return {
            id: this.id,
            username: this.auth.username,
            channels: this.channels,
            connected: this.connected,
            authenticated: this.authenticated,
            connectTime: this.connectTime,
            remoteAddress: wsMeta.remoteAddress,
            meta: this.metaObj
          };
        }
      });

      snub.mono('ws_internal:tracked-client', this.state).send();

      var acceptAuth = () => {
        this.authenticated = true;

        snub.mono('ws:client-authenticated', this.state).send();
        snub.poly('ws_internal:client-authenticated', this.state).send();
        if (config.debug) { console.log('Snub WS Client Authenticated => ' + this.state.id); }
        clearTimeout(authTimeout);

        // we want to add a delay here to allow a small window of time to kick dupe users
        setTimeout(_ => {
          if (this.state.authenticated) { this.send('_acceptAuth', this.state.id); }
        }, config.mutliLogin ? 0 : 200);
        snub.mono('ws_internal:tracked-client', this.state).send();
      };

      var denyAuth = () => {
        this.kick('AUTH_FAIL');
        snub.mono('ws:client-failedauth', this.state).send();
        if (config.debug) { console.log('Snub WS Client Rejected Auth => ' + this.state.id); }
        clearTimeout(authTimeout);
      };

      var libReserved = {
        _auth: (data) => {
          this.auth = data || {};
          authTimeout = setTimeout(() => {
            this.kick('AUTH_TIMEOUT');
          }, config.authTimeout);

          if (config.auth === false) { return acceptAuth(); }

          if (typeof config.auth === 'string') {
            snub.mono('ws:' + config.auth, Object.assign({}, data, wsMeta, { id: this.id })).replyAt(payload => {
              if (payload === true) { return acceptAuth(); }
              denyAuth();
            }).send(recieved => {
              if (!recieved) { denyAuth(); }
            });
          }
          if (typeof config.auth === 'function') {
            config.auth(Object.assign({}, data, wsMeta, { id: this.id }), res => {
              if (res === true)
                return acceptAuth();
              return denyAuth();
            });
          }
        },
        _ping: ts => {
          this.send('_pong', ts);
        }
      };

      if (config.auth) {
        authTimeout = setTimeout(_ => {
          if (!this.authenticated)
            this.kick('AUTH_TIMEOUT');
        }, config.authTimeout);
      } else {
        acceptAuth();
      }

      ws.on('message', e => {
        try {
          this.lastMsgTime = Date.now();
          var [event, data, reply] = JSON.parse(e);

          // block client messages
          if (['send-all', 'connected-clients', 'client-authenticated', 'client-failedauth'].includes(event)) return false;
          if (event.match(/^(send|kick|send-channel|set-meta|add-channel|set-channel|del-channel):/)) return false;

          if (typeof libReserved[event] === 'function') {
            return libReserved[event](data);
          }
          if (!this.authenticated) return;

          if (config.throttle) {
            this.recent = this.recent.filter(ts => ts > Date.now() - config.throttle[1]);
            if (this.recent.length > config.throttle[0]) { this.kick('THROTTLE_LIMIT'); }
            this.recent.push(Date.now());
          }

          snub.mono('ws:' + event, {
            from: this.state,
            payload: data,
            _ts: Date.now()
          })
            .replyAt((reply ? data => {
              this.send(reply, data);
            } : undefined))
            .send(c => {
              if (c < 1 && reply) {
                this.send(reply + ':error', {
                  error: 'Nothing was listening to this event'
                });
              }
            });
        } catch (err) {
          config.error(err);
        }
      });

      ws.on('error', config.error);

      ws.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        snub.mono('ws:client-disconnected', this.state).send();
        snub.mono('ws_internal:tracked-client-remove', this.id).send();
        this.dead = true;
      });
    }

    ClientConnection.prototype.kick = function (reason) {
      this.authenticated = false;
      this.send('_kickConnection', reason || null);
      this.close(1000, reason);
      if (config.debug) { console.log('Snub WS Client Kicked [' + reason + '] => ' + this.state.id); }
    };

    ClientConnection.prototype.close = function (code, reason) {
      this.ws.close(code || 1000, reason || 'NO_REASON');
    };

    ClientConnection.prototype.send = function (event, payload) {
      if (!(this.connected && this.authenticated) && event !== '_kickConnection') return;

      const payLoadStr = JSON.stringify([event, payload]);

      const msgHash = hashString(payLoadStr);
      if (msgHash === this.lastMsgHash) return;
      this.lastMsgHash = msgHash;
      this.ws.send(payLoadStr);
    };

    function upsertTrackedClients (clients) {
      if (!Array.isArray(clients))
        clients = [clients];
      clients.forEach(c => {
        if (!c.connected || !c.authenticated) return;
        c.last_seen = Date.now();
        var existing = trackedClients.find(tc => tc.id === c.id);
        if (existing)
          return Object.assign(existing, c);
        trackedClients.push(c);
      });
    }
  };
};

function hashString (str) {
  let hash = 0;
  let i;
  let chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}
