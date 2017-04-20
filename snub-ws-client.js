var snubWs = function (path, config) {
  path = path || location.origin.replace(/(http|https)\:\/\//i, 'ws://');

  config = config || {};

  config = Object.assign({
    auth: {
      username: null,
      password: null
    },
    initConnect: true,
    autoReconnect: true
  }, config || {});

  if (path.includes('@')) {
    var authString = path.split('@').shift().replace('ws://', '');
    var [user, pass] = authString.split(':');
    config.auth.username = user;
    config.auth.password = pass;
  }

  var autoReconnect = config.autoReconnect;
  var connectionAttemps = 0;
  this.id = null;
  this.metadata = null;
  var connection;
  if (config.initConnect !== false)
    connect.apply(this);
  var eventsRegister = [];
  this.eventsRegister = function () {
    return eventsRegister;
  };

  Object.defineProperty(this, 'connected', {
    get: function () {
      return (connection.readyState === 1);
    }
  });

  this.on = function (ievent, cb, once) {
    if (typeof cb != 'function') return;
    var [event, namespace] = ievent.split('.');
    eventsRegister.push({
      event: event,
      regex: new RegExp('^' + event.replace('*', '.+') + '$'),
      namespace: namespace,
      func: cb,
      once: once
    });
  };
  this.off = function (ievent) {
    var [event, namespace] = ievent.split('.');
    eventsRegister
      .filter(e => (e.event == event && e.namespace == namespace))
      .map(v => eventsRegister.findIndex(f => f == v))
      .reverse().forEach(i => eventsRegister.splice(i, 1));
  };

  // trigger function for all events
  var trigger = (event, data) => {
    data = data || [null];
    eventsRegister
      .filter(e => event.match(e.regex))
      .forEach(e => {
        e.func(...data, event, e.event + (e.namespace ? '.' + e.namespace : ''));
        if (e.once)
          this.off(e.event + (e.namespace ? '.' + e.namespace : ''));
      });
  };

  this.connect = connect.bind(config);
  this.close = function () {
    autoReconnect = false;
    connection.close();
  };

  this.send = function (event, payload, reply) {
    if (connection && connection.readyState <= 1) {
      var replyId = false
      if (typeof reply == 'function') {
        replyId = '_reply:' + generateUID();
        this.on(replyId, reply, true);
      }
      return connection.send(JSON.stringify([event, payload, replyId]));
    }
    trigger('error', ['connection state is not ready']);
  };

  function connect() {
    if (connection && connection.readyState <= 1)
      return console.warn('Websocket state already active.', connection);
    connection = new WebSocket(path);
    connection.onopen = function () {
      connectionAttemps = 0;
      connection.send(JSON.stringify(['_auth', config.auth]));
    };
    connection.onclose = function () {
      trigger('disconnected');
      connectionAttemps++;
      setTimeout(() => {
        if (autoReconnect)
          connect.apply(this);
      }, 500 * connectionAttemps);
    };
    connection.onerror = function (error) {
      trigger('error', [error]);
    };
    window.addEventListener("beforeunload", () => {
      connection.close();
    });
    var libReserved = {
      _acceptAuth: (data) => {
        this.id = data.id;
        this.metadata = data.metadata;

        trigger('connect', [data]);
        connectionAttemps = 0;
      },
      _kickConnection: data => {
        autoReconnect = false;
        trigger('error', [data]);
        connectionAttemps = 0;
        return;
      }
    };
    connection.onmessage = function (e, block) {
      var event, data;
      try {
        [event, data] = JSON.parse(e.data);
      } catch (err) {
        console.warn(err, e);
      }
      if (typeof libReserved[event] == 'function')
        return libReserved[event].apply(this, [data]);
      trigger(event, [data]);
    };
  }

  function generateUID() {
    var firstPart = (Math.random() * 46656) | 0;
    var secondPart = (Math.random() * 46656) | 0;
    firstPart = ('000' + firstPart.toString(36)).slice(-3);
    secondPart = ('000' + secondPart.toString(36)).slice(-3);
    return firstPart + secondPart;
  }
};

(function () {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = snubWs;
  } else {
    window.snubWs = snubWs;
  }
})();