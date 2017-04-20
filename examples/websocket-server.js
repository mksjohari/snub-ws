const Snub = require('snub');
const snub = new Snub({
  debug: false
});
const SnubWS = require('../snub-ws.js');

const snubws = new SnubWS({
  debug: true,
  mutliLogin: false,
  auth: function (auth, accept, deny) {
    if (auth.username == 'username') return accept();
    deny();
  }
});

snub.use(snubws);

// snub.on('ws:*', function () {
//   console.log(arguments);
// });

snub.on('ws:client-authenticated', function (payload) {
  // we can send a message to a single user.
  // this will work with polly but every snub instance will send the message to the client, not alway desired.
  console.log('got Authed user data=> ' + process.pid + ' - ' + JSON.stringify(payload));
  snub.poly('ws:send:' + payload.id, ['hello', 'yay! you authenticated']).send();
});

snub.on('ws:do-math', function (event, reply) {
  // if the event for the client is expecting a reply we can do so.
  if (typeof reply == 'function')
    reply(process.pid + '=' + event.payload.reduce((p, c) => {
      return (p + c);
    }, 0));
});

snub.on('ws:whos-online', function (event, reply) {
  var c = [];
  setTimeout(() => {
    reply(c.map(cu => cu.id));
  }, 2000);
  snub.poly('ws:connected-clients').replyAt(connected => {
    c = c.concat(connected);
  }).send();
});


// create a basic http server to serve up client files.
const http = require('http');
const fs = require('fs');
const path = require('path');

http.createServer(function (request, response) {
  switch (request.url) {
    case '/':
      fs.readFile(path.dirname(__filename) + '/client.html', function (error, content) {
        response.writeHead(200, {
          'Content-Type': 'text/html'
        });
        response.end(content, 'utf-8');
      });
      break;
    case '/snub-ws-client.js':
      fs.readFile(path.dirname(__filename) + '/../snub-ws-client.js', function (error, content) {
        response.writeHead(200, {
          'Content-Type': 'text/javascript'
        });
        response.end(content, 'utf-8');
      });
      break;

    default:
      response.writeHead(404);
      response.end();
      break;
  }
}).listen(8686);