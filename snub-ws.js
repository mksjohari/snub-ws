const querystring = require('querystring');
const url = require('url');
const uws = require('uws');

module.exports = function (config) {
  config = Object.assign({
    port: 8585,
    auth: function (auth, accept, deny) {
      accept();
    },
    debug: false,
    mutliLogin: true
  }, config || {});

  return function (snub) {

    var WebSocketServer = uws.Server;
    var wss = new WebSocketServer({
      port: config.port
    }, () => {
      if (config.debug)
        console.log('Snub WS server listening on port ' + config.port);
    });
    var clients = [];

    wss.on('connection', (ws) => {
      var clientConn = new clientConnection(ws, config.auth);
      clients.push(clientConn);
      if (config.debug)
        console.log('Snub WS Client Connected => ' + clientConn.id);
      snub.mono('ws:client-connected', clientConn.state).send();
      snub.poly('ws_internal:client-connected', clientConn.state).send();
    });

    snub.on('ws:broadcast', function (payload) {
      clients.forEach(client => {
        client.send(...payload);
      });
    });

    snub.on('ws:send:*', function (payload, ni, channel) {
      var sendTo = channel.split(':').pop().split(',');
      var [event, ePayload] = payload;
      clients.filter(client => {
        if (sendTo.includes(client.state.id) || sendTo.includes(client.auth.username))
          return true;
        return false;
      }).forEach(client => {
        client.send(event, ePayload);
      });
    });

    snub.on('ws_internal:client-authenticated', function (connectedClient) {
      // if mutliLogin is on then we need to kick other clients with the same username.
      if (config.mutliLogin === false)
        clients.filter(client => {
          if (client.state.auth && client.state.auth.username == connectedClient.auth.username && client.state.id != connectedClient.id)
            return true;
          return false;
        }).forEach(client => {
          client.kick('Duplicate Login');
        });
    });

    snub.on('ws_internal:client-disconnected', function (s) {
      var fi = clients.findIndex(c => c.id == s.id);
      if (fi > -1)
        clients.splice(fi);
    });

    snub.on('ws:connected-clients', function (nil, reply, channel) {
      reply(clients.map(c => {
        return c.state;
      }));
    });

    function generateUID() {
      var firstPart = (Math.random() * 46656) | 0;
      var secondPart = (Math.random() * 46656) | 0;
      firstPart = ('000' + firstPart.toString(36)).slice(-3);
      secondPart = ('000' + secondPart.toString(36)).slice(-3);
      return firstPart + secondPart;
    }

    function clientConnection(ws, authFunction) {
      var upgradeUrl = url.parse(ws.upgradeReq.url);

      Object.assign(this, {
        id: process.pid + '-' + generateUID(),
        auth: {},
        socket: ws,
        connected: true,
        authenticated: false
      });

      Object.defineProperty(this, 'state', {
        get: function () {
          return {
            id: this.id,
            auth: this.auth,
            connected: this.connected,
            authenticated: this.authenticated
          };
        }
      });

      this.send = function (event, payload) {
        if ((this.connected && this.authenticated) || event == '_kickConnection')
          ws.send(JSON.stringify([event, payload]));
      };

      this.close = function () {
        ws.close();
      };

      this.kick = (reason) => {
        this.send('_kickConnection', reason || null);
        setTimeout(this.close, 100);
        if (config.debug)
          console.log('Snub WS Client Kicked [' + reason + '] => ' + this.state.id);
      };

      var authTimeout;
      var acceptAuth = () => {
        this.authenticated = true;
        this.send('_acceptAuth', this.state);
        snub.mono('ws:client-authenticated', this.state).send();
        snub.poly('ws_internal:client-authenticated', this.state).send();
        if (config.debug)
          console.log('Snub WS Client Authenticated => ' + this.state.id);
        clearTimeout(authTimeout);
      };
      var denyAuth = () => {
        this.kick('Authenication failed');
        setTimeout(this.close, 100);
        snub.mono('ws:client-failedauth', this.state).send();
        if (config.debug)
          console.log('Snub WS Client Rejected Auth => ' + this.state.id);
        clearTimeout(authTimeout);
      };

      var libReserved = {
        _auth: (data) => {
          this.auth = data || {};
          authTimeout = setTimeout(() => {
            this.kick('Authenication timeout');
          }, 3000);
          authFunction(data, acceptAuth, denyAuth);
        }
      };

      ws.on('message', e => {
        try {
          var [event, data, reply] = JSON.parse(e);

          //block client messages
          if (['broadcast', 'connected-clients'].includes(event) || event.match(/^send\:/))
            return false;

          if (typeof libReserved[event] == 'function') {
            return libReserved[event](data);
          }
          if (!this.authenticated) return;
          snub.mono('ws:' + event, {
              from: {
                id: this.id,
                user: this.auth.username
              },
              payload: data
            })
            .replyAt((reply ? data => {
              this.send(reply, data);
            } : undefined))
            .send();
        } catch (err) {
          console.log(err);
        }
      });

      ws.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        snub.mono('ws:client-disconnected', this.state).send();
        snub.poly('ws_internal:client-disconnected', this.state).send();
      });
    }
  };


};