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

function auth(auth, accept) {
  if (auth.username && auth.password === 'password') return accept({
    token: '123456',
  });
  return accept(false);
}

const snubws1 = new SnubWS({
  debug: false,
  port: 8686,
  multiLogin: false,
  idleTimeout: 100,
  auth: auth,
});
const snubws2 = new SnubWS({
  debug: false,
  port: 8787,
  multiLogin: false,
  idleTimeout: 100,
  auth: auth,
  includeRaw: true,
});
const snubws3 = new SnubWS({
  debug: false,
  port: 8888,
  multiLogin: false,
  idleTimeout: 100,
  auth: auth,
});

const snubwsNA = new SnubWS({
  debug: false,
  multiLogin: true,
  idleTimeout: 100,
  auth: false,
});

const ports = [8686, 8787, 8888];

let next = 0;
function nextPort() {
  const port = ports[next];
  next = (next + 1) % ports.length; // Wrap around when reaching the end of the array
  return port;
}
snub.use(snubws1);
snub.use(snubws2);
snub.use(snubws3);
snub.use(snubwsNA);

test('Connect/Disconnect to snub-ws web socket server with basic auth', async function () {
  let didAuth = false;
  var socketClient = new Ws('ws://username:password@localhost:' + nextPort(), {
    onmessage: (e) => {
      try {
        var [key, value] = JSON.parse(e.data);
        if (key === '_acceptAuth') {
          didAuth = true;
          // console.log('Auth Accepted');
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
  var socketClient = new Ws('ws://localhost:' + nextPort(), {
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
          // console.log('Auth Accepted');
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
  var socketClient = new Ws('ws://localhost:8585', {
    onmessage: (e) => {
      try {
        var [key, value] = JSON.parse(e.data);
        if (key === '_acceptAuth') {
          didAuth = true;
          // console.log('Auth Accepted');
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

test('Bulk connections', async function () {
  let didAuth = 0;
  let sendAll = 0;
  let blockCheck = 0;
  let tokenCheck = '';

  let doubleMe = 0;

  snub.on('ws:double-me', async (event, reply) => {
    reply(event.payload * 2);
  });

  const starTrekCharacters = [
    'james-t-kirk',
    'spock',
    'leonard-mccoy',
    'nyota-uhura',
    'montgomery-scott',
    'hikaru-sulu',
    'pavel-chekov',
    'jean-luc-picard',
    'william-riker',
    'data',
    'geordi-laforge',
    'beverly-crusher',
    'deanna-troi',
    'tasha-yar',
    'wesley-crusher',
    'benjamin-sisko',
    'jadzia-dax',
    'kira-nerys',
    'jadzia-dax',
    'kira-nerys',
    'odo',
    'quark',
  ];

  const connections = new Map();

  starTrekCharacters.forEach((character) => {
    var socketClient = new Ws('ws://localhost:' + nextPort(), {
      onopen: (e) => {
        socketClient.json([
          '_auth',
          { username: character, password: 'password' },
        ]);
      },
      onmessage: (e) => {
        var [key, value] = JSON.parse(e.data);
        if (key === '_acceptAuth') {
          tokenCheck = value.token;
          didAuth++;

          socketClient.json(['double-me', 6, 'qwerty456']);
          return;
        }
        if (key === 'send-all-test') {
          sendAll++;
          return;
        }
        if (key === 'set-value') {
          socketClient.testValue = value;
          return;
        }
        if (key === 'blocked') {
          blockCheck++;
          return;
        }

        if (key === 'qwerty456') {
          doubleMe = value;
          return;
        }

        console.log('Message:', key, value);
      },
      onerror: (e) => console.warn('Error:', e),
    });
    connections.set(character, socketClient);
  });

  await justWait(200);

  expect(tokenCheck).toBe('123456');
  expect(doubleMe).toBe(12);

  // check blocked messages
  connections.get('james-t-kirk').json(['send-all', ['blocked', 'value']]);
  await justWait(200);
  expect(blockCheck).toBe(0);

  // checK if all connections are authenticated
  let trekClients = await snub
    .mono('ws:connected-clients', starTrekCharacters)
    .awaitReply();
  await justWait(200);
  expect(trekClients.length).toBe(20);

  // kick some clients
  snub.poly('ws:kick:odo,quark', 'test-kick').send();
  await justWait(500);

  // check if some clients are kicked
  trekClients = await snub
    .mono('ws:connected-clients', starTrekCharacters)
    .awaitReply();
  await justWait(200);

  expect(trekClients.length).toBe(18);

  // send all test
  snub.poly('ws:send-all', ['send-all-test', 'value']).send();
  await justWait(300);
  expect(sendAll).toBe(18);

  // test send
  snub.poly('ws:send:james-t-kirk,spock', ['set-value', 123]).send();
  await justWait(300);
  expect(connections.get('james-t-kirk').testValue).toBe(123);
  expect(connections.get('spock').testValue).toBe(123);

  snub
    .poly('ws:send-all', ['set-value', 456, ['leonard-mccoy', 'nyota-uhura']])
    .send();
  await justWait(300);
  expect(connections.get('leonard-mccoy').testValue).toBe(456);
  expect(connections.get('nyota-uhura').testValue).toBe(456);

  // test channels

  snub
    .poly('ws:add-channel:james-t-kirk,spock,leonard-mccoy,nyota-uhura', [
      'tos',
    ])
    .send();
  await justWait(300);
  snub.poly('ws:del-channel:nyota-uhura', ['tos']).send();
  snub.poly('ws:send-channel:tos', ['set-value', 789]).send();
  await justWait(300);
  expect(connections.get('leonard-mccoy').testValue).toBe(789);
  expect(connections.get('spock').testValue).toBe(789);
  expect(connections.get('james-t-kirk').testValue).toBe(789);
  expect(connections.get('nyota-uhura').testValue).toBe(456);

  const channelCheck = await snub
    .mono('ws:channel-clients', ['tos'])
    .awaitReply();
  expect(channelCheck.length).toBe(3);

  // test meta
  snub
    .poly('ws:set-meta:data,geordi-laforge,beverly-crusher,deanna-troi', {
      series: 'tng',
      starship: 'enterprise',
      likable: true,
      dead: undefined,
      episode: { total: 178, last: 176 },
    })
    .send();
  await justWait(300);

  const metaCheck = await snub
    .mono('ws:get-clients:geordi-laforge,beverly-crusher')
    .awaitReply();
  expect(metaCheck.length).toBe(2);
  expect(metaCheck[0].meta.series).toBe('tng');
  expect(metaCheck[1].meta.starship).toBe('enterprise');
  expect(metaCheck[0].meta.dead).toBe(undefined);
  expect(metaCheck[1].meta.likable).toBe(true);
  expect(metaCheck[0].meta.episode).toBe(undefined);

  // test meta new functions
  snub
    .poly('ws:set-meta', [
      {
        series: 'tos',
        starship: 'enterprise',
        likable: true,
        dead: undefined,
        episode: { total: 178, last: 176 },
      },
      [
        'james-t-kirk',
        'spock',
        'leonard-mccoy',
        'nyota-uhura',
        'montgomery-scott',
        'hikaru-sulu',
        'pavel-chekov',
      ],
    ])
    .send();
  await justWait(300);

  const metaCheck1 = await snub
    .mono('ws:get-clients', ['montgomery-scott', 'hikaru-sulu', 'pavel-chekov'])
    .awaitReply();
  expect(metaCheck1.length).toBe(3);
  expect(metaCheck1[0].meta.series).toBe('tos');
  expect(metaCheck1[1].meta.starship).toBe('enterprise');
  expect(metaCheck1[0].meta.dead).toBe(undefined);
  expect(metaCheck1[1].meta.likable).toBe(true);
  expect(metaCheck1[0].meta.episode).toBe(undefined);

 

  await justWait(200);

  // close connections from client
  connections.get('william-riker').close();
  connections.get('data').close();
  await justWait(200);
  trekClients = await snub
    .mono('ws:connected-clients', starTrekCharacters)
    .awaitReply();
  await justWait(200);

  expect(trekClients.length).toBe(16);

  expect(didAuth).toBe(22);
}, 15000);

// helper functions

function Ws(url, opts) {
  opts = {
    autoConnect: true,
    onopen: noop,
    onmessage: noop,
    onreconnect: noop,
    onmaximum: noop,
    onclose: noop,
    onerror: noop,
    ...opts,
  };

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
      // console.log('ws-open');
      (opts.onopen || noop)(e);
      num = 0;
    };

    ws.onclose = function (e) {
      if (e.code === 3000) return; // unauthorized
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
    console.log('Reconnecting...', e);
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
  function noop() {}
}

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
