# Snub-WS

Middleware WS server that allows you to run web-sockets over snub.

### Usage

`npm install snub`

`npm install snub-ws`

### Basic Example

With redis installed and running with default port and no auth.

```javascript
const Snub = require('snub');
const snub = new Snub();
const SnubWS = require('snub-ws');

const snubws = new SnubWS(
  debug: true
);

snub.use(snubws);

```

### Config options

```javascript
{
  port: 8585, // Web-socket server port
  debug: true, // Bool, turns on verbose messaging.
  mutliLogin: true, // Bool, can the same username connection more than once?
  auth: 'auth-event', // String OR Function OR bool for no auth required
  authTimeout: 3000, // how long to wait for the client to auth before disconnecting
  throttle: [50, 5000], // X number of messages per Y milliseconds before disconnecting
  idleTimeout: 1000 * 60 * 60, // how long can an idle client be connected
}
```

### auth

auth can be passed of 3 things

#### Function
A function passed to auth
```javascript
{
  auth: function (auth, accept) {
    if (auth.username == 'username')
      return accept(true); // run accept to authenticate the web-socket client connection.
    accept(false); // run with false to decline the web-socket connection and disconnect the client.
  }
}
```

#### String
A string passed to auth will run the method as a snub event. Reply true or false.
```javascript
{
  auth: 'authenticate-client'
}

snub.on('ws:authenticate-client', function (auth, reply) {
  console.log(auth);
  if (auth.username == 'username')
    return reply(true);
  reply(false);
});
```

#### Boolean
A bool with false will authenticate any web-socket client connection.
```javascript
{
  auth: false
}
```