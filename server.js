var express = require('express');
var app = express.createServer();
var http = require('http');
var crypto = require('crypto');
var fs = require('fs');
var url = require('url');
var child_process = require('child_process');
var Data = require('./lib/data/data');
var _ = require('underscore');
var CouchClient = require('./lib/data/lib/couch-client');
var async = require('async');

var Document = require('./src/server/document');
var Network = require('./src/server/network');
var User = require('./src/server/user');
var Util = require('./src/server/util');
var Filters = require('./src/server/filters');
var Search = require('./src/server/search');
var HTMLRenderer = require('./src/server/renderers/html_renderer');

var nodemailer = require('nodemailer');
nodemailer.sendmail = true;

// Google Analytics (TODO: move somewhere else)
var gaScript = '';

// App Config
global.config = JSON.parse(fs.readFileSync(__dirname+ '/config.json', 'utf-8'));
global.seed = JSON.parse(fs.readFileSync(__dirname+ '/db/schema.json', 'utf-8'));

// App Settings
global.settings = JSON.parse(fs.readFileSync(__dirname+ '/settings.json', 'utf-8'));
global.db = CouchClient(config.couchdb_url);


var VALIDATE_EMAIL = new RegExp("^(([^<>()[\\]\\\\.,;:\\s@\\\"]+(\\.[^<>()[\\]\\\\.,;:\\s@\\\"]+)*)|(\\\".+\\\"))@((\\[[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\])|(([a-zA-Z\\-0-9]+\\.)+[a-zA-Z]{2,}))$");

// Express.js Configuration
// -----------

app.configure(function() {
  var CookieStore = require('cookie-sessions');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(CookieStore({secret: config.secret}));
  app.use(app.router);
  app.use(express.static(__dirname+"/public", { maxAge: 41 }));
  app.use(express.static(__dirname+"/test", { maxAge: 41 }));
  app.use(express.static(__dirname+"/src", { maxAge: 41 }));
  app.use(express.logger({ format: ':method :url' }));
});


function urlToHttpOptions(u) {
  var fragments = url.parse(u);
  return {
    host: fragments.hostname,
    port: fragments.port,
    path: fragments.pathname + (fragments.search || '')
  };
}

function postToLetterpress (path, data, callback) {
  var postData = JSON.stringify(data);
  var postOptions = _.extend(urlToHttpOptions(config.letterpress_url+path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  });
  
  var req = http.request(postOptions, callback);
  req.write(postData);
  req.end();
}

function letterpress (graph, id, format, response) {
  postToLetterpress('/convert', {
    format: format,
    graph: graph,
    id: id
  }, function (res) {
    response.writeHead(res.statusCode, res.headers);
    res.pipe(response);
  });
}

function parse (format, text, response) {
  postToLetterpress('/parse', {
    format: format,
    text: text
  }, function (res) {
    response.writeHead(res.statusCode, res.headers);
    res.pipe(response);
  });
}


app.use(function(req, res) {
  if (req.url === '/test') {
    var testTemplate = fs.readFileSync(__dirname + '/layouts/test.html', 'utf-8');
    res.send(testTemplate.replace('{{{{seed}}}}', JSON.stringify(seed))
                         .replace('{{{{templates}}}}', JSON.stringify(templates()))
                         .replace('{{{{config}}}}', JSON.stringify(clientConfig())));
    return;
  }
  
  var path = url.parse(req.url).pathname
  var fragments = path.split('/');
  
  var username = fragments[1];
  var docname = fragments[2] ? fragments[2].split('.')[0] : null;
  var format = fragments[2] ? fragments[2].split('.')[1] : null;
  var version = fragments[3]; // version
  
  if (username && docname && (req.headers["user-agent"].indexOf('bot.html')>=0 || req.query.static || format)) {

    Document.get(username, docname, version, req.session ? req.session.username : null, function(err, nodes, id, authorized, version, published) {
      if (err) return res.send(err);

      if (format) {
        if (format === "json") return res.json({status: "ok", graph: nodes, id: id, authorized: authorized, version: version, published: published });
        letterpress(nodes, id, format, res);
      } else {
        var graph = new Data.Graph(seed);
        graph.merge(nodes);
        html = fs.readFileSync(__dirname+ '/layouts/doc.html', 'utf-8');
        var content = new HTMLRenderer(graph.get(id)).render();
        res.send(html.replace('{{{{document}}}}', content));
      }
    });
  } else {
    // A modern web-client is talking - Serve the app
    serveStartpage(req, res);
  }
});

app.enable("jsonp callback");

function serveStartpage(req, res) {
  html = fs.readFileSync(__dirname+ '/layouts/app.html', 'utf-8');
  req.session = req.session ? req.session : {username: null};

  function serve() {
    getNotifications(req.session.username, function(err, notifications) {
      var sessionSeed = _.extend(_.clone(seed), notifications);
      res.send(html.replace('{{{{seed}}}}', JSON.stringify(sessionSeed))
                   .replace('{{{{session}}}}', JSON.stringify(req.session))
                   .replace('{{{{config}}}}', JSON.stringify(clientConfig()))
                   .replace('{{{{ga}}}}', gaScript)
                   .replace('{{{{scripts}}}}', JSON.stringify(scripts()))
                   .replace('{{{{templates}}}}', JSON.stringify(templates())));
    });
  }
  
  // update session seed every time!
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  
  if (req.session.username) {
    graph.fetch({_id: "/user/"+req.session.username}, function(err, nodes) {
      req.session.seed = nodes.toJSON();
      serve();
    });
  } else {
    serve();
  }
}

function findAttributes(member, searchstr, callback) {
  db.view('substance/attributes', {key: member}, function(err, res) {
    if (err) {
      callback(err);
    } else {
      var result = {};
      var count = 0;
      _.each(res.rows, function(row) {
        if (row.value.name && row.value.name.match(new RegExp("("+searchstr+")", "i"))) {
          // Add to result set
          if (count < 50) { // 200 Attributes at the most
            count += 1;
            result[row.value._id] = row.value;
          }
        }
      });
      callback(null, result);
    }
  });
}

function getNotifications(username, callback) {
  // Read in reversed order, therefore replaced startkey with endkey
  if (!username) return callback(null, {});
  db.view('substance/notifications', {endkey: ["/user/"+username], startkey: ["/user/"+username, {}], descending: true, limit: 5}, function(err, res) {
    if (err) return callback(err);
    var result = {};
    async.forEach(res.rows, function(row, callback) {
      // Fetch corresponding event
      db.get(row.value.event, function(err, event) {
        if (err) return callback();
        result[row.value._id] = row.value;
        result[event._id] = event;
        callback();
      });
      
    }, function(err) {
      callback(null, result);
    });
  });
}

var graph = new Data.Graph(seed);
graph.connect('couch', {
  url: config.couchdb_url,
  filters: [
    Filters.ensureAuthorized(),
    Filters.sanitizeUserInput(),
    Filters.logEvents()
  ]
});

// Serve Data.js backend along with an express server
graph.serve(app);

// Helpers
// -----------

var Helpers = {};

var encryptPassword = function (password) {
  var hash = crypto.createHash('sha256');
  hash.update(password);
  return hash.digest('hex');
}

// Layouts for the moment are recompiled every time
_.renderTemplate = function(tpl, view, helpers) {
  var source = fs.readFileSync(__dirname+ '/layouts/' + tpl + '.html', 'utf-8');
  var template = Handlebars.compile(source);
  return template(view, helpers || {});
};

_.escapeHTML = function(string) {
  return string.replace(/&(?!\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};


function clientConfig() {
  return {
    "letterpress_url": config.letterpress_url,
    "transloadit": {
      "image": _.escapeHTML(JSON.stringify(config.transloadit.image)),
      "document_cover": _.escapeHTML(JSON.stringify(config.transloadit.document_cover)),
      "network_cover": _.escapeHTML(JSON.stringify(config.transloadit.network_cover))
    }
  };
}

function isProduction () {
  return process.env.NODE_ENV === 'production';
}

function scripts() {
  if (isProduction()) {
    return settings.scripts.production;
  } else {
    return settings.scripts.development.concat(settings.scripts.source);
  }
}

function loadTemplates() {
  var tpls = {};
  var files = fs.readdirSync(__dirname + '/templates');
  _.each(files, function (file) {
    var name    = file.replace(/\.ejs$/, '')
    ,   content = fs.readFileSync(__dirname + '/templates/' + file, 'utf-8');
    tpls[name] = content;
  });
  return tpls;
}

var styles;
function loadStyles(callback) {
  if (isProduction() && styles) return callback(styles);
  
  var mainFile = __dirname + '/styles/main.less';
  child_process.exec('lessc ' + mainFile, function (error, stdout, stderr) {
    if (error) {
      styles = '/* An error occurred: ' + stderr + ' */';
      console.log(stderr);
    } else {
      styles = stdout;
    }
    callback(styles);
  });
}


var templates = isProduction()
              ? _.once(loadTemplates)
              : loadTemplates;


// Web server
// -----------

// Convenience for allowing CORS on routes - GET only
app.all('*', function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*'); 
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS'); 
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/styles.css', function(req, res) {
  res.writeHead(200, {'Content-Type': 'text/css'});
  loadStyles(function(css) {
    res.write(css);
    res.end();
  });
});

app.get('/sitemap.xml', function(req, res) {
 Document.recent(3000, '', function(err, nodes, count) {
   res.writeHead(200, {'Content-Type': 'text/plain'});
   _.each(nodes, function(n) {
     if (_.include(n.type, '/type/document')) {
       res.write(config.server_url+"/"+n.creator.split('/')[2]+"/"+n.name+"\n");
     }
   });
   res.end();
 });
});

app.get('/fulltextsearch', function (req, res) {
  var searchstr = req.query.q;
  Search.search(searchstr, function (err, results) {
    res.json(results);
  });
});

// Find documents by search string or user
app.get('/documents/search/:type/:search_str', function (req, res) {
  var username = req.session ? req.session.username : null;
  if (req.params.type === 'recent') {
    Document.recent(req.params.search_str, username, function (err, graph, count) {
      res.json({graph: graph, count: count});
    });
  } else if (req.params.type === 'subscribed') {
    Document.subscribed(username, function (err, graph, count) {
      res.json({graph: graph, count: count});
    });
  } else {
    Document.find(req.params.search_str, req.params.type, username, function (err, graph, count) {
      res.json({graph: graph, count: count});
    });
  }
});

app.get('/documents/:user', function (req, res) {
  Document.user(req.params.user, function (err, graph, count) {
    res.json({graph: graph, count: count});
  });
});


app.get('/dashboard.json', function (req, res) {
  if (!req.session) {
    res.json({ error: "Not logged in" });
    return;
  }
  var username = req.session.username;
  Document.dashboard(username, function (err, graph, count, bins) {
    res.json({ graph: graph, count: count, bins: bins });
  });
});


app.post('/network/:network/join', function(req, res) {
  Network.join(req.params.network, req.session.username, function(err) {
    if (err) return res.json({status: "error"});
    res.json({status: "ok"});
  });
});


app.put('/network/:network/leave', function(req, res) {
  console.log('leaving network...');
  Network.leave(req.params.network, req.session.username, function(err) {
    if (err) return res.json({status: "error"});
    res.json({status: "ok"});
  });
});


app.get('/network/:network.json', function(req, res) {
  Network.get(req.params.network, req.session.username, function(err, data) {
    if (err) return res.json({status: "error", error: err});
    res.json(_.extend(data, {status: "ok"}));
  });
});

app.post('/login', function(req, res) {
  var username = req.body.username.toLowerCase(),
      password = req.body.password;
  
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  graph.fetch({_id: '/user/'+username}, function(err, nodes) {
    if (!err && nodes.length > 0) {
      var user = nodes.first();
      if (user && username === user.get('username').toLowerCase() && encryptPassword(password) === user.get('password')) {
        var seed = {};
        seed[user._id] = user.toJSON();
        delete seed[user._id].password;
        
        // TODO: Include notifications
        getNotifications(username, function(err, notifications) {
          req.session = {
            username: username.toLowerCase(),
            seed: seed
          };
          res.send({
            status: "ok",
            username: username,
            seed: _.extend(_.clone(seed), notifications)
          });
        });
      } else {
        res.send({status: "error"});
      }
    } else {
      res.send({status: "error"});
    }
  });
});


// Logout

app.post('/logout', function(req, res) {
  req.session = {};
  res.send({status: "ok"});
});

// Register user

app.post('/register', function(req, res) {
  var username = req.body.username,
      password = req.body.password,
      email = req.body.email,
      name = req.body.name;
  
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  if (!username || username.length === 0) {
    return res.send({"status": "error", "field": "username", "message": "Please choose a username."});
  }
  
  db.view('substance/users', {key: username.toLowerCase()}, function(err, result) {
    if (err) return res.send({"status": "error", "field": "all", "message": "Unknown error."});
    if (result.rows.length > 0) return res.send({"status": "error", "field": "username", "message": "Username is already taken."});
    
    var user = graph.set('/user/'+username.toLowerCase(), {
      type: '/type/user',
      username: username,
      name: name,
      email: email,
      password: encryptPassword(password),
      created_at: new Date()
    });
    
    if (user.validate() && password.length >= 3) {
      graph.sync(function(err) {
        if (!err) {
          var seed = {};
          seed[user._id] = user.toJSON();
          delete seed[user._id].password;
          req.session = {
            username: username.toLowerCase(),
            seed: seed
          };
          res.send({
            status: "ok",
            username: username.toLowerCase(),
            seed: seed
          });
        } else {
          return res.send({"status": "error", "field": "all", "message": "Unknown error."});
        }
      });
    } else {
      console.log(user.errors);
      return res.send({"status": "error", "errors": user.errors, "field": "all", "message": "Some field values are invalid. Please check your input."});
    }
  });
});

app.post('/updateuser', function(req, res) {
  var username = req.body.username;
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  graph.fetch({type: '/type/user'}, function(err) {
    var user = graph.get('/user/'+username);
    if (!user) return res.send({"status": "error"});
    
    user.set({
      name: req.body.name,
      email: req.body.email,
      website: req.body.website,
      company: req.body.company,
      location: req.body.location
    });
    
    // Change password
    if (req.body.password) {
      user.set({
        password: encryptPassword(req.body.password)
      });
    }
    if (user.validate()) {
      graph.sync(function(err) {
        if (!err) {
          var seed = {};
          seed[user._id] = user.toJSON();
          delete seed[user._id].password;
          res.send({
            status: "ok",
            username: username,
            seed: seed
          });
          req.session.username = username;
          req.session.seed = seed;
        } else {
          return res.send({"status": "error"});
        }
      });
    } else return res.send({"status": "error", "message": "Not valid", "errors": user.errors});
  });
});

// Reset password

app.post('/reset_password', function(req, res) {
  var username = req.body.username,
      tan = req.body.tan,
      password = req.body.password;
  
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  graph.fetch({_id: "/user/"+username}, function(err) {
    var user = graph.get("/user/"+username);
    
    if (user.get('tan') !== tan) return res.send({"status": "error", "message": "The Password reset token has expired."});
    if (password.length < 3) return res.send({"status": "error", "message": "Password is invalid. Be aware that you need 3 characters minimum."});
    if (user) {
      user.set({
        password: encryptPassword(password),
        tan: ""
      });
      
      // Auto login
      var seed = {};
      seed[user._id] = user.toJSON();
      delete seed[user._id].password;
      req.session = {
        username: username.toLowerCase(),
        seed: seed
      };
      graph.sync(function(err) {
        if (err) return res.send({"status": "error", "message": "Unknown error."});
        res.send({"status": "ok"});
      });
    } else {
      res.send({"status": "error"});
    }
  });
});

// Recover lost password

app.post('/recover_password', function(req, res) {
  var username = req.body.username.toLowerCase();
  
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  graph.fetch({_id: "/user/"+username}, function(err) {
    var user = graph.get("/user/"+username);
    if (user) {
      user.set({
        tan: Data.uuid()
      });
      
      graph.sync(function(err) {
        // Message object
        var message = {
          sender: '"' + config.mail.name + '" <' + config.mail.sender + '>',
          to: user.get('email'),
          subject: 'Reset your Substance password',
          body: 'In order to reset your password on Substance, click on the link below:\n'+config.server_url+"/reset/"+user.get('username')+"/"+user.get('tan'),
          debug: true
        };

        if (err) return res.send({"status": "error"}, 404);
        
        // Notify
        var mail = nodemailer.send_mail(message, function(err) {
          if (err) return res.send({"status": "error"}, 404);
          res.send({"status": "ok"});
        });
      });
    } else {
      res.send({"status": "error"}, 404);
    }
  });
});


// Confirm collaboration on a document

app.post('/confirm_collaborator', function(req, res) {
  var tan = req.body.tan,
      user = req.body.user;
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  
  if (req.session.username && req.session.username === user) {
    graph.fetch({type: "/type/collaborator", tan: tan, "document": {}}, function(err, nodes) {
      if (nodes.length <= 0) return res.send({"status": "error"});
      
      var doc = nodes.first().get('document');
      if (doc.get('creator')._id === "/user/"+user) return res.send({"status": "error", "error": "already_involved"});
      
      graph.fetch({type: "/type/collaborator", document: doc._id, user: "/user/"+user}, function(err, collaborators) {
        if (collaborators.length > 0) return res.send({"status": "error", "error": "already_involved"});
        
        graph.get(nodes.first()._id).set({
          user: "/user/"+user,
          status: "confirmed"
        });
        
        graph.fetch({type: "/type/subscription", user: "/user/"+user, document: doc._id}, function(err, nodes) {
          if (nodes.length === 0) {
            // Add subscription
            graph.set(null, {
              type: "/type/subscription",
              user: "/user/"+user,
              document: doc._id
            });
          }
          
          graph.sync(function(err) {
            return err ? res.send({"status": "error"}) : res.send({"status": "ok", "graph": {}});
          });
        });
        
      });
    });
  } else {
    res.send({"status": "error", "error": "unknown_error"});
  }
});


// Invite Collaborator by Email

app.post('/invite', function(req, res) {
  var document = req.body.document,
      email = req.body.email,
      mode = req.body.mode;
  
  if (!VALIDATE_EMAIL.test(email)) {
    return res.send({"status": "error", "error": "invalid_email"});
  }
  
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});
  graph.fetch({_id: document}, function(err) {
    var doc = graph.get(document);
    
    // Check if authorized — only the creator is allowed to invite collaborators
    if (doc.get('creator')._id.split('/')[2] !== req.session.username) {
      return res.send({"status": "error", "error": "not_authorized"});
    }
    
    graph.fetch({type: "/type/collaborator", document: document, email: email}, function(err, nodes) {
      if (nodes.length>0) return res.send({"status": "error", "error": "already_invited"});
      
      // Create collaborator object
      var collaborator = graph.set({
        type: "/type/collaborator",
        document: document,
        email: email,
        tan: Data.uuid(),
        mode: mode,
        user: null,
        status: "pending",
        created_at: new Date()
      });
      
      // Message object
      var message = {
        sender: '"' + config.mail.name + '" <' + config.mail.sender + '>',
        to: email,
        subject: doc.get('title'),
        body: "\""+ doc.get('creator')._id.split('/')[2] + "\" invited you to collaborate on his document \""+doc.get('title')+"\" on Substance. \n\n "+ config.server_url +"/collaborate/"+collaborator.get('tan'),
        // Would like you to see his document. in the view case.
        debug: true
      };
      
      graph.sync(function(err) {
        res.send({"status": "ok", "graph": doc.toJSON()});
        if (err) return;
        // Notify
        var mail = nodemailer.send_mail(message, function(err) {
          if(err) {
            console.log('Error occured');
            console.log(err.message);
            return;
          }
          console.log('Successfully notified collaborator.');
        });
      });
      
    });
  });
});

app.get('/notifications', function(req, res) {
  if (!req.session) return res.send({});
  getNotifications(req.session.username, function(err, notifications) {
    // Only deliver unread notifications
    var unreadNotifications = {};
    _.each(notifications, function(n, key) {
      if (!n.read && _.include(n.type, "/type/notification")) {
        unreadNotifications[key] = n;
        unreadNotifications[n.event] = notifications[n.event];
      }
    });
    res.send(JSON.stringify(unreadNotifications));
  });
});

function fetchGravatar(username, size, res, callback) {
  db.get("/user/"+username, function(err, node) {
    if (err) return callback(err);
    var email = node.email || "";
    var host = 'www.gravatar.com';
    var query = "?s="+size+"&d=retro";
    var path = '/avatar/' + crypto.createHash('md5').update(email.toLowerCase()).digest('hex') + query;

    http.get({host: host, path: path}, function(cres) {
      if (cres.statusCode !== 200) return callback('error', '');
      //cres.setEncoding('binary');
      cres.pipe(res);
      cres.on('end', function() {
        callback(null);
      });
    }).on('error', function(e) {
      callback(e);
    });
  });
}

app.get('/avatar/:username/:size', function(req, res) {
  res.writeHead(200, { 'Content-Type': 'image/png'});
  fetchGravatar(req.params.username, req.params.size, res, function() {
    res.end();
  });
});


// Creates a new version from the current document state
// TODO: check if authorized
app.post('/publish', function(req, res) {
  var document = req.body.document;
  var networks = req.body.networks;
  var remark = req.body.remark;
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url, filters: [Filters.addMeta()]});

  function createPublications(callback) {
    graph.fetch({"type": "/type/publication", "document": document}, function(err, nodes) {
      var remoteNetworks  = nodes.map(function(n) { return n.get('network')._id; }).values(),
          newNetworks     = _.difference(networks, remoteNetworks),
          deletedNetworks = _.difference(remoteNetworks, networks),
          changedNetworks = [].concat(newNetworks).concat(deletedNetworks);
      
      _.each(newNetworks, function(network) {
        graph.set({
          type: "/type/publication",
          document: document,
          network: network
        });
      });
      _.each(deletedNetworks, function(network) {
        var pub = graph.find({type: "/type/publication", "network": network}).first()._id;
        graph.del(pub);
      });
      async.forEach(changedNetworks, function (id, cb) {
        graph.fetch({ _id: id }, function (err, nodes) {
          if (err) { cb(err); return; }
          nodes.each(function (network) {
            network.set({ updated_at: new Date() });
          });
          cb(null);
        });
      }, callback);
    });
  }

  Document.getContent(document, function(err, data, id) {
    Util.count('/counter/document/'+document.split('/')[3], function(err, versionCount) {
      // Create a new version
      var currentDate = new Date();
      var version = graph.set({
        _id: "/version/"+document.split('/')[3]+"/"+versionCount,
        type: "/type/version",
        document: document,
        remark: remark,
        created_at: currentDate,
        data: data
      });

      // Update version link
      graph.set(_.extend(data[id], {
        published_version: version._id,
        updated_at: currentDate,
        published_on: currentDate
      }));

      // Create publications
      createPublications(function() {
        graph.sync(function(err) {
          if (err) return res.send({"status": "error"}, 500);
          var newGraph = {};
          newGraph[id] = graph.get(id);
          res.send({
            "status": "ok",
            "version": version._id,
            "graph": newGraph
          });
        });
      });
    });
  });
});


app.post('/unpublish', function(req, res) {
  var document = req.body.document;
  var graph = new Data.Graph(seed).connect('couch', {url: config.couchdb_url});

  graph.fetch({"type": "/type/document", "_id": document}, function(err, nodes) {
    var doc = nodes.first();
    
    doc.set({
      published_version: null,
      updated_at: new Date()
    });

    graph.fetch({"type": "/type/publication", "document": document}, function(err, nodes) {
      nodes.each(function(n) {
        graph.del(n._id);
      });
      graph.sync(function(err) {
        if (err) res.send({"status": "error"}, 500);
        var newGraph = {};
        newGraph[document] = graph.get(document).toJSON();
        newGraph[document].published_version = null;
        res.send({
          "status": "ok",
          "version": null,
          "graph": newGraph
        });
      });
    });
  });
});


app.get('/networks/recent', function (req, res) {
  Network.getNMostRecent(50, function (err, graph) {
    res.json({
      error: err,
      graph: graph
    });
  });
});


// Returns a specific version of the requested doc
app.get('/documents/:username/:name/:version', function(req, res) {
  Document.get(req.params.username, req.params.name, req.params.version, req.session ? req.session.username : null, function(err, graph, id, authorized, version, published) {
    if (err) return res.json(err);
    res.json({status: "ok", graph: graph, id: id, authorized: authorized, version: version, published: published });
  });
});


// Returns the latest version of the requested doc
app.get('/documents/:username/:name', function(req, res) {
  Document.get(req.params.username, req.params.name, null, req.session ? req.session.username : null, function(err, graph, id, authorized, version, published) {
    if (err) return res.json(err);
    res.json({status: "ok", graph: graph, id: id, authorized: authorized, version: version, published: published});
  });
});

app.post('/parse', function (req, res) {
  var format = req.body.format
  ,   text   = req.body.text;
  
  parse(format, text, res);
});


// Write a single document, expressed as a graph
// app.post('/writedocument', function(req, res) {
//   var graph = new Data.Graph(seed, false).connect('couch', { url: config.couchdb_url, force_updates: true });
//   graph.merge(JSON.parse(req.rawBody), true);
//   graph.sync(function(err, nodes) {
//     res.send({"status": "ok"});
//   });
// });

app.listen(config['server_port'], config['server_host'], function (err) {
  console.log('READY: Substance is listening http://'+config['server_host']+':'+config['server_port']);
});
