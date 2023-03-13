const Snub = require('snub');
const SnubWS = require('./snub-ws.js');
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
  auth: function (auth, accept) {
    if (auth.username === 'username' && auth.password === 'password')
      return accept(true);
  },
});

const snubwsNA = new SnubWS({
  debug: true,
  port: 8686,
  mutliLogin: true,
  idleTimeout: 100,
  auth: false,
});

snub.use(snubws);
snub.use(snubwsNA);

test('Connect/Disconnect to snub-ws web socket server with basic auth', async function () {
  let didAuth = false;
  var socketClient = new Ws('ws://username:password@localhost:8585', {
    autoConnect: true,
    onopen: (e) => {},
    onmessage: (e) => {
      try {
        var [key, value] = JSON.parse(e.data);
        if (key === '_acceptAuth') {
          didAuth = true;
          console.log('Auth Accepted');
        }
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
  await justWait(1000);
  expect(didAuth).toBe(true);
}, 10000);

test('Connect/Disconnect to snub-ws web socket server with socket auth', async function () {
  let didAuth = false;
  var socketClient = new Ws('ws://localhost:8585', {
    autoConnect: true,
    onopen: (e) => {
      socketClient.json([
        '_auth',
        { username: 'username', password: 'password' },
      ]);
    },
    onmessage: (e) => {
      try {
        var [key, value] = JSON.parse(e.data);
        if (key === '_acceptAuth') {
          didAuth = true;
          console.log('Auth Accepted');
        }
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
  await justWait(1000);
  expect(didAuth).toBe(true);
}, 10000);

test('Connect/Disconnect to snub-ws web socket server with no auth', async function () {
  let didAuth = false;
  var socketClient = new Ws('ws://localhost:8686', {
    autoConnect: true,
    onopen: (e) => {
      console.log('!!!! WSOPEN');
    },
    onmessage: (e) => {
      try {
        var [key, value] = JSON.parse(e.data);
        console.log('!!!!!!!', key, value);
        if (key === '_acceptAuth') {
          didAuth = true;
          console.log('Auth Accepted');
        }
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
  await justWait(1000);
  console.log('!!!!!!!', socketClient);
  expect(didAuth).toBe(true);
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
