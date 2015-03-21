/*******************************************************************************
 * @license
 * Copyright (c) 2013, 2014 Pivotal Software, Inc. and others.
 * All rights reserved. This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License v1.0
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html).
 *
 * Contributors:
 *     Pivotal Software, Inc. - initial API and implementation
*******************************************************************************/
/*global require console exports process __dirname*/

var URI = require('URIjs');
var path = require('path');
var bodyParser = require('body-parser');

// create and configure express
var app = require('express')();
app.use(require('cookie-parser')());
app.use(bodyParser.json());
app.use(require('method-override')());

var cloudFoundryHost = process.env.VCAP_APP_HOST;
var host = cloudFoundryHost || process.env.HOST || 'localhost';
var port = process.env.VCAP_APP_PORT || process.env.PORT || '3000';
//var homepage = '/client/index.html'; //flux own simple home page
var homepage = '/edit/edit.html'; //orion home page

var isCloudFoundry = cloudFoundryHost != null;
console.log('Starting flux on host: '+host);
console.log('isCloudFoundry = ',isCloudFoundry);

var authentication = require('./authentication');
var ENABLE_AUTH = authentication.isEnabled;
var SUPER_USER = authentication.SUPER_USER;

app.use(authentication.session);
app.enable('trust proxy');

if (isCloudFoundry) {
	//On CF all external http and https get routed to a single http connection
	// on the server. We will force all connection on plain http to
	// redirect to https
	app.use(function (req, res, next) {
		var protocol = req.protocol; //you must enable trust proxy option for this to work on CF
		if (protocol === 'https') {
			return next();
		}
		var target = 'https://'+path.join(req.host, req.url);
		res.redirect(target);
	});
}

if (ENABLE_AUTH) {
	var passport = authentication.passport;
	app.use(passport.initialize());
	app.use(passport.session());
	app.use('/client', authentication.ensureAuthenticated);
	app.use('/edit', authentication.ensureAuthenticated);

	app.get('/auth/github', passport.authenticate('github'));
	app.get('/auth/github/callback',
					passport.authenticate('github', {failureRedirect: '/auth/github'}),
					function redirectHome(request, response) {
						var target = URI(homepage).query({user: userName(request)}).toString();
						console.log('redirecting: ' + target);
						response.redirect(target);
					}
	);
}

////////////////////////////////////////////////////////
// Register http end points

function userName(req) {
	return req && req.user && req.user.username;
}

app.get("/user",
	function (req, res) {
		var authUser = req.user;
		if (!ENABLE_AUTH) {
			authUser = authentication.defaultUser;
		}
		if (authUser) {
			res.set('Content-Type', 'application/json');
			res.send(JSON.stringify(authUser));
		} else {
			res.status(404);
			res.set('Content-Type', 'application/json');
			res.send(JSON.stringify({error: "Not logged in"}));
		}
	}
);

////////////////////////////////////////////////////////
var workspaceDir = path.resolve(__dirname, ".workspace");
if (!require('./util/fileutil').isDir(workspaceDir)) {
	require('fs').mkdirSync(workspaceDir);
}

app.use(require('jb-orion')({
	workspaceDir: workspaceDir,
	passwordFile: null,
	password: null,
	configParams: {},
	dev: null,
	log: null
}));

var server = require('http').Server(app);
console.log('Express server started on ' + host + ":" + port);

// create and configure socket.io
var io = require('socket.io')(server);
if (ENABLE_AUTH) {
	io.use(authentication.socketIoHandshake);
}

server.listen(port, host);

var rabbitConnector = require('./rabbit-connector');
io.sockets.on('connection', function (socket) {
	rabbitConnector.connectWebSocket(socket);
});

if (true) {
	// node.server — repository synchronizer should be separate service
	return
}

/////////////////////////////////////////////////////////////////////////

var messagingHost = 'localhost'; //Careful not to use real host name here as that
                                 // won't work on CF deployments.
                                 //The real host name for 'outside' connections
                                 //doesn't expose the port it is actually running on
                                 //but instead remaps that to standard http / https ports.
                                 //so to talk directly to 'ourselves' we use localhost.

var repository;
if (process.env.USE_IN_MEMORY_DB) {
	console.log('create in-memory backup repository');
	repository = new (require('./repository-inmemory.js').Repository)();
}
else {
	console.log('create mongodb-based backup repository');
	repository = new (require('./repository-mongodb.js').Repository)();
}

new (require('./repository-rest-api.js').RestRepository)(app, repository);

var messagesRepository = new (require('./repository-message-api.js').MessagesRepository)(repository);

var client_socket = require('socket.io-client')("http://" + messagingHost + ":" + port, authentication.asSuperUser({}));
client_socket.on('connect', function () {
	console.log('client socket connected to ' + messagingHost);
	client_socket.emit('connectToChannel', {
		'channel': SUPER_USER
	}, function (answer) {
		console.log('connectToChannel answer', answer);
		if (answer.connectedToChannel) {
			repository.setNotificationSender(client_socket);
			messagesRepository.setSocket(client_socket);
		}
	});
});


