const Snub = require('snub');
const SnubWS = require('../snub-ws.js');
const WebSocket = require('ws');
var snub = new Snub({
  host: 'localhost',
  password: '',
  db: 8,
  timeout: 10000,
  intercepter: async (payload, reply, listener, channel) => {
    if (listener === 'test-intercept-block') return false;
    if (listener === 'test-intercept-mono')
      payload.intercept = payload.intercept * 2;
    return true;
  },
});

const snubws = new SnubWS({
  debug: true,
  mutliLogin: true,
  idleTimeout: 100,
  auth:
    'authenticate-client' ||
    function (auth, accept, deny) {
      if (auth.username == 'username') return accept();
      deny();
    },
});

snub.use(snubws);

test('Connect/Disconnect to snub-ws web socket server', async function () {
  var currentWs = new Ws('ws://username:password@localhost:8585', {
    autoConnect: true,
    onopen: (e) => {
      console.log('SnubSocket Connected');
      currentWs.json(['_auth', { username: 'username' }]);
    },
    onmessage: (e) => {
      try {
        var [key, value] = JSON.parse(e.data);
        // handle the auth check
        if (key === '_ping')
          // && Math.random() > 0.5
          return currentWs.json(['_pong']);
        if (key === '_pong') return pingCheck();
        if (key === '_acceptAuth') {
          console.log('Auth Accepted');

          currentWs.json([
            'my-state',
            { username: 'username' },
            'r' + Date.now(),
          ]);
          return;
        }

        console.log('Message', key, value);
      } catch (error) {
        console.error(error);
      }
    },
    onreconnect: (e) => console.log('Reconnecting...', e),
    onmaximum: (e) => console.log('Stop Attempting!', e),
    onclose: (e) => {
      console.log('socket closed');
    },
    onerror: (e) => console.warn('Error:', e),
  });

  // var awaitReplyNoList = false;
  // try {
  //   await snub.mono('test-listener-mono-no-listener', 'junk').awaitReply();
  // } catch (error) {
  //   awaitReplyNoList = true;
  // }
  // await justWait(250);
  // expect(awaitReplyNoList).toBe(true);
  // // expect(checkReplyAwait).toBe(random * 5);
}, 10000);

function Ws(url, opts) {
  opts = opts || {};

  var ws;
  var num = 0;
  var $ = {
    hash: Math.random(),
  };
  var max = opts.maxAttempts || Infinity;
  $.open = function () {
    try {
      ws.close(1000);
      ws = undefined;
    } catch (error) {}
    ws = new WebSocket(url, opts.protocols || []);
    $.ws = ws;

    ws.onmessage = opts.onmessage || noop;

    ws.onopen = function (e) {
      console.log('ws-open');
      (opts.onopen || noop)(e);
      num = 0;
    };

    ws.onclose = function (e) {
      if (e.code === 1005) return;
      // https://github.com/Luka967/websocket-close-codes
      // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
      e.code === 1000 || e.code === 1001 || $.reconnect(e);
      if (e.code === 1000 && e.reason === 'IDLE_TIMEOUT') $.reconnect(e);
      (opts.onclose || noop)(e);
    };

    ws.onerror = function (e) {
      e && e.code === 'ECONNREFUSED'
        ? $.reconnect(e)
        : (opts.onerror || noop)(e);
    };
  };

  $.reconnect = function (e) {
    if (num++ < max) {
      setTimeout(
        function () {
          (opts.onreconnect || noop)(e);
          $.open();
        },
        num === 1 ? 1 : (opts.timeout || 500) * (num - 1)
      );
    } else {
      (opts.onmaximum || noop)(e);
    }
  };

  $.readyState = function () {
    return ws.readyState;
  };

  $.json = function (x) {
    ws.send(JSON.stringify(x));
  };

  $.send = function (x) {
    ws.send(x);
  };

  $.close = function (x, y) {
    ws.close(x || 1e3, y);
    ws.onmessage = noop;
    ws.onopen = noop;
    ws.onerror = noop;
  };

  if (opts.autoConnect) $.open(); // init

  return $;
}

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
