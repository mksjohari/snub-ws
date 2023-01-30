const Snub = require('snub');
const snub = new Snub({
  debug: true,
});
const SnubWS = require('../snub-ws.js');

const snubws = new SnubWS({
  debug: false,
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

// snub.on('ws:*', function () {
//   console.log(arguments);
// });

snub.on('ws:authenticate-client', function (auth, reply) {
  // console.log(auth);
  if (auth.username == 'username') return reply(true);
  reply(false);
});

snub.on('ws:client-authenticated', function (payload) {
  // we can send a message to a single user.
  // this will work with polly but every snub instance will send the message to the client, not alway desired.
  // console.log(
  //   'got Authed user data=> ' + process.pid + ' - ' + JSON.stringify(payload)
  // );
  snub
    .poly('ws:send:' + payload.id, ['hello', 'yay! you authenticated'])
    .send();
});

snub.on('ws:my-state', function (event, reply) {
  console.log('my-state', event);
  // if the event for the client is expecting a reply we can do so.
  reply(event.from);
});

snub.on('ws:command', function (event, reply) {
  console.log('command', event.payload);
  if (event.payload.command === 'set-channels') {
    console.log('setting channels', event.from.id, event.payload.channels);
    snub.poly('ws:set-channel:' + event.from.id, event.payload.channels).send();
  }
  if (event.payload.command === 'send-all') {
    snub.poly('ws:send-all', ['derp', { a: 1 }]).send();
  }
  if (event.payload.command === 'add-channels') {
    console.log('adding channels', event.from.id, event.payload.channels);
    snub.poly('ws:add-channel:' + event.from.id, event.payload.channels).send();
  }

  if (event.payload.command === 'del-channels') {
    console.log('deleting channels', event.from.id, event.payload.channels);
    snub.poly('ws:del-channel:' + event.from.id, event.payload.channels).send();
  }

  if (event.payload.command === 'set-meta') {
    console.log('setting meta', event.from.id, event.payload.meta);
    snub.poly('ws:set-meta:' + event.from.id, event.payload.meta).send();
  }

  // reply(event.from);
});

snub.on('ws:connected-clients-update', async (clients) => {
  console.log('!!!UPDATE', clients);
});

var dcTotal = 0;
snub.on('ws:connected-clients-offline', async (clients) => {
  dcTotal += clients.length;
  console.log('DCTOTAL: ', dcTotal);
});

snub.on('ws:broadcast', function (event) {
  snub
    .poly('ws:get-client', event.from.id)
    .replyAt((userInfo) => {
      console.log(userInfo);
    })
    .send();

  snub
    .poly('ws:add-channel:' + event.from.id, 'channel1')
    .replyAt((user) => {
      console.log('ADD USER CHANNEL=>', user);

      snub
        .poly('ws:set-channel:' + event.from.id, ['channel2', 'channel3'])
        .replyAt((user) => {
          console.log('SET USER CHANNEL=>', user);

          snub
            .poly('ws:del-channel:' + event.from.id, 'channel2')
            .replyAt((user) => {
              console.log('DEL USER CHANNEL=>', user);

              snub
                .poly('ws:send-channel:channel3', [
                  'channel3',
                  'channel3 message',
                ])
                .send();
            })
            .send();
        })
        .send();
    })
    .send();

  snub.poly('ws:send-all', ['hull0', 'derka?']).send();
});

snub.on('ws:whos-online', function (event, reply) {
  console.log('whos online!!');

  snub
    .mono('ws:connected-clients')
    .replyAt((connected) => {
      console.log('connected', connected);
      reply(connected);
    }, 6000)
    .send((listenCount) => {
      console.log('Listen count', listenCount);
    });
});

// create a basic http server to serve up client files.
const http = require('http');
const fs = require('fs');
const path = require('path');

http
  .createServer(function (request, response) {
    switch (request.url) {
      case '/':
        fs.readFile(
          path.dirname(__filename) + '/client.html',
          function (error, content) {
            response.writeHead(200, {
              'Content-Type': 'text/html',
            });
            response.end(content, 'utf-8');
          }
        );
        break;
      case '/snub-ws-client.js':
        console.log(path.dirname(__filename) + '/../../dist/snub-ws-client.js');
        fs.readFile(
          path.dirname(__filename) +
            '/../../snub-ws-client/dist/snub-ws-client.es.js',
          function (error, content) {
            response.writeHead(200, {
              'Content-Type': 'text/javascript',
            });
            response.end(content, 'utf-8');
          }
        );
        break;

      default:
        response.writeHead(404);
        response.end();
        break;
    }
  })
  .listen(8686);
