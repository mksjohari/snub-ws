const uWS = require('uws.js');
const path = require('path');
var cleanUpFns = [];

process.stdin.resume(); // so the program will not close instantly

function exitHandler(options, exitCode) {
  cleanUpFns.forEach((fn) => {
    fn();
  });
  process.exit();
}

// do something when app is closing
process.on('exit', exitHandler.bind(null, { exit: true }));
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));

module.exports = function (config) {
  config = Object.assign(
    {
      port: 8585,
      auth: false,
      debug: false,
      multiLogin: true, // can the same user be connected more than once
      authTimeout: 3000,
      throttle: [50, 5000], // X number of messages per Y milliseconds.
      idleTimeout: 1000 * 60 * 60, // disconnect if nothing has come from client in x ms 1 hour default
      instanceId: process.pid + '_' + Date.now(),
      error: (_) => {},
    },
    config || {}
  );
  config.idleTimeout = Math.max(config.idleTimeout, 1000 * 60 * 5); // min 5 minute on idle timeout

  if (config.debug) console.log('Snub-ws Init', config);

  return function (snub) {
    var socketClients = new Map(); // clients connected to this instance
    socketClients.matchFn = function (searches = [], fn = (_) => {}) {
      var matches = [];
      searches.forEach((search) => {
        if (this.has(search)) {
          fn(this.get(search));
          matches.push(this.get(search));
        }
        this.forEach((socketClient) => {
          if (socketClient.state.username !== search) return;
          matches.push(socketClient);
          fn(socketClient);
        });
      });
      return matches;
    };
    socketClients.array = function () {
      var clients = [];
      this.forEach((client) => {
        clients.push(client);
      });
      return clients;
    };

    socketClients.authedClients = function (fn = (_) => {}) {
      var clients = [];
      this.forEach((client) => {
        if (!client.authenticated) return;
        fn(client);
        clients.push(client);
      });
      return clients;
    };
    var trackedClients = new Map(); // tracked clients connected to all instances
    trackedClients.array = function () {
      var clients = [];
      this.forEach((client) => {
        clients.push(client);
      });
      return clients;
    };
    var trackedInstances = new Set(); // all known snub-ws instances

    setInterval((_) => {
      if (config.debug)
        console.log(
          `Snub-Ws Interval \n` +
            `IID: ${config.instanceId}\n` +
            `Local CLients: ${socketClients.size}\n` +
            `Tracked CLients: ${trackedClients.size}\n\n`
        );
      socketClients.forEach((ws) => {
        // time to idle this connection out
        if (ws.lastMsgTime < Date.now() - config.idleTimeout) {
          wsKick(ws, 'IDLE_CONNECTION');
          return;
        }

        // send ping to connection that will soon idle out
        if (ws.lastMsgTime < Date.now() - (config.idleTimeout - 1000 * 60)) {
          wsSend(ws, '_ping', Date.now());
        }
      });
    }, config.idleTimeout / 4);

    uWS
      .App()
      .ws('/*', {
        /* Options */
        compression: config.compression
          ? uWS[config.compression]
          : uWS.SHARED_COMPRESSOR,
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: config.idleTimeout,
        /* Handlers */
        upgrade: (res, req, ctx) => {
          var obj = {
            key: req.getHeader('sec-websocket-key'),
            url: req.getUrl(),
            wsMeta: {
              url: req.getUrl(),
              origin: req.getHeader('origin'),
              host: req.getHeader('host'),
              remoteAddress:
                req.getHeader('x-forwarded-for') || req.getHeader('x-real-ip'),
              cookie: req.getHeader('cookie'),
            },
          };
          res.upgrade(
            obj,
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            ctx
          );
        },
        open: (ws) => {
          Object.assign(ws, {
            id:
              config.instanceId +
              '_' +
              ws.key.replace(/[^a-z]/gim, '') +
              '_' +
              snub.generateUID(),
            auth: {},
            channels: [],
            authenticated: false,
            connectTime: Date.now(),
            recent: [],
            lastMsgTime: Date.now(),
            metaObj: {},
          });
          Object.defineProperty(ws, 'state', {
            get: function () {
              return {
                id: ws.id,
                username: ws.auth.username,
                channels: ws.channels,
                authenticated: ws.authenticated,
                connectTime: ws.connectTime,
                remoteAddress: ws.wsMeta.remoteAddress,
                meta: ws.metaObj,
              };
            },
          });

          // socketClients.push(ws);
          socketClients.set(ws.id, ws);

          if (config.auth)
            setTimeout((_) => {
              if (!ws.authenticated) wsKick(ws, 'AUTH_TIMEOUT');
            }, config.authTimeout);
        },
        message: (ws, message, isBinary) => {
          var [event, payload, reply] = JSON.parse(
            Buffer.from(message).toString()
          );
          if (
            [
              'send-all',
              'kick-all',
              'connected-clients',
              'client-authenticated',
              'client-failedauth',
            ].includes(event)
          )
            return false;
          if (
            event.match(
              /^(send|kick|send-channel|set-meta|add-channel|set-channel|del-channel):/
            )
          )
            return false;

          ws.lastMsgTime = Date.now();
          if (event === '_auth') return wsValidateAuth(ws, payload);
          if (event === '_ping') return wsSend(ws, '_pong', payload);
          if (event === '_pong') return;

          if (config.throttle) {
            ws.recent = ws.recent.filter(
              (ts) => ts > Date.now() - config.throttle[1]
            );
            if (ws.recent.length > config.throttle[0]) {
              wsKick(ws, 'THROTTLE_LIMIT');
            }
            ws.recent.push(Date.now());
          }

          snub
            .mono('ws:' + event, {
              from: ws.state,
              payload,
              _ts: Date.now(),
            })
            .replyAt(
              reply
                ? (data) => {
                    wsSend(ws, reply, data);
                  }
                : undefined
            )
            .send((c) => {
              if (c < 1 && reply) {
                wsSend(ws, reply + ':error', {
                  error: 'Nothing was listening to this event',
                });
              }
            });
        },
        drain: (ws) => {
          // need to work out if this is useful for anything.
          // console.log('WebSocket back pressure: ' + ws.getBufferedAmount());
        },
        close: async (ws, code, message) => {
          ws.dead = true;
          ws.authenticated = false;
          snub.mono('ws:client-disconnected', ws.state).send();
          snub.poly('ws_internal:tracked-client-remove', ws.id).send();
          // wait 15 seconds before cleaning up the socket from the client list
          await justWait(15000);
          socketClients.delete(ws.id);
        },
      })
      .any('/*', (res, req) => {
        res.end('Nothing to see here!');
      })
      .listen(config.port, (token) => {
        if (token) {
          console.log('Snub WS server listening on port ' + config.port);
        } else {
          console.error(
            'Snub WS server FAILED listening on port ' + config.port
          );
        }
      });

    trackedInstances.add(config.instanceId);
    snub.on('ws_internal:tracked-instance', (i) => {
      if (i.online) return trackedInstances.add(i.instanceId);
      trackedInstances.delete(i.instanceId);
    });
    snub
      .poly('ws_internal:tracked-instance', {
        instanceId: config.instanceId,
        online: true,
      })
      .send();

    cleanUpFns.push((_) => {
      if (config.debug) console.log('Snub WS Cleanup');
      snub
        .poly('ws_internal:tracked-client-remove', [...socketClients.keys()])
        .send();
      snub
        .poly('ws_internal:tracked-instance', {
          instanceId: config.instanceId,
          online: false,
        })
        .send();
    });

    snub.on('ws_internal:tracked-client-upsert', upsertTrackedClients);

    snub.on('ws_internal:tracked-client-remove', function (clientIds) {
      if (!Array.isArray(clientIds)) clientIds = [clientIds];
      if (config.debug)
        console.log('Snub-ws remove tracked clients', clientIds);
      var clients = [];
      clientIds.forEach((clientId) => {
        if (socketClients.has(clientId))
          clients.push(
            JSON.parse(JSON.stringify(socketClients.get(clientId).state))
          );
        trackedClients.delete(clientId);
      });
      if (clients.length)
        snub.poly('ws:connected-clients-offline', clients).send();
    });

    // on launch get list of tracked clients from other instances
    snub.poly('ws_internal:tracked-client-fetch').send();

    snub.on('ws_internal:tracked-client-fetch', (_) => {
      var clientStates = socketClients
        .authedClients()
        .map((client) => client.state);
      if (clientStates.length)
        snub.poly('ws_internal:tracked-client-upsert', clientStates).send();
    });

    Object.defineProperty(snub, 'wsConnectedClients', {
      get: function () {
        return trackedClients.array();
      },
    });

    snub.on('ws:send-all', function (payload) {
      socketClients.authedClients((ws) => {
        wsSend(ws, ...payload);
      });
    });

    snub.on('ws:send:*', function (payload, n1, channel) {
      var sendTo = channel.split(':').pop().split(',');
      var [event, ePayload] = payload;
      socketClients.matchFn(sendTo, (ws) => {
        wsSend(ws, event, ePayload);
      });
    });

    snub.on('ws:send-channel:*', function (payload, n1, channel) {
      var channels = channel.split(':').pop().split(',');
      var [event, ePayload] = payload;
      socketClients.array().forEach((ws) => {
        if (channels.some((channel) => ws.state.channels.includes(channel)))
          wsSend(ws, event, ePayload);
      });
    });

    snub.on('ws:set-meta:*', function (metaObj, reply, channel) {
      Object.keys(metaObj).forEach((k) => {
        if (Array.isArray(metaObj[k])) {
          return (metaObj[k] = metaObj[k]
            .filter((i) => {
              return (
                ['number', 'string'].includes(typeof i) && String(i).length < 64
              );
            })
            .slice(0, 64));
        }
        if (
          ['number', 'string'].includes(typeof metaObj[k]) &&
          String(metaObj[k]).length > 128
        ) {
          return delete metaObj[k];
        }
        if (typeof metaObj[k] === 'object') {
          return delete metaObj[k];
        }
      });
      var idsOrUsername = channel.split(':').pop().split(',');

      var clientStates = socketClients
        .matchFn(idsOrUsername, (ws) => {
          Object.assign(ws.metaObj, metaObj);
        })
        .map((ws) => ws.state);
      if (clientStates.length)
        snub.poly('ws_internal:tracked-client-upsert', clientStates).send();
      if (clientStates.length > 0 && reply) {
        reply(clientStates);
      }
    });

    // add, set and delete channels for a client, accepts id or username
    snub.on('ws:add-channel:*', function (arrayOfChannels, reply, channel) {
      if (typeof arrayOfChannels === 'string')
        arrayOfChannels = [arrayOfChannels];

      var idsOrUsername = channel.split(':').pop().split(',');
      var clientStates = socketClients
        .matchFn(idsOrUsername, (ws) => {
          ws.channels = [...new Set([].concat(ws.channels, arrayOfChannels))];
        })
        .map((ws) => ws.state);
      if (clientStates.length)
        snub.poly('ws_internal:tracked-client-upsert', clientStates).send();
      if (clientStates.length > 0 && reply) {
        reply(clientStates);
      }
    });

    snub.on('ws:set-channel:*', function (arrayOfChannels, reply, channel) {
      if (typeof arrayOfChannels === 'string')
        arrayOfChannels = [arrayOfChannels];

      var idsOrUsername = channel.split(':').pop().split(',');
      var clientStates = socketClients
        .matchFn(idsOrUsername, (ws) => {
          ws.channels = [...new Set(arrayOfChannels)];
        })
        .map((ws) => ws.state);
      if (clientStates.length)
        snub.poly('ws_internal:tracked-client-upsert', clientStates).send();
      if (clientStates.length > 0 && reply) {
        reply(clientStates);
      }
    });

    snub.on('ws:del-channel:*', function (arrayOfChannels, reply, channel) {
      if (typeof arrayOfChannels === 'string')
        arrayOfChannels = [arrayOfChannels];

      var idsOrUsername = channel.split(':').pop().split(',');
      var clientStates = socketClients
        .matchFn(idsOrUsername, (ws) => {
          ws.channels = [
            ...new Set(
              ws.channels.filter((c) => {
                return !arrayOfChannels.includes(c);
              })
            ),
          ];
        })
        .map((ws) => ws.state);
      if (clientStates.length)
        snub.poly('ws_internal:tracked-client-upsert', clientStates).send();
      if (clientStates.length > 0 && reply) {
        reply(clientStates);
      }
    });

    snub.on('ws:kick:*', function (message, n2, channel) {
      var sendTo = channel.split(':').pop().split(',');
      socketClients.matchFn(sendTo, (ws) => {
        wsKick(ws, message);
        ws.authenticated = false;
      });
    });
    snub.on('ws:kick-all', function (message = 'kick') {
      socketClients.array().forEach((ws) => {
        wsKick(ws, message);
        ws.authenticated = false;
      });
    });

    snub.on('ws_internal:client-authenticated', function (wsState) {
      if (config.multiLogin === false) {
        socketClients.matchFn([wsState.id, wsState.username], (ws) => {
          if (ws.connectTime < wsState.connectTime)
            return wsKick(ws, 'DUPE_LOGIN');
        });
      }
    });

    snub.on('ws:connected-clients', function (clientIds, reply) {
      if (!clientIds) return reply(snub.wsConnectedClients);
      reply(
        snub.wsConnectedClients.filter(
          (c) => clientIds.includes(c.id) || clientIds.includes(c.username)
        )
      );
    });

    function upsertTrackedClients(clients) {
      if (!Array.isArray(clients)) clients = [clients];
      if (config.debug) console.log('Snub-ws tracked clients upsert', clients);
      var clientsToUpdate = [];
      clients.forEach((clientObj) => {
        if (!clientObj.authenticated) return;
        var newObj = Object.assign(
          trackedClients.get(clientObj.id) || {},
          clientObj
        );
        trackedClients.set(clientObj.id, newObj);
        if (socketClients.has(clientObj.id)) clientsToUpdate.push(newObj);
      });
      if (clientsToUpdate.length)
        snub.poly('ws:connected-clients-update', clientsToUpdate).send();
    }

    function wsValidateAuth(ws, authPayload) {
      if (config.debug) console.log('Snub-ws wsAcceptAuth', authPayload);
      if (config.auth === false) {
        return wsAcceptAuth(ws, authPayload);
      }

      if (typeof config.auth === 'string') {
        snub
          .mono(
            'ws:' + config.auth,
            Object.assign({}, authPayload, ws.wsMeta, { id: ws.id })
          )
          .replyAt((payload) => {
            if (payload === true) {
              return wsAcceptAuth(ws, authPayload);
            }
            wsDenyAuth(ws);
          })
          .send((received) => {
            if (!received) {
              wsDenyAuth(ws);
            }
          });
      }
      if (typeof config.auth === 'function') {
        config.auth(
          Object.assign({}, authPayload, ws.wsMeta, { id: this.id }),
          (res) => {
            if (res === true) return wsAcceptAuth(ws, authPayload);
            return wsDenyAuth(ws);
          }
        );
      }
    }

    function wsAcceptAuth(ws, authPayload) {
      ws.authenticated = true;
      ws.auth = authPayload;
      snub.mono('ws:client-authenticated', ws.state).send();
      snub.poly('ws_internal:client-authenticated', ws.state).send();
      if (config.debug)
        console.log('Snub WS Client Authenticated => ' + ws.state.id);

      // we want to add a delay here to allow a small window of time to kick dupe users
      setTimeout(
        (_) => {
          if (ws.state.authenticated) {
            wsSend(ws, '_acceptAuth', ws.state.id);
          }
        },
        config.multiLogin ? 0 : 200
      );
      snub.poly('ws_internal:tracked-client-upsert', ws.state).send();

      if (config.debug) console.log('Snub-ws wsAcceptAuth', ws);
    }
    function wsDenyAuth(ws) {
      ws.authenticated = false;
      wsKick(ws, 'AUTH_FAIL');
      snub.mono('ws:client-failedauth', ws.state).send();
      if (config.debug) console.log('Snub-ws wsDenyAuth');
    }

    function wsKick(ws, reason = null) {
      if (ws.dead) return;
      wsSend(ws, '_kickConnection', reason);
      ws.end(1000, reason);
      if (config.debug) console.log('Snub-ws wsKick', reason);
    }

    // send msg to client
    function wsSend(ws, event, payload) {
      if (ws.dead) return;
      var sendString = JSON.stringify([event, payload]);
      const msgHash = hashString(sendString);
      // block dupe messages going to the client within 5 seconds
      if (msgHash === ws.lastMsgHash && Date.now() - ws.lastMsgTime < 5000)
        return;
      ws.lastMsgHash = msgHash;
      ws.send(sendString);
    }
  };
};

function hashString(str) {
  let hash = 0;
  let i;
  let chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
